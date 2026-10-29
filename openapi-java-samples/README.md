# OpenAPI Java 教程

其他语言：[Node.js](../openapi-nodejs-samples/README.md)、[Go](../openapi-go-samples/README.md)。

独立 Maven 工程，使用 JDK HttpClient、Jackson 3 和官方 AWS SDK for Java 2.x。无需平台源码，也不依赖其他教程。

## 准备与运行

需要 **JDK 17 或更高版本、Maven 3.9 或更高版本**。在教程代码根目录运行：

```bash
cd openapi-java-samples
cp .env.example .env
# 编辑 .env，填入自己的 OpenAPI 地址、AK、SK
mvn -q compile exec:java -Dexec.args="boards"
mvn -q compile exec:java -Dexec.args="upload ./demo.zip /教程/demo.zip OTHER"
mvn -q compile exec:java -Dexec.args="upload ./app.xapk /应用/app.xapk APK"
mvn -q compile exec:java -Dexec.args="probe 123456789"
```

Maven 的 `-Dexec.args` 会解析命令参数；文件路径包含空格时需要在参数中使用引号。首次运行会从公共 Maven 仓库下载锁定版本的依赖。SDK 的原始日志关闭，由示例输出脱敏后的 OpenAPI 日志。

## AK/SK 与请求签名

`.env` 仅包含以下三个变量，填写你自己的值；操作系统环境变量优先于 `.env`。样例地址是占位值，请从 Manage 的 OpenAPI 概览确认实际地址，只填协议、域名和可选端口，不带 `/open-api` 路径。只有本机调试允许 HTTP，其他环境使用 HTTPS。

```dotenv
OPENAPI_BASE_URL=https://openapi.sample.com
OPENAPI_ACCESS_KEY=replace-with-your-ak
OPENAPI_SECRET_KEY=replace-with-your-sk
```

AK/SK 从 Manage 获取，确认启用、未过期、出口 IP 白名单和接口权限正确。校准服务器时钟。不要在网页、App、日志或 Git 中放置 AK/SK；`.env` 和构建产物已忽略。环境文件按字面值读取，不执行 shell 表达式，不展开变量。不要把 `.env` 提交到仓库。

客户端只序列化一次 JSON，签名与发送使用完全相同的 UTF-8 字节。SK 是 32 字节密钥的无填充 Base64URL 编码，**先解码再用作 HMAC 密钥**。

以下九行用单个 LF 连接，末尾没有换行：

```text
HMAC-SHA-256
<AK>
<Unix 毫秒时间戳>
POST
<固定请求路径>
<排序后的查询串，没有则保留空行>
<小写 Host，默认端口省略>
application/json
<实际请求体字节的 SHA-256，小写十六进制>
```

用解码后的 SK 对这个字符串执行 HMAC-SHA-256，输出 64 位小写十六进制作为 `X-API-Signature`。同时发送 `X-API-Algorithm: HMAC-SHA-256`、`X-API-Access-Key`、`X-API-Timestamp`。本教程的三个接口均为固定 ASCII 路径且无 URL 查询参数；客户端是教程示例，不是覆盖所有接口的通用 SDK。

## 1. 查询板卡

`boards` 调用 `POST /open-api/board/query`，第一批请求：

```json
{"scroller":{"cursor":null,"size":200}}
```

成功响应 `code=200000000`，`data` 包含 `items`、`nextCursor`、`size`、`hasMore`。当 `hasMore=true`，下一批将整个 `nextCursor` 对象原样放到 `scroller.cursor`（例如 `{"id":"9007199254740993"}`）。ID 始终使用字符串。示例自动取全部批次，不计算总数，查询期间新增的数据不保证进入后续批次。

省略 `status`、`online` 表示不筛选。可修改查询请求添加 `status:2`（已分配）及 `online:true`（在线），后续批次必须保持筛选不变。status 可填 1 待分配、2 已分配、3 故障、4 维护中；online 可填 true/false。租户由 AK 确定，不传 tenantId。

## 2. 上传文件并等待可用

上传命令的参数是 **本地文件、网盘完整路径、分类编码**，分类缺省 OTHER。网盘路径必须含文件名，缺失目录自动创建；使用可用的新路径，同名可能被服务端拒绝。

| fileCategory | 含义 |
| --- | --- |
| APK | 安卓安装包，APK/XAPK/APKS 均填 APK |
| IMAGE | 图片 |
| VIDEO | 视频 |
| AUDIO | 音频 |
| OTHER | 其他文件 |

实际可填范围以 Manage 接口调试中的当前启用分类为准。示例接受 1 字节至 32 GiB 的普通文件；服务端可以设置更小上限。上传时不要修改源文件。

1. 流式计算完整文件原始字节的 SHA-256 与字节数。`sha256 = lowercase_hex(SHA-256(完整文件原始字节))`，结果是 **64 位小写十六进制**。它不含文件名、路径，不是 ETag 或分片组合摘要。Linux 可用 `sha256sum 文件名` 核对第一列。
2. `POST /open-api/storage/upload-sts`：提交 `tenantPath`、`sha256`、`sizeBytes`、`fileCategory`、`createDirectories:true`、`durationSeconds:3600`。
3. 保存响应中的 `fileTid`。若 `status=1`，文件已经秒传复用，不需要访问 S3；否则必须是 `status=0` 并带 `sts`。
4. 使用返回的 `sts.endpoint`、`region`、`forcePathStyle`，以及临时 `accessKeyId`、`secretAccessKey`、`sessionToken` 配置 S3 SDK。仅写返回的 `bucket` 和 `objectKey`，不能用 tenantPath 替代 objectKey。
5. S3 `CreateMultipartUpload` → 顺序 `UploadPart`（每片 8 MiB）→ `CompleteMultipartUpload`。即使小文件也使用 Multipart，只有最后一片允许小于 5 MiB。记录每片 ETag 并按序提交；上传失败时尝试 `AbortMultipartUpload`，不打印原始 SDK 异常。
6. S3 完成后先等 1.5 秒，再 `POST /open-api/storage/upload-probe`：`{"fileTid":"申请返回的编号","forceFailIfIncomplete":false}`。按响应的 `nextProbeAfterSeconds` 继续探测，缺省约 2 秒。**只有探测返回 status=1 才报告文件可用**；S3 上传完毕不等于文件已经通过校验。

| status | 处理 |
| --- | --- |
| 0 | 上传中或校验中，继续探测 |
| 1 | 文件可用，成功 |
| -1 | 上传失败，退出 |
| -2 | 服务端判定上传超时，退出 |
| 2 | 待删除，不可用，退出 |

本地最多探测 5 分钟，超时不会把服务端上传置为失败，可用同一 fileTid 再执行 `probe`。OpenAPI 每次请求限时 30 秒且不自动重试写请求；S3 每次请求限时 60 秒、最多尝试 3 次，超时并不保证服务端没有收到请求。凭证有效期只是上传期限，不保证网络能及时传完。

本示例不自动续签、不提供断点续传。失败后先检查 fileTid 对应的状态和网盘路径，再决定重新申请；不要盲目重复提交。中止分片未确认时检查上传状态或联系管理员清理。

## 入参、出参与错误日志

示例对每次 OpenAPI 调用输出 JSON 日志：请求包含 `method/path/body`，响应包含 `httpStatus/durationMs/body`，响应 body 保留 `code/message/traceId/data`。`upload-sts` 和每一轮 `upload-probe` 都记录，业务错误响应也记录。网络异常只输出异常类型/固定说明，非 JSON 响应不打印原文。

AK/SK、认证请求头和签名不输出。JSON 中 `accessKeyId`、`secretAccessKey`、`sessionToken` 等敏感字段递归替换成 `[REDACTED]`；交给 S3 SDK 的实际凭证保持原值。示例日志形式如下（节选）：

```json
{
  "event": "response",
  "method": "POST",
  "path": "/open-api/storage/upload-sts",
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
        "accessKeyId": "[REDACTED]",
        "secretAccessKey": "[REDACTED]",
        "sessionToken": "[REDACTED]"
      }
    }
  }
}
```

请求体摘要用于验签，上传参数 sha256 是文件摘要，两者输入不同。HTTP 401 时检查 AK/SK、编码、时间与启用状态；业务失败用 code 和 traceId 到 Manage/服务端排查；S3 失败检查凭证有效期、返回的 endpoint 是否可达。日志会包含网盘路径等业务数据，分享前应检查。

## 代码导读与验证

- `OpenApi.java`：环境变量、签名、原始字节 HTTP 发送、响应校验及日志脱敏。
- `Samples.java`：板卡游标、上传申请与探测流程。
- `S3Upload.java`：SDK 分片上传、ETag 汇总、失败中止。
- `Main.java`：boards/upload/probe 命令入口。

```bash
mvn test
mvn package
```

测试使用合成密钥、内存 HTTP 服务和模拟 S3，覆盖签名向量、原始字节验签、日志脱敏、游标、秒传、分片/ETag、失败中止、探测成功/失败/超时；不会使用你的 `.env` 或访问真实租户。真实上传闭环仍需有效 AK/SK、可达的 S3 endpoint 和运行中的文件校验服务。

参考：[AWS SDK for Java 2.x S3 官方示例](https://docs.aws.amazon.com/sdk-for-java/latest/developer-guide/java_s3_code_examples.html)。
