import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const dist = dirname(fileURLToPath(import.meta.resolve("@vmaos/webrtc-sdk")));
await mkdir(new URL("./public/sdk/", import.meta.url), { recursive: true });
await copyFile(join(dist, "browser.iife.js"), new URL("./public/sdk/browser.iife.js", import.meta.url));
