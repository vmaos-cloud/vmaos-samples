// A relative control: zero is neutral, never an estimate of current cloud volume.
export function mountRelativeVolume(host, { up, down }) {
  host.innerHTML = `<div class="relative-volume"><div class="relative-volume-header"><label>音量调整</label><output>不调整</output></div><input type="range" aria-label="相对音量调整" min="-5" max="5" step="1" value="0" disabled><div class="relative-volume-help"><span>− 减小</span><span>0</span><span>增大 ＋</span></div><p class="relative-volume-hint">松手调整 · 自动回中</p></div>`;
  const input = host.querySelector('input'), output = host.querySelector('output');
  const keys = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown']);
  const listeners = [];
  let enabled = false, running = false, draft = 0, interaction, timer, revision = 0;
  const describe = () => draft === 0 ? '不调整' : `${draft > 0 ? '增大' : '减小'} ${Math.abs(draft)} 步`;
  function render() {
    input.value = String(draft); input.disabled = !enabled || running;
    input.setAttribute('aria-valuetext',describe()); input.setAttribute('aria-busy',String(running));
    output.textContent = running ? '调整中…' : describe();
  }
  function reset() { clearTimeout(timer); revision++; interaction = undefined; draft = 0; running = false; render(); }
  function listen(target,type,callback) { target.addEventListener(type,callback); listeners.push(()=>target.removeEventListener(type,callback)); }
  function commit() {
    if (!enabled || running || !interaction) return;
    const delta = draft; interaction = undefined; draft = 0;
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 5) { render(); return; }
    running = true; render(); const token = ++revision;
    let left = Math.abs(delta);
    function step() {
      if (!enabled || token !== revision) return;
      let sent = false;
      try { sent = (delta > 0 ? up() : down()) === true; } catch { /* No replay after failure. */ }
      if (!sent || --left === 0) { running = false; render(); return; }
      timer = setTimeout(step,80);
    }
    step();
  }
  const preview = () => {
    if (!enabled || running || !interaction) return;
    const value = Number(input.value);
    if (Number.isInteger(value) && Math.abs(value) <= 5) { draft = value; render(); }
  };
  listen(input,'input',preview); listen(input,'change',preview);
  listen(input,'pointerdown',event=>{
    if (!enabled || running || interaction || event.button !== 0) return;
    interaction = {kind:'pointer',id:event.pointerId};
    try { input.setPointerCapture?.(event.pointerId); } catch { /* Synthetic/unsupported capture. */ }
  });
  listen(input,'pointerup',event=>{ if (interaction?.kind === 'pointer' && interaction.id === event.pointerId) commit(); });
  for (const type of ['pointercancel','lostpointercapture']) listen(input,type,()=>{if(interaction?.kind==='pointer')reset();});
  listen(input,'keydown',event=>{
    if (event.key === 'Escape') { reset(); return; }
    if (!keys.has(event.key)) return;
    event.stopPropagation();
    if (enabled && !running && !interaction) interaction = {kind:'keyboard'};
  });
  listen(input,'keyup',event=>{
    if (!keys.has(event.key)) return;
    event.stopPropagation(); if (interaction?.kind === 'keyboard') commit();
  });
  listen(input,'blur',()=>{if(interaction)reset();});
  listen(window,'blur',reset); listen(document,'visibilitychange',()=>{if(document.hidden)reset();});
  const stop = event=>event.stopPropagation(); listen(host,'click',stop);
  render();
  return {
    setEnabled(value) { const next = value === true; if (next !== enabled || !next) reset(); enabled = next; render(); },
    cancel: reset,
    destroy() { enabled = false; reset(); listeners.forEach(remove=>remove()); host.replaceChildren(); },
  };
}
