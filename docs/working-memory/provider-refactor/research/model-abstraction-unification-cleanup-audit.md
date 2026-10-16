# Model Abstraction Unification Cleanup Audit

> Status: Pre-cleanup review after M4 completion; M4 items are zero, remaining issues await itemized rulings
>
> Date: 2026-08-24
>
> Target design: [`../design/design.md`](../design/design.md)
>
> Current parallel phase: [`../steps/04-model-execution-cutover.md`](../steps/04-model-execution-cutover.md)

## 1. Document Positioning

The Provider Refactor has established new Provider Config, Model Config Rules, Registry, ModelFactory, and `Model`
call boundaries, and has deleted a large number of old Provider/Model implementations. M4 has migrated special executions like idle tasks and Subagents onto the same
standard model call chain.

This audit no longer only judges whether a phase completed as planned, but checks whether the entire system still has a second model abstraction, a second model assembly path, or a second model fact source. Audit results first record code facts and structural risks; items requiring design rulings are kept as open questions for itemized discussion before entering formal design and implementation plans.

This audit has clear separation of concerns with parallel new code reviews:

```text
Parallel new code review
`- Check whether M4 new implementation is correct, complete, and introduces behavioral or quality issues

This model abstraction unification cleanup audit
`- Check what old code, old abstractions, and compatible paths can be physically exited after the new chain is established
```

Therefore, this audit does not perform general implementation Reviews on M4 new code. New implementations are only read as deletion evidence when judging whether a piece of old code has been completely replaced by the new chain. The core output here is the old code cleanup list, dependencies, deletion prerequisites, and mechanical zero conditions, not another list of M4 new code issues.

This audit answers the following questions:

1. Can business code still bypass `ModelFactory` and directly execute model requests using old Adapters or old request DTOs;
2. Are `ModelSelection`, `Model`, model identity, requests, and results still mixedly expressed by old `ModelRef`;
3. Are there still Catalogs, Runtime Configs, Endpoints, or modelId hardcodes providing model facts outside of Provider/Model Config;
4. Do Core, Services, Protocol, and UI still consume old Provider/Model complete DTOs;
5. Which old implementations should be physically deleted, and which only need to be constrained within Adapter, Protocol, or one-time importer boundaries;
6. What mechanical checks are still needed after M4 completion to prove the system abstraction has truly converged.

More directly, this audit continuously asks:

> What alternative capabilities has the new design provided; why does code depending on the old design still exist; can it be deleted now; if not yet deletable,
> what is the last missing migration prerequisite.

## 2. Target Architecture for Audit

The target system has only one model formation and execution chain:

```text
Persisted / Protocol
    ModelSelection
          |
          v
Effective Provider Config + Effective Model Config Rules
          |
          v
    Provider Registry
          |
          v
      ModelFactory
          |
          v
      Active Model
      |- identity
      |- properties
      |- optionSpecs
      |- options
      `- generateText / streamText
          |
          v
  Adapter internal execution projection
          |
          v
     Provider API
```

Target responsibilities of each concept:

| Concept                   | Unique Responsibility                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ModelSelection`          | Express user or product intent for future model creation; can be persisted and cross-process transferred               |
| Effective Provider Config | Determine Provider, API, Access, model members, and user visibility                                                    |
| Effective Model Config    | Determine model Properties, Option Specs, and request parameter mapping                                                |
| Provider Registry         | Aggregate Effective Config, and provide resolution and Views by Provider/Model identity                                |
| `ModelFactory`            | Assemble Selection, Registry facts, and request dependencies into complete `Model`                                     |
| `Model`                   | Immutable model facts for current execution and the唯一的 model call interface                                         |
| Adapter                   | Encode `ModelRequest` into specific Provider API requests; do not output a second model abstraction to business layers |
| Model Identity            | If events, Telemetry truly need it, only record actual model identity,不承担 Selection or Options semantics            |

Core should only recognize `ModelSelection` and `Model`; if necessary, it can recognize only the minimal read-only Model Identity. Core should not
recognize AI SDK Adapters, Provider Connections, baseURL, providerKind, old Catalog capabilities, or capabilities inferred by specific modelId.

## 3. Audit Classification Principles

When discovering old symbols or old DTOs, deletion cannot be judged solely by name. The following four categories are used:

| Category                           | Meaning                                                                                           | Handling Principle                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| M4 Already Exited                  | Special execution dual-track belonging to M4 and already deleted                                  | Maintain zero gates, prevent reintroduction                                 |
| Runtime Second Abstraction         | Still participates in normal model selection, assembly, capability judgment, or request execution | Must be migrated to unified chain and old entry deleted                     |
| Legitimate Boundary Implementation | Adapter internal execution, strict Protocol schema, or one-time legacy importer                   | Can be retained, but must not leak back into Core, Registry, Service, or UI |
| Subsequent Domain Boundary         | Known not belonging to M4, requiring re-assignment by subsequent phases                           | Record dependencies and final direction, do not conveniently modify in M4   |

`AiSdkModelAdapter` itself is not a "old model abstraction" that needs deletion. It can continue as a concrete execution implementation. The real question is whether Core directly depends on it, and whether it re-becomes a second business model entry point through public DTOs, Connections, or mutable Registries.

## 4. Current Overall Conclusion

Main business model calls mostly go through `Model.generateText()` / `Model.streamText()`; direct calls to OpenAI, Anthropic,
or other Provider SDK implementations have basically converged within Adapters. This shows that the new public call boundary has formed.

However, the system has not yet completed abstraction unification. Several groups of old structures that participate in normal runtime currently remain:

```text
Formal path
ModelSelection -> Registry -> ModelFactory -> Model

Concurrent path
Runtime Config -> modelAdapter -> Compatibility Model
Old Catalog / Connection / modelId hardcode -> Re-infer Properties and Options
ModelRef -> Simultaneously承担 Selection, Identity, Variant, Request, and Result ownership
New Registry Model View -> Reverse-project as old ModelProviderModelConfig -> Service / UI
```

Therefore, M4 is a necessary convergence, but completing only M4 does not prove the system has only one model abstraction. A dedicated model abstraction cleanup phase is still needed after M4.

## 5. Issues Found

### 5.1 Core Still Simultaneously Depends on ModelFactory and Old Model Adapter (Ruled for Deletion)

Detailed implementation Todo: [`../steps/todo-01-core-model-adapter-boundary-cleanup.md`](../steps/todo-01-core-model-adapter-boundary-cleanup.md)

`AgentRuntimeDeps` and `AgentRuntime` currently hold:

- `modelFactory`;
- `modelAdapter: any`;
- `modelConnectionPort`;
- `resolveRuntimeModelLimits`;
- `resolveModelProviderOptions`;
- `providerRuntimeHeadersPort`.

`createRuntimeModel()` creates formal Models when `modelFactory` exists; when the Factory is missing, it automatically uses `modelAdapter`
to create Compatibility Models. This Compatibility Model self-fills context window, max output, input formats, Tools,
Structured Output, WebSearch, and Mid-conversation System facts.

Current representative default values for Compatibility Models include:

- context window `200_000`;
- max output `32_000`;
- Text, Image, Video, PDF supported;
- Audio not supported;
- Tool Call, Structured Output supported;
- WebSearch and Mid-conversation System inferred based on Connection, Endpoint, or modelId.

This is not merely a compatibility naming, but a model fact source parallel to Effective Model Config. As long as Core allows the implicit path when Factory is missing, production assembly omissions cannot be detected by type or startup integrity checks.

Static scanning shows that 17 Core production files currently still reference `modelAdapter`, and about 15 Core production files reference
`modelConnectionPort`. Some titles, Memory, Compact, Subagent, and model-type tool sub-branches still judge capability availability based on whether Adapters or Connections exist.

Confirmed design rulings:

- Core deletes `modelAdapter` dependency and Compatibility Models;
- When ModelFactory is missing, no fallback to Adapter or Core-assembled model facts;
- All production model execution entries must obtain formal ModelFactory;
- Test model calls switch to Fake Models / Fake ModelFactory, no production compatibility entries reserved for tests;
- Adapters can still serve as Bootstrap/ModelFactory downstream execution implementations, no requirement to delete the `modelAdapter` concept from the entire repo;
- Whether `modelFactory` is required on `AgentRuntimeDeps` types for pure state-only Runtimes can be decided by actual construction forms,
  but any Factory-less Runtime must be unable to execute model requests.

Implementation assessment: This cleanup has clear boundaries and controllable risk, but is not a trivial deletion. Static scans after M4 still find 17 Core production files referencing `modelAdapter`, Workflow Child Factory types are still optional, and about 29 Core/Bootstrap test files provide only Adapters without Factories. Implementation must first migrate test assemblies and production Child Runtimes, then delete Core fallbacks, fields, and feature gates. It should be a standalone, test-first cleanup commit and must not cross-edit with unsubmitted test modifications from parallel M4 Reviews.

### 5.2 M4's Special Execution Model Chain Physically Exited

M4 has deleted the following old concepts:

- `turnRuntimeModel`;
- `TurnExecutionModel`;
- `ExecutionScopedModelSource`;
- `createRuntimeModelFactory`;
- Runtime Provider temporary Overlays;
- State machines for temporary switching and restoring Session models.

Idle tasks, Compacts, Subagents, and normal sessions now use the same Selection, Registry, ModelFactory, and Active
Models, without producing second complete Provider/Model snapshots. All the above symbols are zero in production source scans; only one
`turnRuntimeModel` literal remains in protocol tests, used to prove old fields cannot enter new command contracts.

### 5.3 Dead ModelPort Interface Still Retained

The old `ModelPort` still defines `generateText` / `streamText` interfaces with `ModelTextRequest` inputs, plus
`ModelPortOptions`. No valid production calls were found in current static reference audits.

It is a duplicate Core-facing execution interface to the new `Model`, and should be deleted as明确 dead code. When deleting, do not retype
`modelAdapter: any` as `ModelPort`, which would merely restore the old abstraction.

### 5.4 New Model's Result/Events Still Built on Old ModelRef Protocol

The new `Model` has defined unified Properties, Option Specs, Options, and call methods, but `ModelResult` and
`ModelEvent` are temporarily still aliases of old `ModelTextResult` and `ModelStreamEvent`.

`ModelRef` in the old protocol simultaneously carries:

- `providerId`;
- `modelId`;
- Optional `variant`.

It is currently still widely used for:

- Old `ModelTextRequest`;
- `ModelTextResult`;
- Stream Events;
- Network Status;
- Telemetry;
- Message and execution ownership;
- Runtime selection and compatibility conversion.

`ModelRef` still appears in about 48 production files in static scans. Direct batch deletion is not possible here because some of these genuinely need to record executed model identities; the problem is that the same type mixes selection intent, execution identity, reasoning variants, and request parameters.

Questions needing discussion:

1. Whether to formally establish a `ModelIdentity` containing only `providerId + modelId`;
2. Whether `ModelSelection` is the only authorized serialized selection type carrying Options;
3. Whether Results, Events, and Telemetry save Identity, complete execution Options, or one execution Observation;
4. How `variant` exits, and how historical persisted data only converts at recovery boundaries;
5. Whether new `ModelResult` / `ModelEvent` should脱离 old DTOs before `ModelRef` is deleted.

### 5.5 Old Model Catalog Still a Parallel Fact System

Detailed implementation Todo: [`../steps/todo-08-legacy-model-catalog-retirement.md`](../steps/todo-08-legacy-model-catalog-retirement.md)

The following complete structures are currently still retained:

- `ModelCatalogConfig`;
- `ModelCapability` / `ModelCapabilityProvider`;
- `ModelCatalogService` / `ModelCatalogSource`;
- `models-dev` / `models-dev-snapshot`;
- `default-policy` / `reasoning-policy`;
- `runtime-thought-level`.

The bundled `models-dev-snapshot.ts` is about 2.3 MB. Currently discovered normal production constructions explicitly set
`modelsDev: false`, indicating the bundled database no longer carries main production facts; but Catalog types, merge logic, and policies are still referenced by Bootstrap, Adapters, and old config chains.

Target boundaries should be:

```text
Normal runtime
Built-in / Personal Config -> Effective Rules -> Registry -> Model

Historical migration
Legacy Config -> Private Importer -> New Config
                              `-> Terminate here
```

Confirmed Legacy Config rulings:

- Delete old `modelCatalog.overrides` Schema, parsing, merging, and tests; do not write Personal Model Config importers for it;
- The context, input formats, Tool/Structured Output, reasoning tiers, default values, and request parameter mappings once expressed by this structure can all be completely expressed by Personal Model Config Rules; no unique runtime capabilities must be retained;
- Although the Legacy parser currently parses `modelCatalog.overrides`, formal importers do not consume those results, so deleting it will not cancel a currently valid migration behavior;
- Regular Provider/Model configurations already explicitly supported by importers in old `provider.*.models.*` continue migration; the existing migration boundary must not be expanded or narrowed for deleting `modelCatalog.overrides`;
- Old display metadata like `name`, `family` do not constitute reasons to retain Catalogs; if there are future product uses, they should enter current display configs, not re-establish Catalog authority.

The physical cleanup of the above rulings and remaining Catalog data/source, capability/default policies, Reasoning Selection Views, and Tool Schema compatibility special judgments is uniformly implemented by Todo 08; they must not continue scattered in already-completed Todo 02.

### 5.5.1 Reasoning Selector Reuses Model Selection Chain

`ZCodeModelReasoningState` is not a model runtime state. It is currently sent cross-process with `ZCodeModelOption`, mainly providing reasoning tiers and defaults for model selection interfaces like input boxes,
Subagents, idle tasks, and Repo Wikis. The target is not to establish independent reasoning queries or status chains, but to reuse model selection candidates:

```text
Effective Model Config.optionSpecs.reasoningLevel
                         |
                         v
            Registry Model Selection View
                         |
                         v
                Currently selected model candidates
                         |
                         +--> Composer reasoning selector
                         +--> Subagent / Off-Peak / Repo Wiki
                         `--> Submit ModelSelection.options.reasoningLevel
```

Confirmed rulings:

- Available tiers and defaults belong to the model selection candidate's `optionSpecs.reasoningLevel`, read directly by the frontend from the currently selected candidate;
- `ModelSelection` only saves user-explicitly selected `options.reasoningLevel`, does not copy entire tier specifications;
- Delete independent `ZCodeModelReasoningState` concept and misleading `State` naming; do not establish a second reasoning fetch, store, or sync channel;
- `enabled` is a redundant field: the existence of `optionSpecs.reasoningLevel` completely expresses whether the model provides this option;
- `providerOptionsByLevel` does not enter Protocol/UI. Provider request parameter mappings only stay in the Effective Model Config's
  `reasoningMapping`, consumed by ModelFactory/Adapters on the execution side;
- Protocols can strictly serialize Option Specs needed for selection candidates, but it is part of the Registry Selection View, not a
  new model fact source.

### 5.6 Capability Inference Paths Outside Model Properties

The new `ModelProperties` already includes capabilities like input/output formats, Tools, Structured Output, Native WebSearch, and
Mid-conversation System. However, paths still exist in Core and Adapters to infer capabilities based on:

- providerKind;
- baseURL / Endpoint host;
- specific modelId or modelId prefix;
- specific Provider ID.

Current representative hardcodes include `claude-opus-4-8`, DeepSeek Endpoints, DeepSeek V4, MIMO, Kimi K3,
GitHub Copilot, and GPT string combinations.

Two issues need to be distinguished here:

```text
Whether a model supports a capability
    -> Effective Model Config / Model.properties

How an API type encodes capabilities into wire requests
    -> Adapter implementation or explicit Adapter compatibility config
```

Current partial helpers mix "capability facts" and "encoding limitations." For example, Configs can declare Native WebSearch as supported, while Adapters may not encode tools because the Endpoint is not in the allowlist, producing two ruling sources.

Questions needing discussion:

1. Which hardcodes are model capabilities and should be migrated to Built-in Model Config Rules;
2. Which are API protocol compatibilities and should switch to being driven by `api.type` or explicit compatibility flags;
3. Whether Adapters are allowed to know specific model IDs; if so, what are the boundaries and central locations;
4. Whether model name inference in one-time legacy importers is retained as the sole exception.

### 5.7 Idle Models Re-projected Back to Old Provider Model DTOs

Idle tasks can now read models from the new Provider Config resolution, but Services then reconstruct each model into old
`ModelProviderModelConfig`, including old `modalities` and old reasoning patch structures. Subscription Providers and UI
continue consuming this DTO.

This chain does not change the Registry's fact source, but keeps the old complete Provider Model Schema as an active Service/UI interface,
and may induce subsequent features to continue relying on old fields.

Questions needing discussion:

1. What fields idle task pages truly need;
2. Whether to establish a minimal `OffPeakModelOption` / View rather than returning full Model Config;
3. Whether reasoning display should read new Option Specs directly, or be uniformly provided by Selection View;
4. Whether `ModelProviderModelConfig` should ultimately only appear in legacy importers.

### 5.8 Dynamic Authentication Still Refreshed Through Core Runtime Header Compatibility Chain

API Key Providers can save static access materials directly from Provider Config. Dynamic credentials for account-type Providers are not managed by Config; account services must resolve current access materials during request execution.

The new direction is for ModelFactory to assemble `ModelRequestDependencies` when creating Models. But existing account Providers still refresh Headers before each physical request through Core's `providerRuntimeHeadersPort` and Model Invocation Context. Sub-branches like Titles,
Compacts, Memories, Verifiers, and Subagents therefore need to explicitly propagate refresh callbacks.

This keeps Core knowing about Provider authentication lifecycles, but the complete overhaul of Account Providers does not belong to M4. Currently classified as subsequent domain boundaries, not requiring M4 to delete simultaneously.

Questions needing discussion:

1. Whether the Account Provider phase uniformly assembles account Request Auth Sources into ModelFactory;
2. Whether Core only retains call context like Trace, Status, etc., no longer holding credential refresh capabilities;
3. Whether dynamic credential refreshes only update access materials, prohibiting re-parsing of complete Provider/Models;
4. Whether this cleanup belongs to M5, M6, or a separate Auth convergence phase.

## 6. Currently Confirmed Retainable Boundaries

The following structures are not objects this audit requires directly deleting:

### 6.1 Adapter Internal Provider SDK Implementations

AI SDK, OpenAI, Anthropic, and other specific clients can continue to exist in Adapters. Business layers cannot directly depend on them, and Adapters cannot
expose a second Model Selection or capability system to Core.

### 6.2 Adapter Execution Infrastructure

Adapters can maintain API factories, transports, signature caches, and other execution infrastructure internally, but no longer maintain Provider lists or queryable
Execution Registries. baseURL, API type, static Headers, and Model Config are bound once at Model creation time, not accepting
temporary business-layer Overlays that re-become model fact sources.

### 6.3 Strict Protocol Schemas

Cross-process protocols need independent runtime schema validation. Protocol types need not share the same declarations with in-process TypeScript types, but their
semantics must align with `ModelSelection`, not re-introduce complete Runtime Models, Provider snapshots, or alternative Options expressions.

### 6.4 One-Time Legacy Importers

Importers can recognize published old fields, old modalities, and historical reasoning configurations, but conversion results must immediately enter new Config.
Old types must not leak from importers into Registries, Runtimes, Service Views, or UIs.

## 7. Recommended Itemized Discussion Order

Subsequent discussions should proceed by dependencies, not cram all issues into the same implementation branch:

1. **M4 Zero Gates**: Continuously confirm old special execution symbols remain zero;
2. **Core Model-only**: Rule whether ModelFactory becomes the mandatory dependency for all executable Runtimes;
3. **Selection / Model / Identity**: Clarify three concepts and identity expressions for Results, Events, and Telemetry;
4. **Old Catalog Retirement**: Confirm the minimal retention scope of legacy importers;
5. **Capabilities and Wire Compatibility**: Classify existing modelId, Provider, and Endpoint hardcodes item by item;
6. **Service/UI Old DTO Retirement**: Eliminate reverse projections starting from idle model Views;
7. **Account Request Auth**: Delete Core Header refresh compatibility chain in the account Provider phase;
8. **Final Mechanical Gates**: Solidify rules prohibiting old abstraction reintroduction into tests or static checks.

Items 2 through 6 jointly constitute the candidate "M4 post-model abstraction unification cleanup." Whether to set as an independent milestone and how to number them must be decided after itemized rulings are completed.

## 8. Candidate Mechanical Acceptance Conditions

The following are candidate zero conditions proposed by this audit, representing deletions that cannot be executed without discussion:

```text
modelAdapter in Core                         = 0
modelConnectionPort in Core                  = 0
ModelPort / ModelPortOptions                  = 0
TurnExecutionModel                           = 0
ExecutionScopedModelSource                   = 0
turnRuntimeModel                             = 0
ModelRef.variant                             = 0
ModelCatalogConfig in normal runtime         = 0
ModelProviderModelConfig in Service/UI normal paths = 0
Judging model capabilities by specific modelId outside Config = 0
```

Additionally, behavioral acceptances are needed:

- Normal sessions, idle tasks, Compacts, Memories, Titles, Goals, Subagents, Workflows, and model-type tools all obtain Models from ModelFactory;
- Current Loops only read their own Active Models, falling back to Session default selections or mutable Registries;
- Registry updates only affect subsequently created Models;
- Model Properties are Core's sole fact for capability judgment;
- Adapter encoding limitations do not silently override Config's model capability declarations;
- Protocols, Telemetry, and persistence can record real execution models, but do not re-承担 model selection or configuration responsibilities;
- Legacy Configs can only be unidirectionally imported and cannot continue to serve as runtime fallbacks.

## 9. Confidence Boundaries and Subsequent Maintenance

This audit's conclusions come from production code static call scans, old export reference audits, Config/Registry/ModelFactory call chain checks, and read-only observations of the current M4 work tree. Complete `knip` results contain substantial repository noise, so only symbol-level reviewed results are written to conclusions; "no static references found" also does not prove absence of strings or dynamic imports.

M4 items have been re-scanned and marked complete against current production code. The remaining symbol counts and call locations are still pre-audit snapshots; remaining production references need to be re-scanned before entering the next cleanup phase, and conclusions经过 itemized rulings must be synchronized to formal design and subsequent implementation documents. This file does not replace formal design, nor does it prematurely solidify un-discussed suggestions into target contracts.
