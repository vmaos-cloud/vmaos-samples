import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
if (!args.length) throw new Error("Provide a pnpm command");
for (const demo of ["vanilla", "react", "vue", "script"]) {
  const result = spawnSync("pnpm", args, { cwd: fileURLToPath(new URL(`../${demo}/`, import.meta.url)), stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
