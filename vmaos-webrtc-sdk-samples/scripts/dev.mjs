import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (!child.pid) continue;
    try { process.kill(-child.pid, "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
for (const demo of ["vanilla", "react", "vue", "script"]) {
  const child = spawn("npm", ["run", "dev"], {
    cwd: fileURLToPath(new URL(`../${demo}/`, import.meta.url)), stdio: "inherit",
    detached: true,
  });
  children.push(child);
  child.on("error", error => { console.error(`${demo}: ${error.message}`); stop(1); });
  child.on("exit", code => { if (!stopping) stop(code ?? 1); });
}
// npm starts Vite as a descendant; terminate each entire process group.
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
