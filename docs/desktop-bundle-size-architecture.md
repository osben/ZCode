# Desktop Bundle Size Architecture

Desktop packaging uses two clearly separated asset layers:

- The desktop local agent runtime is prepared for the current platform and enters the installer.
- Remote-only assets are produced by `pnpm --filter @zcode/server-cli exec tsx src/packaging/stageRemoteAssetsCli.ts` into `mock-cdn/releases/...` and no longer enter the installer.

## Directory layout

- `packages/desktop/bundled-agents/<platform>/`
  - Minimal runtime directory for the current target platform.
  - Current product paths require only `glm/`.
  - `*-<platform>.tgz` archives are generated alongside for auditing and later remote-distribution reuse.
- `packages/desktop/mock-cdn/`
  - Dev-time remote asset entry point.
  - Stores `source-server-release.json` and the four-platform Source Server archives under `releases/<version>/...`.

## Production

- Production installers no longer contain `remote-assets`.
- Production remote assets are distributed via the CDN version root's `source-server-release.json` and `zcode-server-<platform-arch>.tar.gz`.
- On first install or explicit update, SHA-256/size are verified against the descriptor; local-download mode caches the full archive before uploading, SSH remote-download mode downloads the same archive on the target machine, and both end in the immutable release installer.
- With `ZCODE_ENV=production`, two official CDNs are built in by default:
  - CN: `https://cdn.codegeex.cn/zcode/electron/releases/<version>`
  - Overseas: `https://cdn-zcode.z.ai/zcode/electron/releases/<version>`
- When CI sets `CDN_DOMAIN` / `OSS_PATH_PREFIX`, the production build expands them into the remote CDN candidate list at build time. The repo default for `CDN_DOMAIN` is uniformly `cdn-zcode.z.ai`, overriding the CI global variable, CDN URL prefix validation, OSS upload URL generation, and the CDN warm-up script; the default publish path stays `zcode/electron/releases`. An explicit single domain or comma-separated list still resolves buckets, paths, and warm-up accounts in configured order.
- During migration a comma list can put `3.1.3` on the new CDN first with the old CDN as fallback; once the switch is done, collapse the CI variable to the single new CDN.
- Default priority follows "app language + local timezone":
  - `locale` zh with a UTC+8 timezone: CN CDN first, overseas CDN as fallback.
  - Otherwise: overseas CDN first, CN CDN as fallback.
- If a `CDN_DOMAIN` list was injected at build time, the CI list order is used as-is, without re-sorting by language/timezone.
- `ZCODE_ENV=test` defaults to the intranet test asset root: `http://intranet.example.invalid:12345/ssh-remote-assets/<version>`. CI's `build:remote:assets` job syncs the descriptor and four archives there.
- `remoteCdnBaseUrl` is still overridable by env var; once set explicitly, only that custom base is used — no `ZCODE_ENV` defaults or production regional routing.
- SSH remote-server download mode downloads and verifies the full archive in a remote temp directory, installs to `~/.zcode/server/releases/`, and switches atomically via `current.json`.

## Switching to the public CDN in dev

- Dev defaults to `mock-cdn/releases/<version>/...` written by this round's Source Server staging.
- To force the public CDN in dev, set `ZCODE_DEV_REMOTE_ASSET_USE_CDN=1`.
- With it on, remote deploy stops reading `mock-cdn` and goes straight into the descriptor/CDN + local archive cache chain.
- Without `ZCODE_REMOTE_ASSET_CDN_BASE_URL`, the regional routing rules above still generate the "primary CDN + fallback CDN" candidate list.
- `ZCODE_REMOTE_ASSET_CDN_BASE_URL` can point at a custom CDN base.
- `ZCODE_REMOTE_ASSET_CACHE_DIR` overrides the remote cache directory; e.g. point a dev run at the production `~/Library/Application Support/ZCode/remote-assets-cache` to reuse only the remote asset cache without switching Electron `userData`.
- These remote-asset env vars can come from the shell or from `.env.local` at the repo root or under `packages/desktop`; shell variables win.
- To launch "desktop dev + production remote SSH download/cache chain" in one command, use `pnpm dev:desktop:remote-prod`.

## Source Server preparation chain

1. `pnpm --filter @zcode/server-cli exec tsx src/packaging/stageRemoteAssetsCli.ts` builds the Server CLI/Core and the Agent bundle.
2. Target Node, node-pty, official plugins, and native tools are collected for linux/darwin × x64/arm64.
3. One full archive per platform, plus the unified `source-server-release.json`.
4. Dev and production share the same archive install contract; no loose components, wrappers, or legacy manifests.

Desktop and remote share one compiled `zcode.cjs`; the platform-specific Node-embedded native `zcode-agent` is no longer downloaded:

- `scripts/build-desktop-agent-cli.mjs` builds `apps/zcode-cli/packages/cli/dist/zcode.cjs` plus the official plugin runtimes Dev requires (node-repl-host, Browser Use client, simulator), validating them. `pnpm dev:desktop` runs it after `pre-dev`; the dev resolver prefers the in-workspace bundle, and `stageRemoteAssetsCli.ts` gets the Agent bundle through it too.
- Desktop packaging's `prepare:agent-bundle` writes `zcode.cjs` and the official plugin seed assets into `packages/desktop/bundled-agents/<platform>/glm/`, copied into the installer by electron-builder.
- `scripts/download-glm.mjs` and desktop `prepare:glm` remain manual compatibility fallbacks only — not part of default Dev, desktop packaging, or remote asset preparation.

## Resources forbidden from the installer

- Non-target-platform natives inside the local agent directory
- Non-target-platform native packages/prebuilds inside `node_modules`
- Optional native dependencies already bundled for the renderer that desktop Node never loads — currently the `@napi-rs/canvas*` declared by `pdfjs-dist` for Node
- `node-pty/build`, `node-pty/bin`, and non-target `node-pty/prebuilds/<platform-arch>`; the desktop package keeps only `node-pty/prebuilds/<target-platform-arch>`
- `@lydell/node-pty-*` packages used only to prepare the target prebuild; Linux packaging must also exclude these source packages after `beforePack` copies the target binary into `node-pty/prebuilds/<target-platform-arch>`
- `mock-cdn/`
- `*.map`
- `*.pdb`
- `*.tgz`
- `*.tsbuildinfo`
- `docs/`, `doc/`, `man/`
- `example/`, `examples/`
- `test/`, `tests/`, `__tests__/`
- Non-license markdown

## Audit

`packages/desktop/scripts/audit-bundle-size.mjs` runs automatically after the macOS bundle and checks:

- Total `.app` size
- `Resources/*` directory size
- `Frameworks/*` directory size
- Top 30 largest resource entries

Exceeding a threshold fails the build, so size cannot regress silently.

Beyond installer size thresholds, `electron-builder`'s `afterPack` and the post-bundle mechanical audit must also verify:

- No `@napi-rs/canvas*` and no `@lydell/node-pty-*` in the installer
- `node-pty` contains only the prebuild for the current `targetPlatform.key` — nothing for the build machine or other targets
- `.node`, `.dll`, `.dylib`, native helper `.exe`, and node-pty's extension-less helpers are marked unpack in the asar header; they must not remain in `app.asar` as packed payload while also sitting in `app.asar.unpacked`

The asar content audit must invoke the project-pinned `@electron/asar` CLI directly from Node. Never obtain the parsed output via `pnpm exec asar` — pnpm diagnostics such as workspace engine warnings could mix into stdout and be misread as asar entries.

`pnpm-workspace.yaml#supportedArchitectures` only controls which platform dependencies the workspace install may prepare; it is not an installer resource boundary. The final installer resource set is decided by `ZCODE_TARGET_OS` / `ZCODE_TARGET_ARCH`.
