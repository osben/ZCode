# Fork-only model option fields in the shared provider_config.json

## Background (confirmed)

- `~/.zcode/v2/provider_config.json` is shared with the upstream app. The upstream build pinned in
  `fork-upstream-base.json` (3.16.1, `0a1fc56d`) parses it with strict schemas and rejects the
  whole file on any unknown key. Every personal provider then disappears and every provider save
  throws (AGENTS.md "Shared Databases and Fork Divergence").
- Fork commit `43f52e5d` added `optionSpecs.reasoningLevel.default` (`EnumOptionSpecConfig.default`).
  Upstream's `completeEnumOptionSpecDataSchema` has no such key, so it is fork-only.
- The fork's built-in catalog `config/provider/zcode-builtin.json` carries `default: "high"` for
  two model rules (`gpt-5.6`, `gpt-6-{astra,sol,luna}`).
- **Confirmed reachable write path (before this fix):** a built-in model in Settings, switched to
  manual ("do not follow recommended") and saved. `resolveProviderModelDraftCommit`
  (`ProviderModelMetadata.ts`) copies the inherited default into the effective option specs;
  `materializeEditorManagedPersonalConfig` → `extractManualModelConfig` keeps it because the
  manual schema reuses the full fork `reasoningLevel` schema; `setExact` → `toPersonalJSON` →
  `encodeProviderConfigFile` writes it to disk. Commit `476a04e7` added a UI test that asserts
  exactly this persistence.
- Why the value cannot simply be dropped: a manual rule replaces the editable leaves of the
  layers below it. `ModelConfigRules.resolve` calls `clearManualModelConfig` before overlaying the
  manual rule, so without a fix a manual `gpt-5.6` would lose `"high"` and fall back to `"max"`.
- The ACP pseudo-model's `default: "auto"` is derived (`acp-agent-derivation.ts`) and is not a
  personal write (see `specs/acp-agent-runtime.md`).

## Product rules

1. **Catalog owns the default.** `optionSpecs.reasoningLevel.default` is owned by the Built-in
   and derived catalog layers. It is not a user-editable manual leaf and no UI control writes it.
2. **Shared file never carries it.** Neither a personal model rule (`providerModelRules`,
   `manualProviderModelRules`) written to `provider_config.json` nor one read from it may contain
   `optionSpecs.reasoningLevel.default`. The owner is `@zcode/provider`:
   - `parsePersonalModelConfigRules` drops the key before the strict parse (reading legacy files);
   - `ModelConfigRules.toPersonalJSON` drops the key before the strict parse (every disk write,
     the CAS revision, provisioning and import all go through `encodeProviderConfigFile`).
3. **Manual rules inherit the catalog default.** Clearing editable leaves for a manual rule keeps
   the inherited `reasoningLevel.default`; the manual rule then overlays on it. The existing
   `EnumOptionSpecConfig.overlay` rule still drops the inherited default when the rule's own
   `values` no longer include it.
4. **Migration is implicit and idempotent.** A file written by an earlier fork build with the key
   is normalized on read: `NodePersonalProviderConfigRepository` already rewrites any file whose
   content differs from its canonical encoding, under the file lock. The rewrite removes only the
   key; the value is re-derived from the catalog. A second read does not rewrite.
5. Other fork-only fields are out of scope for this rule. Any new fork-only personal field must
   either be added to this spec or stored in a `fork_`-prefixed sidecar.

## State owners

| State                                | Owner                                               | Persisted to shared file |
| ------------------------------------ | --------------------------------------------------- | ------------------------ |
| Built-in `reasoningLevel.default`    | `config/provider/zcode-builtin.json` (materialized) | No                       |
| Derived ACP `reasoningLevel.default` | `acp-agent-derivation.ts`                           | No                       |
| Personal manual/smart rule values    | `ModelConfigRules` (`@zcode/provider`)              | Yes, without `default`   |

## Acceptance scenarios

- Manual save of a built-in `gpt-5.6` model writes a file with no `default` key, and
  `decodeWithUpstreamSchemas` accepts the whole file.
- The same manual save still resolves to `default: "high"` through the built-in rule.
- A manual rule whose `values` exclude the inherited default resolves with no default.
- `ModelConfigRules.toPersonalJSON()` and `parsePersonalModelConfigRules()` never emit or accept
  the key in either rule list, and keep every other field unchanged.
- Smart rule (`useRecommendedConfig` on) with a default in memory: the written file has no key.
- `NodePersonalProviderConfigRepository.update` with a default in memory: the file on disk passes
  the upstream decoder.
- A file with the key on disk, written by an earlier fork build: the first `read()` rewrites it
  without the key and upstream accepts it; a second `read()` leaves the bytes unchanged.
- The ACP pseudo-model config never reaches the shared file with the key.

## Tests

- `packages/provider/test/catalog-reasoning-default.test.ts`: resolution, overlay, personal
  serialization and parse boundary.
- `packages/provider-node/test/fork-shared-file-upstream-compat.test.ts`: fork write paths and the
  file-level migration, decoded by the verbatim upstream schema copies in
  `test/fixtures/upstream-3.16.1/`.
- `packages/provider-node/test/acp-upstream-compat.test.ts`: the ACP pseudo-model guard.
