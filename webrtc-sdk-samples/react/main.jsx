import { mountRemoteNavigation } from "./navigation.js";
import { createControlledSdk } from "./control.js";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as SDK from "@vmaos/webrtc-sdk";
const { WebRtcSdk } = SDK;
import { parseTicket } from "./ticket.js";
import { mountCameraControls } from "./camera.js";
import "./style.css";
function Demo() {
  const mount = useRef(null), instance = useRef(), cameraHost = useRef(null), cameraCleanup = useRef(), navigationHost = useRef(null), navigation = useRef();
  const [text, setText] = useState(""), [status, setStatus] = useState("尚未连接"), [busy, setBusy] = useState(false), [connected, setConnected] = useState(false);
  function dispose() { navigation.current?.disconnect(); cameraCleanup.current?.(); cameraCleanup.current = undefined; const current = instance.current; instance.current = undefined; current?.destroy(); }
  function disconnect() { dispose(); setText(""); setBusy(false); setConnected(false); setStatus("已断开，请获取新的票据"); }
  useEffect(() => {
    navigation.current = mountRemoteNavigation(navigationHost.current);
    const hide = () => { if (instance.current) disconnect(); };
    const visibility = () => { if (document.hidden) instance.current?.cancelInput(); };
    window.addEventListener("pagehide", hide); document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("pagehide", hide); document.removeEventListener("visibilitychange", visibility); dispose(); navigation.current?.destroy(); };
  }, []);
  function connect() {
    try {
      const config = parseTicket(text); disconnect();
      const current = createControlledSdk(SDK, { mountedElement: mount.current, connectConfig: config, enabledIMEKeyboard: true });
      instance.current = current; navigation.current.bind(WebRtcSdk,current); cameraCleanup.current = mountCameraControls(WebRtcSdk, current, cameraHost.current); setBusy(true); setStatus("正在连接…");
      current.on("control-state", ({connected}) => { if (instance.current === current) { setConnected(connected); setStatus(connected ? "已连接，可点击画面或使用键盘" : "连接中，操作已暂停…"); } });
      current.on(WebRtcSdk.EVENTS.CONNECTED, () => { if (instance.current === current) { setConnected(true); setStatus("已连接，可点击画面或使用键盘"); } });
      current.on(WebRtcSdk.EVENTS.ERROR, () => { if (instance.current === current) { disconnect(); setStatus("连接失败，请检查网络与云机状态并获取新票据"); } });
      current.on(WebRtcSdk.EVENTS.STOP_CONNECT, () => { if (instance.current === current) disconnect(); });
      current.init();
    } catch (error) { disconnect(); setStatus(error instanceof Error ? error.message : "连接初始化失败"); }
  }
  return <main><h1>React 集成演示</h1><p className="security">AK/SK 不能放到前端项目中，必须由后端调用 OpenAPI，保障安全性。前端只接收短期 connection-ticket；不要把票据放入 URL、日志或浏览器存储。</p><p>后端调用 POST /open-api/phone/connection-ticket，输入完整成功 JSON。票据约 25 秒有效且仅能消费一次；失败或断线后需获取新票据。</p><div className="layout"><section><label htmlFor="ticket">OpenAPI 结果 JSON</label><textarea id="ticket" autoComplete="off" spellCheck={false} value={text} onChange={event => setText(event.target.value)} /><button disabled={busy} onClick={connect}>连接云机</button><button disabled={!busy} onClick={disconnect}>断开并清空</button><p className="status" role="status">{status}</p><p className="camera-hint">在云机应用中打开摄像头后授权本地设备。需 HTTPS 或 localhost；不申请麦克风权限。</p><div ref={cameraHost} /></section><div className="screen"><div ref={mount} className="device" aria-label="云机画面" /><div ref={navigationHost} /></div></div></main>;
}
createRoot(document.querySelector("#app")).render(<React.StrictMode><Demo /></React.StrictMode>);
