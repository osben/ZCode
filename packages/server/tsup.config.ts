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
  // node-forge uses dynamic require("crypto"); after inlining into the server ESM bundle, Node reports
  // "Dynamic require of crypto is not supported." Keep it external, matching desktop main/host builds.
  "node-forge",
  "yaml",
  // The services feedback-log compression path uses the CJS package yazl. Inlining it into the ESM
  // bundle leaves a runtime require("fs") call and crashes entry-http at startup. Keep it external for
  // Node's native loader.
  "yazl",
  // Cloud-content ZIP extraction uses yauzl, whose CommonJS require("fs") crashes when loaded in the ESM
  // bundle. As in desktop, keep it external for Node's native loader.
  "yauzl",
];

export default defineConfig({
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
