# 接入教程

面向客户的独立示例。每个教程独立安装、独立运行。

| 教程 | 内容 |
| --- | --- |
| [WebRTC 单控](webrtc-sdk-samples/README.md) | 原生 H5、React、Vue、script 标签四种接入方式 |
| [WebRTC 群控](webrtc-sdk-group-samples/README.md) | AK/SK 服务端签名、查询与选择云机、主控切换及从控实时预览 |
| [OpenAPI · Node.js](openapi-nodejs-samples/README.md) | Node.js + AWS SDK v3：板卡查询、STS 分片上传与探测 |
| [OpenAPI · Java](openapi-java-samples/README.md) | Java + AWS SDK 2.x：板卡查询、STS 分片上传与探测 |
| [OpenAPI · Go](openapi-go-samples/README.md) | Go + AWS SDK v2：板卡查询、STS 分片上传与探测 |

下列教程中以教程代码根目录为起点的命令，均在获取代码并进入该根目录后执行。

izuanke 版教程仓库：`https://gitee.com/izuanke/izuanke-samples.git`。获取代码：

```bash
git clone https://gitee.com/izuanke/izuanke-samples.git
cd izuanke-samples
```


WebRTC 示例通过 npm 使用 `@vmaos/webrtc-sdk`。OpenAPI 示例分别在 Node.js、Java 或 Go 服务端运行；AK/SK 不放到浏览器代码中。**群控教程的 AK/SK 输入框仅用于本机调试，生产环境必须将 AK/SK 保存在后端服务器**，提交给同源后端后保留在当前页面输入框中，退出时清空；签名始终由后端执行。

两套示例在工作区中使用同级目录，互不嵌套。可运行 `node scripts/verify-parity.mjs` 检查当前示例内容；比较两套示例时使用 `node scripts/verify-parity.mjs --against <另一套示例的目录>`。 提交前请先暂存两套示例的全部新增、修改及删除，再运行 `node scripts/verify-parity.mjs --staged` 检查实际暂存内容与一致性；两套位于不同目录时使用 `node scripts/verify-parity.mjs --staged --against <另一套示例的目录>`，该检查需要 Git。
