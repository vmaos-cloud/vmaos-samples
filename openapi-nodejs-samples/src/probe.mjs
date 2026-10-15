import { setTimeout as sleep } from 'node:timers/promises';

export async function waitForFile(api, fileTid, {
  timeoutMs = 300_000, sleepImpl = sleep, now = Date.now, onProgress = () => {},
} = {}) {
  if (!/^[1-9][0-9]*$/.test(fileTid)) throw new Error('fileTid 必须为正整数十进制字符串');
  const deadline = now() + timeoutMs;
  let delayMs = 1500;
  while (now() < deadline) {
    await sleepImpl(Math.min(delayMs, Math.max(0, deadline - now())));
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const probe = await api('/open-api/storage/upload-probe', {
      fileTid, forceFailIfIncomplete: false,
    }, { timeoutMs: Math.max(1, Math.min(30_000, remaining)) });
    onProgress({ fileTid, status: probe.status, stage: probe.stage });
    if (probe.status === 1) return probe;
    if (probe.status !== 0) throw new Error(`文件不可用：fileTid=${fileTid}，status=${probe.status}，stage=${probe.stage}`);
    delayMs = Number.isFinite(probe.nextProbeAfterSeconds) && probe.nextProbeAfterSeconds > 0
      ? Math.max(1000, probe.nextProbeAfterSeconds * 1000) : 2000;
  }
  throw new Error(`探测等待超时，fileTid=${fileTid}；可稍后继续 probe，此操作不会终止服务端上传`);
}
