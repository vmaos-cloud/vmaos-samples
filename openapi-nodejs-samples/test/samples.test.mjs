import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signRequest, createOpenApiClient } from '../src/client.mjs';
import { queryBoards } from '../src/boards.mjs';
import { waitForFile } from '../src/probe.mjs';
import { uploadFile } from '../src/upload.mjs';
import { multipartUpload } from '../src/multipart.mjs';

const sk = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64url');
const ak = 'AK7WyN4fQp9_z3Hk2mLs8DxA';
const digest = body => createHash('sha256').update(body).digest('hex');
async function fixture(t, content = Buffer.from('abc')) {
  const dir = await mkdtemp(join(tmpdir(), 'public-sample-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'demo.bin'); await writeFile(path, content);
  return path;
}
const sts = { endpoint: 'https://s3.example.com', region: 'demo-region', forcePathStyle: true,
  bucket: 'sample-bucket', objectKey: 'sample-object', accessKeyId: 'synthetic',
  secretAccessKey: 'synthetic', sessionToken: 'synthetic', expiration: '2099-01-01T00:00:00Z' };

test('HMAC matches published interoperability vector; strict SK decoding', () => {
  const headers = signRequest(new URL('https://openapi.sample.com/openapi/v1/containers/query?page=1'),
    Buffer.from('{"status":1}'), ak, sk, '1789893015123');
  assert.equal(headers['X-API-Signature'], 'e55d0512e0508809e9b21ce7fab8f084590fc07240066cae65e2d9f3de0849cb');
  assert.throws(() => signRequest(new URL('https://example.com'), Buffer.from('{}'), ak, sk + '='), /SK/);
});

test('query canonicalization sorts encoded names/values and retains duplicates', () => {
  const sign = query => signRequest(new URL(`https://example.com/open-api/board/query?${query}`), Buffer.from('{}'), ak, sk, '1')['X-API-Signature'];
  assert.equal(sign('x=b&x=a&space=a+b'), sign('space=a%20b&x=a&x=b'));
  assert.notEqual(sign('x=b&x=a'), sign('x=a'));
});

test('client signs exact transmitted UTF-8 bytes and uses nine-digit success code', async () => {
  let request;
  const api = createOpenApiClient({ baseUrl: 'https://api.example.com', accessKey: ak, secretKey: sk,
    fetchImpl: async (url, options) => {
      request = options;
      const signed = signRequest(url, options.body, ak, sk, options.headers['X-API-Timestamp']);
      assert.deepEqual(options.headers, signed);
      assert.equal(options.redirect, 'error');
      assert.equal(options.body.toString(), '{"name":"中文"}');
      return Response.json({ code: 200000000, data: { ok: true } });
    } });
  assert.deepEqual(await api('/open-api/board/query', { name: '中文' }), { ok: true });
  assert.ok(request.signal);
});

test('client rejects business errors and unsafe origins without logging credentials', async () => {
  for (const baseUrl of ['http://example.com', 'https://example.com/path', 'https://user:pass@example.com']) {
    assert.throws(() => createOpenApiClient({ baseUrl, accessKey: ak, secretKey: sk }), /origin/);
  }
  const api = createOpenApiClient({ baseUrl: 'https://example.com', accessKey: ak, secretKey: sk,
    fetchImpl: async () => Response.json({ code: 422604001, traceId: 'demo-trace', secret: 'must-not-print' }, { status: 422 }) });
  await assert.rejects(api('/open-api/board/query', {}), error => /422604001.*demo-trace/.test(error.message) && !error.message.includes('must-not-print'));
});

test('board scrolling passes the entire cursor and preserves filters', async () => {
  const calls = [];
  const api = async (path, data) => {
    calls.push({ path, data });
    return { items: [], hasMore: calls.length === 1, nextCursor: calls.length === 1 ? { id: '9007199254740993' } : null };
  };
  const pages = [];
  for await (const page of queryBoards(api, { status: 2, online: true })) pages.push(page);
  assert.equal(pages.length, 2);
  assert.deepEqual(calls[1].data, { scroller: { cursor: { id: '9007199254740993' }, size: 200 }, status: 2, online: true });
});

test('probe waits 1.5s initially then honors server delay and success', async () => {
  let clock = 0; const delays = []; let count = 0;
  const api = async (path, body) => {
    assert.equal(path, '/open-api/storage/upload-probe');
    assert.deepEqual(body, { fileTid: '123', forceFailIfIncomplete: false });
    return { fileTid: '123', status: ++count === 1 ? 0 : 1, nextProbeAfterSeconds: 3 };
  };
  const result = await waitForFile(api, '123', { now: () => clock, sleepImpl: async ms => { clock += ms; delays.push(ms); } });
  assert.equal(result.status, 1); assert.deepEqual(delays, [1500, 3000]);
});

for (const status of [-1, -2, 2]) {
  test(`probe rejects terminal status ${status}`, async () => {
    await assert.rejects(waitForFile(async () => ({ status, stage: 'TEST' }), '123', { sleepImpl: async () => {} }), new RegExp(`status=${status}`));
  });
}

test('probe local timeout never forces server failure', async () => {
  let clock = 0; let calls = 0;
  await assert.rejects(waitForFile(async (_, body) => { calls++; assert.equal(body.forceFailIfIncomplete, false); return { status: 0 }; }, '123', {
    timeoutMs: 2000, now: () => clock, sleepImpl: async ms => { clock += ms; },
  }), /超时.*fileTid=123/);
  assert.equal(calls, 1);
});

test('upload hashes original bytes and follows STS → multipart → probe', async t => {
  const path = await fixture(t); const steps = [];
  const result = await uploadFile(async (endpoint, body) => {
    steps.push('sts'); assert.equal(endpoint, '/open-api/storage/upload-sts');
    assert.equal(body.sha256, digest('abc')); assert.equal(body.sizeBytes, 3); assert.equal(body.fileCategory, 'OTHER');
    return { fileTid: '123', status: 0, sts };
  }, path, '/demo.bin', 'OTHER', { onProgress: () => {},
    uploadImpl: async (file, size, sha, credentials) => {
      steps.push('multipart'); assert.equal(size, 3); assert.equal(sha, digest('abc')); assert.equal(credentials, sts); assert.ok(file);
    }, probeImpl: async (_, id) => { steps.push('probe'); return { fileTid: id, status: 1 }; } });
  assert.deepEqual(steps, ['sts', 'multipart', 'probe']); assert.equal(result.status, 1);
});

test('deduplicated file skips S3 and probe', async t => {
  const path = await fixture(t);
  const unexpected = async () => assert.fail('must not run');
  const result = await uploadFile(async () => ({ fileTid: '123', status: 1, sts: null }), path, '/demo.bin', 'OTHER', {
    onProgress: () => {}, uploadImpl: unexpected, probeImpl: unexpected,
  });
  assert.equal(result.reused, true);
});

test('multipart uploads actual slices, preserves ETags and combines parts in order', async t => {
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 3, 7); const path = await fixture(t, bytes);
  const file = await open(path, 'r'); t.after(() => file.close());
  const commands = []; const bodies = []; let destroyed = false;
  await multipartUpload(file, bytes.length, digest(bytes), sts, { partSize: 5 * 1024 * 1024,
    clientFactory: options => {
      assert.equal(options.forcePathStyle, true); assert.equal(options.credentials.sessionToken, 'synthetic');
      return { destroy: () => { destroyed = true; }, send: async command => {
        commands.push(command.constructor.name);
        assert.equal(command.input.Key, sts.objectKey);
        if (command.constructor.name === 'CreateMultipartUploadCommand') return { UploadId: 'demo-upload' };
        if (command.constructor.name === 'UploadPartCommand') { bodies.push(command.input.Body); return { ETag: `etag-${command.input.PartNumber}` }; }
        assert.deepEqual(command.input.MultipartUpload.Parts, [{ PartNumber: 1, ETag: 'etag-1' }, { PartNumber: 2, ETag: 'etag-2' }]);
        return {};
      } };
    } });
  assert.deepEqual(Buffer.concat(bodies), bytes);
  assert.deepEqual(commands, ['CreateMultipartUploadCommand', 'UploadPartCommand', 'UploadPartCommand', 'CompleteMultipartUploadCommand']);
  assert.equal(destroyed, true);
});

test('multipart failure aborts precise upload and never completes or leaks SDK error', async t => {
  const path = await fixture(t); const file = await open(path, 'r'); t.after(() => file.close());
  const commands = [];
  await assert.rejects(multipartUpload(file, 3, digest('abc'), sts, { clientFactory: () => ({ destroy() {}, send: async command => {
    commands.push(command.constructor.name);
    if (command.constructor.name === 'CreateMultipartUploadCommand') return { UploadId: 'demo-upload' };
    if (command.constructor.name === 'UploadPartCommand') throw new Error('secretAccessKey=must-not-print');
    assert.equal(command.input.UploadId, 'demo-upload'); return {};
  } }) }), error => /分片上传失败/.test(error.message) && !error.message.includes('must-not-print'));
  assert.deepEqual(commands, ['CreateMultipartUploadCommand', 'UploadPartCommand', 'AbortMultipartUploadCommand']);
});

test('upload API logs request and response while preserving real STS credentials for S3', async () => {
  const logs = [];
  const envelope = { code: 200000000, message: 'success', traceId: 'demo-trace', data: {
    fileTid: '123', status: 0, sts: { ...sts, accessKeyId: 'temporary-access',
      secretAccessKey: 'temporary-secret', sessionToken: 'temporary-token' },
  } };
  let sentBody;
  const api = createOpenApiClient({ baseUrl: 'https://example.com', accessKey: ak, secretKey: sk,
    logger: entry => logs.push(entry), fetchImpl: async (_, options) => {
      sentBody = options.body.toString(); return Response.json(envelope);
    } });
  const body = { tenantPath: '/应用/demo.xapk', sha256: digest('abc'), sizeBytes: 3, fileCategory: 'APK' };
  const result = await api('/open-api/storage/upload-sts', body);
  assert.deepEqual(logs[0], { method: 'POST', path: '/open-api/storage/upload-sts', event: 'request', body });
  assert.equal(sentBody, JSON.stringify(body));
  assert.equal(logs[1].httpStatus, 200); assert.equal(logs[1].body.traceId, 'demo-trace');
  assert.equal(logs[1].body.data.sts.objectKey, 'sample-object');
  assert.equal(logs[1].body.data.sts.accessKeyId, '[REDACTED]');
  assert.equal(logs[1].body.data.sts.secretAccessKey, '[REDACTED]');
  assert.equal(logs[1].body.data.sts.sessionToken, '[REDACTED]');
  assert.equal(typeof logs[1].durationMs, 'number');
  assert.equal(result.sts.secretAccessKey, 'temporary-secret');
  const text = JSON.stringify(logs);
  for (const secret of [ak, sk, 'temporary-access', 'temporary-secret', 'temporary-token']) {
    assert.ok(!text.includes(secret));
  }
});

test('probe logs complete error envelope and recursively redacts sensitive fields', async () => {
  const logs = [];
  const api = createOpenApiClient({ baseUrl: 'https://example.com', accessKey: ak, secretKey: sk,
    logger: entry => logs.push(entry), fetchImpl: async () => Response.json({
      code: 500904001, message: 'internal server error', traceId: 'error-trace',
      details: [{ secret: 'hidden-response', 'session_token': 'hidden-token' }],
    }, { status: 500 }) });
  await assert.rejects(api('/open-api/storage/upload-probe', {
    fileTid: '123', forceFailIfIncomplete: false, nested: [{ SK: 'hidden-request' }],
  }), /500904001/);
  assert.equal(logs[0].body.fileTid, '123');
  assert.equal(logs[0].body.nested[0].SK, '[REDACTED]');
  assert.equal(logs[1].httpStatus, 500);
  assert.equal(logs[1].body.message, 'internal server error');
  assert.equal(logs[1].body.traceId, 'error-trace');
  assert.ok(!JSON.stringify(logs).includes('hidden-'));
});

test('non-JSON and network failures log diagnostics without dumping raw contents', async () => {
  for (const network of [false, true]) {
    const logs = [];
    const api = createOpenApiClient({ baseUrl: 'https://example.com', accessKey: ak, secretKey: sk,
      logger: entry => logs.push(entry), fetchImpl: async () => {
        if (network) throw new TypeError('hidden-network-detail');
        return new Response('hidden-page-content', { status: 502 });
      } });
    await assert.rejects(api('/open-api/storage/upload-probe', { fileTid: '123' }));
    assert.equal(logs[0].event, 'request');
    assert.equal(logs[1].event, network ? 'error' : 'response');
    if (network) assert.equal(logs[1].errorType, 'TypeError');
    else assert.equal(logs[1].httpStatus, 502);
    assert.ok(!JSON.stringify(logs).includes('hidden-'));
  }
});
