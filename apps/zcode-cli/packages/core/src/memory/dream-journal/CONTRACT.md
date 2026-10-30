# dream-journal

Per-run record of what a Dream run changed in project memory, so each change can be inspected and later undone.

Invariants:

- One JSON file per run under `<memoryRoot>/.fork_dream-journal/`; the directory is dot-prefixed so the catalog and index skip it.
- A snapshot is written before the tool that touches the file runs; `finalize` records `after` from disk and drops no-op touches.
- A run left `running` when the lock is free was interrupted; the next `beginRun` settles it from disk.
- Writes are atomic and serialized per memory root. Corrupt files are renamed aside, never overwritten. At most 30 runs and 10 skip rows are kept; skip rows are evicted before any other run.
- Journal failures never fail the Dream run; the runtime adapter (`runtime-adapter.ts`) is the only place that turns them into logs.

Cross-module edges:

- The Dream runtime helper (`runtime/helpers/project-memory-dream.ts`) calls the runtime adapter; the adapter takes a `DreamJournalHost` (logger, clock, file port) instead of runtime internals.
- The recall manifest scanner imports only `DREAM_JOURNAL_DIRECTORY_NAME` to skip the directory.

Known limitations:

- No fsync: run files use an atomic rename without a flush, so a power loss can leave the newest run file missing or stale.
- Symlinked memory files: the snapshot records the target body, not the link; undo writes a regular file.
