# Legacy task snapshot async read (ZCO-39 stage 2)

## Behavior

Reading a legacy task snapshot from `~/.zcode/v2/sessions/{workspaceHash}/` must not block the Host event loop. Imported Claude histories are routinely multi-MB, so a synchronous read plus `JSON.parse` stalls every RPC of the window.

- Candidates are tried in order: the live `{taskId}.json`, then `{taskId}.deleted.json`.
- The first candidate that exists is read with `fs/promises` and parsed. A missing file (`ENOENT`, or `ENOTDIR` for a vanished parent directory) moves on to the next candidate; if none exists the result is `null`.
- Existence is decided by the read itself, not by a separate `existsSync` probe, so a file removed between the check and the read cannot slip through as a read error.
- Any other failure (permission error, invalid JSON) is not swallowed by the reader. Callers keep their existing handling: `readLegacyTaskSnapshot` logs a warning and returns `null`; the imported-history repair path propagates the error.
- A live file that exists but is corrupt does not fall through to the deleted file.

Both call sites share one reader: `readLegacyTaskSnapshot` in `zcodeTaskServiceAdapter.ts` and `readLegacyImportedClaudeHistory` in `importedClaudeHistoryRepair.ts`.

## Acceptance scenarios

1. Only the live file exists: it is returned.
2. Both files exist: the live file wins.
3. Only the deleted file exists: it is returned.
4. Neither exists: `null`.
5. The live file contains invalid JSON: the reader rejects and does not try the deleted file.
6. A candidate under a missing parent directory behaves like a missing file.
7. Existing legacy-snapshot and imported-history behavior is unchanged for callers (same warn-and-null handling, same repair semantics).
