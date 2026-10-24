# Auto-update: a newer version supersedes a downloaded package

## Background

The desktop app uses an `electron-updater` generic feed. The running version may be older than a package that
has been downloaded but not installed: for example the process runs `3.1.2`, `3.1.3` is downloaded, and the
user has not yet chosen to restart and install.

In the old state machine, after `update-downloaded` the menu stayed on "Restart to update" and background
polling could only start from `idle`. If the stable feed later advanced to `3.1.4`, the same running process
would not check again and could not replace the installable package with `3.1.4`. There was a similar gap
before download: after detecting but not downloading an update, the state stayed at `update-available`, and
neither polling nor "Check for updates" re-requested the manifest, so users could install only the first version
they saw.

## Target semantics

- The latest server version is the target; the local package is a separate fact. When `update-available`,
  `download-progress` or `update-downloaded` is already visible, a background recheck must not switch the UI
  to `checking`.
- Check once immediately at startup. With no update visible, recheck every 15 minutes; while an update entry
  stays available, recheck every 2 minutes. After a download completes or is cancelled, check again immediately
  if no check is in flight; if a check was already in flight, do not queue another and let the short polling
  interval handle it. After a download failure (from the download Promise or an error event), check again; if
  the failure occurs before the current check settles, wait for it to settle first. Do not recheck after a
  forced-update failure.
- "Check for updates" in the menu must re-request the manifest in `update-available`, not replay a stale
  in-memory version. While downloading, show that download is in progress; if already downloaded and still
  equal to the target, continue installing.
- If a recheck returns a higher version, replace the target version, channel and release notes. If automatic
  download is on and no download is in progress, download the new version; otherwise stay in the discovered
  state and wait for user confirmation.
- If a recheck returns the same version as the current target, do not download again. If it is lower than the
  target or skipped, keep an existing ready package in the ready state; otherwise return to `idle`.
- When the downloaded package version equals the current target, clicking "Restart to update" continues
  installing that package. If the target is newer and the new package is not ready yet, neither quitting nor
  "Restart to update" may install the old package.
- If the replacement download fails while the older ready package still exists, restore the menu to the older
  ready state so users do not lose their installable update.

## Implementation constraints

- Trigger downloads explicitly from the main process: disable `electron-updater` `autoDownload`, then decide in
  the `update-available` event whether to call `downloadUpdate()` based on the ready-package version. A higher
  target may be recorded during a download, but do not start another download concurrently.
- Compare versions using semver coercion (to support strings like `v3.1.4`); if parsing fails, treat differing
  strings as needing a download.
- Start automatic polling from `idle`, `update-available` and `update-downloaded`; keep skipping `checking` and
  real `download-progress` to avoid concurrent downloads. On macOS/Linux, keep automatic installation on quit
  only when the ready package version equals the current target.
- The only install state is held by main in `quitAndInstallPhase`, progressing `idle -> preparing -> installing`.
  A failure enters the terminal `recovering` state and restarts in a controlled way. Confirming installation
  locks the ready package immediately; background manifest requests take no part in install admission. Late
  check results and check failures must not modify the locked package nor be misreported as native install
  errors.
- Download events are first recorded on the corresponding CancellationToken, and `ready` is published only
  after the download Promise settles successfully. Installation does not wait on network work: a pending
  download is not ready, and an existing ready package does not depend on background checks finishing. Cancelled
  or failed downloads must not publish a stale ready state.
- After `preparing` starts, no new check, download or update result is accepted. Host/Agent cleanup cannot be
  reverted. Preparation failures, staging errors during preparation and native install failures after handoff
  all trigger a controlled restart and never return to an old window whose services have been destroyed.
  Recovery runs only once; repeated errors do not restart again.
- The return of `quitAndInstall()` does not mean installation has finished. After a successful handoff the phase
  stays `installing`, native `before-quit` is allowed through, and repeated install commands do not re-enter.
  Real install errors and errors with a check origin are handled separately, without guessing the origin from
  the current menu.
- This only changes the desktop main-process update lifecycle. It does not change the Host/Agent exit barrier,
  the mobile shared-host attachment, or the desktop continuous / web remote replayable message boundaries.

```text
Download Promise settles successfully → ready → confirm install / lock package → preparing → installing → quit
                                              background check does not take part in waiting  │          │
                                                                                               └─ failure ─┴→ recovering → restart and recover
```

## Regression verification

- Unit tests cover quit being allowed through after macOS/Linux install calls return, idempotence of repeated
  commands, and retry back to ready after synchronous or asynchronous failures.
- Unit tests cover a pending check not blocking ready-state installation, ready publication after download
  completion, target locking after preparation, native errors and duplicate events. The Electron smoke test
  covers new-version events and duplicate IPC during preparation, confirming that after Host/Agent cleanup the
  install is still handed off only once.
- The Electron process-level smoke test uses the real `MacUpdater.quitAndInstall()`, renderer IPC and
  `app.before-quit`, and controls native staging callbacks so they arrive after the install call returns. It
  asserts the install is initiated once and the process exits normally. The native updater uses fixtures and
  does not replace the user's app or perform a real ShipIt install.
- ShipIt file replacement and automatic restart for signed release packages still need pre-release
  verification; the smoke test does not substitute for it.
