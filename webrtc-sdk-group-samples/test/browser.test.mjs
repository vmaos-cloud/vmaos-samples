import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createSampleServer } from '../server.mjs';

// The browser test exercises the tutorial against mock public API/SDK contracts, without a real AK/SK.
const fakeSdk = `
export const EmitType={cloudClipData:'cloudClipData'};
export const ChannelDataType={ActionWheel:'ActionWheel',ActionCommandEvent:'ActionCommandEvent',ClickData:'ClickData',ActionInput:'ActionInput',ActionChinese:'ActionChinese'};
export class TouchData{constructor(action,p,x,y,offsetTime){Object.assign(this,{action,p,x,y,offsetTime})}}
export class InputData{constructor(text){this.text=text}}
export class WheelData{constructor(axis){this.axis=axis}}
export class KeyEventData{constructor(keyCode,meta){Object.assign(this,{keyCode,meta})}}
export function getKeyEventData(e){return {keyCode:e.code==='Backspace'?67:3,meta:0}}
export class WebRtcClient{constructor(config){this.config=config;this.events={};window.active=(window.active||0)+1;window.maximum=Math.max(window.maximum||0,window.active)}on(e,f){(this.events[e]||=[]).push(f);return this}off(e,f){this.events[e]=this.events[e]?.filter(x=>x!==f)||[];return this}sendChannelData(type,data){(window.sent||=[]).push({room:this.config.roomId,type,data});return true}stop(){window.active--}}
export class ControlGroupClient{constructor(config){this.config=config;this.events={}}on(e,f){this.events[e]=f;return this}start(){this.events.ready?.()}stop(){}removeAllListeners(){}sendData(type,data){for(const room of Object.keys(this.config.roomTokens))(window.sent||=[]).push({room,type,data});return true}}
export class WebRtcSdk{static EVENTS={CONNECTED:'connected',ERROR:'error',STOP_CONNECT:'stop',CAMERA_STATE_CHANGED:'camera',CAMERA_ERROR:'cameraError'};constructor(options,deps){this.options=options;this.deps=deps;this.events={}}on(e,f){(this.events[e]||=[]).push(f)}off(e,f){this.events[e]=this.events[e]?.filter(x=>x!==f)||[]}emit(e,v){for(const f of [...(this.events[e]||[])])f(v)}init(){this.client=this.deps.clientFactory(this.options.connectConfig);this.options.mountedElement.append(document.createElement('video'));this.emit('connected')}disableAudio(){}volumeUp(){return this.client.sendChannelData('ActionInput',{keyCode:24,meta:0})}volumeDown(){return this.client.sendChannelData('ActionInput',{keyCode:25,meta:0})}scroll(delta){return this.client.sendChannelData('ActionWheel',{axis:-Math.sign(delta)})}goHome(){this.client.sendChannelData('ActionInput',{keyCode:3})}goBack(){this.client.sendChannelData('ActionInput',{keyCode:4})}goTask(){this.client.sendChannelData('ActionInput',{keyCode:187})}destroy(){this.client.stop();this.options.mountedElement.replaceChildren()}}
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
  await page.route('**/sdk/browser.iife.js', route => route.fulfill({ contentType: 'text/javascript', body: fakeSdk.replaceAll('export ', '') + '\nglobalThis.WebRTCSDK={WebRtcSdk,WebRtcClient,ControlGroupClient,EmitType,ChannelDataType,TouchData,InputData,KeyEventData,WheelData,getKeyEventData};' }));
  await page.route('**/sdk/styles.css', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('https://preview.example/**', route => route.fulfill({ contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': '*' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640"><rect width="360" height="640" fill="#192943"/></svg>' }));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[name=accessKey]').fill('test-ak'); await page.locator('[name=secretKey]').fill('test-sk');
  await page.getByRole('button', { name: '连接并查询云机' }).click();
  await page.locator('#phones tr').first().waitFor();
  assert.equal(await page.locator('[name=accessKey]').inputValue(), 'test-ak');
  assert.equal(await page.locator('[name=secretKey]').inputValue(), 'test-sk');
  for (const phone of phones.slice(0, 2)) await page.locator('#phones tr').filter({ hasText: phone.phoneCode }).getByRole('checkbox').check();
  await page.getByRole('button', { name: '群控所选云机' }).click();
  await page.locator('#primary video').waitFor();
  await page.getByRole('button', { name: '新增云机', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '新增群控云机' });
  await picker.getByRole('checkbox', { name: 'P3', exact: true }).check();
  assert.equal(await picker.getByRole('checkbox', { name: 'P1（已在群控中）', exact: true }).isDisabled(), true);
  await picker.getByRole('button', { name: '加入群控', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('follower-status').textContent === '从控控制就绪 2 / 2 台');
  await page.locator('.tile .picture img').first().waitFor();
  for (const width of [1630, 1024, 375]) {
    await page.setViewportSize({ width, height: 970 });
    assert.equal(await page.locator('.tile header').evaluateAll(headers => headers.every(header => {
      const code = header.querySelector('strong');
      return header.firstElementChild.textContent.match(/主控|从控/) && code.scrollWidth <= code.clientWidth + 1
        && getComputedStyle(code).textOverflow !== 'ellipsis' && header.querySelectorAll('summary').length === 1;
    })), true);
    assert.equal(await page.locator('.picture').first().evaluate(box => box.getBoundingClientRect().height), 480);
    assert.equal(await page.locator('.picture img').first().evaluate(img => {
      const box=img.parentElement.getBoundingClientRect(), frame=img.getBoundingClientRect();
      return frame.bottom <= box.bottom + 1 && frame.top >= box.top - 1 && getComputedStyle(img).objectFit === 'contain';
    }), true);
  }
  await page.setViewportSize({ width: 1630, height: 970 });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  assert.deepEqual((await page.evaluate(() => window.sent.filter(item=>item.type==='ActionInput'))).map(item => item.room).sort(), ['P1', 'P2', 'P3']);
  const second = page.locator('.tile').filter({ has: page.getByText('P2', { exact: true }) });
  await second.getByRole('button', { name: '操控', exact: true }).click();
  await second.getByRole('menuitem', { name: '设为主控', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('primary-name').textContent === 'P2' && document.querySelector('#primary video'));
  assert.equal(await second.locator('.picture').innerText(), '操控中');
  assert.deepEqual(await page.locator('.tile strong').allTextContents(), ['P1', 'P2', 'P3']);
  assert.equal(await page.evaluate(() => window.maximum), 1);
  const third = page.locator('.tile').filter({ has: page.getByText('P3', { exact: true }) });
  await third.getByRole('button', { name: '操控', exact: true }).click();
  assert.equal(await third.getByRole('menuitemcheckbox', { name: '参与同步', exact: true }).getAttribute('aria-checked'), 'true');
  await third.getByRole('menuitemcheckbox', { name: '参与同步', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('follower-status').textContent === '从控控制就绪 1 / 1 台');
  await third.getByRole('button', { name: '操控', exact: true }).click();
  await third.getByRole('menuitem', { name: '移除', exact: true }).click();
  assert.deepEqual(await page.locator('.tile strong').allTextContents(), ['P1', 'P2']);
  const newSecond = page.locator('.tile').filter({ has: page.getByText('P2', { exact: true }) });
  await newSecond.getByRole('button', { name: '操控', exact: true }).click();
  await newSecond.getByRole('menuitem', { name: '移除', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('primary-name').textContent === 'P1' && document.querySelector('#primary video'));
  const remaining = page.locator('.tile');
  await remaining.getByRole('button', { name: '操控', exact: true }).click();
  assert.equal(await remaining.getByRole('menuitem', { name: '移除', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '断开群控', exact: true }).click();
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await page.locator('#primary video').waitFor();
  await page.locator('#sync').uncheck();
  await page.waitForFunction(() => document.querySelector('#primary video') !== null);
  assert.equal(await page.evaluate(() => window.active), 1);
  assert.equal(await page.evaluate(() => window.maximum), 1);
  const logout = page.waitForResponse(response => response.url().endsWith('/api/logout'));
  await page.getByRole('button', { name: '退出并清除凭据' }).click();
  await logout;
  await page.waitForFunction(() => window.active === 0);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.equal(await page.locator('[name=accessKey]').inputValue(), '');
  assert.equal(await page.locator('[name=secretKey]').inputValue(), '');
  assert.equal(destroyed, 1);
});
