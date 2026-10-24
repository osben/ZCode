# Force Update Client Config

## Background

ZCode Desktop supports remote version gating. When remote config explicitly requires a forced upgrade, Desktop clients below the minimum version must be blocked before the main window is created and guided to update. Without that remote config, do no local version comparison and keep the current startup flow.

## Config field

The remote `GET {activeZCodeEndpointOrigin}/api/v1/client/configs` `data.configs` may add:

```json
{
  "forceUpdate": {
    "minimalVersion": "4.0.0"
  }
}
```

The Desktop main pre-window guard reads the active ZCode endpoint resolved from `ZCODE_ENV` / endpoint override: `pnpm dev:desktop` defaults to the same endpoint as `dev:desktop:prod`, so it hits production; the test environment requires `pnpm dev:desktop:test` explicitly. The same-named field in the static `https://cdn.zcode-ai.com/zcode/config/default.json` is parsing compatibility only and is no longer the guard's fixed read address. Client-config parsing in business services keeps the same field semantics.

## Decision rules

- Compare only when `forceUpdate.minimalVersion` is a non-empty string.
- No forced upgrade when `forceUpdate` is absent, or `minimalVersion` is missing, empty, or not valid semver.
- The local version is the compile-time `ZCODE_VERSION`.
- Compare with semver semantics; local below minimum means force update.
- Prerelease versions follow semver, e.g. `4.0.0-beta.1` < `4.0.0`.
- If both remote and local config reads fail, do not gate; a hook is reserved to skip update checks and enter the UI fully offline. An explicit offline policy, if ever needed, belongs in the Desktop main guard, not the UI Root.

## Product behavior

- On forced update, main shows a standalone small window / system dialog before creating the main window; no main UI, workspace, or settings page.
- The message states only the current and minimum versions.
- Two upgrade paths:
  - Automatic: trigger the existing auto-update check/download; if the update is downloaded, go straight to restart-and-install.
  - Manual: open the website download page, routed by app language to the Chinese or English page.
- After the user closes or handles the prompt, the old client does not continue into the main UI.
- Web / mobile remote control are out of scope; mobile keeps the existing "usable only after a project is opened" semantics, with no new forced-update fallback page or manual-upgrade entry.

## Multi-client boundary

The capability only reads `client/configs` of the current active ZCode endpoint in Desktop main before the main window is created and blocks startup; it does not touch session, task stream, snapshot, queue, owner command, or replayable/continuous message chains. Mobile Web remote control still enters the existing Root through the shared-host attachment; this logic does not spread replayable-restore semantics to the desktop continuous main link or change the mobile remote-control boundary.
