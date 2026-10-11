import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
// This tsup config is itself bundled; the build tool must preserve its original location instead of inlining and relocating it.
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);
const { stageThirdPartyNotices } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/third-party-notices.mjs")).href
);

// tsup.config may be loaded from different working directories; resolve the repository-root package.json relative to this config file.
const rootPackageJsonPath = resolve(import.meta.dirname, "../../package.json");
const { version } = JSON.parse(readFileSync(rootPackageJsonPath, "utf-8"));

const { environment: zcodeEnv, content: zcodeBuiltinProviderConfigJson } =
  await loadBuiltinProviderConfig();

export const SERVER_HTTP_DEFINES = {
  __ZCODE_VERSION__: JSON.stringify(version),
  __ZCODE_ENV__: JSON.stringify(zcodeEnv),
  __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(zcodeBuiltinProviderConfigJson),
};

function createSharedDefines() {
  return SERVER_HTTP_DEFINES;
}

export const SERVER_HTTP_EXTERNAL_DEPENDENCIES = [
  "ssh2",
  "node-pty",
  "undici",
  "axios",
  "form-data",
  "combined-stream",
  "proxy-from-env",
  "follow-redirects",
  "yazl",
  // Bugfix: node-forge uses dynamic require("crypto"); after inlining into the server ESM bundle,
  // Node reports "Dynamic require of crypto is not supported." Keep it external, matching desktop
  // main/host builds.
  "node-forge",
  "yaml",
  // The services feedback-log compression path uses the CJS package yazl. Inlining it into the ESM
  // bundle leaves a runtime require("fs") call and crashes entry-http at startup. Keep it external for
  // Node's native loader.
  "yazl",
  // Bugfix: node-forge (the appCaCert self-signed CA path) uses a dynamic require("crypto")
  // internally; as in desktop tsup.config, it must stay external for Node's native loader.
  "node-forge",
  // Fix: cloud-content ZIP extraction (services/cloud-content) pulls in the CJS package yauzl;
  // inlining it into the ESM bundle makes entry-http.js fail at load time with
  // "Dynamic require of 'fs' is not supported." As in desktop, keep it external for Node's
  // native loader.
  "yauzl",
];

export default defineConfig({
  // The HTTP server build externalizes and inlines third-party code, so a complete notice set
  // must sit next to dist (the Web/unified distribution copies dist directly).
  onSuccess: async () => {
    await stageThirdPartyNotices(resolve(import.meta.dirname, "dist"));
  },
  entry: { "entry-http": "src/entry-http.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  // Workspace package exports point to .ts source, which Node cannot load directly at runtime; bundle it.
  noExternal: [
    "@zcode/shared",
    "@zcode/rpc",
    "@zcode/services",
    "@zcode/services/node",
    "@zcode/client",
  ],
  // ssh2 / node-pty contain .node native addons and cannot be processed by esbuild.
  // If CJS dependencies such as undici / axios are inlined into the ESM bundle, runtime dynamic requires
  // for assert/util/url fail under Node's ESM wrapper with "Dynamic require not supported." Keep them
  // external for the HTTP server so Node loads them natively; build-remote.ts still inlines them for the
  // single-file remote bundle.
  external: SERVER_HTTP_EXTERNAL_DEPENDENCIES,
  define: createSharedDefines(),
  // esbuild does not recognize es2025 from tsconfig.json; use tsconfig.build.json to remove the warning.
  tsconfig: "tsconfig.build.json",
});
