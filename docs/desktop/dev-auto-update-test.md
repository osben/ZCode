# Desktop dev-mode auto-update verification

## Purpose

Auto update is not initialized in dev mode by default, so everyday joint debugging does not trigger
download, install and restart flows by accident. To verify the auto-update interaction, dev-mode auto update can
be enabled explicitly so the dev app requests the test environment's server manifest endpoint directly.

The test environment already provides:

```text
GET /api/v1/releases/electron/manifest
```

so local verification no longer depends on a mock manifest server.

## Launch

```bash
ZCODE_AUTO_UPDATE_DEV=1 \
ZCODE_AUTO_UPDATE_DEV_VERSION=3.3.1 \
pnpm dev:desktop:test
```

- `pnpm dev:desktop:test` injects `ZCODE_ENV=test`, so the manifest provider requests the test environment
  endpoint.
- `ZCODE_AUTO_UPDATE_DEV=1` explicitly enables auto update in dev mode only; unset, dev mode does not check
  for updates.
- `ZCODE_AUTO_UPDATE_DEV_VERSION` simulates the current client version; for example with the current version
  compared as `3.3.1`, a test environment returning stable `3.3.2` and preview `3.3.3` lets you verify channel
  switching.

## Behavior boundary

- Production packages do not read these dev switches and keep checking updates by packaged config and the
  server manifest provider.
- Dev mode sets `electron-updater`'s `forceDevUpdateConfig` and reads `packages/desktop/dev-app-update.yml` as
  a local cache initialization placeholder; real download URLs still come from the test environment manifest
  response.
- Clicking `重启以更新` (restart to update) in dev mode only restarts the current dev app to verify the UI state
  loop; it does not try to make an unpackaged app take over a real installer.
