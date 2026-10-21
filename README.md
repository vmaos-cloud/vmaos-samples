# VMAOS 接入教程

面向 VMAOS 客户的独立示例。每个教程独立安装、独立运行。

| 教程 | 内容 |
| --- | --- |
| [WebRTC 单控](vmaos-webrtc-sdk-samples/README.md) | 原生 H5、React、Vue、script 标签四种接入方式 |
| [WebRTC 群控](vmaos-webrtc-sdk-group-samples/README.md) | AK/SK 服务端签名、查询与选择云机、主控切换及从控实时预览 |
| [OpenAPI · Node.js](openapi-nodejs-samples/README.md) | Node.js + AWS SDK v3：板卡查询、STS 分片上传与探测 |
| [OpenAPI · Java](openapi-java-samples/README.md) | Java + AWS SDK 2.x：板卡查询、STS 分片上传与探测 |
| [OpenAPI · Go](openapi-go-samples/README.md) | Go + AWS SDK v2：板卡查询、STS 分片上传与探测 |

```bash
git clone https://github.com/vmaos-cloud/vmaos-samples.git
cd vmaos-samples
```

WebRTC 示例通过 npm 使用 `@vmaos/webrtc-sdk`。OpenAPI 示例在 Node.js 服务端运行；AK/SK 不放到浏览器代码中。**群控教程的 AK/SK 输入框仅用于本机调试，生产环境必须将 AK/SK 保存在后端服务器**，提交给同源后端后保留在当前页面输入框中，退出时清空；签名始终由后端执行。
