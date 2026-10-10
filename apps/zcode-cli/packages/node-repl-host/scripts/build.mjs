import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");

// See the equivalent fix in browser-use-plugin/scripts/build.mjs: the __require shim
// in esbuild's ESM output has no require in ESM scope, so CJS dependencies pulled in by
// @zcode/core (yaml → require("process")) throw during **module evaluation**. The plugin
// host's await import() then fails, registering zero tools and hiding
// mcp__node_repl__js from the model. Inject the real createRequire.
const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

// Computer Use was completely unavailable in production builds: each CUA call either
// waited until the MCP client timed out (observed at 60/110/120s) or returned after ~64s.
// 「permission broker socket is not accepting connections yet」。
//
// The lazy-start path (see the lazy-start comment in services/src/node.ts) moved Helper
// installation/launch on darwin from the host to the SDK's first CUA call, and that path
// runs **in this package**. `helperInstaller` therefore ships in this bundle. But
// `__ZCODE_CUA_HELPER_BUILD_ID__` was injected **only** by packages/desktop/tsup.config.ts
// (Electron main / app.asar); this file's esbuild call had no defines. In production,
// the producer's `ZCODE_CUA_HELPER_BUILD_ID` therefore collapsed to an empty string (see
// the fallback in zcode-cua/src/broker/shared/cua-version.ts),
// `resolveExpectedCuaHelperBuildId()` returned null, and helperInstaller hit the fail-closed guard:
//
//   "Packaged ZCode is missing its embedded Computer Use Helper build identity;
//    refusing an unpinned Helper install"
//
// As a result, Helper was neither installed nor launched and no logs were written. MCP
// converted this throw into a timeout with no persistence point, so the problem stayed
// hidden. Evidence: host logs contained five `[cua-product-helper]` lines on 09-11 (host
// path with the define) and zero on 09-14; `~/.zcode/computer-use/logs/` was never
// created; renaming an installed Helper did not trigger reinstall. Development was
// unaffected (ALLOW_UNSIGNED_LOCAL plus non-production runtime bypasses this guard), so
// the issue appeared only in production builds and could not be reproduced locally.
//
// Use the same source as desktop: CI injects the ZCODE_CUA_HELPER_BUILD_ID environment
// variable; development falls back on an empty string (dev Helper does not use download
// or pin verification). See the matching define comment in packages/desktop/tsup.config.ts.
const resolveCuaHelperBuildId = (env = process.env) =>
  env.ZCODE_CUA_HELPER_BUILD_ID?.trim() ?? "";

export const buildNodeReplHostBundle = async ({
  outfile = resolve(packageRoot, "dist", "mcp", "server.js"),
  cuaHelperBuildId = resolveCuaHelperBuildId(),
} = {}) => {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    banner: { js: nodeRequireBanner },
    bundle: true,
    define: {
      __ZCODE_CUA_HELPER_BUILD_ID__: JSON.stringify(cuaHelperBuildId),
    },
    entryPoints: [resolve(packageRoot, "src", "server.ts")],
    format: "esm",
    legalComments: "none",
    outfile,
    platform: "node",
    target: "node24",
  });
  // Build-time guard: if the define name drifts (is renamed or removed by a refactor such
  // as createSharedDefines), the output silently falls back to an empty string. The
  // symptom appears only in production and looks like a timeout, so fail here before it
  // reaches users.
  if (cuaHelperBuildId) {
    const bundled = await readFile(outfile, "utf8");
    if (!bundled.includes(cuaHelperBuildId)) {
      throw new Error(
        `[node-repl-host] ZCODE_CUA_HELPER_BUILD_ID=${cuaHelperBuildId} 未折叠进 ${outfile}：` +
          "__ZCODE_CUA_HELPER_BUILD_ID__ define 没有生效，正式包的 Helper 安装会被 fail-closed 拒绝。",
      );
    }
  }
  return { outfile, cuaHelperBuildId };
};

// This previously used `file://${process.argv[1]}`. On Windows argv[1] is
// `C:\...\build.mjs`, while import.meta.url is `file:///C:/.../build.mjs`, so they never
// match. The script was treated as a plain module and exited without doing anything: the
// build appeared to succeed but produced no output, discovered only when the dev guard
// reported "build succeeded without required MCP runtime". The equivalent browser-use
// script and other repository entry points use pathToFileURL; this one was missed when
// extracting the package.
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const { outfile } = await buildNodeReplHostBundle();
  console.log(`[node-repl-host] ${outfile}`);
}
