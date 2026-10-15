import { clientFromEnv, printOpenApiLog, reportError } from './client.mjs';
import { uploadFile } from './upload.mjs';

try {
  const [localPath, tenantPath, category = 'OTHER'] = process.argv.slice(2);
  if (!localPath || !tenantPath) throw new Error('用法：npm run upload -- <本地文件> <网盘绝对路径> [分类，默认 OTHER]');
  const result = await uploadFile(clientFromEnv({ logger: printOpenApiLog }), localPath, tenantPath, category);
  console.log(`文件可用：fileTid=${result.fileTid}${result.reused ? '（秒传）' : ''}`);
} catch (error) { reportError(error); }
