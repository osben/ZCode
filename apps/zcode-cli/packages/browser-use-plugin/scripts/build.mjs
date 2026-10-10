import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const defaultPackageRoot = resolve(import.meta.dirname, "..");
const executableFileMode = 0o755;

// When esbuild bundles with format: "esm", it replaces require() in CJS dependencies with a __require shim:
//   typeof require !== "undefined" ? require : (name) => { throw Error('Dynamic require of "' + name + '" is not supported') }
// The ESM module scope has no require, so the shim always takes its throwing branch.
// @zcode/core eagerly imports CJS yaml through tool/handlers/write.js -> memory/origin-session.js.
// yaml's require("process") hits the shim, causing dist/mcp/server.js to throw
// `Dynamic require of "process" is not supported` during **module evaluation**. The plugin host's await import() then fails,
// resulting in mcp.server.closed / mcp.server.failed, zero registered tools, and mcp__node_repl__js becoming unavailable to the model.
// Inject the real createRequire so the shim uses a working require (the output remains ESM).
// Apply this to both bundles: browser-client currently has no CJS dependencies, but as an ESM artifact it would fail at load
// time in the same way if a CJS dependency is introduced later.
const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

const createBundleOptions = ({ entryPoint, outfile }) => ({
  banner: {
    js: nodeRequireBanner,
  },
  bundle: true,
  entryPoints: [entryPoint],
  format: "esm",
  legalComments: "none",
  outfile,
  platform: "node",
  target: "node24",
});

/**
 * Build entry point shared by direct script execution and smoke tests, ensuring tests validate artifacts built with the same
 * esbuild options as release artifacts.
 */
export const buildBrowserUsePluginBundles = async ({
  packageRoot = defaultPackageRoot,
  browserClientOutfile = resolve(packageRoot, "scripts", "browser-client.mjs"),
} = {}) => {
  // @zcode/node-repl-host builds and ships the node_repl host artifact itself; this package emits only browser-client.
  await mkdir(dirname(browserClientOutfile), { recursive: true });
  await build(
    createBundleOptions({
      entryPoint: resolve(packageRoot, "src", "browser-client.ts"),
      outfile: browserClientOutfile,
    }),
  );
  await chmod(browserClientOutfile, executableFileMode);
  return { browserClientOutfile };
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await buildBrowserUsePluginBundles();
}
