import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageAgentBundle } from "../packages/desktop/scripts/stage-agent-bundle.mjs";
import { runCommand } from "./spawn-command.mjs";

// adapters tsc OOMs (exit 134) on memory-constrained machines; raise the heap cap for the whole build chain.
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : ""}--max-old-space-size=8192`;
import { stageDevCuaPluginRuntime } from "./stage-dev-cua-plugin-runtime.mjs";
import {
  resolveBuiltinProviderBuildEnvironment,
  stageBuiltinProviderConfig,
} from "./builtin-provider-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const useTurboBuild = process.env.ZCODE_DESKTOP_AGENT_BUILD_MODE === "turbo";
const useBootstrapWithRemoteBuild = process.env.ZCODE_BOOTSTRAP_WITH_REMOTE === "1";
const pnpmRunEnv = {
  ...process.env,
  ZCODE_ENV: await resolveBuiltinProviderBuildEnvironment({ root: repoRoot }),
  // pnpm 11's verify-deps-before-run triggers pnpm install before every run in the
  // apps/zcode-cli sub-workspace; the sub-workspace runtime depends on the root repo's
  // @zcode/shared, and the automatic install cannot resolve root workspace packages, breaking
  // dev:desktop:test and E2E onPrepare.
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};
// Bug root cause: if the filesystem plugin seed lacked the Sharp closure, the error only
// surfaced at screenshot/zoom time. This script serves local Dev, prebuild, the server CLI, and
// the packaged desktop agent; all three build branches must fill in the same reproducible
// runtime. ZCODE_CUA_DEV_MODE is passed only to the staging helper and never enters the final
// product/runtime environment, so what follows describes staging input, not the product run mode.
const cuaPluginRuntimeStagingEnv = {
  ...process.env,
  ZCODE_CUA_DEV_MODE: "1",
};
// Root cause: the desktop Agent build has two paths — plain pnpm and bootstrap:with-remote
// running tsc directly. The two used to maintain dependency order separately; after
// @zcode/telemetry was added only the bootstrap order was updated, and in a clean CI, where
// telemetry/dist does not exist yet, bootstrap failed to resolve the type entry.
// Both paths now derive from this single ordered list so future workspace dependencies cannot drift again.
const cliWorkspaceBuilds = [
  { packageName: "@zcode/shared-types", packageDir: "shared-types" },
  { packageName: "@zcode/contracts", packageDir: "contracts" },
  // dynamic-workflow's tsc build depends on the gitignored libs.generated.ts, and the bare-tsc
  // path (runBootstrapWithRemoteBuild) does not run package build scripts, so the generator must
  // run first; it must also precede @zcode/core, which depends on dynamic-workflow.
  {
    packageName: "@zcode/dynamic-workflow",
    packageDir: "dynamic-workflow",
    prepareScript: "scripts/generate-libs.mjs",
  },
  // dynamic-workflow-runtime's type entry is dist/index.d.ts; it must build before bootstrap.
  { packageName: "@zcode/dynamic-workflow-runtime", packageDir: "dynamic-workflow-runtime" },
  { packageName: "@zcode/core", packageDir: "core" },
  { packageName: "@zcode/adapters", packageDir: "adapters" },
  { packageName: "@zcode/i18n", packageDir: "i18n" },
  { packageName: "@zcode/telemetry", packageDir: "telemetry" },
  { packageName: "@zcode/bootstrap", packageDir: "bootstrap" },
];
// An official plugin manifest can be seeded from the filesystem even when server.js is missing;
// the error only appears when the session connects to MCP, producing a half-started state of
// "Helper ready but no CUA tools". Every standalone MCP runtime required by normal Dev must be
// centrally registered here, with real entry files verified after the build, before the Agent
// bundle is allowed to start.
// Bug cause: this script is also the only plugin build entry for Source Server archive staging
// (stageCli.ts ensureAgentBundle). After legacy prepare-prebuilds.mjs was deleted, no remote
// build step produced android-emulator / ios-simulator dist/mcp/server.js any more, and since
// plugin dist is gitignored, a clean CI packed plugins without MCP entries into the archive.
// Every official plugin whose plugin.json declares mcpServers must be registered here.
const requiredDevPluginRuntimeBuilds = [
  {
    packageName: "@zcode/android-emulator-plugin",
    artifactPath: "android-emulator-plugin/dist/mcp/server.js",
  },
  {
    packageName: "@zcode/ios-simulator-plugin",
    artifactPath: "ios-simulator-plugin/dist/mcp/server.js",
  },
  {
    // node_repl host: shared by Browser Use and Computer Use; the artifact belongs to its own package.
    packageName: "@zcode/node-repl-host",
    artifactPath: "node-repl-host/dist/mcp/server.js",
  },
  {
    // browser-use's own runtime is down to browser-client; the host is no longer carried by it.
    packageName: "@zcode/browser-use-plugin",
    artifactPath: "browser-use-plugin/scripts/browser-client.mjs",
  },
  // The document plugins' viewer-panel server is built by office-runtime; without a dev build the panel entry is visible but MCP fails to start.
  ...["documents", "pdf", "presentations", "spreadsheets"].map((name) => ({
    packageName: `@zcode/${name}-plugin`,
    artifactPath: `${name}-plugin/dist/server.mjs`,
  })),
  // The Sites panel's MCP server is built by the plugin itself; without a build the panel entry is visible but MCP fails to start.
  { packageName: "@zcode/zcode-site-plugin", artifactPath: "zcode-site-plugin/dist/server.mjs" },
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
 * Stage the freshly built agent bundle into bundled-agents.
 *
 * Why required: when dev is not packaged, the agent binary is resolved by
 * desktopRuntimeEnv.ts's resolveBundledZCodeAgentBinaryPath(), whose candidates are
 * **only** bundled-agents/ — not cli/dist/. Relying on the packaging chain alone left dev
 * running whatever the last package run left behind — observed 3 days stale, with every
 * agent-CLI-side change silently not applying in dev, disguising "the change never made it in"
 * as "the code does nothing".
 * The implementation shares stage-agent-bundle.mjs with the packaging chain, so the two can no longer drift apart.
 *
 * dev runs only the host platform, so platformKey comes straight from process; the packaging chain resolves its own cross-platform targets.
 */
function stageDevAgentBundle() {
  stageAgentBundle({
    repoRoot,
    platformKey: `${process.platform}-${process.arch}`,
  });
}

/**
 * Re-stage the built-in provider config next to the agent bundle after every build path.
 *
 * scripts/builtin-provider-config.mjs resolves the file from this run's ZCODE_ENV (pnpmRunEnv).
 * The CLI build (apps/zcode-cli/packages/cli/scripts/build.mjs) also stages it, but this explicit
 * call keeps dist/provider on the same environment as the run, so the bootstrap path does not
 * depend on the nested build having staged it. The fork test in scripts/test pins this call.
 */
async function stageProviderConfigForAgentBundle() {
  await stageBuiltinProviderConfig({
    root: repoRoot,
    env: pnpmRunEnv,
    directory: resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/provider"),
  });
}

function runBootstrapWithRemoteBuild() {
  // Bug cause: bootstrap used to treat an existing dist/zcode.cjs as "already built this run",
  // so after source changes it still put the previous Agent generation into the Source Server
  // archive. Bootstrap success must mean a real rebuild of this run.
  for (const { packageDir, prepareScript } of cliWorkspaceBuilds) {
    // bootstrap:with-remote builds the agent bundle in its remote-assets phase.
    // Running tsc per package through pnpm adds the shim/env node layer and easily stalls for a
    // long time in low-memory local environments.
    // Here only the bootstrap-specific env vars apply, reusing the current Node to launch the
    // TypeScript CLI directly.
    // Bare tsc bypasses package build scripts, so packages with a prepareScript
    // (dynamic-workflow) must run the generator manually first to fill in the gitignored
    // libs.generated.ts, or tsc fails on the missing file.
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
  runBootstrapWithRemoteBuild();
  await stageProviderConfigForAgentBundle();
  stageDevAgentBundle();
  stageDevCuaPluginRuntime({ env: cuaPluginRuntimeStagingEnv });
  process.exit(0);
}

if (!useTurboBuild) {
  // The Linux container demo has no repo-level turbo root: `turbo --cwd apps/zcode-cli`
  // treats apps/zcode-cli as the root and rejects turbo.json inputs pointing at
  // ../../packages/shared. The agent sub-workspace also does not include the root
  // packages/shared, yet the agent package depends on @zcode/shared.
  // So the default builds via the repo-root workspace with an explicit pnpm package order,
  // keeping the WDIO pre-build from stalling on sub-workspace resolution.
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
  await stageProviderConfigForAgentBundle();
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
await stageProviderConfigForAgentBundle();
stageDevAgentBundle();
stageDevCuaPluginRuntime({ env: cuaPluginRuntimeStagingEnv });
