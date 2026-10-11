import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
// The current Vite dev server listens only on localhost, not 127.0.0.1.
// Polling 127.0.0.1 here kept preLaunchTask from becoming ready, so the Electron launch task never ran.
const viteUrl = "http://localhost:5174";
let child;

async function isViteReady() {
  try {
    const response = await fetch(viteUrl);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer() {
  while (true) {
    if (await isViteReady()) {
      break;
    }

    if (child?.exitCode != null) {
      process.exit(child.exitCode);
    }

    await sleep(300);
  }
}

child = spawn(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--filter", "@zcode/desktop", "exec", "vite", "dev"],
  {
    cwd: workspaceRoot,
    stdio: "inherit",
  },
);

void waitForServer();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (child != null && !child.killed) {
      child.kill(signal);
      return;
    }

    process.exit(0);
  });
}
if (child != null) {
  child.on("exit", (code, signal) => {
    if (signal != null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}
