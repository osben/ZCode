import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import { thirdPartyNoticesVitePlugin } from "../../scripts/third-party-notices.mjs";
import { resolveRemoteFrontendVersion } from "./vite/remoteFrontendVersion.mjs";
// Bugfix: Vite config runs while Node is loading; do not import the @zcode/shared root entry here.
// It contains NodeNext-style source re-exports, so Node looks for real .js files and fails during bootstrap.
import {
  resolveRuntimeZCodeEndpointOrigin,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
} from "@zcode/shared/zcodeEndpoint";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const { version } = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export default defineConfig(({ mode }) => {
  // `.env*` provides link constants only; the startup script or CI injects the current product environment through ZCODE_ENV.
  // The startup script explicitly selects test/production through process.env, which must take precedence over .env files;
  // otherwise share:test could resolve to the wrong endpoint due to stale mode configuration.
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);
  const endpointEnv = {
    ...env,
    ZCODE_ENV: zcodeEnv,
  };
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(endpointEnv);
  const zaiOAuthOrigin = resolveZaiOAuthOrigin(endpointEnv);
  // The ZAI OAuth client_id is a public identifier and may be injected into the browser bundle; secrets/tokens must not use VITE_.
  const zaiOAuthClientId = resolveZaiOAuthClientId(endpointEnv);

  return {
    plugins: [pdfJsCMapsPlugin(), react(), tailwindcss(), thirdPartyNoticesVitePlugin()],
    resolve: {
      alias: {
        // Fix resolution of the @ alias in the UI component library.
        // packages/ui source is bundled directly by the Web app, but Web did not declare @ -> packages/ui/src,
        // so imports such as "@/components/lib/utils" failed to resolve during the build.
        // Add the alias to the consumer's Vite config, leaving component source unchanged and limiting the impact.
        "@": resolve(__dirname, "../ui/src"),
        // Recharts depends on d3-shape@3.x, which requires the Path export from d3-path.
        // Hoisted node_modules may expose an older d3-path@1.x beside d3-shape to Vite prebundling,
        // causing Desktop/Web dev to fail during dependency optimization; point explicitly to the root 3.x entry to fix resolution.
        "d3-path": resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
      },
    },
    server: {
      port: 5173,
      proxy: {
        // During local Web login debugging, OAuth token exchange must first reach the production same-origin API.
        // Keep this dedicated proxy before the `/api` catch-all so it is not sent to the local server and returned as 404.
        "/api/v1/oauth/token": {
          target: zcodeEndpointOrigin,
          changeOrigin: true,
          secure: true,
        },
        // Proxy /ws and /api requests to the server (port 3030 by default).
        "/ws": { target: "ws://localhost:3030", ws: true },
        "/api": { target: "http://localhost:3030" },
      },
    },
    optimizeDeps: {
      // Add React-related entry points explicitly during dependency prebundling to prevent rolldown from returning
      // extensionless paths while resolving `react/jsx-runtime` / `react/jsx-dev-runtime`, which causes UNLOADABLE_DEPENDENCY.
      include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    worker: {
      rollupOptions: {
        // The @pierre/diffs worker entry registers a message listener after import.
        // Its package omits the sideEffects declaration, so production tree-shaking reduces the worker sub-build to 0B.
        // Disable tree-shaking for the worker build only to avoid affecting the main bundle.
        treeshake: false,
      },
    },
    define: {
      __ZCODE_VERSION__: JSON.stringify(
        resolveRemoteFrontendVersion(version, process.env.WEB_REMOTE_FRONTEND_VERSION),
      ),
      __ZCODE_COMMIT__: JSON.stringify(env.ZCODE_COMMIT || "unknown"),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      // Compatibility name for older Web runtime reads; new code consistently uses VITE_ZCODE_BASE_URL.
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
      // Inject public OAuth configuration explicitly so Web does not implicitly depend on source fallbacks in different modes.
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(zaiOAuthClientId),
      "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(zaiOAuthOrigin),
    },
    build: {
      // Do not expose sourceMappingURL in production browser assets, to prevent reconstructing application source on the client.
      sourcemap: mode === "production" ? "hidden" : true,
    },
  };
});
