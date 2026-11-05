import { mountRelativeVolume } from "./volume.js";
// Public SDK controls for a single cloud screen. Keep beside the copied demo.
export function mountRemoteNavigation(host) {
  host.innerHTML = `<nav class="remote-navigation" aria-label="云机导航">
    <button type="button" aria-label="最近任务" title="最近任务" data-action="goTask" disabled>▦</button>
    <button type="button" aria-label="Home" title="Home" data-action="goHome" disabled>⌂</button>
    <button type="button" aria-label="返回" title="返回" data-action="goBack" disabled>‹</button>
    <button type="button" aria-label="更多功能" title="更多功能" aria-haspopup="menu" aria-expanded="false" disabled>⋯</button>
    <div class="remote-more-menu" hidden><div data-volume></div>
      <div role="menu" aria-label="更多功能"><button type="button" role="menuitem" data-audio disabled>静音</button></div>
    </div></nav>`;
  const more = host.querySelector('[aria-haspopup="menu"]');
  const menu = host.querySelector('.remote-more-menu');
  const audio = host.querySelector('[data-audio]');
  let sdk, connected = false, audioEnabled = true, unbind = () => {};
  const volume = mountRelativeVolume(host.querySelector('[data-volume]'), {up:()=>sdk?.volumeUp()===true,down:()=>sdk?.volumeDown()===true});
  function close() { menu.hidden = true; more.setAttribute('aria-expanded','false'); volume.setEnabled(false); }
  function state(value) {
    connected = value;
    host.querySelectorAll('button').forEach(button => { button.disabled = !value; });
    const video = host.parentElement?.querySelector('video');
    if (video) video.muted = !audioEnabled;
    volume.setEnabled(value && !menu.hidden);
    if (!value) close();
  }
  function click(event) {
    const button = event.target.closest('button');
    if (!button || !host.contains(button) || !connected || !sdk) return;
    if (button === more) {
      menu.hidden = !menu.hidden; more.setAttribute('aria-expanded',String(!menu.hidden));
      volume.setEnabled(!menu.hidden && connected);
      if (!menu.hidden) menu.querySelector('input').focus();
      return;
    }
    if (button === audio) {
      // The tutorial input adapter reports failed sends without changing UI state.
      const sent = audioEnabled ? sdk.disableAudio() : sdk.enableAudio();
      if (sent !== false) { audioEnabled = !audioEnabled; audio.textContent = audioEnabled ? '静音' : '恢复声音'; const video = host.parentElement?.querySelector('video'); if (video) video.muted = !audioEnabled; }
    } else if (button.dataset.action) sdk[button.dataset.action]();
    close();
  }
  const outside = event => { if (!host.contains(event.target)) close(); };
  function keyboard(event) {
    if (menu.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); more.focus(); }
    else if (event.target.tagName !== 'INPUT' && ['ArrowDown','ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const items = [...menu.querySelectorAll('button')], current = items.indexOf(document.activeElement);
      items[(current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  }
  host.addEventListener('click',click);
  document.addEventListener('pointerdown',outside);
  document.addEventListener('keydown',keyboard);
  window.addEventListener('blur',close);
  function disconnect() {
    unbind(); unbind = () => {}; sdk = undefined;
    audioEnabled = true; audio.textContent = '静音'; state(false);
  }
  return {
    bind(Sdk,current) {
      disconnect(); sdk = current;
      const ready = () => state(true), offline = () => state(false);
      const changed = value => state(value.connected === true);
      const listeners = [[Sdk.EVENTS.CONNECTED,ready],[Sdk.EVENTS.ERROR,offline],[Sdk.EVENTS.STOP_CONNECT,offline],['control-state',changed]];
      listeners.forEach(([event,listener]) => current.on(event,listener));
      unbind = () => listeners.forEach(([event,listener]) => current.off(event,listener));
    },
    disconnect,
    destroy() {
      disconnect(); volume.destroy(); host.removeEventListener('click',click);
      document.removeEventListener('pointerdown',outside); document.removeEventListener('keydown',keyboard);
      window.removeEventListener('blur',close); host.replaceChildren();
    },
  };
}
