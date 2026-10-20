# Plugin zip executable bits

Status: implemented locally (2026-10-19).

## Product contract

When a plugin is installed from a zip source (marketplace URL, bundled cache), the extracted files
must keep the Unix permission bits archived in the zip entries. Plugin hook scripts and binaries
shipped inside plugin zips (for example `hooks/run-hook.cmd` in the superpowers plugin) are
registered as hook/exec commands and are spawned directly; without the executable bit every spawn
fails with `EACCES` (or exit 126 through a shell) for the plugin's whole lifetime.

Rules:

1. For each extracted file entry that carries Unix attributes (`externalFileAttributes >> 16`),
   the extractor applies the archived `rwxrwxrwx` bits to the extracted file. `chmod` after write
   is used instead of `writeFile(..., { mode })` so the process umask cannot strip the archived
   bits.
2. Setuid/setgid/sticky bits are not restored; only the low 9 permission bits apply.
3. Entries without Unix attributes (mode bits `0`, typical for zips produced on Windows) keep the
   platform default file mode; the extractor must not force them executable.
4. Existing safety rules are unchanged: symlinks are rejected, encrypted entries are rejected, and
   path/size limits still apply before any byte is written.

## Acceptance scenarios

- A zip entry with mode `100755` extracts to a file with owner/group/other execute bits set; the
  file can be spawned directly.
- A zip entry with mode `100644` extracts non-executable.
- A zip entry with no Unix attributes extracts with the platform default mode.

## Non-goals

- No change to which zip sources are trusted, checksum verification, or the atomic directory
  activation around plugin installs.
- No retroactive repair of already-extracted plugin caches; reinstalling a plugin re-extracts with
  the corrected extractor.
