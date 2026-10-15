import { createHash } from 'node:crypto';
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';

// 即使小文件也走 Multipart，便于学习完整分片流程；仅最后一片允许小于 5 MiB。
export async function multipartUpload(file, size, expectedSha256, sts, {
  partSize = 8 * 1024 * 1024, onProgress = () => {}, clientFactory = options => new S3Client(options),
} = {}) {
  if (!Number.isSafeInteger(partSize) || partSize < 5 * 1024 * 1024 || Math.ceil(size / partSize) > 10_000) {
    throw new Error('分片至少 5 MiB，且总分片数不能超过 10000');
  }
  const client = clientFactory({ endpoint: sts.endpoint, region: sts.region,
    forcePathStyle: sts.forcePathStyle,
    credentials: { accessKeyId: sts.accessKeyId, secretAccessKey: sts.secretAccessKey, sessionToken: sts.sessionToken },
    maxAttempts: 3, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  const target = { Bucket: sts.bucket, Key: sts.objectKey };
  const send = command => client.send(command, { abortSignal: AbortSignal.timeout(60_000) });
  const hash = createHash('sha256');
  let uploadId;
  try {
    const expiresAt = Date.parse(sts.expiration);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('STS 已过期');
    const created = await send(new CreateMultipartUploadCommand(target));
    uploadId = created.UploadId;
    if (!uploadId) throw new Error('S3 未返回 UploadId');
    const parts = [];
    for (let offset = 0, number = 1; offset < size; number++) {
      if (Date.now() >= expiresAt) throw new Error('STS 已过期，请重新申请上传');
      const body = Buffer.alloc(Math.min(partSize, size - offset));
      let filled = 0;
      while (filled < body.length) {
        const { bytesRead } = await file.read(body, filled, body.length - filled, offset + filled);
        if (!bytesRead) throw new Error('上传期间文件大小发生变化');
        filled += bytesRead;
      }
      hash.update(body);
      const result = await send(new UploadPartCommand({ ...target, UploadId: uploadId,
        PartNumber: number, Body: body, ContentLength: body.length }));
      if (!result.ETag) throw new Error('S3 分片响应缺少 ETag');
      parts.push({ PartNumber: number, ETag: result.ETag });
      offset += body.length;
      onProgress({ uploadedBytes: offset, sizeBytes: size, partNumber: number });
    }
    if ((await file.stat()).size !== size || hash.digest('hex') !== expectedSha256) {
      throw new Error('上传期间文件内容发生变化，请重新运行');
    }
    await send(new CompleteMultipartUploadCommand({ ...target, UploadId: uploadId,
      MultipartUpload: { Parts: parts } }));
  } catch {
    let cleanup = '';
    if (uploadId) {
      try { await send(new AbortMultipartUploadCommand({ ...target, UploadId: uploadId })); }
      catch { cleanup = '；中止分片未确认，请检查上传状态或联系管理员清理'; }
    }
    throw new Error(`S3 分片上传失败，请检查网络、文件是否变化以及 STS 有效期${cleanup}`);
  } finally { client.destroy(); }
}
