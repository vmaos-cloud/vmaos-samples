// Public SDK events only. Keep this file in the demo when copying it independently.
export function mountCameraControls(Sdk, sdk, host) {
  host.innerHTML = `<div class="camera-panel" hidden><span class="camera-message" role="status"></span><div class="camera-actions"><button type="button" data-camera="retry" hidden>重试摄像头</button><button type="button" data-camera="front" hidden>前置</button><button type="button" data-camera="back" hidden>后置</button><button type="button" data-camera="stop" hidden>关闭摄像头</button></div></div>`;
  const panel = host.querySelector('.camera-panel'), message = host.querySelector('.camera-message');
  const buttons = Object.fromEntries([...host.querySelectorAll('[data-camera]')].map(button => [button.dataset.camera, button]));
  let state = 'idle', active = false, error = '', disposed = false;
  function render() {
    panel.hidden = state === 'idle';
    panel.dataset.state = state;
    message.setAttribute('role', state === 'error' ? 'alert' : 'status');
    message.textContent = state === 'error' ? error || '摄像头连接失败，请检查设备和权限' : state === 'requesting' ? '等待摄像头授权' : '摄像头传输中';
    buttons.retry.hidden = state !== 'error';
    buttons.stop.hidden = !active && state !== 'requesting';
    buttons.front.hidden = buttons.back.hidden = !active;
  }
  function onState(next) { if (disposed) return; state = next.state; active = next.active; if (state !== 'error') error = ''; render(); }
  function onError(next) { if (disposed) return; state = 'error'; error = next.message; render(); }
  // Camera errors update this panel only; they do not disconnect the cloud desktop.
  async function run(action) {
    try { await action(); }
    catch { if (!disposed && state !== 'error') onError({ message: '摄像头操作失败，请检查设备和权限后重试' }); }
  }
  buttons.retry.onclick = () => run(() => sdk.startCamera());
  buttons.front.onclick = () => run(() => sdk.switchCamera({ useBackCamera: false }));
  buttons.back.onclick = () => run(() => sdk.switchCamera({ useBackCamera: true }));
  buttons.stop.onclick = () => sdk.stopCamera();
  sdk.on(Sdk.EVENTS.CAMERA_STATE_CHANGED, onState);
  sdk.on(Sdk.EVENTS.CAMERA_ERROR, onError);
  render();
  return () => {
    disposed = true;
    sdk.off(Sdk.EVENTS.CAMERA_STATE_CHANGED, onState);
    sdk.off(Sdk.EVENTS.CAMERA_ERROR, onError);
    host.replaceChildren();
  };
}
