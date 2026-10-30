import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const servers = [];
const browser = await chromium.launch({ headless: true, executablePath: process.env.SAMPLES_BROWSER_PATH });
try {
 for (const [index, name] of ['vanilla','react','vue','script'].entries()) {
  const dir = resolve(root, name, 'dist');
  const server = createServer(async (req,res) => {
   try {
    const pathname = req.url.split('?')[0];
    if (pathname === '/__verify/control.js' || pathname === '/__verify/camera.js' || pathname === '/__verify/sdk.js') {
     const require = createRequire(resolve(root, name, 'package.json'));
     const path = pathname.endsWith('sdk.js') ? resolve(dirname(require.resolve('@vmaos/webrtc-sdk')), 'browser.iife.js') : resolve(root, name, pathname.endsWith('camera.js') ? 'camera.js' : 'control.js');
     res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(path)); return;
    }
    const path = resolve(dir, '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!path.startsWith(dir + '/')) throw new Error('outside root');
    const body = await readFile(path);
    res.setHeader('Content-Type', { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png' }[extname(path)] || 'application/octet-stream'); res.end(body);
   } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); servers.push(server);
  const port = server.address().port;
  const context = await browser.newContext(); const page = await context.newPage();
  const requests = []; const errors = [];
  page.on('request', req => requests.push(req.url())); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByText(/AK\/SK 不能放到前端项目中/).waitFor();
  const input = page.getByLabel('OpenAPI 结果 JSON'), connect = page.getByRole('button', { name:'连接云机' });
  await input.fill('invalid json'); await connect.click();
  await page.getByRole('status').filter({hasText:'请输入有效的 OpenAPI 结果 JSON'}).waitFor();
  const data = {signalServerUrl:'wss://signal.example.com',roomId:'sample-room',token:'sample-sensitive-ticket',turnServerUris:['turn:127.0.0.1:3478'],expiresAt:'2026-01-01T00:00:00Z'};
  await input.fill(JSON.stringify({code:200000000,data})); await connect.click();
  await page.getByRole('status').filter({hasText:'票据已过期'}).waitFor();
  await input.fill(JSON.stringify({code:200000000,data,SK:'should-never-be-sent'})); await connect.click();
  await page.getByRole('status').filter({hasText:'请勿粘贴 AK/SK'}).waitFor();
  data.expiresAt = new Date(Date.now()+25000).toISOString();
  await input.fill(JSON.stringify({code:200000000,data})); await connect.click();
  assert.equal(await input.inputValue(),'');
  await page.getByRole('button',{name:'断开并清空'}).click();
  await page.getByRole('status').filter({hasText:'已断开'}).waitFor();
  assert.equal(await page.locator('.device').evaluate(el => el.childElementCount),0);
  assert.equal(await page.locator('.camera-panel').count(),0);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length),0);
  assert(!requests.some(url => url.includes('/open-api/')));
  assert.deepEqual(errors,[]);
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // Use the published SDK event emitter, with operation stubs. No cloud or camera access.
  await page.addScriptTag({url:`http://127.0.0.1:${port}/__verify/sdk.js`});
  await page.evaluate(async () => {
   const { mountCameraControls } = await import('/__verify/camera.js');
   const Sdk = window.WebRTCSDK.WebRtcSdk;
   if (!Sdk.EVENTS.CAMERA_STATE_CHANGED || !Sdk.EVENTS.CAMERA_ERROR) throw new Error('Published SDK has no camera events');
   const host = document.createElement('div'); document.body.append(host);
   const sdk = new Sdk({mountedElement:host,connectConfig:{}});
   const calls = [];
   sdk.startCamera = async () => { calls.push('retry'); };
   sdk.switchCamera = async options => { calls.push(options.useBackCamera ? 'back' : 'front'); };
   sdk.stopCamera = () => { calls.push('stop'); sdk.emit(Sdk.EVENTS.CAMERA_STATE_CHANGED,{state:'idle',active:false}); };
   const cleanup = mountCameraControls(Sdk,sdk,host);
   const check = (ok, text) => { if (!ok) throw new Error(text); };
   const panel = host.querySelector('.camera-panel');
   const button = key => host.querySelector(`[data-camera="${key}"]`);
   check(panel.hidden && calls.length === 0, 'No camera capture on connect');
   sdk.emit(Sdk.EVENTS.CAMERA_STATE_CHANGED,{state:'requesting',active:false});
   check(!panel.hidden && !button('stop').hidden && button('retry').hidden, 'Pending authorization UI');
   sdk.emit(Sdk.EVENTS.CAMERA_STATE_CHANGED,{state:'active',active:true});
   check(host.textContent.includes('摄像头传输中') && !button('front').hidden, 'Active camera UI');
   button('front').click(); button('back').click();
   sdk.emit(Sdk.EVENTS.CAMERA_STATE_CHANGED,{state:'error',active:true});
   sdk.emit(Sdk.EVENTS.CAMERA_ERROR,{message:'权限被拒绝'});
   check(host.querySelector('[role="alert"]').textContent === '权限被拒绝' && !button('stop').hidden, 'Switch failure retains active controls');
   button('retry').click(); button('stop').click();
   check(JSON.stringify(calls) === JSON.stringify(['front','back','retry','stop']) && panel.hidden, 'Camera public operations');
   sdk.startCamera = async () => { sdk.emit(Sdk.EVENTS.CAMERA_STATE_CHANGED,{state:'requesting',active:false}); throw new Error('denied'); };
   sdk.emit(Sdk.EVENTS.CAMERA_STATE_CHANGED,{state:'error',active:false});
   button('retry').click(); await new Promise(resolve => setTimeout(resolve,0));
   check(host.textContent.includes('摄像头操作失败'), 'Rejected operation is handled');
   cleanup();
   check(host.childElementCount === 0 && sdk.listenerCount(Sdk.EVENTS.CAMERA_STATE_CHANGED) === 0 && sdk.listenerCount(Sdk.EVENTS.CAMERA_ERROR) === 0, 'Camera listeners removed');
   sdk.destroy(); host.remove();
  });
  await page.evaluate(async () => {
   const { createControlledSdk } = await import('/__verify/control.js');
   const api = window.WebRTCSDK, events = [], mirrored = [];
   const host = document.createElement('div'); host.style.cssText = 'position:fixed;inset:0;width:360px;height:640px'; document.body.append(host);
   const originalStart = api.WebRtcClient.prototype.startConnection;
   const originalSend = api.WebRtcClient.prototype.sendChannelData;
   api.WebRtcClient.prototype.startConnection = function () {};
   api.WebRtcClient.prototype.sendChannelData = function (type,data) { events.push({type,data}); return true; };
   let sdk;
   const check = (ok,label) => { if (!ok) throw new Error(label); };
   try {
    sdk = createControlledSdk(api, {mountedElement:host,connectConfig:{signalServerUrl:'wss://signal.example',roomId:'P1',token:'test-only',hostTurn:[]}}, (type,data) => mirrored.push({type,data}));
    sdk.init(); sdk.emit(api.WebRtcSdk.EVENTS.CONNECTED);
    const video = host.querySelector('video');
    Object.defineProperty(video,'videoWidth',{value:360}); Object.defineProperty(video,'videoHeight',{value:640});
    video.getBoundingClientRect = () => ({left:0,top:0,width:360,height:640});
    video.setPointerCapture = () => {}; video.hasPointerCapture = () => false;
    host.dispatchEvent(new PointerEvent('pointerenter'));
    const input = host.querySelector('[aria-label="云机键盘输入"]');
    check(document.activeElement === input, 'Cloud screen owns input focus');
    const clip = new DataTransfer(); clip.setData('text/plain','你好\nclipboard');
    const paste = new ClipboardEvent('paste',{clipboardData:clip,cancelable:true,bubbles:true}); input.dispatchEvent(paste);
    check(paste.defaultPrevented, 'Paste default suppressed');
    check(events.length === 1 && events[0].data.text === '你好\nclipboard', 'Paste sent once');
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value = '中文'; input.dispatchEvent(new InputEvent('input',{data:'中文',isComposing:true}));
    check(events.length === 1, 'Composition intermediate text ignored');
    input.dispatchEvent(new CompositionEvent('compositionend',{data:'中文'}));
    input.value = '中文'; input.dispatchEvent(new InputEvent('input',{data:'中文'}));
    check(events.length === 2, 'Composition committed once');
    input.dispatchEvent(new KeyboardEvent('keydown',{code:'Backspace',key:'Backspace',bubbles:true,cancelable:true}));
    check(events.at(-1).data.keyCode === 67, 'Backspace forwarded');
    const before = events.length;
    input.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyV',key:'v',ctrlKey:true,bubbles:true}));
    input.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyV',key:'v',metaKey:true,bubbles:true}));
    check(events.length === before, 'Paste shortcuts do not forward physical key');
    video.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,pointerType:'mouse',button:0,clientX:180,clientY:320,bubbles:true,cancelable:true}));
    check(events.at(-1).data.action === 0 && events.at(-1).data.x === .5 && events.at(-1).data.y === .5, 'Normalized touch sent once');
    const moves = events.length;
    window.dispatchEvent(new Event('blur'));
    check(events.length === moves+1 && events.at(-1).data.action === 1, 'Blur releases touch');
    const blurredCount = events.length;
    input.dispatchEvent(new CompositionEvent('compositionend',{data:'迟到输入'}));
    input.dispatchEvent(new InputEvent('input',{data:'迟到输入'}));
    check(events.length === blurredCount, 'Late input after blur is ignored');
    host.dispatchEvent(new PointerEvent('pointerenter'));
    video.dispatchEvent(new PointerEvent('pointerdown',{pointerId:2,pointerType:'mouse',button:0,clientX:100,clientY:100,bubbles:true,cancelable:true}));
    video.dispatchEvent(new PointerEvent('pointercancel',{pointerId:2,bubbles:true,cancelable:true}));
    check(events.at(-1).data.action === 1 && events.at(-1).data.x === 100/360, 'Canceled touch released at last position');
    check(events.length === mirrored.length, 'Main and follower input payloads agree');
    sdk.destroy(); const count = events.length;
    input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:clip,cancelable:true,bubbles:true}));
    check(events.length === count && !host.children.length, 'Disposed session consumes no input');
   } finally { sdk?.destroy(); host.remove(); api.WebRtcClient.prototype.startConnection=originalStart; api.WebRtcClient.prototype.sendChannelData=originalSend; }
  });
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.evaluate(async () => {
   const { createControlledSdk }=await import('/__verify/control.js'), api=window.WebRTCSDK;
   const host=document.createElement('div');document.body.append(host);
   const originalStart=api.WebRtcClient.prototype.startConnection, originalSend=api.WebRtcClient.prototype.sendChannelData;
   const sent=[];
   api.WebRtcClient.prototype.startConnection=function(){};
   api.WebRtcClient.prototype.sendChannelData=function(type,data){sent.push({type,data});return true;};
   const sdk=createControlledSdk(api,{mountedElement:host,connectConfig:{signalServerUrl:'wss://signal.example',roomId:'P1',token:'test-only',hostTurn:[]}});
   sdk.init();sdk.emit(api.WebRtcSdk.EVENTS.CONNECTED);host.dispatchEvent(new PointerEvent('pointerenter'));
   window.pasteVerification={sent,cleanup(){sdk.destroy();host.remove();api.WebRtcClient.prototype.startConnection=originalStart;api.WebRtcClient.prototype.sendChannelData=originalSend;}};
   await navigator.clipboard.writeText('实际 Ctrl+V\n你好');
  });
  try {
   await page.keyboard.press('Control+V');
   await page.waitForFunction(()=>window.pasteVerification.sent.filter(event=>event.type==='ActionChinese').length===1);
   assert.equal(await page.evaluate(()=>window.pasteVerification.sent.find(event=>event.type==='ActionChinese').data.text),'实际 Ctrl+V\n你好');
  } finally { await page.evaluate(()=>{window.pasteVerification.cleanup();delete window.pasteVerification;}); }
  assert.deepEqual(errors,[]);
  console.log(`${name}: paste/IME/key/touch/blur/cleanup and camera state/retry/switch/stop/error passed; rendered security guidance; invalid/expired/AK-SK rejected; SDK initialized/destroyed; no browser storage/OpenAPI calls; mobile fits`);
  await context.close();
 }
} finally { await browser.close(); await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
