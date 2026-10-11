import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { resolveDesktopProductFlavor } from "./scripts/desktop-product-identity.mjs";
const { copyGenUiRuntimeAssets } = await import(
  pathToFileURL(resolve(import.meta.dirname, "scripts/gen-ui-runtime-assets.mjs")).href
);
// tsup bundles this config first; load the build tool dynamically so its import.meta.dirname is not relocated to desktop.
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);
const { resolveBuildTimeConfig, createBuildTimeConfigDefines } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/build-time-config.mjs")).href
);
// Build-time optional capabilities (ARMS, event reporting, auto-update); see docs/desktop/build-time-optional-capabilities.md
const buildTimeConfigDefines = createBuildTimeConfigDefines(
  await resolveBuildTimeConfig(process.env),
);

const buildMetadata = getBuildMetadata();

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

// Load .env files manually; unlike Vite, tsup does not read .env.* automatically. These files provide URL constants only.
function loadEnvFiles(): Record<string, string> {
  const vars: Record<string, string> = {};
  const files = ["../../.env"];
  if (process.env.NODE_ENV === "production") {
    files.push("../../.env.production");
  } else {
    files.push("../../.env.development", "../../.env.development.local");
  }
  for (const file of files) {
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2];
      }
    }
  }
  // Actual environment variables have the highest priority.
  if (process.env.ZCODE_ENV) vars.ZCODE_ENV = process.env.ZCODE_ENV;
  if (process.env.ZCODE_BASE_URL) vars.ZCODE_BASE_URL = process.env.ZCODE_BASE_URL;
  if (process.env.VITE_ZCODE_BASE_URL) vars.VITE_ZCODE_BASE_URL = process.env.VITE_ZCODE_BASE_URL;
  // OAuth origin/client_id are read by the host runtime; keep this override point so development builds can inspect the unified env source.
  if (process.env.ZAI_OAUTH_CLIENT_ID) vars.ZAI_OAUTH_CLIENT_ID = process.env.ZAI_OAUTH_CLIENT_ID;
  if (process.env.ZAI_OAUTH_ORIGIN) vars.ZAI_OAUTH_ORIGIN = process.env.ZAI_OAUTH_ORIGIN;
  if (process.env.ZAI_BUSINESS_BASE_URL) {
    vars.ZAI_BUSINESS_BASE_URL = process.env.ZAI_BUSINESS_BASE_URL;
  }
  if (process.env.ZAI_BUSINESS_LOGIN_URL) {
    vars.ZAI_BUSINESS_LOGIN_URL = process.env.ZAI_BUSINESS_LOGIN_URL;
  }
  if (process.env.CDN_DOMAIN) vars.CDN_DOMAIN = process.env.CDN_DOMAIN;
  if (process.env.OSS_PATH_PREFIX) vars.OSS_PATH_PREFIX = process.env.OSS_PATH_PREFIX;
  if (process.env.VITE_ZAI_OAUTH_CLIENT_ID) {
    vars.VITE_ZAI_OAUTH_CLIENT_ID = process.env.VITE_ZAI_OAUTH_CLIENT_ID;
  }
  if (process.env.VITE_ZAI_OAUTH_ORIGIN) {
    vars.VITE_ZAI_OAUTH_ORIGIN = process.env.VITE_ZAI_OAUTH_ORIGIN;
  }
  return vars;
}

const env = loadEnvFiles();
const { environment: zcodeEnv } = await loadBuiltinProviderConfig();
// Package identity and backend environment are independent: ZCODE_PREVIEW_IDENTITY=1 lets a production-backend build run as ZCode Preview.
const zcodeProductFlavor = resolveDesktopProductFlavor({ ...process.env, ZCODE_ENV: zcodeEnv });
console.log(`[tsup] ZCODE_ENV=${zcodeEnv} ZCODE_PRODUCT_FLAVOR=${zcodeProductFlavor}`);

function parseCsvEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveBuildRemoteCdnReleaseRoots(runtimeEnv: Record<string, string | undefined>) {
  const domains = parseCsvEnv(runtimeEnv.CDN_DOMAIN);
  const pathPrefixes = parseCsvEnv(runtimeEnv.OSS_PATH_PREFIX || "zcode/electron/releases");
  if (domains.length === 0) {
    return [];
  }
  if (pathPrefixes.length !== 1 && pathPrefixes.length !== domains.length) {
    throw new Error(
      `OSS_PATH_PREFIX must contain one value or match CDN_DOMAIN count (${domains.length}), got ${pathPrefixes.length}`,
    );
  }

  return domains.map((domain, index) => {
    const pathPrefix = pathPrefixes.length === 1 ? pathPrefixes[0] : pathPrefixes[index];
    return `https://${domain}/${pathPrefix}`.replace(/\/+$/, "");
  });
}

export function resolveBuildPackagedAgentTelemetryEnv(
  runtimeEnv: Record<string, string | undefined>,
): Record<string, string> {
  const endpoint = runtimeEnv.ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT?.trim();
  const headers = runtimeEnv.ZCODE_PACKAGED_AGENT_OTEL_HEADERS?.trim();
  const serviceName =
    runtimeEnv.ZCODE_PACKAGED_AGENT_OTEL_SERVICE_NAME?.trim() || "zcode-cli-agent";

  if (!endpoint && !headers) {
    if (
      runtimeEnv.CI &&
      (runtimeEnv.CI_COMMIT_TAG || runtimeEnv.CI_COMMIT_BRANCH === "release/current")
    ) {
      throw new Error("Packaged Agent OTLP configuration is required for release builds");
    }
    return {};
  }
  if (!endpoint || !headers) {
    throw new Error(
      "ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT and ZCODE_PACKAGED_AGENT_OTEL_HEADERS must be configured together",
    );
  }
  if (endpoint.length > 2_048) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT exceeds 2048 characters");
  }
  if (headers.length > 8_192 || /[\r\n]/u.test(headers)) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_HEADERS is invalid");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(serviceName)) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_SERVICE_NAME is invalid");
  }

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT must be a valid HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(parsedEndpoint.protocol) ||
    parsedEndpoint.username ||
    parsedEndpoint.password
  ) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT must be a valid HTTP(S) URL");
  }
  if (
    resolveZCodeEnv(runtimeEnv.ZCODE_ENV) === "production" &&
    parsedEndpoint.protocol !== "https:"
  ) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT must use HTTPS in production");
  }

  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: parsedEndpoint.toString(),
    OTEL_EXPORTER_OTLP_HEADERS: headers,
    OTEL_SERVICE_NAME: serviceName,
    // Only an Agent shipped in the official Desktop installer can be trusted by the build chain as packaged;
    // source/development_bundle are not guessed at runtime—stay unknown unless explicitly injected.
    ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION: "packaged",
  };
}

export function resolveDesktopTsupBundleSecurityOptions(
  runtimeEnv: Record<string, string | undefined> = process.env,
) {
  const isProduction = runtimeEnv.NODE_ENV === "production";
  const isE2ECoverageBuild = runtimeEnv.ZCODE_E2E_COVERAGE === "1";
  return {
    // The packaged main/host/preload bundles were not minified under NODE_ENV=production,
    // leaving source comments and formatting in the artifacts and increasing reverse-engineering and implementation-disclosure risks.
    keepNames: isProduction && !isE2ECoverageBuild,
    minify: isProduction && !isE2ECoverageBuild,
    // Production packages do not include sourcemaps; emitting sourceMappingURL would expose an invalid map path.
    // E2E coverage builds go only into an isolated app cache and need maps to resolve V8 bundle ranges
    // back to TypeScript source; normal release builds remain without sourcemaps.
    sourcemap: isE2ECoverageBuild || !isProduction,
  };
}

type DesktopTsupEsbuildOptions = {
  chunkNames?: string;
  legalComments?: "none" | "inline" | "eof" | "linked" | "external";
};

export function applyDesktopTsupEsbuildSecurityOptions(options: DesktopTsupEsbuildOptions) {
  // During production minification, esbuild may preserve license/legal comments by default.
  // Release packages should not contain source comments or sourcemap entry comments in main/host/preload.
  options.legalComments = "none";
}

const desktopTsupBundleSecurityOptions = resolveDesktopTsupBundleSecurityOptions();

function createSharedDefines() {
  return {
    __ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion),
    __ZCODE_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
    __ZCODE_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
    __ZCODE_ENV__: JSON.stringify(zcodeEnv),
    __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(zcodeProductFlavor),
    ...buildTimeConfigDefines,
    // Computer Use Helper build identity — helperInstaller reads this to choose which Helper bundle to download.
    // If missing, the installer throws "Packaged ZCode is missing its embedded Computer Use Helper build identity".
    // CI injects it through ZCODE_CUA_HELPER_BUILD_ID; an empty value in dev uses the fallback (dev helpers are not downloaded).
    __ZCODE_CUA_HELPER_BUILD_ID__: JSON.stringify(
      process.env.ZCODE_CUA_HELPER_BUILD_ID?.trim() ?? "",
    ),
    // Bugfix: the remote runtime CDN root was previously hardcoded in the main bundle, so OSS/CDN
    // switching required code changes. Inject it at build time from CI's CDN_DOMAIN/OSS_PATH_PREFIX;
    // keep the old default when unconfigured.
    __ZCODE_REMOTE_CDN_RELEASE_ROOTS__: JSON.stringify(resolveBuildRemoteCdnReleaseRoots(env)),
  };
}

function createMainDefines() {
  return {
    ...createSharedDefines(),
    // Release installers cannot inherit the GitLab Runner or development-terminal environment.
    // Compile only the low-privilege write configuration CI provides into Desktop Main, then
    // deliver it through the existing Main -> Host -> Agent security boundaries.
    __ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__: JSON.stringify(
      resolveBuildPackagedAgentTelemetryEnv(process.env),
    ),
  };
}

const desktopNodeRuntimeExternals = [
  "electron",
  "node-pty",
  "ssh2",
  "undici",
  "@larksuiteoapi/node-sdk",
  "yaml",
  // node-forge uses dynamic require("crypto") internally; inlining it into an ESM main/host bundle makes Electron report
  // Dynamic require of "crypto" is not supported. Keep it as a runtime external dependency, like undici.
  "node-forge",
  // The ZIP extractor internally depends on CommonJS require("fs") and cannot be inlined into the ESM main/host artifacts.
  "yauzl",
];

function createDevReadyMarkerHook(target: "main" | "host" | "preload"): string {
  // In multi-config watch mode, CLI-level --onSuccess runs separately for each sub-build.
  // Previously, preload could write the ready marker first, allowing Electron to start before main/host finished.
  // Each config now writes its own marker on success so the dev launcher can wait for every build precisely.
  return `node scripts/write-dev-ready-marker.mjs ${target}`;
}

export default defineConfig([
  {
    name: "main",
    entry: {
      "main/index": "src/main/index.ts",
      "main/browserWebmRecorder": "src/main/browserView/electronBrowserWebmRecorder.ts",
      "main/zcodeDataSizeWorker": "src/main/zcodeDataSizeWorker.ts",
      // The storage-scan Worker for the Resource Manager's "Storage" tab: main owns StorageService, while traversal runs in a separate thread resolved by new Worker(new URL()).
      "main/storageScanWorker": "src/main/storageScanWorker.ts",
    },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // If undici is inlined into the main ESM bundle, it reaches its internal CommonJS require("assert") at runtime,
    // and Electron reports Dynamic require of "assert" is not supported while loading the main artifact.
    // Keep undici external in Desktop; the standalone remote bundle inlines it separately.
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      // Provider Refactor workspace packages export TypeScript source; the Electron production runtime has no
      // TS loader, so inline them in the Desktop bundle instead of leaving bare package references to src/index.ts.
      "@zcode/provider",
      "@zcode/provider-node",
      // services is bundled into main, but its producer import used to remain a bare package reference.
      // electron-builder excludes node_modules/@zcode, causing ERR_MODULE_NOT_FOUND at startup in the installed app.
      // Bundle the producer's JS broker with services; the native addon remains only in the separate Helper.
      "@zcode/zcode-cua",
    ],
    define: createMainDefines(),
    // Bugfix: when main and host watch builds share an output root, default chunk names can
    // overwrite each other, causing main imports to point to a chunk just rewritten by host and
    // intermittently fail with a missing-named-export startup error.
    // Write chunks to target-specific directories to isolate concurrent build outputs.
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "main/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("main"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "preload",
    entry: {
      "preload/embeddedBrowserJavaScriptDialog": "src/preload/embeddedBrowserJavaScriptDialog.ts",
      "preload/codingPlanWebview": "src/preload/codingPlanWebview.ts",
      "preload/rewardsWebview": "src/preload/rewardsWebview.ts",
      "preload/browserVideoRecorder": "src/preload/browserVideoRecorder.ts",
      "preload/index": "src/preload/index.ts",
      "preload/resourceManager": "src/preload/resourceManager.ts",
      "preload/cuaPermissionPanel": "src/preload/cuaPermissionPanel.ts",
      "preload/pluginSandbox": "src/preload/pluginSandbox/index.ts",
    },
    outDir: "out",
    format: "cjs",
    platform: "node",
    target: "node22",
    external: ["electron"],
    noExternal: ["@zcode/shared"],
    outExtension: () => ({ js: ".cjs" }),
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
    },
    onSuccess: createDevReadyMarkerHook("preload"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    // window.zcode / window.openai alias scripts inside the plugin iframe (a thin wrapper over the
    // official ext-apps `App`): IIFE, browser platform, served same-origin by the zcode-sandbox://
    // protocol handler.
    name: "plugin-sandbox-alias",
    loader: { ".css": "text" },
    entry: {
      "plugin-sandbox-alias": "src/renderer/src/plugin-sandbox/alias.ts",
      "gen-ui": "src/renderer/src/plugin-sandbox/genUi.ts",
    },
    // Cannot go under out/renderer: the vite renderer build's emptyOutDir would wipe the alias
    // scripts written earlier.
    outDir: "out/plugin-sandbox",
    onSuccess: () => copyGenUiRuntimeAssets(resolve("out/plugin-sandbox")),
    format: "iife",
    platform: "browser",
    target: "es2022",
    // Sandbox pages have no node_modules: the SDKs (ext-apps / client / core / zod) must all be
    // bundled into the IIFE.
    noExternal: [/.*/],
    outExtension: () => ({ js: ".js" }),
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
    },
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "host",
    entry: {
      "host/index": "src/host/index.ts",
      "host/tasksStorageWorker": "src/host/tasksStorageWorker.ts",
    },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // Host and main share the same services graph; inlining undici still triggers the same dynamic require crash in the Electron ESM runtime.
    // Keep it external here as well to prevent Host startup failures in Desktop development and packaged builds.
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      "@zcode/provider",
      "@zcode/provider-node",
      "@zcode/zcode-cua",
    ],
    define: createSharedDefines(),
    // Use the same chunk isolation strategy as main to prevent host and main artifacts from overwriting each other.
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "host/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("host"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "scheduler",
    entry: { "scheduler/index": "src/scheduler/index.ts" },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // Like host, the persistent cron scheduler process reuses @zcode/services (tasks-index + cron),
    // and keeps undici and similar packages external to avoid dynamic require crashes in the Electron ESM runtime.
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      "@zcode/provider",
      "@zcode/provider-node",
      "@zcode/zcode-cua",
    ],
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "scheduler/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("scheduler"),
    ...desktopTsupBundleSecurityOptions,
  },
]);
