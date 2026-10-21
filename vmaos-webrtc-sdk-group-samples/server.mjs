import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep } from 'node:path';
import { createClient } from './openapi.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export function createSampleServer({ baseUrl, clientFactory = createClient } = {}) {
  const sessions = new Map();
  const remove = id => { sessions.get(id)?.client.destroy(); sessions.delete(id); };
  const expiry = setInterval(() => {
    for (const [id, session] of sessions) if (session.expires <= Date.now()) remove(id);
  }, 30_000); expiry.unref();
  const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      if (!host || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${host}`).hostname)) return send(res, 403, { error: '仅供本机调试' });
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'POST') return send(res, 405, { error: '需要 POST' });
        if (req.headers.origin !== `http://${host}` || !String(req.headers['content-type']).startsWith('application/json')) return send(res, 403, { error: '请求来源无效' });
        let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 32768) return send(res, 413, { error: '请求过大' }); }
        const body = JSON.parse(text || '{}');
        const id = /(?:^|;\s*)vmaos_group=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
        if (url.pathname === '/api/session') {
          if (sessions.size >= 100) return send(res, 429, { error: '会话数量过多' });
          const client = clientFactory(baseUrl, body.accessKey, body.secretKey);
          if (id) remove(id);
          const next = randomBytes(32).toString('hex'); sessions.set(next, { client, expires: Date.now() + 30 * 60_000 });
          res.setHeader('Set-Cookie', `vmaos_group=${next}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=1800`);
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/logout') {
          if (id) remove(id); res.setHeader('Set-Cookie', 'vmaos_group=; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=0');
          return send(res, 200, { ok: true });
        }
        const session = sessions.get(id);
        if (!session || session.expires <= Date.now()) { if (id) remove(id); return send(res, 401, { error: '请重新输入 AK/SK' }); }
        const routes = { '/api/phones': '/open-api/phone/query', '/api/group-ticket': '/open-api/phone/group-connection-ticket',
          '/api/ticket': '/open-api/phone/connection-ticket', '/api/previews': '/open-api/phone/screenshot-token' };
        if (!Object.hasOwn(routes, url.pathname)) return send(res, 404, { error: '接口不存在' });
        return send(res, 200, await session.client.call(routes[url.pathname], body));
      }
      if (req.method !== 'GET') return send(res, 405, { error: '需要 GET' });
      const isSdk = url.pathname.startsWith('/sdk/');
      const base = isSdk ? dirname(fileURLToPath(import.meta.resolve('@vmaos/webrtc-sdk'))) : resolve(root, 'public');
      const name = isSdk ? url.pathname.slice(5) : url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = resolve(base, name);
      if (!file.startsWith(base + sep)) return send(res, 404, { error: '文件不存在' });
      const ext = file.split('.').at(-1), type = { html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', ico: 'image/x-icon' }[ext];
      if (!type) return send(res, 404, { error: '文件不存在' });
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes);
    } catch (error) {
      // 不输出请求、认证信息、票据或上游原始异常。
      send(res, 400, { error: error.message?.startsWith('OpenAPI HTTP') ? error.message : '请求失败，请检查输入或服务配置' });
    }
  });
  server.on('close', () => { clearInterval(expiry); for (const id of sessions.keys()) remove(id); });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 5176);
  createSampleServer({ baseUrl: process.env.VMAOS_BASE_URL || 'https://api.example.com' }).listen(port, '127.0.0.1', () => console.log(`群控教程：http://127.0.0.1:${port}`));
}
