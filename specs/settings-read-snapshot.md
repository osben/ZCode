# Settings Read Snapshot and Logging

Owner: `packages/services/src/setting/settingService.ts` (main `setting.json`) and
`packages/services/src/setting/forkSettingsSidecar.ts` (`fork-settings.json`).

## Problem

No file watcher covers `setting.json`: the desktop main `settingsFile` (desktop/src/main/index.ts:587)
is only used once for the startup bootstrap. Change detection therefore uses a stat check.

The per-read `reading settings from` and `read result` lines were already `debug` (gated to the
development environment). The info-level payload lines were the write logs, now fixed as rule 3.

`settingService.get()` is called from many host paths (source server directory, provider
resolution, terminal profile, bots, settings sync, startup reconnect). Each call re-read and
re-parsed `setting.json` and `fork-settings.json` from disk, and emitted per-read diagnostics
that included the full settings payload (recent project paths and other user data). An idle
window produced 1 to 2 reads per second.

## Ownership

- Each settings service instance owns one in-memory snapshot of both files.
- Several instances in one process and in other processes (Electron main, window Host utility
  processes) share the same files. An in-process cache alone would serve stale data, so the
  snapshot is validated against the on-disk file identity of both files: inode, size, mtime and
  ctime in nanoseconds. This is a change check on the file, not a timer.

## Rules

1. Reads are served from the in-memory snapshot. The first `get()` loads both files. Later
   `get()` calls only stat both files and reuse the snapshot while the identity is unchanged.
   A changed identity (external edit or a write from another instance) reloads the snapshot on
   the next read.
2. Racy timestamps are not cacheable. Some filesystems keep timestamps at coarse granularity
   (FAT/exFAT 2 s, some SMB/DrvFs mounts), so a rewrite of the same size within that granularity
   can leave the identity unchanged. If `max(mtime, ctime)` of a file is within 2 s of the clock at
   stat time, or later, the combined identity of the two files is `null`. A `null` identity is never reused, so the
   next read stats and re-reads both files. Once the files settle, a later read caches the identity
   again. The same rule as git's racy index entries.
3. Writes update the snapshot before they resolve. `update()`, migration writes in `get()`, and
   legacy account connection migration reload the snapshot from disk at the end of the queued
   write, still inside the queue turn, before the promise resolves. Once the written files are
   outside the racy window, a read that follows a completed write performs no disk read. Inside
   the window the next read reloads from disk.
4. Logging (both files use `createServiceLogger`, scopes `settingService` and `forkSettings`):
   - `info` is written only on the first snapshot load of an instance (key count, no values)
     and once per committed `update()` with the patch key names (never values). Migration and
     other internal writes log key names at `debug`.
   - Settings payloads (values, paths, endpoints) go only to `debug`, which is gated to the
     development environment.
   - Reloads triggered by an external change are `debug`.
5. Errors keep their current levels. Error text must not include settings values. A failed read
   yields defaults for that call only and is never cached.

## Acceptance

- 100 consecutive `get()` calls after the first one perform zero disk reads of `setting.json`
  when the files are outside the racy window.
- Inside the racy window, two consecutive `get()` calls each read `setting.json` from disk.
- A `update()` followed by `get()` returns the written value with zero disk reads once the file is
  outside the racy window.
- An external rewrite of `setting.json` is picked up by the next `get()`.
- Tests: `packages/services/test/settingService.test.ts` (describe "settingService read snapshot").
