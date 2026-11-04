import { mountRemoteNavigation } from "./navigation.js";
import { createControlledSdk } from "./control.js";
import * as SDK from "@vmaos/webrtc-sdk";
const { WebRtcSdk } = SDK;
import { parseTicket } from "./ticket.js";
import { mountCameraControls } from "./camera.js";
import "./style.css";
document.querySelector("#app").innerHTML = `<main><h1>原生 H5 / ESM 集成演示</h1><p class="security">AK/SK 不能放到前端项目中，必须由后端调用 OpenAPI，保障安全性。前端只接收短期 connection-ticket；不要把票据放入 URL、日志或浏览器存储。</p><p>后端调用 POST /open-api/phone/connection-ticket，输入完整成功 JSON。票据约 25 秒有效且仅能消费一次；失败或断线后需获取新票据。</p><div class="layout"><section><label for="ticket">OpenAPI 结果 JSON</label><textarea id="ticket" autocomplete="off" spellcheck="false" placeholder='{"code":200000000,"data":{…}}'></textarea><button id="connect">连接云机</button><button id="disconnect" disabled>断开并清空</button><p class="status" id="status" role="status">尚未连接</p><p class="camera-hint">在云机应用中打开摄像头后授权本地设备。需 HTTPS 或 localhost；不申请麦克风权限。</p><div id="camera-controls"></div></section><div class="screen"><div id="device" class="device" aria-label="云机画面"></div><div id="navigation"></div></div></div></main>`;
const input = document.querySelector("#ticket"), status = document.querySelector("#status");
const navigation = mountRemoteNavigation(document.querySelector("#navigation"));
let sdk, cameraCleanup;
function state(text, busy = false, connected = false) {
  status.textContent = text;
  document.querySelector("#connect").disabled = busy;
  document.querySelector("#disconnect").disabled = !busy;
  document.querySelectorAll("[data-action]").forEach(button => button.disabled = !connected);
}
function disconnect() { navigation.disconnect(); cameraCleanup?.(); cameraCleanup = undefined; const current = sdk; sdk = undefined; current?.destroy(); input.value = ""; state("已断开，请获取新的票据"); }
document.querySelector("#connect").onclick = () => {
  try {
    const config = parseTicket(input.value);
    disconnect();
    const current = createControlledSdk(SDK, { mountedElement: "#device", connectConfig: config, enabledIMEKeyboard: true });
    sdk = current; navigation.bind(WebRtcSdk,current); cameraCleanup = mountCameraControls(WebRtcSdk, current, document.querySelector("#camera-controls")); state("正在连接…", true);
    current.on("control-state", ({connected}) => { if (sdk === current) state(connected ? "已连接，可点击画面或使用键盘" : "连接中，操作已暂停…", true, connected); });
    current.on(WebRtcSdk.EVENTS.CONNECTED, () => { if (sdk === current) state("已连接，可点击画面或使用键盘", true, true); });
    current.on(WebRtcSdk.EVENTS.ERROR, () => { if (sdk === current) { disconnect(); state("连接失败，请检查网络与云机状态并获取新票据"); } });
    current.on(WebRtcSdk.EVENTS.STOP_CONNECT, () => { if (sdk === current) disconnect(); });
    current.init();
  } catch (error) { disconnect(); state(error instanceof Error ? error.message : "连接初始化失败"); }
};
document.querySelector("#disconnect").onclick = disconnect;

window.addEventListener("pagehide", disconnect);

if (import.meta.hot) import.meta.hot.dispose(() => { disconnect(); navigation.destroy(); });
