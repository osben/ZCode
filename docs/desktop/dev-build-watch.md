# Desktop dev build watcher scope

## Background

Before starting Electron, `pnpm dev:desktop` runs Vite and tsup watch in parallel. The Desktop package directory
also holds generated content such as the E2E cache, the remote mock CDN, built-in Agents and the local CUA
Helper; these are not TypeScript development sources but are scanned by the default `tsup --watch` (watch path
`.`).

When these generated directories are large, the main/host build marker takes long to appear and `dev.mjs` keeps
printing `Waiting for build artifacts`. That log is a waiting state, not an Electron error.

## Goal

The desktop dev watch listens only to the sources and dependencies that trigger main/host/preload/scheduler
rebuilds and excludes generated directories that do not take part in incremental dev builds, shortening first
start and watcher setup time. The watch root must be narrowed at the same time; only setting `--ignore-watch`
still makes tsup glob `.` in full first and does not remove the first-scan cost.

The startup chain is unchanged:

```text
dev:runtime
  +--> vite dev
  +--> tsup --watch + generated-directory blacklist
  `--> dev.mjs
          `--> start Electron after the main/host/preload markers appear
```

## Blacklist

Paths relative to `packages/desktop`, used only to exclude local dev watchers; they do not change build,
packaging or runtime resource preparation:

- `mock-cdn/**`
- `bundled-agents/**`
- `.e2e-cache/**`
- `.e2e-artifacts/**`
- `.e2e-home-*/**` (E2E isolated home)
- `dist-cua-helper/**`

These directories can still be written by E2E, Helper or runtime asset flows; writing does not trigger a
Desktop bundle rebuild. `out`, `.git` and `node_modules` keep using tsup's default exclusion rules.

The watch root explicitly covers `packages/desktop/src` and the `src` directories of `services`, `server`,
`shared`, `rpc`, `client`, `provider` and `provider-node`, so workspace source changes still trigger rebuilds.

## Constraints

1. `dev:runtime` and `dev:local-cli` use the same watch root and blacklist, so the standard desktop and the
   remote-control local-cli start paths do not drift.
2. Only chokidar's watch scope changes; tsup entries, output directory, ready marker and the Electron start
   gate are unchanged.
3. The blacklist must use glob form and be quoted in the shell so `*` is not expanded early by the host shell.
4. The ability of workspace source changes to trigger builds must be preserved; if dependency sources later move
   out of the default watch range, add the corresponding source path explicitly and update this spec.

## Acceptance

- Both Desktop watch entries in the package scripts include the full blacklist.
- Related static tests pass.
- The `tsup --watch` log shows each blacklist path under `Ignoring changes`.
- In a checkout with large generated directories, the watcher no longer blocks the ready marker on scanning
  them.
- `pnpm typecheck`, `pnpm lint` and affected unit tests pass.
