import { createHash, createHmac } from 'node:crypto';

const encode = value => encodeURIComponent(value).replace(/[!'()*]/g,
  char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const hexSha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function redactLogValue(value) {
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    /^(ak|sk|accesskey|accesskeyid|accesskeysecret|secretkey|secretaccesskey|sessiontoken|token|password|secret|signature|authorization|xvmaosaccesskey|xvmaossignature)$/i
      .test(key.replace(/[-_]/g, '')) ? '[REDACTED]' : redactLogValue(child),
  ]));
}

export function printOpenApiLog(entry) {
  console.log(`[OpenAPI ${entry.event}] ${entry.method} ${entry.path}\n${JSON.stringify(entry, null, 2)}`);
}

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

export function createOpenApiClient({ baseUrl, accessKey, secretKey, fetchImpl = fetch, logger = () => {} }) {
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
    const headers = signRequest(url, body, accessKey, secretKey);
    const startedAt = Date.now();
    const emit = entry => logger(redactLogValue({ method: 'POST', path, ...entry }));
    // 日志只包含脱敏后的 JSON，不包含认证请求头；解析已序列化的字节以反映实际入参。
    emit({ event: 'request', body: JSON.parse(body.toString('utf8')) });
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST', body, headers,
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      emit({ event: 'error', durationMs: Date.now() - startedAt, errorType: error.name });
      throw error;
    }
    let envelope;
    try { envelope = await response.json(); } catch {
      emit({ event: 'response', httpStatus: response.status, durationMs: Date.now() - startedAt,
        body: '[非 JSON 响应，正文省略]' });
      throw new Error(`OpenAPI 返回非 JSON 响应，HTTP ${response.status}`);
    }
    emit({ event: 'response', httpStatus: response.status, durationMs: Date.now() - startedAt, body: envelope });
    if (!response.ok || envelope.code !== response.status * 1_000_000) {
      // 详细响应通过上面的脱敏日志查看；异常摘要不包含完整响应。
      throw new Error(`OpenAPI HTTP ${response.status}，code=${envelope.code}，traceId=${envelope.traceId ?? '-'}`);
    }
    if (envelope.data == null) throw new Error('OpenAPI 成功响应缺少 data');
    return envelope.data;
  };
}

export function clientFromEnv({ logger } = {}) {
  return createOpenApiClient({ baseUrl: process.env.VMAOS_BASE_URL,
    accessKey: process.env.VMAOS_ACCESS_KEY, secretKey: process.env.VMAOS_SECRET_KEY, logger });
}

export function reportError(error) {
  // SDK 原始异常可能包含请求上下文，因此命令行只显示简单消息。
  console.error(error.message);
  process.exitCode = 1;
}
