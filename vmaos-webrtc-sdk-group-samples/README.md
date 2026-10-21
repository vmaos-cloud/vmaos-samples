# WebRTC 群控教程

> **⚠️ AK/SK 输入仅供本机调试。生产环境必须将 AK/SK 保存在后端服务器，由后端签名调用 OpenAPI；不要写入前端代码、浏览器存储或公开页面。** 本例的输入框只是为了方便调试，不能作为生产系统的凭据管理方式。

此示例通过公开 npm 包 `@vmaos/webrtc-sdk@0.1.2` 和公开 OpenAPI 实现群控。页面提供 AK、SK 输入框，查询云机后勾选在线运行的云机，至少两台、最多一百台。

主控只有一路 WebRTC，从控使用实时图片预览和合并的 WebSocket 控制连接。可以选择是否同步、单独勾选从控，并在列表原位置显示主控“操控中”占位。切换主控时重新申请凭证，列表顺序保持不变。

## 运行

需要 Node.js 24.15.0 或更高版本，以及 pnpm 12.4.1。先确认服务端已支持本教程列出的接口、信令服务支持 SDK 0.1.2 的群控连接。

```bash
cd vmaos-webrtc-sdk-group-samples
cp .env.example .env
# 将 .env 中的 VMAOS_BASE_URL 改为自己的 OpenAPI HTTPS 根地址
pnpm install --frozen-lockfile
pnpm start
```

打开 `http://127.0.0.1:5176`。页面使用已安装 npm SDK 的浏览器 IIFE 入口，无需 CDN。不要复制平台 SDK 源码、使用 workspace/link/file 依赖或提交本地构建产物。

1. 输入自己的 AK/SK，点击“连接并查询云机”。浏览器同源提交到本例后端，AK/SK 保留在当前页面输入框中，方便重复调试；点击“退出并清除凭据”后清空。
2. 通过“加载更多”翻阅云机，勾选要操作的在线运行云机，点击“群控所选云机”。列表只来自当前 AK 租户，AK/SK 不授予其他租户访问能力。
3. 在左侧主控画面点击、滑动或输入文字，通过底部按钮发送返回、主页和最近任务操作。勾选“参与同步”的从控随主控操作。
4. 点击某台从控“设为主控”切换。切换、成员调整及重连都会释放旧连接、重新授权，已消费的一次性凭证不能复用。
5. “断开群控”释放媒体、控制连接和预览请求。“退出并清除凭据”还会清除服务端内存会话。

## 接口与数据流

| 浏览器调用本例后端 | 后端签名调用的公开接口 | 用途 |
| --- | --- | --- |
| `/api/session` | 无 | 接收输入的 AK/SK，创建短期服务端内存会话 |
| `/api/phones` | `POST /open-api/phone/query` | 首次 `scroller.cursor=null`，后续原样使用 `nextCursor` |
| `/api/group-ticket` | `POST /open-api/phone/group-connection-ticket` | 一次获取主控及从控逐台凭证 |
| `/api/ticket` | `POST /open-api/phone/connection-ticket` | 不同步任何从控时只授权主控 |
| `/api/previews` | `POST /open-api/phone/screenshot-token` | 获取各云机完整预览地址 |

群控请求：

```json
{"mainPhoneCode":"P1","followerPhoneCodes":["P2","P3"],"durationMs":300000}
```

成功响应的 `data.main` 包含 `phoneCode`、`ticket`；`data.followerGroups` 按 `signalServerUrl` 分组，每组的 `members` 同样包含 `phoneCode`、`ticket`。每张 ticket 包含 `signalServerUrl`、`roomId`、`token`、`turnServerUris`、`expiresAt`。主控凭证交给 SDK 的 `VmaosWebRtcSdk`，从控逐房间 Token 交给 `ControlGroupClient`，主控不得重复加入从控群组。

本例用 SDK 公开的 `clientFactory` 接口将主控输入转发给从控，仍由 SDK 处理视频、坐标、触摸和中文输入。每个信令地址一个从控连接，退出时停止并移除监听；正在进行的触摸先发送结束动作。

从控只在右侧滚动区域可见且页面处于前台时拉图，全页最多四个图片下载并发。每台完成下载和解码后，通过浏览器绘制时钟独立等待至少一秒，再请求下一张，不使用固定周期的图片刷新定时器。20 分钟截图授权在剩余不足 30 秒时续期；失败五秒重试，回到页面时重新检查。截图 404 表示暂时没有帧；403 表示需要新的授权。同一云机及容器的有效截图 Token 会复用，续期只延长有效期；不同云机可以返回不同 Token，接口仅返回 previews，不返回顶层 token。到期、缓存丢失或容器换代时才会生成新 Token。续期后须重新应用预览地址，即使地址没有变化，也应恢复已因 403 停止的图片请求。

## 凭据与接入自己的系统

- AK/SK 输入仅适合在本人电脑上运行这个教程。服务只监听回环地址，不提供公网登录服务。真实系统由受控后端管理凭据，并检查登录用户可操作的云机集合；不要直接公开本例。
- SK 在后端按规范 Base64URL 解码为 32 字节 HMAC 密钥，对实际发送的 UTF-8 字节签名；浏览器不实现 OpenAPI 签名。
- AK/SK 在当前页面表单中保留，签名凭据保存在服务端内存；不写 `.env`、日志、Cookie 或浏览器存储；Cookie 只有随机会话标识，设有 HttpOnly、SameSite=Strict。会话最长三十分钟，退出后清理密钥缓冲区，重启服务会丢失会话。
- 图片地址和连接票据同样属于凭证，不复制到日志、URL 导航参数或浏览器存储。`.env`、`node_modules/`、`dist/` 和生成的 SDK 文件均不提交。
- 本例后端仅允许四个固定公开接口，不接受浏览器指定上游地址；API 根地址由本地配置指定。真实部署须使用 HTTPS/WSS 和业务鉴权。

## 验证

```bash
pnpm test
pnpm check
```

自动测试验证后端签名字节一致性、接口白名单、同源限制、会话隔离及退出清理；不需要真实 AK/SK。真实云机的视频、预览和操作效果仍需使用自己的服务进行联调。
