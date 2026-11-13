# Windows Installer Overhaul Spec

## Goal

This spec constrains four user-facing problems of Windows NSIS in-place updates:

1. A managed update must not delete unrelated files in the installation directory because of NSIS's default whole-tree cleanup. Upgrades from historical versions without a manifest are not guaranteed.
2. For update chains that use an ownership manifest (versions after this change), insufficient disk space, insufficient permission and file-cleanup failures must show the real stage and reason, not a generic "ZCode is running" message. Historical uninstallers are not covered by this compatibility promise.
3. The installer shows verifiable stage steps and keeps an offline log.
4. After an update the Start menu shortcut, desktop shortcut and Windows AUMID stay consistent. A shortcut the user deleted is never silently recreated.

## Scope and Invariants

- `electron-updater` keeps handling download and verification; the Windows target stays NSIS. No migration to Squirrel or MSIX.
- The installation directory is the application execution directory, not a data directory. Only when the previous version has no ownership manifest (the old uninstaller may still wipe the whole tree) does `.zcode` data inside the installation directory or its subdirectories block an in-place install. A new uninstaller that supports the manifest deletes only declared files and no longer blocks on `.zcode`.
- Only files the current version explicitly declares as application-owned may be deleted. Unknown files are preserved. On conflict the new application file wins.
- Manifest cleanup rejects absolute paths, `..` escapes and the uninstaller's own entries. Reparse point/junction hardening and an access budget for the interactive directory-protection scan are follow-ups.
- The installer logs on a best-effort basis for implemented stages. A log write failure must not block installation. Logs must not contain the full raw command line, user data content or credentials.
- A shortcut is repaired in place only when it exists but its target is invalid or inconsistent. A missing shortcut keeps respecting the user's deletion.
- In packaged builds the main-process AUMID equals the electron-builder `appId`. Development builds keep a separate AUMID.
- macOS and Linux never enter the Windows install handoff branch. The desktop continuous and mobile web-remote replayable state links do not leak into each other.

## Version Boundary and Forward Convergence

- `.zcode-install-manifest` is the capability marker between new and old uninstallers; numeric versions are not compared. Before calling the old uninstaller, the installer checks whether the old installation directory contains the file. Present: manifest cleanup, no `.zcode` protection scan. Missing: treated as legacy full-cleanup risk and the `.zcode` protection scan runs first.
- The first upgrade from a historical version without a manifest keeps using the old electron-builder uninstaller flow. This is a known limitation: the old uninstaller may wipe the install directory, show native retry copy, or fail to return a classifiable reason. No backup, restore, rollback or custom-uninstaller compatibility layer is added for this path.
- If a historical upgrade fails, the user can complete it by uninstalling and reinstalling or by migrating files manually. This does not change the reliability goal for updates between new versions.
- Each later version converges only failures still observable in the current version. One-time compatibility with every historical install state is not a goal. New guarantees are written into this spec only after real installer/uninstaller smoke coverage.

## Install State and Order

```text
update-downloaded
      |
      v
prepare app exit ----(fail/timeout)----> updater error (button kept, retryable)
      |
      v
launch NSIS
  CHECK_APP_RUNNING
      |
      v
  check old install dir for manifest capability
      |
      +----(no manifest)----> `.zcode` protection scan
      |                           |
      |                           +----(data)----> blocked
      |                           |
      |                           v
      |                      legacy best-effort (native retry/error copy allowed)
      |
      +----(manifest)----> ownership cleanup (skip `.zcode` scan)
                                  |
                                  +----(lock/ACL/space)----> restore deleted files + cleanup log
      |
      v
extract new files -> repair existing shortcuts -> write AUMID/notify Shell
      |
      v
installer-completed (log available; finish page launches `$INSTDIR\\ZCode.exe` directly)
```

## File Ownership and Migration

### New versions

Packaging generates an installer-readable ownership manifest listing application files relative to `$INSTDIR` (directories are not listed separately). The manifest is installed with the package for the next update. For the recovery boundary of a failed cleanup see "Windows Updates: Preserve Files in the Installation Directory"; no full filesystem transaction is promised for the extract stage or power loss. `customRemoveFiles` handles only manifest entries; unknown entries are not deleted.

### Upgrading from an old version (later incremental design)

When the old version has no manifest, the target design is to move entries that cannot be proven application-owned into a separate temporary backup before calling the old uninstaller, and after the new version is installed restore only entries the new version does not contain. The backup directory is not under `$PLUGINSDIR`; if restore fails, keep the path and write it to the log. The current implementation does not take over electron-builder's outer `uninstallOldVersion` call, so it cannot change the old uninstaller's whole-tree cleanup on the first upgrade from a manifest-less version. The implementation takes effect for later updates between new versions; see `windows-installer-preserve-files.md`.

### Failure and rollback

- A Delete failure in manifest cleanup records the cleanup stage, failure reason and uninstaller PID and returns a nonzero exit code. Files not yet handled stay as they are; before calling the old uninstaller the new installer backs up the managed files on a best-effort basis, and only when a complete backup succeeds are deleted files put back after an old-uninstaller failure. A backup failure counts as no backup: log it and continue installing; a partial backup must not be used for restore. A failed deletion of the backup directory only records the path and must not pop a dialog that blocks installation.
- For updates between managed versions, a nonzero return from the old uninstaller (SHELL_CONTEXT and HKCU paths) is reported by the outer installer as a cleanup failure. electron-builder's five retries are kept, but when they are exhausted a cleanup-failure and retry/cancel prompt is shown; with a complete backup, cancel restores the deleted files; after a failed backup has been discarded, cancel only exits the installer and the prompt must state clearly that no automatic restore is possible — it must not promise a restore that does not exist. "Application cannot be closed" is no longer shown.
- A historical uninstaller without a manifest is not required to return a classifiable error and is not required to back up, restore or roll back.
- Fine-grained Win32 error chains for extract, copy and directory protection are follow-ups. Do not describe them as implemented guarantees.

## Diagnostics and Step Display

- The interactive installer always shows the Details area (overriding electron-builder's default `nevershow`), and the install section's `SetDetailsPrint none` becomes `listonly`. Details show, in order: install start, cleanup stage, extract stage, each NSIS `File` entry, shortcut stage and finalization. Process start and initialization events happen in `.onInit`; the file log is authoritative for them.
- The previous version's uninstaller is a separate process. The outer details first show cleanup start/complete, then replay the uninstaller log after the process returns. The current uninstaller writes each relative path from the manifest it actually tried to delete to `%TEMP%\\ZCode-uninstaller.log`.
- A silent update shows no UI but writes `%TEMP%\\ZCode-installer.log`. The UAC-elevated inner process tries to write `%WINDIR%\\Logs\\ZCode-installer.log` directly. There is no implementation that copies the outer temporary log to Windir by permission. An unwritable log must not block installation.
- Log markers use numeric PIDs and a stage enum, never `$CMDLINE`. Stages: `install-started`, `cleanup-started/completed`, `extract-started/completed`, `shortcuts-started/completed`, `install-finalization-started`, `install-completed`. A managed-cleanup file deletion failure records the relative path and the immediate Win32 error code instead of a fixed `permission-or-disk-space`. The old-install-process close-out records path match, terminate/wait/recheck stages and the PID; a nonzero old-uninstaller exit keeps its original exit code. Fine-grained `reparse-point` and `extract` diagnostics are follow-ups.
- An interactive managed update keeps up to 5 old-uninstaller retries; once they are exhausted this project's cleanup-failure and exit-code prompt is used, differentiated by whether a complete backup exists: with a backup it promises that cancel restores the deleted files; without one it states clearly that cancel only exits the installer and no automatic restore is possible. The real application-process check keeps the original "application cannot be closed" prompt; the silent path relies on the exit code and log.
- The cleanup-failure message box carries `/SD IDOK`. Interactive mode shows the prompt; silent mode auto-confirms and returns exit code `2`. It must not block an unattended update.

## Shortcuts and AUMID

- A Start menu/desktop `.lnk` with a correct target is kept as is, including arguments.
- A `.lnk` that exists with a wrong target is repaired in place, then the stable AUMID is set and `SHChangeNotify(SHCNE_UPDATEITEM)` is sent.
- A deleted `.lnk` is not recreated. The finish page launches the exe in the new install directory directly.
- `app.setAppUserModelId()` uses the production/Preview `appId` in packaged builds and `cn.aminer.zcode` in development.

## Acceptance Cases

| Case                      | Scenario                                                                                  | Must observe                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| WIN-INSTALL-OWNERSHIP-001 | `notes.txt` or a custom directory exists before the update                                | The files remain after the update; application files are replaced                                                                                |
| WIN-INSTALL-OWNERSHIP-002 | Old version has no manifest                                                               | Not guaranteed; the old uninstaller may keep native behavior; migration support is added later only with clear benefit                           |
| WIN-INSTALL-DIAG-001      | Managed cleanup hits a lock/permission/disk error                                         | The cleanup log has stage, classification and numeric PID; the outer installer returns nonzero and shows a cleanup failure                       |
| WIN-INSTALL-RECOVERY-001  | The old uninstaller deletes the main program first, then fails on a file in use           | The main program is restored byte for byte, the locked file and unrelated files are kept, the exit code is nonzero                               |
| WIN-INSTALL-RECOVERY-002  | A backup source file is opened exclusively, handle released after the backup              | The backup failure is logged, the partial backup is discarded, the new payload is still written after a successful old uninstall, exit code zero |
| WIN-INSTALL-RECOVERY-003  | A same-named directory appears where the main program was deleted                         | Restore must not be declared successful; keep the backup and report its path                                                                     |
| WIN-INSTALL-RECOVERY-004  | A complete backup succeeded and the old uninstall succeeds, but deleting the backup fails | The log keeps the backup path, no dialog, the new payload is still written, exit code zero                                                       |
| WIN-INSTALL-RECOVERY-005  | The backup fails and the old uninstall also fails                                         | No restore from the partial backup; the old uninstall's failure exit code is kept; the old version is never claimed intact                       |
| WIN-INSTALL-PROCESS-001   | A `ZCode.exe` process from the old install directory survives                             | The handle path is verified and exit confirmed after termination; same-named processes outside the old install directory keep running            |
| WIN-INSTALL-PROCESS-002   | A candidate process in the old install directory cannot be queried or terminated          | Backup and uninstall have not started; the log has the stage and PID; old-version files are untouched                                            |
| WIN-INSTALL-DIAG-003      | Old version has no manifest, or the extract stage fails                                   | No fine-grained diagnostics guarantee; the native installer result is kept; converge on real problems later                                      |
| WIN-INSTALL-DIAG-002      | Silent `/S` update                                                                        | No UI but stage logs exist; the log PID is numeric and there is no raw command line                                                              |
| WIN-INSTALL-SHORTCUT-001  | Correct / stale / deleted shortcuts                                                       | The correct one keeps its arguments, the stale one is repaired, the deleted one is not recreated                                                 |
| WIN-INSTALL-AUMID-001     | Production and Preview packaged runs                                                      | The main-process AUMID equals the NSIS `appId` and the Shell can index/pin it correctly                                                          |

## Implementation Boundary

Guaranteed now: ownership cleanup, stage and extracted-file lists in install details, per-file cleanup records in the uninstaller log, shortcut/AUMID consistency, all covered by real NSIS smoke. Follow-ups, not current guarantees: a full install transaction, reparse-safe directory scanning, extract Win32 error codes, copying the log to Windir, and cross-version manifest migration.
