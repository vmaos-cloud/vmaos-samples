import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const demos = ['vanilla', 'react', 'vue', 'script'];
if (process.argv.includes('--group')) demos.push('../webrtc-sdk-group-samples/public');
const server = createServer(async (req, res) => {
  try {
    const [, index, name] = req.url.split('/');
    if (!demos[index] || !['control.js', 'clipboard.js', 'sdk.js'].includes(name)) {
      res.setHeader('Content-Type', 'text/html'); res.end('<div id="device" style="width:320px;height:400px"></div>'); return;
    }
    const dir = resolve(root, demos[index]);
    const require = createRequire(resolve(index === '4' ? resolve(dir, '..') : dir, 'package.json'));
    const file = name === 'sdk.js' ? resolve(dirname(require.resolve('@vmaos/webrtc-sdk')), 'browser.iife.js') : resolve(dir, name);
    res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.SAMPLES_BROWSER_PATH });
  for (const [index, demo] of demos.entries()) {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base);
    await page.addScriptTag({ url: `${base}/${index}/sdk.js` });
    await page.evaluate(async index => {
      const api = window.WebRTCSDK;
      const { createControlledSdk } = await import(`/${index}/control.js`);
      window.writes = []; window.actions = [];
      api.WebRtcClient.prototype.startConnection = function () { window.client = this; };
      api.WebRtcClient.prototype.sendChannelData = (...args) => { window.actions.push(args); return true; };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.writes.push(text); } } });
      window.sdk = createControlledSdk(api, { mountedElement: '#device', connectConfig: { signalServerUrl: 'wss://signal.example', roomId: 'test', token: 'test-only', hostTurn: [] } });
      window.sdk.init(); window.sdk.emit(api.WebRtcSdk.EVENTS.CONNECTED);
      document.querySelector('#device').dispatchEvent(new PointerEvent('pointerenter'));
      window.cloudCopy = text => window.client.emit(api.EmitType.cloudClipData, text);
      window.cloudCopy('云机文字\nhello 😀');
    }, index);
    await page.waitForFunction(() => window.writes.length === 1);
    assert.deepEqual(await page.evaluate(() => window.writes), ['云机文字\nhello 😀']);
    assert.equal(await page.locator('[data-cloud-clipboard]').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '云机键盘输入');
    assert.equal(await page.evaluate(() => window.actions.length), 0);
    const before = await page.locator('#device').boundingBox();
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      document.addEventListener('copy', event => { window.nativeCopy = event.clipboardData.getData('text/plain'); });
      window.cloudCopy('云机文字\nhello 😀');
    });
    const panel = page.locator('[data-cloud-clipboard]'); await panel.waitFor();
    assert.deepEqual(await page.locator('#device').boundingBox(), before);
    const box = await panel.boundingBox();
    assert.equal(box.y, 24); assert(Math.abs(box.x + box.width / 2 - 640) < 1);
    assert.equal(await page.getByRole('textbox', { name: '云机复制的文字' }).count(), 0);
    await page.getByRole('button', { name: '查看文字', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '云机复制的文字' }).inputValue(), '云机文字\nhello 😀');
    await page.getByRole('button', { name: '复制到本机', exact: true }).click();
    await page.getByText('已复制到本机', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.nativeCopy), '云机文字\nhello 😀');
    await page.getByRole('button', { name: '关闭剪贴板提示' }).click(); await panel.waitFor({ state: 'detached' });
    await page.evaluate(() => window.cloudCopy('云机文字\nhello 😀')); await panel.waitFor();
    await page.evaluate(() => {
      document.execCommand = () => false;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
    });
    await page.getByRole('button', { name: '复制到本机', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '请查看文字并手工复制' }).waitFor();
    // A previous fallback must disappear while a newer automatic copy is pending.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise((_, reject) => { window.rejectReplacement = reject; }) } });
      window.cloudCopy('replacement');
    });
    assert.equal(await panel.count(), 0);
    await page.evaluate(() => window.rejectReplacement(new Error('denied'))); await panel.waitFor();
    await page.getByRole('button', { name: '查看文字', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '云机复制的文字' }).inputValue(), 'replacement');
    await page.setViewportSize({ width: 390, height: 844 });
    const narrow = await panel.boundingBox();
    assert.equal(narrow.y, 24); assert(Math.abs(narrow.x + narrow.width / 2 - 195) < 1);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(async () => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: text => text === 'old' ? new Promise((_, reject) => { window.rejectOld = reject; }) : Promise.resolve() } });
      window.cloudCopy('old'); window.cloudCopy('new'); await new Promise(resolve => setTimeout(resolve, 0));
      window.rejectOld(new Error('late denial')); await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal(await panel.count(), 0);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise((_, reject) => { window.rejectLate = reject; }) } });
      window.cloudCopy('pending'); window.sdk.destroy(); window.rejectLate(new Error('late'));
    });
    await page.waitForTimeout(20);
    assert.equal(await panel.count(), 0);
    assert.equal(await page.evaluate(() => window.client.listenerCount(window.WebRTCSDK.EmitType.cloudClipData)), 0);
    assert.deepEqual(errors, []);
    console.log(`PASS ${demo}: automatic copy, HTTP fallback, preview, close, ordering and cleanup`);
    await page.close();
  }
} finally {
  await browser?.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
