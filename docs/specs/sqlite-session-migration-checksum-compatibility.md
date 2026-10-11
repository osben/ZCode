# SQLite session migration checksum compatibility

## Context

Migration `0020_provider_model_selection` was already applied before its SQL comments were translated. Because the comments are inside the SQL template, the translation changed the stored SHA-256 checksum even though it did not change the migration's data behavior. Existing session databases then fail startup preflight with `checksum_mismatch`.

## Contract

- Session migrations continue to use SHA-256 of `sql.trim()` to identify the exact SQL applied.
- A migration may list an explicit, migration-specific set of historical checksums when a known non-semantic edit changed its SQL text after release.
- For `0020_provider_model_selection`, accept both the pre-translation checksum `681180b4fcb497e13289b6970021678f24c975efdf3538777541105c5b2b444e` and the current checksum `31fdaa50915e6ee967de3d8072a7f98bab64da0ac2864275589e4a2740eda788`.
- An accepted historical checksum only permits startup to recognize the migration as already applied. It must not rerun the migration or rewrite the checksum ledger.
- A checksum not equal to the current checksum or an explicitly listed historical checksum still fails closed with `checksum_mismatch`.

## Acceptance scenarios

1. A session database whose `0020_provider_model_selection` ledger row has the pre-translation checksum passes migration preflight and preserves that ledger value.
2. A database with the current checksum continues to pass unchanged.
3. An unrelated or unknown checksum still fails with `checksum_mismatch` for the offending migration.
