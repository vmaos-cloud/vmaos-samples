// Browser-only member controls. Connection tickets remain managed by the sample backend.
export function memberMenu({ primary, participating, active, removable, onSync, onPrimary, onRemove }) {
  const details = document.createElement('details'); details.className = 'member-control';
  const summary = document.createElement('summary'); summary.textContent = '操控';
  summary.setAttribute('role', 'button'); summary.setAttribute('aria-haspopup', 'menu'); summary.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div'); menu.className = 'member-menu'; menu.setAttribute('role', 'menu');
  function action(text, disabled, callback, checked) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.disabled = disabled; button.setAttribute('aria-label', text);
    button.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (checked !== undefined) button.setAttribute('aria-checked', String(checked));
    button.onclick = () => { details.open = false; summary.focus(); callback(); };
    menu.append(button); return button;
  }
  action('参与同步', primary, onSync, primary || participating);
  const promote = action('设为主控', primary || !active, onPrimary); promote.dataset.switchPrimary = '';
  const remove = action('移除', !removable, onRemove); remove.className = 'member-remove';
  if (!removable) remove.title = '至少保留一台云机';
  details.append(summary, menu);
  details.ontoggle = () => {
    summary.setAttribute('aria-expanded', String(details.open));
    if (details.open) document.querySelectorAll('details.member-control[open]').forEach(other => { if (other !== details) other.open = false; });
  };
  details.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); details.open = false; summary.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); details.open = true;
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current <= 0 ? buttons.length - 1 : current - 1);
    buttons[next].focus();
  };
  return details;
}

document.addEventListener('click', event => {
  document.querySelectorAll('details.member-control[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
});
