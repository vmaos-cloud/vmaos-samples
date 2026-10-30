// Tutorial input adapter built only from the public SDK API.
// Keep this file beside the demo when copying it into a separate project.
export function createControlledSdk(api, options, onAction = () => {}) {
  const host = typeof options.mountedElement === 'string' ? document.querySelector(options.mountedElement) : options.mountedElement;
  let ready = false, focused = false, disposed = false, client, gesture, composing = false, committed;
  const input = document.createElement('textarea');
  input.setAttribute('aria-label', '云机键盘输入');
  input.autocomplete = 'off'; input.autocapitalize = 'off'; input.spellcheck = false;
  input.tabIndex = -1;
  Object.assign(input.style, { position: 'absolute', width: '1px', height: '1px', opacity: '0', padding: '0', border: '0', pointerEvents: 'none' });
  const listeners = [];
  function listen(target, type, handler, capture = false) {
    target.addEventListener(type, handler, capture);
    listeners.push(() => target.removeEventListener(type, handler, capture));
  }
  const send = (type, data) => ready && !disposed && client?.sendChannelData(type, data);
  const text = value => { if (focused && value) send(api.ChannelDataType.ActionChinese, new api.InputData(value)); input.value = ''; };
  function finishTouch() {
    if (!gesture) return;
    const previous = gesture; gesture = undefined;
    send(api.ChannelDataType.ClickData, new api.TouchData(1, 0, previous.x, previous.y, Math.max(0, Math.round(performance.now() - previous.started))));
    if (previous.video.hasPointerCapture?.(previous.id)) previous.video.releasePointerCapture(previous.id);
  }
  function blur() { focused = false; finishTouch(); composing = false; committed = undefined; input.value = ''; input.blur(); }
  function focus() { if (ready && !disposed && !document.hidden) { input.focus({ preventScroll: true }); focused = document.activeElement === input; } }
  function point(video, event) {
    const box = video.getBoundingClientRect(), width = video.videoWidth, height = video.videoHeight;
    if (!box.width || !box.height || !width || !height) return;
    const scale = Math.min(box.width / width, box.height / height), w = width * scale, h = height * scale;
    const x = (event.clientX - box.left - (box.width - w) / 2) / w;
    const y = (event.clientY - box.top - (box.height - h) / 2) / h;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : undefined;
  }
  function pointer(event) {
    if (!(event.target instanceof HTMLVideoElement)) return;
    // Suppress the built-in pointer handler so every gesture is sent exactly once.
    event.preventDefault(); event.stopImmediatePropagation();
    if (!ready || disposed) return;
    const video = event.target, position = point(video, event);
    if (event.type === 'pointerdown') {
      focus();
      if (gesture || !position || (event.pointerType === 'mouse' && event.button !== 0)) return;
      gesture = { ...position, id: event.pointerId, video, started: performance.now() };
      video.setPointerCapture?.(event.pointerId);
      send(api.ChannelDataType.ClickData, new api.TouchData(0, 0, position.x, position.y, 0));
    } else if (gesture?.id === event.pointerId) {
      if (position && ['pointermove', 'pointerup'].includes(event.type)) Object.assign(gesture, position);
      if (event.type !== 'pointermove') finishTouch();
      else send(api.ChannelDataType.ClickData, new api.TouchData(2, 0, gesture.x, gesture.y, Math.max(0, Math.round(performance.now() - gesture.started))));
    }
  }
  const sdk = new api.WebRtcSdk({ ...options, disabled: true, enabledIMEKeyboard: false }, {
    clientFactory(config) {
      client = new api.WebRtcClient(config);
      const original = client.sendChannelData.bind(client);
      client.sendChannelData = (type, data) => {
        if ([api.ChannelDataType.ClickData, api.ChannelDataType.ActionInput, api.ChannelDataType.ActionChinese].includes(type)) {
          if (!ready || disposed) return false;
          const accepted = original(type, data);
          if (accepted !== false) onAction(type, data);
          return accepted;
        }
        return original(type, data);
      };
      return client;
    },
  });
  const connected = () => { ready = true; };
  const disconnected = () => { blur(); ready = false; };
  sdk.on(api.WebRtcSdk.EVENTS.CONNECTED, connected);
  sdk.on(api.WebRtcSdk.EVENTS.ERROR, disconnected);
  sdk.on(api.WebRtcSdk.EVENTS.STOP_CONNECT, disconnected);
  const init = sdk.init.bind(sdk), destroy = sdk.destroy.bind(sdk);
  sdk.init = () => {
    init(); host.append(input);
    listen(host, 'pointerenter', focus);
    listen(host, 'pointerleave', () => { if (!gesture) blur(); });
    for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) listen(host, event, pointer, true);
    // Match the desktop controls: only the focused cloud screen consumes input.
    listen(input, 'blur', blur);
    listen(window, 'blur', blur);
    listen(document, 'visibilitychange', () => { if (document.hidden) blur(); });
    listen(input, 'compositionstart', () => { if (!focused) return; composing = true; committed = undefined; });
    listen(input, 'compositionend', event => { composing = false; if (!focused) { input.value = ''; return; } committed = event.data; text(event.data); });
    listen(input, 'input', event => {
      if (composing || event.isComposing) return;
      const value = input.value || event.data || '';
      if (committed === value) { committed = undefined; input.value = ''; return; }
      committed = undefined; text(value);
    });
    listen(input, 'paste', event => {
      event.preventDefault(); committed = undefined;
      text(event.clipboardData?.getData('text/plain') || '');
    });
    listen(input, 'keydown', event => {
      if (!focused || composing || event.isComposing || event.keyCode === 229) return;
      committed = undefined;
      if (['Dead', 'Process', 'AltGraph'].includes(event.key)) return;
      if (event.code === 'KeyV' && (event.ctrlKey || event.metaKey)) return;
      if (event.key?.length === 1 && ((!event.ctrlKey && !event.metaKey && !event.altKey) || event.getModifierState('AltGraph'))) return;
      const { keyCode, meta } = api.getKeyEventData(event);
      if (keyCode !== -1) { event.preventDefault(); send(api.ChannelDataType.ActionInput, new api.KeyEventData(keyCode, meta)); }
    });
  };
  sdk.cancelInput = blur;
  sdk.destroy = () => {
    if (disposed) return;
    blur(); ready = false; disposed = true;
    for (const remove of listeners) remove();
    sdk.off(api.WebRtcSdk.EVENTS.CONNECTED, connected);
    sdk.off(api.WebRtcSdk.EVENTS.ERROR, disconnected);
    sdk.off(api.WebRtcSdk.EVENTS.STOP_CONNECT, disconnected);
    input.remove(); destroy();
  };
  return sdk;
}
