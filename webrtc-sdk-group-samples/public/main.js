import { memberMenu } from './members.js';
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
let primaryConnected = false, followerReadyCount = 0, followerExpectedCount = 0;
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
  followerReadyCount = 0; followerExpectedCount = 0;
  ++followerGeneration; followerAbort?.abort(); finishFollowersTouch();
  for (const client of followers) { client.stop(); client.removeAllListeners(); }
  followers = []; $('follower-status').textContent = '从控控制未连接';
}
function stopConnections() {
  primaryConnected = false;
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
  } else if ([ChannelDataType.ActionInput, ChannelDataType.ActionChinese, ChannelDataType.ActionWheel].includes(type)) {
    followers.forEach(client => client.sendData(type, data));
  }
}
function renderTiles() {
  previews.forEach(item => item.preview.destroy()); previews = []; $('followers').replaceChildren();
  $('add-member').disabled = !selected.length || selected.length >= 100;
  $('primary-name').textContent = primaryCode || '';
  for (const phone of selected) {
    const tile = document.createElement('article'); tile.className = 'tile';
    const header = document.createElement('header'), code = document.createElement('strong'); code.textContent = phone.phoneCode;
    const primary = phone.phoneCode === primaryCode, role = document.createElement('span');
    role.className = `member-role${primary ? ' is-primary' : ''}`; role.textContent = primary ? '主控' : '从控';
    header.append(role, code, memberMenu({ primary, participating: participants.has(phone.phoneCode), active, removable: selected.length > 1,
      onSync: () => void setParticipating(phone.phoneCode, !participants.has(phone.phoneCode)).catch(fail),
      onPrimary: () => void switchPrimary(phone.phoneCode).catch(fail),
      onRemove: () => void removeMember(phone.phoneCode).catch(fail),
    }));
    const box = document.createElement('div'); box.className = 'picture';
    box.textContent = primary ? (active ? '操控中' : '已断开') : '等待截图';
    tile.append(header, box); $('followers').append(tile);
    if (phone.phoneCode !== primaryCode && active) previews.push({ code: phone.phoneCode, preview: new Preview(box, $('followers'), requestPreviewRenewal) });
  }
}
async function removeMember(code) {
  if (!selected.some(phone => phone.phoneCode === code)) throw new Error('目标云机不在当前群控中');
  if (selected.length <= 1) throw new Error('至少保留一台云机');
  sdk?.cancelInput();
  const wasPrimary = code === primaryCode;
  if (wasPrimary) stopConnections();
  selected = selected.filter(phone => phone.phoneCode !== code); participants.delete(code);
  if (wasPrimary) primaryCode = selected[0].phoneCode;
  renderTiles();
  if (active) await Promise.all([...(wasPrimary ? [rebuildMain()] : []), rebuildFollowers(), grantPreviews()]);
}
let addRows = [], addCursor = null, addMore = false, addChosen = new Set(), addAbort, addGeneration = 0;
function closeMemberPicker() {
  ++addGeneration; addAbort?.abort(); $('add-members').close(); addChosen.clear();
}
function renderMemberChoices() {
  $('member-choices').replaceChildren();
  const existing = new Set(selected.map(phone => phone.phoneCode));
  for (const phone of addRows) {
    const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox';
    const joined = existing.has(phone.phoneCode), checked = addChosen.has(phone.phoneCode);
    input.checked = joined || checked;
    const reason = joined ? '已在群控中' : !phone.phoneCode || phone.online !== true || phone.status !== 2 ? '云机未在线运行'
      : !checked && selected.length + addChosen.size >= 100 ? '群控最多支持 100 台云机' : '';
    input.disabled = !!reason;
    input.onchange = () => {
      if (input.checked) addChosen.add(phone.phoneCode); else addChosen.delete(phone.phoneCode);
      renderMemberChoices();
    };
    label.append(input, phone.phoneCode || '未知云机', reason ? `（${reason}）` : ''); $('member-choices').append(label);
  }
  $('member-count').textContent = `已选择 ${addChosen.size} 台，最多再添加 ${100 - selected.length} 台`;
  $('member-confirm').disabled = !addChosen.size || selected.length + addChosen.size > 100;
  $('member-more').disabled = !addMore; applyMemberFilter();
}
async function loadMemberChoices(reset) {
  const mine = ++addGeneration; addAbort?.abort(); const controller = addAbort = new AbortController();
  if (reset) { addRows = []; addCursor = null; addMore = false; }
  $('member-more').disabled = true; $('member-refresh').disabled = true; $('member-status').textContent = '正在加载云机';
  try {
    const result = await api('/api/phones', { scroller: { cursor: addCursor, size: 100 } }, controller.signal);
    if (mine !== addGeneration || controller.signal.aborted) return;
    const seen = new Set(addRows.map(phone => phone.phoneCode));
    addRows.push(...result.items.filter(phone => !seen.has(phone.phoneCode)));
    addCursor = result.nextCursor; addMore = result.hasMore; renderMemberChoices(); $('member-status').textContent = addRows.length ? '' : '暂无可选云机';
  } catch (error) { if (!controller.signal.aborted) $('member-status').textContent = error.message || '加载失败，请重新查询'; }
  finally { if (mine === addGeneration) { $('member-refresh').disabled = false; $('member-more').disabled = !addMore; } }
}
$('add-member').onclick = () => {
  addChosen.clear(); $('member-filter').value = ''; $('member-choices').replaceChildren();
  $('member-confirm').disabled = true; $('member-count').textContent = `最多再添加 ${100 - selected.length} 台`;
  $('add-members').showModal(); void loadMemberChoices(true);
};
$('member-refresh').onclick = () => { addChosen.clear(); void loadMemberChoices(true); };
$('member-more').onclick = () => void loadMemberChoices(false);
function applyMemberFilter() {
  const keyword = $('member-filter').value.trim().toLowerCase();
  for (const label of $('member-choices').children) label.hidden = !label.textContent.toLowerCase().includes(keyword);
}
$('member-filter').oninput = applyMemberFilter;
$('member-cancel').onclick = closeMemberPicker;
$('add-members').addEventListener('cancel', event => { event.preventDefault(); closeMemberPicker(); });
$('member-confirm').onclick = () => {
  const codes = [...addChosen];
  closeMemberPicker(); void addMembers(codes).catch(fail);
};
function usableTicket(ticket) {
  if (!ticket || typeof ticket.roomId !== 'string' || !ticket.roomId || typeof ticket.token !== 'string' || !ticket.token
      || !Array.isArray(ticket.turnServerUris) || !Number.isFinite(Date.parse(ticket.expiresAt)) || Date.parse(ticket.expiresAt) <= Date.now()) throw new Error('凭证无效或已过期，请重新获取');
  if (!['ws:', 'wss:'].includes(new URL(ticket.signalServerUrl).protocol)) throw new Error('信令地址无效');
  return ticket;
}
async function rebuildMain() {
  if (!active) return;
  primaryConnected = false;
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
    current.on('control-state', ({connected}) => {
      if (sdk !== current) return;
      primaryConnected = connected;
      if (!connected) finishFollowersTouch();
      $('primary-status').textContent = connected ? '已连接' : '连接中';
      document.querySelectorAll('[data-primary-action]').forEach(button => { button.disabled = !connected; });
    });
    current.on(WebRtcSdk.EVENTS.CONNECTED, () => {
      if (sdk !== current) return;
      primaryConnected = true; current.disableAudio(); $('primary-status').textContent = '已连接'; document.querySelectorAll('[data-primary-action]').forEach(button => { button.disabled = false; });
    });
    const failed = () => {
      if (sdk !== current) return;
      primaryConnected = false; current.cancelInput(); finishFollowersTouch(); cameraCleanup?.(); cameraCleanup = undefined; sdk = undefined; current.destroy();
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
  followerExpectedCount = codes.length;
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
  const update = () => { if (mine === followerGeneration) { followerReadyCount = [...ready.values()].reduce((a, b) => a + b, 0); $('follower-status').textContent = `从控控制就绪 ${followerReadyCount} / ${codes.length} 台${failed ? '，部分失败，请重试从控' : ''}`; } };
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
    if (reset) { closeMemberPicker(); stop(); selected = []; primaryCode = undefined; participants.clear(); $('add-member').disabled = true; rows = []; addRows = []; cursor = null; $('list').hidden = false; $('workspace').hidden = true; }
    const result = await api('/api/phones', { scroller: { cursor, size: 100 } }, controller.signal);
    if (mine !== queryGeneration) return;
    const seen = new Set(rows.map(phone => phone.phoneCode)); rows.push(...result.items.filter(phone => !seen.has(phone.phoneCode)));
    cursor = result.nextCursor; hasMore = result.hasMore; renderRows(); message(`已加载 ${rows.length} 台云机`);
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { if (mine === queryGeneration) $('reload').disabled = false; }
}
$('login').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true;
  try { await groupControls.connectAndQuery(Object.fromEntries(new FormData(form))); } catch (error) { fail(error); } finally { button.disabled = false; }
};
$('reload').onclick = () => void query(true).catch(fail); $('more').onclick = () => void query(false).catch(fail);
function connectWorkspace() {
  active = true; $('stop').textContent = '断开群控'; renderTiles();
  return Promise.all([rebuildMain(), rebuildFollowers(), grantPreviews()]);
}
$('start').onclick = () => {
  const chosen = [...$('phones').querySelectorAll('input:checked')].map(input => input.dataset.code);
  void startGroup(chosen).catch(fail);
};
$('sync').onchange = () => void setSynchronous($('sync').checked).catch(fail);
$('stop').onclick = () => { if (active) groupControls.disconnect(); else void groupControls.reconnect().catch(fail); };
$('retry-main').onclick = () => void rebuildMain().catch(fail);
$('retry-followers').onclick = () => void rebuildFollowers().catch(fail);
$('retry-previews').onclick = () => void grantPreviews().catch(fail);
$('logout').onclick = () => void logout().catch(fail);
$('home').onclick = () => sdk?.goHome(); $('back').onclick = () => sdk?.goBack(); $('task').onclick = () => sdk?.goTask();
const resume = () => { if (!document.hidden) requestPreviewRenewal(false); };
document.addEventListener('visibilitychange', resume); window.addEventListener('focus', resume);
window.addEventListener('pagehide', () => { closeMemberPicker(); ++queryGeneration; queryAbort?.abort(); stop(); });


// Tutorial integration API, not methods on the published WebRtcSdk class.
function requireActive() {
  if (!active || !selected.length) throw new Error('群控已断开，请先建立群控或重新连接');
}
function requirePrimary() {
  requireActive();
  if (!sdk || !primaryConnected) throw new Error('主控尚未连接，请等待就绪');
  return sdk;
}
function normalizeCodes(codes) {
  if (!Array.isArray(codes) || codes.some(code => typeof code !== 'string' || !code.trim())) throw new TypeError('请提供非空云机编号字符串数组');
  return [...new Set(codes)];
}
function loadedPhones(codes) {
  const known = new Map([...rows, ...addRows].map(phone => [phone.phoneCode, phone]));
  return codes.map(code => {
    const phone = known.get(code);
    if (!phone) throw new Error(`云机 ${code} 尚未加载，请先查询或加载更多`);
    if (phone.online !== true || phone.status !== 2) throw new Error(`云机 ${code} 未在线运行`);
    return phone;
  });
}
async function startGroup(phoneCodes) {
  const codes = normalizeCodes(phoneCodes);
  if (codes.length < 2 || codes.length > 100) throw new RangeError('首次群控请选择 2 至 100 台云机');
  const phones = loadedPhones(codes);
  stop(); selected = phones; primaryCode = phones[0].phoneCode;
  participants.clear(); phones.forEach(phone => participants.add(phone.phoneCode));
  $('list').hidden = true; $('workspace').hidden = false;
  return connectWorkspace();
}
async function switchPrimary(phoneCode) {
  requireActive();
  if (!selected.some(phone => phone.phoneCode === phoneCode)) throw new Error('目标云机不在当前群控中，请先新增成员');
  if (phoneCode === primaryCode) return; // Repeating the selection must not reconnect an already selected primary.
  stopConnections(); primaryCode = phoneCode; renderTiles();
  await Promise.all([rebuildMain(), rebuildFollowers(), grantPreviews()]);
}
async function setSynchronous(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('同步开关必须为布尔值');
  $('sync').checked = enabled; sdk?.cancelInput(); await rebuildFollowers();
}
async function setParticipating(phoneCode, enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('参与同步开关必须为布尔值');
  if (!selected.some(phone => phone.phoneCode === phoneCode)) throw new Error('目标云机不在当前群控中');
  if (phoneCode === primaryCode) {
    if (!enabled) throw new Error('主控始终接收操作；如需只操作主控，请关闭顶部同步操作');
    return;
  }
  if (participants.has(phoneCode) === enabled) return;
  sdk?.cancelInput();
  if (enabled) participants.add(phoneCode); else participants.delete(phoneCode);
  renderTiles(); await Promise.all([rebuildFollowers(), grantPreviews()]);
}
async function addMembers(phoneCodes) {
  if (!selected.length) throw new Error('请先建立一组群控');
  const existing = new Set(selected.map(phone => phone.phoneCode));
  const codes = normalizeCodes(phoneCodes).filter(code => !existing.has(code));
  if (!codes.length) return;
  if (selected.length + codes.length > 100) throw new RangeError('群控最多支持 100 台云机');
  const phones = loadedPhones(codes);
  sdk?.cancelInput(); selected.push(...phones); phones.forEach(phone => participants.add(phone.phoneCode)); renderTiles();
  if (active) await Promise.all([rebuildFollowers(), grantPreviews()]);
}
async function logout() {
  closeMemberPicker(); $('add-member').disabled = true; ++queryGeneration; queryAbort?.abort();
  stop(); selected = []; rows = []; addRows = []; primaryCode = undefined; hasMore = false; participants.clear(); renderRows(); $('login').reset();
  $('workspace').hidden = true; $('list').hidden = false;
  await api('/api/logout'); message('凭据已清除');
}
function getState() {
  return {
    active, primaryCode, primaryConnected, synchronous: $('sync').checked,
    followerReadyCount, followerExpectedCount, ready: active && primaryConnected && followerReadyCount === followerExpectedCount,
    members: selected.map(phone => ({ phoneCode: phone.phoneCode, primary: phone.phoneCode === primaryCode, participating: phone.phoneCode === primaryCode || participants.has(phone.phoneCode) })),
    availablePhones: rows.map(({ phoneCode, online, status }) => ({ phoneCode, online, status })), hasMore,
  };
}
async function waitUntilReady({ timeoutMs = 15000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('等待超时必须为正数毫秒');
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    requireActive();
    if (getState().ready) return getState();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('连接尚未全部就绪，请检查主控状态、同步范围及从控连接');
}
export const groupControls = Object.freeze({
  async connectAndQuery({ accessKey, secretKey }) { await api('/api/session', { accessKey, secretKey }); await query(true); return getState(); },
  async reloadPhones() { await query(true); return getState(); },
  async loadMorePhones() { if (hasMore) await query(false); return getState(); },
  start: startGroup, switchPrimary, setSynchronous, setParticipating, addMembers,
  removeMember,
  disconnect() { stop(); renderTiles(); message('已断开'); },
  async reconnect() { if (active) return; if (!selected.length) throw new Error('请先选择云机建立群控'); return connectWorkspace(); },
  retryPrimary() { requireActive(); return rebuildMain(); },
  retryFollowers() { requireActive(); return rebuildFollowers(); },
  refreshPreviews() { requireActive(); return grantPreviews(); },
  home() { requirePrimary().goHome(); }, back() { requirePrimary().goBack(); }, recentTasks() { requirePrimary().goTask(); },
  click(...args) { return requirePrimary().click(...args); }, swipe(...args) { return requirePrimary().swipe(...args); }, drag(...args) { return requirePrimary().drag(...args); },
  scroll(deltaY) { return requirePrimary().scroll(deltaY); },
  sendText(text) { return requirePrimary().sendTextInput(text); }, sendKey(keyCode, meta = 0) { return requirePrimary().sendKey(keyCode, meta); },
  startCamera(options) { return requirePrimary().startCamera(options); }, switchCamera(options) { return requirePrimary().switchCamera(options); }, stopCamera() { requirePrimary().stopCamera(); },
  getState, waitUntilReady, logout,
});
