// Stage the agent bundle by copying apps/zcode-cli/packages/cli/dist/zcode.cjs to
// bundled-agents/<platform>/glm and writing its metadata.
//
// The dev and packaging pipelines must use the same staging implementation.
// Staging only in the packaging path (prepare-agent-node-bundle.mjs) is insufficient because the dev
// path (scripts/build-desktop-agent-cli.mjs) would not stage the bundle. In an unpackaged dev build,
// desktopRuntimeEnv.ts resolves the agent binary with resolveBundledZCodeAgentBinaryPath(), whose only
// candidate is bundled-agents/; it does not check cli/dist/. Dev would therefore keep running the copy
// from the previous package build. One observed copy was three days old, so agent CLI changes silently
// had no effect in dev and looked like code changes were not working. Sharing this implementation keeps
// the two paths aligned.
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "apps/zcode-cli/packages/cli/dist/zcode.cjs";

/**
 * Reason for the fix (2026-10-24, real device): the node_repl MCP server (including the inlined
 * CUA agent runtime) is not inside zcode.cjs — the agent launches it from the ~/.zcode plugin
 * cache. The dev zcode.cjs is a plain esbuild bundle (no SEA assets), and the bootstrap
 * filesystem seed rootCandidates cannot resolve apps/zcode-cli/packages/node-repl-host
 * (cwd is the workspace, not the repo layout), so the dev agent can only consume whatever
 * the cache already holds; the cache's only writer is the production agent's SEA seed
 * (which embeds an old copy), so agent-side changes never ran in dev.
 * Aligned with the production package layout: staging the source package to
 * glm/packages/node-repl-host lets the dev agent's entrypointDir + rootCandidates[0] hit it,
 * and every dev startup seed refreshes the cache from this latest build (a production
 * rewrite only affects sessions it starts later — the node_repl server process is
 * unaffected by cache changes once it has loaded its code).
 * The packaging chain (prepare-agent-node-bundle.mjs) later re-stages the same directory
 * with the fuller officialPluginPackages logic; staging the same content twice here is
 * harmless.
 */
const STAGED_NODE_REPL_HOST_ENTRIES = [
  "dist",
  ".zcode-plugin",
  "package.json",
  "README.md",
  "scripts",
];

export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(repoRoot, "packages", "desktop", "bundled-agents", platformKey, "glm");
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, "zcode.cjs"),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
  };
}

/**
 * Rebuild the glm directory from scratch before copying. Clearing it is intentional: electron-builder
 * copies bundled-agents/<platform>/glm to resources/glm as a directory. Stale native binaries (such as
 * zcode-agent or zcode-acp) and old metadata from a previous local build would otherwise ship in the
 * installer. Clean CI checkouts do not contain them, but local worktrees can.
 */
export function stageAgentBundle({ repoRoot, platformKey, log = console.log }) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath } = resolveAgentBundlePaths({
    repoRoot,
    platformKey,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[stage:agent-bundle] agent bundle 源产物不存在：${cliBundlePath}`);
  }
  rmSync(glmDir, { recursive: true, force: true });
  mkdirSync(glmDir, { recursive: true });
  copyFileSync(cliBundlePath, stagedBundlePath);
  const meta = {
    runtime: "electron-node",
    entry: "zcode.cjs",
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
  };
  writeFileSync(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  // node-repl-host staging (see the STAGED_NODE_REPL_HOST_ENTRIES comment): a missing dist
  // means the caller has not built it yet (build-desktop-agent-cli's defaultBuildFilters
  // builds before staging). Skip and let the packaging chain report the error; do not
  // duplicate the validation in this shared implementation.
  const nodeReplHostSource = resolve(repoRoot, "apps", "zcode-cli", "packages", "node-repl-host");
  const nodeReplHostTarget = resolve(glmDir, "packages", "node-repl-host");
  if (existsSync(resolve(nodeReplHostSource, "dist", "mcp", "server.js"))) {
    mkdirSync(nodeReplHostTarget, { recursive: true });
    for (const entry of STAGED_NODE_REPL_HOST_ENTRIES) {
      const sourcePath = resolve(nodeReplHostSource, entry);
      if (existsSync(sourcePath)) {
        cpSync(sourcePath, resolve(nodeReplHostTarget, entry), { recursive: true });
      }
    }
    log(`[stage:agent-bundle] staged node-repl-host runtime for dev self-seed`);
  }
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  return { stagedBundlePath, stagedMetaPath };
}
