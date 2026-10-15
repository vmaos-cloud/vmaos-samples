import { clientFromEnv, reportError } from './client.mjs';
import { waitForFile } from './probe.mjs';

try {
  const fileTid = process.argv[2];
  if (!fileTid) throw new Error('用法：npm run probe -- <fileTid>');
  const result = await waitForFile(clientFromEnv(), fileTid, { onProgress: console.log });
  console.log(`文件可用：fileTid=${result.fileTid}`);
} catch (error) { reportError(error); }
