# React 组件 集成教程

**AK/SK 不能放到前端项目中，必须由后端调用 OpenAPI，保障安全性。前端只接收短期 connection-ticket；不要把票据放入 URL、日志或浏览器存储。**

这是一个独立示例，不导入其他教程的代码。SDK 的连接、鼠标/触摸/键盘控制和清理都在本目录中实现。

## 启动与构建

在本教程目录执行：

```bash
cd react
pnpm install --frozen-lockfile
npm run dev
```

运行 `npm run build` 可生成静态页面。依赖已发布的 `@vmaos/webrtc-sdk`，无需平台源码或其他教程。

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
- `main.jsx`：用户点击后才初始化 SDK，连接时清空输入，断开时销毁。启用中文输入，关闭 SDK 调试日志；每次重连都要新票据。
- 构建产物不包含 AK/SK，页面不提供 AK/SK 字段，不调用 OpenAPI，不使用 localStorage/sessionStorage 保存票据。
- 生产使用 HTTPS/WSS，并配置授权信令/TURN 域名及 CSP。不要用未经信任的来源提供的 JSON。此示例不替代后端鉴权。

## WebView / Electron

本示例可作为支持标准 WebRTC 的 H5 WebView 页面或 Electron renderer。宿主退出或切换业务页面时调用销毁；在页面隐藏时也释放连接。小程序原生运行层无法直接使用该 DOM SDK。不要通过 WebView URL 传递 token；Electron 保持上下文隔离，AK/SK 仍只存放在业务后端。

**AK/SK 不能放到前端项目中，必须由后端调用 OpenAPI，保障安全性。前端只接收短期 connection-ticket；不要把票据放入 URL、日志或浏览器存储。**
