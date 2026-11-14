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
  installing that package. If the target is newer and the new package is not ready yet, "Restart to update" must not install the old package; an ordinary quit never triggers an install in any version state.
- If the replacement download fails while the older ready package still exists, restore the menu to the older
  ready state so users do not lose their installable update.

## Implementation constraints

- Trigger downloads explicitly from the main process: disable `electron-updater` `autoDownload`, then decide in
  the `update-available` event whether to call `downloadUpdate()` based on the ready-package version. A higher
  target may be recorded during a download, but do not start another download concurrently.
- Compare versions using semver coercion (to support strings like `v3.1.4`); if parsing fails, treat differing
  strings as needing a download.
- Start automatic polling from `idle`, `update-available` and `update-downloaded`; keep skipping `checking` and
  real `download-progress` to avoid concurrent downloads. On all platforms an ordinary quit never triggers an install; only the user's explicit "Restart to update" enters the install flow, and the ready package must equal the current target.
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
Download Promise settles successfully → ready → explicit confirm install / lock package → preparing → installing → quit
                                              background check does not take part in waiting  │          │
                                                                                               └─ failure ─┴→ recovering → restart and recover
```

## Regression verification

- Expected behavior: an ordinary quit in the ready state on macOS/Linux/Windows runs no install preparation, calls no installer and schedules no relaunch. After an install failure, a new process that rediscovers the same pending package must still let an ordinary quit finish normally; this recovery path needs its own acceptance through the real startup recovery entry and cannot be replaced by the ready-state injection scenarios below.
- The deb regression reuses the locked-dependency `DebUpdater` and checks install success, privilege-escalation failure and recovery through an isolated command-execution boundary; it does not run a real package manager on a dev machine. Real Ubuntu deb privilege UI, file replacement and version upgrade need separate real-machine acceptance.
- The current Electron smoke covers a pending check not blocking ready-state installation, new-version events and duplicate IPC during preparation, and native error recovery. Install and Host/Agent cleanup each hand off only once; the historical App unit tests are retired and are not current coverage.
- The Electron process-level smoke test uses the real `MacUpdater.quitAndInstall()`, renderer IPC and
  `app.before-quit`, and controls native staging callbacks so they arrive after the install call returns. It
  asserts the install is initiated once and the process exits normally. The native updater uses fixtures and
  does not replace the user's app or perform a real ShipIt install.
- ShipIt file replacement and automatic restart for signed release packages still need pre-release
  verification; the smoke test does not substitute for it.

### Quit-intent regression entry

`node packages/desktop/scripts/auto-update-install-reentry-smoke.mjs` runs real Electron, the production updater module and the locked electron-updater in an isolated userData:

- Default / `--pending-check` / `--preparing-download-failure`: Mac async install handoff, pending check and duplicate commands during preparation.
- `--native-install-error`: a Mac staging failure recovers with one restart only.
- `--ordinary-quit`: a downloaded Mac package does not block an ordinary quit.
- `--linux-deb`: the real DebUpdater still calls pkexec when non-root with `isAdminRightsRequired=false`; only the command-execution boundary is replaced.
- `--linux-deb --native-install-error`: simulated privilege-escalation failure; after service cleanup it recovers with one restart only.
- `--linux-deb --ordinary-quit`: after the updater initializes, the ready state is injected through the `update-downloaded` event, then it verifies an ordinary quit neither installs nor relaunches. The fixture prepares no persisted pending data and does not pass through `hydratePendingPostUpdateReleaseNotes()`, so it does not cover a new process recovering state from a pending package.

Running the Linux updater branch in macOS Electron does not verify the real Linux authorization dialog, package manager or installed version change.
