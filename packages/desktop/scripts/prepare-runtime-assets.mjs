#!/usr/bin/env node

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeSearchReleasePlan } from "../../../scripts/native-search-tools-config.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";
import { isRealComputerUseProducerInstalled } from "./computer-use-producer.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const target = getTargetPlatform();
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
// The Windows Chrome import entry point is disabled. Compiling its helper by default would increase CI
// time and the release signing surface. Keep an explicit switch so the existing native implementation
// and supply-chain checks can be reused if the entry point is restored.
const shouldPrepareWindowsBrowserImportHelper =
  target.os === "win32" && process.env.ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT === "1";
// The Windows Computer Use Helper comes from the real producer; the open-source placeholder package has
// no Helper runtime, so skip preparation.
const shouldPrepareWindowsCuaHelper =
  target.os === "win32" && isRealComputerUseProducerInstalled({ desktopPackageRoot: desktopRoot });
// Provides snap targets for the CUA permission panel. macOS only; if swiftc is unavailable, the script
// skips this helper and the panel falls back to the bottom of the screen. The panel remains usable, so
// always running this on darwin does not make the build fragile.
const shouldPrepareMacosWindowBounds = target.os === "darwin";

// The desktop package bundles the local agent JavaScript bundle (prepare:agent-bundle), which runs on
// the app's Electron Node runtime. Remote cross-platform native binaries still come from
// prepare:remote-assets above.
// native-search is prepared uniformly by prepare-native-search-tools.mjs: it downloads the pinned
// digest archive when the internal dependency source is configured, or unpacks the identically named
// archive shipped with the repository otherwise; neither path needs an extra switch.
const localRuntimeScripts = [
  "prepare:agent-bundle",
  ...(shouldPrepareWindowsCuaHelper ? ["prepare:windows-cua-helper"] : []),
  ...(nativeSearchReleasePlan.enabled ? ["prepare:native-search"] : []),
  ...(shouldPrepareWindowsBrowserImportHelper ? ["prepare:browser-import-helper"] : []),
  ...(shouldPrepareMacosWindowBounds ? ["prepare:macos-window-bounds"] : []),
  // Optional (post-processing with the system model): the build script skips itself without a toolchain.
  ...(shouldPrepareMacosWindowBounds ? ["prepare:macos-apple-fm"] : []),
];

function runTimedPnpmScript(scriptName, cwd = desktopRoot) {
  const startMs = Date.now();
  console.log(`[ci][timer] prepare-runtime-assets:${scriptName} start`);
  try {
    runCommand(pnpmCommand, ["run", scriptName], {
      cwd,
      env: process.env,
    });
  } finally {
    console.log(
      `[ci][timer] prepare-runtime-assets:${scriptName} end duration_ms=${Date.now() - startMs}`,
    );
  }
}

const shouldSkipRemoteAssets = process.env.ZCODE_SKIP_REMOTE_ASSETS === "1";

if (!shouldSkipRemoteAssets) {
  // pnpm 12 does not look up missing package scripts in parent directories.
  runTimedPnpmScript("prepare:remote-assets", resolve(desktopRoot, "../.."));
} else {
  // The desktop installer in the Windows build job does not depend on mock-cdn remote assets.
  // This previously ran prepare:remote-assets unconditionally, serially downloading and packaging
  // cross-platform resources in the same job and bringing CI close to its one-hour limit. Use an
  // explicit switch to prepare remote assets only when needed.
  console.log("[prepare:runtime-assets] skip prepare:remote-assets (ZCODE_SKIP_REMOTE_ASSETS=1)");
}

for (const scriptName of localRuntimeScripts) {
  runTimedPnpmScript(scriptName);
}
