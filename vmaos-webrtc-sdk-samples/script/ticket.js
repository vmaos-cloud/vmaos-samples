// 只解析后端返回的成功响应，不调用 OpenAPI，不存储凭据。
export function parseTicket(text, now = Date.now()) {
  let result;
  try { result = JSON.parse(text); } catch { throw new Error("请输入有效的 OpenAPI 结果 JSON"); }
  function rejectSecrets(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(ak|sk|access[-_]?key|secret[-_]?key|access[-_]?key[-_]?id|access[-_]?key[-_]?secret|authorization|x[-_]?ak|x[-_]?sk)$/i.test(key)) {
        throw new Error("请勿粘贴 AK/SK 或鉴权请求头，只输入 connection-ticket 响应");
      }
      rejectSecrets(child);
    }
  }
  rejectSecrets(result);
  if (result?.code !== 200000000 || !result.data || typeof result.data !== "object") {
    throw new Error("需要 code 为 200000000 的完整成功响应，请重新从后端获取票据");
  }
  const data = result.data;
  for (const key of ["signalServerUrl", "roomId", "token", "expiresAt"]) {
    if (typeof data[key] !== "string" || !data[key].trim()) throw new Error("缺少或无效的连接字段：" + key);
  }
  let signal;
  try { signal = new URL(data.signalServerUrl); } catch { throw new Error("信令地址必须是有效的 ws/wss 地址"); }
  if (!["ws:", "wss:"].includes(signal.protocol) || !signal.hostname || signal.username || signal.password) {
    throw new Error("信令地址必须是有效且不含账号密码的 ws/wss 地址");
  }
  if (globalThis.location?.protocol === "https:" && signal.protocol !== "wss:") throw new Error("HTTPS 页面必须使用 WSS 信令地址");
  if (!Array.isArray(data.turnServerUris) || !data.turnServerUris.length || data.turnServerUris.some(value => typeof value !== "string" || !value.trim())) {
    throw new Error("turnServerUris 必须是非空字符串数组");
  }
  const expiry = Date.parse(data.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) throw new Error("票据已过期或 expiresAt 无效，请重新调用后端获取票据");
  return { signalServerUrl: data.signalServerUrl, roomId: data.roomId, token: data.token,
    hostTurn: [...data.turnServerUris], spareTurn: [], signAgain: false, enableLogger: false };
}
