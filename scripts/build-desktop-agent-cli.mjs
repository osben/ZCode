import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageAgentBundle } from "../packages/desktop/scripts/stage-agent-bundle.mjs";
import { runCommand } from "./spawn-command.mjs";

// Adapters tsc can OOM (exit 134) on memory-constrained machines; raise the heap limit for the entire build chain.
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : ""}--max-old-space-size=8192`;
import { stageDevCuaPluginRuntime } from "./stage-dev-cua-plugin-runtime.mjs";
import {
  stageBuiltinProviderConfig,
  resolveBuiltinProviderBuildEnvironment,
} from "./builtin-provider-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const useTurboBuild = process.env.ZCODE_DESKTOP_AGENT_BUILD_MODE === "turbo";
const useBootstrapWithRemoteBuild = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";
const pnpmRunEnv = {
  ...process.env,
  ZCODE_ENV: await resolveBuiltinProviderBuildEnvironment({ root: repoRoot }),
  // pnpm 11's verify-deps-before-run runs pnpm install before each command in the apps/zcode-cli sub-workspace.
  // The sub-workspace runtime depends on the root workspace's @zcode/shared, which automatic install cannot resolve,
  // causing dev:desktop:test and E2E onPrepare to fail.
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};
// Root cause: if the filesystem plugin seed is missing the Sharp closure, the failure appears only when screenshot/zoom is used.
// This script serves local development, prebuild, the server CLI, and the packaged desktop agent; all three build paths
// must include the same copyable runtime. ZCODE_CUA_DEV_MODE is passed only to the staging helper and does not enter the final
// product/runtime environment, so this describes staging input rather than product runtime mode.
const cuaPluginRuntimeStagingEnv = {
  ...process.env,
  ZCODE_CUA_DEV_MODE: "1",
};
// Fix rationale: the desktop Agent has two build paths: regular pnpm and direct tsc through bootstrap:with-remote.
// Previously, each path maintained its own dependency order. After @zcode/telemetry was added, only the bootstrap dependencies were updated,
// so in a clean CI environment telemetry/dist did not exist and bootstrap failed to resolve the type entry point.
// Both paths now derive from this ordered list to prevent future workspace dependencies from drifting again.
const cliWorkspaceBuilds = [
  { packageName: "@zcode/shared-types", packageDir: "shared-types" },
  { packageName: "@zcode/contracts", packageDir: "contracts" },
  // dynamic-workflow's tsc build depends on the gitignored libs.generated.ts.
  // The bare-tsc path (runBootstrapWithRemoteBuild) does not run the package build script,
  // so run the generator first. It must precede @zcode/core, which depends on dynamic-workflow.
  {
    packageName: "@zcode/dynamic-workflow",
    packageDir: "dynamic-workflow",
    prepareScript: "scripts/generate-libs.mjs",
  },
  // dynamic-workflow-runtime's type entry point is dist/index.d.ts; build it before bootstrap.
  { packageName: "@zcode/dynamic-workflow-runtime", packageDir: "dynamic-workflow-runtime" },
  { packageName: "@zcode/core", packageDir: "core" },
  { packageName: "@zcode/adapters", packageDir: "adapters" },
  { packageName: "@zcode/i18n", packageDir: "i18n" },
  { packageName: "@zcode/telemetry", packageDir: "telemetry" },
  { packageName: "@zcode/bootstrap", packageDir: "bootstrap" },
];
// An official plugin manifest can be seeded from the filesystem even when server.js is missing, and fail only when the session
// connects to MCP, leaving a half-started state where Helper is ready but CUA tools are missing. Register all standalone MCP runtimes
// required for normal development in one place, and verify their actual entry files after building before starting the Agent bundle.
const requiredDevPluginRuntimeBuilds = [
  {
    // node_repl host shared by Browser Use and Computer Use; its artifact belongs to a separate package.
    packageName: "@zcode/node-repl-host",
    artifactPath: "node-repl-host/dist/mcp/server.js",
  },
  {
    // browser-use now contains only browser-client at runtime; it no longer bundles the host.
    packageName: "@zcode/browser-use-plugin",
    artifactPath: "browser-use-plugin/scripts/browser-client.mjs",
  },
];
const defaultBuildFilters = [
  ...cliWorkspaceBuilds.map(({ packageName }) => packageName),
  ...requiredDevPluginRuntimeBuilds.map(({ packageName }) => packageName),
];

async function verifyRequiredDevPluginRuntimeArtifacts() {
  for (const runtime of requiredDevPluginRuntimeBuilds) {
    const artifactPath = resolve(repoRoot, "apps/zcode-cli/packages", runtime.artifactPath);
    try {
      await access(artifactPath);
    } catch (error) {
      throw new Error(
        `[build-desktop-agent-cli] ${runtime.packageName} build succeeded without required MCP runtime: ${artifactPath}`,
        { cause: error },
      );
    }
  }
}

/**
 * Stage the newly built agent bundle in bundled-agents.
 *
 * Required: when dev is unpackaged, desktopRuntimeEnv.ts resolves the Agent binary through
 * resolveBundledZCodeAgentBinaryPath(); its only candidate is bundled-agents/, not cli/dist/. Staging only in the packaging
 * chain leaves dev running the previous bundle. It was observed to remain stale for 3 days, silently ignoring Agent CLI changes
 * and making "the change was not included" look like "the code has no effect". Share stage-agent-bundle.mjs with packaging so the two paths cannot drift.
 *
 * Dev runs only on the host platform, so platformKey comes directly from process; the packaging chain resolves cross-platform targets itself.
 */
function stageDevAgentBundle() {
  stageAgentBundle({
    repoRoot,
    platformKey: `${process.platform}-${process.arch}`,
  });
}

async function runBootstrapWithRemoteBuild() {
  if (existsSync(resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs"))) {
    await stageBuiltinProviderConfig({
      root: repoRoot,
      env: pnpmRunEnv,
      directory: resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/provider"),
    });
    console.log("[build-desktop-agent-cli] reuse existing zcode-cli desktop agent bundle");
    return;
  }

  for (const { packageDir, prepareScript } of cliWorkspaceBuilds) {
    // bootstrap:with-remote builds the Agent bundle during the remote-assets stage.
    // Running tsc package by package through pnpm also traverses the shim/env Node layers and can hang for a long time on low-memory local machines.
    // Only bootstrap-specific environment variables apply here, so invoke the TypeScript CLI with the current Node directly.
    // Bare tsc skips package build scripts, so packages with prepareScript (dynamic-workflow) need their generator run first
    // to create the gitignored libs.generated.ts; otherwise tsc fails because the file is missing.
    if (prepareScript) {
      runCommand(process.execPath, [prepareScript], {
        cwd: `apps/zcode-cli/packages/${packageDir}`,
        env: pnpmRunEnv,
        stdio: "inherit",
      });
    }
    runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
      cwd: `apps/zcode-cli/packages/${packageDir}`,
      env: pnpmRunEnv,
      stdio: "inherit",
    });
  }

  runCommand(process.execPath, ["scripts/build.mjs", "--desktop-agent"], {
    cwd: "apps/zcode-cli/packages/cli",
    env: pnpmRunEnv,
    stdio: "inherit",
  });
}

if (useBootstrapWithRemoteBuild) {
  await runBootstrapWithRemoteBuild();
  stageDevAgentBundle();
  stageDevCuaPluginRuntime({ env: cuaPluginRuntimeStagingEnv });
  process.exit(0);
}

if (!useTurboBuild) {
  // The Linux container demo has no repository-level turbo root. `turbo --cwd apps/zcode-cli`
  // treats apps/zcode-cli as the root and rejects turbo.json inputs pointing to ../../packages/shared.
  // The Agent sub-workspace also omits the root packages/shared even though the Agent package depends on @zcode/shared.
  // Build in the explicit pnpm package order from the repository root by default to avoid WDIO setup hanging during sub-workspace resolution.
  for (const filter of defaultBuildFilters) {
    runCommand("pnpm", ["--filter", filter, "build"], {
      env: pnpmRunEnv,
      stdio: "inherit",
    });
  }

  await verifyRequiredDevPluginRuntimeArtifacts();
  runCommand("pnpm", ["--filter", "@zcode/cli", "build:desktop-agent"], {
    env: pnpmRunEnv,
    stdio: "inherit",
  });
  stageDevAgentBundle();
  stageDevCuaPluginRuntime({ env: cuaPluginRuntimeStagingEnv });
  process.exit(0);
}

runCommand(
  "pnpm",
  [
    "exec",
    "turbo",
    "--skip-infer",
    "--cwd",
    "apps/zcode-cli",
    "run",
    "build:desktop-agent",
    "--filter=@zcode/cli",
  ],
  {
    env: pnpmRunEnv,
    stdio: "inherit",
  },
);
stageDevAgentBundle();
stageDevCuaPluginRuntime({ env: cuaPluginRuntimeStagingEnv });
