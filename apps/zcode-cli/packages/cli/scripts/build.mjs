import { chmod, readFile, rm } from "node:fs/promises";
import { readThirdPartyNotices, stageThirdPartyNotices } from "../../../../../scripts/third-party-notices.mjs";
import { basename, dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { stageBuiltinProviderConfig } from "../../../../../scripts/builtin-provider-config.mjs";

const cliRoot = resolve(import.meta.dirname, "..");
const projectRoot = resolve(cliRoot, "../..");
const executableFileMode = 0o755;
const packageJsonFile = "package.json";
const rootPackageVersionError = "Root package.json must define a non-empty string version.";
const desktopAgentBuildFlag = "--desktop-agent";
export const resolveBuildExternal = () => ["@zcode/tui", "playwright-core", "koffi"];

export const readZodBuildVersion = async () => {
  const sharedPackage = JSON.parse(
    await readFile(resolve(projectRoot, "../../packages/shared/package.json"), "utf8"),
  );
  const version = sharedPackage.dependencies?.zod;
  if (typeof version !== "string" || !/^4\.\d+\.\d+$/.test(version)) {
    throw new Error("packages/shared must pin one exact Zod v4 version.");
  }
  return version;
};

async function readZodPackage(file, cache) {
  for (
    let directory = dirname(file);
    directory !== dirname(directory);
    directory = dirname(directory)
  ) {
    if (basename(directory) !== "zod") continue;
    if (!cache.has(directory)) {
      cache.set(
        directory,
        readFile(resolve(directory, "package.json"), "utf8").then((text) => {
          const manifest = JSON.parse(text);
          if (manifest.name !== "zod" || typeof manifest.version !== "string") {
            throw new Error(`Invalid Zod package metadata: ${directory}`);
          }
          return { root: directory, version: manifest.version };
        }),
      );
    }
    return cache.get(directory);
  }
  return undefined;
}

function assertZodVersion(pkg, expectedV4Version) {
  if (pkg.version.startsWith("4.") && pkg.version !== expectedV4Version) {
    throw new Error(`Expected Zod v4 ${expectedV4Version}, found ${pkg.version}: ${pkg.root}`);
  }
}

export async function assertZodBundleIdentity(metafile, { workingDirectory, expectedV4Version }) {
  if (!metafile) throw new Error("Zod bundle validation requires an esbuild metafile.");
  const packages = new Map();
  const cache = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (!/(?:^|[/\\])zod[/\\]/.test(input)) continue;
    const pkg = await readZodPackage(resolve(workingDirectory, input), cache);
    if (!pkg) continue;
    assertZodVersion(pkg, expectedV4Version);
    const previous = packages.get(pkg.version);
    if (previous && previous !== pkg.root) {
      throw new Error(`Duplicate Zod ${pkg.version} in bundle: ${previous}, ${pkg.root}`);
    }
    packages.set(pkg.version, pkg.root);
  }
}

export function createZodDedupePlugin({ expectedV4Version }) {
  return {
    name: "zcode-zod-dedupe",
    setup(builder) {
      const packages = new Map();
      const cache = new Map();
      // A hoisted install can leave byte-identical copies of Zod at different paths for multiple consumers.
      // Resolve versions and exports for each original consumer before merging installation roots; do not alias v3 as v4.
      builder.onResolve({ filter: /^zod(?:\/|$)/ }, async (args) => {
        if (args.pluginData?.zcodeZodResolving) return;
        const resolved = await builder.resolve(args.path, {
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: { zcodeZodResolving: true },
        });
        if (resolved.errors.length || resolved.external) return resolved;
        const pkg = await readZodPackage(resolved.path, cache);
        if (!pkg) throw new Error(`Cannot identify resolved Zod package: ${resolved.path}`);
        assertZodVersion(pkg, expectedV4Version);
        if (!packages.has(pkg.version)) packages.set(pkg.version, pkg.root);
        return {
          ...resolved,
          // Preserve the subpath and .js/.cjs extension selected by exports; do not rewrite the conditions with require.resolve.
          path: resolve(packages.get(pkg.version), relative(pkg.root, resolved.path)),
          pluginData: args.pluginData,
        };
      });
      builder.onEnd(async (result) => {
        if (result.errors.length) return;
        await assertZodBundleIdentity(result.metafile, {
          workingDirectory: builder.initialOptions.absWorkingDir ?? process.cwd(),
          expectedV4Version,
        });
      });
    },
  };
}

export const readRootPackageVersion = async ({ root = projectRoot } = {}) => {
  const packageJson = JSON.parse(await readFile(resolve(root, packageJsonFile), "utf8"));

  if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
    throw new Error(rootPackageVersionError);
  }

  return packageJson.version;
};

export const resolveBuildOptions = (args = [], env = process.env) => {
  const desktopAgent = args.includes(desktopAgentBuildFlag);
  const e2eCoverage = env.ZCODE_E2E_COVERAGE === "1";

  return {
    // Normal desktop-agent releases must remain minified and omit maps. E2E coverage builds must
    // preserve original symbols and source maps so c8 can map back to each package's TypeScript source.
    minify: desktopAgent && !e2eCoverage,
    sourcemap: e2eCoverage || !desktopAgent,
  };
};

export const resolveBuildAliases = ({
  cliDirectory = cliRoot,
  rootDirectory = projectRoot,
} = {}) => ({
  "@zcode/shared-types": resolve(cliDirectory, "../shared-types/dist/index.js"),
  // The plugin host needs only these standalone entry points; do not route them through the generic alias and reevaluate the shared root entry.
  "@zcode/shared/runtime-env": resolve(rootDirectory, "../../packages/shared/src/runtimeEnv.ts"),
  "@zcode/shared/mcp": resolve(rootDirectory, "../../packages/shared/src/mcp.ts"),
  "@zcode/shared/runtime-tool-runtime": resolve(
    rootDirectory,
    "../../packages/shared/src/runtime-tool-runtime.ts",
  ),
  // esbuild aliases rewrite import paths by prefix. Declare every shared subpath exactly before the
  // generic entry, or it will resolve incorrectly as `src/index.ts/<subpath>` and break Desktop agent/SEA packaging.
  "@zcode/shared/zcode-protocol-v4": resolve(
    rootDirectory,
    "../../packages/shared/src/zcode-protocol-v4/index.ts",
  ),
  // This subpath reference was added when the ModelSelection schema moved to a single source of truth
  // in shared. esbuild rewrites aliases by prefix; unless declared exactly before the generic entry,
  // it will incorrectly resolve to `src/index.ts/model-selection` and break Desktop agent packaging.
  "@zcode/shared/model-selection": resolve(
    rootDirectory,
    "../../packages/shared/src/model-selection.ts",
  ),
  // The new shared Model Schema subpath must not be appended to index.ts by the generic alias.
  "@zcode/shared/model-config": resolve(rootDirectory, "../../packages/shared/src/model-config.ts"),
  // The process exception boundary uses this lightweight contract before bootstrap, so it must not
  // match shared's generic prefix alias.
  "@zcode/shared/process-diagnostic": resolve(
    rootDirectory,
    "../../packages/shared/src/process-diagnostic.ts",
  ),
  "@zcode/shared/config-schema": resolve(
    rootDirectory,
    "../../packages/shared/src/config-schema.ts",
  ),
  "@zcode/shared/workspace-hook-discovery": resolve(
    rootDirectory,
    "../../packages/shared/src/workspace-hook-discovery.ts",
  ),
  // The review controller imports WorkspaceHookMutationError directly, so it needs this exact alias.
  // As above, omitting it breaks Desktop agent/SEA packaging because esbuild rewrites by prefix.
  "@zcode/shared/workspace-hook-mutation": resolve(
    rootDirectory,
    "../../packages/shared/src/workspace-hook-mutation.ts",
  ),
  // The verdict's direct import needs this exact alias. Without it, the generic "@zcode/shared"
  // prefix rewrites the path to `src/index.ts/workspace-hook-review-monotonicity`, breaking Desktop agent/SEA packaging.
  "@zcode/shared/workspace-hook-review-monotonicity": resolve(
    rootDirectory,
    "../../packages/shared/src/workspace-hook-review-monotonicity.ts",
  ),
  // This subpath was added when the trust-store file schema moved to its single source of truth.
  // Without an exact declaration, the generic "@zcode/shared" prefix rewrites it to
  // `src/index.ts/workspace-hook-trust-store-file`, breaking Desktop agent/SEA packaging as above.
  "@zcode/shared/workspace-hook-trust-store-file": resolve(
    rootDirectory,
    "../../packages/shared/src/workspace-hook-trust-store-file.ts",
  ),
  "@zcode/shared/zcodeEndpoint": resolve(
    rootDirectory,
    "../../packages/shared/src/zcodeEndpoint.ts",
  ),
  "@zcode/shared/node": resolve(rootDirectory, "../../packages/shared/src/node.ts"),
  "@zcode/shared": resolve(rootDirectory, "../../packages/shared/src/index.ts"),
  "@zcode/core": resolve(cliDirectory, "../core/dist/index.js"),
});

export const buildCli = async ({
  cliDirectory = cliRoot,
  rootDirectory = projectRoot,
  minify = false,
  sourcemap = true,
  env = process.env,
  version = readRootPackageVersion({
    root: rootDirectory,
  }),
} = {}) => {
  const cliVersion = await version;
  const outfile = resolve(cliDirectory, "dist/zcode.cjs");
  const sourcemapFile = `${outfile}.map`;
  const notices = await readThirdPartyNotices(resolve(rootDirectory, "../.."));

  await stageBuiltinProviderConfig({
    root: resolve(rootDirectory, "../.."),
    directory: resolve(cliDirectory, "dist/provider"),
    env,
  });

  await build({
    banner: {
      // SEA and the regular CLI share this entry point; it must be readable independently before Agent initialization and native-resource extraction.
      js: `#!/usr/bin/env node\n"use strict";\nif (process.argv.length === 3 && process.argv[2] === "--licenses") { const sea = require("node:sea"); const nodeNotice = sea.isSea() ? "\\n\\n## Bundled Node.js runtime\\n\\n" + sea.getAsset("zcode-node-license", "utf8") : ""; process.stdout.write(${JSON.stringify(notices.toString("utf8"))} + nodeNotice, () => process.exit(0)); } else {`,
    },
    footer: { js: "}" },
    bundle: true,
    define: {
      __CLI_VERSION__: JSON.stringify(cliVersion),
    },
    entryPoints: [resolve(cliDirectory, "src/main.ts")],
    // Ink 7 and yoga-layout use top-level await, so the CJS CLI bundle loads the TUI
    // through Node's native dynamic import path instead of forcing esbuild to lower it.
    // playwright-core depends on runtime package assets and require.resolve, so it must remain external rather than being bundled inline.
    // The managed headless adapter is loaded lazily only with explicit --browser-use=headless; app-server and the regular CLI are unaffected.
    // koffi dynamically requires native `.node` files for the current platform. Inlining it makes
    // esbuild traverse artifacts for every platform and fail with "No loader is configured for .node".
    // Runtime loading still comes from the dependency package; build-sea collects SEA native assets separately.
    external: resolveBuildExternal(),
    format: "cjs",
    // Desktop app integration embeds only zcode.cjs. The old desktop-agent build reused the CLI
    // debug artifact, which was unminified and left source maps pointing to files not copied into the package.
    // Desktop agent mode minifies JavaScript while preserving function/class names so diagnostics
    // and registration logic that depend on name are not affected by esbuild identifier mangling.
    keepNames: minify,
    legalComments: "none",
    logLevel: "info",
    minify,
    metafile: true,
    plugins: [createZodDedupePlugin({ expectedV4Version: await readZodBuildVersion() })],
    outfile,
    platform: "node",
    sourcemap,
    // Target the lowest Node version across all runtimes: Desktop uses Electron's bundled Node 24,
    // while remote SSH uses the already-installed standalone Node v22.16 to run the same zcode.cjs.
    // Targeting Node 22 keeps the artifact from using syntax or features unsupported by either runtime.
    target: "node22",
    alias: resolveBuildAliases({ cliDirectory, rootDirectory }),
  });

  if (!sourcemap) {
    await rm(sourcemapFile, { force: true });
  }

  await chmod(outfile, executableFileMode);
  await stageThirdPartyNotices(resolve(cliDirectory, "dist"), resolve(rootDirectory, "../.."));
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await buildCli(resolveBuildOptions(process.argv.slice(2)));
}
