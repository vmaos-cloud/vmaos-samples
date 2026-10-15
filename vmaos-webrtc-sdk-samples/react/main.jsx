import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { VmaosWebRtcSdk } from "@vmaos/webrtc-sdk";
import { parseTicket } from "./ticket.js";
import "./style.css";
function Demo() {
  const mount = useRef(null), instance = useRef();
  const [text, setText] = useState(""), [status, setStatus] = useState("尚未连接"), [busy, setBusy] = useState(false), [connected, setConnected] = useState(false);
  function dispose() { const current = instance.current; instance.current = undefined; current?.destroy(); }
  function disconnect() { dispose(); setText(""); setBusy(false); setConnected(false); setStatus("已断开，请获取新的票据"); }
  useEffect(() => {
    const hide = () => { if (instance.current) disconnect(); };
    const visibility = () => { if (document.hidden) hide(); };
    window.addEventListener("pagehide", hide); document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("pagehide", hide); document.removeEventListener("visibilitychange", visibility); dispose(); };
  }, []);
  function connect() {
    try {
      const config = parseTicket(text); disconnect();
      const current = new VmaosWebRtcSdk({ mountedElement: mount.current, connectConfig: config, enabledIMEKeyboard: true });
      instance.current = current; setBusy(true); setStatus("正在连接…");
      current.on(VmaosWebRtcSdk.EVENTS.CONNECTED, () => { if (instance.current === current) { setConnected(true); setStatus("已连接，可点击画面或使用键盘"); } });
      current.on(VmaosWebRtcSdk.EVENTS.ERROR, () => { if (instance.current === current) { disconnect(); setStatus("连接失败，请检查网络与云机状态并获取新票据"); } });
      current.on(VmaosWebRtcSdk.EVENTS.STOP_CONNECT, () => { if (instance.current === current) disconnect(); });
      current.init();
    } catch (error) { disconnect(); setStatus(error instanceof Error ? error.message : "连接初始化失败"); }
  }
  return <main><h1>React 集成演示</h1><p className="security">AK/SK 不能放到前端项目中，必须由后端调用 OpenAPI，保障安全性。前端只接收短期 connection-ticket；不要把票据放入 URL、日志或浏览器存储。</p><p>后端调用 POST /open-api/phone/connection-ticket，输入完整成功 JSON。票据约 25 秒有效且仅能消费一次；失败或断线后需获取新票据。</p><div className="layout"><section><label htmlFor="ticket">OpenAPI 结果 JSON</label><textarea id="ticket" autoComplete="off" spellCheck={false} value={text} onChange={event => setText(event.target.value)} /><button disabled={busy} onClick={connect}>连接云机</button><button disabled={!busy} onClick={disconnect}>断开并清空</button><p className="status" role="status">{status}</p>{[["goBack","返回"],["goHome","主页"],["goTask","任务"],["enableAudio","开启音频"],["disableAudio","关闭音频"]].map(([action,label]) => <button key={action} disabled={!connected} onClick={() => instance.current?.[action]()}>{label}</button>)}</section><div ref={mount} className="device" aria-label="云机画面" /></div></main>;
}
createRoot(document.querySelector("#app")).render(<React.StrictMode><Demo /></React.StrictMode>);
