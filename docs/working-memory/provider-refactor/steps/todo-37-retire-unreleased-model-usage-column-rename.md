# Todo 37: Retire the Unreleased Model Usage Database Column Rename

> Status: Implemented
>
> Date: 2026-08-28
>
> Source: pre-launch downgrade-compatibility review of Provider Refactor

## 1. Background

Provider Refactor renamed the ambiguous domain term `variant` to `reasoningLevel`. Commit `8c55290f1f` also added a
SQLite migration `alter table model_usage rename column variant to reasoning_level;`. The rename changed no meaning,
query capability or product behavior, but a database that ran it cannot be written by older versions (they still
write `model_usage.variant`, so a downgrade hits a missing-column error). The change was unreleased and only a few
dev/trial environments ran the migration, so no reverse migration, dual-column compatibility or runtime schema
probing is added.

## 2. Decision

The database keeps its physical column name; the domain uses the accurate name:

```text
ModelUsageRecord.reasoningLevel -> (Repository mapping) -> model_usage.variant
```

1. Delete the `0019_model_usage_reasoning_level` migration; it stays in history as a retired dev-time ID and a later
   formal migration must not reuse it.
2. `model_usage` permanently keeps the `variant` column; no `reasoning_level` column.
3. Domain, protocol and Runtime keep `reasoningLevel`; the Usage Repository (the only persistence boundary) writes it
   to `variant`.
4. No reverse migration, no `variant/reasoning_level` dual-column compatibility, no column-existence probing
   (`pragma_table_info` guessing) and no startup auto-repair.
5. A fresh database still gets `model_usage.variant` from `0010_usage_observability`.
6. Production SQL contains no read/write of `model_usage.reasoning_level`.

Environments already affected are repaired manually (not a repository migration, not run at startup). Quit ZCode and
back up the SQLite file first; run only on a database confirmed to have `reasoning_level` and the
`0019_model_usage_reasoning_level` record; unaffected environments must not run it:

```sql
BEGIN IMMEDIATE;
ALTER TABLE model_usage RENAME COLUMN reasoning_level TO variant;
DELETE FROM schema_migration
WHERE id = '0019_model_usage_reasoning_level';
COMMIT;
```

## 3. Not done

No reverse `reasoning_level -> variant` migration; no dual physical column support in the Repository; no table
drop/rebuild; no change to usage data meaning or retention; no other Session Store table/column/migration changes;
no rollback of the `reasoningLevel` domain naming.

## 4. Acceptance

- A new SQLite Session Store's migration list ends at the current formal migration and excludes the retired `0019`;
  `pragma_table_info(model_usage)` has `variant` and no `reasoning_level`.
- A `ModelUsageRecord` with `reasoningLevel` lands in `variant`, including upsert of the same usage record.
- The branch relative to `origin/staging` contains no SQLite table or column change; downgrade does not fail on
  `model_usage.variant`.
- No automatic reverse migration, dual-column compatibility or runtime schema guessing exists.

## 5. Outcome

The migration was removed from the formal chain; the Usage Repository maps `reasoningLevel` to `variant` at the
single persistence boundary; Session Store tests pin the migration list and real table structure and cover first
write and same-ID upsert; production code was audited for `model_usage.reasoning_level`, dual-column compatibility,
schema probing and auto-repair (none). The manual repair SQL was rehearsed on a temporary SQLite database (original
usage values kept, the `0019` record deleted).
