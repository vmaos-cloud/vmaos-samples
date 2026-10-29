import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createSampleServer } from '../server.mjs';

// The browser test exercises the tutorial against mock public API/SDK contracts, without a real AK/SK.
const fakeSdk = `
export const ChannelDataType={ClickData:'ClickData',ActionInput:'ActionInput',ActionChinese:'ActionChinese'};
export class TouchData{constructor(action,p,x,y,offsetTime){Object.assign(this,{action,p,x,y,offsetTime})}}
export class WebRtcClient{constructor(config){this.config=config;window.active=(window.active||0)+1;window.maximum=Math.max(window.maximum||0,window.active)}sendChannelData(type,data){(window.sent||=[]).push({room:this.config.roomId,type,data});return true}stop(){window.active--}}
export class ControlGroupClient{constructor(config){this.config=config}on(){return this}start(){}stop(){}removeAllListeners(){}sendData(type,data){for(const room of Object.keys(this.config.roomTokens))(window.sent||=[]).push({room,type,data});return true}}
export class WebRtcSdk{static EVENTS={LOADED_FAILURE:'failed'};constructor(options,deps){this.options=options;this.deps=deps}on(){}init(){this.client=this.deps.clientFactory(this.options.connectConfig);this.options.mountedElement.append(document.createElement('video'))}startConnection(){}disableAudio(){}goHome(){this.client.sendChannelData('ActionInput',{keyCode:3})}goBack(){this.client.sendChannelData('ActionInput',{keyCode:4})}goTask(){this.client.sendChannelData('ActionInput',{keyCode:187})}destroy(){this.client.stop();this.options.mountedElement.replaceChildren()}}
`;

test('AK/SK query, selection, group controls and primary switching use the public contracts', async t => {
  const calls = [], phones = ['P1', 'P2', 'P3'].map(phoneCode => ({ phoneCode, online: true, status: 2 }));
  let destroyed = 0;
  const ticket = phoneCode => ({ signalServerUrl: 'ws://signal.example/v1/signaling', roomId: phoneCode,
    token: 'test-only', turnServerUris: ['turn:turn.example'], expiresAt: new Date(Date.now() + 300000).toISOString() });
  const server = createSampleServer({ baseUrl: 'https://openapi.sample.com', clientFactory: () => ({ destroy: () => destroyed++, call: async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith('/query')) return { items: phones, nextCursor: null, hasMore: false };
    if (path.endsWith('/group-connection-ticket')) return { main: { phoneCode: body.mainPhoneCode, ticket: ticket(body.mainPhoneCode) },
      followerGroups: [{ signalServerUrl: ticket('P1').signalServerUrl, members: body.followerPhoneCodes.map(phoneCode => ({ phoneCode, ticket: ticket(phoneCode) })) }] };
    if (path.endsWith('/connection-ticket')) return ticket(body.phoneCode);
    if (path.endsWith('/screenshot-token')) return { previews: body.phoneCodes.map(phoneCode => ({ phoneCode, previewUrl: `https://preview.example/${phoneCode}` })) };
    throw new Error('unexpected public API');
  } }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('**/sdk/browser.iife.js', route => route.fulfill({ contentType: 'text/javascript', body: fakeSdk.replaceAll('export ', '') + '\nglobalThis.WebRTCSDK={WebRtcSdk,WebRtcClient,ControlGroupClient,ChannelDataType,TouchData};' }));
  await page.route('**/sdk/styles.css', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('https://preview.example/**', route => route.fulfill({ contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': '*' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640"><rect width="360" height="640" fill="#192943"/></svg>' }));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[name=accessKey]').fill('test-ak'); await page.locator('[name=secretKey]').fill('test-sk');
  await page.getByRole('button', { name: '连接并查询云机' }).click();
  await page.locator('#phones tr').first().waitFor();
  assert.equal(await page.locator('[name=accessKey]').inputValue(), 'test-ak');
  assert.equal(await page.locator('[name=secretKey]').inputValue(), 'test-sk');
  for (const phone of phones) await page.locator('#phones tr').filter({ hasText: phone.phoneCode }).getByRole('checkbox').check();
  await page.getByRole('button', { name: '群控所选云机' }).click();
  await page.locator('#primary video').waitFor();
  await page.getByRole('button', { name: '主页', exact: true }).click();
  assert.deepEqual((await page.evaluate(() => window.sent)).map(item => item.room).sort(), ['P1', 'P2', 'P3']);
  const second = page.locator('.tile').filter({ has: page.getByText('P2', { exact: true }) });
  await second.getByRole('button', { name: '设为主控' }).click();
  await page.waitForFunction(() => document.getElementById('primary-name').textContent === 'P2' && document.querySelector('#primary video'));
  assert.equal(await second.locator('.picture').innerText(), '操控中');
  assert.deepEqual(await page.locator('.tile strong').allTextContents(), ['P1', 'P2', 'P3']);
  assert.equal(await page.evaluate(() => window.maximum), 1);
  await page.locator('#sync').uncheck();
  await page.waitForFunction(() => document.querySelector('#primary video') !== null);
  assert.equal(calls.at(-1).path, '/open-api/phone/connection-ticket');
  const logout = page.waitForResponse(response => response.url().endsWith('/api/logout'));
  await page.getByRole('button', { name: '退出并清除凭据' }).click();
  await logout;
  await page.waitForFunction(() => window.active === 0);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.equal(await page.locator('[name=accessKey]').inputValue(), '');
  assert.equal(await page.locator('[name=secretKey]').inputValue(), '');
  assert.equal(destroyed, 1);
});
