# Todo118: Preserve the User's Enable/Disable State in the First Provider Migration

> Status: First-import fix implemented on 2026-09-11 with targeted tests and local review passed; the joint
> account-non-disableable acceptance follows Todo117 and final whole-batch acceptance was pending. No real user config was modified.
>
> Latest ruling: the old disable of built-in account Providers is entirely cancelled and they cannot be disabled; there is
> no longer any wait to tell whether the disable was user- or system-generated. Manual-key Providers keep enable/disable,
> and an instance created from a template is not a built-in account. Current account write/parse constraints are owned by
> Todo117; this item owns the first migration.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-118-preserve-legacy-provider-enabled.md`

## Confirmed Problem

Baseline of the old format is `origin/staging_backup`: the old config stores the outer Provider `enabled`, and the reader
could read it from the outer field or the old `zcode.enabled`. `importLegacyPersonalProviderConfig()` did not copy the
field when creating the new Provider rule, and the public Resolver uses `rule.enabled ?? true`.

```text
old config enabled=false -> reader keeps false -> importer drops enabled -> new rule enabled missing -> Resolver defaults to enabled
```

Verified offline in memory with the real importer and Resolver: for a custom Provider with old value `false`, `true` or
missing, the import result lacked `enabled` and resolved to true in all three cases. It is not a UI illusion and needs no
special model or complex operation.

Entries: `packages/services/src/model-provider/legacyZCodeConfigProviderReader.ts`,
`legacyPersonalProviderConfigImporter.ts`, `packages/provider/src/resolver.ts`,
`packages/services/test/legacyPersonalProviderConfigImporter.test.ts`, `legacyProviderUpgrade.test.ts`.

## Fix Scope and Boundaries

1. Custom Providers: preserve the old enable intent by writing an explicit `enabled` on the **outer layer of the new
   Provider rule**, same level as `providerId`, not into `config` or model rules; false and true are kept, missing stays
   missing; the Resolver's uniform default is unchanged.
2. No conversion of Provider disable into per-model disable; no clearing of Keys, model members or historical Selection; no
   effect on pinned running execution; no change to account domain, plan or entitlement.
3. Old built-in account identities: `enabled=false` is not imported, with no distinction of user- vs system-generated
   disables (login/connection/entitlement failure). Account Providers are rebuilt from current config and still obey
   connection, entitlement, credentials and model eligibility; they are not forced executable.
4. Old `builtin:bigmodel / builtin:zai` API identities keep Todo35's boundary (migrate the Key only, not rescue the old
   `enabled`); identity migration is not widened. After migration, manual-Key instances can still be toggled by the user,
   and other manual instances created from preset templates are not subject to the account non-disableable rule.
5. This item fixes the first import. New manual-Key configs already migrated are not overwritten from the old file
   automatically (a differing `enabled` may contain a deliberate post-migration change). An existing account
   `enabled=false` stops taking effect through Todo117's unified semantics, not by re-running migration or reading the old
   file back. Remedy for already-migrated manual Providers is not implemented automatically here.
6. Original old config is kept, not overwritten or dual-written; no runtime read-back of old fields. The thinking-level
   migration gap is fixed separately by Todo121.

## Acceptance (done) and Review

Discriminating tests first (old custom Provider false / true / missing across old-file read, import, saving the new
format, re-read and Resolver); offline fixtures with a valid Key placeholder and complete model config show false publishes
no executable model while true and default stay under the public completeness conditions (enabling does not loosen
eligibility); old outer `enabled` vs old extension-field priority with the new field on the rule outer layer, schema
acceptable and original config unchanged; built-in API/account branches (old API migrates only the Key; account old
disable not imported, with or without `systemDisabledReason`, and verified jointly with Todo117 that accounts cannot be
disabled while manual-Key and per-model toggles are unaffected); first-import boundary (no re-import when new config
exists, no overwriting of a user's later toggle); old migration tests whose input had `enabled=false` without asserting the
state are no longer evidence for this behavior.

Completion claims must distinguish: first migration preserves manual Provider enable state; built-in account disable
cancelled; remedy for already-migrated manual users is out of scope; none substitutes another. No built-in identity item
awaits a user ruling.

Result: the importer writes an explicit outer `enabled` only in the custom branch (missing stays missing); the built-in
identity branch is unchanged. The parameterized old-file -> new-file -> Resolver cases reproduced the lost value first;
after the fix three test files / 20 items pass, covering outer vs extension priority, new-format re-read, no re-import after
a post-upgrade toggle reversal, old-file bytes unchanged and actual Registry publication. Root typecheck, lint (0 errors /
41 existing warnings) and architecture (0 violations) pass. Local review: no runtime old-field read-back, data remedy,
Key/model-level toggle rewrite or identity guessing. The Todo117 joint batch verified accounts cannot be disabled without
loosening eligibility, and first-migration assertions with/without a valid `systemDisabledReason` and enabled-but-missing-Key
non-executable passed. Whole-batch final delivery review was pending; record: [execution ledger](./provider-stabilization-20260911-execution.md).
