# Auto download and install updates

## Background

The Electron auto-update dialog lets the user choose "download and install updates automatically from now on".
The preference must persist in global settings and stay consistent with the same-named switch in the settings
page. The standalone update window does not mount the full workspace services, so it cannot depend on the UI
layer's `settingService` directly.

## Behavior

- New setting `autoDownloadAndInstallUpdates`, off by default.
- In the "not downloaded" state, the update dialog shows a left-aligned checkbox above the bottom button:
  `以后自动下载并安装更新` (download and install updates automatically from now on).
- The settings page general group shows the same switch.
- When the setting is on and an available update is detected, the main process automatically calls the current
  download flow.
- While downloading, the main update entry shows only progress/loading and cannot be clicked to open the update
  dialog.
- After download completes the user clicks `重启以更新` (restart to update):
  - with no running Agent session, run the existing `quitAndInstallUpdate()` directly;
  - with running tasks, first warn that the app will quit and restart and in-progress tasks will be
    interrupted; run the update after the user confirms.

## Architecture

- Setting persistence keeps using `AppSettings` and `settingService`.
- The main-process `autoUpdater` reads the setting on the `update-available` event and triggers the download,
  independent of whether any renderer window is open.
- The standalone update window reads/writes the auto-update preference through a narrow platform interface and
  does not expose the full setting service.
- The pre-restart task check reuses the existing `IPlatformService.getDesktopSessionActivity()`, so the UI layer
  neither reads the task store directly nor reaches into service implementations.

## Verification

- Unit tests cover: settings schema default and patch; auto-download starts when an update is detected with the
  preference on; the dialog checkbox writes the setting and triggers download for the currently available
  update; the main update entry is disabled while downloading; the restart button asks for confirmation when
  tasks are running.
- `pnpm typecheck` and `pnpm lint` still run.
