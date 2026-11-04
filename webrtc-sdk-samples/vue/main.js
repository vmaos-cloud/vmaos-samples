import { mountRemoteNavigation } from "./navigation.js";
import { createControlledSdk } from "./control.js";
import { createApp, h, ref, onMounted, onUnmounted } from "vue";
import * as SDK from "@vmaos/webrtc-sdk";
const { WebRtcSdk } = SDK;
import { parseTicket } from "./ticket.js";
import { mountCameraControls } from "./camera.js";
import "./style.css";
createApp({
  setup() {
    const mount = ref(), text = ref(""), status = ref("尚未连接"), busy = ref(false), connected = ref(false);
    const cameraHost = ref(), navigationHost = ref();
    let sdk, cameraCleanup, navigation;
    function disconnect() { navigation?.disconnect(); cameraCleanup?.(); cameraCleanup = undefined; const current = sdk; sdk = undefined; current?.destroy(); text.value = ""; busy.value = false; connected.value = false; status.value = "已断开，请获取新的票据"; }
    const hide = () => { if (sdk) disconnect(); };
    const visibility = () => { if (document.hidden) sdk?.cancelInput(); };
    onMounted(() => { navigation = mountRemoteNavigation(navigationHost.value); window.addEventListener("pagehide", hide); document.addEventListener("visibilitychange", visibility); });
    onUnmounted(() => { window.removeEventListener("pagehide", hide); document.removeEventListener("visibilitychange", visibility); disconnect(); navigation?.destroy(); });
    function connect() {
      try {
        const config = parseTicket(text.value); disconnect();
        const current = createControlledSdk(SDK, { mountedElement: mount.value, connectConfig: config, enabledIMEKeyboard: true });
        sdk = current; navigation.bind(WebRtcSdk,current); cameraCleanup = mountCameraControls(WebRtcSdk, current, cameraHost.value); busy.value = true; status.value = "正在连接…";
        current.on("control-state", ({connected: ready}) => { if (sdk === current) { connected.value = ready; status.value = ready ? "已连接，可点击画面或使用键盘" : "连接中，操作已暂停…"; } });
        current.on(WebRtcSdk.EVENTS.CONNECTED, () => { if (sdk === current) { connected.value = true; status.value = "已连接，可点击画面或使用键盘"; } });
        current.on(WebRtcSdk.EVENTS.ERROR, () => { if (sdk === current) { disconnect(); status.value = "连接失败，请检查网络与云机状态并获取新票据"; } });
        current.on(WebRtcSdk.EVENTS.STOP_CONNECT, () => { if (sdk === current) disconnect(); });
        current.init();
      } catch (error) { disconnect(); status.value = error instanceof Error ? error.message : "连接初始化失败"; }
    }
    return () => h("main", [h("h1", "Vue 集成演示"), h("p", { class: "security" }, "AK/SK 不能放到前端项目中，必须由后端调用 OpenAPI，保障安全性。前端只接收短期 connection-ticket；不要把票据放入 URL、日志或浏览器存储。"), h("p", "后端调用 POST /open-api/phone/connection-ticket，输入完整成功 JSON。票据约 25 秒有效且仅能消费一次；失败或断线后需获取新票据。"), h("div", { class: "layout" }, [h("section", [h("label", { for: "ticket" }, "OpenAPI 结果 JSON"), h("textarea", { id: "ticket", autocomplete: "off", spellcheck: false, value: text.value, onInput: event => text.value = event.target.value }), h("button", { disabled: busy.value, onClick: connect }, "连接云机"), h("button", { disabled: !busy.value, onClick: disconnect }, "断开并清空"), h("p", { role: "status", class: "status" }, status.value), h("p", { class: "camera-hint" }, "在云机应用中打开摄像头后授权本地设备。需 HTTPS 或 localhost；不申请麦克风权限。"), h("div", { ref: cameraHost })]), h("div", { class: "screen" }, [h("div", { ref: mount, class: "device", "aria-label": "云机画面" }), h("div", { ref: navigationHost })])])]);
  }
}).mount("#app");
