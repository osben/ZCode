# Todo 144: Database startup protection (SQL optimization withdrawn from scope)

> Superseded by [Todo 145: prepare databases before entering ZCode](./todo-145-global-database-startup-loading.md),
> which holds the current plan; the workspace loading and Host-deferral scope described in the first round
> is no longer the plan. This file keeps only the outcome of the first round.
>
> Status: scope reduced; on 2026-09-14 the user cancelled SQL optimization. Priority P0, created from
> baseline `hotfix/3.12.2` (`16c3f15c3f`). Full history: `git show 45f808f7:docs/working-memory/provider-refactor/steps/todo-144-large-database-migration-optimization.md`.

## Final scope of this hotfix

The user judged the SQL optimization did not solve the key peak-memory problem, so this hotfix does no
migration SQL optimization and no batching.

- 0020/0022 optimized SQL and the execution allowlist are deleted; the runner executes the frozen original SQL directly.
- Optimization-specific scan-plan tests are removed; original-SQL execution, ledger compatibility, later user edits and failure rollback tests are kept.
- Execution-version and implementation-fingerprint fields are removed; only the existing migration checksum remains. Original SQL, IDs, ledger and database structure are unchanged (`migrations.ts` and `migrations/` have an empty diff against the hotfix target branch).
- The independent Provider JSON read protection stays; no reset of the branch and no change to user databases.
- SQLite and the ledger remain the single source of migration facts; Host/UI only observe stages.
- Loading before entering ZCode (the full-screen startup page) was left to be redesigned and is carried by Todo 145; the workspace-based gate did not meet the goal.

Retained first-round behavior: stage states checking / waiting_for_lock / migrating / committing / ready /
failed with a strictly typed startup notification (never parsing stderr text); SQLite remains the only
migration coordinator (re-check the ledger after taking the lock; Host/UI hold no second migration lock);
lock waits are distinguished from ordinary request timeouts and no ordinary business request is sent during
migration (so watchdog reclaim cannot cause repeated migration); server-side admission, not just a UI mask,
blocks database-dependent sessions, history, Wiki and scheduler/bot; data preparation does not depend on
account, Key, entitlement or optional remote config; different physical databases stay independent; a
failure keeps the database (no empty database, no deletion of WAL/SHM).

Execution budgets (unchanged and carried by Todo 145 section 6): first notification 30 s for the built-in
new Agent; external SQLite write-lock total wait 60 minutes (native busy 25 ms, async backoff 10-200 ms);
no auto-kill timeout on long SQL; elapsed-time hint at 10 minutes; business-period busy timeout and
ordinary RPC timeouts restored/unchanged; custom old Agents keep the old path until a valid startup frame.
Ledger rows with unknown IDs keep their existing compatibility (only known IDs checksum-verified); with
non-standard triggers the frozen original SQL runs.

Host `tasks-index` initialization visibility was split into
[Host tasks-index initialization observability](./host-tasks-index-startup-followup.md); 20 GB
performance measurement, Windows/macOS device verification and release rollout stay separate and are not
replaced by isolated small-database tests.

Related: [startup gate plan](../../../desktop/database-migration-startup-gate-plan.md),
[Todo 109](./todo-109-database-migration-consolidation-and-rollback-readability.md),
[SQLite multi-Agent concurrent startup contract](../../../superpowers/specs/2026-07-15-sqlite-concurrent-agent-startup-design.md),
[session config blocking hotfix](../../../performance/session-config-blocking-hotfix.md) (do not
reintroduce optional remote-config dependencies into the startup gate).

## Verification of the withdrawal (2026-09-14)

Red first (assertion that original SQL runs failed while 0020/0022 were replaced), then green after the
withdrawal: storage, frozen original migration, sync/async runner, real lock and crash recovery 4 files 55
cases; old migrations and old Reader regression 5 files 46; Host protocol and gating 2 files 15; bootstrap
Writable flush 1 file 1. `pnpm typecheck`, CLI adapters/bootstrap typecheck, `pnpm lint` (42 existing
warnings, 0 errors) and `pnpm architecture:check --changed` (0 violations) pass. The first bootstrap run
loaded an old adapters dist that rejected the removed fingerprint field; rebuilding adapters fixed it with
no production fallback. `dep:refs` does not load the CLI adapters project, so deletion boundaries rely on
repo-wide reference scans and cross-package typechecks. User databases were not touched; no large-database
performance measurement or UI E2E was run.

## Earlier first-round implementation (SQL optimization parts withdrawn)

The first round also added: a final-pass finding that, even with pending RPC 0, an old startup request
settling must not let the migration enter idle reclaim (`zcodeAgentProcessManager.test.ts` 40 cases);
crash-recovery tests with real child processes (kill before COMMIT re-migrates, lost notification after
COMMIT does not); `bootstrap/tests/storage-startup.test.ts` (real Writable flush barrier, strict schema,
attempt/databaseId/sequence consistent with diagnostics); a pending E2E
`conversation-session-database-startup.test.ts` (real old database + write lock + page refresh + data
check after release); the source branch was renamed `fix-database-migration-startup` (target
`hotfix/3.12.2`) after fast-forwarding to `5d7165d328`; a pre-push expanded run (971 files, 970 pass) found
6 Root update overlay cases failing because an old `useWorkspaceServices` mock returned its first-argument
path, and the test double's service contract was fixed with no production fallback. Open items from that
round that remain open under Todo 145: multi-window / standalone CLI / SSH-WSL-Docker / Web and phone
shared-host coverage, the exact wait-budget and retry review, lifecycle cases (crash before COMMIT, late
ready, reload), E2E DBSTART-01..18 and platform/theme/language/phone viewport coverage (the desktop E2E was
blocked by an environment SIGTRAP of even a minimal Electron app), 20 GB performance, staged rollout
(migrated -> unmigrated small -> unmigrated large -> multi-process/remote) and the draft MR scope split.
Not in this Todo: batched COMMIT, background half-migration formats, per-read runtime backfill, unconditional
full-database backup, unknown-data cleaning, or editing real user databases.
