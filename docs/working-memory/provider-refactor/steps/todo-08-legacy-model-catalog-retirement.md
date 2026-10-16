# 08 Legacy Model Catalog and Derivative Compatibility Logic Retirement

> Status: Completed
>
> Date: 2026-08-24
>
> Source review: [`../research/model-abstraction-unification-cleanup-audit.md`](../research/model-abstraction-unification-cleanup-audit.md)
>
> Overall roadmap: [`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)

## 1. Task Objective

Thoroughly delete the old Model Catalog as a second system for model facts, reasoning configuration, and request compatibility policy. All meaningful model
facts enter ZCode Built-in / Personal Model Config Rules; historical inputs only converted at explicit importer boundaries; Provider API
request compatibility explicitly driven by Effective Model Config, no longer inferred by specific modelId.

This Todo simultaneously closes three derivative issues confirmed during old Catalog retirement:

1. Delete Legacy `modelCatalog.overrides` with no actual importer consumers;
2. Delete independent `ZCodeModelReasoningState`; Reasoning UI reuses Registry model selection candidates;
3. Replace Kimi K3 modelId Tool Schema special case with `requiresMfjsToolSchema` Model Config field.

```text
Legacy Residual

Legacy modelCatalog.overrides --------> Catalog parser / capability merge
Catalog reasoning --------------------> providerOptionsByLevel -> Protocol/UI
modelId == kimi-k3 --------------------> Tool Schema $ref workaround

Target

Built-in / Personal Model Config Rules
                 |
                 v
       Effective Model Config
       |- properties
       |- optionSpecs.reasoningLevel
       |- reasoningMapping
       `- requiresMfjsToolSchema
                 |
                 +--> Registry Selection View -> UI -> ModelSelection.options
                 `--> Adapter request assembly -> Provider API
```

## 2. Core Decisions

### 2.1 Old Model Catalog Can Be Entirely Retired

Provider/Model normal operation facts come only from:

```text
ZCode Built-in Provider Config
        -> Account Provider Config
        -> Personal Provider Config
        -> Effective Provider Config

ZCode Built-in Model Config Rules
        + Personal Model Config Rules
        -> Effective Model Config Rules
```

Old `ModelCatalogConfig`, `ModelCapability`, `ModelCapabilityProvider`, `ModelCatalogService`,
`ModelCatalogSource`, bundled models.dev snapshot/source, Catalog capability/default/reasoning policy are no longer runtime
fact sources, nor do they retain same-shape substitute DTOs for compatibility.

Facts determinable as belonging to models or connection combinations written to Built-in Model Config Rules; Personal Rules continue post-overriding. Adapter
request encoding behavior driven by explicit Model Config fields or formal API implementations. Cannot re-infer model capabilities and request parameters from Catalog, Provider kind, Endpoint, or
specific modelId.

### 2.2 Delete Legacy `modelCatalog.overrides`

Valid content expressible by old `modelCatalog.overrides` all replaceable by Personal Model Config Rules:

| Legacy Content                             | Current归属                  |
| ------------------------------------------ | ---------------------------- |
| context window                             | `properties.contextWindow`   |
| input format                               | `properties.input_format`    |
| Tool / Structured Output                   | `properties`                 |
| reasoning levels and defaults              | `optionSpecs.reasoningLevel` |
| reasoning Provider request params          | `reasoningMapping`           |
| Provider/Model/API combination differences | Model Config Rule matcher    |

Formal Legacy importer does not consume parser-returned `runtimePatch.modelCatalog`; therefore no new migration for that field:

- Delete Schema, parser, merge/helper, Catalog projection, and dedicated tests;
- New Config does not accept that field;
- Do not establish Personal Model Config importer;
- Old `provider.*.models.*` normally supported fields continue migrating by existing behavior;
- `name`, `family`, and other display metadata do not constitute reasons to retain Catalog.

### 2.3 Reasoning UI Reuses Model Selection Candidates

`ZCodeModelReasoningState` is not a runtime state, but an old protocol's re-wrapped model option specification for the selector. Target chain fixed as:

```text
Effective Model Config.optionSpecs.reasoningLevel
                         |
                         v
            Registry Model Selection View
                         |
                         +--> Composer
                         +--> Subagent
                         +--> Off-Peak
                         `--> Repo Wiki
                                  |
                                  v
              ModelSelection.options.reasoningLevel
```

Decisions:

- Model selection candidates directly provide `optionSpecs.reasoningLevel.values/default`;
- Whether Option Spec exists already expresses whether reasoning selection is provided; no need to retain `enabled`;
- Delete independent `ZCodeModelReasoningState` types, schemas, builders, and mapping helpers;
- Do not add reasoning-specific fetch, Store, Context, or sync protocols;
- `ModelSelection` only saves user-exPLICITLY-selected `options.reasoningLevel`; does not copy full level set and defaults;
- `providerOptionsByLevel` does not enter Protocol/UI; Provider parameters only retained in Effective Model Config's
  `reasoningMapping`, consumed forward by ModelFactory/Adapter;
- UI labels and localization are Selection View display projections; do not re-establish model facts.

### 2.4 `requiresMfjsToolSchema` Replaces modelId Special Case

Add overlay-able boolean field at Model Config root:

```ts
interface ModelConfigInput {
  properties?: ModelPropertiesConfigInput | null;
  optionSpecs?: ModelOptionSpecsConfigInput | null;
  reasoningMapping?: ReasoningMappingConfig | null;
  requiresMfjsToolSchema?: boolean | null;
}
```

Sparse Rules can omit or override this field; Built-in general Rules provide complete default `false`; precise
Provider/Model/API combination rules need current compatibility behavior overridden to `true`. Field must be boolean in complete Model Config at Registry.

It does not enter `Model.properties`, nor need to enter Protocol/UI. Todo 02 already determined that Adapter creates Models directly receiving complete
Registry Model Config, so execution closures can directly read this field.

```text
requiresMfjsToolSchema = false
`- Use Tool Contract.inputSchema as-is

requiresMfjsToolSchema = true
`- Copy and project Tool Schema before sending
   |- Parseable non #/$defs local $ref -> elevate to root $defs
   |- Projection successful -> send projected copy
   `- Unable to parse/rewrite -> InvalidModelRequest; network request must not be sent
```

This field at current stage only enables the already-existing local `$ref` root `$defs` projection, not representing ZCode implementing or verifying complete MFJS dialect.
This round does not handle `oneOf`, `anyOf`, `pattern`, and other MFJS rules, nor establish general Tool Schema dialect system.

Original `ModelToolContract.inputSchema` remains unchanged, and continues as authoritive for tool parameter validation and execution. Projection only exists at
Adapter Provider request assembly boundary. Delete `isKimiK3ModelId()` and all logic triggering this conversion by specific K3 modelId.

## 3. Deletion and Modification Scope

### 3.1 Catalog and Legacy Config

- Delete remaining `ModelCatalogConfig`, Catalog Service/Source/Capability Provider;
- Delete bundled models.dev snapshot, loader, Catalog query/merge-only tests, and packaging configs;
- Delete `default-policy`, `reasoning-policy`, Catalog capability helpers now with no consumers;
- Delete `modelCatalog.overrides` Config Schema, parser, merge, and runtime patch;
- `runtime-thought-level`: if only Catalog reverse matching remains, delete; existing Telemetry can only read explicit Model options/mappings,
  do not re-establish Catalog for retained observations.

### 3.2 Protocol and UI

- Model candidate protocol directly expresses reasoning Option Spec;
- Delete `ZCodeModelReasoningState`, `buildProtocolReasoningState()`, and old Provider reasoning projection;
- Delete `providerOptionsByLevel` cross-process field;
- Composer, Subagent, Off-Peak, Repo Wiki uniformly read values/default from current candidates;
- Do not change each product entry's own draft, save, and submission state ownership.

### 3.3 Adapter Tool Schema Projection

- `toAiSdkTools()` obtains `requiresMfjsToolSchema` from creation-time complete Model Config;
- Retain and accurately name existing local reference elevation implementation;
- Unparseable target references no longer leak to Provider as-is; instead throw typed `InvalidModelRequest` before request;
- generate/stream share same projection and failure paths;
- Errors contain Tool name and failed `$ref`; must not contain Secrets or irrelevant request content;
- Delete `default-policy.ts` Kimi K3 Schema judgment and its modelId variant list.

## 4. Explicitly Not Handled in This Todo

- Complete MFJS validator/projector or general Tool Schema dialect architecture;
- Off-Peak `ModelProviderModelConfig` overall retirement;
- Public `ModelRef`, Result/Event identity, and historical provenance;
- Overall design of Telemetry, Status, Context, Observation;
- Account Request Auth, runtime header refresh;
- Strict one-by-one comparison of old Catalog with ZCode Built-in Config migration audit;
- Model selection, Queue, recovery, or desktop/mobile realtime semantics.

## 5. Tests First

### 5.1 Config and Registry

1. `requiresMfjsToolSchema` supports Rule default, `true`, `false`, `null`, and Personal post-overriding;
2. Built-in general Rules provide `false`; integrity validation rejects final missing/null;
3. ZCode Built-in Config's target Provider/Model/API combinations parse to `true`; non-target combinations retain `false`;
4. Config JSON round-trip preserves this field;
5. Registry/ModelFactory does not fill or override this field by modelId.

### 5.2 Legacy Catalog

1. New Schema does not accept `modelCatalog.overrides`;
2. Legacy importer does not read, migrate, or retain that field;
3. Old `provider.*.models.*` normally supported migration regressions unchanged;
4. Normal startup, model selection, and request execution do not construct Catalog;
5. After deleting models.dev/Catalog, Official/Personal model facts remain parseable.

### 5.3 Reasoning Selection View

1. Candidates with Option Spec publish values/default; without Option Spec, do not publish reasoning selection;
2. Composer, Subagent, Off-Peak, Repo Wiki read same candidate facts;
3. Submissions only write `ModelSelection.options.reasoningLevel`;
4. No `enabled` or `providerOptionsByLevel` in Protocol/UI;
5. Adapter still produces Provider request params by `reasoningMapping[level]`.

### 5.4 Tool Schema Projection

1. Field `false`: Schema as-is;
2. Field `true`: parseable `#/properties/...` references elevated to root `$defs`;
3. Same reference reuses same `$defs` item; existing `$defs` not overridden;
4. Original Tool Contract deep-equal and unmodified;
5. Unparseable local references throw `InvalidModelRequest` before network;
6. Errors contain Tool name and reference path;
7. generate/stream behavior consistent;
8. Same modelId does not transform when field false; no implicit model-name behaviors remain.

## 6. Implementation Order

### Step A: Config Contract and Tests

- First add Model Config Overlay, integrity, ZCode Built-in Rule, and JSON round-trip failing tests;
- Add `requiresMfjsToolSchema` Schema/Config/Registry fields;
- Declare values in Built-in general Rules and target precise Rules.

### Step B: Tool Schema Explicitly Driven

- First add projection success, failure, original object unchanged, and modelId no longer生效 (effective) Adapter tests;
- Adapter reads complete Model Config fields;
- Delete Kimi modelId special case and old test assumptions.

### Step C: Catalog and Reasoning Protocol Retirement

- Delete Legacy `modelCatalog.overrides` input surface;
- Delete remaining Catalog data, Services/Sources, policies, and consumers;
- Selection View directly publishes reasoning Option Spec;
- Migrate UI consumers and delete independent Reasoning State.

### Step D: Verification and Commit

- Run Provider Config, Registry, Bootstrap, Adapter, Protocol, and UI affected unit tests;
- Run `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`;
- Run representative regressions on Tool wire and model selection protocols;
- Independent Conventional Commit.

## 7. Mechanical Zero and Completion Definition

- Normal production code has no `ModelCatalogConfig`, `ModelCatalogService`, `ModelCapabilityProvider`;
- No bundled models.dev snapshot/source and corresponding production packaging items;
- Config Schema/Runtime patch has no `modelCatalog.overrides`;
- Protocol/UI has no `ZCodeModelReasoningState`, `enabled`, `providerOptionsByLevel`;
- Adapter has no `isKimiK3ModelId()` or other Tool Schema modelId hardcode;
- `requiresMfjsToolSchema` only from Effective Model Config;
- Projection failures fail-closed before network requests; cannot silently delete Tools or send untransformable references as-is;
- No new Catalog alias, Runtime capability map, Reasoning State, or Tool Schema compatibility Registry.

Upon completion, Provider/Model static facts exist only in current Config/Registry/Model chain; Reasoning UI only consumes model selection candidate
facts; known K3 Tool Schema compatibility explicitly driven by Model Config, no longer dependent on old Catalog or specific model names.
