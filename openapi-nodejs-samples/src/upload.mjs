import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { multipartUpload } from './multipart.mjs';
import { waitForFile } from './probe.mjs';

export async function uploadFile(api, localPath, tenantPath, fileCategory = 'OTHER', {
  uploadImpl = multipartUpload, probeImpl = waitForFile, onProgress = console.log,
} = {}) {
  if (!tenantPath?.startsWith('/') || tenantPath.endsWith('/')) throw new Error('tenantPath 必须是含文件名的网盘绝对路径');
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(fileCategory)) throw new Error('fileCategory 必须填写分类编码，如 OTHER 或 APK');
  const file = await open(localPath, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > 32 * 1024 ** 3) throw new Error('请选择 1 字节至 32 GiB 的普通文件');
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('计算摘要期间文件发生变化');
    const grant = await api('/open-api/storage/upload-sts', {
      tenantPath, sha256, sizeBytes: before.size, fileCategory, createDirectories: true, durationSeconds: 3600,
    });
    onProgress({ fileTid: grant.fileTid, status: grant.status }); // 不输出 sts。
    if (grant.status === 1) return { fileTid: grant.fileTid, status: 1, reused: true };
    if (grant.status !== 0 || !grant.sts) throw new Error('上传申请未返回可用的 STS');
    await uploadImpl(file, before.size, sha256, grant.sts, { onProgress });
    // S3 Complete 成功只表示字节上传完毕，必须等探测 status=1 才可使用。
    return await probeImpl(api, grant.fileTid, { onProgress });
  } finally { await file.close(); }
}
