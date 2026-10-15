# VMAOS OpenAPI 示例（Node.js）

其他语言：[Java](../openapi-java-samples/README.md)、[Go](../openapi-go-samples/README.md)。

两个可以直接运行的服务端 Demo：

- `query:boards`：签名调用 `POST /open-api/board/query`，使用 `nextCursor` 查询所有批次。
- `upload`：计算完整文件 SHA-256 → `upload-sts` → AWS S3 SDK 分片上传 → `upload-probe`，等待文件可用。

## 准备

需要 Node.js 24.15.0 或更高版本。AK/SK 从 VMAOS Manage 获取，并配置调用服务器的出口 IP 白名单及权限。系统时钟应准确。

```bash
cd vmaos-samples/openapi-nodejs-samples
npm ci
cp .env.example .env
```

编辑 `.env`：

```dotenv
VMAOS_BASE_URL=https://你的OpenAPI域名
VMAOS_ACCESS_KEY=你的AK
VMAOS_SECRET_KEY=你的SK
```

Base URL 从 Manage 的 OpenAPI 概览确认，只填写 origin（协议、域名、可选端口），不要填写 Manage 地址或 `/open-api` 路径。示例中的 `openapi.example.com` 是占位地址。AK/SK 只在业务服务器使用，不放到网页、App、URL、日志或 Git 中；`.env` 已被忽略。

## 1. 查询板卡

```bash
npm run query:boards
```

首批请求：

```json
{"scroller":{"cursor":null,"size":200},"status":null,"online":null}
```

成功响应使用九位返回码 `200000000`，数据位于 `data`，并包含 `traceId`。`data` 中有 `items`、`nextCursor`、`size`、`hasMore`。若 `hasMore=true`，将 **整个 nextCursor 对象** 原样填入下次请求的 `scroller.cursor`（例如 `{"id":"123456789"}`），保持筛选条件不变，直至 `hasMore=false`。ID 始终保留为字符串，避免 JavaScript 精度丢失。

可在 `src/query-boards.mjs` 中传入 `queryBoards(api, { size: 100, status: 2, online: true })`。

| 筛选字段 | 可填值 |
| --- | --- |
| status | null 不筛选；1 待分配；2 已分配；3 故障；4 维护中 |
| online | null 不筛选；true 在线；false 离线 |

租户身份由 AK 确定，不传 `tenantId`。滚动查询不提供总数，也不是数据快照。

## 2. 上传文件并等待可用

```bash
npm run upload -- ./demo.zip /教程/demo.zip OTHER
npm run upload -- ./app.apk /应用/app.apk APK
```

参数依次是本地文件、租户网盘完整路径（含文件名）、分类编码（缺省 OTHER）。缺失目录会自动创建。请选择可用的新网盘路径，重名可能被服务端拒绝。

| fileCategory | 含义 |
| --- | --- |
| APK | 安卓安装包；APK/XAPK/APKS 都填 APK |
| IMAGE | 图片 |
| VIDEO | 视频 |
| AUDIO | 音频 |
| OTHER | 其他文件 |

实际可填范围以 Manage 接口调试页面显示的当前启用分类为准。服务端可配置上传上限；示例自身最多接受 32 GiB。

完整流程在 `src/upload.mjs`：

1. 流式计算 `sha256 = lowercase_hex(SHA-256(完整文件原始字节))` 和字节数；SHA-256 是 64 位小写十六进制，不包含文件名、路径，也不是 ETag。Linux 可用 `sha256sum 文件名` 对照第一列。
2. 调用 `POST /open-api/storage/upload-sts`，提交 `tenantPath`、`sha256`、`sizeBytes`、`fileCategory`、`createDirectories:true`、`durationSeconds:3600`。
3. 保存返回的 `fileTid`。如果 `status=1`，文件已秒传复用，直接成功，不访问 S3。如果 `status=0`，使用返回的 `sts`。
4. 用 `sts.endpoint`、`region`、`forcePathStyle` 和临时 `accessKeyId`、`secretAccessKey`、`sessionToken` 创建 `S3Client`，仅写返回的 `bucket` 和 `objectKey`。网盘路径不能替代物理对象键。
5. `CreateMultipartUpload` → 顺序 `UploadPart`（每片 8 MiB，最后一片可更小）→ `CompleteMultipartUpload`。即使小文件也使用分片接口。保留每片 ETag 供完成请求使用；ETag 不作为 SHA-256。上传异常时尝试 `AbortMultipartUpload`，原始 SDK 异常和凭证不打印。
6. S3 完成后等待 1.5 秒，调用 `POST /open-api/storage/upload-probe`，传 `{"fileTid":"返回的编号","forceFailIfIncomplete":false}`；按 `nextProbeAfterSeconds` 继续轮询（缺省 2 秒）。**只有 status=1 才表示文件可用**。

| status | 处理 |
| --- | --- |
| 0 | 上传中或校验中，继续探测 |
| 1 | 文件可用，成功 |
| -1 | 上传失败，退出 |
| -2 | 服务端判定上传超时，退出 |
| 2 | 待删除，不可用，退出 |

探测默认最多等待 5 分钟；本地等待超时不会强制终止服务端上传。可用日志中的 `fileTid` 继续查询：

```bash
npm run probe -- 123456789
```

### 查看 OpenAPI 入参和出参日志

`npm run upload` 和 `npm run probe` 默认输出每次 OpenAPI 调用的日志。`upload-sts` 申请、每一轮 `upload-probe` 都显示：

- `[OpenAPI request]`：HTTP 方法、接口路径和实际发送的 JSON 入参。
- `[OpenAPI response]`：HTTP 状态、耗时和 JSON 响应信封（`code`、`message`、`traceId`、`data`）。失败响应同样记录，便于按 traceId 排查。
- `[OpenAPI error]`：网络异常或超时的异常类型和耗时；非 JSON 响应只记录状态及说明，不打印原始正文。

示例（节选，地址、编号及 traceId 均为占位值）：

```text
[OpenAPI request] POST /open-api/storage/upload-sts
{
  "method": "POST",
  "path": "/open-api/storage/upload-sts",
  "event": "request",
  "body": {
    "tenantPath": "/教程/demo.zip",
    "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "sizeBytes": 3,
    "fileCategory": "OTHER",
    "createDirectories": true,
    "durationSeconds": 3600
  }
}
[OpenAPI response] POST /open-api/storage/upload-sts
{
  "method": "POST",
  "path": "/open-api/storage/upload-sts",
  "event": "response",
  "httpStatus": 200,
  "durationMs": 42,
  "body": {
    "code": 200000000,
    "message": "success",
    "traceId": "demo-trace",
    "data": {
      "fileTid": "123456789",
      "status": 0,
      "sts": {
        "endpoint": "https://s3.example.com",
        "region": "us-east-1",
        "forcePathStyle": true,
        "bucket": "sample-bucket",
        "objectKey": "uploads/OTHER/example-object",
        "accessKeyId": "[REDACTED]",
        "secretAccessKey": "[REDACTED]",
        "sessionToken": "[REDACTED]",
        "expiration": "2099-01-01T00:00:00Z"
      }
    }
  }
}
```

日志不输出认证请求头、AK/SK 或签名；JSON 中的临时凭证等敏感字段递归替换为 `[REDACTED]`，实际交给 S3 SDK 的凭证保持原值。分片进度仍单独显示。日志包含网盘路径等业务数据，分享前应检查。

示例不自动续签 STS、不自动重发 `upload-sts`、不提供断点续传；凭证过期或上传失败后需先确认服务端状态。上传过程中不要修改源文件。分片 SDK 对传输失败最多尝试 3 次，每次请求限时 60 秒；OpenAPI 请求限时 30 秒，写请求不自动重试。`durationSeconds=3600` 只是申请的凭证有效期，不保证文件一定能在期限内传完。

## 签名说明

`src/client.mjs` 对 JSON **只序列化一次**，相同 UTF-8 字节用于摘要和实际发送。SK 先按无填充 Base64URL 解码为 32 字节，再计算 HMAC-SHA-256。

规范请求由以下九行用 LF 连接，末尾无换行：

```text
HMAC-SHA-256
<AK>
<Unix毫秒时间戳>
POST
<请求路径>
<排序后的查询串；没有则为空行>
<小写Host，默认端口省略>
application/json
<请求体原始字节的SHA-256小写十六进制>
```

将 HMAC 结果编码为 64 位小写十六进制，放入 `X-VMAOS-Signature`；同时发送 `X-VMAOS-Algorithm`、`X-VMAOS-Access-Key`、`X-VMAOS-Timestamp`。三个示例接口均无 URL 查询参数，路径为固定 ASCII 路径。签名客户端限定这些接口，不是通用 OpenAPI SDK。

注意：请求体摘要用于请求验签；上传参数 `sha256` 则是完整文件摘要，两者输入不同。错误输出保留 HTTP 状态、业务码和 traceId，可在 Manage 对照错误信息排查；输出 STS 响应时会隐藏临时凭证。

## 验证

```bash
npm ci
npm test
```

测试使用固定的合成密钥和模拟 OpenAPI/S3，覆盖签名向量、分页、分片合并与失败清理、秒传、上传后探测、失败和超时。不会访问真实租户或上传真实文件；真实闭环需要有效 AK/SK、可达的 S3 地址和服务端文件校验服务。

S3 接口参考：[AWS SDK for JavaScript v3 官方示例](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html)。
