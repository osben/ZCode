import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {
  resolveBigModelApiOrigin,
  resolveRuntimeZCodeEndpointOrigin,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
} from "../shared/src/zcodeEndpoint.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const { version } = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const zcodeEnv = env.ZCODE_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
  const endpointEnv = { ...env, ZCODE_ENV: zcodeEnv };
  const endpointOrigin = resolveRuntimeZCodeEndpointOrigin(endpointEnv);
  const oauthOrigin = resolveZaiOAuthOrigin(endpointEnv);
  const oauthClientId = resolveZaiOAuthClientId(endpointEnv);
  // The BigModel OAuth entry must follow ZCODE_ENV, otherwise the test
  // environment sends test accounts to the production authorization page.
  const bigmodelOAuthOrigin = resolveBigModelApiOrigin(endpointEnv);

  return {
    root: resolve(HERE),
    base: "/cn/share/",
    // Share reuses Web's material-icons assets instead of copying the full Web
    // source/dependencies, so dev:web-share and the Docker production build both
    // read icons from the same public assets.
    publicDir: resolve(REPO_ROOT, "packages/web/public"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        { find: "@", replacement: resolve(REPO_ROOT, "packages/ui/src") },
        // String aliases match by prefix, which rewrites subpath imports such as
        // "@zcode/shared/mcp-apps" into ".../shared/src/index.ts/mcp-apps"
        // (subdirectory appended after a file path, ENOTDIR), breaking the
        // web-share build. Use a regex that matches exactly the root import;
        // subpath imports are resolved by @zcode/shared's exports map (also
        // pointing at TS sources).
        {
          find: /^@zcode\/shared$/,
          replacement: resolve(REPO_ROOT, "packages/shared/src/index.ts"),
        },
        // Bugfix: message.tsx's file-link menu statically references useWorkspaceServices and
        // file-menu, which value-import @zcode/rpc, so the read-only share timeline pulls in rpc.
        // The share image does not install it and the Docker build fails to resolve it. rpc has
        // no third-party deps and the share page never reaches that branch without services, so
        // point directly at source (the Dockerfile copies rpc/src).
        {
          find: /^@zcode\/rpc$/,
          replacement: resolve(REPO_ROOT, "packages/rpc/src/index.ts"),
        },
        // Bugfix: shared/app-control value-imports the session-control contract. The image copies
        // only that package's source (its sole third-party dep, zod, is already installed by shared),
        // and without this alias the Docker build fails to resolve it.
        {
          find: /^@zcode\/session-control\/contracts$/,
          replacement: resolve(REPO_ROOT, "packages/session-control/src/contract.ts"),
        },
        // The share image does not install @zcode/ui (it would pull in the
        // services/rpc closure), so subpath imports must point at source files
        // explicitly.
        {
          find: "@zcode/ui/useTheme",
          replacement: resolve(REPO_ROOT, "packages/ui/src/useTheme.ts"),
        },
        {
          find: "@zcode/shared/zcode-protocol-v4",
          replacement: resolve(REPO_ROOT, "packages/shared/src/zcode-protocol-v4/index.ts"),
        },
        {
          find: "@zcode/shared/test-ids",
          replacement: resolve(REPO_ROOT, "packages/shared/src/test-ids.ts"),
        },
        // 分享管理页复用的基础控件；只依赖 radix-ui / cva / lucide，均在 share-ui 依赖闭包内。
        {
          find: "@zcode/ui/button",
          replacement: resolve(REPO_ROOT, "packages/ui/src/components/ui/button.tsx"),
        },
        {
          find: "@zcode/ui/dropdown-menu",
          replacement: resolve(REPO_ROOT, "packages/ui/src/components/ui/dropdown-menu.tsx"),
        },
        {
          find: "@zcode/ui/alert-dialog",
          replacement: resolve(REPO_ROOT, "packages/ui/src/components/ui/alert-dialog.tsx"),
        },
        {
          find: "@zcode/ui/conversation-share-readonly",
          replacement: resolve(REPO_ROOT, "packages/share-ui/src/index.ts"),
        },
        // The login card needs provider icons (svg resolved via the
        // @ -> packages/ui/src alias). This module only depends on
        // shared/lucide/cn, keeping the services/rpc closure out of the share
        // image.
        {
          find: "@zcode/ui/oauth-provider-icon",
          replacement: resolve(REPO_ROOT, "packages/ui/src/lib/oauthProviderIcon.tsx"),
        },
      ],
    },
    define: {
      __ZCODE_VERSION__: JSON.stringify(version),
      __ZCODE_COMMIT__: JSON.stringify(env.ZCODE_COMMIT || "unknown"),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(endpointOrigin),
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(endpointOrigin),
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(oauthClientId),
      "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(oauthOrigin),
      "import.meta.env.VITE_BIGMODEL_OAUTH_ORIGIN": JSON.stringify(bigmodelOAuthOrigin),
    },
    build: {
      outDir: resolve(REPO_ROOT, "packages/web-share/dist"),
      emptyOutDir: true,
      sourcemap: mode === "production" ? "hidden" : true,
    },
  };
});
