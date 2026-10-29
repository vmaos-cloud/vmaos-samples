const { WebRtcSdk, WebRtcClient, ControlGroupClient, ChannelDataType, TouchData } = globalThis.WebRTCSDK;
import { Preview } from './preview.js';

const $ = id => document.getElementById(id), message = text => { $('message').textContent = text; };
let rows = [], cursor = null, hasMore = false, selected = [], primaryCode, sdk, primarySend;
let active = false;
let followers = [], previews = [], grantTimer, grantDue = 0, granting = false, generation = 0, connectionAbort, previewAbort, lastTouch;
const participants = new Set();
async function api(path, body = {}, signal) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, cache: 'no-store' });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
function stopConnections() {
  ++generation; connectionAbort?.abort();
  if (lastTouch) {
    const up = new TouchData(1, 0, lastTouch.data.x, lastTouch.data.y, Math.max(0, performance.now() - lastTouch.started));
    primarySend?.(ChannelDataType.ClickData, up); lastTouch.clients.forEach(client => client.sendData(ChannelDataType.ClickData, up)); lastTouch = null;
  }
  sdk?.destroy(); sdk = undefined; primarySend = undefined;
  for (const client of followers) { client.stop(); client.removeAllListeners(); } followers = [];
}
function stop() {
  active = false; granting = false;
  stopConnections(); previewAbort?.abort(); clearTimeout(grantTimer); previews.forEach(item => item.preview.destroy()); previews = [];
}
function renderTiles() {
  previews.forEach(item => item.preview.destroy()); previews = []; $('followers').replaceChildren();
  for (const phone of selected) {
    const tile = document.createElement('article'); tile.className = 'tile';
    const header = document.createElement('header'), code = document.createElement('strong'); code.textContent = phone.phoneCode; header.append(code);
    const box = document.createElement('div'); box.className = 'picture';
    if (phone.phoneCode === primaryCode) { box.textContent = '操控中'; }
    else {
      const label = document.createElement('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = participants.has(phone.phoneCode);
      checkbox.onchange = () => { if (checkbox.checked) participants.add(phone.phoneCode); else participants.delete(phone.phoneCode); void rebuild().catch(fail); };
      label.append(checkbox, '参与同步'); header.append(label);
      const button = document.createElement('button'); button.textContent = '设为主控';
      button.onclick = () => { primaryCode = phone.phoneCode; renderTiles(); void rebuild().catch(fail); void grantPreviews().catch(fail); }; header.append(button);
      box.textContent = '等待截图';
    }
    tile.append(header, box); $('followers').append(tile);
    if (phone.phoneCode !== primaryCode) previews.push({ code: phone.phoneCode, preview: new Preview(box, $('followers')) });
  }
}
function fail(error) { message(error.message || '连接失败，请重试'); }
async function rebuild() {
  if (!active) return;
  stopConnections(); const mine = generation, controller = connectionAbort = new AbortController();
  const codes = $('sync').checked ? selected.filter(phone => phone.phoneCode !== primaryCode && participants.has(phone.phoneCode)).map(phone => phone.phoneCode) : [];
  message('正在申请群控凭证');
  let result;
  try {
    result = codes.length ? await api('/api/group-ticket', { mainPhoneCode: primaryCode, followerPhoneCodes: codes, durationMs: 300000 }, controller.signal)
      : { main: { phoneCode: primaryCode, ticket: await api('/api/ticket', { phoneCode: primaryCode }, controller.signal) }, followerGroups: [] };
  } catch (error) { if (!controller.signal.aborted) throw error; return; }
  if (mine !== generation) return;
  for (const group of result.followerGroups) {
    const client = new ControlGroupClient({ signalServerUrl: group.signalServerUrl, roomTokens: Object.fromEntries(group.members.map(({ ticket }) => [ticket.roomId, ticket.token])) });
    client.on('failure', () => message('从控连接失效，请点击群控按钮重新连接')); client.start(); followers.push(client);
  }
  const ticket = result.main.ticket;
  if (Date.parse(ticket.expiresAt) <= Date.now()) { stopConnections(); throw new Error('凭证已过期，请重新连接'); }
  $('primary-name').textContent = result.main.phoneCode;
  sdk = new WebRtcSdk({ mountedElement: $('primary'), enabledDebug: false, enabledIMEKeyboard: true,
    connectConfig: { signalServerUrl: ticket.signalServerUrl, roomId: ticket.roomId, token: ticket.token, hostTurn: ticket.turnServerUris, spareTurn: [], isGroup: false, signAgain: false } }, {
    clientFactory(config) {
      const client = new WebRtcClient(config), send = client.sendChannelData.bind(client); primarySend = send;
      client.sendChannelData = (type, data) => {
        if (type === ChannelDataType.ClickData) {
          if (data.action === 0) lastTouch = { data, started: performance.now(), clients: followers.filter(item => item.sendData(type, data)) };
          else { lastTouch?.clients.forEach(item => item.sendData(type, data)); if (lastTouch) lastTouch.data = data; if (data.action === 1) lastTouch = null; }
        } else followers.forEach(item => item.sendData(type, data));
        return send(type, data);
      };
      return client;
    },
  });
  sdk.on(WebRtcSdk.EVENTS.LOADED_FAILURE, () => message('主控连接失败，请重新连接'));
  sdk.init(); sdk.startConnection(); sdk.disableAudio(); message('已发起连接；切换主控将重新申请一次性凭证');
}
async function grantPreviews() {
  if (!active || !selected.length || granting) return;
  granting = true; clearTimeout(grantTimer); previewAbort?.abort(); const controller = previewAbort = new AbortController(); const start = Date.now();
  try {
    const result = await api('/api/previews', { phoneCodes: selected.map(phone => phone.phoneCode), durationMs: 1200000 }, controller.signal);
    if (controller.signal.aborted) return;
    const urls = new Map(result.previews.map(item => [item.phoneCode, item.previewUrl]));
    for (const item of previews) item.preview.setUrl(urls.get(item.code));
    grantDue = start + 1170001;
    grantTimer = setTimeout(() => void grantPreviews().catch(fail), Math.max(0, grantDue - Date.now()));
  } catch (error) {
    if (controller.signal.aborted) return;
    grantDue = Date.now() + 5000; grantTimer = setTimeout(() => void grantPreviews().catch(fail), 5000); throw error;
  } finally { if (previewAbort === controller) granting = false; }
}
function renderRows() {
  $('phones').replaceChildren();
  for (const row of rows) {
    const tr = document.createElement('tr'), td = document.createElement('td'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.code = row.phoneCode;
    checkbox.disabled = !row.phoneCode || row.online !== true || row.status !== 2;
    checkbox.onchange = () => { const n = $('phones').querySelectorAll('input:checked').length; if (n > 100) { checkbox.checked = false; message('最多选择 100 台'); } $('start').disabled = $('phones').querySelectorAll('input:checked').length < 2; };
    td.append(checkbox); tr.append(td);
    for (const value of [row.phoneCode, ['未知', '启动中', '运行中', '已关机', '异常'][row.status ?? 0], row.online ? '在线' : '离线']) { const cell = document.createElement('td'); cell.textContent = value || '—'; tr.append(cell); }
    $('phones').append(tr);
  }
  $('more').disabled = !hasMore; $('start').disabled = true;
}
async function query(reset) {
  $('reload').disabled = true; $('more').disabled = true;
  try {
    if (reset) { stop(); selected = []; rows = []; cursor = null; $('list').hidden = false; $('workspace').hidden = true; }
    const result = await api('/api/phones', { scroller: { cursor, size: 100 } });
    rows.push(...result.items); cursor = result.nextCursor; hasMore = result.hasMore; renderRows(); message(`已加载 ${rows.length} 台云机`);
  } finally { $('reload').disabled = false; }
}
$('login').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
  try { await api('/api/session', Object.fromEntries(new FormData(form))); await query(true); } catch (error) { fail(error); } finally { button.disabled = false; }
};
$('reload').onclick = () => void query(true).catch(fail); $('more').onclick = () => void query(false).catch(fail);
$('start').onclick = () => {
  stop(); const chosen = new Set([...$('phones').querySelectorAll('input:checked')].map(input => input.dataset.code)); selected = rows.filter(phone => chosen.has(phone.phoneCode));
  if (selected.length < 2) return; active = true; primaryCode = selected[0].phoneCode; participants.clear(); selected.forEach(phone => participants.add(phone.phoneCode));
  $('list').hidden = true; $('workspace').hidden = false; renderTiles(); void rebuild().catch(fail); void grantPreviews().catch(fail);
};
$('sync').onchange = () => { if (active) void rebuild().catch(fail); };
$('stop').onclick = () => { stop(); message('已断开'); };
$('logout').onclick = () => { stop(); selected = []; rows = []; renderRows(); $('login').reset(); $('workspace').hidden = true; $('list').hidden = false; void api('/api/logout').catch(fail); message('凭据已清除'); };
$('home').onclick = () => sdk?.goHome(); $('back').onclick = () => sdk?.goBack(); $('task').onclick = () => sdk?.goTask();
const resume = () => { if (!document.hidden && active && selected.length && Date.now() >= grantDue) void grantPreviews().catch(fail); };
document.addEventListener('visibilitychange', resume); window.addEventListener('focus', resume);
window.addEventListener('pagehide', stop);
