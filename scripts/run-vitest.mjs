import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const vitestCli = resolve(rootDir, "node_modules/vitest/vitest.mjs");
const nodeOptions = [process.env.NODE_OPTIONS, "--no-experimental-webstorage"]
  .filter(Boolean)
  .join(" ");
const result = spawnSync(process.execPath, [vitestCli, ...process.argv.slice(2)], {
  cwd: rootDir,
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  stdio: "inherit",
});

if (result.error) {
  console.error("Failed to start Vitest:", result.error);
  process.exitCode = 1;
} else if (result.signal) {
  console.error(`Vitest stopped by ${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
