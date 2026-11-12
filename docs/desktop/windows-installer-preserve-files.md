# Windows Updates: Preserve Files in the Installation Directory

## Goal

Managed in-place updates may remove only files declared as owned by the ZCode release package. Unrelated files placed in the installation directory by users or other programs must be preserved. The installer must not use `RMDir /r $INSTDIR` to clean up this update path. This specification does not guarantee preservation for legacy upgrades without a manifest.

## Ownership Manifest

- During packaging, generate `.zcode-install-manifest` at the root of the Windows app output directory. It contains one relative file path per line, uses backslashes, is UTF-8, and ends with a newline. The manifest lists only files actually included in the release package.
- Install the manifest with the app package so the old uninstaller can read it during the next update. The manifest itself is also a ZCode-owned file, but the cleanup walk skips its self-referencing entry so the currently open metadata is not deleted; a later install still writes a new manifest.
- `customRemoveFiles` deletes files listed in the manifest only; it must not remove the installation directory root or any unlisted files/directories. On deletion failure, immediately stop the old uninstaller and preserve remaining files for the installer to report the failure.
- If the manifest is missing or unreadable, use a migration-safe policy: the current uninstaller deletes no files from the installation directory, continues installation, and leaves old-version files in place. Note that an initial upgrade from a version without a manifest still runs the old uninstaller first; that uninstaller may recursively delete the entire directory. This specification does not promise preservation of unrelated files on that path; a separately implemented, rollback-capable legacy migration is required.
- The packaging process generates the manifest; it is not user input. The implementation must still reject absolute paths and paths containing `..` to prevent a malicious or corrupted manifest from deleting files outside its scope.

## Version Boundaries

- The manifest marks availability of ownership-based cleanup. In-place updates between versions are covered by the strong guarantee starting with the first version that includes a manifest.
- During the first upgrade from a legacy version without a manifest, the old uninstaller may still clean up the entire tree or return a native error message. This specification adds no migration backup, recovery, or rollback for that path; users can upgrade by uninstalling and reinstalling or manually migrating files.
- As versions advance, add protection and diagnostics only for failures that remain reproducible between new versions. Do not attempt one-time compatibility with every historical installation state.

## Compatibility and Boundaries

- Ordinary uninstallation (without `--updated`) continues to use electron-builder's default flow; this specification changes only the cleanup phase for in-place updates.
- Data directories outside the installation directory (for example, `%USERPROFILE%\.zcode`) are outside the manifest and are not cleaned up during updates.
- The manifest lists files only and does not actively delete empty directories, so unrelated files and directory structures remain intact.

## Verification Requirements

- An isolated NSIS fixture must verify: listed old app files are deleted when a manifest is present and unlisted `user-data.txt` is preserved; all old files are preserved when the new uninstaller cannot find a manifest; and if a Windows file handle blocks deletion, the process returns nonzero and writes `cleanup-failed` with a numeric PID. Legacy recursive cleanup by the old uninstaller is outside this phase.
- Use the real NSIS compiler corresponding to electron-builder in the fixture. Do not write to a real installation directory, desktop, Start menu, or product registry.
- The compile fixture keeps the production header order: the custom include loads first and the uninstaller constants of `common.nsh` are defined afterwards; functions that reference the constant are deferred until `customHeader` expands, and the fixture must not define the constant early to mask packaging warnings.

## Recovery from an old-uninstaller cleanup failure

Before calling the old uninstaller, the new installer must read the old manifest from that uninstaller's actual `InstallLocation` and copy the managed files that still exist to a unique backup directory beside the install directory. The manifest is saved separately once first; even if the manifest lists itself, the walk must not copy it exclusively again. No old file may be deleted before the backup completes; if the backup fails, installation stops at once and the old version stays as it was. A legacy installation without a manifest keeps following the legacy boundary above.

When the old uninstaller exits nonzero, restore the deleted files from the backup; originals that still exist are not overwritten, to avoid touching locked files again. When restoring, verify relative paths against the files still present in the backup; Windows NSIS path normalization may return empty for a deleted target, and that must not skip a file to restore or falsely report restore success. After a successful restore the backup is cleaned up and the cleanup failure is reported; after a failed restore the backup path is kept and reported, and the installer must not claim the old version was fully restored. After the old uninstaller succeeds, this run's cleanup backup is removed. The protection targets the uninstall cleanup stage and promises no full install transaction for later extraction failure or power loss.

```text
old InstallLocation + manifest -> full backup -> run old uninstaller
                                      |          |- success -> delete backup -> extract new package
                                      |          `- failure -> put back deleted files -> report cleanup failure
                                      `- failure -> install directory unchanged, stop
```

The prompt for exhausted old-uninstaller retries must describe a cleanup failure and the exit code and must not be replaced by "application cannot be closed"; that prompt stays only for a real process-check failure. Interactive retry/cancel is kept; after cancel the deleted files are restored, and a silent install cancels by default. Both paths keep the installer log. The retry prompt and the final cleanup-failure prompt after cancel follow the installer language and must not show fixed Chinese at the end of an English installer flow.

Acceptance uses an isolated install directory: the manifest lists the main program first, then a deletable file, and last a file opened exclusively. After the old uninstaller runs, assert nonzero, the first two restored byte for byte, the locked file unchanged and unrelated files unchanged; after the handle is released a retry can finish the cleanup. Also test backup write failure, no manifest, successful cleanup, an unwritable restore destination and the exhausted-retry prompt.

The self-referencing manifest regression must include normal cleanup, recovery when the old uninstaller fails after the backup, and deleting the backup after a successful cleanup.

### Self-reference compatibility of old uninstallers

The uninstaller of an old full package may not skip the manifest it is reading. The new installer must first keep the original manifest and the managed files; after a successful backup it atomically replaces the manifest for the old uninstaller with one that has only the self-reference removed; if the backup or replacement fails, the old uninstall must not start. On cleanup failure the original manifest bytes are restored even if the manifest file still exists. The full-package regression covers an upgrade with the original old uninstaller's self-referencing manifest and byte-for-byte identity of the original manifest after a failure.

Isolated Windows 11 x64 full-package verification this round: after adding a self-reference to the manifest of the original 3.16.2, the old implementation's upgrade returned 2; with the fix, the full NSIS installer restored 1,430 files and the original manifest bytes when the auto-update cleanup failed, then the original upgrade succeeded, and a reinstall over it with the new self-referencing manifest also succeeded. The managed main program, app.asar and tools match the full payload hashes, unrelated files are kept, and the temporary backup is cleared on success. The installer is not configured with the official signature, so this result says nothing about the official signing trust chain, power loss or extraction-failure rollback.
