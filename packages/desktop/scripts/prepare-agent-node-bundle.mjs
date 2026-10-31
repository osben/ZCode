#!/usr/bin/env node

// Desktop packaging stages the agent JavaScript bundle (zcode.cjs) in bundled-agents/<platform>/glm
// and runs it with the app's bundled Electron Node runtime (ELECTRON_RUN_AS_NODE), replacing the
// standalone Node binary that used to ship with the app.
//
// Reasons for this approach:
// - The agent has no native NAPI addons (ripgrep uses WASM and the rest is pure JavaScript), so it can
//   run directly on Electron's Node runtime.
// - Electron 41 bundles Node 24.x; zcode-cli targets Node 26, and its bundle targets Node 22 for both Electron and SSH runtimes.
// - The per-platform package shrinks from about 180 MB to 16 MB, and the same JavaScript works across
//   platforms.
// - The app-server command path does not load @zcode/tui, so the TUI does not need to be packaged here.
//
// Remote environments (SSH/WSL/Docker) do not have Electron and still use the native binaries from
// prepare:remote-assets; this change does not affect that path.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { stageAgentBundle } from "./stage-agent-bundle.mjs";
import {
  isSharpRequiredByComputerUse,
  stageSharpIntoBundledAgents,
} from "./sharp-package-assets.mjs";
import { stageKoffiIntoBundledAgents } from "./koffi-package-assets.mjs";
import { officialPluginPackages } from "./official-plugin-packages.mjs";
import { BUNDLED_NPM_VERSION, stageBundledNpm } from "./bundled-npm-assets.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const cliBundlePath = resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const adaptersRoot = resolve(repoRoot, "apps/zcode-cli/packages/adapters");
const pnpmRunEnv = {
  ...process.env,
  // pnpm 11 runs install before executing a command in the apps/zcode-cli sub-workspace.
  // That sub-workspace cannot resolve the root workspace's @zcode/shared, which blocks plugin runtime
  // builds during Docker/web app packaging.
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};
const BROWSER_USE_PLUGIN_PACKAGE_NAME = "@zcode/browser-use-plugin";
const NODE_REPL_HOST_PACKAGE_NAME = "@zcode/node-repl-host";
const CUA_PLUGIN_PACKAGE_NAME = "@zcode/zcode-cua-plugin";

// Platform directory names combine darwin/win32/linux with x64/arm64.
// ZCODE_TARGET_OS and ZCODE_TARGET_ARCH can override them (CI injects these for cross-packaging).
function normalizePlatform(raw) {
  switch (raw) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return raw;
  }
}

function normalizeArch(raw) {
  switch (raw) {
    case "x86_64":
    case "x64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return raw;
  }
}

const platform = normalizePlatform(process.env.ZCODE_TARGET_OS || "") || process.platform;
const arch = normalizeArch(process.env.ZCODE_TARGET_ARCH || "") || process.arch;
const platformKey = `${platform}-${arch}`;

const glmDir = resolve(desktopRoot, "bundled-agents", platformKey, "glm");
// Skills bundled with the CLI (not plugins): bootstrap's resolveBundledSkillRoots searches the same
// candidate directories as official plugins for packages/bundled-skills next to zcode.cjs and reads it
// in place. If this is not staged, /workflow in the desktop package asks users to load the
// dynamic-workflows skill first while the skill is missing—exactly the failure mode that moving it out
// of the uninstallable zcode-guide plugin was meant to fix.
const bundledSkillPack = {
  relativePath: "apps/zcode-cli/packages/bundled-skills",
  requiredPaths: [
    "skills/dynamic-workflows/SKILL.md",
    "skills/dynamic-workflows/patterns.md",
    "skills/dynamic-workflows/examples.md",
  ],
  stagedPath: "packages/bundled-skills",
  topLevelPaths: ["README.md", "skills"],
};
const includedOfficialPluginTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // Electron production resources use a separate copy allowlist. Omitting agents leaves first-run
  // filesystem seeding without subagents.
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
]);
const excludedOfficialPluginAssetNames = new Set([
  ".DS_Store",
  ".venv",
  "__pycache__",
  "node_modules",
]);

function shouldCopyOfficialPluginAsset(sourcePath) {
  const name = basename(sourcePath);
  return !excludedOfficialPluginAssetNames.has(name) && !name.endsWith(".pyc");
}
const isBootstrapWithRemote = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";

function buildCliBundle() {
  console.log("[prepare:agent-bundle] building zcode-cli app-server bundle ...");
  // Reuse the repository root script (turbo build:desktop-agent --filter=@zcode/cli); a cache hit is
  // nearly instantaneous.
  runCommand(process.execPath, [resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs")], {
    cwd: repoRoot,
    env: pnpmRunEnv,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(
      `[prepare:agent-bundle] expected cli bundle missing after build: ${cliBundlePath}`,
    );
  }
}

function buildOfficialPluginRuntimes() {
  for (const plugin of officialPluginPackages) {
    if (!plugin.requiresRuntime) continue;
    console.log(`[prepare:agent-bundle] building ${plugin.packageName} runtime ...`);
    if (isBootstrapWithRemote) {
      buildOfficialPluginRuntimeForBootstrap(plugin);
      assertOfficialPluginRuntime(plugin);
      continue;
    }

    runCommand(
      "pnpm",
      ["--dir", resolve(repoRoot, "apps/zcode-cli"), "--filter", plugin.packageName, "build"],
      {
        cwd: repoRoot,
        env: pnpmRunEnv,
      },
    );
    assertOfficialPluginRuntime(plugin);
  }
}

function buildOfficialPluginRuntimeForBootstrap(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  const hasCompleteRuntime = plugin.requiredRuntimePaths.every((relativePath) =>
    existsSync(resolve(pluginRoot, ...relativePath.split("/"))),
  );
  if (plugin.packageName !== BROWSER_USE_PLUGIN_PACKAGE_NAME && hasCompleteRuntime) {
    console.log(
      `[prepare:agent-bundle] reuse existing official plugin runtime: ${plugin.packageName}`,
    );
    return;
  }

  // bootstrap:with-remote builds remote assets and the desktop agent bundle in sequence.
  // When plugin builds run through pnpm/filter, the tsc shim is prone to SIGKILL in low-memory local
  // environments. Only under the bootstrap flag, run the equivalent tsc + build-mcp steps directly
  // with the current Node process; the plugin's own build script remains unchanged.
  // browser-use's server and browser-client are a release pair. Always rebuild the server even if an
  // older server.js exists, or the desktop installer may stage an outdated server with the current
  // client (or without a client).
  runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
    cwd: pluginRoot,
    env: process.env,
  });
  runCommand(process.execPath, [plugin.runtimeBuildScript], {
    cwd: pluginRoot,
    env: process.env,
  });
}

function assertOfficialPluginRuntime(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  for (const relativePath of plugin.requiredRuntimePaths) {
    const runtimePath = resolve(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin runtime: ${runtimePath}`);
    }
  }
}

function stageBundle() {
  // The implementation lives in stage-agent-bundle.mjs. The dev path
  // (scripts/build-desktop-agent-cli.mjs) must use the same implementation or it may keep running a
  // stale agent left by the previous package build.
  stageAgentBundle({ repoRoot, platformKey });
}

function stageOfficialPlugins() {
  for (const plugin of officialPluginPackages) {
    const sourceRoot = resolve(repoRoot, plugin.relativePath);
    const manifestPath = resolve(sourceRoot, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin manifest: ${manifestPath}`);
    }

    const targetRoot = resolve(glmDir, plugin.stagedPath);
    mkdirSync(targetRoot, { recursive: true });
    for (const entryName of includedOfficialPluginTopLevelPaths) {
      const sourcePath = resolve(sourceRoot, entryName);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, resolve(targetRoot, entryName), {
        recursive: true,
        filter: shouldCopyOfficialPluginAsset,
      });
    }
    for (const relativePath of plugin.requiredSeedPaths ?? []) {
      const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
      if (!existsSync(stagedAssetPath)) {
        throw new Error(
          `[prepare:agent-bundle] missing staged official plugin seed asset: ${stagedAssetPath}`,
        );
      }
    }
    console.log(`[prepare:agent-bundle] staged official plugin ${plugin.stagedPath}`);
  }
}

function stageBundledSkillPack() {
  const sourceRoot = resolve(repoRoot, bundledSkillPack.relativePath);
  const targetRoot = resolve(glmDir, bundledSkillPack.stagedPath);
  mkdirSync(targetRoot, { recursive: true });
  for (const entryName of bundledSkillPack.topLevelPaths) {
    const sourcePath = resolve(sourceRoot, entryName);
    if (!existsSync(sourcePath)) continue;
    cpSync(sourcePath, resolve(targetRoot, entryName), {
      recursive: true,
      filter: shouldCopyOfficialPluginAsset,
    });
  }
  for (const relativePath of bundledSkillPack.requiredPaths) {
    const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
    if (!existsSync(stagedAssetPath)) {
      throw new Error(
        `[prepare:agent-bundle] missing staged bundled skill asset: ${stagedAssetPath}`,
      );
    }
  }
  console.log(`[prepare:agent-bundle] staged bundled skill pack ${bundledSkillPack.stagedPath}`);
}

// Fallback npm/npx for stdio MCP servers (runs the bundled npm on Electron Node when the user has no Node).
// The tarball is cached by sha512 under node_modules/.cache, so repeated packaging does not download it again.
async function stageBundledNpmRuntime() {
  const stagedRoot = await stageBundledNpm({
    cacheDir: resolve(repoRoot, "node_modules", ".cache", "zcode-bundled-npm"),
    glmDir,
  });
  console.log(`[prepare:agent-bundle] staged npm@${BUNDLED_NPM_VERSION} into ${stagedRoot}`);
}

function stageSharpForNodeReplPlugin() {
  if (!isSharpRequiredByComputerUse({ desktopPackageRoot: desktopRoot })) {
    console.log(
      "[prepare:agent-bundle] Computer Use package does not declare sharp, skip sharp staging",
    );
    return;
  }
  // `sharp` remains externalized—it contains native .node files that cannot be inlined, and at runtime
  // it resolves from the node_modules of **the package that contains it**. Since 2026-09-11 the
  // node_repl host bundle belongs to @zcode/node-repl-host, so sharp must be staged into the host
  // directory; otherwise `import sharp` inside the host cannot resolve in the packaged app.
  // The native dependencies of CUA screenshot / get_app_state still go into the CUA plugin's own
  // node_modules; the Browser Use directory keeps a copy for compatibility. All three stagings live in
  // plugin subdirectories so electron-builder does not filter node_modules at the extraResources root.
  const pluginStagedDirs = [
    [NODE_REPL_HOST_PACKAGE_NAME, resolve(glmDir, "packages", "node-repl-host")],
    [BROWSER_USE_PLUGIN_PACKAGE_NAME, resolve(glmDir, "packages", "browser-use-plugin")],
    [CUA_PLUGIN_PACKAGE_NAME, resolve(glmDir, "packages", "zcode-cua-plugin")],
  ];
  for (const [packageName, pluginStagedDir] of pluginStagedDirs) {
    if (!existsSync(resolve(pluginStagedDir, ".zcode-plugin", "plugin.json"))) {
      console.log(`[prepare:agent-bundle] ${packageName} not staged, skip sharp staging`);
      continue;
    }
    stageSharpIntoBundledAgents({
      desktopPackageRoot: desktopRoot,
      glmDir: pluginStagedDir,
      targetPlatform: { os: platform, arch },
    });
    console.log(
      `[prepare:agent-bundle] staged sharp into ${resolve(pluginStagedDir, "node_modules")} (${platform}-${arch})`,
    );
  }
}

function stageKoffiForCuaPlugin() {
  const cuaPluginStagedDir = resolve(glmDir, "packages", "zcode-cua-plugin");
  if (!existsSync(resolve(cuaPluginStagedDir, ".zcode-plugin", "plugin.json"))) {
    console.log("[prepare:agent-bundle] zcode-cua-plugin not staged, skip koffi staging");
    return;
  }
  stageKoffiIntoBundledAgents({
    koffiPackageRoot: adaptersRoot,
    glmDir: cuaPluginStagedDir,
    targetPlatform: { os: platform, arch },
  });
  console.log(
    `[prepare:agent-bundle] staged koffi into ${resolve(cuaPluginStagedDir, "node_modules")} (${platform}-${arch})`,
  );
}

// Fix rationale: when an Electron production package contains only resources/glm/zcode.cjs, there is
// no official plugin directory near the app-server process's __dirname. Seeding cannot find its source
// at startup, so users do not receive the bundled plugins automatically. Place official plugins in
// glm/packages/*-plugin as expected by bootstrap's rootCandidates so Electron Node can reuse the same
// filesystem seeding logic.
// Generating the browser-use runtime declaration depends on @zcode/core/dist. A clean CI checkout does
// not have that artifact, so build the CLI dependencies before the official plugins; a leftover dist on
// developer machines previously hid this ordering issue.
buildCliBundle();
buildOfficialPluginRuntimes();
stageBundle();
stageOfficialPlugins();
stageBundledSkillPack();
await stageBundledNpmRuntime();
stageKoffiForCuaPlugin();
stageSharpForNodeReplPlugin();
