# Todo 35: Legacy Personal Provider User Intent Migration Consolidation

> Status: Completed
>
> Date: 2026-08-28
>
> Source: Todo 33 pre-launch Legacy Importer review
>
> Related tasks: [`Todo 33`](./todo-33-personal-provider-config-file-cutover.md)

> 2026-09-17 follow-up decision: [Todo161](todo-161-cli-legacy-output-token-migration.md) only adds an explicit
> output-limit migration for the first Standalone CLI import. The CLI conclusion in this document (context-only) is
> superseded by that item. Desktop and historical implementation evidence remain.

## 1. Problem

Todo 33 switched formal Personal Provider/Model Config to `provider_config.json`, but the Legacy Importer still
migrated by "difference between old Effective Config and current Built-in". Old `config.json` contains Built-in
Preset, Catalog enrichment, settings page default fill, account runtime state and retired model hardcode, so a
difference is not user intent. Direct deviations: `source=builtin` could still migrate API key, enabled, user-added
models and Model Rule; Personal Providers lacked `group=standard-personal` and could not project as complete
Personal Providers; `maxOutputTokens`, modalities, tools, structured output, reasoning and other system-generated
facts were solidified as Personal Rules.

## 2. Final Decision

Migration preserves only stably expressible user-customized Provider invocation intent, model members/order and
custom models' `contextWindow`. The Importer no longer parses or compares current Built-in Config and creates no
second model fact inference.

```text
Old config.json
  ├─ source = builtin -> entire Provider discarded
  └─ User-customized Provider
       ├─ Personal Provider Config: providerId / group, label / logo, API key / management URL,
       │  API Schema / Base URL / Headers, enabled, modelIds / modelOrder
       └─ Personal Model Config Rules: only a valid contextWindow
```

`models-dev` is deprecated and `workspace` is not a current real migration input; no compatibility branches. A
Provider missing `source` but recognized by the old Reader as user-customized keeps the old Reader's `custom`
default semantics.

## 3. Provider Migration

- `source=builtin` is discarded entirely: no Provider Overlay or Model Rule; API key, Endpoint, Schema, Headers,
  enabled, model add/delete, model order and all account state are not salvaged. Current ZCode Built-in Config and
  Account Overlay provide the formal facts.
- A valid customized Provider migrates: `providerId` (non-empty after trim); fixed `group=standard-personal`; user
  name and logo (name equal to ID may omit label); API key and management URL; API Schema, normalized Base URL and
  Headers explicitly saved by the old config; `enabled` as-is (`undefined` not back-filled); non-empty, un-deleted,
  deduplicated `modelIds`; the same valid member order as `modelOrder`.
- Not migrated: source, Catalog identity, created/updated time, `systemDisabledReason`, login/plan/connection
  failure and other runtime state.

## 4. Model Migration

Old string models only provide member identity and no Model Rule. Old object models with `deleted=true` are removed
from members and rules; other object models produce an exact `providerId + modelId` Personal Rule only when
`contextWindow` is a finite positive integer:

```ts
new ModelConfig({
  properties: new ModelPropertiesConfig({ contextWindow }),
});
```

`contextWindow` does not depend on `modified`, is not compared with Built-in defaults, and is not invoked within the
Importer Resolver. Entirely discarded and re-resolved by current Built-in Model Config Rules: `maxOutputTokens` and
`hasMaxOutputTokens`; Text/Image/Video/Audio/PDF input/output format and `modalitiesConfigured`; tools, structured
output, native web search, mid-conversation system; reasoning spec/mapping/profile; compatibility, priority,
disabled reason, model headers/options, `modelIdByKind`; Catalog name and display metadata. `modified` only marks
the whole old model entry as having participated in editing and cannot prove any leaf was user-modified, so it does
not take part in migration decisions.

## 5. File and Runtime Boundaries

Todo 33's lifecycle is unchanged: old `config.json` is read once only when `provider_config.json` does not exist, no
backup, `model-providers.json` not read, only `provider_config.json` listened to after a successful write. No
Provider v1/v2 intermediate format compatibility; account, model selection and Active Model freeze semantics
unchanged.

## 6. Acceptance Scenarios

1. Built-in Providers, even with API key, modified models and added models, migrate zero.
2. Customized Providers keep invocation config, `standard-personal` group, enabled, members and order.
3. String/object/deleted/blank/duplicate models project correctly.
4. Valid context migrates fully regardless of `modified`; invalid or missing context produces no Rule.
5. max output, modalities, tools, structured output, reasoning and compatibility never enter a Personal Rule.
6. The migration result is semantically unchanged after a formal codec JSON round-trip.
7. Migrated customized Providers combine with Built-in general Model Rules into complete Registry models.
8. Provider Runtime first import, skip when a formal file exists, and file listening regress cleanly.

## 7. Completion and Outcome

- The Importer no longer depends on a ZCode Built-in Snapshot or Effective diff projection;
  `projectEffectiveProvidersToPersonalConfig` (no production callers) was deleted with its public exports and
  self-tests; Built-in, Catalog/account state and retired model capabilities never enter Personal Config.
- Customized Providers directly generate Personal Config with `group=standard-personal`, invocation config, enabled,
  deduplicated members and original order; models go through one member collector; Personal Model Rules contain only a
  valid positive integer `properties.contextWindow`. Old capability migration implementations (reasoning
  conversion, max output, modalities, tools, structured output) are deleted.
- Vertical tests prove migrated context combined with current general Built-in Model Rules (format, capabilities and
  max output from current rules) enters the formal Resolver; the Services first-migration test proves the
  `provider_config.json` codec round-trip retains group, member order and context Rule.
- A later lifecycle review found the Standalone CLI importer still referencing the deleted Effective-to-Personal
  projection; it was synchronized to generate `standard-personal` Providers directly, keeping only model members,
  order and valid `contextWindow`, so CLI startup does not silently degrade migration to an empty config.
- Verification: Services directed tests 13, `@zcode/provider` 151, `@zcode/provider-node` 44; root
  `pnpm typecheck` and `pnpm lint` passed (33 pre-existing unrelated warnings); full `pnpm test:unit` 1486 files
  passed, 1 skipped, 12672 tests passed, 25 skipped.
