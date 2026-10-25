# ZCode Lite Static Distribution

> Implementation plan (2026-07-09), partially shipped. The server and plain-Web bootstrap
> tasks below are in the tree; the build/packaging script and artifact layout never landed
> and remain open. Product spec: `docs/zcode-lite-static-distribution.md`.

**Goal:** Build a static-source ZCode Lite artifact that users install from an intranet file
server (a plain static file service, not an npm registry) and run as a local Web app.

## Constraints

- The build script must not upload or push artifacts; the upload target is one-off.
- ZCode Lite uses the user's installed Node.js; no bundled Node runtime.
- Default serve host `127.0.0.1`, automatically selected free port. `--host 0.0.0.0` implies
  token-protected access and no automatic browser open.
- Lite Web uses the plain Web same-origin `/ws` path only; `/remote` relay and replayable
  semantics are unchanged.

## Shipped

- HTTP server static + token support (`packages/server/src/http.ts`, `entry-http.ts`):
  `HttpServerOptions.staticRoot` / `spaFallback` / `host` / `authToken`; static serving with
  SPA fallback after API and WebSocket routes; token guard on `/api/*`, `/ws`, `/ws/remote/*`;
  env `HOST`, `ZCODE_SERVER_HOST`, `ZCODE_WEB_STATIC_ROOT`, `ZCODE_SERVER_AUTH_TOKEN`.
  Tests: `packages/server/test/serverInfoHttp.test.ts` (token rejection/acceptance, static
  `index.html` fallback).
- Plain Web bootstrap (`packages/web/src/main.tsx`): fetches `/api/server-info`, uses the
  first workspace path as `initialWorkspaceAbsPath`, stays tolerant when the endpoint is
  unavailable.

## Open (never landed)

- Build script `scripts/build-zcode-lite.mjs` / `pnpm build:lite` producing
  `dist/zcode-lite/install.sh`, `latest.json`,
  `releases/<version>/zcode-lite-<version>.tar.gz`, and `sha256.txt` — staging web/server
  dists, `agent/zcode.cjs`, runtime `node_modules`, `bin/zcode-lite.mjs`, and patched
  `node-pty/prebuilds` (`@lydell/node-pty-*` macOS/Linux prebuilds). None of these exist in
  the current tree.
- Local smoke run of the unpacked lite server and the one-off upload to
  `/Users/dev/shared/zcode/deps/zcode-lite`.
