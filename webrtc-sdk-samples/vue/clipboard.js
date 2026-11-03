// Public WebRtcClient event; keep this file with control.js when copying a demo.
export function mountCloudClipboard(api, client) {
  let disposed = false, version = 0, panel;
  const removePanel = () => { panel?.remove(); panel = undefined; };
  const current = mine => !disposed && mine === version;

  function legacyCopy(text) {
    let copied = false;
    const previous = document.activeElement;
    const input = document.createElement('textarea');
    input.value = text; input.readOnly = true;
    Object.assign(input.style, { position: 'fixed', left: '-9999px', top: '0', opacity: '0' });
    const onCopy = event => {
      if (!event.clipboardData) return;
      event.preventDefault(); event.clipboardData.setData('text/plain', text); copied = true;
    };
    document.body.append(input);
    document.addEventListener('copy', onCopy, true);
    try {
      input.focus(); input.select(); input.setSelectionRange(0, text.length);
      return document.execCommand('copy') && copied;
    } catch { return false; }
    finally {
      document.removeEventListener('copy', onCopy, true); input.remove();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    }
  }

  function show(text, mine) {
    if (!current(mine)) return;
    removePanel();
    panel = document.createElement('aside');
    panel.dataset.cloudClipboard = '';
    panel.setAttribute('aria-label', '云机剪贴板提示');
    Object.assign(panel.style, { position: 'fixed', top: '24px', left: '50%', transform: 'translateX(-50%)',
      width: 'min(320px, calc(100vw - 48px))', boxSizing: 'border-box', padding: '12px', border: '1px solid #ffe58f',
      borderRadius: '8px', background: '#fffbe6', color: '#262626', font: '14px/1.5 sans-serif', zIndex: '1100' });
    const message = document.createElement('p'); message.textContent = '云机文字待复制';
    message.setAttribute('role', 'status'); message.style.margin = '0 0 8px';
    const actions = document.createElement('div');
    Object.assign(actions.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });
    const button = (label, action) => {
      const element = document.createElement('button'); element.type = 'button'; element.textContent = label;
      Object.assign(element.style, { cursor: 'pointer', padding: '4px 8px', border: '1px solid #d9d9d9',
        borderRadius: '4px', background: '#fff', color: '#262626', font: 'inherit' });
      element.onclick = action; actions.append(element); return element;
    };
    const copy = button('复制到本机', async () => {
      if (!current(mine) || copy.disabled) return;
      copy.disabled = true; message.setAttribute('role', 'status');
      try {
        let copied = false;
        try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; } }
        catch { /* A user click can still use the legacy copy fallback. */ }
        if (!current(mine)) return;
        if (!copied) copied = legacyCopy(text);
        message.textContent = copied ? '已复制到本机' : '复制失败，请查看文字并手工复制';
        message.setAttribute('role', copied ? 'status' : 'alert');
      } finally { if (current(mine)) copy.disabled = false; }
    });
    let preview;
    const view = button('查看文字', () => {
      if (!preview) {
        preview = document.createElement('textarea'); preview.readOnly = true; preview.value = text;
        preview.setAttribute('aria-label', '云机复制的文字'); preview.rows = 4;
        Object.assign(preview.style, { boxSizing: 'border-box', width: '100%', marginTop: '8px', maxHeight: '180px', resize: 'vertical' });
        panel.append(preview);
      } else preview.hidden = !preview.hidden;
      view.textContent = preview.hidden ? '查看文字' : '收起文字';
      view.setAttribute('aria-expanded', String(!preview.hidden));
    });
    view.setAttribute('aria-expanded', 'false');
    const close = button('关闭', () => { ++version; removePanel(); });
    close.setAttribute('aria-label', '关闭剪贴板提示');
    panel.append(message, actions); document.body.append(panel);
  }

  async function receive(text) {
    if (disposed || typeof text !== 'string' || !text) return;
    const mine = ++version;
    removePanel();
    try {
      // Automatic writes never create a focused input or interrupt cloud typing.
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(text);
      if (current(mine)) removePanel();
    } catch { show(text, mine); }
  }
  client.on(api.EmitType.cloudClipData, receive);
  return () => {
    if (disposed) return;
    disposed = true; ++version; removePanel();
    client.off(api.EmitType.cloudClipData, receive);
  };
}
