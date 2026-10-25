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
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "apps/zcode-cli/packages/cli/dist/zcode.cjs";

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
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  return { stagedBundlePath, stagedMetaPath };
}
