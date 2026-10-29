import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createSampleServer } from '../server.mjs';

// Exercise the installed SDK through the sample, while replacing only the external
// OpenAPI, signaling and peer transports. This does not test real media or devices.
test('installed SDK drives group actions and releases transports on switching and logout', async t => {
  const calls = [], phones = ['P1', 'P2', 'P3'].map(phoneCode => ({ phoneCode, online: true, status: 2 }));
  const ticket = phoneCode => ({ signalServerUrl: 'wss://signal.example', roomId: phoneCode,
    token: 'test-only', turnServerUris: [], expiresAt: new Date(Date.now() + 300000).toISOString() });
  const server = createSampleServer({ baseUrl: 'https://openapi.sample.com', clientFactory: () => ({ destroy() {}, async call(path, body) {
    calls.push({ path, body });
    if (path.endsWith('/query')) return { items: phones, nextCursor: null, hasMore: false };
    if (path.endsWith('/group-connection-ticket')) return { main: { phoneCode: body.mainPhoneCode, ticket: ticket(body.mainPhoneCode) },
      followerGroups: [{ signalServerUrl: 'wss://signal.example', members: body.followerPhoneCodes.map(phoneCode => ({ phoneCode, ticket: ticket(phoneCode) })) }] };
    if (path.endsWith('/connection-ticket')) return ticket(body.phoneCode);
    if (path.endsWith('/screenshot-token')) return { previews: body.phoneCodes.map(phoneCode => ({ phoneCode, previewUrl: `https://preview.example/${phoneCode}` })) };
    throw new Error('unexpected API');
  } }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const state = window.transportTest = { sockets: [], peers: [], actions: [], groupActions: [] };
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; state.sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); }); }
      send(value) {
        const message = JSON.parse(value);
        if (message.type === 'ControlGroupSignIn') {
          this.rooms = message.subRoomIdsOfGroup;
          queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'GroupPeer', groupId: 'test-group', myId: 'test-web' }) }));
        } else if (message.type === 'GroupSendAction') state.groupActions.push({ rooms: this.rooms, action: JSON.parse(message.action) });
        else if (message.type === 'SignIn') this.room = message.roomId;
      }
      close() { this.readyState = 3; }
    };
    window.RTCPeerConnection = class {
      constructor() {
        state.peers.push(this); this.closed = false;
        const channel = this.channel = { readyState: 'open', send(value) { state.actions.push(JSON.parse(new TextDecoder().decode(value))); }, close() { this.readyState = 'closed'; } };
        queueMicrotask(() => this.ondatachannel?.({ channel }));
      }
      addTransceiver() { return { sender: { track: null, replaceTrack: async () => {} } }; }
      close() { this.closed = true; }
      getStats() { return Promise.resolve(new Map()); }
    };
  });
  await page.route('https://preview.example/**', route => route.fulfill({ contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': '*' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }));
  const sdkResponse = page.waitForResponse(response => response.url().endsWith('/sdk/browser.iife.js'));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal((await sdkResponse).status(), 200);
  assert.equal(await page.evaluate(() => typeof window.WebRTCSDK?.WebRtcSdk), 'function');
  await page.locator('[name=accessKey]').fill('test-ak'); await page.locator('[name=secretKey]').fill('test-sk');
  await page.getByRole('button', { name: '连接并查询云机' }).click();
  for (const phone of phones) await page.locator('#phones tr').filter({ hasText: phone.phoneCode }).getByRole('checkbox').check();
  await page.getByRole('button', { name: '群控所选云机' }).click();
  await page.waitForFunction(() => window.transportTest.sockets.some(socket => socket.rooms?.length === 2) && window.transportTest.peers.length === 1);
  await page.getByRole('button', { name: '主页', exact: true }).click();
  await page.waitForFunction(() => window.transportTest.groupActions.length === 1 && window.transportTest.actions.some(action => action.type === 'ActionInput'));
  assert.deepEqual(await page.evaluate(() => window.transportTest.groupActions[0].rooms.sort()), ['P2', 'P3']);
  const actions = await page.evaluate(() => ({ primary: window.transportTest.actions.find(action => action.type === 'ActionInput'), follower: window.transportTest.groupActions[0].action }));
  assert.equal(JSON.parse(actions.primary.data).keyCode, 3);
  assert.equal(JSON.parse(actions.follower.data).keyCode, 3);
  const second = page.locator('.tile').filter({ has: page.getByText('P2', { exact: true }) });
  await second.getByRole('button', { name: '设为主控' }).click();
  await page.waitForFunction(() => document.getElementById('primary-name').textContent === 'P2' && window.transportTest.peers.length === 2);
  assert.equal(await page.evaluate(() => window.transportTest.peers[0].closed), true);
  await page.locator('#sync').uncheck();
  await page.waitForFunction(() => window.transportTest.peers.length === 3);
  assert(calls.some(call => call.path.endsWith('/connection-ticket') && call.body.phoneCode === 'P2'));
  const priorGroupActions = await page.evaluate(() => window.transportTest.groupActions.length);
  const priorPrimaryActions = await page.evaluate(() => window.transportTest.actions.filter(action => action.type === 'ActionInput').length);
  await page.getByRole('button', { name: '主页', exact: true }).click();
  await page.waitForFunction(count => window.transportTest.actions.filter(action => action.type === 'ActionInput').length > count, priorPrimaryActions);
  assert.equal(await page.evaluate(() => window.transportTest.groupActions.length), priorGroupActions);
  const logout = page.waitForResponse(response => response.url().endsWith('/api/logout'));
  await page.getByRole('button', { name: '退出并清除凭据' }).click(); await logout;
  assert.equal(await page.evaluate(() => window.transportTest.peers.every(peer => peer.closed) && window.transportTest.sockets.every(socket => socket.readyState === 3)), true);
  assert.deepEqual(errors, []);
});
