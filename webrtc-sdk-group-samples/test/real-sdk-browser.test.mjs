import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createSampleServer } from '../server.mjs';

// Execute the README examples themselves so documentation and public sample calls stay aligned.
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
function documentedExample(name) {
  const start = readme.indexOf(`<!-- example: ${name} -->`);
  assert(start >= 0, `Missing README example: ${name}`);
  const rest = readme.slice(start), begin = rest.indexOf('```js\n') + 6;
  const end = rest.indexOf('\n```', begin);
  assert(begin >= 6 && end > begin, `Missing JavaScript block: ${name}`);
  return rest.slice(begin, end);
}
async function runExample(page, name) {
  const code = documentedExample(name);
  return page.evaluate(async source => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('var groupControls = (await import("/main.js")).groupControls;\n' + source)();
    return (await import('/main.js')).groupControls.getState();
  }, code);
}

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
        queueMicrotask(() => { this.ondatachannel?.({ channel }); this.iceConnectionState='connected'; this.oniceconnectionstatechange?.(); });
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
  await page.waitForFunction(() => window.transportTest.sockets.some(socket => socket.rooms?.length === 2) && window.transportTest.peers.length === 1 && document.getElementById('primary-status').textContent === '已连接');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.waitForFunction(() => window.transportTest.groupActions.length === 1 && window.transportTest.actions.some(action => action.type === 'ActionInput'));
  assert.deepEqual(await page.evaluate(() => window.transportTest.groupActions[0].rooms.sort()), ['P2', 'P3']);
  const actions = await page.evaluate(() => ({ primary: window.transportTest.actions.find(action => action.type === 'ActionInput'), follower: window.transportTest.groupActions[0].action }));
  assert.equal(JSON.parse(actions.primary.data).keyCode, 3);
  assert.equal(JSON.parse(actions.follower.data).keyCode, 3);
  assert.equal(await page.locator('#primary video').evaluate(video=>video.muted),true);
  assert.deepEqual(await page.locator('nav button').allTextContents(),['最近任务','Home','返回']);
  await page.evaluate(()=>{
    const event=new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true});
    document.querySelector('#primary video').dispatchEvent(event);
    window.groupWheelPrevented=event.defaultPrevented;
  });
  await page.waitForFunction(()=>window.transportTest.groupActions.some(entry=>entry.action.type==='ActionWheel'));
  assert.equal(await page.evaluate(()=>window.groupWheelPrevented),true);
  assert.deepEqual(await page.evaluate(()=>window.transportTest.groupActions.filter(entry=>entry.action.type==='ActionWheel').map(entry=>JSON.parse(entry.action.data).axis)),[-1]);
  assert.equal(await page.evaluate(()=>window.transportTest.actions.some(action=>action.type==='ActionCommandEvent'&&JSON.parse(action.data).value==='DISABLE')),true);

  await page.evaluate(() => {
    const host=document.getElementById('primary'); host.dispatchEvent(new PointerEvent('pointerenter'));
    const input=host.querySelector('[aria-label="云机键盘输入"]'), clipboard=new DataTransfer();
    clipboard.setData('text/plain','群控粘贴\n第二行'); input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,cancelable:true,bubbles:true}));
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.dispatchEvent(new CompositionEvent('compositionend',{data:'中文输入'}));
    input.value='中文输入'; input.dispatchEvent(new InputEvent('input',{data:'中文输入'}));
  });
  await page.waitForFunction(() => window.transportTest.actions.filter(action=>action.type==='ActionChinese').length===2 && window.transportTest.groupActions.filter(entry=>entry.action.type==='ActionChinese').length===2);
  const texts=await page.evaluate(()=>({main:window.transportTest.actions.filter(a=>a.type==='ActionChinese').map(a=>JSON.parse(a.data).text),followers:window.transportTest.groupActions.filter(a=>a.action.type==='ActionChinese').map(a=>JSON.parse(a.action.data).text)}));
  assert.deepEqual(texts.main,['群控粘贴\n第二行','中文输入']); assert.deepEqual(texts.main,texts.followers);
  await page.evaluate(()=>{
    const video=document.querySelector('#primary video');
    Object.defineProperty(video,'videoWidth',{value:360}); Object.defineProperty(video,'videoHeight',{value:640});
    video.getBoundingClientRect=()=>({left:0,top:0,width:360,height:640});
    video.setPointerCapture=()=>{}; video.hasPointerCapture=()=>false;
    video.dispatchEvent(new PointerEvent('pointerdown',{pointerId:7,pointerType:'mouse',button:0,clientX:180,clientY:320,bubbles:true,cancelable:true}));
    window.dispatchEvent(new Event('blur'));
  });
  await page.waitForFunction(()=>window.transportTest.groupActions.filter(a=>a.action.type==='ClickData').length===2);
  const touch=await page.evaluate(()=>window.transportTest.groupActions.filter(a=>a.action.type==='ClickData').map(a=>JSON.parse(a.action.data).action));
  assert.deepEqual(touch,[0,1]);
  // Selection updates only follower sockets, keeping the established main peer.
  const third = page.locator('.tile').filter({has:page.getByText('P3',{exact:true})});
  await third.getByRole('button', { name: '操控', exact: true }).click();
  await third.getByRole('menuitemcheckbox', { name: '参与同步', exact: true }).click();
  await page.waitForFunction(()=>window.transportTest.sockets.some(socket=>socket.rooms?.length===1&&socket.rooms[0]==='P2'&&socket.readyState===1));
  assert.equal(await page.evaluate(()=>window.transportTest.peers.length),1);
  // Remote copy comes from the primary data channel and is never mirrored.
  const groupActionsBeforeCopy = await page.evaluate(() => window.transportTest.groupActions.length);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.addEventListener('copy', event => { window.copiedCloudText = event.clipboardData.getData('text/plain'); });
    window.transportTest.peers[0].channel.onmessage({ data: JSON.stringify({ type: 'CloudClipData', data: '主控文字\nhello 😀' }) });
  });
  await page.getByRole('button', { name: '查看文字', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '云机复制的文字' }).inputValue(), '主控文字\nhello 😀');
  await page.getByRole('button', { name: '复制到本机', exact: true }).click();
  await page.getByText('已复制到本机', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.copiedCloudText), '主控文字\nhello 😀');
  assert.equal(await page.evaluate(() => window.transportTest.groupActions.length), groupActionsBeforeCopy);
  const second = page.locator('.tile').filter({ has: page.getByText('P2', { exact: true }) });
  await second.getByRole('button', { name: '操控', exact: true }).click();
  await second.getByRole('menuitem', { name: '设为主控', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('primary-name').textContent === 'P2' && window.transportTest.peers.length === 2);
  assert.equal(await page.evaluate(() => window.transportTest.peers[0].closed), true);
  assert.equal(await page.locator('[data-cloud-clipboard]').count(), 0);
  await page.evaluate(() => window.transportTest.peers[0].channel.onmessage?.({ data: JSON.stringify({ type: 'CloudClipData', data: '旧主控文字' }) }));
  assert.equal(await page.locator('[data-cloud-clipboard]').count(), 0);
  await page.locator('#sync').uncheck();
  assert.equal(await page.evaluate(() => window.transportTest.peers.length), 2);
  assert(calls.some(call => call.path.endsWith('/connection-ticket') && call.body.phoneCode === 'P2'));
  const peers = await page.evaluate(() => window.transportTest.peers.length);
  await page.getByRole('button', { name: '重试从控', exact: true }).click();
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.transportTest.peers.length), peers);
  const priorGroupActions = await page.evaluate(() => window.transportTest.groupActions.length);
  const priorPrimaryActions = await page.evaluate(() => window.transportTest.actions.filter(action => action.type === 'ActionInput').length);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.waitForFunction(count => window.transportTest.actions.filter(action => action.type === 'ActionInput').length > count, priorPrimaryActions);
  assert.equal(await page.evaluate(() => window.transportTest.groupActions.length), priorGroupActions);
  // Customers call switchPrimary on the existing group, rather than calling start again.
  await page.evaluate(async () => {
    const { groupControls: controls } = await import('/main.js');
    await controls.switchPrimary('P1'); await controls.waitUntilReady();
  });
  const beforeSwitch = await page.evaluate(() => window.transportTest.peers.length);
  const switched = await runExample(page, 'switch-primary');
  assert.equal(switched.primaryCode, 'P2');
  assert.deepEqual(switched.members.map(phone => phone.phoneCode), ['P1', 'P2', 'P3']);
  assert.equal(await page.evaluate(() => window.transportTest.peers.length), beforeSwitch + 1);
  await runExample(page, 'switch-primary');
  assert.equal(await page.evaluate(() => window.transportTest.peers.length), beforeSwitch + 1, 'Selecting the existing primary must not reconnect');
  const invalidSwitch = await page.evaluate(async () => {
    const { groupControls: controls } = await import('/main.js');
    try { await controls.switchPrimary('missing'); return false; } catch { return controls.getState().primaryCode === 'P2'; }
  });
  assert.equal(invalidSwitch, true);
  await page.evaluate(async () => {
    const { groupControls: controls } = await import('/main.js');
    await controls.setParticipating('P3', true); await controls.setSynchronous(true); await controls.waitUntilReady();
  });
  const beforeInput = await page.evaluate(() => ({ main: window.transportTest.actions.length, followers: window.transportTest.groupActions.length }));
  await runExample(page, 'navigation');
  await runExample(page, 'gestures');
  await runExample(page, 'text-and-key');
  const forwarded = await page.evaluate(before => ({
    main: window.transportTest.actions.slice(before.main), followers: window.transportTest.groupActions.slice(before.followers),
  }), beforeInput);
  assert(forwarded.main.some(action => action.type === 'ActionChinese' && JSON.parse(action.data).text === '你好，群控示例'));
  assert(forwarded.main.some(action => action.type === 'ActionInput' && JSON.parse(action.data).keyCode === 66));
  assert(forwarded.main.some(action => action.type === 'ClickData'));
  assert(forwarded.main.some(action => action.type === 'ActionWheel'));
  const payload = action => ({ type: action.type, data: JSON.parse(action.data) });
  assert.deepEqual(forwarded.followers.map(item => payload(item.action)), forwarded.main.filter(action => ['ActionInput', 'ActionChinese', 'ClickData', 'ActionWheel'].includes(action.type)).map(payload));
  assert(forwarded.followers.every(item => item.rooms.length === 2 && item.rooms.includes('P1') && item.rooms.includes('P3')));
  const stablePeerCount = await page.evaluate(() => window.transportTest.peers.length);
  const excluded = await runExample(page, 'exclude-member');
  assert.equal(excluded.members.find(phone => phone.phoneCode === 'P3').participating, false);
  await runExample(page, 'remove-member');
  const added = await runExample(page, 'add-member');
  assert.equal(added.primaryCode, 'P2');
  assert.equal(added.members.find(phone => phone.phoneCode === 'P3').participating, true);
  await runExample(page, 'retry-followers');
  await runExample(page, 'refresh-previews');
  assert.equal(await page.evaluate(() => window.transportTest.peers.length), stablePeerCount, 'Member/follower/preview changes must preserve the primary peer');
  const onlyMain = await runExample(page, 'sync-off');
  assert.equal(onlyMain.synchronous, false);
  await runExample(page, 'retry-primary');
  const reconnected = await runExample(page, 'disconnect-reconnect');
  assert.equal(reconnected.primaryCode, 'P2');
  assert.equal(reconnected.members.length, 3);
  assert.equal(reconnected.synchronous, false);
  assert.equal(reconnected.ready, true);
  const logout = page.waitForResponse(response => response.url().endsWith('/api/logout'));
  await page.getByRole('button', { name: '退出并清除凭据' }).click(); await logout;
  assert.equal(await page.evaluate(() => window.transportTest.peers.every(peer => peer.closed) && window.transportTest.sockets.every(socket => socket.readyState === 3)), true);
  assert.deepEqual(errors, []);
});
