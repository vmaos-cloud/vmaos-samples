// Browser-only presentation of the public screenshot API; no platform implementation is imported.
let transfers = 0;
const queue = [];
async function download(url, signal) {
  if (transfers < 4) transfers++; else await new Promise(resolve => queue.push(resolve));
  try {
    signal.throwIfAborted();
    const reply = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!reply.ok) { await reply.body?.cancel(); throw Object.assign(new Error('预览暂不可用'), { status: reply.status }); }
    return await reply.blob();
  } finally { const next = queue.shift(); if (next) next(); else transfers--; }
}
function paintDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted(); const begin = performance.now(); let frame;
    const cancel = () => { cancelAnimationFrame(frame); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    const step = now => { if (now - begin < ms) frame = requestAnimationFrame(step); else { signal.removeEventListener('abort', cancel); resolve(); } };
    frame = requestAnimationFrame(step);
  });
}
export class Preview {
  constructor(box, root) {
    this.box = box; this.url = ''; this.visible = false;
    this.observer = new IntersectionObserver(entries => { this.visible = entries[0].isIntersecting; this.restart(); }, { root, rootMargin: '0px' });
    this.observer.observe(box);
    this.visibility = () => this.restart(); document.addEventListener('visibilitychange', this.visibility);
  }
  setUrl(url) { this.url = url; this.restart(); }
  restart() {
    this.controller?.abort();
    if (!this.visible || document.hidden || !this.url) return;
    const controller = this.controller = new AbortController(); void this.run(controller.signal);
  }
  async run(signal) {
    while (!signal.aborted) {
      let delay = 1000, next;
      try {
        const blob = await download(this.url, signal); signal.throwIfAborted();
        next = URL.createObjectURL(blob); const image = new Image(); image.alt = '云机画面'; image.decoding = 'async'; image.src = next;
        await image.decode(); signal.throwIfAborted();
        const old = this.objectUrl; this.objectUrl = next; next = null;
        this.box.replaceChildren(image); if (old) URL.revokeObjectURL(old);
      } catch (error) {
        if (next) URL.revokeObjectURL(next);
        if (signal.aborted) return;
        if (error.status === 403) { this.box.textContent = '预览授权已失效，等待续期'; return; }
        if (!this.objectUrl) this.box.textContent = error.status === 404 ? '等待截图' : '正在重试预览';
        if (error.status !== 404) delay = 5000;
      }
      try { await paintDelay(delay, signal); } catch { return; }
    }
  }
  destroy() {
    this.controller?.abort(); this.observer.disconnect(); document.removeEventListener('visibilitychange', this.visibility);
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}
