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
    if (pathname === '/__verify/camera.js' || pathname === '/__verify/sdk.js') {
     const require = createRequire(resolve(root, name, 'package.json'));
     const path = pathname.endsWith('camera.js') ? resolve(root, name, 'camera.js') : resolve(dirname(require.resolve('@vmaos/webrtc-sdk')), 'browser.iife.js');
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
  assert.deepEqual(errors,[]);
  console.log(`${name}: camera state/retry/switch/stop/error/cleanup passed; rendered security guidance; invalid/expired/AK-SK rejected; SDK initialized/destroyed; no browser storage/OpenAPI calls; mobile fits`);
  await context.close();
 }
} finally { await browser.close(); await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
