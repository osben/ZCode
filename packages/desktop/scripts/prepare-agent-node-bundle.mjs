#!/usr/bin/env node

// Desktop packaging stages the agent JavaScript bundle (zcode.cjs) in bundled-agents/<platform>/glm
// and runs it with the app's bundled Electron Node runtime (ELECTRON_RUN_AS_NODE), replacing the
// standalone Node binary that used to ship with the app.
//
// Reasons for this approach:
// - The agent has no native NAPI addons (ripgrep uses WASM and the rest is pure JavaScript), so it can
//   run directly on Electron's Node runtime.
// - Electron 41 bundles Node 24.x, matching zcode-cli's target runtime.
// - The per-platform package shrinks from about 180 MB to 16 MB, and the same JavaScript works across
//   platforms.
// - The app-server command path does not load @zcode/tui, so the TUI does not need to be packaged here.
//
// Remote environments (SSH/WSL/Docker) do not have Electron and still use the native binaries from
// prepare:remote-assets; this change does not affect that path.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { access, cp, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { stageAgentBundle } from "./stage-agent-bundle.mjs";

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
// stage-agent-bundle.mjs resolves the destinations for zcode.cjs and .node-bundle-meta.json itself.
// After the node_repl host moved into the separate @zcode/node-repl-host package, browser-use stopped
// producing dist/mcp/server.js. The CUA assets (docs/computer-use.md and scripts/computer-use-client.mjs)
// also moved to @zcode/zcode-cua-plugin. This list was not updated, so packaging still requested those
// three files from browser-use and failed with a missing runtime. The dev path uses the corrected
// requiredDevPluginRuntimeBuilds in scripts/build-desktop-agent-cli.mjs. These parallel lists are
// maintained separately, so dev testing does not catch the packaging issue; see the authoritative
// ownership in bootstrap/official-plugin-definitions.ts.
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json now exposes recording lookup, so the desktop package cannot reuse a runtime that
  // omits the document contents.
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];
const officialPluginPackages = [
  {
    // browser-use carries only its client script and skills/docs; the node_repl MCP runtime belongs to
    // @zcode/node-repl-host (see the constant comment above).
    packageName: "@zcode/browser-use-plugin",
    relativePath: "apps/zcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/browser-use-plugin",
  },

  {
    // node_repl host: the MCP runtime shared by Browser Use and Computer Use, now in a separate package.
    // It has no listing and does not appear in the plugin marketplace, but first-run seeding in the
    // production package needs its dist runtime. Otherwise node_repl is unavailable when either bua or
    // cua is enabled.
    packageName: "@zcode/node-repl-host",
    relativePath: "apps/zcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/node-repl-host",
  },
];
// Skills bundled with the CLI (not plugins): bootstrap's resolveBundledSkillRoots searches the same
// candidate directories as official plugins for packages/bundled-skills next to zcode.cjs and reads it
// in place. If this is not staged, /workflow in the desktop package asks users to load the
// dynamic-workflows skill first, but the skill file is missing. Package it with the agent.
const bundledSkillPack = {
  relativePath: "apps/zcode-cli/packages/bundled-skills",
  requiredPaths: [
    "skills/dynamic-workflows/SKILL.md",
    "skills/dynamic-workflows/patterns.md",
    "skills/dynamic-workflows/examples.md",
  ],
  stagedPath: "packages/bundled-skills",
  topLevelPaths: ["skills"],
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

async function stageBundledSkillPack() {
  const sourceRoot = resolve(repoRoot, bundledSkillPack.relativePath);
  const targetRoot = resolve(glmDir, bundledSkillPack.stagedPath);
  await mkdir(targetRoot, { recursive: true });
  for (const entryName of bundledSkillPack.topLevelPaths) {
    const sourcePath = resolve(sourceRoot, entryName);
    await cp(sourcePath, resolve(targetRoot, entryName), {
      recursive: true,
      filter: shouldCopyOfficialPluginAsset,
    });
  }
  for (const relativePath of bundledSkillPack.requiredPaths) {
    const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
    await access(stagedAssetPath);
  }
  console.log(`[prepare:agent-bundle] staged bundled skill pack ${bundledSkillPack.stagedPath}`);
}

// When an Electron production package contains only resources/glm/zcode.cjs, there is no official
// plugin directory near the app-server process's __dirname. Seeding cannot find its source at startup,
// so users do not receive the bundled plugins automatically. Place official plugins in glm/packages/*-plugin
// as expected by bootstrap's rootCandidates so Electron Node can reuse the same filesystem seeding logic.
// Generating the browser-use runtime declaration depends on @zcode/core/dist. A clean CI checkout does
// not have that artifact, so build the CLI dependencies before the official plugins; a leftover dist on
// developer machines previously hid this ordering issue.
buildCliBundle();
buildOfficialPluginRuntimes();
stageBundle();
stageOfficialPlugins();
await stageBundledSkillPack();
