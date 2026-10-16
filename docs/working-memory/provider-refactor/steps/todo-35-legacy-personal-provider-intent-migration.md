# Todo 35: Legacy Personal Provider User Intent Migration Consolidation

> Status: Completed
>
> Date: 2026-08-28
>
> Source: Todo 33 pre-launch Legacy Importer review
>
> Related tasks: [`Todo 33`](./todo-33-personal-provider-config-file-cutover.md)

## 1. Problem

Todo 33 has switched formal Personal Provider/Model Config to `provider_config.json`, but existing Legacy Importer
still migrates by "difference between old Effective Config and current Built-in." Old `config.json` contains Built-in Preset,
Catalog enrichment, settings page default fill, account runtime state, and retired model hardcode, therefore difference does not equal user intent.

Current implementation also has three direct deviations:

- `source=builtin` may still migrate API Key, enabled, user-added models, and Model Rule;
- Personal Providers lack `group=standard-personal`, cannot project as complete Personal Provider after migration;
- `maxOutputTokens`, modalities, tools, structured output, reasoning, and other system-generated facts solidified as Personal Rule.

## 2. Final Decision

Migration only preserves stably expressible user-customized Provider invocation intent, model members/order, and custom models'
`contextWindow`. Importer no longer parses or compares current Built-in Config, does not create second model fact inference.

```text
Old config.json
      |
      +--> source = builtin
      |      `--> entire Provider discarded
      |
      `--> User-customized Provider
             |
             +--> Personal Provider Config
             |      ├─ providerId / group
             |      ├─ label / logo
             |      ├─ API Key / management URL
             |      ├─ API Schema / Base URL / Headers
             |      ├─ enabled
             |      └─ modelIds / modelOrder
             |
             `--> Personal Model Config Rules
                    `─ Only preserve valid contextWindow
```

`models-dev` deprecated, `workspace` not current migration real input; Importer does not create compatibility branches for them. Missing
`source`, but Providers recognized by old Reader as user-customized structure, continue handled by old Reader's `custom` default semantics.

## 3. Provider Migration

### 3.1 Built-in

`source=builtin` entirely discarded, does not produce Provider Overlay or Model Rule. API Key, Endpoint, Schema, Headers,
enabled, model add/delete, model order, and all account state not salvaged. Current ZCode Built-in Config and Account Overlay
re-provide formal facts.

### 3.2 User-Customized Provider

Valid customized Provider migrations the following fields:

- `providerId` non-empty after trim;
- Fixed `group=standard-personal`;
- User name and logo; name equal to ID can omit label;
- API Key and API Key management URL;
- API Schema, normalized Base URL, and Headers explicitly saved by old config;
- `enabled` retained as-is, `undefined` not back-filled;
- Non-empty, un-deleted, deduplicated `modelIds`;
- Same valid member order written to `modelOrder`.

Does not migrate source, Catalog identity, created/updated time, `systemDisabledReason`, login/plan/connection failure and other runtime state.

## 4. Model Migration

Old string models only provide member identity, do not produce Model Rule. Old object models removed from members and rules when `deleted=true`;
other object models only produce exact `providerId + modelId` Personal Rule when `contextWindow` is finite positive integer:

```ts
new ModelConfig({
  properties: new ModelPropertiesConfig({ contextWindow }),
});
```

`contextWindow` does not depend on `modified`, does not compare with Built-in default values, and not invoked within Importer Resolver.

The following model facts entirely discarded, re-resolved by current Built-in Model Config Rules:

- `maxOutputTokens` and `hasMaxOutputTokens`;
- Text/Image/Video/Audio/PDF input/output format and `modalitiesConfigured`;
- tools, structured output, native web search, mid-conversation system;
- reasoning spec/mapping/profile;
- compatibility, priority, disabled reason, model headers/options, `modelIdByKind`;
- Catalog name and display metadata.

`modified` merely marks entire old model entry participating in editing, cannot prove any leaf field modified by user, therefore not participating in migration judgment.

## 5. File and Runtime Boundaries

Todo 33's lifecycle unchanged: only reads old `config.json` once when `provider_config.json` not exists,
no backup, does not read `model-providers.json`, only listens to `provider_config.json` after successful write. This Todo does not add Provider v1/v2
intermediate format compatibility, nor modifies account, model selection, or Active Model freeze semantics.

## 6. Test Plan

Write failing tests first, then modify production implementation:

1. Built-in Providers even containing API Key, modified models, and added models zero migration;
2. Customized Providers completely retain invocation config, `standard-personal` group, enabled, members, and order;
3. String/object/deleted/blank/duplicate models correctly projected;
4. Valid context fully migrated, not dependent on `modified`; invalid or missing context produces no Rule;
5. max output, modalities, tools, structured output, reasoning, compatibility all not entering Personal Rule;
6. Migration result semantically unchanged after formal codec JSON round-trip;
7. Migrated customized Providers combine with Built-in general Model Rules into complete Registry models;
8. Provider Runtime first import, existing formal file skip import, and file listening regression pass.

## 7. Completion Criteria

- Legacy Importer no longer depends on ZCode Built-in Snapshot or Effective diff projection;
- Built-in, Catalog/account state, and retired model capabilities not entering Personal Config;
- Customized Providers have complete group, invocation config, members, and ordering after migration;
- Personal Model Rules only possibly contain `properties.contextWindow`;
- Directed unit tests, related Services/Provider tests, root `pnpm typecheck`, and `pnpm lint` pass;
- Submit Conventional Commit upon completion.

## 8. Implementation Results

- Importer deleted ZCode Built-in Snapshot input and Effective diff projection, `source=builtin`, retired
  `models-dev`, and non-Personal `workspace` inputs all no longer written to formal file;
- `projectEffectiveProvidersToPersonalConfig` provided only for old migration confirmed no production callers, deleted along with public exports and
  self-tests, avoiding continuing exposing erroneous entry point of "reverse-deduce Personal intent from Effective Config";
- Customized Providers directly generate Personal Config with `group=standard-personal`, retaining invocation config, enabled,
  deduplicated model members, and original order;
- Old string/object/deleted/blank/duplicate models uniformly through single member collector; Personal Model Rules only contain valid positive integer
  `properties.contextWindow`;
- Old capability migration implementations for reasoning conversion, max output, modalities, tools, and structured output deleted;
- Vertical tests prove migrated context combined with current general Built-in Model Rules, complete format, capabilities, and max output all from
  current rules, can enter formal Resolver;
- Services first migration test proves `provider_config.json` codec round-trip retains group, member order, and context Rule;
- Subsequent lifecycle Review found Standalone CLI importer still referencing deleted Effective→Personal projection; now synchronized
  to directly generate `standard-personal` Provider, and also only preserve model members, order, and valid `contextWindow`, avoiding CLI
  startup silently degrading migration to empty config when export missing;
- Directed Services tests 13, `@zcode/provider` 151, `@zcode/provider-node` 44 all passed; root
  `pnpm typecheck` and `pnpm lint` passed, lint only reports 33 pre-existing unrelated warnings; full `pnpm test:unit`
  1486 files passed, 1 skipped, 12672 tests passed, 25 skipped.
