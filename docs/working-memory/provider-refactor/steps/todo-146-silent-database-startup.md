# Todo146: Silent startup when no migration is pending

Date: 2026-09-15; follows Todo145 and the user-confirmed startup display behavior. Status: implementation
and code review complete; Electron GUI / target-platform acceptance is outstanding.

## Goal and display contract

- Normal restart with no pending migration: existing Logo -> main window. No title, explanation, timer or text button; no artificial delay.
- Once a pending migration is confirmed: "Updating local data" -> "Saving update" -> "Finishing startup" -> main window. An empty database uses initialization copy (not "historical-record upgrade").
- Lock-wait copy appears only after migration need is confirmed and the process is waiting for a lock. While waiting for a lock before confirmation, or when no migration is needed, keep showing the Logo. Errors are always shown, with manual retry where applicable; migrations are never re-run automatically.
- Across databases the overall initialization/upgrade notice is kept. "Saving" appears only during the real commit phase of the last database, as marked by the Host; "Finishing startup" only when the last database is ready or services are being assembled. No completion is announced during an intermediate database's commit or maintenance.
- Once migration-triggered progress is displayed it stays until this startup finishes (no reversion to "Upgrade" during cross-database work, maintenance or service assembly). A refresh restores from the same-generation Host snapshot; a new attempt resets the facts.

```text
SQLite executor checks ledger -> Host aggregates migration facts for this attempt -> Renderer derives silent/migration/error
                                         `-> same-source ARMS facts
No pending work: silent maintenance/service assembly -> same-generation ready + port -> main window
Pending work: show notice/wait for lock/recheck -> existing SQL/COMMIT -> maintenance/service assembly -> main window
```

## Implementation boundaries

- Keep the existing global phase; maintenance becomes a separate `maintaining` phase. Add structured migration facts: kind (`none`/`initialize`/`upgrade`), actual execution count and committed count. Unknown fields never imply that migration is unnecessary.
- Before acquiring the lock the executor reads the ledger as a display preflight; on BUSY it stays "unknown" and uses the existing lock-wait path. After taking the lock it reads the real ledger again before executing. The preflight authorizes nothing and does not change frozen SQL, checksums, migration IDs or the per-database transaction boundary.
- The Host aggregates by internal database ID. Required migration kind is stable within an attempt; execution/commit counts are summed from the latest snapshot per database (duplicate phase notifications are not accumulated). Facts survive service assembly, failure and refresh; a retry clears them.
- New CLI facts are optional protocol fields (old notifications stay parseable); no new storage control commands to older remote hosts. Mobile stays on shared-host; desktop-continuous and web-remote-replayable unchanged.
- Within one Host attempt, successful preparation is reused for the same CLI-reported, normalized real database path. Only Workers that completed successfully, closed and exited are registered; failed attempts, retries and new Hosts do not reuse old completion sets. After the dedicated handshake says `reuse`, a duplicate path is not reopened/migrated but still needs exit confirmation. No promise to eliminate all CLI bundle startup overhead.
- Normal startup mounts no timer or body copy; `RootStartupLoading` reuses the Logo and theme; zh/en kept in sync; error pages keep recovery actions.
- ARMS keeps total preparation duration and the existing disk-statistics scope and adds migration kind and actual execution/commit counts (to tell "no migration" from "work completed by another process"); no periodic network request or disk scan.
- No permanent migrated marker that skips database checks; no removal of existing maintenance or change to SQLite lock policy. No claim that "no migration" means zero I/O or millisecond startup.

## Acceptance cases

| ID          | Scenario                                                         | Assertion                                                                                                                           |
| ----------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| SILENTDB-01 | Migration complete; restart while holding a write lock           | Logo visible with no body text/buttons; Root not mounted early; enters after release                                                |
| SILENTDB-02 | Empty/old database                                               | initialize vs upgrade distinguished; shown only after migration need is confirmed; ready only after COMMIT/close                    |
| SILENTDB-03 | Another process holds the lock and completes remaining migration | this connection does not rerun it; migration need existed, execution/commit counts are 0                                            |
| SILENTDB-04 | SQL fails midway                                                 | error shown; execution count may be nonzero, committed count 0; manual retry starts a new attempt                                   |
| SILENTDB-05 | Mixed databases and reload                                       | shown when only one database needs upgrade; notice not reversed during maintenance/next database; same-generation snapshot restored |
| SILENTDB-06 | Same real session database, different cwd                        | prepared only on first success; different databases reached via relative paths do not merge; failure not reused                     |
| SILENTDB-07 | ARMS                                                             | kind/execution/commit facts share the Host source; existing total duration and disk statistics kept                                 |
| SILENTDB-08 | Chinese/English and themes                                       | normal startup shows no text; error/migration copy only for the corresponding real facts                                            |

E2E continues in the `conversation-session-database-startup` pending spec. No real user DB and no 20 GB performance test.

## Implementation and verification record

- Final app regression 144 cases / 11 files; six task-preparation cases after adding repeated lock contention around the preflight; earlier expanded regressions: relay, disk, service waiting 54 cases / 12 files; repository expansion 110 / 4 files. CLI async-migration and session-store 52 / 2; frozen SQL and crash recovery 7 / 2. Only preflight/notifications changed: task-database migration definitions and all session-database migration SQL are byte-identical to HEAD; checksum calculation and locked-ledger rechecks remain.
- Root typecheck passed; lint 0 errors / 45 warnings; architecture 0 violations; Desktop E2E typecheck, CLI adapters/bootstrap TypeScript build, desktop tsup/Vite and CLI bundle build passed.
- Isolated real built-in Worker probes: empty task DB 3/3, empty session DB 22/22; reopening reports `none + 0/0` with the ledger unchanged; reuse sends only path/completion frames. No user DB touched.
- React mounted tests: no body/timer while silent, timer starts only after migration is confirmed, failure cleans up the timer, retry clears display; intermediate multi-database commit/maintenance shows no global save/completion.
- Review fixes: publish committed facts immediately after a successful COMMIT (a later close failure cannot zero the count); publish lock-wait state independently for each preflight and post-lock stage so unknown waits do not hide a confirmed migration notice; check Worker exit after async `realpath` to avoid a late writeback.
- E2E (silent lock wait, refresh, Host recreation, full no-text DOM check after lock release) was updated and executed but failed before creating a browser session: `session not created: Chrome instance exited` (report `packages/desktop/.e2e-artifacts/desktop-e2e-20260915073633586-p297237-e0c4161e03b58901/summary.json`); the pending test was not promoted. Not tested: Windows/macOS, mobile remote control, ARMS backend ingestion.
- Silence is a display contract only: database checks and existing maintenance still run; cache reuse covers only successful preparation within one attempt, not skipping checks across restarts. No decrease in total migration time or memory is promised; disk-sampling frequency is unchanged. Logs: `/tmp/zcode-silent-startup-*.log`.
