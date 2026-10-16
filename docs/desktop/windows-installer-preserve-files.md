# Windows Updates: Preserve Files in the Installation Directory

## Goal

Managed in-place updates may remove only files declared as owned by the ZCode release package. Unrelated files placed in the installation directory by users or other programs must be preserved. The installer must not use `RMDir /r $INSTDIR` to clean up this update path. This specification does not guarantee preservation for legacy upgrades without a manifest.

## Ownership Manifest

- During packaging, generate `.zcode-install-manifest` at the root of the Windows app output directory. It contains one relative file path per line, uses backslashes, is UTF-8, and ends with a newline. The manifest lists only files actually included in the release package.
- Install the manifest with the app package so the old uninstaller can read it during the next update. The manifest itself is also a ZCode-owned file.
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
