import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolveZCodeEndpointOrigin } from "@zcode/shared/zcodeEndpoint";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { resolveDesktopProductFlavor } from "./scripts/desktop-product-identity.mjs";

// Dynamically load repo-root build tooling so its import.meta.dirname is not relocated to desktop after the config is bundled.
// Build-time optional capabilities (ARMS, event reporting, auto-update), see docs/desktop/build-time-optional-capabilities.md
const { resolveBuildTimeConfig, createBuildTimeConfigDefines } = await import(
  pathToFileURL(resolve(__dirname, "../../scripts/build-time-config.mjs")).href
);
const buildTimeConfigDefines = createBuildTimeConfigDefines(
  await resolveBuildTimeConfig(process.env),
);

const buildMetadata = getBuildMetadata();
const desktopRequire = createRequire(import.meta.url);

interface IstanbulInstrumenter {
  instrumentSync(sourceCode: string, filename: string): string;
  lastFileCoverage(): unknown;
  lastSourceMap(): object | null;
}

interface IstanbulLibInstrument {
  createInstrumenter(options: {
    autoWrap: boolean;
    compact: boolean;
    coverageGlobalScope: string;
    coverageGlobalScopeFunc: boolean;
    esModules: boolean;
    parserPlugins: string[];
    preserveComments: boolean;
    produceSourceMap: boolean;
  }): IstanbulInstrumenter;
}

const { createInstrumenter } = desktopRequire("istanbul-lib-instrument") as IstanbulLibInstrument;

function resolveInstalledPackageRoot(packageName: string): string {
  return dirname(desktopRequire.resolve(`${packageName}/package.json`));
}

export const desktopRendererDependencyAliases = {
  // pnpm's hoisted or package-local layout varies with installation settings; hard-coded
  // node_modules subpaths can make Rolldown dependency optimization resolve entries such as
  // react/jsx-runtime to paths that do not exist. Resolve the actual installation root through
  // Node to keep one React runtime while supporting different node-linker settings.
  react: resolveInstalledPackageRoot("react"),
  "react-dom": resolveInstalledPackageRoot("react-dom"),
  "lucide-react": resolveInstalledPackageRoot("lucide-react"),
} as const;

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

function createE2EUIRendererCoveragePlugin(repoRoot: string): Plugin {
  const sourceRoots = [
    resolve(repoRoot, "packages/ui/src"),
    resolve(repoRoot, "packages/desktop/src/renderer"),
  ].map(normalizePathForVite);
  const instrumenter = createInstrumenter({
    autoWrap: true,
    compact: false,
    coverageGlobalScope: "globalThis",
    coverageGlobalScopeFunc: false,
    esModules: true,
    parserPlugins: ["typescript", "jsx"],
    preserveComments: true,
    produceSourceMap: true,
  });
  const baselineCoverage: Record<string, unknown> = {};
  const baselinePath = resolve(
    repoRoot,
    "packages/desktop/out/renderer/e2e-coverage-baseline.json",
  );

  return {
    name: "zcode:e2e-ui-source-coverage",
    enforce: "pre",
    transform(sourceCode, id, options) {
      if (options?.ssr || id.startsWith("\0")) {
        return null;
      }
      const filename = stripViteRequestQuery(id);
      const absoluteFilename = isAbsolute(filename) ? filename : resolve(repoRoot, filename);
      const normalizedFilename = normalizePathForVite(absoluteFilename);
      if (!shouldInstrumentE2EUISource(normalizedFilename, sourceRoots)) {
        return null;
      }

      // Post-transform instrumentation depends on the merged Vite/React/esbuild source map, which
      // projects generated JavaScript coverage back onto TypeScript source lines such as imports
      // and interfaces. Instrument the original TS/TSX AST first, then compile with Vite, so the
      // coverage map includes only actual runtime code.
      const code = instrumenter.instrumentSync(sourceCode, normalizedFilename);
      baselineCoverage[normalizedFilename] = JSON.parse(
        JSON.stringify(instrumenter.lastFileCoverage()),
      );
      return {
        code,
        map: instrumenter.lastSourceMap(),
      };
    },
    closeBundle() {
      // Reading only page __coverage__ omits lazy chunks that were never loaded and shrinks the
      // denominator. In a coverage build, retain zero-hit maps for the complete renderer graph so
      // the suite reporter can merge them.
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(baselineCoverage, null, 2)}\n`, "utf-8");
    },
  };
}

function shouldInstrumentE2EUISource(filename: string, sourceRoots: string[]) {
  return (
    isCoverageSourceFile(filename) &&
    !filename.includes("/node_modules/") &&
    !isDeclarationFile(filename) &&
    !isTestSourceFile(filename) &&
    sourceRoots.some((sourceRoot) => isInsidePath(filename, sourceRoot))
  );
}

function isCoverageSourceFile(filename: string) {
  return [".cts", ".cjs", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"].includes(extname(filename));
}

function isDeclarationFile(filename: string) {
  return /\.d\.[cm]?ts$/u.test(filename);
}

function isTestSourceFile(filename: string) {
  return /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(filename);
}

function isInsidePath(filename: string, directory: string) {
  return filename === directory || filename.startsWith(`${directory}/`);
}

function normalizePathForVite(path: string) {
  return path.replaceAll("\\", "/");
}

function stripViteRequestQuery(id: string) {
  return id.split("?")[0] ?? id;
}

function createReactScanDevPlugin(): Plugin {
  const scriptPath = normalizePathForVite(desktopRequire.resolve("react-scan/dist/auto.global.js"));
  return {
    name: "zcode:react-scan",
    apply: "serve",
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        if (context.path !== "/index.html") return [];
        // Scan must install its hook before React loads; a plain head script guarantees the order so an async import cannot miss the first mount.
        return [{ tag: "script", attrs: { src: `/@fs/${scriptPath}` }, injectTo: "head-prepend" }];
      },
    },
  };
}

export default defineConfig(({ command, mode }) => {
  // `.env*` provides only link constants; the startup script or CI injects the current product
  // environment through ZCODE_ENV.
  const env = loadEnv(mode, "../..", "");
  const repoRoot = resolve(__dirname, "../..");
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);
  // Package identity is independent of the backend environment; the renderer uses it to decide
  // whether to show the update entry point.
  const zcodeProductFlavor = resolveDesktopProductFlavor({
    ...process.env,
    ...env,
    ZCODE_ENV: zcodeEnv,
  });
  const e2eCoverageEnabled =
    env.ZCODE_E2E_COVERAGE === "1" || process.env.ZCODE_E2E_COVERAGE === "1";
  const e2eStoreBridgeEnabled =
    env.VITE_ZCODE_E2E_STORE_BRIDGE === "1" || process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1";
  const zcodeEndpointOrigin = resolveZCodeEndpointOrigin({
    env: zcodeEnv,
    envBaseOrigin:
      env.ZCODE_BASE_URL ??
      env.ZCODE_ENDPOINT_ORIGIN ??
      (zcodeEnv === "production" ? env.ZCODE_PRODUCTION_BASE_URL : env.ZCODE_TEST_BASE_URL),
  });
  const codingPlanWebviewOrigin =
    env.VITE_CODING_PLAN_WEBVIEW_ORIGIN ?? process.env.VITE_CODING_PLAN_WEBVIEW_ORIGIN ?? "";
  const plugins = [
    // Wired up only in the dev server, never injected in builds; the backend's ZCODE_ENV does not decide whether dev tooling is on.
    ...(command === "serve" && mode !== "production" && env.ZCODE_REACT_SCAN !== "0"
      ? [createReactScanDevPlugin()]
      : []),
    ...(e2eCoverageEnabled ? [createE2EUIRendererCoveragePlugin(repoRoot)] : []),
    pdfJsCMapsPlugin(),
    react(),
    tailwindcss(),
  ];

  return {
    root: "src/renderer",
    plugins,
    resolve: {
      alias: {
        // Fix @ alias resolution failures in the UI component library.
        // Desktop bundles packages/ui source directly, but this Vite config did not know that @
        // should point to packages/ui/src, breaking internal imports in components such as
        // spinner and alert. Define the alias at the consumer rather than changing individual
        // component imports, matching the web configuration.
        "@": resolve(__dirname, "../ui/src"),
        ...desktopRendererDependencyAliases,
        // Recharts reads the Path export from d3-path through d3-shape. A hoisted node_modules may
        // contain a stale d3-shape/node_modules/d3-path@1.x, which Vite pre-bundling can resolve
        // first and report as a missing export. Pin d3-path to the root 3.x entry so desktop
        // dependency optimization and runtime resolution agree.
        "d3-path": resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
      },
      dedupe: ["react", "react-dom", "lucide-react"],
    },
    server: { port: 5174, strictPort: true },
    define: {
      __ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion),
      __ZCODE_MIN_COMPATIBLE_VERSION__: JSON.stringify(buildMetadata.minCompatibleVersion),
      __ZCODE_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
      __ZCODE_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(zcodeProductFlavor),
      ...buildTimeConfigDefines,
      __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__: JSON.stringify(mode !== "production"),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      // Support the legacy name read by older renderers; new code consistently reads
      // VITE_ZCODE_BASE_URL.
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
      "import.meta.env.VITE_CODING_PLAN_WEBVIEW_ORIGIN": JSON.stringify(codingPlanWebviewOrigin),
      "import.meta.env.VITE_REWARDS_WEBVIEW_ORIGIN": JSON.stringify(
        env.VITE_REWARDS_WEBVIEW_ORIGIN ?? process.env.VITE_REWARDS_WEBVIEW_ORIGIN ?? "",
      ),
      // Bugfix: Enable the E2E store bridge only with the WDIO-specific variable, so a product environment
      // of ZCODE_ENV=test is not mistaken for a test run.
      "import.meta.env.VITE_ZCODE_E2E_STORE_BRIDGE": JSON.stringify(
        e2eStoreBridgeEnabled ? "1" : "",
      ),
    },
    // Electron loads pages with the file:// protocol, so asset paths must be relative; otherwise,
    // loading fails with ERR_FILE_NOT_FOUND.
    base: "./",
    worker: {
      rollupOptions: {
        // The @pierre/diffs worker entry registers its message listener after import.
        // Its package omits the sideEffects declaration, causing the production worker sub-build
        // to be tree-shaken to 0 bytes. Disable tree-shaking only for the worker build, leaving the
        // main bundle unaffected.
        treeshake: false,
      },
    },
    build: {
      outDir: "../../out/renderer",
      emptyOutDir: true,
      // Exposing sourceMappingURL in production packages would let an attacker reconstruct the
      // application source from the client. Use hidden sourcemaps in production: keep .map files
      // for local and release workflows without exposing a mapping entry point in the artifacts.
      sourcemap: mode === "production" ? "hidden" : true,
      rollupOptions: {
        // Multiple entry points: main window, process monitor, and CUA permission drag panel.
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          "resource-manager": resolve(__dirname, "src/renderer/resource-manager.html"),
          "cua-permission-panel": resolve(__dirname, "src/renderer/cua-permission-panel.html"),
          // Trusted shell for the plugin UI sandbox, served via zcode-sandbox://
          "plugin-sandbox": resolve(__dirname, "src/renderer/plugin-sandbox.html"),
        },
      },
    },
  };
});
