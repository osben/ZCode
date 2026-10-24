# Windows installer diagnostics spec

## Goal

For managed updates generated after this version, users can see locatable phases and processes in the installer
details and the file log, and a silent update still records the same set of phase events. The installer uses
`.zcode-install-manifest` to judge the previous version uninstaller's capability instead of relying on a numeric
version: a missing manifest is treated as the full-delete risk of the old uninstaller, and a present manifest as
the selective cleanup of the new uninstaller.

## Phase events

After the installer starts, record in order:

1. `installer-process-started`: records the installer process PID and role (`outer` or `elevated-inner`).
2. `installer-initialized`: records the install mode (`interactive` or `silent`).
3. `install-started`: entering the electron-builder install section.
4. `cleanup-started` / `cleanup-completed`: calling the previous version's uninstaller and handling its result.
5. `extract-started` / `extract-completed`: start/finish of app file extraction; the NSIS `File` entries between
   them show one by one in the details area.
6. `shortcuts-started` / `shortcuts-completed`: handling Start menu and desktop shortcuts.
7. `install-finalization-started`: entering the project's custom finalization (repair of invalid shortcut
   targets, setting the launch target).
8. `install-completed`: the install section returned successfully.

```text
NSIS .onInit
   │
   ├─ initialize log path and write installer-process-started(pid)
   └─ decide silent/interactive mode and write installer-initialized
          │
          └─ install-started
                  ├─ cleanup-started → cleanup-completed
                  ├─ extract-started → File entries → extract-completed
                  ├─ shortcuts-started → shortcuts-completed
                  └─ customInstall: install-finalization-started → install-completed
```

The interactive installer always shows the NSIS Details area and, at the start of the install section, changes
electron-builder's default `SetDetailsPrint none` to `listonly`, so every NSIS `File` entry keeps appearing in
the details area during extraction; phase events are written both to the details area and the log file. The
process-start and initialization events occur in `.onInit` when the details control does not exist yet, so they
are not promised to be back-filled into the page and the file log is authoritative for them.

The old uninstaller runs as a separate process under electron-builder; the outer details area first shows
cleanup start/completion, then after the process returns replays the per-item records of this uninstaller run's
log; the raw log stays in `%TEMP%\ZCode-uninstaller.log` to check which files were actually attempted for
deletion. Historical-version uninstallers may still show only the native retry copy.

## Log path and safety boundary

- Default log: `%TEMP%\ZCode-installer.log`.
- The outer installer can specify a path via `/LOG=<path>`, convenient for support staff to collect logs.
- The UAC-elevated inner process does not accept an inherited `/LOG` path and directly tries to write
  `%WINDIR%\Logs\ZCode-installer.log`, so a low-privilege caller cannot control a high-privilege file path.
  Copying the outer `%TEMP%` log into Windir is not currently promised.
- Each log line contains `pid=<decimal PID>`; a log write failure only affects diagnostics and must not stop the
  install flow.
- The inner-instance criterion of the formal installer must be wired to the `UAC_IsInnerInstance` used by
  electron-builder; it must not default to constant false, and only the smoke fixture forces a simulated inner
  instance. A test replacement is allowed only when the isolated fixture defines it explicitly; the formal
  default behavior must use the real UAC state.

## Uninstaller capability judgment

- Before calling the old uninstaller the installer checks the old `$INSTDIR\.zcode-install-manifest`.
- manifest present: the previous version's uninstaller supports ownership cleanup, and the `.zcode` directory
  protection scan is skipped.
- manifest missing: the previous version may be an old full-delete uninstaller, so scan the install directory
  and subdirectories first; if `.zcode` is found, block the install.
- A missing manifest is not equal to one exact numeric version; it may be a historical version, a manually
  deleted manifest or a damaged install, all taking the conservative path.

## Compatibility boundary

- The ownership cleanup and `cleanup-failed` classification are strong guarantees of this spec only when the
  previous version already carries `.zcode-install-manifest`; the missing-manifest path uses old-uninstaller
  compatibility and the `.zcode` protection.
- When upgrading from a historical version without a manifest, electron-builder's native uninstaller retry and
  native error copy are allowed; this round does not take over its backup, restore or full-tree cleanup.
- In an interactive managed update, if the old uninstaller returns non-zero, electron-builder's
  `appCannotBeClosed` retry prompt may show first, and after the user cancels this project's cleanup error
  shows; a silent update relies on the exit code and the log.
- The cleanup-failure prompt uses `/SD IDOK`: the interactive mode shows an error box, and the silent mode
  automatically takes the default confirmation and returns exit code `2`, without waiting for the user.

## Diagnostics not currently covered

- Rejection of reparse points/junctions by the directory-protection scan, the access budget, loop detection and
  `.zcode-dev` recognition.
- The Win32 error code of each Copy/Extract in the electron-builder extraction phase (phases and file entries
  are covered).

## Silent install

The silent mode has no visible page, but must still record `installer-initialized mode=silent` in `.onInit` and
record the start and completion events in the install section. Later error classification can correlate the
installer process and phase through them.

## Acceptance

- Compile order: when `installer.nsh` loads it only declares the log initialization macro that depends on the
  extension plugin; after electron-builder registers the plugin directory, `customHeader` expands the function,
  and the `preInit` of `.onInit` still calls the same function. It must not rely on the completion order of
  `!addplugindir` and the custom include when the header is generated asynchronously.
- The compile regression must register the NSIS extension plugin directory after the custom include, use the
  real `UAC_IsInnerInstance`, and cover both installer and uninstaller; the ordinary smoke no longer replaces the
  outer judgment with constant false, and only the elevated-inner isolation scenario keeps an explicit
  simulation.
- The Windows NSIS smoke fixture can compile and run interactive/silent installs.
- The log contains the above phases with a positive-integer PID; `/LOG` overrides the default path.
- The elevated-inner test proves a caller-supplied log path is not modified.
