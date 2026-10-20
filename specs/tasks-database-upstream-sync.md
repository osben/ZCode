# Tasks Database Upstream Sync (3.16.1, PR 7a)

## Scope

The `packages/services` database layer only: `session/tasksDatabase/*`, `project-storage/*`, `task-groups/migration-v6.ts`, `session/forkWorkspacePinRepo.ts` (fork table), and the minimal non-DB call sites needed to compile. The CLI session-store database (`apps/zcode-cli`) is out of scope.

## Owners

- **Schema ledger**: `tasks_schema_migration` in `~/.zcode/v2/tasks-index.sqlite`. Owned by `sqliteMigrations.migrate` (`@zcode/shared/sqlite-migrations`) through `session/tasksDatabase/migrations.ts`. The ledger is shared by the upstream app and this fork.
- **Startup preparation**: `prepareTasksIndexStorage` (`session/tasksDatabase/startup.ts`, re-exported by `project-storage/startup.ts`). It is the single writer that runs migrations and repairs, called by the desktop Host worker through `@zcode/services/storage-startup`.
- **Repo fallback**: `TaskIndexRepo`, `AutomationRepo`, `OffPeakTaskRepo`, `ForkWorkspacePinRepo` call `runTasksDatabaseMigrations(db)` from `ensureReady()` only when the path is not already prepared (`isTasksStorageMigrated` / `isTasksStoragePrepared`). They never migrate outside an async `ensureReady`.
- **Fork tables**: `fork_workspace_pins` (created by `forkWorkspacePinRepo.ts`), owned by the fork repo.

## Ledger rules

1. Upstream ids (`0001_adopt_task_schema`, `0002_provider_selection`, `0003_official_glm_selection`, `0004_project_execution_scopes`, `0006_task_group_admissions`, and the scoped `0004_controller_remote_identity` / `0005_source_server_workspace_schema`) and their checksum inputs are frozen. Their modules are taken byte-identical from upstream: `schema-v1.ts`, `official-glm-selection-v3.ts`, `controller-remote-schema-v4.ts`, `source-server-schema-v5.ts`, `task-groups/migration-v6.ts`, and `migrations.ts`.
2. The checksum is `sha256(JSON.stringify(checksumInput))`. It is identical in the old fork runner and in `@zcode/shared/sqlite-migrations`, so ledger rows written by either build verify under the other.
3. Fork migrations use ids `9001_fork_*`, are additive only, and never take an upstream `000N` number. `9001_fork_workspace_pins` is recorded by the fork repo in `tasks_schema_migration`.
4. Ledger rows whose id the build does not know are ignored by every check (`areTasksDatabaseMigrationsApplied`, `inspectTasksMigrationKind`, the runner). Unknown rows are never deleted.
5. Backup and restore only touch the migration's `touchedTables` and only delete ledger rows for the migration ids being restored. A fork table not listed in `touchedTables` is never snapshotted or dropped.
6. Fork-owned columns and tables use the `fork_` prefix. Fork incognito markers follow the same rule.
7. Scoped migrations (`controller-remote`, `source-server`) are not run by this PR because no caller passes those scopes. Their ledger ids are reserved by upstream.

## Compatibility shims (remove in the final sync PR)

- `storage-startup.ts` keeps the `(path, onProgress)` signature used by the desktop worker. The optional settings argument of upstream `prepareTasksIndexStorage` is accepted but not forwarded to `TaskIndexRepo` (the fork repo has no settings parameter; project import is deferred).
- `session/tasksDatabase/startup.ts` remains as the fork module path, re-exporting the project-storage implementation.

## Acceptance scenarios

1. **Old fork build DB opens with the new runner.** A database created by the old fork build (ledger 0001-0003 plus `9001_fork_workspace_pins` row and the `fork_workspace_pins` table) opens with the new runner: the upstream migrations are verified by checksum, `9001` rows are ignored, `fork_workspace_pins` survives, and the new `0004_project_execution_scopes` / `0006_task_group_admissions` are applied.
2. **Fork table survives backup/restore.** A `fork_workspace_pins` row written before a migration survives `createMigrationBackup` + `restore` of the upstream migration, and the restore removes only the restored migration ids.
3. **Upstream frozen checksums are unchanged.** The upstream checksum pin tests pass without changes to their expected constants.

## Ownership of failures

A checksum mismatch on an upstream id is a hard error and must never be "fixed" by rewriting the ledger row.
