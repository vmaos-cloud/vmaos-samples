import { createControlledSdk } from './control.js';
import { mountCameraControls } from './camera.js';
import { Preview } from './preview.js';
const SDK = globalThis.WebRTCSDK;
const { WebRtcSdk, ControlGroupClient, ChannelDataType, TouchData } = SDK;
const $ = id => document.getElementById(id);
const message = text => { $('message').textContent = text; };
let rows = [], cursor = null, hasMore = false, selected = [], primaryCode;
let sdk, cameraCleanup, active = false, followers = [], previews = [], gesture;
let mainGeneration = 0, followerGeneration = 0, queryGeneration = 0, previewGeneration = 0;
let connectionAbort, followerAbort, queryAbort, previewAbort, grantTimer, grantDue = 0, lastGrantStarted = 0;
const participants = new Set();
async function api(path, body = {}, signal) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function fail(error) { if (error.name !== 'AbortError') message(error.message || '连接失败，请重试'); }
function finishFollowersTouch() {
  if (!gesture) return;
  const previous = gesture; gesture = undefined;
  const up = new TouchData(1, 0, previous.data.x, previous.data.y, Math.max(0, Math.round(performance.now() - previous.started)));
  previous.clients.forEach(client => client.sendData(ChannelDataType.ClickData, up));
}
function stopFollowers() {
  ++followerGeneration; followerAbort?.abort(); finishFollowersTouch();
  for (const client of followers) { client.stop(); client.removeAllListeners(); }
  followers = []; $('follower-status').textContent = '从控控制未连接';
}
function stopConnections() {
  ++mainGeneration; connectionAbort?.abort();
  sdk?.cancelInput(); stopFollowers(); cameraCleanup?.(); cameraCleanup = undefined;
  sdk?.destroy(); sdk = undefined; $('primary-status').textContent = '已断开';
}
function stop() {
  active = false; stopConnections(); ++previewGeneration; previewAbort?.abort(); clearTimeout(grantTimer);
  previews.forEach(item => item.preview.destroy()); previews = [];
  $('stop').textContent = selected.length ? '重新连接' : '断开群控';
  document.querySelectorAll('[data-primary-action], [data-switch-primary]').forEach(button => { button.disabled = true; });
}
function sendFollowers(type, data) {
  if (type === ChannelDataType.ClickData) {
    if (data.action === 0) {
      finishFollowersTouch();
      gesture = { data, started: performance.now(), clients: followers.filter(client => client.sendData(type, data)) };
    } else if (gesture) {
      gesture.clients.forEach(client => client.sendData(type, data)); gesture.data = data;
      if (data.action === 1) gesture = undefined;
    }
  } else if ([ChannelDataType.ActionInput, ChannelDataType.ActionChinese].includes(type)) {
    followers.forEach(client => client.sendData(type, data));
  }
}
function renderTiles() {
  previews.forEach(item => item.preview.destroy()); previews = []; $('followers').replaceChildren();
  for (const phone of selected) {
    const tile = document.createElement('article'); tile.className = 'tile';
    const header = document.createElement('header'), code = document.createElement('strong'); code.textContent = phone.phoneCode; header.append(code);
    const box = document.createElement('div'); box.className = 'picture';
    const label = document.createElement('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox';
    checkbox.checked = phone.phoneCode === primaryCode || participants.has(phone.phoneCode); checkbox.disabled = phone.phoneCode === primaryCode;
    checkbox.onchange = () => {
      if (checkbox.checked) participants.add(phone.phoneCode); else participants.delete(phone.phoneCode);
      sdk?.cancelInput(); void rebuildFollowers().catch(fail);
    };
    label.append(checkbox, '参与同步'); header.append(label);
    if (phone.phoneCode === primaryCode) box.textContent = active ? '操控中' : '已断开';
    else {
      const button = document.createElement('button'); button.textContent = '设为主控'; button.dataset.switchPrimary = ''; button.disabled = !active;
      button.onclick = () => {
        if (!active) return;
        stopConnections(); primaryCode = phone.phoneCode; renderTiles();
        void rebuildMain().catch(fail); void rebuildFollowers().catch(fail); void grantPreviews().catch(fail);
      };
      header.append(button); box.textContent = '等待截图';
    }
    tile.append(header, box); $('followers').append(tile);
    if (phone.phoneCode !== primaryCode && active) previews.push({ code: phone.phoneCode, preview: new Preview(box, $('followers'), requestPreviewRenewal) });
  }
}
function usableTicket(ticket) {
  if (!ticket || typeof ticket.roomId !== 'string' || !ticket.roomId || typeof ticket.token !== 'string' || !ticket.token
      || !Array.isArray(ticket.turnServerUris) || !Number.isFinite(Date.parse(ticket.expiresAt)) || Date.parse(ticket.expiresAt) <= Date.now()) throw new Error('凭证无效或已过期，请重新获取');
  if (!['ws:', 'wss:'].includes(new URL(ticket.signalServerUrl).protocol)) throw new Error('信令地址无效');
  return ticket;
}
async function rebuildMain() {
  if (!active) return;
  const mine = ++mainGeneration; connectionAbort?.abort(); const controller = connectionAbort = new AbortController();
  cameraCleanup?.(); cameraCleanup = undefined; sdk?.destroy(); sdk = undefined;
  $('primary-status').textContent = '连接中'; document.querySelectorAll('[data-primary-action]').forEach(button => { button.disabled = true; });
  try {
    const ticket = usableTicket(await api('/api/ticket', { phoneCode: primaryCode }, controller.signal));
    if (!active || mine !== mainGeneration) return;
    $('primary-name').textContent = primaryCode;
    const current = createControlledSdk(SDK, { mountedElement: $('primary'), enabledDebug: false,
      connectConfig: { signalServerUrl: ticket.signalServerUrl, roomId: ticket.roomId, token: ticket.token,
        hostTurn: ticket.turnServerUris, spareTurn: [], isGroup: false, signAgain: false } }, sendFollowers);
    sdk = current; cameraCleanup = mountCameraControls(WebRtcSdk, current, $('camera-controls'));
    current.on(WebRtcSdk.EVENTS.CONNECTED, () => {
      if (sdk !== current) return;
      $('primary-status').textContent = '已连接'; document.querySelectorAll('[data-primary-action]').forEach(button => { button.disabled = false; });
    });
    const failed = () => {
      if (sdk !== current) return;
      current.cancelInput(); finishFollowersTouch(); cameraCleanup?.(); cameraCleanup = undefined; sdk = undefined; current.destroy();
      $('primary-status').textContent = '连接失败，请重试主控'; document.querySelectorAll('[data-primary-action]').forEach(button => { button.disabled = true; });
    };
    current.on(WebRtcSdk.EVENTS.ERROR, failed); current.on(WebRtcSdk.EVENTS.STOP_CONNECT, failed);
    current.init(); const video = $('primary').querySelector('video'); if (video) video.muted = true;
  } catch (error) { if (!controller.signal.aborted && mine === mainGeneration) { $('primary-status').textContent = '连接失败，请重试主控'; throw error; } }
}
async function rebuildFollowers() {
  sdk?.cancelInput(); stopFollowers();
  if (!active || !$('sync').checked) return;
  const codes = selected.filter(phone => phone.phoneCode !== primaryCode && participants.has(phone.phoneCode)).map(phone => phone.phoneCode);
  if (!codes.length) return;
  const mine = followerGeneration, controller = followerAbort = new AbortController();
  $('follower-status').textContent = `从控控制就绪 0 / ${codes.length} 台`;
  const results = await Promise.allSettled(codes.map(async phoneCode => ({ phoneCode, ticket: usableTicket(await api('/api/ticket', { phoneCode }, controller.signal)) })));
  if (!active || controller.signal.aborted || mine !== followerGeneration) return;
  const groups = new Map(); let failed = results.some(result => result.status === 'rejected');
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { ticket } = result.value;
    if (Date.parse(ticket.expiresAt) <= Date.now()) { failed = true; continue; }
    const group = groups.get(ticket.signalServerUrl) || [];
    group.push(ticket); groups.set(ticket.signalServerUrl, group);
  }
  const ready = new Map();
  const update = () => { if (mine === followerGeneration) $('follower-status').textContent = `从控控制就绪 ${[...ready.values()].reduce((a, b) => a + b, 0)} / ${codes.length} 台${failed ? '，部分失败，请重试从控' : ''}`; };
  for (const [signalServerUrl, tickets] of groups) {
    try {
      const client = new ControlGroupClient({ signalServerUrl, roomTokens: Object.fromEntries(tickets.map(ticket => [ticket.roomId, ticket.token])) });
      client.on('ready', () => { ready.set(client, tickets.length); update(); });
      client.on('failure', () => { ready.delete(client); failed = true; update(); });
      followers.push(client); client.start();
    } catch { failed = true; }
  }
  update();
}
async function grantPreviews() {
  if (!active || !selected.length) return;
  const mine = ++previewGeneration; clearTimeout(grantTimer); previewAbort?.abort(); const controller = previewAbort = new AbortController(); const started = lastGrantStarted = Date.now();
  try {
    const result = await api('/api/previews', { phoneCodes: selected.map(phone => phone.phoneCode), durationMs: 1200000 }, controller.signal);
    if (!active || controller.signal.aborted || mine !== previewGeneration) return;
    const urls = new Map(result.previews.map(item => [item.phoneCode, item.previewUrl]));
    for (const item of previews) item.preview.setUrl(urls.get(item.code));
    grantDue = started + 1170001;
    grantTimer = setTimeout(() => void grantPreviews().catch(fail), Math.max(0, grantDue - Date.now()));
  } catch (error) {
    if (controller.signal.aborted || mine !== previewGeneration) return;
    grantDue = Date.now() + 5000; grantTimer = setTimeout(() => void grantPreviews().catch(fail), 5000); throw error;
  }
}
function requestPreviewRenewal(force = true) {
  if (!active || (!force && Date.now() < grantDue)) return;
  clearTimeout(grantTimer);
  grantTimer = setTimeout(() => void grantPreviews().catch(fail), Math.max(0, 5000 - (Date.now() - lastGrantStarted)));
}
function renderRows() {
  $('phones').replaceChildren();
  for (const row of rows) {
    const tr = document.createElement('tr'), td = document.createElement('td'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.code = row.phoneCode;
    checkbox.disabled = !row.phoneCode || row.online !== true || row.status !== 2;
    checkbox.onchange = () => { const count = $('phones').querySelectorAll('input:checked').length; if (count > 100) { checkbox.checked = false; message('最多选择 100 台'); } $('start').disabled = $('phones').querySelectorAll('input:checked').length < 2; };
    td.append(checkbox); tr.append(td);
    for (const value of [row.phoneCode, ['未知', '启动中', '运行中', '已关机', '异常'][row.status ?? 0], row.online ? '在线' : '离线']) { const cell = document.createElement('td'); cell.textContent = value || '—'; tr.append(cell); }
    $('phones').append(tr);
  }
  $('more').disabled = !hasMore; $('start').disabled = true;
}
async function query(reset) {
  const mine = ++queryGeneration; queryAbort?.abort(); const controller = queryAbort = new AbortController();
  $('reload').disabled = true; $('more').disabled = true;
  try {
    if (reset) { stop(); selected = []; rows = []; cursor = null; $('list').hidden = false; $('workspace').hidden = true; }
    const result = await api('/api/phones', { scroller: { cursor, size: 100 } }, controller.signal);
    if (mine !== queryGeneration) return;
    const seen = new Set(rows.map(phone => phone.phoneCode)); rows.push(...result.items.filter(phone => !seen.has(phone.phoneCode)));
    cursor = result.nextCursor; hasMore = result.hasMore; renderRows(); message(`已加载 ${rows.length} 台云机`);
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { if (mine === queryGeneration) $('reload').disabled = false; }
}
$('login').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true;
  try { await api('/api/session', Object.fromEntries(new FormData(form))); await query(true); } catch (error) { fail(error); } finally { button.disabled = false; }
};
$('reload').onclick = () => void query(true).catch(fail); $('more').onclick = () => void query(false).catch(fail);
function connectWorkspace() {
  active = true; $('stop').textContent = '断开群控'; renderTiles();
  void rebuildMain().catch(fail); void rebuildFollowers().catch(fail); void grantPreviews().catch(fail);
}
$('start').onclick = () => {
  stop(); const chosen = new Set([...$('phones').querySelectorAll('input:checked')].map(input => input.dataset.code)); selected = rows.filter(phone => chosen.has(phone.phoneCode));
  if (selected.length < 2) return;
  primaryCode = selected[0].phoneCode; participants.clear(); selected.forEach(phone => participants.add(phone.phoneCode));
  $('list').hidden = true; $('workspace').hidden = false; connectWorkspace();
};
$('sync').onchange = () => { sdk?.cancelInput(); void rebuildFollowers().catch(fail); };
$('stop').onclick = () => { if (active) { stop(); renderTiles(); message('已断开'); } else if (selected.length >= 2) connectWorkspace(); };
$('retry-main').onclick = () => void rebuildMain().catch(fail);
$('retry-followers').onclick = () => void rebuildFollowers().catch(fail);
$('retry-previews').onclick = () => void grantPreviews().catch(fail);
$('logout').onclick = () => {
  ++queryGeneration; queryAbort?.abort(); stop(); selected = []; rows = []; hasMore = false; renderRows(); $('login').reset();
  $('workspace').hidden = true; $('list').hidden = false; void api('/api/logout').catch(fail); message('凭据已清除');
};
$('home').onclick = () => sdk?.goHome(); $('back').onclick = () => sdk?.goBack(); $('task').onclick = () => sdk?.goTask();
const resume = () => { if (!document.hidden) requestPreviewRenewal(false); };
document.addEventListener('visibilitychange', resume); window.addEventListener('focus', resume);
window.addEventListener('pagehide', () => { ++queryGeneration; queryAbort?.abort(); stop(); });
