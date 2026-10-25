# Web App Docker Image Spec

## Goal

Provide a locally runnable, complete Web App Docker image containing the Web static assets, the
`@zcode/server` HTTP/WS service and the ZCode agent app-server. The image is for local Docker
verification and does not replace the desktop remote-control shared-host architecture.

## Runtime structure

```text
browser
  |
  | http://localhost:3030
  v
Node gateway
  |-- static files: packages/web/dist
  |-- /api/* proxy
  `-- /ws* proxy
       |
       v
@zcode/server entry-http
  |
  | stdio
  v
zcode.cjs app-server
  |
  | app data
  v
/data/.zcode
  |-- v2        app settings, task index
  `-- cli       agent session DB, logs, rollout
```

## Image contents

- The base image is set by the `NODE_BASE_IMAGE` build arg, default `node:26.11.1-bookworm-slim`.
- The builder stage runs:
  - `pnpm install --frozen-lockfile`
  - `packages/desktop/scripts/prepare-agent-node-bundle.mjs`
  - `pnpm --filter @zcode/server build`
  - `pnpm --filter @zcode/web build`
- The runtime stage exposes a single port, default `3030`.
- The runtime stage keeps the server's pnpm runtime dependencies, because `entry-http.js` externalizes packages such as `ssh2`, `node-pty` and `undici`.

## Data and workspace

- `HOME=/data`
- `ZCODE_DATA_BASE_DIR=/data`
- `ZCODE_STORAGE_DIR=/data/.zcode`
- The default workspace is `/workspace`

The startup script seeds `/workspace` only when `setting.json` is missing or the workspace list is
empty, and does not overwrite the models, accounts or task data in an existing volume.

## Local use

```bash
pnpm docker:build:web-app
pnpm docker:run:web-app
```

Overridable variables:

```bash
IMAGE=zcode-web-app:dev NODE_BASE_IMAGE=node:26.11.1-bookworm-slim pnpm docker:build:web-app
PORT=3030 DATA_VOLUME=zcode-web-data WORKSPACE_DIR="$PWD" pnpm docker:run:web-app
```

Open `http://localhost:3030/`.
