import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createSampleServer } from '../server.mjs';

test('preview pool cancels queued tiles and recovers an unchanged URL after renewal', async t => {
  const server = createSampleServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SAMPLES_BROWSER_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.previewObservers = [];
    window.IntersectionObserver = class {
      constructor(callback) { this.callback = callback; window.previewObservers.push(this); }
      observe() { queueMicrotask(() => this.callback([{ isIntersecting: true }])); }
      disconnect() {}
    };
  });
  let requests = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const image = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
  await page.route('https://preview.example/queued/**', async route => {
    requests++; await gate;
    await route.fulfill({ contentType: 'image/svg+xml', headers: { 'Access-Control-Allow-Origin': '*' }, body: image }).catch(() => {});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const { Preview } = await import('/preview.js'); window.framesUnderTest = [];
    for (let i = 0; i < 6; i++) {
      const box = document.createElement('div'); document.body.append(box);
      const preview = new Preview(box, null); preview.setUrl(`https://preview.example/queued/${i}`); window.framesUnderTest.push(preview);
    }
  });
  for (let i = 0; requests < 4 && i < 100; i++) await page.waitForTimeout(10);
  assert.equal(requests, 4);
  await page.evaluate(() => {
    window.framesUnderTest.slice(4).forEach(preview => preview.destroy());
    window.previewObservers.slice(0, 4).forEach(observer => observer.callback([{ isIntersecting: false }]));
  });
  release(); await page.waitForTimeout(100);
  assert.equal(requests, 4, 'Canceled queued tiles must not begin a transfer');
  await page.evaluate(() => window.framesUnderTest.forEach(preview => preview.destroy()));
  let recoveryRequests = 0;
  await page.route('https://preview.example/recover', route => {
    recoveryRequests++;
    return route.fulfill({ status: recoveryRequests === 1 ? 403 : 200, contentType: 'image/svg+xml',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Screenshot-Token-Remaining-Ms', 'X-Screenshot-Token-Remaining-Ms': '20000' }, body: recoveryRequests === 1 ? '' : image });
  });
  await page.evaluate(async () => {
    const { Preview } = await import('/preview.js'); const box = document.createElement('div'); box.id='recover'; document.body.append(box);
    window.renewRequests = 0;
    window.recoveryPreview = new Preview(box, null, () => window.renewRequests++);
    window.recoveryPreview.setUrl('https://preview.example/recover');
  });
  await page.locator('#recover').getByText('预览授权已失效，等待续期').waitFor();
  await page.waitForTimeout(100); assert.equal(recoveryRequests, 1);
  await page.evaluate(() => window.recoveryPreview.setUrl('https://preview.example/recover'));
  await page.locator('#recover img').waitFor();
  assert.equal(recoveryRequests, 2);
  assert.equal(await page.evaluate(() => window.renewRequests), 2, '403 and short remaining lifetime request renewal');
  await page.evaluate(() => window.recoveryPreview.destroy());
});
