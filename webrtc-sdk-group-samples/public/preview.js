// Public preview URLs only. The queue is shared by all visible tiles on this page.
let running = 0;
const waiting = [];
async function acquire(signal) {
  signal.throwIfAborted();
  if (running < 4) { running++; return; }
  await new Promise((resolve, reject) => {
    const entry = { resume: () => { signal.removeEventListener('abort', cancel); resolve(); } };
    const cancel = () => { const index = waiting.indexOf(entry); if (index !== -1) waiting.splice(index, 1); reject(signal.reason); };
    waiting.push(entry); signal.addEventListener('abort', cancel, { once: true });
  });
}
function release() { const next = waiting.shift(); if (next) next.resume(); else running--; }
async function download(url, signal) {
  await acquire(signal);
  try {
    signal.throwIfAborted();
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    const raw = response.headers.get('X-Screenshot-Token-Remaining-Ms');
    const remaining = raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
    const blob = response.ok ? await response.blob() : undefined;
    if (!response.ok) await response.body?.cancel();
    return { status: response.status, remaining, blob };
  } finally { release(); }
}
function paintDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted(); const start = performance.now(); let frame;
    const cancel = () => { cancelAnimationFrame(frame); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    const tick = now => {
      if (now - start < ms) frame = requestAnimationFrame(tick);
      else { signal.removeEventListener('abort', cancel); resolve(); }
    };
    frame = requestAnimationFrame(tick);
  });
}
async function decode(image, signal) {
  signal.throwIfAborted();
  let cancel;
  const stopped = new Promise((_, reject) => { cancel = () => { image.src = ''; reject(signal.reason); }; signal.addEventListener('abort', cancel, { once: true }); });
  try { await Promise.race([image.decode(), stopped]); signal.throwIfAborted(); }
  finally { signal.removeEventListener('abort', cancel); }
}
export class Preview {
  constructor(box, root, renew = () => {}) {
    this.box = box; this.url = ''; this.visible = typeof IntersectionObserver === 'undefined'; this.renew = renew;
    this.status = document.createElement('span'); this.status.className = 'preview-status'; this.status.setAttribute('role', 'status'); this.box.replaceChildren(this.status);
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver(entries => { this.visible = entries[0].isIntersecting; this.restart(); }, { root, rootMargin: '0px' });
      this.observer.observe(box);
    }
    this.visibility = () => this.restart(); document.addEventListener('visibilitychange', this.visibility);
    this.showStatus('等待截图');
  }
  showStatus(value) { this.status.textContent = value; }
  setUrl(url) { if (this.disposed) return; this.url = url; this.restart(); }
  restart() {
    this.controller?.abort();
    if (this.disposed || !this.visible || document.hidden || !this.url) return;
    const controller = this.controller = new AbortController(); void this.run(controller.signal);
  }
  async run(signal) {
    while (!signal.aborted) {
      let delay = 1000, objectUrl;
      try {
        const frame = await download(this.url, signal); signal.throwIfAborted();
        if ((frame.status === 200 || frame.status === 404) && frame.remaining !== undefined && frame.remaining <= 30000) this.renew();
        if (frame.status === 403) { this.showStatus('预览授权已失效，等待续期'); this.renew(); return; }
        if (frame.status === 404) this.showStatus('等待截图');
        else if (frame.status !== 200) { this.showStatus('正在重试预览'); delay = 5000; }
        else {
          objectUrl = URL.createObjectURL(frame.blob); const image = new Image(); image.alt = '云机画面'; image.decoding = 'async'; image.src = objectUrl;
          await decode(image, signal);
          const old = this.objectUrl; this.objectUrl = objectUrl; objectUrl = undefined;
          this.box.replaceChildren(image, this.status); this.showStatus(''); if (old) URL.revokeObjectURL(old);
        }
      } catch {
        if (signal.aborted) return;
        this.showStatus('正在重试预览'); delay = 5000;
      } finally { if (objectUrl) URL.revokeObjectURL(objectUrl); }
      try { await paintDelay(delay, signal); } catch { return; }
    }
  }
  destroy() {
    if (this.disposed) return;
    this.disposed = true; this.controller?.abort(); this.observer?.disconnect(); document.removeEventListener('visibilitychange', this.visibility);
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.box.replaceChildren();
  }
}
