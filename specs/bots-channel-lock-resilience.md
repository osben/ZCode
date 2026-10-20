# Bot channel lock resilience

Status: implemented locally (2026-10-19).

## Product contract

Bot channel polling (Telegram long polling and the shared runtime lock discipline) and bot storage
initialization must survive transient `bot-state.v3.json` file-lock contention. Several app
instances share one user data dir by design; each Telegram update cursor write and each
`bots.getBotStates` read takes the same file lock. Under sustained cross-instance contention a
single 8 s lock wait must never permanently disable a bot.

Rules:

1. **Polling outlives transient storage errors.** `pollBot` keeps retrying on lock and storage
   failures (existing 5 s wait). Only an aborted runtime or a credential failure ends polling.
   Cursor writes stay inside the retried section: a failed cursor write retries the whole poll
   cycle; Telegram `update_id` acknowledgements are still committed only after the business
   callback succeeds.
2. **Offset reads in status and error paths are best-effort.** The runtime status payload's
   `offset` is display-only state derived from storage; the storage owner of the offset remains
   `writeTelegramOffset`. When a status-path read fails (for example the file-lock timeout), the
   runtime logs at debug level, reports `offset: undefined`, and continues the loop. It must not
   convert a display-read failure into a polling-lifecycle failure.
3. **Bot storage initialization retries with a bounded backoff.** The startup chain
   (`ensureBotStorageMigrated` → state read → group synchronization restore) retries the whole
   chain a bounded number of times with fixed delays. Each retry logs a warning; only final
   failure logs the existing error. The chain is idempotent: every step is a read or an
   idempotent restore, and the migration promise resets itself on failure, so a retry re-runs it.

## Owners and event order

```text
pollBot loop (owner: channel runtime)
  acquire polling runtime lock ──► long poll ──► process updates ──► writeTelegramOffset (lock)
        │ on lock/storage error: status(error, offset best-effort) ──► wait 5 s ──► retry
        └─ offset READ failures never leave the loop; offset WRITE failures retry the cycle

startup init (owner: bots service)
  ensureBotStorageMigrated ──► readState ──► restore group sync ──► done
        └─ on error: warn ──► wait ──► retry (bounded) ──► final error log
```

## Acceptance scenarios

- `readTelegramOffset` rejects (simulated lock timeout) while polling: runtime status updates omit
  the offset, the loop continues, and the next successful poll cycle reports the offset again.
- `repo.readState` fails for the first N startup-init attempts and succeeds afterwards: bot
  storage initialization completes and group synchronization restore runs.
- Startup init that fails on every attempt logs the existing `Bot storage initialization failed`
  error once, after the last retry.

## Non-goals

- No change to the shared file-lock algorithm (`atomicFileLock`), its timeout budget, or its
  stale-lock recovery.
- No change to the Weixin/Feishu runtimes: their error handlers do not read lock-protected state.
- No cross-instance deduplication beyond the existing per-token polling runtime lock.
