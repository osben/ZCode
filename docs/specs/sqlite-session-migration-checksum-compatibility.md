# SQLite session migration checksum compatibility

## Context

The upstream app and this fork share `~/.zcode/cli/db/db.sqlite`, including its `schema_migration` checksum ledger. Each build verifies the ledger rows of the migrations it knows and fails startup preflight with `checksum_mismatch` when a row does not match.

Commit `ac31c7db` translated the `--` comments inside the `PROVIDER_MODEL_SELECTION_MIGRATION_SQL` template of migration `0020_provider_model_selection`. Comments inside the SQL template are part of the checksum input, so the translation changed the checksum from the upstream value to a fork-only value even though the migration's data behavior was unchanged. Fork builds that contained the translation wrote the fork-only value into new databases, which an upstream build then rejects.

## Contract

- Session migrations continue to use SHA-256 of `sql.trim()` to identify the exact SQL applied.
- The checksum input of every upstream migration is byte-for-byte identical to upstream, including comments inside SQL strings: the full SQL text of session-store migrations `0001`–`0022`, and the `checksumInput` of tasks-index migrations `0001`–`0003`. A fresh database created by the fork writes the same ledger checksums as upstream.
- For `0020_provider_model_selection`, the current (written) checksum is the upstream checksum `681180b4fcb497e13289b6970021678f24c975efdf3538777541105c5b2b444e`.
- A migration may list an explicit, migration-specific set of historical checksums when a known non-semantic edit changed its SQL text after release. For `0020_provider_model_selection`, the translated checksum `31fdaa50915e6ee967de3d8072a7f98bab64da0ac2864275589e4a2740eda788` is accepted as historical.
- An accepted historical checksum only permits startup to recognize the migration as already applied. It must not rerun the migration or rewrite the checksum ledger.
- A checksum not equal to the current checksum or an explicitly listed historical checksum still fails closed with `checksum_mismatch`.
- A regression test pins the ledger checksum of every upstream migration in both shared databases, so a future edit to a pinned checksum input (for example a comment-translation sweep) fails CI. Exactly what is pinned:
  - Session store (`0001`–`0022`): SHA-256 of the full `sql.trim()`, so any edit to the executed SQL, comments included, fails the pin.
  - Tasks index: SHA-256 of `JSON.stringify(checksumInput)`. For `0003_official_glm_selection` that is the full migration SQL. For `0001_adopt_task_schema` it is the schema DDL strings, frozen column declarations and index SQL plus the semantic marker `scheduled-count-backfill-v1`; other SQL that `adoptSchema` executes (for example the `scheduled_run_count` backfill `UPDATE`) is not hashed. For `0002_provider_selection` it is only the semantic markers `legacy-automation-selection-v1` and `no-provider-for-legacy-off-peak-v1`; the conversion SQL in `provider-selection-v2.ts` is not hashed. Edits to that unhashed SQL do not fail the pin; it must still stay identical to upstream, which only review enforces.
  - The pinned lists contain upstream ids only; fork migrations (`9001_fork_*`) must never appear in them.

## Acceptance scenarios

1. A session database whose `0020_provider_model_selection` ledger row has the translated checksum `31fdaa…` passes migration preflight and preserves that ledger value.
2. A database with the upstream checksum `681180b4…` continues to pass unchanged.
3. An unrelated or unknown checksum still fails with `checksum_mismatch` for the offending migration.
4. A fresh session database and a fresh tasks index database record, for every upstream migration id, exactly the upstream checksum.

## Open decision: databases already written with the translated checksum

Databases whose `0020_provider_model_selection` row was written by a fork build containing the translation keep `31fdaa…`. The fork still reads them, but an upstream build rejects them with `checksum_mismatch` until the ledger row is rewritten to `681180b4…`. Whether to repair such ledgers (and how: a one-time startup rewrite, a manual tool, or nothing) is undecided and not implemented; startup must not rewrite the ledger on its own under the current contract.
