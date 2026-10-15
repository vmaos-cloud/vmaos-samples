import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const servers = [];
const browser = await chromium.launch({ headless: true, executablePath: process.env.VMAOS_SAMPLES_BROWSER_PATH });
try {
 for (const [index, name] of ['vanilla','react','vue','script'].entries()) {
  const dir = resolve(root, name, 'dist');
  const server = createServer(async (req,res) => {
   try {
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
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length),0);
  assert(!requests.some(url => url.includes('/open-api/')));
  assert.deepEqual(errors,[]);
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log(`${name}: rendered security guidance; invalid/expired/AK-SK rejected; SDK initialized/destroyed; no browser storage/OpenAPI calls; mobile fits`);
  await context.close();
 }
} finally { await browser.close(); await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
