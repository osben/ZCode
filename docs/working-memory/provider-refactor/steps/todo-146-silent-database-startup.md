# Todo146: Silent Startup When No Migration Is Pending

Date: 2026-09-15; follows Todo145 and the user-confirmed startup display behavior. Status: implementation and code review complete; Electron GUI/target-platform acceptance remains outstanding.

## Goal and Display Contract

- Normal restart with no pending migration: existing Logo → main window. No title, explanation, timer, or text button; do not add an artificial delay.
- After confirming a migration is pending: “Updating local data” → “Saving update” → “Finishing startup” → main window. Use initialization copy for an empty database; do not call it historical-record upgrade.
- Show lock-wait copy only after migration need is confirmed and the process is waiting for a lock. Continue showing Logo while waiting on a lock before confirming migration or when no migration is needed. Always show errors; provide manual retry when applicable. Do not rerun migrations automatically.
- During cross-database preparation, keep the overall initialization/upgrade notice. Show “Saving” only during the real commit phase of the last database, as marked by the Host. Show “Finishing startup” only when the last database is ready or services are being assembled. Do not announce completion during an intermediate database commit or maintenance.
- Once migration-triggered progress is displayed, retain it until this startup finishes; do not revert to Upgrade during cross-database work, maintenance, or service assembly. On refresh, restore from the same-generation Host snapshot. A new attempt resets the facts.

```text
SQLite executor checks ledger → Host aggregates migration facts for this attempt → Renderer derives silent/migration/error
                                      ↓
                               same-source ARMS facts
No pending work → silent maintenance/service assembly → same-generation ready + port → main window
Pending work → show notice/wait for lock/recheck → existing SQL/COMMIT → maintenance/service assembly → main window
```

## Implementation Boundaries

- Keep the existing global phase; make maintenance a separate `maintaining` phase. Add structured migration facts: kind (`none`/`initialize`/`upgrade`), actual execution count, and committed count. If the fields are unknown, do not infer that migration is unnecessary.
- Before acquiring the lock, the migration executor reads the ledger as a display preflight. On BUSY, retain “unknown” and use the existing lock-wait path. After lock acquisition, read the real ledger again before execution. Preflight does not authorize execution and must not change frozen SQL, checksums, migration IDs, or the per-database transaction boundary.
- Host aggregates by internal database ID. Keep the required migration kind stable within one attempt. Sum execution/commit counts from the latest snapshot per database; do not accumulate duplicate phase notifications. Preserve facts through service assembly, failure, and refresh. A retry clears previous facts.
- New CLI facts are optional protocol fields; old notifications remain parseable. Do not send new storage-specific control commands to older remote hosts. Mobile remains on shared-host; desktop-continuous and web-remote-replayable remain unchanged.
- Within one Host attempt, reuse successful preparation for the same CLI-reported, normalized real database path. Register only Workers that completed successfully, closed, and exited. Failed attempts, retries, and new Hosts do not reuse old completion sets. After the dedicated handshake says `reuse`, a duplicate path is not reopened/migrated but still requires exit confirmation. Do not promise to eliminate all CLI bundle startup overhead.
- Normal startup mounts no timer or body copy. `RootStartupLoading` reuses Logo and theme; keep Chinese/English synchronized. Error pages retain recovery actions.
- ARMS retains total preparation duration and the established disk-statistics scope; add migration type and actual execution/commit counts to distinguish no migration from work completed by another process. Add no periodic network requests or disk scans.
- Do not skip database checks with a permanent migrated marker; do not remove existing maintenance or change SQLite lock policy. Do not claim no migration means zero I/O or guarantees millisecond startup.

## Execution Checklist

- [x] Update the spec, catalog, and coverage matrix.
- [x] Test first: restart without migration, initialization, upgrade, lock competition, rollback of commit facts, Host aggregation/refresh/retry, same-database reuse, no-text and error display, ARMS.
- [x] Add executor-side structured facts and strict protocol support; keep maintenance state separate.
- [x] Host aggregation and reuse on successful preparation.
- [x] Silent UI, fact-driven migration display, both locales, and telemetry.
- [x] Typecheck, lint, architecture gate, frozen-migration regression, builds, isolated runtime probes, and post-implementation review.
- [ ] Electron GUI/target-platform acceptance: E2E was updated and executed, but the environment failed before session creation; this does not count as passed.
- [x] Record results and commit. Report the GUI environment failure honestly; do not promote a pending test or claim success.

## Acceptance Cases

| ID | Scenario | Assertion |
| --- | --- | --- |
| SILENTDB-01 | Migration complete; restart while holding a write lock | Logo visible with no body text/buttons; Root is not mounted early; enter after release |
| SILENTDB-02 | Empty/old database | Distinguish initialize/upgrade; show only after migration need is confirmed; ready only after COMMIT/close |
| SILENTDB-03 | Another process holds the lock and completes remaining migration | This connection does not rerun it; migration need existed, execution/commit counts are 0 |
| SILENTDB-04 | SQL fails midway | Show error; execution count may be nonzero, committed count is 0; manual retry starts a new attempt |
| SILENTDB-05 | Mixed databases and reload | Show when only one database needs upgrade; do not reverse the notice during maintenance/next database; restore same-generation snapshot |
| SILENTDB-06 | Same real session database, different cwd | Prepare only on first success; different databases reached through relative paths do not merge; failure is not reused |
| SILENTDB-07 | ARMS | Kind/execution/commit facts share Host source; retain existing total duration and disk statistics |
| SILENTDB-08 | Chinese/English and themes | Normal startup has no visible text; error/migration copy appears only for corresponding real facts |

Continue using the conversation-session-database-startup pending spec for E2E. No real user DB and no 20 GB performance test.

## Implementation and Verification Record

- Final app regression passed 144 cases across 11 files. After adding repeated lock contention around preflight, six task-preparation cases passed. Earlier expanded regression for relay, disk, and service waiting passed 54 cases across 12 files; repository expansion passed 110 cases across four files.
- CLI async-migration and session-store regressions passed 52 cases across two files; frozen SQL and crash recovery passed seven across two files. Only preflight/notifications changed; task-database migration definitions and all session-database migration SQL remained byte-for-byte identical to HEAD. Checksum calculation and locked ledger rechecks remain.
- Root typecheck passed; lint had 0 errors / 45 warnings; architecture had 0 violations. Desktop E2E typecheck, CLI adapters/bootstrap TypeScript build, desktop tsup/Vite, and CLI bundle build passed.
- Isolated real built-in Worker probes: empty task DB 3/3, empty session DB 22/22. Reopening each reported `none + 0/0`, with ledger unchanged. Reuse sends only path/completion frames. No user DB was touched; no 20 GB performance test was run.
- React mounted tests verified no body/timer while silent, timer starts only after migration is confirmed, failure cleans up timer, and retry clears display. Intermediate multi-database commit/maintenance does not show global save/completion.
- Review fixes: publish committed facts immediately after successful COMMIT so a later close failure does not zero the committed count; publish lock-wait state independently for each preflight and post-lock stage so unknown waits do not hide a confirmed migration notice; check Worker exit after async `realpath` completes to prevent a late writeback.
- E2E was updated for silent lock wait, refresh, Host recreation, and a full DOM-without-text check after lock release. It failed before creating a browser session: `session not created: Chrome instance exited`. Report: `packages/desktop/.e2e-artifacts/desktop-e2e-20260915073633586-p297237-e0c4161e03b58901/summary.json`. The pending test was not promoted. Windows/macOS, mobile remote control, and ARMS backend ingestion remain untested.
- Logs: local `/tmp/zcode-silent-startup-*.log`. Silence is a display contract only: database checks and existing maintenance still run. Cache reuse is limited to successful preparation in the same attempt; it does not permanently skip checks across restarts. No decrease in total migration time or memory is promised; disk-sampling frequency is unchanged.
