#!/usr/bin/env node
/* eslint-disable max-lines */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  LEGACY_REMOTE_RIPGREP_VERSION,
  NATIVE_SEARCH_PREBUILT_RELEASES,
  resolveNativeSearchArtifactSource,
  resolveNativeSearchPrebuiltRelease,
} from "./native-search-tools-config.mjs";
import { resolveRemoteNativeSearchPrebuiltPlan } from "./remote-native-search-tools-config.mjs";
import { prepareNativeSearchTools } from "./prepare-native-search-tools.mjs";
import {
  stageNativeSearchNotices,
  stageNodeNotices,
  stageThirdPartyNotices,
} from "./third-party-notices.mjs";
import {
  computeDeterministicSourceSha256 as computeComponentSourceSha256,
  packSourceAsDeterministicTarGzip as packComponentSourceAsArchive,
} from "./deterministic-tar-archive.mjs";
import { runCommand } from "./spawn-command.mjs";

export { computeComponentSourceSha256, packComponentSourceAsArchive };

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const desktopDir = join(rootDir, "packages/desktop");
const mockCdnDir = join(desktopDir, "mock-cdn");
const version = require(join(rootDir, "package.json")).version;
const ZCODE_AGENT_RUNTIME = {
  glm: {
    version: readZCodeAgentRuntimeVersion(),
  },
};
const releaseDir = join(mockCdnDir, "releases", version);
const nodeVersion = "v22.16.0";
const componentSchemaVersion = 1;
const remotePlatforms = ["linux-arm64", "linux-x64", "darwin-arm64", "darwin-x64"];
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const isBootstrapWithRemote = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";

/**
 * Node dist download source. Defaults to a mirror in China and can be overridden with `ZCODE_NODE_DIST_MIRROR`
 * (the same convention as the CI variable in `.gitlab/ci/00-workflow.yml` and `scripts/cua-helper-sea-base.mjs`).
 *
 * This was originally hard-coded to `https://nodejs.org/dist`, which macOS
 * runners could not reach: all three attempts ended with `UND_ERR_CONNECT_TIMEOUT` (10s). Worse, the error text in this file
 * told users to "check the Node.js mirror address," even though no such setting existed.
 *
 * Why it was not exposed before: `mock-cdn` persists across jobs through a GIT_CLEAN_FLAGS exclusion, while
 * `build:remote:assets` runs `rm -rf` on every release directory except its own $VERSION each time.
 * Different version directories therefore evict each other's persisted artifacts; an evicted version must download from the origin again.
 * Normally the path logs `[skip] already exists`, so this network path had not been exercised for a long time.
 */
export const DEFAULT_NODE_DIST_BASE = "https://cdn.npmmirror.com/binaries/node";

export function nodeDistBase(env = process.env) {
  const mirror = env.ZCODE_NODE_DIST_MIRROR?.trim();
  return (mirror || DEFAULT_NODE_DIST_BASE).replace(/\/+$/u, "");
}
const BROWSER_USE_PLUGIN_PACKAGE_NAME = "@zcode/browser-use-plugin";
// After the node_repl host moved to the standalone @zcode/node-repl-host package, browser-use
// stopped producing dist/mcp/server.js, and CUA assets moved to @zcode/zcode-cua-plugin. This is the **third** parallel manifest
// (the others are production packaging in packages/desktop/scripts/prepare-agent-node-bundle.mjs and dev builds in
// scripts/build-desktop-agent-cli.mjs). Only the dev manifest was updated at the time, causing both
// build:macos:arm64 and build:remote:assets to fail with "missing runtime".
// See bootstrap/official-plugin-definitions.ts for the authoritative ownership.
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // Remote prebuilds must use the same screen-recording documentation completeness contract as the desktop seed.
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];
const remoteOfficialPluginPackages = [
  {
    packageName: "@zcode/android-emulator-plugin",
    relativePath: "apps/zcode-cli/packages/android-emulator-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build-mcp.mjs",
    stagedPath: "packages/android-emulator-plugin",
  },
  {
    packageName: "@zcode/documents-plugin",
    relativePath: "apps/zcode-cli/packages/documents-plugin",
    requiresRuntime: false,
    stagedPath: "packages/documents-plugin",
  },
  {
    packageName: "@zcode/image-search-plugin",
    relativePath: "apps/zcode-cli/packages/image-search-plugin",
    requiresRuntime: false,
    stagedPath: "packages/image-search-plugin",
  },
  {
    packageName: "@zcode/pdf-plugin",
    relativePath: "apps/zcode-cli/packages/pdf-plugin",
    requiresRuntime: false,
    stagedPath: "packages/pdf-plugin",
  },
  {
    packageName: "@zcode/presentations-plugin",
    relativePath: "apps/zcode-cli/packages/presentations-plugin",
    requiresRuntime: false,
    stagedPath: "packages/presentations-plugin",
  },
  {
    packageName: "@zcode/spreadsheets-plugin",
    relativePath: "apps/zcode-cli/packages/spreadsheets-plugin",
    requiresRuntime: false,
    stagedPath: "packages/spreadsheets-plugin",
  },
  {
    packageName: "@zcode/visualize-plugin",
    relativePath: "apps/zcode-cli/packages/visualize-plugin",
    requiresRuntime: false,
    requiredSeedPaths: [
      "skills/visualize/SKILL.md",
      "skills/visualize/references/api.md",
      "skills/visualize/references/styles.md",
      "skills/visualize/tweak.md",
      "skills/visualize/LICENSE.md",
      "skills/visualize/scripts/render.py",
      "skills/visualize/assets/visualize.css",
      "skills/visualize/assets/visualize.html",
      "skills/visualize/assets/calendar.js",
      "skills/visualize/assets/runtime-manifest.json",
      "skills/visualize/scripts/vendor.py",
      "skills/visualize/assets/vendor/manifest.json",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
      "skills/visualize/assets/vendor/lucide-1.17.0.js",
      "skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
      "skills/visualize/widgets/calendar.md",
      "skills/visualize/examples/calendar.html",
      "skills/visualize/assets/standalone-host-bridge.js",
      "skills/visualize/assets/standalone-shell.js",
    ],
    requiredRuntimePaths: [],
    stagedPath: "packages/visualize-plugin",
  },
  {
    // The remote shared-host must deploy the node_repl runtime, or it will have the skill but no mcp__node_repl__js.
    // This runtime is now provided by @zcode/node-repl-host (see the next entry); browser-use carries only its own
    // client script and skill/docs.
    packageName: "@zcode/browser-use-plugin",
    relativePath: "apps/zcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/browser-use-plugin",
  },
  {
    // node_repl host: the MCP runtime shared by Browser Use and Computer Use. Without it, the remote shared-host
    // has no mcp__node_repl__js and both BUA and CUA fail to connect.
    packageName: "@zcode/node-repl-host",
    relativePath: "apps/zcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/node-repl-host",
  },
  {
    // Remote CUA deploys only the SDK, skills, and docs; the runtime must remain attached to the desktop shared host,
    // and must not install or start a native Helper in the remote workspace.
    packageName: "@zcode/zcode-cua-plugin",
    relativePath: "apps/zcode-cli/packages/zcode-cua-plugin",
    requiresRuntime: false,
    stagedPath: "packages/zcode-cua-plugin",
  },
  {
    packageName: "@zcode/ios-simulator-plugin",
    relativePath: "apps/zcode-cli/packages/ios-simulator-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build-mcp.mjs",
    stagedPath: "packages/ios-simulator-plugin",
  },
  {
    packageName: "@zcode/restore-legacy-sessions-plugin",
    relativePath: "apps/zcode-cli/packages/restore-legacy-sessions-plugin",
    requiresRuntime: false,
    stagedPath: "packages/restore-legacy-sessions-plugin",
  },
  {
    packageName: "@zcode/skill-creator-plugin",
    relativePath: "apps/zcode-cli/packages/skill-creator-plugin",
    requiresRuntime: false,
    stagedPath: "packages/skill-creator-plugin",
  },
  {
    packageName: "@zcode/plugin-creator-plugin",
    relativePath: "apps/zcode-cli/packages/plugin-creator-plugin",
    requiresRuntime: false,
    stagedPath: "packages/plugin-creator-plugin",
  },
  {
    packageName: "@zcode/zcode-guide-plugin",
    relativePath: "apps/zcode-cli/packages/zcode-guide-plugin",
    requiresRuntime: false,
    stagedPath: "packages/zcode-guide-plugin",
  },
];
// Skills bundled with the CLI (not plugins): the remote Agent bootstrap searches the same candidate directories as official plugins,
// finds packages/bundled-skills beside zcode.cjs, and reads them in place. This manifest matches packages/desktop/scripts/prepare-agent-node-bundle.mjs.
const remoteBundledSkillPack = {
  relativePath: "apps/zcode-cli/packages/bundled-skills",
  requiredPaths: [
    "skills/dynamic-workflows/SKILL.md",
    "skills/dynamic-workflows/patterns.md",
    "skills/dynamic-workflows/examples.md",
  ],
  stagedPath: "packages/bundled-skills",
  topLevelPaths: ["README.md", "skills"],
};
const remoteOfficialPluginTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // Production remote prebuilds have a separate top-level allowlist; omitting agents permanently drops subagents before upload.
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
const remoteOfficialPluginRequiredPaths = [
  "packages/android-emulator-plugin/.zcode-plugin/plugin.json",
  "packages/browser-use-plugin/.zcode-plugin/plugin.json",
  "packages/zcode-cua-plugin/.zcode-plugin/plugin.json",
  "packages/image-search-plugin/.zcode-plugin/plugin.json",
  "packages/image-search-plugin/.mcp.json",
  "packages/documents-plugin/.zcode-plugin/plugin.json",
  "packages/pdf-plugin/.zcode-plugin/plugin.json",
  "packages/presentations-plugin/.zcode-plugin/plugin.json",
  "packages/spreadsheets-plugin/.zcode-plugin/plugin.json",
  "packages/ios-simulator-plugin/.zcode-plugin/plugin.json",
  "packages/restore-legacy-sessions-plugin/.zcode-plugin/plugin.json",
  "packages/skill-creator-plugin/.zcode-plugin/plugin.json",
  "packages/plugin-creator-plugin/.zcode-plugin/plugin.json",
  "packages/plugin-creator-plugin/skills/plugin-creator/SKILL.md",
  "packages/zcode-guide-plugin/.zcode-plugin/plugin.json",
  // Fix rationale: document skill content and visual-judge are required seed assets; validating only the manifest is insufficient.
  "packages/documents-plugin/agents/visual-judge.md",
  "packages/documents-plugin/skills/docx/SKILL.md",
  "packages/pdf-plugin/agents/visual-judge.md",
  "packages/pdf-plugin/skills/pdf/SKILL.md",
  "packages/presentations-plugin/agents/visual-judge.md",
  "packages/presentations-plugin/skills/pptx/SKILL.md",
  "packages/spreadsheets-plugin/agents/visual-judge.md",
  "packages/spreadsheets-plugin/skills/xlsx/SKILL.md",
  "packages/visualize-plugin/.zcode-plugin/plugin.json",
  "packages/visualize-plugin/skills/visualize/SKILL.md",
];

function readZCodeAgentRuntimeVersion() {
  const runtimeSourcePath = join(rootDir, "packages/shared/src/zcode-agent-runtime.ts");
  const runtimeSource = readFileSync(runtimeSourcePath, "utf8");
  const match = runtimeSource.match(/version:\s*["']([^"']+)["']/);
  if (!match?.[1]) {
    throw new Error("Unable to parse ZCode Agent runtime version");
  }
  return match[1];
}

async function download(url, destinationPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} (${url})`);
  }
  if (!response.body) {
    throw new Error(`Download failed: empty response body (${url})`);
  }

  // The original response.pipe(file) + finish listener could neither resolve nor reject after a network interruption,
  // eventually triggering an unsettled top-level await. Use pipeline so failures are observable and can exit nonzero.
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(destinationPath, { flags: "w" }),
  );
}

async function downloadWithRetry(url, destinationPath, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await download(url, destinationPath);
      return;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      console.warn(`  [warn] download attempt ${attempt}/${maxAttempts} failed: ${url}`);
      console.warn(`  [warn] retry reason: ${String(error)}`);
    }
  }
}

async function extractArchiveMember(url, destinationDir, archiveMember) {
  const tempDir = mkdtempSync(join(tmpdir(), "zcode-node-dist-"));
  const archivePath = join(tempDir, "node.tar.xz");

  try {
    await downloadWithRetry(url, archivePath);
    // Bug fix: on Windows, GNU tar (Git Bash) treats the drive-letter colon (C:) in an absolute path (C:\...) as
    // a remote host and reports "Cannot connect to C". Use cwd plus a relative archive name to avoid a colon in the -f argument.
    // MSYS tar argument conversion can also corrupt backslash paths (\3 is treated as an escape); convert -C targets to forward slashes.
    // This does not affect bsdtar or Linux/macOS CI.
    runCommand(
      "tar",
      [
        "-xJf",
        "node.tar.xz",
        "--strip-components=2",
        "-C",
        destinationDir.replaceAll("\\", "/"),
        archiveMember,
      ],
      {
        cwd: tempDir,
      },
    );
  } finally {
    // Bug fix: on Windows, antivirus/indexing or a still-running xz child process may briefly hold a handle to a newly written archive.
    // An immediate rmSync can fail with EPERM, and an exception from finally would hide the actual download/extraction error.
    // Retry deletion and warn on failure so the original error can propagate.
    try {
      rmSync(tempDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.warn(`  [warn] 清理临时目录失败（可忽略）: ${tempDir}`);
      console.warn(`  [warn] ${String(error)}`);
    }
  }
}

function resolveDedicatedPackageRoot(packageName, fromDir) {
  const packageEntryPath = require.resolve(packageName, { paths: [fromDir] });
  let currentDir = dirname(packageEntryPath);

  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = require(packageJsonPath);
      if (packageJson?.name === packageName) {
        return currentDir;
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  throw new Error(
    `Unable to resolve package root for ${packageName} from entry ${packageEntryPath}`,
  );
}

function resolveNodePtyPackageName(platformKey) {
  return `@lydell/node-pty-${platformKey}`;
}

function resolveNodePtyPackageVersion(platformKey) {
  const packageName = resolveNodePtyPackageName(platformKey);
  const packageRoot = resolveDedicatedPackageRoot(packageName, join(rootDir, "packages/server"));
  const packageJson = require(join(packageRoot, "package.json"));
  if (typeof packageJson?.version !== "string" || !packageJson.version.trim()) {
    throw new Error(`Unable to resolve version for ${packageName}`);
  }
  return packageJson.version.trim();
}

async function prepareNodeBinaries() {
  for (const platformKey of remotePlatforms) {
    const nodeDir = join(releaseDir, "node", platformKey);
    const nodeBinaryPath = join(nodeDir, "node");
    // The remote Node component is downloaded separately; when reusing the cache, refresh the license text for the exact Node version too.
    await stageNodeNotices(nodeDir, nodeVersion, rootDir);

    if (existsSync(nodeBinaryPath)) {
      console.log(`  [skip] mock-cdn node/${platformKey} already exists`);
      continue;
    }

    mkdirSync(nodeDir, { recursive: true });
    const archiveName = `node-${nodeVersion}-${platformKey}.tar.xz`;
    const url = `${nodeDistBase()}/${nodeVersion}/${archiveName}`;

    console.log(`  [download] ${url}`);

    try {
      await extractArchiveMember(url, nodeDir, `node-${nodeVersion}-${platformKey}/bin/node`);
      chmodSync(nodeBinaryPath, 0o755);
      console.log(`  [ok] mock-cdn node/${platformKey}`);
    } catch (error) {
      console.error(`  [error] 下载或解压失败: ${url}`);
      console.error(
        `  [error] 请检查 CI runner 的外网访问、tar/xz 依赖，或用 ZCODE_NODE_DIST_MIRROR 覆盖下载源（当前 ${nodeDistBase()}）`,
      );
      throw error;
    }
  }
}

function buildServerBundle() {
  console.log("==> Building server bundle");

  try {
    if (isBootstrapWithRemote) {
      runBootstrapServerRemoteBuild();
      return;
    }

    // On Windows CI, spawnSync("pnpm.cmd") directly throws EINVAL before starting the child process.
    // Use the cross-platform launcher so .cmd runs through shell/cmd.exe and remote resource preparation does not stop early.
    runCommand(pnpmCommand, ["run", "build:remote"], {
      cwd: join(rootDir, "packages/server"),
    });
  } catch (error) {
    console.error(
      "  [error] packages/server build:remote 失败，请优先检查 CI 日志中的 TypeScript / esbuild 输出",
    );
    throw error;
  }
}

function runBootstrapServerRemoteBuild() {
  // bootstrap:with-remote runs install, remote assets, and the workspace build in sequence locally.
  // Do not reuse an existing zcode-server.cjs here: package versions often stay the same during development, and a stale bundle missing new RPCs
  // would be deployed to the SSH remote. Keep only the low-memory optimization of launching tsx directly with the current Node; do not change CI's build:remote.
  runCommand(
    process.execPath,
    [join(rootDir, "node_modules/tsx/dist/cli.mjs"), "build-remote.ts"],
    {
      cwd: join(rootDir, "packages/server"),
      env: process.env,
    },
  );
}

function copyServerBundle() {
  const serverDir = join(releaseDir, "server");
  mkdirSync(serverDir, { recursive: true });
  copyFileSync(
    join(rootDir, "packages/server/dist/remote/zcode-server.cjs"),
    join(serverDir, "zcode-server.cjs"),
  );
  console.log("  [ok] mock-cdn server/zcode-server.cjs");
}

function copyNodePtyPrebuilds() {
  console.log("==> Copying node-pty prebuilds from @lydell/node-pty");

  for (const platformKey of remotePlatforms) {
    const ptyDir = join(releaseDir, "node-pty", platformKey);
    const targetBinaryPath = join(ptyDir, "pty.node");
    const targetSpawnHelperPath = join(ptyDir, "spawn-helper");
    const requiresSpawnHelper = platformKey.startsWith("darwin-");

    if (
      existsSync(targetBinaryPath) &&
      (!requiresSpawnHelper || existsSync(targetSpawnHelperPath))
    ) {
      console.log(`  [skip] mock-cdn node-pty/${platformKey} already exists`);
      continue;
    }

    mkdirSync(ptyDir, { recursive: true });

    const packageName = resolveNodePtyPackageName(platformKey);
    let packageRoot;
    try {
      packageRoot = resolveDedicatedPackageRoot(packageName, join(rootDir, "packages/server"));
    } catch {
      console.log(`  [warn] ${packageName} not found, run: pnpm install`);
      continue;
    }

    const sourcePrebuildDir = join(packageRoot, "prebuilds", platformKey);
    const sourceBinaryPath = join(sourcePrebuildDir, "pty.node");
    if (!existsSync(sourceBinaryPath)) {
      console.log(`  [warn] binary not found at ${sourceBinaryPath}`);
      continue;
    }

    // On Darwin, node-pty depends on spawn-helper in addition to pty.node.
    // mock-cdn previously copied only pty.node, causing posix_spawn ENOENT during terminal.create after remote deployment.
    // Copy spawn-helper into the remote assets directory as well so remote terminals have the required binary at startup.
    copyFileSync(sourceBinaryPath, targetBinaryPath);
    if (requiresSpawnHelper) {
      const sourceSpawnHelperPath = join(sourcePrebuildDir, "spawn-helper");
      if (!existsSync(sourceSpawnHelperPath)) {
        console.log(`  [warn] spawn-helper not found at ${sourceSpawnHelperPath}`);
        continue;
      }
      copyFileSync(sourceSpawnHelperPath, targetSpawnHelperPath);
      chmodSync(targetSpawnHelperPath, 0o755);
    }
    console.log(`  [ok] mock-cdn node-pty/${platformKey} (copied from ${packageName})`);
  }
}

function buildRemoteOfficialPluginRuntimes() {
  for (const plugin of remoteOfficialPluginPackages) {
    if (!plugin.requiresRuntime) continue;
    console.log(`==> Building remote official plugin runtime: ${plugin.packageName}`);
    if (isBootstrapWithRemote) {
      buildRemoteOfficialPluginRuntimeForBootstrap(plugin);
      assertRemoteOfficialPluginRuntime(plugin);
      continue;
    }

    runCommand(
      pnpmCommand,
      ["--dir", join(rootDir, "apps/zcode-cli"), "--filter", plugin.packageName, "build"],
      {
        cwd: rootDir,
        env: process.env,
      },
    );
    assertRemoteOfficialPluginRuntime(plugin);
  }
}

function buildRemoteOfficialPluginRuntimeForBootstrap(plugin) {
  const pluginRoot = join(rootDir, plugin.relativePath);
  const hasCompleteRuntime = plugin.requiredRuntimePaths.every((relativePath) =>
    existsSync(join(pluginRoot, ...relativePath.split("/"))),
  );
  if (plugin.packageName !== BROWSER_USE_PLUGIN_PACKAGE_NAME && hasCompleteRuntime) {
    console.log(`  [skip] reuse existing remote official plugin runtime: ${plugin.packageName}`);
    return;
  }

  // bootstrap:with-remote prepares remote assets and the workspace build serially.
  // Official plugin runtimes are needed only while staging assets; run the equivalent build with the current Node to avoid nesting pnpm/tsc shims.
  // browser-use's MCP server and browser-client must come from the same build. Reusing based only on an old server.js
  // could mix a stale or missing client into remote assets, so always rebuild this plugin in bootstrap mode.
  runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
    cwd: pluginRoot,
    env: process.env,
  });
  runCommand(process.execPath, [plugin.runtimeBuildScript], {
    cwd: pluginRoot,
    env: process.env,
  });
}

function assertRemoteOfficialPluginRuntime(plugin) {
  const pluginRoot = join(rootDir, plugin.relativePath);
  for (const relativePath of plugin.requiredRuntimePaths) {
    const runtimePath = join(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      throw new Error(`[prepare-prebuilds] missing remote official plugin runtime: ${runtimePath}`);
    }
  }
}

function stageRemoteOfficialPlugins(glmDir) {
  for (const plugin of remoteOfficialPluginPackages) {
    const sourceRoot = join(rootDir, plugin.relativePath);
    const manifestPath = join(sourceRoot, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(
        `[prepare-prebuilds] missing remote official plugin manifest: ${manifestPath}`,
      );
    }

    const targetRoot = join(glmDir, ...plugin.stagedPath.split("/"));
    mkdirSync(targetRoot, { recursive: true });
    for (const entryName of remoteOfficialPluginTopLevelPaths) {
      const sourcePath = join(sourceRoot, entryName);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, join(targetRoot, entryName), {
        recursive: true,
        filter: shouldCopyOfficialPluginAsset,
      });
    }
    for (const relativePath of remoteOfficialPluginRequiredPaths) {
      if (!relativePath.startsWith(`${plugin.stagedPath}/`)) continue;
      const stagedAssetPath = join(glmDir, ...relativePath.split("/"));
      if (!existsSync(stagedAssetPath)) {
        throw new Error(
          `[prepare-prebuilds] missing staged remote official plugin seed asset: ${stagedAssetPath}`,
        );
      }
    }
    console.log(`  [ok] mock-cdn glm official plugin ${plugin.stagedPath}`);
  }
}

function stageRemoteBundledSkillPack(glmDir) {
  const sourceRoot = join(rootDir, remoteBundledSkillPack.relativePath);
  const targetRoot = join(glmDir, ...remoteBundledSkillPack.stagedPath.split("/"));
  mkdirSync(targetRoot, { recursive: true });
  for (const entryName of remoteBundledSkillPack.topLevelPaths) {
    const sourcePath = join(sourceRoot, entryName);
    if (!existsSync(sourcePath)) continue;
    cpSync(sourcePath, join(targetRoot, entryName), {
      recursive: true,
      filter: shouldCopyOfficialPluginAsset,
    });
  }
  for (const relativePath of remoteBundledSkillPack.requiredPaths) {
    const stagedAssetPath = join(targetRoot, ...relativePath.split("/"));
    if (!existsSync(stagedAssetPath)) {
      throw new Error(
        `[prepare-prebuilds] missing staged remote bundled skill asset: ${stagedAssetPath}`,
      );
    }
  }
  console.log(`  [ok] mock-cdn glm bundled skill pack ${remoteBundledSkillPack.stagedPath}`);
}

// Remote agents now run the compiled zcode.cjs rather than platform-specific native binaries:
// remote deployments already have a separate Node for zcode-server.cjs, which the Agent can reuse to execute zcode.cjs.
// There is no need to prepare a SEA binary with embedded Node for every platform. zcode.cjs is identical across platforms;
// each platform only places it in its own glm/<platform> component directory, preserving the existing manifest structure.
function stageRemoteAgentBundles() {
  console.log("==> Building zcode-cli bundle for remote agents");
  // Reuse the same build script as desktop (turbo build:desktop-agent --filter=@zcode/cli); cache hits are nearly instantaneous.
  runCommand(process.execPath, [join(rootDir, "scripts/build-desktop-agent-cli.mjs")], {
    cwd: rootDir,
    env: process.env,
  });
  // browser-use runtime's tsc depends on @zcode/core/dist. Build the Agent CLI dependencies before remote assets too,
  // so a clean CI checkout does not expose a TS2307 hidden by a development machine's cache.
  buildRemoteOfficialPluginRuntimes();
  const cliBundlePath = join(rootDir, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[prepare-prebuilds] expected cli bundle missing: ${cliBundlePath}`);
  }

  for (const platformKey of remotePlatforms) {
    const glmDir = join(releaseDir, "glm", platformKey);
    // Clean rebuild: the glm component now contains only zcode.cjs. Remove leftover native binaries and old metadata
    // so they are not included in the component tar and inflate remote assets.
    rmSync(glmDir, { recursive: true, force: true });
    mkdirSync(glmDir, { recursive: true });
    copyFileSync(cliBundlePath, join(glmDir, "zcode.cjs"));
    stageRemoteOfficialPlugins(glmDir);
    stageRemoteBundledSkillPack(glmDir);
    console.log(`  [ok] mock-cdn glm/${platformKey}/zcode.cjs`);
  }
}

function downloadRemoteNativeSearchToolsFromIntranet(platformKey, targetOs, targetArch) {
  try {
    if (targetOs === "linux") {
      // Fix rationale: Linux remote previously used the legacy single-tool rg13 download path, leaving WSL Bash
      // unable to find the bundled bfs/ugrep. Reuse the release plan already verified by desktop/SEA here,
      // preparing glibc 2.28 bfs/ugrep -2 and Microsoft musl rg14 together.
      runCommand(
        process.execPath,
        [
          join(rootDir, "scripts/download-native-search-tools.mjs"),
          "--platform",
          targetOs,
          "--arch",
          targetArch,
          "--output-dir",
          join(releaseDir, "tools", platformKey),
        ],
        {
          cwd: rootDir,
          env: process.env,
        },
      );
    } else {
      runCommand(
        process.execPath,
        [
          join(rootDir, "scripts/download-ripgrep.mjs"),
          LEGACY_REMOTE_RIPGREP_VERSION,
          targetOs,
          targetArch,
        ],
        {
          cwd: rootDir,
          env: {
            ...process.env,
            ZCODE_FORCE_REMOTE_MOCK_CDN: "1",
          },
        },
      );
    }
  } catch (error) {
    console.error(
      `  [error] native search 下载失败 (${platformKey})，请检查依赖镜像和 runner 网络访问`,
    );
    throw error;
  }
}

// Remote native search uses the same source selection as desktop/SEA: when an intranet dependency source is configured, preserve the existing download commands
// (Linux uses the release plan; macOS keeps the legacy single-tool rg13 download); otherwise unpack repository archives using the remote plan.
// Both paths write license notices into each tool directory before computing component hashes, so component archives include the notices.
async function prepareRemoteNativeSearchTools({ env = process.env } = {}) {
  const source = resolveNativeSearchArtifactSource(env);
  console.log(
    source === "intranet"
      ? "==> Downloading native search binaries for remote platforms"
      : "==> Preparing native search binaries for remote platforms from repository archives",
  );
  for (const platformKey of remotePlatforms) {
    const [targetOs, targetArch] = platformKey.split("-");
    if (!targetOs || !targetArch) {
      throw new Error(`Invalid remote platform key: ${platformKey}`);
    }
    const prebuiltPlan = resolveRemoteNativeSearchPrebuiltPlan({
      platform: targetOs,
      arch: targetArch,
      outputDir: join(releaseDir, "tools", platformKey),
    });
    if (source === "intranet") {
      downloadRemoteNativeSearchToolsFromIntranet(platformKey, targetOs, targetArch);
      await stageNativeSearchNotices(prebuiltPlan, rootDir, { origin: "intranet-mirror" });
    } else {
      await prepareNativeSearchTools({ prebuiltPlan, source: "repository" });
    }
  }
}

function joinPosix(...segments) {
  return segments.join("/").replace(/\/+/g, "/");
}

function normalizeSemanticPrefix(rawPrefix, fallback = "v1") {
  const prefix = String(rawPrefix ?? "").trim();
  if (!prefix) {
    return fallback;
  }

  const normalized = prefix.replace(/\+/g, "-");
  if (!normalized) {
    return fallback;
  }
  return normalized.startsWith("v") ? normalized : `v${normalized}`;
}

function computeFileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/u.test(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function buildComponentVersion(semanticPrefix) {
  return normalizeSemanticPrefix(semanticPrefix);
}

export function buildContentAddressedComponentVersion(semanticPrefix, sha256) {
  const normalizedSha = String(sha256 ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedSha)) {
    throw new Error(`Invalid component sha256: ${sha256}`);
  }
  return `${buildComponentVersion(semanticPrefix)}+${normalizedSha.slice(0, 12)}`;
}

export function buildComponentArtifactRelativePath(platformKey, componentId, componentVersion) {
  return joinPosix("components", platformKey, componentId, `${componentVersion}.tar.gz`);
}

function resolveComponentSemanticVersion(componentVersion) {
  const version = String(componentVersion ?? "").trim();
  const plusIndex = version.lastIndexOf("+");
  if (plusIndex < 0 || plusIndex === version.length - 1) {
    return version;
  }

  const suffix = version.slice(plusIndex + 1).toLowerCase();
  return /^[a-f0-9]{12,64}$/.test(suffix) ? version.slice(0, plusIndex) : version;
}

// glm carries the zcode-cli app-server protocol schema. Even when the runtime version is unchanged,
// zcode.cjs may change with app code; reusing an old glm across releases makes remote agents reject new protocol fields.
const nonReusableReleaseAssetIds = new Set(["server-bundle", "glm"]);

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function compareVersionSegments(left, right) {
  const leftParts = String(left).split(/[.-]/);
  const rightParts = String(right).split(/[.-]/);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? "0";
    const rightPart = rightParts[index] ?? "0";
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;

    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) {
        return leftNumber - rightNumber;
      }
      continue;
    }

    const compared = leftPart.localeCompare(rightPart, undefined, {
      numeric: true,
    });
    if (compared !== 0) {
      return compared;
    }
  }

  return 0;
}

function findReusableReleaseDirs({ mockCdnDir, currentVersion }) {
  const releasesDir = join(mockCdnDir, "releases");
  if (!existsSync(releasesDir)) {
    return [];
  }

  return readdirSync(releasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== currentVersion)
    .map((entry) => entry.name)
    .filter((candidate) => compareVersionSegments(candidate, currentVersion) < 0)
    .sort((left, right) => compareVersionSegments(right, left))
    .map((candidate) => join(releasesDir, candidate));
}

function normalizeManifestComponents(manifest) {
  if (!manifest || !Array.isArray(manifest.components)) {
    return new Map();
  }

  return new Map(
    manifest.components
      .filter((component) => typeof component?.id === "string")
      .map((component) => [component.id, component]),
  );
}

export function restoreReusableReleaseAssets({
  mockCdnDir,
  currentVersion,
  releaseDir,
  componentDefinitionsByPlatform,
}) {
  const previousReleaseDirs = findReusableReleaseDirs({
    mockCdnDir,
    currentVersion,
  });
  if (previousReleaseDirs.length === 0) {
    return;
  }

  for (const [platformKey, componentDefinitions] of componentDefinitionsByPlatform.entries()) {
    for (const componentDefinition of componentDefinitions) {
      if (nonReusableReleaseAssetIds.has(componentDefinition.id)) {
        continue;
      }

      for (const previousReleaseDir of previousReleaseDirs) {
        const previousManifest = readJsonFile(
          join(previousReleaseDir, `manifest-${platformKey}.json`),
        );
        const previousComponents = normalizeManifestComponents(previousManifest);
        const previousComponent = previousComponents.get(componentDefinition.id);
        if (
          resolveComponentSemanticVersion(previousComponent?.version) !==
          resolveComponentSemanticVersion(componentDefinition.version)
        ) {
          continue;
        }

        const sourcePath = join(previousReleaseDir, ...componentDefinition.mount.split("/"));
        const targetPath = join(releaseDir, ...componentDefinition.mount.split("/"));
        if (!existsSync(sourcePath)) {
          continue;
        }

        const requiredPaths = componentDefinition.requiredPaths ?? [];
        const hasTargetRequiredPaths =
          existsSync(targetPath) &&
          requiredPaths.every((relativePath) =>
            existsSync(join(targetPath, ...relativePath.split("/"))),
          );
        if (hasTargetRequiredPaths) {
          continue;
        }

        const hasRequiredPaths = requiredPaths.every((relativePath) =>
          existsSync(join(sourcePath, ...relativePath.split("/"))),
        );
        if (!hasRequiredPaths) {
          continue;
        }

        // An app version change creates a new releases/<version> directory, so a mock-cdn cache hit cannot depend on that path.
        // Copy a previous release only when the component version matches and required files are present, avoiding repeated downloads of a stable runtime.
        mkdirSync(dirname(targetPath), { recursive: true });
        if (existsSync(targetPath)) {
          // An interrupted bootstrap may leave an incomplete destination containing only .part files.
          // If the destination exists but required files are missing, do not skip reuse; clear it and repair it from a complete historical release.
          rmSync(targetPath, { force: true, recursive: true });
        }
        cpSync(sourcePath, targetPath, { recursive: true });
        console.log(
          `  [reuse] ${componentDefinition.id} ${platformKey} from ${basename(previousReleaseDir)}`,
        );
        break;
      }
    }
  }
}

function buildReusableComponentDefinitionsByPlatform() {
  return new Map(
    remotePlatforms.map((platformKey) => [
      platformKey,
      buildRemoteComponentDefinitions(platformKey).map((component) => ({
        id: component.id,
        version: buildComponentVersion(component.semanticPrefix),
        mount: component.mount,
        requiredPaths: buildReusableComponentRequiredPaths(component.id, platformKey),
      })),
    ]),
  );
}

function buildReusableComponentRequiredPaths(componentId, platformKey) {
  switch (componentId) {
    case "node-runtime":
      return ["node"];
    case "node-pty":
      return platformKey.startsWith("darwin-") ? ["pty.node", "spawn-helper"] : ["pty.node"];
    case "glm":
      // GLM is now the compiled zcode.cjs artifact (shared across platforms), which the remote runs with its deployed Node.
      // Before reusing it, also verify that official plugin seed resources are complete; otherwise an old release keeps producing remote bundles with 0 built-in plugins.
      return ["zcode.cjs", ...remoteOfficialPluginRequiredPaths];
    case "bfs":
      return ["bfs"];
    case "ripgrep":
      return [platformKey.startsWith("win32-") ? "rg.exe" : "rg"];
    case "ugrep":
      return ["ugrep"];
    default:
      return [];
  }
}

export function buildRemoteComponentDefinitions(platformKey) {
  const baseComponents = [
    {
      id: "server-bundle",
      semanticPrefix: version,
      mount: "server",
      sourcePath: join(releaseDir, "server"),
    },
    {
      id: "node-runtime",
      semanticPrefix: nodeVersion,
      mount: joinPosix("node", platformKey),
      sourcePath: join(releaseDir, "node", platformKey),
    },
    {
      id: "node-pty",
      // The node-pty component was previously pinned to v1, so clients kept hitting the old cache after platform packages were upgraded.
      // Use the version of the package actually copied so an @lydell/node-pty-<platform> upgrade invalidates the component cache automatically.
      semanticPrefix: resolveNodePtyPackageVersion(platformKey),
      mount: joinPosix("node-pty", platformKey),
      sourcePath: join(releaseDir, "node-pty", platformKey),
    },
    {
      id: "glm",
      // The GLM native binary was previously pinned to v1, so binary upgrades did not invalidate the component cache.
      // Reuse ZCODE_AGENT_RUNTIME.glm.version to keep the manifest version consistent with the runtime descriptor.
      semanticPrefix: ZCODE_AGENT_RUNTIME.glm.version,
      mount: joinPosix("glm", platformKey),
      sourcePath: join(releaseDir, "glm", platformKey),
    },
  ];

  if (platformKey.startsWith("linux-")) {
    return [
      ...baseComponents,
      {
        id: "bfs",
        semanticPrefix: resolveNativeSearchPrebuiltRelease("bfs", "linux"),
        mount: joinPosix("tools", platformKey, "bfs"),
        sourcePath: join(releaseDir, "tools", platformKey, "bfs"),
      },
      {
        id: "ripgrep",
        semanticPrefix: NATIVE_SEARCH_PREBUILT_RELEASES.ripgrep,
        mount: joinPosix("tools", platformKey, "ripgrep"),
        sourcePath: join(releaseDir, "tools", platformKey, "ripgrep"),
      },
      {
        id: "ugrep",
        semanticPrefix: resolveNativeSearchPrebuiltRelease("ugrep", "linux"),
        mount: joinPosix("tools", platformKey, "ugrep"),
        sourcePath: join(releaseDir, "tools", platformKey, "ugrep"),
      },
    ];
  }

  return [
    ...baseComponents,
    {
      id: "ripgrep",
      semanticPrefix: LEGACY_REMOTE_RIPGREP_VERSION,
      mount: joinPosix("tools", platformKey, "ripgrep"),
      sourcePath: join(releaseDir, "tools", platformKey, "ripgrep"),
    },
  ];
}

function tryReuseRemoteComponentArtifact({
  mockCdnDir,
  component,
  previousComponent,
  sourceSha256,
}) {
  if (!previousComponent) {
    return null;
  }

  if (previousComponent.id !== component.id || previousComponent.mount !== component.mount) {
    return null;
  }

  if (
    resolveComponentSemanticVersion(previousComponent.version) !==
    buildComponentVersion(component.semanticPrefix)
  ) {
    return null;
  }

  if (previousComponent.sourceSha256 !== sourceSha256) {
    return null;
  }

  if (
    typeof previousComponent.artifactPath !== "string" ||
    typeof previousComponent.sha256 !== "string" ||
    !isSha256(previousComponent.sha256)
  ) {
    return null;
  }

  const artifactPath = join(mockCdnDir, ...previousComponent.artifactPath.split("/"));
  if (!existsSync(artifactPath)) {
    return null;
  }

  if (computeFileSha256(artifactPath) !== previousComponent.sha256) {
    return null;
  }

  return previousComponent;
}

export function prepareRemoteComponentArtifact({
  mockCdnDir,
  platformKey,
  component,
  previousComponents = new Map(),
}) {
  if (!existsSync(component.sourcePath)) {
    throw new Error(
      `Missing component source for ${component.id} (${platformKey}): ${component.sourcePath}`,
    );
  }

  const sourceSha256 = computeComponentSourceSha256(component.sourcePath);
  const previousComponent = previousComponents.get(component.id);
  const reusedComponent = tryReuseRemoteComponentArtifact({
    mockCdnDir,
    component,
    previousComponent,
    sourceSha256,
  });
  if (reusedComponent) {
    // Do not rebuild a tar.gz each time when the remote mock-cdn component source has not changed.
    // Use a fingerprint of the source directory to reuse the existing manifest and artifact, avoiding repeated compression of large components in bootstrap:with-remote.
    console.log(`  [skip] component ${component.id} ${platformKey} unchanged`);
    return reusedComponent;
  }

  const semanticComponentVersion = buildComponentVersion(component.semanticPrefix);
  const stagingArtifactRelativePath = joinPosix(
    "components",
    platformKey,
    component.id,
    `${semanticComponentVersion}.tmp-${process.pid}-${Date.now()}.tar.gz`,
  );
  const stagingArtifactPath = join(mockCdnDir, ...stagingArtifactRelativePath.split("/"));
  mkdirSync(dirname(stagingArtifactPath), { recursive: true });

  // Reusing an old tar on a local rerun of the same version would leave the manifest sha256 pointing to stale content.
  // Build a temporary archive first, then include its content hash in the final filename so the CDN does not keep serving an old object under the same name.
  packComponentSourceAsArchive(component.sourcePath, stagingArtifactPath);
  const artifactSha256 = computeFileSha256(stagingArtifactPath);
  const componentVersion = buildContentAddressedComponentVersion(
    component.semanticPrefix,
    artifactSha256,
  );
  const artifactRelativePath = buildComponentArtifactRelativePath(
    platformKey,
    component.id,
    componentVersion,
  );
  const artifactPath = join(mockCdnDir, ...artifactRelativePath.split("/"));
  if (artifactPath !== stagingArtifactPath) {
    rmSync(artifactPath, { force: true });
    mkdirSync(dirname(artifactPath), { recursive: true });
    renameSync(stagingArtifactPath, artifactPath);
  }
  console.log(`  [component] ${component.id} ${platformKey} -> ${artifactRelativePath}`);

  return {
    id: component.id,
    version: componentVersion,
    sha256: artifactSha256,
    sourceSha256,
    artifactPath: artifactRelativePath,
    mount: component.mount,
  };
}

function prepareRemoteComponentArtifacts() {
  console.log("==> Packaging component artifacts and manifests");

  const componentRootDir = join(mockCdnDir, "components");
  mkdirSync(componentRootDir, { recursive: true });

  for (const platformKey of remotePlatforms) {
    const componentManifestEntries = [];
    const componentDefinitions = buildRemoteComponentDefinitions(platformKey);
    const previousComponents = normalizeManifestComponents(
      readJsonFile(join(releaseDir, `manifest-${platformKey}.json`)),
    );

    for (const component of componentDefinitions) {
      componentManifestEntries.push(
        prepareRemoteComponentArtifact({
          mockCdnDir,
          platformKey,
          component,
          previousComponents,
        }),
      );
    }

    const manifestPath = join(releaseDir, `manifest-${platformKey}.json`);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: componentSchemaVersion,
          appVersion: version,
          platformArch: platformKey,
          components: componentManifestEntries,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`  [ok] mock-cdn releases/${version}/manifest-${platformKey}.json`);
  }
}

async function main() {
  console.log(`==> Preparing mock CDN release in ${releaseDir}`);

  mkdirSync(releaseDir, { recursive: true });
  restoreReusableReleaseAssets({
    mockCdnDir,
    currentVersion: version,
    releaseDir,
    componentDefinitionsByPlatform: buildReusableComponentDefinitionsByPlatform(),
  });

  await prepareNodeBinaries();
  buildServerBundle();
  copyServerBundle();
  copyNodePtyPrebuilds();
  stageRemoteAgentBundles();
  await prepareRemoteNativeSearchTools();
  // Fix: server, pty, and agent can each be downloaded independently; add each one's notice before calculating component hashes.
  await stageThirdPartyNotices(join(releaseDir, "server"), rootDir);
  for (const platformKey of remotePlatforms) {
    await stageThirdPartyNotices(join(releaseDir, "node-pty", platformKey), rootDir);
    await stageThirdPartyNotices(join(releaseDir, "glm", platformKey), rootDir);
  }
  prepareRemoteComponentArtifacts();

  console.log(`==> Done! Mock CDN release ready at ${releaseDir}`);
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  await main();
}
