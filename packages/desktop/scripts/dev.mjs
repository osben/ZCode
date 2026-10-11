import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { prepareDevElectronAppBundle } from "./devElectronAppBundle.mjs";

const root = resolve(import.meta.dirname, "..");
const mainBundle = resolve(root, "out/main/index.js");
const buildReadyMarkers = [
  { name: "main", path: resolve(root, "out/.main-build-ready") },
  { name: "host", path: resolve(root, "out/.host-build-ready") },
  { name: "preload", path: resolve(root, "out/.preload-build-ready") },
];
const waitLogIntervalMs = 3_000;
const require = createRequire(import.meta.url);

function resolveLocalElectronBinary() {
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackageRoot = resolve(electronPackageJsonPath, "..");

  // This previously called spawn("electron") on Windows and depended on PATH containing the local binary.
  // With pnpm and PowerShell, the child process often receives node but cannot find the electron command,
  // so the dev script fails with ENOENT and developers have to start each process in a separate terminal.
  // Resolve the Electron binary from the current project to avoid PATH differences across shells/platforms.
  if (process.platform === "win32") {
    return resolve(electronPackageRoot, "dist", "electron.exe");
  }

  if (process.platform === "darwin") {
    return resolve(electronPackageRoot, "dist", "Electron.app", "Contents", "MacOS", "Electron");
  }

  return resolve(electronPackageRoot, "dist", "electron");
}

function probeHttpUrl(url) {
  return new Promise((resolveProbe) => {
    const req = request(url, { method: "HEAD", timeout: 1_000 }, (res) => {
      res.resume();
      resolveProbe({ ok: true });
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => {
      resolveProbe({
        ok: false,
        reason: `${error.code ? `${error.code} ` : ""}${error.message}`,
      });
    });
    req.end();
  });
}

// Wait for both Vite dev server and main bundle to be ready
async function waitForReady() {
  // Desktop tsup runs three independent watch builds: main, host, and preload.
  // Previously, any one successful build could release Electron while the other outputs were unstable,
  // causing it to load partially written ESM/CJS files. Wait for each build's ready marker and confirm
  // that the main bundle exists before starting Electron.
  let lastBuildWaitLogAt = 0;
  while (true) {
    const missingMarkers = buildReadyMarkers
      .filter((marker) => !existsSync(marker.path))
      .map((marker) => marker.name);
    const hasMainBundle = existsSync(mainBundle);
    if (missingMarkers.length === 0 && hasMainBundle) {
      break;
    }
    const now = Date.now();
    if (now - lastBuildWaitLogAt >= waitLogIntervalMs) {
      // When dev startup stalls while waiting, the terminal often ends on a tsup watch log, leaving it
      // unclear which condition is missing. Periodically print the wait status so missing markers or the
      // main bundle can be identified from the logs.
      console.log(
        `[dev] Waiting for build artifacts... missingMarkers=${
          missingMarkers.join(",") || "none"
        } mainBundle=${hasMainBundle ? "ready" : "missing"}`,
      );
      lastBuildWaitLogAt = now;
    }
    await sleep(300);
  }

  // Wait for Vite dev server
  // Depending on local DNS/IPv6 configuration, Vite may listen only on localhost/::1 or 127.0.0.1.
  // Poll multiple loopback addresses so Electron does not wait forever when the dev script and Vite use
  // different listen addresses.
  const viteUrls = ["http://localhost:5174", "http://127.0.0.1:5174", "http://[::1]:5174"];
  let lastViteWaitLogAt = 0;
  while (true) {
    const failures = [];
    for (const viteUrl of viteUrls) {
      const result = await probeHttpUrl(viteUrl);
      if (result.ok) {
        return viteUrl;
      }
      failures.push(`${viteUrl}: ${result.reason}`);
    }
    const now = Date.now();
    if (now - lastViteWaitLogAt >= waitLogIntervalMs) {
      console.log(`[dev] Waiting for Vite dev server... ${failures.join(" | ")}`);
      lastViteWaitLogAt = now;
    }
    await sleep(300);
  }
}

const rendererUrl = await waitForReady();
console.log("[dev] Starting Electron...");

const electronBinary = resolveLocalElectronBinary();
let electronCommand = existsSync(electronBinary) ? electronBinary : "electron";

if (process.platform === "darwin" && existsSync(electronBinary)) {
  // Raw Electron launched from the command line on macOS has no CFBundleURLTypes, so LaunchServices
  // routes zcode:// links to the default Electron shell, which has no project entry point. Add the
  // product Info.plist to the local launch copy so the production Share page can route links to a
  // running Dev instance without knowing about Dev.
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackage = JSON.parse(await readFile(electronPackageJsonPath, "utf8"));
  const electronAppPath = resolve(electronBinary, "../../..");
  const devBundle = await prepareDevElectronAppBundle({
    electronAppPath,
    runtimeRoot: resolve(root, "../../.zcode-runtime/desktop-dev"),
    electronVersion: electronPackage.version,
    arch: process.arch,
  });
  electronCommand = devBundle.executablePath;
  console.log(`[dev] Prepared macOS ZCode Dev bundle: ${devBundle.appPath}`);
}

const electron = spawn(electronCommand, ["."], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl },
  windowsHide: true,
  detached: process.platform !== "win32",
});

let electronClosed = false;
let shuttingDown = false;
let forceKillTimer;
let hardExitTimer;

function signalElectronTree(signal) {
  if (electronClosed || !electron.pid) {
    return;
  }

  if (process.platform === "win32") {
    electron.kill(signal);
    return;
  }

  try {
    process.kill(-electron.pid, signal);
  } catch {
    electron.kill(signal);
  }
}

function forceKillElectronTree() {
  if (electronClosed || !electron.pid) {
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(electron.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  signalElectronTree("SIGKILL");
}

function shutdownFromSignal(signal) {
  if (shuttingDown) {
    forceKillElectronTree();
    return;
  }

  shuttingDown = true;
  console.log(`[dev] Received ${signal}, stopping Electron...`);
  // After concurrently receives Ctrl+C, it only terminates the node scripts/dev.mjs wrapper process.
  // Electron on macOS does not reliably respond to SIGINT/SIGTERM and was previously orphaned under
  // ppid=1, continuing to hold ports and logs. Put Electron in its own process group so the dev script
  // can clean it up, force-killing the full development process tree after a timeout.
  signalElectronTree("SIGTERM");
  forceKillTimer = setTimeout(forceKillElectronTree, 1_500);
  hardExitTimer = setTimeout(() => process.exit(0), 5_000);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => shutdownFromSignal(signal));
}

electron.on("error", (error) => {
  console.error("[dev] Failed to start Electron:", error);
  process.exit(1);
});

electron.on("close", (code, signal) => {
  electronClosed = true;
  clearTimeout(forceKillTimer);
  clearTimeout(hardExitTimer);
  if (shuttingDown) {
    process.exit(0);
  }
  process.exit(code ?? (signal ? 1 : 0));
});
