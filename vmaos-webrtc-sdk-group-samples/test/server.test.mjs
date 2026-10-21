import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createSampleServer } from '../server.mjs';
import { createClient } from '../openapi.mjs';

test('signs exact bytes on the backend and limits calls to public phone APIs', async () => {
  const key = Buffer.alloc(32, 7), sk = key.toString('base64url'); let observed;
  const client = createClient('https://api.example.com', 'demo-ak', sk, async (url, options) => {
    observed = options; assert.equal(url.pathname, '/open-api/phone/group-connection-ticket');
    const canonical = ['HMAC-SHA-256', 'demo-ak', options.headers['X-VMAOS-Timestamp'], 'POST', url.pathname, '',
      'api.example.com', 'application/json', createHash('sha256').update(options.body).digest('hex')].join('\n');
    assert.equal(options.headers['X-VMAOS-Signature'], createHmac('sha256', key).update(canonical).digest('hex'));
    return Response.json({ code: 200000000, data: { main: {} } });
  });
  await client.call('/open-api/phone/group-connection-ticket', { mainPhoneCode: 'P1', followerPhoneCodes: ['P2'] });
  assert.deepEqual(JSON.parse(observed.body), { mainPhoneCode: 'P1', followerPhoneCodes: ['P2'] });
  await assert.rejects(client.call('/private/debug', {}), /不支持/); client.destroy();
});

test('keeps AK/SK server-side, rejects cross-origin callers, isolates and destroys sessions', async t => {
  const calls = [], destroyed = [];
  const server = createSampleServer({ baseUrl: 'https://api.example.com', clientFactory: (_base, ak, sk) => {
    assert.equal(ak, 'demo-ak'); assert.equal(sk, 'demo-secret');
    return { call: async (path, body) => { calls.push({ path, body }); return { items: [], hasMore: false }; }, destroy: () => destroyed.push(true) };
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie, source = origin) => fetch(origin + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: source, ...(cookie ? { Cookie: cookie } : {}),
  }, body: JSON.stringify(body) });
  assert.equal((await post('/api/session', {}, '', 'https://other.example')).status, 403);
  assert.equal((await post('/api/phones', {})).status, 401);
  const login = await post('/api/session', { accessKey: 'demo-ak', secretKey: 'demo-secret' });
  assert.equal(login.status, 200); assert.deepEqual(await login.json(), { ok: true });
  const cookie = login.headers.get('set-cookie'); assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const session = cookie.split(';')[0];
  assert.equal((await post('/api/phones', { scroller: { cursor: null, size: 100 } }, session)).status, 200);
  assert.equal(calls[0].path, '/open-api/phone/query');
  assert.equal((await post('/api/group-ticket', { mainPhoneCode: 'P1', followerPhoneCodes: ['P2'] }, session)).status, 200);
  assert.equal(calls[1].path, '/open-api/phone/group-connection-ticket');
  await post('/api/logout', {}, session); assert.equal(destroyed.length, 1);
  assert.equal((await post('/api/phones', {}, session)).status, 401);
});
