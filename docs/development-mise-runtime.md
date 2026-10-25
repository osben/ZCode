# mise dev runtime

## Background

The repo root and `apps/zcode-cli` both need consistent Node/pnpm versions. Root and the Agent subproject uniformly use Node `26.11.1` and pnpm `12.14.0`. CI, Docker, and local development should run the same 26.x baseline so version drift surfaces before the Electron, Vite, or Agent build stages.

## Goals

- `mise install` prepares the dev runtime after entering the repo.
- `mise run dev` starts the desktop test environment by default.
- `mise run dev` uses an isolated data root, sharing no account credentials, settings, or task index with the installed app.
- Stable aliases exist for common web, desktop-production, remote-debug, and verification commands.
- Existing pnpm scripts keep their real execution logic; mise only orchestrates versions and entry points.
- mise is an optional dev entry; the Git pre-push hook does not require it. Pushes use whatever Node/pnpm the current environment provides — see [Pre-push Hook](testing/pre-push-hook.md#开发环境与版本管理工具).

## Conventions

- Node pinned to `26.11.1`, matching the root and `apps/zcode-cli/.node-version`.
- pnpm pinned to `12.14.0`, matching `apps/zcode-cli/package.json`'s `packageManager`.
- pnpm's `nodeLinker`, `overrides`, `patchedDependencies`, and build licenses live in the root `pnpm-workspace.yaml`; `.npmrc` keeps only registry/auth.
- `verifyDepsBeforeRun: false` keeps command execution from implicitly installing; installs use an explicit `pnpm install --frozen-lockfile`.
- Electron downloads during install go through `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` to avoid first-install GitHub-release timeouts.
- Root Vitest launches via `scripts/run-vitest.mjs` with `--no-experimental-webstorage`, so Node 26's native `localStorage` global does not shadow jsdom storage.
- Task entry points still call the existing scripts in the root `package.json`; desktop/web/agent startup semantics do not fork.
- The `dev` task runs `pnpm dev:desktop:test` with `ZCODE_DATA_BASE_DIR=$HOME/.zcode-dev-home`; app data lands in `$HOME/.zcode-dev-home/.zcode/`.
- The dev data directory never copies credentials, settings, task history, or plugin state from the installed environment; the first launch needs a fresh login and configuration.
- `pnpm dev:desktop:test` itself keeps its original data-directory semantics; the isolation belongs only to the `mise run dev` entry.
- Production desktop startup uses `dev-desktop-prod`, which does not inherit the `dev` task's data-dir variables.
- A custom `dataBaseDir` in `$HOME/.zcode/v2/setting.json` overrides this variable via `applyEarlyDataBaseDirBootstrap()` (`setDataBaseDir()` beats env); clear that field first when isolation matters.
- Data isolation does not change the OAuth callback protocol. The installed app and dev both use `zcode://`, so log out of other ZCode instances before logging into dev, or the callback may reach the wrong process.

## Relation to the 3996dcbdb3 rollback

`3996dcbdb3` (revert of the storage-profile series) removed the source Desktop's ability to auto-select `$HOME/.zcode-dev/` when `app.isPackaged=false`, and with it this entry's isolation. Storage profiles no longer participate; the mise entry's `ZCODE_DATA_BASE_DIR` injection is the only isolation mechanism. `$HOME/.zcode-dev/` is a deprecated directory no startup path uses.

## Verification

- `mise install`
- `mise run bootstrap`
- `mise run dev`
- `mise run typecheck`
- `mise run lint`
