# Local Settings And SQLite Migrations

## Goal

ZCode needs a durable local state layer for project-scoped runtime choices while keeping
hand-authored config files declarative. Current users: project permission rulesets and project
permission mode. Model selection and reasoning are intentionally not global local settings;
configured defaults, App Recent, sparse Session Selection, and Active Model each have their own
documented owner.

The layer needs ordered SQLite migrations so users can safely jump versions without ad hoc
`create table if not exists` blocks.

## Storage boundary

The table is named `local_setting` because it stores local mutable state, not source-controlled
project config.

```sql
create table local_setting (
  scope text not null,
  scope_id text not null,
  namespace text not null,
  key text not null,
  value text not null,
  schema_version integer not null,
  time_created integer not null,
  time_updated integer not null,
  primary key(scope, scope_id, namespace, key)
);
```

Initial keys:

| Scope     | Scope ID   | Namespace    | Key       | Value                    |
| --------- | ---------- | ------------ | --------- | ------------------------ |
| `project` | project id | `permission` | `ruleset` | `PermissionRuleset` JSON |
| `project` | project id | `permission` | `mode`    | `{ "mode": "build" }`    |

The table is generic, but callers must not read or write arbitrary keys directly. Adapters expose
typed methods, and each namespace/key pair gets runtime validation when it becomes public behavior.

Older builds may have written `user/default/model/reasoningLevel`. Current code ignores that row; it
is not migrated into a Selection, because that would turn an obsolete global preference into an
explicit model option.

## Migration ledger

SQLite migrations use a ledger table:

```sql
create table schema_migration (
  id text primary key,
  checksum text not null,
  app_version text,
  time_applied integer not null
);
```

R3's `0024_session_database_identity` takes over the `zcode_database_identity` table that Source
Server once created directly. Agent and Source reuse the frozen SQL and ledger primitives through
`@zcode/shared/sqlite-migrations`, keeping the existing checksum algorithm and error types. When
Source runs before the Agent, it applies only that standalone additive-table migration; the later
Agent initialization fills in its own remaining versions. Both orderings record the migration once
in the same `schema_migration`. The takeover preserves the existing identity and mints no new
generation; generation choice, backup lineage, and recovery rules still belong to the Source merge
plan. Any SQL or ledger failure inside the transaction rolls back; history is never edited and
success is never hand-written.

Migration rules:

- Migrations are append-only and run in deterministic order.
- The CLI migration registry uses unique full IDs and unique four-digit numeric prefixes in
  increasing order; registry tests enforce this before release.
- Each migration declares the CLI version that introduced it; future migrations use their own
  version while historical entries keep the original. This is not the running desktop version.
- Each migration is wrapped in `begin immediate` / `commit` so concurrent CLI startups serialize
  schema writes.
- Applied migrations are checked by `id` and `checksum`. A checksum mismatch is a startup error:
  historical migration SQL must not be edited in place.
- Migration SQL must be idempotent where practical, because old databases can already contain
  tables created by pre-ledger builds.
- The ledger records a migration only after its SQL succeeds.
- A build checks only the migration ids it defines and ignores other ledger rows, so the upstream
  app and this fork can share one database.
- Fork-owned migrations use `9001_fork_*` ids, are additive only, and add only `fork_`-prefixed
  tables or columns; they never take an upstream `000N` id. Their ids never appear in the upstream
  checksum pin (`adapters/tests/upstream-migration-checksum-pin.test.ts`).
  - `9001_fork_session_incognito`: nullable `session.fork_incognito` (JSON incognito profile,
    `NULL` = normal session). Upstream upserts do not list the column; the fork upsert sets it with
    `coalesce`, so it is set once and never cleared (root `specs/incognito-session.md`).

## Startup migration gate

SQLite schema migration is a startup gate. After config and database path resolution, but before
runtime, provider, model, MCP, TUI, ZCode app-server, or session command logic is initialized,
bootstrap must open the SQLite store and finish all pending migrations. Later layers receive a
migrated store; they must not continue with an unverified schema.

Fast paths that need no local state (`--help`, `--version`, `doctor`) may skip the gate. Any path
that reads or writes session, permission, local setting, input history, workflow, or ZCode
app-server state must pass the gate first.

Startup behavior by entrypoint:

| Entrypoint                   | Migration timing                                            | Output behavior                                                                                                                                    | Failure behavior                                                           |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| prompt / non-interactive CLI | Before app construction and before model adapter creation.  | Normal CLI errors go to stderr; verbose mode may include cause/stack.                                                                              | Return exit code `1`; do not create runtime.                               |
| TUI                          | Before entering the full-screen TUI.                        | Avoid raw stderr while the TUI owns the screen. Pre-TUI status may use the controlled stderr path; failures print as ordinary CLI errors before the TUI. | Return exit code `1`; do not call `runTui`.                               |
| ZCode app-server             | Before `zcode app-server --stdio` accepts protocol traffic. | Never write migration progress to stdout, because stdout is the protocol stream. Default to structured logs; failures may be summarized on stderr. | Return exit code `1`; do not establish the app-server protocol connection. |

The storage adapter owns the actual SQLite transaction and checksum checks. Bootstrap owns the
ordering: migration is a named, observable startup stage that blocks all later side effects.

Migration errors are structured around stable categories:

- `open_failed`: SQLite file or parent directory could not be opened or created.
- `checksum_mismatch`: an applied migration checksum differs from the current migration SQL.
- `sql_failed`: migration SQL failed after the migration transaction began.

Errors preserve the original cause and include the database path plus migration id when known. CLI
and ZCode app-server entrypoints format these errors at their boundary; the adapter never calls
`process.exit`.

## Provider data migration (Todo109)

The staged `0019_dwf_journal` and its historical checksum are kept; `0020_provider_model_selection`
is appended afterwards and runs inside the same startup gate, with no migration catch-up when
resuming a session. It only adds JSON members: the Session's current selection, the User/Assistant
historical model source, the new model-switch structure, and the new Subtask Part structure. Old
members and old values are preserved; historical execution identity is never reinterpreted against
the current account. Models and modes not recorded in `session_input` are not guessed; no other
table is rewritten by this transition.

```text
old DB -> startup migration/transaction -> new-field reader -> display/execution boundary
          old values kept as-is            missing config can be re-selected, content stays readable
rollback writes old format -> re-upgrade -> applied ledger migrations do not rerun, no per-field backfill from old fields
```

Storage uses distinct members so new and old names never collide: model switches use
`fromModelSelection` / `toModelSelection`, Subtask uses `modelSelection`. The adapter unwraps them
into the existing Port's logical fields; Core never reads old fields. Writes of old-format content
are kept only where needed for frozen old readers: the new User's `model` object and the model
switch's `toModel` object. Updating an existing record keeps its original old values; there is no
continuous dual-write of config. Fork/copy is handled by the adapter copying the old snapshot at the
original record coordinates; the business layer never interprets old config.

This section constrains only the Provider refactor; the permission-migration compatibility phase
below is out of its scope.

## Permission migration

The old `permission(project_id, data)` table is migrated into:

```text
project/<project_id>/permission/ruleset
```

The backfill uses `insert or ignore` so repeated startup cannot overwrite newer `local_setting` rows
with stale legacy data.

During the compatibility phase:

- Reads check `local_setting` first and fall back to the old `permission` table.
- New writes go to `local_setting`.
- The old table remains in the database until a later cleanup migration removes fallback support.

## Tests

- Fresh databases apply all migrations and record their ids in order.
- Reopening a migrated database does not duplicate ledger or `local_setting` rows.
- A database with only the legacy `permission` table backfills rulesets into `local_setting`.
- A recorded migration checksum mismatch fails startup.
- App bootstrap opens the migrated session store before model adapter, runtime, MCP, or TUI
  initialization.
- App-server startup migration failure prevents the ZCode app-server connection and writes no
  progress to stdout.
- TUI startup migration failure returns before entering the full-screen TUI.
