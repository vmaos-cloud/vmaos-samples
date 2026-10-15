import { createHash, createHmac } from 'node:crypto';

const encode = value => encodeURIComponent(value).replace(/[!'()*]/g,
  char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const hexSha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// SK 是 Base64URL 编码的 32 字节密钥，不能直接用展示字符串作为 HMAC 密钥。
export function signRequest(url, body, accessKey, secretKey, timestamp = String(Date.now())) {
  const key = Buffer.from(secretKey, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== secretKey) {
    throw new Error('SK 必须为 32 字节密钥的无填充 Base64URL 编码');
  }
  const query = [...url.searchParams].map(([name, value]) => [encode(name), encode(value)])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
    .map(pair => pair.join('=')).join('&');
  const canonical = ['HMAC-SHA-256', accessKey, timestamp, 'POST', url.pathname,
    query, url.host.toLowerCase(), 'application/json', hexSha256(body)].join('\n');
  try {
    return {
      'Content-Type': 'application/json',
      'X-VMAOS-Algorithm': 'HMAC-SHA-256',
      'X-VMAOS-Access-Key': accessKey,
      'X-VMAOS-Timestamp': timestamp,
      'X-VMAOS-Signature': createHmac('sha256', key).update(canonical, 'utf8').digest('hex'),
    };
  } finally {
    key.fill(0);
  }
}

export function createOpenApiClient({ baseUrl, accessKey, secretKey, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))
      || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('VMAOS_BASE_URL 必须是 HTTPS origin（仅本机调试允许 HTTP）');
  }
  if (!accessKey || /[\s\r\n]/.test(accessKey) || !secretKey) throw new Error('请设置 AK/SK 环境变量');
  return async (path, data, { timeoutMs = 30_000 } = {}) => {
    if (!['/open-api/board/query', '/open-api/storage/upload-sts', '/open-api/storage/upload-probe'].includes(path)) {
      throw new Error('示例未支持此接口');
    }
    const url = new URL(path, base);
    // 只序列化一次：签名和 fetch 发送完全相同的 UTF-8 字节。
    const body = Buffer.from(JSON.stringify(data), 'utf8');
    const response = await fetchImpl(url, {
      method: 'POST', body, headers: signRequest(url, body, accessKey, secretKey),
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    let envelope;
    try { envelope = await response.json(); } catch {
      throw new Error(`OpenAPI 返回非 JSON 响应，HTTP ${response.status}`);
    }
    if (!response.ok || envelope.code !== response.status * 1_000_000) {
      // 不输出请求头、请求体或完整响应，避免泄漏签名和临时凭证。
      throw new Error(`OpenAPI HTTP ${response.status}，code=${envelope.code}，traceId=${envelope.traceId ?? '-'}`);
    }
    if (envelope.data == null) throw new Error('OpenAPI 成功响应缺少 data');
    return envelope.data;
  };
}

export function clientFromEnv() {
  return createOpenApiClient({ baseUrl: process.env.VMAOS_BASE_URL,
    accessKey: process.env.VMAOS_ACCESS_KEY, secretKey: process.env.VMAOS_SECRET_KEY });
}

export function reportError(error) {
  // SDK 原始异常可能包含请求上下文，因此命令行只显示简单消息。
  console.error(error.message);
  process.exitCode = 1;
}
