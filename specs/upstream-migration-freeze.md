# Upstream Migration Freeze (`fork-upstream-migrations.json`)

## Background (current source facts)

- The fork shares two SQLite databases with the upstream app (root `AGENTS.md`, "Shared Databases and Fork Divergence"):
  - `~/.zcode/cli/db/db.sqlite` — session store, ledger table `schema_migration`;
  - `~/.zcode/v2/tasks-index.sqlite` — tasks index, ledger tables `tasks_schema_migration` (base / controller-remote / source-server scopes) and `schema_migration` (projects scope).
- Each build applies only its own migrations but verifies every ledger row's checksum, so a fork edit to an **upstream** migration's checksum input makes the other build reject the shared database. Fork edits that only change comments _outside_ the checksum input are safe.
- Every set writes its ledger through the shared runner (`packages/shared/src/sqlite-migrations/runner.ts`), which stores `sha256(sql.trim())`:
  - session store runner: `apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts` (`appliedAtColumn: "time_applied"`);
  - tasks index runner: `packages/services/src/session/tasksDatabase/migrations.ts`, where `sql` is `JSON.stringify(checksumInput)` and the checksum is `sha256(JSON.stringify(checksumInput))` — identical once trimmed, because `JSON.stringify` has no leading/trailing whitespace;
  - projects runner: `packages/services/src/project-storage/index.ts`.
- The gate pins the **ledger checksum values each runner writes on a fresh `:memory:` database**, not file bytes. The fork legitimately rewrote comment text in some migration files (for example `packages/services/src/session/tasksDatabase/provider-selection-v2.ts`) and once shipped a translated 0020 SQL (`FORK_LEDGER_SQL_VARIANTS` in `fork-migrations.ts`); neither affects the values below.

## One-off audit (2026-10-26, before generating the baseline)

For every upstream id in the baseline: `git grep <id> 3c5b2276 -- packages apps` confirms the id exists at the pinned upstream commit `3c5b227649371507ddc4eb46ac5133afe6db1cab`, and `git diff 3c5b2276 HEAD -- <migration source files>` shows whether any checksum input changed since the pin.

Result:

- All 34 upstream ids (24 `cli`, 10 across the four tasks-index sets: 5 base, 3 projects, 1 controller-remote, 1 source-server) exist at `3c5b2276`.
- Exactly one migration source file differs from the pin: `packages/services/src/session/tasksDatabase/provider-selection-v2.ts` — comment translation only, in the body of `importLegacyAutomationSelections`. That function is the `apply` body of `0002_provider_selection`; `apply` bodies are not part of any checksum input.
- No upstream checksum input differs from `3c5b2276`; the baseline below is safe to freeze.

## Sets and migration sources

| Set                             | Database                         | Ledger                   | Sources of checksum input                                                                                                                                                             |
| ------------------------------- | -------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli`                           | `~/.zcode/cli/db/db.sqlite`      | `schema_migration`       | `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts` (0001–0019, 0023), `migrations/002{0,1,2}-*.ts`, `packages/shared/src/sqlite-migrations/legacy.ts` (0024)  |
| `tasks_index:base`              | `~/.zcode/v2/tasks-index.sqlite` | `tasks_schema_migration` | `packages/services/src/session/tasksDatabase/migrations.ts` and the `checksumInput` consts it imports (`schema-v1.ts`, `official-glm-selection-v3.ts`, `task-groups/migration-v6.ts`) |
| `tasks_index:projects`          | same                             | `schema_migration`       | `packages/services/src/project-storage/index.ts` (0005/0006/0007 `sql`) and the SQL consts it imports (`schema.ts`, `default-workspace/migration.ts`, `migration-order/migration.ts`) |
| `tasks_index:controller-remote` | same                             | `tasks_schema_migration` | `controller-remote-schema-v4.ts` (`CONTROLLER_REMOTE_SCHEMA_SQL`)                                                                                                                     |
| `tasks_index:source-server`     | same                             | `tasks_schema_migration` | `source-server-schema-v5.ts` (`SOURCE_SERVER_SCHEMA_CHECKSUM_INPUT`)                                                                                                                  |

## Baseline format (`fork-upstream-migrations.json`, repo root)

```json
{
  "upstreamCommit": "<40-hex sha, equals the effective pin (see Rules)>",
  "sets": {
    "cli": [{ "id": "0001_base_session_store", "checksum": "…" }, …],
    "tasks_index:base": […], "tasks_index:projects": […],
    "tasks_index:controller-remote": […], "tasks_index:source-server": […]
  },
  "acceptedVariants": { "cli": { "0020_provider_model_selection": ["<fork-written checksum>"] } }
}
```

- Entries are in application order (the order the runner applies them), which is the relative order the ledger rows must keep.
- `acceptedVariants` lists historical checksums that fork builds once wrote for an upstream id (derived from `FORK_LEDGER_SQL_VARIANTS`); a collected checksum matching an accepted variant passes.

## Rules

- **Fork id** iff `/^9\d{3}_fork_[a-z0-9_]+$/`. Every other applied id is upstream and must appear in the baseline with the same checksum and the same relative order. Fork ids are ignored entirely.
- **Check** (`scripts/check-upstream-migrations.ts`, no flags):
  1. `baseline.upstreamCommit` must equal the **effective pin**: `pendingUpstreamCommit` from `fork-upstream-base.json` when set (a pre-port series, `specs/fork-format-scope.md`), otherwise `upstreamCommit`. Upstream migrations pre-ported from the pending commit are baselined against it; the sync PR that moves `upstreamCommit` there and removes the pending field then passes without regeneration. Else fail: `[db:migrations] Upstream pin moved: fork-upstream-base.json is <pin> but fork-upstream-migrations.json was generated at <old>; upstream pin moved; regenerate the baseline in this sync PR. See specs/upstream-migration-freeze.md.`
  2. Per set, the upstream id sequence (fork ids filtered out) must equal the baseline sequence.
  3. Per entry, the collected checksum must equal the baseline checksum or be listed in `acceptedVariants`.
- Failure messages name the set, the id, both checksums, the shared database, and the recovery (`git show <upstreamCommit>:<path>`; add a `9NNN_fork_*` migration instead). Distinct variants cover: changed checksum, unknown non-fork id, missing id, reordered ids, unknown/missing set, pin mismatch.
- **Update** (`--update`): allowed only when the effective pin differs from `baseline.upstreamCommit` or no baseline exists. Append-only — an existing entry may keep its checksum (or an accepted variant) and new upstream ids are appended in application order; if an existing entry would change or disappear, or surviving ids would reorder, refuse: `upstream rewrote a frozen migration — stop and escalate`. The regenerated file records the new pin.
- Trailing-whitespace-only edits to `sql` pass everywhere: every checksum is computed over `sql.trim()`.

## Coverage limits

- `apply` function bodies are **not** covered: `0001_adopt_task_schema` and `0002_provider_selection` hash semantic marker strings, and `0005_projects`/`0006_default_workspace_tasks`/`0007_initial_workspace_order` hash only their `sql`; edits inside those `apply` bodies change no pinned checksum.
- `touchedTables`, `appVersion`, and `previousIds` are not pinned (they do not feed any ledger checksum).
- The gate reads the migration lists the runners would apply; it does not open the real databases under `~/.zcode`.

## Regenerating the baseline in an upstream sync PR

After bumping `fork-upstream-base.json` (or setting `pendingUpstreamCommit` for a pre-port series), run from the repository root:

```
pnpm db:migrations:baseline:update
```

and commit the regenerated `fork-upstream-migrations.json` together with the pin change. `pnpm db:migrations:check` gates ordinary PRs; it runs in `pnpm verify:pre-push` and in the PR checks job. The step is part of the sync procedure in `specs/fork-format-scope.md`.

## Tests

- `scripts/test/upstream-migration-baseline.test.mjs` (`node --test`): pure compare/append logic — checksum change, unknown id, missing id, reorder, pin mismatch, pending-commit effective pin, append-after-bump, append-refusal on rewrite, whitespace-trim equivalence, accepted variants.
- `scripts/test/check-upstream-migrations.test.ts` (`pnpm exec tsx --test scripts/test/check-upstream-migrations.test.ts`): real-code collection equals the committed baseline; an edited `0014_message_part_sequence` SQL and an edited tasks `checksumInput` (both injected via the collector's migration-list overrides) fail the check naming the id.
- The per-package pin tests (`apps/zcode-cli/packages/adapters/tests/upstream-migration-checksum-pin.test.ts`, `packages/services/test/tasksDatabaseUpstreamChecksumPin.test.ts`) read this baseline instead of inline constants, so the values have exactly one source.
