import { createApp, h, ref, onMounted, onUnmounted } from "vue";
import { VmaosWebRtcSdk } from "@vmaos/webrtc-sdk";
import { parseTicket } from "./ticket.js";
import "./style.css";
createApp({
  setup() {
    const mount = ref(), text = ref(""), status = ref("尚未连接"), busy = ref(false), connected = ref(false);
    let sdk;
    function disconnect() { const current = sdk; sdk = undefined; current?.destroy(); text.value = ""; busy.value = false; connected.value = false; status.value = "已断开，请获取新的票据"; }
    const hide = () => { if (sdk) disconnect(); };
    const visibility = () => { if (document.hidden) hide(); };
    onMounted(() => { window.addEventListener("pagehide", hide); document.addEventListener("visibilitychange", visibility); });
    onUnmounted(() => { window.removeEventListener("pagehide", hide); document.removeEventListener("visibilitychange", visibility); disconnect(); });
    function connect() {
      try {
        const config = parseTicket(text.value); disconnect();
        const current = new VmaosWebRtcSdk({ mountedElement: mount.value, connectConfig: config, enabledIMEKeyboard: true });
        sdk = current; busy.value = true; status.value = "正在连接…";
        current.on(VmaosWebRtcSdk.EVENTS.CONNECTED, () => { if (sdk === current) { connected.value = true; status.value = "已连接，可点击画面或使用键盘"; } });
        current.on(VmaosWebRtcSdk.EVENTS.ERROR, () => { if (sdk === current) { disconnect(); status.value = "连接失败，请检查网络与云机状态并获取新票据"; } });
        current.on(VmaosWebRtcSdk.EVENTS.STOP_CONNECT, () => { if (sdk === current) disconnect(); });
        current.init();
      } catch (error) { disconnect(); status.value = error instanceof Error ? error.message : "连接初始化失败"; }
    }
    return () => h("main", [h("h1", "Vue 集成演示"), h("p", { class: "security" }, "AK/SK 不能放到前端项目中，必须由后端调用 OpenAPI，保障安全性。前端只接收短期 connection-ticket；不要把票据放入 URL、日志或浏览器存储。"), h("p", "后端调用 POST /open-api/phone/connection-ticket，输入完整成功 JSON。票据约 25 秒有效且仅能消费一次；失败或断线后需获取新票据。"), h("div", { class: "layout" }, [h("section", [h("label", { for: "ticket" }, "OpenAPI 结果 JSON"), h("textarea", { id: "ticket", autocomplete: "off", spellcheck: false, value: text.value, onInput: event => text.value = event.target.value }), h("button", { disabled: busy.value, onClick: connect }, "连接云机"), h("button", { disabled: !busy.value, onClick: disconnect }, "断开并清空"), h("p", { role: "status", class: "status" }, status.value), ...[["goBack","返回"],["goHome","主页"],["goTask","任务"],["enableAudio","开启音频"],["disableAudio","关闭音频"]].map(([action,label]) => h("button", { disabled: !connected.value, onClick: () => sdk?.[action]() }, label))]), h("div", { ref: mount, class: "device", "aria-label": "云机画面" })])]);
  }
}).mount("#app");
