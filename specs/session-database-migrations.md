# Session database migrations (shared `~/.zcode/cli/db/db.sqlite`)

Status: implemented with the upstream 3.16.1 sync, PR 7b. Covers the CLI session-store ledger only; the
services-side task index and project storage are specified elsewhere.

## Scope and owners

- Upstream migration definitions: `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts`,
  `migrations/0020-*.ts` to `0022-*.ts`, and `schema.baseline.sql`. Byte-identical to upstream `0a1fc56d`.
  The fork never edits these files.
- Fork migration definitions: `session-store/fork-migrations.ts`. Exports `FORK_SESSION_MIGRATIONS`,
  `SESSION_DATABASE_MIGRATIONS` (upstream list followed by fork entries; the list the runner executes) and
  `resolveSessionDatabaseMigrations(db)`.
- Historical SQL text for ledger variants: `session-store/fork-ledger-variants/`. Only used to match a ledger row
  that a fork build wrote with a different checksum.
- Runner: `session-store/migration-runner.ts`. Owns the WAL check, startup lock, preflight, ledger checksum checks,
  `previousIds` copies and the call into the shared `@zcode/shared/sqlite-migrations` `migrate`, which owns the
  table-level backup, the single transaction and the `schema_migration` writes.
- Store: `session-store/sqlite-session-store.ts`. `SqliteSessionStore.open` (and its alias `openStartup`) is the
  production entry point. The constructor is private.
- Compatibility sync path (TEMPORARY, remove in the final PR together with the callers): `runSqliteSessionMigrationsSync`,
  `SqliteSessionStore.openSyncCompat`, `createSqliteSessionStore` and `openStartupSqliteSessionStore`. The sync
  path applies the same ledger rules but takes no table backup. Its `migrationResult` has the shared
  `MigrationResult` shape: `applied` lists only the ids whose SQL ran in this open (empty on a reopen), and
  `backupSkipped` is always `true`. `storage-migrate` relies on that shape to build its report.

## Ledger rules

1. The ledger key is the full migration id string (`schema_migration.id`). Ids that share a numeric prefix do not
   collide: upstream `0023_session_soft_delete_outcome` and the pre-PR fork `0023_session_execution_worktree` are
   different keys. The collision is in the numeric sequence, not in the ledger.
2. Checksums are `sha256(sql.trim())`. An id present in the ledger must match the checksum of the SQL the build
   holds for that id, or the open fails with `checksum_mismatch`.
3. Ledger variants: a ledger row may carry a historical checksum that fork builds wrote (see below). The runner then
   pairs that id with its historical SQL text for this open. The ledger row itself is never rewritten.
4. Upstream ids (`000N_*`) are the upstream sequence. The fork never uses numbers from that sequence. Fork ids are
   `9NNN_fork_*`, additive only, and guarded by column existence checks.
5. Fork-only columns of upstream tables carry a fork name (`session.fork_incognito`,
   `session.execution_directory`, `session.execution_branch`). Upstream builds never list them.
6. `previousIds` relocates an id without re-running SQL. Every existing alias must have the same checksum as the
   migration's SQL; the runner copies the row (checksum and timestamp) to the new id.
7. Unknown ids (rows written by the other build or by other fork subsystems) are kept and ignored by the runner.

## Ledger variants (fork, before the runner)

- `0020_provider_model_selection`: the fork commits `ac31c7db` through `32b1525a` translated the SQL comments of
  this migration. Their ledger rows carry `31fdaa50915e6ee967de3d8072a7f98bab64da0ac2864275589e4a2740eda788`
  (verified: the historical SQL hashes to this value). The current upstream checksum is
  `681180b4fcb497e13289b6970021678f24c975efdf3538777541105c5b2b444e`.
- `resolveSessionDatabaseMigrations` runs read-only, inside the startup lock. If the ledger row for `0020` has the
  translated checksum, that one entry is paired with the translated SQL. The shared runner then accepts the
  untouched row. The translated SQL is never executed, because a present row is never pending.
- Consequence: the upstream build still rejects a database whose 0020 row carries the translated checksum; that
  behavior is unchanged from before this PR. Fork builds from this PR accept both checksums and do not modify them.

## Migration ids after this change

| Id                                     | Owner             | Notes                                                                                                                      |
| -------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `0001` to `0022`                       | upstream          | unchanged, pinned in `upstream-migration-checksum-pin.test.ts`                                                             |
| `0023_session_soft_delete_outcome`     | upstream          | adds `session.time_deleted` and `session.last_outcome`; apply is column-guarded                                            |
| `0024_session_database_identity`       | upstream (shared) | creates `zcode_database_identity`                                                                                          |
| `9001_fork_session_incognito`          | fork              | `session.fork_incognito`; apply is column-guarded                                                                          |
| `9002_fork_session_execution_worktree` | fork              | re-homes the pre-PR fork `0023_session_execution_worktree`; `previousIds` with byte-identical SQL; apply is column-guarded |

Fork-owned tables outside this list (`9001_fork_usage_rollup`, created by `ensureForkUsageRollupSchema`) and
`9001_fork_workspace_pins` (services) are not migrations of this list; the runner ignores their ledger rows.

## Upgrade and rollback scenarios

Each scenario is a test in `apps/zcode-cli/packages/adapters/tests/session-migration-history.test.ts`, run on a
copy of a real sqlite file in `tests/fixtures/session-db/`. Fixtures are never migrated in place.

| Scenario                                                                                                    | Fixture                               | Expected                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. DB written by the pre-PR fork build opens with the new build                                             | `fork-head-execution-worktree.sqlite` | Applies `0023_session_soft_delete_outcome` and `0024` only. `9002` copies the old `0023_session_execution_worktree` row, so no column is re-added. Every old row keeps its checksum and timestamp. Seed rows unchanged. A second open applies nothing. |
| B. DB written by pure upstream 3.16.1 opens with the fork build                                             | `upstream-3.16.1.sqlite`              | Applies `9001` and `9002` only. Upstream rows keep their checksums; `time_deleted` and `last_outcome` exist and are not re-added.                                                                                                                      |
| C. DB written by a fork build with translated 0020 SQL opens with the new build                             | `fork-translated-0020.sqlite`         | The 0020 row keeps `31fdaa...` and its timestamp. Only `0023_session_soft_delete_outcome` and `0024` apply.                                                                                                                                            |
| D. Fresh database                                                                                           | none                                  | Every id in `SESSION_DATABASE_MIGRATIONS` applies once, in list order.                                                                                                                                                                                 |
| E. Rollback: the pre-PR fork build reads a database written by the new build                                | output of A                           | Every id the pre-PR build lists keeps the checksum that build computes, so its ledger check passes (checked by replaying                                                                                                                               |
| the ids and checksums, not by running the pre-PR binary). `execution_*` and `fork_incognito` columns exist. |

Known limitation of E: the pre-PR build does not filter `time_deleted`, so sessions tombstoned by the new build stay
visible there until the new build erases them. Accepted: fork erase removes rows physically.

## Soft delete and fork erase

- Upstream `softDeleteSession` sets `time_deleted` with `coalesce`, so the first deletion time is kept and a repeat is
  a no-op. Message and part rows are kept. Session listings and child-session counts filter `time_deleted is null`.
- The fork permanent erase (`repositories/session-tree.ts`, `deleteSessionTree`, see `specs/session-deletion-cascade.md`)
  physically removes an erased tree. Tombstone and erase coexist: a tombstoned row is hidden; an erased row is gone.
- The fork archive state (`time_archived`) is unchanged: listings still exclude archived sessions unless
  `includeArchived` is set, and `updateSession` still writes `timeArchived`.
- `updateSession` writes only the columns the input owns (upstream partial update), which fixes the stale full-row
  overwrite of concurrent title and permission changes.
- Deferred: upstream writes `last_outcome` through `UpdateSessionInput.lastOutcome`. The fork contracts do not carry
  that field yet, so the column is never written by this build (it is read as NULL). Add it with the contracts sync.

## Backup and admission

- The async path runs the shared `migrate` with a table-level backup in `<data root>/backup`. For `:memory:`
  databases the backup goes to the OS temp directory, so the working tree is never written.
- Admission: WAL check, then `BEGIN IMMEDIATE`, then ledger reads under the lock. The preflight that reports the
  migration kind is read-only and needs no write lock.

## Test matrix

- `upstream-migration-checksum-pin.test.ts`: a fresh database writes the pinned upstream checksum for every upstream id
  (`0001` to `0024`), and the translated 0020 variant hashes to its accepted checksum.
- `session-migration-history.test.ts`: scenarios A to E on the real fixtures, plus the idempotent reopen and sync
  compat equivalence.
- `session-soft-delete.test.ts`: tombstone hides a session and keeps its row; erase still removes a tree.
- `session-store.test.ts`, `frozen-migration-startup.test.ts`, `async-migration-startup.test.ts`,
  `session-migration-boundaries.test.ts`, `session-database-identity-migration.test.ts`: upstream behavior, with the
  expected id lists extended by the fork ids.
