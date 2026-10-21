import { createHash, createHmac } from 'node:crypto';

const paths = new Set(['/open-api/phone/query', '/open-api/phone/connection-ticket',
  '/open-api/phone/group-connection-ticket', '/open-api/phone/screenshot-token']);
export function createClient(baseUrl, accessKey, secretKey, fetchImpl = fetch) {
  const base = new URL(baseUrl);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
      || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('API 地址须为 HTTPS origin；本机调试允许 HTTP');
  const key = Buffer.from(secretKey, 'base64url');
  if (!accessKey || /\s/.test(accessKey) || key.length !== 32 || key.toString('base64url') !== secretKey) {
    key.fill(0); throw new Error('请输入有效 AK/SK');
  }
  return {
    destroy() { key.fill(0); },
    async call(path, data) {
      if (!paths.has(path)) throw new Error('不支持的接口');
      const url = new URL(path, base), timestamp = String(Date.now());
      const body = Buffer.from(JSON.stringify(data));
      const canonical = ['HMAC-SHA-256', accessKey, timestamp, 'POST', url.pathname, '',
        url.host.toLowerCase(), 'application/json', createHash('sha256').update(body).digest('hex')].join('\n');
      const response = await fetchImpl(url, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: {
        'Content-Type': 'application/json', 'X-VMAOS-Algorithm': 'HMAC-SHA-256', 'X-VMAOS-Access-Key': accessKey,
        'X-VMAOS-Timestamp': timestamp, 'X-VMAOS-Signature': createHmac('sha256', key).update(canonical).digest('hex'),
      } });
      const result = await response.json();
      if (!response.ok || result.code !== 200000000 || result.data == null) {
        throw new Error(`OpenAPI HTTP ${response.status}, code=${Number(result.code) || 0}, traceId=${String(result.traceId || '').replace(/[^a-zA-Z0-9_-]/g, '')}`);
      }
      return result.data;
    },
  };
}
