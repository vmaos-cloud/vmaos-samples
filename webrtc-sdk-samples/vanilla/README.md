# 原生 H5 / ESM 集成教程

**AK/SK 不能放到前端项目中，必须由后端调用 OpenAPI，保障安全性。前端只接收短期 connection-ticket；不要把票据放入 URL、日志或浏览器存储。**

这是一个独立示例，不导入其他教程的代码。SDK 的连接、鼠标/触摸/键盘控制和清理都在本目录中实现。

## 启动与构建

进入本教程目录后执行；安装前请确认对应 SDK 的 0.3.0 版本已在 npm 发布，否则安装无法完成：

```bash
pnpm install
npm run dev
```

运行 `npm run build` 可生成静态页面。依赖 `@vmaos/webrtc-sdk`，无需平台源码或其他教程。

## 操作步骤

1. 在后端配置 AK/SK，校验登录用户和云机访问权限，再按 OpenAPI 签名规则调用 `POST /open-api/phone/connection-ticket`，请求体 `{"phoneCode":"云机业务编号"}`。签名规则可在 Manage 的 API 概览下载，不在前端实现。
2. 后端使用当前租户 AK；目标云机必须在线且运行中。后端通过 HTTPS 将响应交给已授权前端，不把请求头、AK/SK 或签名过程返回前端。
3. 把完整成功响应粘贴到输入框并立即点击连接。当前票据有效窗口约 25 秒，以 `expiresAt` 为准；token 一次性消费。断线、失败或过期后重新获取票据，不复用。
4. 连接后可点击/触摸画面、使用键盘和中文输入，并使用返回、主页、任务和音频按钮。断开、页面退出或组件卸载执行 `destroy()`。

## 输入格式

```json
{
  "code": 200000000,
  "message": "success",
  "data": {
    "signalServerUrl": "wss://signal.example.com",
    "roomId": "cloud-device-room",
    "token": "REPLACE_WITH_FRESH_BACKEND_TICKET",
    "turnServerUris": [
      "turn:turn.example.com:3478"
    ],
    "expiresAt": "2026-01-01T00:00:00Z"
  }
}
```

上面是格式示例，地址、token 和过期时间都是占位值，不能直接连接。页面不自动生成有效期，不会把过期票据改成有效票据。解析器只允许完整成功响应，并仅提取 SDK 必需字段；`turnServerUris` 映射为 `hostTurn`，设置 `signAgain: false` 禁用旧 token 重签。

## 本例关键实现

- `ticket.js`：校验成功码、字段、WebSocket 地址、有效期，并拒绝 AK/SK 请求头；不会把输入原文或服务端异常内容输出到日志。
- `main.js`：用户点击后才初始化 SDK，连接时清空输入，断开时销毁。启用中文输入，关闭 SDK 调试日志；每次重连都要新票据。
- 构建产物不包含 AK/SK，页面不提供 AK/SK 字段，不调用 OpenAPI，不使用 localStorage/sessionStorage 保存票据。
- 生产使用 HTTPS/WSS，并配置授权信令/TURN 域名及 CSP。不要用未经信任的来源提供的 JSON。此示例不替代后端鉴权。

## WebView / Electron

本示例可作为支持标准 WebRTC 的 H5 WebView 页面或 Electron renderer。宿主退出或切换业务页面时调用销毁；切换标签页时保留连接并释放输入状态；退出页面时销毁连接。小程序原生运行层无法直接使用该 DOM SDK。不要通过 WebView URL 传递 token；Electron 保持上下文隔离，AK/SK 仍只存放在业务后端。

**AK/SK 不能放到前端项目中，必须由后端调用 OpenAPI，保障安全性。前端只接收短期 connection-ticket；不要把票据放入 URL、日志或浏览器存储。**

## 本地摄像头（SDK 0.3.0）

本教程固定依赖 `@vmaos/webrtc-sdk@0.3.0`。只连接桌面时不会申请摄像头；在云机应用内打开摄像头后，SDK 才请求本地授权，并通过当前 WebRTC 连接上行视频，不申请麦克风权限。

1. 使用 HTTPS 或 localhost 打开页面。普通内网 IP 的 HTTP 页面无法采集摄像头；iframe 宿主需允许 `camera`，并确保 Permissions Policy 未禁止摄像头。
2. 连接云机，在云机内打开相机或其他需要摄像头的应用，并允许浏览器使用本地摄像头。
3. 页面显示“摄像头传输中”。可点击“前置”“后置”切换；桌面电脑不一定有前后两类设备，浏览器会选择可用设备。
4. 权限拒绝、设备缺失、占用或拔出时，页面独立提示摄像头错误。修正设备或权限后点击“重试摄像头”，不必重新申请桌面票据。
5. 点击“关闭摄像头”只停止本地采集，桌面连接保持。云机再次请求打开摄像头时仍会按需响应；断开、页面退出或卸载时销毁 SDK，释放设备。

`camera.js` 仅调用公开 SDK API，监听 `CAMERA_STATE_CHANGED`、`CAMERA_ERROR`，并在断开时移除监听器。`active` 应独立判断：切换失败时，旧摄像头仍可能在发送视频。摄像头错误不能当成桌面断线处理。

```js
sdk.on(WebRtcSdk.EVENTS.CAMERA_STATE_CHANGED, ({ state, active }) => {
  // state: idle / requesting / active / error
  // 根据 state 显示提示，根据 active 判断是否仍在传输。
});
sdk.on(WebRtcSdk.EVENTS.CAMERA_ERROR, ({ message }) => {
  // 显示 message，保持桌面连接。
});
await sdk.startCamera(); // 失败后重试最近一次请求
await sdk.switchCamera({ useBackCamera: false }); // 前置；true 为后置
sdk.stopCamera();
```

如需指定外接摄像头，授权后从 `navigator.mediaDevices.enumerateDevices()` 获取 `videoinput` 的 deviceId，再调用 `sdk.switchCamera({ deviceId })`；不要把设备标识写入 URL 或日志。云机侧应用需支持对应摄像头输入；本教程的自动验证不代替真实云机与物理摄像头验收。

## 粘贴和输入

复制本目录时请保留 `control.js`。鼠标移入已连接的画面后，Ctrl+V / Command+V 将本机剪贴板纯文本输入云机；先在云机中选中目标文本框。普通文字通过文本通道发送，中文等输入法仅发送一次最终确认文字；退格、回车、方向键和快捷键使用按键通道。离开画面、失焦和隐藏页面会清理组合状态并结束触控，不占用页面其他输入框。
