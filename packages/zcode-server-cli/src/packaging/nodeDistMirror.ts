/**
 * The sole resolver for the Node dist download source within this package.
 *
 * It shares the same contract and default value as the `ZCODE_NODE_DIST_MIRROR` CI variable in `.gitlab/ci/00-workflow.yml`,
 * `nodeDistBase()` in `scripts/prepare-prebuilds.mjs`, and `DEFAULT_MIRROR` in
 * `scripts/cua-helper-sea-base.mjs`. These four locations must stay in sync: the CI variable overrides
 * the code default, so changing the code default alone has no effect in CI.
 *
 * `stageCli.ts` and `scripts/prepare-prebuilds.mjs` both hardcoded
 * `https://nodejs.org/dist`, which macOS CI runners cannot reach (`UND_ERR_CONNECT_TIMEOUT`, 10s).
 * Both prepare-prebuilds and stage:remote-assets failed on this path and were only bypassed when the cache happened to avoid network access.
 *
 * Keep this in a separate module rather than stageCli.ts: the latter ends with top-level `await main()` and executes on import,
 * so tests cannot import it.
 */
export const DEFAULT_NODE_DIST_BASE = "https://cdn.npmmirror.com/binaries/node";

export function resolveNodeDistBase(env: NodeJS.ProcessEnv = process.env): string {
  const mirror = env.ZCODE_NODE_DIST_MIRROR?.trim();
  return (mirror || DEFAULT_NODE_DIST_BASE).replace(/\/+$/u, "");
}
