# 08 Legacy Model Catalog and Derivative Compatibility Logic Retirement

> Status: Completed (2026-08-24)
>
> Source review: [`../research/model-abstraction-unification-cleanup-audit.md`](../research/model-abstraction-unification-cleanup-audit.md)
>
> Overall roadmap: [`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-08-legacy-model-catalog-retirement.md`

## 1. Task Objective

The old Model Catalog is deleted as a second system for model facts, reasoning configuration and request compatibility
policy. All model facts live in ZCode Built-in / Personal Model Config Rules. Historical inputs are converted only at
explicit importer boundaries. Provider API request compatibility is driven by Effective Model Config, never inferred
from a specific modelId.

The todo also closed three derivative issues:

1. Legacy `modelCatalog.overrides` (no importer consumed it) is deleted.
2. Independent `ZCodeModelReasoningState` is deleted; the reasoning UI reuses Registry model selection candidates.
3. The Kimi K3 modelId Tool Schema special case is replaced by the `requiresMfjsToolSchema` Model Config field.

## 2. Core Decisions

### 2.1 Old Model Catalog Is Entirely Retired

Normal-operation facts come only from:

```text
ZCode Built-in Provider Config -> Account Provider Config -> Personal Provider Config -> Effective Provider Config
ZCode Built-in Model Config Rules + Personal Model Config Rules -> Effective Model Config Rules
```

`ModelCatalogConfig`, `ModelCapability`, `ModelCapabilityProvider`, `ModelCatalogService`, `ModelCatalogSource`, the
bundled models.dev snapshot/source and Catalog capability/default/reasoning policy are not runtime fact sources and have
no same-shape substitute DTOs. Facts that belong to a model or connection combination go to Built-in Model Config Rules
(Personal Rules override afterwards). Adapter request encoding is driven by explicit Model Config fields or formal API
implementations, not re-inferred from Catalog, Provider kind, Endpoint or modelId.

### 2.2 Legacy `modelCatalog.overrides` Is Deleted

Everything it could express is replaceable by Personal Model Config Rules:

| Legacy content                             | Current owner                |
| ------------------------------------------ | ---------------------------- |
| context window                             | `properties.contextWindow`   |
| input format                               | `properties.input_format`    |
| Tool / Structured Output                   | `properties`                 |
| reasoning levels and defaults              | `optionSpecs.reasoningLevel` |
| reasoning Provider request params          | `reasoningMapping`           |
| Provider/Model/API combination differences | Model Config Rule matcher    |

The formal Legacy importer never consumed parser-returned `runtimePatch.modelCatalog`, so there is no migration:
schema, parser, merge/helper, Catalog projection and dedicated tests are deleted; new Config does not accept the field;
no Personal Model Config importer is created. Old `provider.*.models.*` fields keep migrating as before. `name`,
`family` and other display metadata are no reason to keep a Catalog.

### 2.3 Reasoning UI Reuses Model Selection Candidates

`ZCodeModelReasoningState` was a re-wrapped option spec, not runtime state. Target chain:

```text
Effective Model Config.optionSpecs.reasoningLevel
  -> Registry Model Selection View
  -> Composer / Subagent / Off-Peak / Repo Wiki
  -> ModelSelection.options.reasoningLevel
```

1. Candidates directly provide `optionSpecs.reasoningLevel.values/default`; Option Spec presence already means
   reasoning selection is offered, so no `enabled` flag.
2. Independent `ZCodeModelReasoningState` types, schemas, builders and mapping helpers are deleted; no reasoning-specific
   fetch, Store, Context or sync protocol is added.
3. `ModelSelection` saves only the explicitly selected `options.reasoningLevel`, not the full level set or default.
4. `providerOptionsByLevel` never enters Protocol/UI; Provider parameters live only in Effective Model Config
   `reasoningMapping`, consumed by ModelFactory/Adapter.
5. UI labels/localization are display projections of the Selection View and do not re-establish model facts.

### 2.4 `requiresMfjsToolSchema` Replaces the modelId Special Case

Overlay-able boolean at the Model Config root:

```ts
interface ModelConfigInput {
  properties?: ModelPropertiesConfigInput | null;
  optionSpecs?: ModelOptionSpecsConfigInput | null;
  reasoningMapping?: ReasoningMappingConfig | null;
  requiresMfjsToolSchema?: boolean | null;
}
```

Sparse Rules may omit or override it. Built-in general Rules provide default `false`; precise Provider/Model/API
combination rules override to `true` where current compatibility needs it. It must be boolean in the complete Model
Config at Registry. It does not enter `Model.properties` or Protocol/UI; Adapter-created models receive the complete
Registry Model Config (Todo 02), so execution closures read it directly.

```text
false -> use Tool Contract.inputSchema as-is
true  -> copy and project Tool Schema before sending
         parseable non #/$defs local $ref -> elevate to root $defs; send projected copy
         unparseable/unrewritable        -> InvalidModelRequest; no network request
```

This enables only the existing local `$ref` root `$defs` projection; it does not claim a complete MFJS dialect. `oneOf`,
`anyOf`, `pattern` and other MFJS rules, and a general Tool Schema dialect system, are out of scope. Original
`ModelToolContract.inputSchema` stays unchanged and authoritative for parameter validation and execution; projection
exists only at the Adapter request assembly boundary. `isKimiK3ModelId()` and all K3 modelId triggers are deleted.

## 3. Deletion and Modification Scope

### 3.1 Catalog and Legacy Config

- `ModelCatalogConfig`, Catalog Service/Source/Capability Provider, bundled models.dev snapshot, loader, Catalog
  query/merge-only tests and packaging configs are deleted.
- `default-policy`, `reasoning-policy` and Catalog capability helpers with no consumers are deleted, as are the
  `modelCatalog.overrides` Config Schema, parser, merge and runtime patch.
- `runtime-thought-level` is deleted if only Catalog reverse matching remains; Telemetry reads only explicit Model
  options/mappings.

### 3.2 Protocol and UI

- Model candidate protocol directly expresses the reasoning Option Spec.
- `ZCodeModelReasoningState`, `buildProtocolReasoningState()`, old Provider reasoning projection and the cross-process
  `providerOptionsByLevel` field are deleted.
- Composer, Subagent, Off-Peak and Repo Wiki read values/default from current candidates. Each entry keeps its own
  draft, save and submission state ownership.

### 3.3 Adapter Tool Schema Projection

- `toAiSdkTools()` gets `requiresMfjsToolSchema` from the creation-time complete Model Config.
- The existing local reference elevation is kept and accurately named.
- Unparseable target references throw typed `InvalidModelRequest` before the request instead of leaking as-is;
  generate/stream share the same projection and failure paths.
- Errors contain the Tool name and failed `$ref`, never Secrets or unrelated request content.
- `default-policy.ts` Kimi K3 Schema judgment and its modelId variant list are deleted.

## 4. Explicitly Not Handled

- Complete MFJS validator/projector or general Tool Schema dialect architecture.
- Off-Peak `ModelProviderModelConfig` overall retirement.
- Public `ModelRef`, Result/Event identity, historical provenance.
- Overall design of Telemetry, Status, Context, Observation.
- Account Request Auth, runtime header refresh.
- Strict one-by-one comparison of old Catalog with ZCode Built-in Config migration audit.
- Model selection, Queue, recovery, desktop/mobile realtime semantics.

## 5. Acceptance Tests

### 5.1 Config and Registry

1. `requiresMfjsToolSchema` supports Rule default, `true`, `false`, `null` and Personal post-overriding.
2. Built-in general Rules provide `false`; integrity validation rejects a final missing/null value.
3. ZCode Built-in target Provider/Model/API combinations parse to `true`; others keep `false`.
4. Config JSON round-trip preserves the field.
5. Registry/ModelFactory does not fill or override the field by modelId.

### 5.2 Legacy Catalog

1. New Schema rejects `modelCatalog.overrides`; the Legacy importer does not read, migrate or retain it.
2. Old `provider.*.models.*` migration regressions are unchanged.
3. Normal startup, model selection and request execution do not construct a Catalog.
4. After deleting models.dev/Catalog, Official/Personal model facts remain parseable.

### 5.3 Reasoning Selection View

1. Candidates with Option Spec publish values/default; without it, no reasoning selection is published.
2. Composer, Subagent, Off-Peak and Repo Wiki read the same candidate facts.
3. Submissions write only `ModelSelection.options.reasoningLevel`.
4. No `enabled` or `providerOptionsByLevel` in Protocol/UI.
5. Adapter still produces Provider request params by `reasoningMapping[level]`.

### 5.4 Tool Schema Projection

1. Field `false`: Schema as-is.
2. Field `true`: parseable `#/properties/...` references are elevated to root `$defs`.
3. The same reference reuses one `$defs` item; existing `$defs` are not overridden.
4. Original Tool Contract is deep-equal and unmodified.
5. Unparseable local references throw `InvalidModelRequest` before network, with Tool name and reference path.
6. generate/stream behave the same.
7. Same modelId with field `false` is not transformed; no implicit model-name behavior remains.

## 6. Completion Invariants (Mechanical Zero)

- Production code has no `ModelCatalogConfig`, `ModelCatalogService`, `ModelCapabilityProvider`.
- No bundled models.dev snapshot/source or its packaging items.
- Config Schema/Runtime patch has no `modelCatalog.overrides`.
- Protocol/UI has no `ZCodeModelReasoningState`, `enabled`, `providerOptionsByLevel`.
- Adapter has no `isKimiK3ModelId()` or other Tool Schema modelId hardcode.
- `requiresMfjsToolSchema` comes only from Effective Model Config.
- Projection failures fail closed before network requests; Tools are never silently dropped and untransformable
  references are never sent as-is.
- No new Catalog alias, Runtime capability map, Reasoning State or Tool Schema compatibility Registry.
