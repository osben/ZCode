# Desktop server-manifest auto update

## Background

The old desktop client let `electron-updater` read `latest*.yml` on the CDN directly. That suits static
full-rollout releases but not per-device gray release, stable / preview separation, or server-side promotion of
preview to stable. The new client first requests the ZCode server manifest endpoint, then hands the
`latest.yml`-format content returned by the server to `electron-updater` for download, verification and
installation.

The CDN still stores installers, blockmaps and update manifests, but only in versioned directories; CI no
longer overwrites a global stable feed. The server manifest picks a version from the stable / preview state in
the release API and returns absolute CDN URLs pointing at the versioned platform directory.

## Manifest endpoint

The client checking for updates requests:

```text
GET /api/v1/releases/electron/manifest
```

Selection parameters are passed through both query and header:

| query        | header              | Value                                                                                                               |
| ------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `platform`   | `X-Platform`        | a release-service platform name such as `darwin-aarch64`; the server also accepts Node-style names like `win32-x64` |
| `channel`    | `X-Release-Channel` | standard channel `1`; early-access/preview channel `3`                                                              |
| `device_mid` | `X-Device-Mid`      | the uuidv4-style device ID reused by desktop telemetry                                                              |

The response body keeps the electron-builder `latest*.yml` format, for example:

```yaml
version: 3.4.0
files:
  - url: https://cdn.example.com/zcode/electron/releases/3.4.0/macos-arm64/ZCode-3.4.0-mac-arm64.zip
    sha512: ...
    size: 123456
path: https://cdn.example.com/zcode/electron/releases/3.4.0/macos-arm64/ZCode-3.4.0-mac-arm64.zip
sha512: ...
releaseDate: "2026-07-09T00:00:00.000Z"
```

The server should return absolute CDN URLs for download files. If it returns relative paths, the client falls
back to the endpoint origin as the base URL; production responses must not rely on the old CDN feed directory
as an implicit base.

Versioned directories on OSS for Electron artifacts are layered by platform and architecture:

```text
<path-prefix>/<version>/macos-arm64/
<path-prefix>/<version>/macos-x64/
<path-prefix>/<version>/windows-x64/
<path-prefix>/<version>/windows-arm64/
<path-prefix>/<version>/linux-x64/
<path-prefix>/<version>/linux-arm64/
```

Each versioned platform directory uses a `latest.yml` that contains `releaseNotesByLocale`, and the installer
and `.blockmap` upload together with the platform/architecture. Remote `manifest-*.json` stays at the root of
`<path-prefix>/<version>/` and `components/...` stays in the cross-version directory, so remote runtime asset
URLs do not change needlessly. CI no longer generates per-locale or old-client generic-feed copies of the
update manifest.

## Release channels

- stable: for official users. After the CI full-rollout stage sets the release API state to `status=1`, the
  server manifest returns that version for stable.
- preview: for users who opted in to preview updates. After the CI gray stage sets the release API state to
  `status=3`, the server decides by the `device_mid` gray policy whether the preview manifest returns that
  version.
- preview can be marked/promoted to stable on the server. After promotion no installer needs re-uploading; the
  stable manifest returns the same CDN artifacts.

The client only passes channel and device_mid and implements no gray ratio or channel promotion locally.

## CI two stages

1. Gray stage: keeps the existing installer upload, CDN warm-up and release metadata artifacts, and sends
   `status=3` to the release API. This stage does not overwrite the stable CDN feed's `latest*.yml`.
2. Full stage: triggered manually or by rule, reusing the same release metadata and sending `status=1` to the
   release API. It no longer uploads a stable CDN feed; the server manifest returns files from the same
   versioned platform directory.

Installer, blockmap, `latest*.yml` upload and CDN warm-up all target only versioned platform directories.
stable / preview visibility is controlled by the release API state and the server manifest; CI no longer
expresses release state by overwriting a CDN feed.

## Client state machine

"Discover update" and "download update" are separate:

```text
idle -> checking -> update-available -> download-progress -> update-downloaded
```

- `update-available`: shows only the update entry, no automatic download. The menu and title-bar button both
  show that a new version exists. The top-left title-bar entry text uses the `font-medium text-ui-xs` badge
  level, the button uses a minimum height rather than a fixed height, and the expanded width is determined by
  the short localized text; after UI font-size changes the text must not be clipped, the default size stays a
  compact capsule, and the download-state icon entry stays visible.
- Clicking the update entry opens a standalone update window. It carries only the update UI and starts no
  Local/Remote Host or workspaceKey Agent runtime; it reuses the original update dialog content and state
  controller so all buttons, copy, progress and release-notes cache logic before, during and after download are
  strictly identical to the original Dialog. The main-window entry only shows the current update state and
  opens the standalone window; only when the runtime has no desktop window IPC does it fall back to an inline
  Dialog.
- The window has three sections (title, download progress, actions) with a narrow compact width and `16px`
  horizontal padding. The title section is a horizontal flex `logo | title + release time`; the left logo
  reuses `public/icon_512@2x.png`, exactly the same source as the macOS Dock icon, fixed at `56px` (`size-14`),
  with the title and release time as a vertical group centered against the logo. The product icon keeps the
  original rounded corners, transparent margin and proportions, with no extra crop, scale, border or shadow, and
  is a decorative image excluded from screen readers. The window shows no stable / preview channel badge, so
  users do not perceive the update channel in the dialog; the release time sits below the title row and shows
  only the formatted date. The release-notes Markdown data may still be used for other displays such as entry
  hover, but the window no longer expands the release-notes body, heading, collapse control or background card.
  The window uses only neutral surface / border / foreground tokens (no success, brand or accent background),
  buttons are text-only, and the close entry keeps the bottom `稍后` (later); the top-left main-window update
  entry keeps its original success color block, handled separately from the window's neutral visuals.
- The window renders by explicit phase, not by combining several booleans:
  - Before download (`update-available`): shows the release time, no channel badge; bottom shows `跳过此版本`
    (skip this version), `稍后` (later), `下载更新` (download update).
  - Downloading (`download-progress`): hides `跳过此版本` and `稍后`, shows only the progress and `取消下载`
    (cancel download); the progress area adds an `8px` left margin inside the dialog's main padding; the right
    side of the progress bar prefers downloaded/total size formatted `1.0MB / 10.0MB` with one decimal and
    shows no right text when byte data is missing (no residual `0%` percentage); the main-window update entry
    shows a loading spinner without text. `download-progress.version` is an optional protocol field, so the
    renderer must recognize the download state by `kind`, keeping the entry and an opened dialog even if a frame
    lacks a version, and must not unmount the component or close the dialog. After the user clicks `下载更新`
    the renderer must first enter a local "download requested" downloading display; the IPC return of
    `downloadUpdate()` only means the command was received by main, not that the download state was entered. If
    a versionless transition such as `checking` / `idle` arrives briefly afterwards, the renderer reuses the
    last visible update model to keep the dialog until `download-progress` / `update-downloaded` settles. If
    main-side download start fails, the failure must converge back to `update-available` so the user can see it
    and retry, and must not broadcast `idle` directly, which would make both the main entry and the dialog
    disappear.
  - After download (`update-downloaded` / legacy `UpdateReady` ready): shows the release time, no channel badge;
    bottom shows `稍后` and `重启以更新` (restart to update), without `跳过此版本`.
- The renderer update entry and standalone window must first convert `UpdateStatePayload` into a view model via
  a pure state model, then render. The state model uniformly yields `phase`, `displayVersion`, `progressValue`,
  `progressLabel`, `skippableVersion`, `updateChannel` and action-completion judgment; components only handle
  user actions, setting writes and rendering. User-habit boundaries are centralized in the state model: the
  download state is judged by `kind`, not `version`; the window is not auto-closed while downloading; only
  ordinary idle/checking/error states may unmount the update entry; once a download action reaches the next
  state the button lock is released, and cancel/skip releases the lock after leaving the download state.
- At renderer startup both a one-time `getUpdateState()` snapshot and the continuous `onUpdateStateChanged`
  event exist. The snapshot result may return later than events, and a revision must prevent an old snapshot
  from overriding a newer event; in particular an old `idle` must not override an already received
  `update-available` / `download-progress`, or the home update button disappears.
- Before download the user can click `跳过此版本`. The skipped version is persisted per channel; a higher
  version in the same channel prompts again. After download starts the dialog hides `跳过此版本`; a user who
  does not want to continue downloading uses `取消下载`; cancelling a download is not skipping a version.
- `downloadUpdate()` is called only after the user clicks `下载更新`, entering `download-progress` with a
  progress bar; the top-left main-window entry returns to the loading style, continuously indicating download,
  and the download spinner must be visible in both the narrow button and the expanded-text state.
- While downloading the user can click `取消下载`. The client interrupts the current transfer through the
  `electron-updater` cancellation token, clears the downloading state and returns to `update-available`,
  keeping the same version / channel / release notes so the user can retry or close the dialog later.
- After the download completes it enters `update-downloaded`. With no check in flight, it checks the manifest
  once more immediately; if a check is in flight it hands over to the 2-minute short polling. After a download
  failure it returns to `update-available` and checks once more; if the failure occurs before the current check
  settles, it waits for settlement before checking again. A forced-update failure only reports the error and
  does not recheck. When the user clicks `重启以更新`, `quitAndInstall()` is called only if the ready package
  version still equals the current target; if the target is already higher, the old package is not installed.
- After the startup check, with no visible update it rechecks every 15 minutes; while `update-available` or
  `update-downloaded` is still shown it rechecks every 2 minutes. A recheck that finds a higher version
  replaces the current target, and an entry already shown does not switch to `checking`. The menu "check for
  updates" also re-requests in the discovered state without replaying the old target.
- If the user restarts the app after the download completes but before installing, main restores
  `update-downloaded` at startup hydrate from the persisted pending release notes; it restores only when the
  pending version is higher than the current `app.getVersion()`, so a cached package does not prompt
  `下载更新` again. Only after the pending version really equals the current app version are the release notes
  synced to the renderer as post-install release notes.
- The forced-update gate can still reuse the same updater, but starts downloading immediately on
  `update-available`, keeping the blocking-upgrade semantics.

The old `UpdateReady` event is kept for compatible downloaded-state sync; the new UI mainly subscribes to the
continuous `UpdateStateChanged` state.

## Settings

`AppSettings` adds:

```ts
receivePreviewUpdates?: boolean;
skippedElectronUpdateVersions?: Partial<Record<"stable" | "preview", string>>;
```

- `receivePreviewUpdates` defaults to `false` and affects only the desktop auto-update check; Web and mobile
  remote do not read it.
- After the settings page toggles `receivePreviewUpdates`, the renderer notifies the main process immediately
  via `syncAppSettings`. If main is in a switchable state (`update-available` / `idle` / `checking`), it clears
  the old channel's available version and re-requests the server manifest; for example when preview `3.3.3` is
  already shown and the switch is turned off, it re-fetches `channel=stable` and shows stable `3.3.2`. It does
  not interrupt the installation flow while downloading or already downloaded and waiting to install.
- `skippedElectronUpdateVersions` is maintained by the main process; the renderer only asks via IPC to skip the
  current version, so the UI never spells channel semantics itself.

## Compatibility and migration

- Old installers that still check the CDN stable feed via the packaged `app-update.yml` are no longer refreshed
  by the CI full stage. Compatibility for old packages must be carried by a server manifest migration policy, a
  separate emergency release action or the old-feed operations flow, so that new release state is not tied to
  CI static-feed overwrites again.
- New installers use the server manifest provider by default; `ZCODE_UPDATE_FEED_URL` stays as a
  diagnostic/emergency override and must be a complete manifest endpoint URL. When configured explicitly it
  still goes through the server manifest provider and the client overrides the `platform` / `device_mid` /
  `channel` query parameters and corresponding headers; it no longer switches to the old generic feed.
- Post-update release notes, the downloaded-pending-install state and the Windows pre-install resource release
  logic keep the existing implementation.
- The Windows process exit, shortcut and completion-page launch boundaries from `quitAndInstall()` to NSIS are
  in `docs/desktop/windows-update-install-handoff.md`.

## Local debug launch

To test server-manifest auto update locally, first confirm the release service manifest endpoint is reachable:

```bash
curl "http://intranet.example.invalid:3011/api/v1/releases/electron/manifest?platform=darwin-aarch64&channel=stable&device_mid=00000000-0000-4000-8000-000000000000"
```

Then start the desktop app from the repo root. `ZCODE_UPDATE_FEED_URL` must be a complete manifest endpoint URL;
the client overrides the `platform`, `channel`, `device_mid` query and corresponding headers at request time.
`ZCODE_AUTO_UPDATE_DEV=1` enables the update chain inside dev Electron, and `ZCODE_AUTO_UPDATE_DEV_VERSION`
lowers the local app version below the server version so "update discovered" triggers:

```bash
ZCODE_UPDATE_FEED_URL="http://intranet.example.invalid:3011/api/v1/releases/electron/manifest" \
ZCODE_AUTO_UPDATE_DEV=1 \
ZCODE_AUTO_UPDATE_DEV_VERSION=3.3.3 \
pnpm dev:desktop:prod
```

To test the preview channel, turn on the "early access/preview updates" setting and recheck; do not hard-code
the channel into `ZCODE_UPDATE_FEED_URL`, which easily disagrees with the renderer's setting state.

## Verification

- Unit tests cover manifest provider request parameters, stable/preview channel selection, skipping versions,
  discover-without-download, download after click, and forced update still auto-downloading.
- CI config tests cover the gray `status=3` and full `status=1` jobs; upload script tests cover the versioned
  platform/architecture directories and that the stable feed is no longer uploaded.
- `pnpm typecheck` and `pnpm lint` must run.
- If a real installer upgrade cannot be verified in the current environment, the commit notes list the pending
  packaged-build upgrade verification items.
