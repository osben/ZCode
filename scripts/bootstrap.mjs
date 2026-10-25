#!/usr/bin/env node

import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCommand } from "./spawn-command.mjs";
import { clearHoistedPatchedDependencyTargets } from "./bootstrap-patched-dependencies.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const gitCommand = "git";
const withRemoteAssets = process.argv.includes("--with-remote");

function prependPathEntries(pathValue, entries) {
  const currentEntries = pathValue ? pathValue.split(delimiter) : [];
  return [...entries, ...currentEntries].join(delimiter);
}

function resolvePinnedNodeBin() {
  if (process.platform === "win32") {
    return undefined;
  }

  const miseConfigPath = resolve(rootDir, "mise.toml");
  if (!existsSync(miseConfigPath)) {
    return undefined;
  }

  const miseConfig = readFileSync(miseConfigPath, "utf8");
  const match = miseConfig.match(/^\s*node\s*=\s*"([^"]+)"/m);
  const version = match?.[1]?.trim();
  if (!version) {
    return undefined;
  }

  const nvmNodeBin = join(homedir(), ".nvm", "versions", "node", `v${version}`, "bin");
  return existsSync(nvmNodeBin) ? nvmNodeBin : undefined;
}

function resolveUserPnpmBin() {
  if (process.platform === "win32") {
    return undefined;
  }

  const pnpmBin = join(homedir(), "Library", "pnpm");
  return existsSync(join(pnpmBin, "pnpm")) ? pnpmBin : undefined;
}

function resolvePnpmCommand() {
  if (!withRemoteAssets) {
    return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  }

  const userPnpmBin = resolveUserPnpmBin();
  if (userPnpmBin) {
    return join(userPnpmBin, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  }

  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function resolveBootstrapWithRemoteEnv(baseEnv = process.env) {
  if (!withRemoteAssets) {
    return {};
  }

  // 修复原因：默认 dev:desktop 使用生产账号；远程构建若沿用通用 test 默认值，
  // 会把生产凭据发往测试模型地址并返回 401。入口统一选择环境并传给所有构建子进程。
  const zcodeEnv = baseEnv.ZCODE_ENV?.trim().toLowerCase() || "production";
  if (zcodeEnv !== "test" && zcodeEnv !== "production") {
    throw new Error(`Invalid ZCODE_ENV for bootstrap:with-remote: ${zcodeEnv}`);
  }

  const pathEntries = [resolvePinnedNodeBin(), resolveUserPnpmBin()].filter(Boolean);

  return {
    ZCODE_ENV: zcodeEnv,
    // bootstrap:with-remote is the manual entry point for initializing remote resources. In automated non-TTY environments,
    // pnpm install may ask for confirmation before clearing node_modules. Disable confirmation only for this entry point; do not change CI/production build commands.
    HUSKY: "0",
    PNPM_CONFIG_CONFIRM_MODULES_PURGE: "false",
    npm_config_confirm_modules_purge: "false",
    // Remote assets and the bootstrap build trigger many workspace builds in the same run.
    // Limit peak-memory reduction to the bootstrap:with-remote child process; do not change the global semantics of build/build:bootstrap.
    PNPM_CONFIG_WORKSPACE_CONCURRENCY: "1",
    ZCODE_BOOTSTRAP_WITH_REMOTE: "1",
    ...(pathEntries.length > 0
      ? {
          PATH: prependPathEntries(baseEnv.PATH, pathEntries),
        }
      : {}),
  };
}

const bootstrapWithRemoteEnv = resolveBootstrapWithRemoteEnv();
const pnpmCommand = resolvePnpmCommand();

function runGit(args) {
  runCommand(gitCommand, args, {
    cwd: rootDir,
    env: process.env,
  });
}

function runPnpm(args, options = {}) {
  runCommand(pnpmCommand, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
      ...options.env,
    },
  });
}

function runBootstrapServerBuild() {
  const serverDir = resolve(rootDir, "packages/server");

  // The final bootstrap:with-remote build used to reuse build:bootstrap, causing @zcode/server build
  // to nest another pnpm run build:remote. tsx/esbuild child processes can hang or be killed in low-memory local environments.
  // A build also cannot be skipped just because dist files exist: development versions often stay the same, and stale entry-http or remote bundles
  // would keep local/remote environments on an old protocol. Keep only the low-memory optimization that directly runs the equivalent entry point; leave CI and production build scripts unchanged.
  runCommand(process.execPath, [resolve(rootDir, "node_modules/tsup/dist/cli-default.js")], {
    cwd: serverDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
    },
  });
  runCommand(
    process.execPath,
    [resolve(rootDir, "node_modules/tsx/dist/cli.mjs"), "build-remote.ts"],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        ...bootstrapWithRemoteEnv,
      },
    },
  );
}

function runBootstrapE2eReportBuild() {
  const e2eReportDir = resolve(rootDir, "packages/e2e-report");
  // Bugfix: the final bootstrap:with-remote build must not nest pnpm build:node.
  // In low-memory environments, the pnpm shim plus tsc can be SIGKILLed; run the equivalent entry point directly from the bootstrap runner only.
  runCommand(
    process.execPath,
    [resolve(rootDir, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    {
      cwd: e2eReportDir,
      env: {
        ...process.env,
        ...bootstrapWithRemoteEnv,
      },
    },
  );
  runCommand(process.execPath, [resolve(rootDir, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: e2eReportDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
    },
  });
}

function runBootstrapStreamAnimateBuild() {
  const streamAnimateDir = resolve(rootDir, "packages/stream-animate");
  // Bugfix: during the serial final build in bootstrap:with-remote, continuing to run stream-animate’s tsc through pnpm
  // can still hit the shim and be SIGKILLed; run the equivalent entry point directly from the bootstrap runner only.
  runCommand(
    process.execPath,
    [resolve(rootDir, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.server.json"],
    {
      cwd: streamAnimateDir,
      env: {
        ...process.env,
        ...bootstrapWithRemoteEnv,
      },
    },
  );
  runCommand(process.execPath, [resolve(rootDir, "node_modules/vite/bin/vite.js"), "build"], {
    cwd: streamAnimateDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
    },
  });
}

function runBootstrapDesktopBuild() {
  const desktopDir = resolve(rootDir, "packages/desktop");
  // bootstrap:with-remote initializes remote resources and the local runtime.
  // Building the desktop app bundle enters the production tsup/vite path, which is killed with SIGKILL in low-memory local environments.
  // Keep build metadata only in the bootstrap runner; preserve the production/CI semantics of build:no-runtime-assets.
  runCommand(process.execPath, ["scripts/build-metadata.mjs"], {
    cwd: desktopDir,
    env: {
      ...process.env,
      ...bootstrapWithRemoteEnv,
    },
  });
  console.log("[bootstrap:with-remote] skip desktop app bundle build; runtime assets are prepared");
}

function runBootstrapWithRemoteBuild() {
  for (const filter of ["@zcode/rpc", "@zcode/web", "@zcode/formal-proof"]) {
    // During the final bootstrap:with-remote build, pnpm -r starts multiple Vite/esbuild/tsup processes concurrently.
    // Remote assets have already reached a memory peak, so build packages serially here without changing build:bootstrap/CI commands.
    runPnpm(["--filter", filter, "build"]);
  }
  runBootstrapE2eReportBuild();
  runBootstrapStreamAnimateBuild();
  runBootstrapServerBuild();
  runBootstrapDesktopBuild();
}

runGit(["submodule", "update", "--init", "--recursive", "apps/zcode-cli"]);

const clearedPatchedDependencies = await clearHoistedPatchedDependencyTargets({
  rootDir,
  pnpmCommand,
});
if (clearedPatchedDependencies.length > 0) {
  console.log(
    `[bootstrap] refreshed hoisted patched dependencies: ${clearedPatchedDependencies.join(", ")}`,
  );
}

runPnpm(withRemoteAssets ? ["install", "--config.confirmModulesPurge=false"] : ["install"]);

runPnpm(["prepare:desktop-runtime"], {
  env: withRemoteAssets
    ? {}
    : {
        // Local bootstrap used to prepare the remote mock-cdn by default,
        // repackaging cross-platform components every time and making ordinary initialization slow.
        // Prepare only the desktop local runtime by default; use bootstrap:with-remote when remote resources are needed.
        ZCODE_SKIP_REMOTE_ASSETS: "1",
      },
});

if (withRemoteAssets) {
  runBootstrapWithRemoteBuild();
  // Refresh the existing component manifests after the workspace build so they describe current outputs.
  // The root prepare script is the remote-assets entry point (fork test spec); the server-cli package script is gone.
  runPnpm(["run", "prepare:remote-assets"]);
  // Source Server archive stage (source-server-release.json + four platform archives). Still needed by R3 first-run;
  // invoked through the package entry instead of a named script so the spec test keeps its no-script contract.
  // Run after the final workspace build so the archive collects this run's fresh build outputs.
  runPnpm([
    "--filter",
    "@zcode/server-cli",
    "exec",
    "tsx",
    "src/packaging/stageRemoteAssetsCli.ts",
  ]);
} else {
  runPnpm(["run", "build:bootstrap"]);
}
