# Auto-update: A Newer Version Supersedes a Downloaded Package

## Background

The desktop app uses an `electron-updater` generic feed. The running version may be older than a package that has already been downloaded but not installed. For example, the current process may be running `3.1.2`, with `3.1.3` downloaded while the user has not yet chosen to restart and install it.

In the old state machine, after `update-downloaded` the menu stayed on “Restart to update,” and background polling could only start from `idle`. If the stable feed later advanced to `3.1.4`, the same running process would not check again and could not replace the installable package with `3.1.4`. There was a similar gap before download: after detecting but not downloading an update, state stayed at `update-available`, and neither polling nor “Check for updates” requested the manifest again, leaving users able to install only the first version they saw.

## Target Semantics

- The latest server version is the target; the local package is a separate fact. When `update-available`, `download-progress`, or `update-downloaded` is already visible, a background recheck must not switch the UI to `checking`.
- Check once immediately at startup. When no update is visible, recheck every 15 minutes; while an update entry remains available, recheck every 2 minutes. After a download completes or is canceled, check immediately again if no check is in flight. After a download fails—whether the failure came from the download Promise or an error event—check again. If the failure occurs before the current check settles, wait for it to settle before checking again. Do not recheck after a forced-update failure. If a check was already in flight when a download completed or was canceled, do not queue another one; let the short polling interval handle it.
- “Check for updates” in the menu must request the manifest again in `update-available`, rather than replaying a stale in-memory version. While downloading, show that the download is in progress; if already downloaded and still equal to the target, continue installation.
- If a recheck returns a higher version, replace the target version, channel, and release notes. If automatic download is enabled and no download is in progress, download the new version; otherwise remain in the discovered state and wait for user confirmation.
- If a recheck returns the same version as the current target, do not download again. If it is lower than the target or has been skipped, keep an existing ready package in the ready state; otherwise return to `idle`.
- When the downloaded package version equals the current target, clicking “Restart to update” continues installing that package. If the target is newer and the new package is not ready yet, neither quitting nor “Restart to update” may install the old package.
- If the replacement download fails while the older ready package still exists, restore the menu to the older ready state so users do not lose their existing installable update.

## Implementation Constraints

- Explicitly trigger downloads from the main process: disable `electron-updater` `autoDownload`, then decide whether to call `downloadUpdate()` in the `update-available` event based on the ready-package version. A higher target may be recorded during a download, but do not start another download concurrently.
- Compare versions using semver coercion to support strings such as `v3.1.4`; if parsing fails, treat differing strings as requiring a download.
- Start automatic polling from `idle`, `update-available`, and `update-downloaded`. Continue skipping `checking` and actual `download-progress` states to avoid concurrent downloads. On macOS/Linux, retain automatic installation on quit only when the ready package version equals the current target.
