# Bot State/Cache V2 Migration Design

Bot runtime state lives in `bot-state.json` and model provider cache in `bots-model-cache.json`. After provider config moved to `config.json`, Bot could still read stale provider ids or old model snapshots from those files: `/model` showed an old `providerId/modelId` while provider selection reported the provider missing. Bot state/cache migration must not re-implement provider config migration — it reuses `modelProviderService.getAll()` (which owns the `model-providers.json` → `config.json` migration) as the authority, then upgrades Bot's own files to v2.

Rules:

- New files `bot-state.v2.json` and `bots-model-cache.v2.json`; the new version reads/writes v2 only and never writes the old files, which old versions keep using untouched.
- Missing v2 files: old files are read once as read-only migration input.
- Bot provider/model snapshots are authoritative from `config.json`-migrated provider data.
- Draft models that cannot be resolved in the new provider structure are cleared, not preserved.

File shapes:

- `bot-state.v2.json`: `version: 2`, `migratedAt`, `source?: { stateUpdatedAt?: number }`, `bots` (v2 form of existing bot state).
- `bots-model-cache.v2.json`: `version: 2`, `updatedAt`, `migratedAt?`, `source?: { cacheUpdatedAt?: number }`, `providers` (sanitized provider/model snapshots from `modelProviderService.getAll()`), `modelIdRemaps?` (only old→new model mappings provably unique at migration time, for state migration reuse). The v2 provider list is not a copy of the old cache; the old cache is only auxiliary input for mapping old draft models/cache entries.

Migration order (bot service init):

1. Valid v2 state + cache → use them directly.
2. Either v2 file missing → read the corresponding old file as read-only input.
3. `modelProviderService.getAll()` for the authoritative provider list.
4. Build `bots-model-cache.v2.json`: snapshots from the authoritative list, sensitive fields filtered, source timestamps recorded, verifiable unique old provider/model mappings recorded.
5. Build `bot-state.v2.json`: keep non-provider fields (workspace, active task, pending permission, platform offset, reply mode, mode, thoughtLevel); validate/migrate `draftOptions.model`; on mismatch or ambiguity clear the draft model so Bot returns to the no-model-selected safe state.
6. Subsequent runs touch only v2 files.

Draft model migration (conservative order, no fuzzy matching, no guessing by similar names, no random pick among multi-provider hits):

1. `providerId` exists in the authoritative list and `modelId` belongs to it → keep.
2. `providerId` gone but the old cache supplies a provider name and `(provider name, modelId)` matches exactly one authoritative provider → migrate to that provider id.
3. Only `modelId` present and it occurs exactly once across authoritative providers → migrate.
4. Otherwise clear the draft model and log one `warn`.

Compatibility/rollback: old versions keep working off the untouched old files; rolling back simply resumes old-file reads; a corrupt v2 file is regenerated from old files plus current provider config (empty state/cache if both corrupt); deleting v2 re-triggers migration but never resurrects invalid provider/models.

Logging (`createServiceLogger(scope)`, never API keys or provider secrets): `info` for migration start/finish, `warn` for old-file read failures, invalid v2 schema, and unresolvable draft models, `error` when v2 write failure prevents loading state.

Verification: v2 preferred when present; migration writes only v2; draft kept when ids still valid; migrated on unique name+modelId match; cleared on multi-match/no-match; cache snapshots from `modelProviderService.getAll()`; output contains no provider API key.
