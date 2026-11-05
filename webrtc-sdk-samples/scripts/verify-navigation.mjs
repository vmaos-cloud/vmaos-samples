import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const demos = ['vanilla', 'react', 'vue', 'script'];
const server = createServer(async (req, res) => {
  try {
    const [, index, name] = req.url.split('/');
    if (!demos[index] || !['sdk.js', 'navigation.js', 'volume.js'].includes(name)) {
      res.setHeader('Content-Type', 'text/html'); res.end('<div id="navigation"></div>'); return;
    }
    const dir = resolve(root, demos[index]);
    const require = createRequire(resolve(dir, 'package.json'));
    const file = name === 'sdk.js' ? resolve(dirname(require.resolve('@vmaos/webrtc-sdk')), 'browser.iife.js') : resolve(dir, name);
    res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.SAMPLES_BROWSER_PATH });
  for (const [index, name] of demos.entries()) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({ url: `/${index}/sdk.js` });
    await page.evaluate(async index => {
      const { mountRemoteNavigation } = await import(`/${index}/navigation.js`);
      const Sdk = window.WebRTCSDK.WebRtcSdk;
      const sdk = new Sdk({mountedElement:'#unused',connectConfig:{}});
      const calls = []; let accepted = true;
      for (const method of ['goTask','goHome','goBack','volumeUp','volumeDown','disableAudio','enableAudio']) sdk[method] = () => { calls.push(method); return accepted; };
      const host = document.getElementById('navigation');
      const nav = mountRemoteNavigation(host);
      const check = (value, message) => { if (!value) throw new Error(message); };
      const more = () => host.querySelector('[aria-label="更多功能"]');
      const item = text => [...host.querySelectorAll('[role="menuitem"]')].find(button => button.textContent === text);
      check([...host.querySelectorAll('nav > button')].map(button => button.getAttribute('aria-label')).join(',') === '最近任务,Home,返回,更多功能', 'Navigation order matches connected cloud screen');
      check([...host.querySelectorAll('button')].every(button => button.disabled), 'No operation before connection');
      nav.bind(Sdk,sdk); sdk.emit(Sdk.EVENTS.CONNECTED);
      more().click(); check(more().getAttribute('aria-expanded') === 'true', 'More menu opens');
      const slider=host.querySelector('input[type=range]');
      slider.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); slider.value='1'; slider.dispatchEvent(new Event('input',{bubbles:true}));
      check(calls.length===0,'Relative volume previews without sending');
      slider.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true}));
      check(calls.at(-1)==='volumeUp' && slider.value==='0' && more().getAttribute('aria-expanded')==='true','Release adjusts once, centres and retains popup');
      more().click();
      more().click(); item('静音').click();
      more().click(); check(item('恢复声音') && calls.at(-1)==='disableAudio', 'Mute becomes restore');
      accepted=false; item('恢复声音').click(); more().click(); check(item('恢复声音'), 'Failed send retains mute state');
      accepted=true; item('恢复声音').click(); more().click(); check(item('静音') && calls.at(-1)==='enableAudio', 'Restore sends once and changes label');
      document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); check(more().getAttribute('aria-expanded')==='false', 'Outside pointer closes menu');
      more().click(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); check(more().getAttribute('aria-expanded')==='false', 'Escape closes menu');
      more().click(); sdk.emit('control-state',{connected:false});
      check(more().disabled && more().getAttribute('aria-expanded')==='false', 'ICE interruption disables and closes menu');
      const count=calls.length; slider.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));slider.value='5';slider.dispatchEvent(new Event('input',{bubbles:true}));slider.dispatchEvent(new KeyboardEvent('keyup',{key:'End',bubbles:true}));check(calls.length===count&&slider.disabled,'No offline operation');
      sdk.emit('control-state',{connected:true}); more().click(); check(item('静音'), 'ICE recovery retains session audio state');
      sdk.emit(Sdk.EVENTS.STOP_CONNECT); check(more().disabled, 'Terminal disconnect disables navigation');
      nav.disconnect(); check(sdk.listenerCount('control-state')===0, 'Replacing session releases listeners');
      nav.bind(Sdk,sdk); sdk.emit(Sdk.EVENTS.CONNECTED); more().click(); check(item('静音'), 'New session starts with audio enabled');
      nav.destroy(); check(host.childElementCount===0 && sdk.listenerCount(Sdk.EVENTS.CONNECTED)===0, 'Unmount releases DOM and listeners');
    }, index);
    assert.equal(await page.locator('#navigation').textContent(),'');
    await page.close(); console.log(`${name}: navigation, mute, disconnect and lifecycle verified`);
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
