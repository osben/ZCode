# Model Abstraction Unification Cleanup Audit

> Status: Pre-cleanup review after M4 completion; M4 items are zero, remaining issues await itemized rulings
>
> Date: 2026-08-24
>
> Target design: [`../design/design.md`](../design/design.md)
>
> Current parallel phase: [`../steps/04-model-execution-cutover.md`](../steps/04-model-execution-cutover.md)

## 1. Document Positioning

The Provider Refactor established new Provider Config, Model Config Rules, Registry, ModelFactory, and `Model` call boundaries, deleted most old Provider/Model implementations, and migrated idle tasks and Subagents onto the standard model call chain. This audit does not re-judge phase completion; it checks whether the system still has a second model abstraction, a second model assembly path, or a second model fact source, and outputs the old-code cleanup list, dependencies, deletion prerequisites, and mechanical zero conditions. Items requiring design rulings stay open for itemized discussion before entering formal design and implementation.

Division of labor with the parallel new code review (which checks whether M4 new implementation is correct and complete): this audit checks what old code, old abstractions, and compatible paths can be physically exited now that the new chain is established. New implementations are read only as deletion evidence.

Questions answered:

1. Can business code still bypass `ModelFactory` and execute model requests directly through old Adapters or old request DTOs?
2. Are `ModelSelection`, `Model`, model identity, requests, and results still mixed in old `ModelRef`?
3. Do Catalogs, Runtime Configs, Endpoints, or modelId hardcodes still provide model facts outside Provider/Model Config?
4. Do Core, Services, Protocol, and UI still consume old Provider/Model complete DTOs?
5. Which old implementations should be physically deleted, and which stay constrained within Adapter, Protocol, or one-time importer boundaries?
6. What mechanical checks after M4 prove the abstraction truly converged?

> What alternative capabilities has the new design provided; why does code depending on the old design still exist; can it be deleted now; if not yet deletable, what is the last missing migration prerequisite?

## 2. Target Architecture for Audit

The target system has one model formation and execution chain:

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

| Concept                   | Unique Responsibility                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ModelSelection`          | Express user or product intent for future model creation; can be persisted and cross-process transferred               |
| Effective Provider Config | Determine Provider, API, Access, model members, and user visibility                                                    |
| Effective Model Config    | Determine model Properties, Option Specs, and request parameter mapping                                                |
| Provider Registry         | Aggregate Effective Config; provide resolution and Views by Provider/Model identity                                    |
| `ModelFactory`            | Assemble Selection, Registry facts, and request dependencies into complete `Model`                                     |
| `Model`                   | Immutable model facts for current execution and the sole model call interface                                          |
| Adapter                   | Encode `ModelRequest` into specific Provider API requests; do not output a second model abstraction to business layers |
| Model Identity            | If events, Telemetry truly need it, record only actual model identity; carries no Selection or Options semantics       |

Core recognizes only `ModelSelection` and `Model` (at most a minimal read-only Model Identity). Core must not recognize AI SDK Adapters, Provider Connections, baseURL, providerKind, old Catalog capabilities, or capabilities inferred by specific modelId.

## 3. Audit Classification Principles

Deletion is not judged by name:

| Category                           | Meaning                                                                                           | Handling Principle                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| M4 Already Exited                  | Special execution dual-track belonging to M4 and already deleted                                  | Maintain zero gates, prevent reintroduction                                 |
| Runtime Second Abstraction         | Still participates in normal model selection, assembly, capability judgment, or request execution | Must be migrated to the unified chain and the old entry deleted             |
| Legitimate Boundary Implementation | Adapter internal execution, strict Protocol schema, or one-time legacy importer                   | Can be retained, but must not leak back into Core, Registry, Service, or UI |
| Subsequent Domain Boundary         | Known not belonging to M4, requiring re-assignment by later phases                                | Record dependencies and final direction; do not conveniently modify in M4   |

`AiSdkModelAdapter` is not itself an "old model abstraction" to delete; it can remain the concrete execution implementation. The question is whether Core directly depends on it, and whether it re-becomes a second business model entry through public DTOs, Connections, or mutable Registries.

## 4. Current Overall Conclusion

Main business model calls mostly go through `Model.generateText()` / `Model.streamText()`; direct calls to OpenAI/Anthropic/other Provider SDKs have converged within Adapters — the new public call boundary has formed. But abstraction unification is incomplete; several old structures still participate in normal runtime:

```text
Formal path
ModelSelection -> Registry -> ModelFactory -> Model

Concurrent path
Runtime Config -> modelAdapter -> Compatibility Model
Old Catalog / Connection / modelId hardcode -> Re-infer Properties and Options
ModelRef -> Simultaneously carries Selection, Identity, Variant, Request, and Result ownership
New Registry Model View -> Reverse-project as old ModelProviderModelConfig -> Service / UI
```

M4 was a necessary convergence, but completing it does not prove the system has only one model abstraction; a dedicated model abstraction cleanup phase follows M4.

## 5. Issues Found

### 5.1 Core Still Simultaneously Depends on ModelFactory and Old Model Adapter (Ruled for Deletion)

Implementation Todo: [`../steps/todo-01-core-model-adapter-boundary-cleanup.md`](../steps/todo-01-core-model-adapter-boundary-cleanup.md)

`AgentRuntimeDeps` and `AgentRuntime` hold `modelFactory`; `modelAdapter: any`; `modelConnectionPort`; `resolveRuntimeModelLimits`; `resolveModelProviderOptions`; `providerRuntimeHeadersPort`. `createRuntimeModel()` creates formal Models when `modelFactory` exists, otherwise falls back to `modelAdapter` Compatibility Models that self-fill context window (`200_000`), max output (`32_000`), input formats (Text/Image/Video/PDF, not Audio), Tool Call, Structured Output, and WebSearch/MCS facts inferred from Connection, Endpoint, or modelId. This is a model fact source parallel to Effective Model Config: with the implicit path allowed, production assembly omissions cannot be caught by type or startup integrity checks. Static scanning: 17 Core production files reference `modelAdapter`, ~15 reference `modelConnectionPort`; some Titles, Memory, Compact, Subagent, and model-type tool sub-branches still judge capability availability from Adapter/Connection existence.

Confirmed rulings:

- Core deletes `modelAdapter` dependency and Compatibility Models;
- When ModelFactory is missing, no fallback to Adapter or Core-assembled model facts;
- All production model execution entries must obtain a formal ModelFactory;
- Test model calls switch to Fake Models / Fake ModelFactory; no production compatibility entries reserved for tests;
- Adapters can still serve as Bootstrap/ModelFactory downstream execution implementations; no requirement to delete the `modelAdapter` concept from the entire repo;
- Whether `modelFactory` is required on `AgentRuntimeDeps` types for pure state-only Runtimes can follow the actual construction forms, but any Factory-less Runtime must be unable to execute model requests.

Implementation assessment: clear boundaries and controllable risk, but not a trivial deletion — Workflow Child Factory types are still optional and ~29 Core/Bootstrap test files provide only Adapters without Factories. Migrate test assemblies and production Child Runtimes first, then delete Core fallbacks, fields, and feature gates. A standalone, test-first cleanup commit; must not cross-edit with unsubmitted test modifications from parallel M4 reviews.

### 5.2 M4's Special Execution Model Chain Physically Exited

M4 deleted `turnRuntimeModel`, `TurnExecutionModel`, `ExecutionScopedModelSource`, `createRuntimeModelFactory`, runtime Provider temporary Overlays, and the state machines for temporary switching/restoring Session models. Idle tasks, Compacts, Subagents, and normal sessions now use the same Selection, Registry, ModelFactory, and Active Models, without second complete Provider/Model snapshots. All symbols are zero in production scans; one `turnRuntimeModel` literal remains in protocol tests to prove old fields cannot enter new command contracts.

### 5.3 Dead ModelPort Interface Still Retained

The old `ModelPort` still defines `generateText` / `streamText` with `ModelTextRequest` inputs plus `ModelPortOptions`; no valid production calls remain in static reference audits. It duplicates the new `Model` as a Core-facing execution interface and should be deleted as dead code. Do not retype `modelAdapter: any` as `ModelPort` — that would restore the old abstraction.

### 5.4 New Model's Result/Events Still Built on Old ModelRef Protocol

`ModelResult` and `ModelEvent` are still aliases of old `ModelTextResult` / `ModelStreamEvent`. `ModelRef` (`providerId` + optional `variant`) is still widely used for old `ModelTextRequest`, `ModelTextResult`, stream events, network status, telemetry, message and execution ownership, and runtime selection/compatibility conversion — about 48 production files. Batch deletion is impossible: some genuinely record executed model identity; the problem is the same type mixing selection intent, execution identity, reasoning variants, and request parameters.

Questions needing discussion:

1. Whether to establish a `ModelIdentity` containing only `providerId + modelId`;
2. Whether `ModelSelection` is the only authorized serialized selection type carrying Options;
3. Whether Results, Events, and Telemetry save Identity, complete execution Options, or one execution Observation;
4. How `variant` exits, and how historical persisted data converts only at recovery boundaries;
5. Whether new `ModelResult` / `ModelEvent` should detach from old DTOs before `ModelRef` is deleted.

### 5.5 Old Model Catalog Still a Parallel Fact System

Implementation Todo: [`../steps/todo-08-legacy-model-catalog-retirement.md`](../steps/todo-08-legacy-model-catalog-retirement.md)

Still retained: `ModelCatalogConfig`; `ModelCapability` / `ModelCapabilityProvider`; `ModelCatalogService` / `ModelCatalogSource`; `models-dev` / `models-dev-snapshot` (~2.3 MB bundled; discovered normal production constructions explicitly set `modelsDev: false`); `default-policy` / `reasoning-policy`; `runtime-thought-level`. Catalog types, merge logic, and policies are still referenced by Bootstrap, Adapters, and old config chains.

```text
Normal runtime
Built-in / Personal Config -> Effective Rules -> Registry -> Model

Historical migration
Legacy Config -> Private Importer -> New Config
                              `-> Terminate here
```

Confirmed Legacy Config rulings:

- Delete old `modelCatalog.overrides` Schema, parsing, merging, and tests; do not write Personal Model Config importers for it;
- The context, input formats, Tool/Structured Output, reasoning tiers, defaults, and request parameter mappings once expressed there are fully expressible by Personal Model Config Rules; no unique runtime capabilities must be retained;
- The Legacy parser currently parses `modelCatalog.overrides` but formal importers do not consume those results, so deleting it cancels no valid migration behavior;
- Regular Provider/Model configurations explicitly supported by importers in old `provider.*.models.*` continue migration; the existing migration boundary must not be expanded or narrowed for this deletion;
- Old display metadata like `name`, `family` do not justify retaining Catalogs; future product uses enter current display configs, not re-established Catalog authority.

Physical cleanup of these rulings plus remaining Catalog data/source, capability/default policies, Reasoning Selection Views, and Tool Schema compatibility special judgments is implemented uniformly by Todo 08; it must not stay scattered in completed Todo 02.

#### 5.5.1 Reasoning Selector Reuses Model Selection Chain

`ZCodeModelReasoningState` is not a model runtime state. It travels cross-process with `ZCodeModelOption`, mainly providing reasoning tiers and defaults for model selection interfaces (input boxes, Subagents, idle tasks, Repo Wikis). The target is not an independent reasoning query/status chain but reuse of model selection candidates:

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

- Available tiers and defaults belong to the candidate's `optionSpecs.reasoningLevel`, read directly by the frontend from the currently selected candidate;
- `ModelSelection` saves only user-explicit `options.reasoningLevel`, not entire tier specifications;
- Delete the independent `ZCodeModelReasoningState` concept and its misleading `State` naming; no second reasoning fetch, store, or sync channel;
- `enabled` is redundant: the existence of `optionSpecs.reasoningLevel` fully expresses availability;
- `providerOptionsByLevel` does not enter Protocol/UI. Provider request parameter mappings stay in Effective Model Config `reasoningMapping`, consumed by ModelFactory/Adapters on the execution side;
- Protocols can strictly serialize Option Specs for selection candidates, but as part of the Registry Selection View, not a new model fact source.

### 5.6 Capability Inference Paths Outside Model Properties

The new `ModelProperties` already covers input/output formats, Tools, Structured Output, Native WebSearch, and MCS. But Core and Adapters still infer capabilities from providerKind, baseURL / Endpoint host, specific modelId or prefixes, and specific Provider IDs — representative hardcodes include `claude-opus-4-8`, DeepSeek Endpoints, DeepSeek V4, MIMO, Kimi K3, GitHub Copilot, and GPT string combinations.

Distinguish two issues:

```text
Whether a model supports a capability
    -> Effective Model Config / Model.properties

How an API type encodes capabilities into wire requests
    -> Adapter implementation or explicit Adapter compatibility config
```

Some helpers mix "capability facts" and "encoding limitations": Configs can declare Native WebSearch supported while an Adapter declines to encode the tool because the Endpoint is not allowlisted — two ruling sources.

Questions: which hardcodes are model capabilities migrating to Built-in Model Config Rules; which are API protocol compatibilities switching to `api.type` or explicit compatibility flags; whether Adapters may know specific model IDs, with what boundaries and central locations; and whether model-name inference in one-time legacy importers stays the sole exception.

### 5.7 Idle Models Re-projected Back to Old Provider Model DTOs

Idle tasks can read models from the new Provider Config resolution, but Services reconstruct each model into old `ModelProviderModelConfig` (including old `modalities` and old reasoning patch structures), which subscription Providers and UI consume. The Registry's fact source is unchanged, but the old complete Provider Model Schema stays an active Service/UI interface and may induce later features to keep relying on old fields.

Questions: what fields idle task pages truly need; whether to establish a minimal `OffPeakModelOption` / View instead of returning full Model Config; whether reasoning display reads new Option Specs directly or is uniformly provided by Selection View; whether `ModelProviderModelConfig` ultimately appears only in legacy importers.

### 5.8 Dynamic Authentication Still Refreshed Through Core Runtime Header Compatibility Chain

API Key Providers save static access materials in Provider Config. Dynamic credentials for account-type Providers are not Config-managed; account services must resolve current access materials at request execution. The new direction has ModelFactory assemble `ModelRequestDependencies` at Model creation, but existing account Providers still refresh Headers before each physical request through Core's `providerRuntimeHeadersPort` and Model Invocation Context; Titles, Compacts, Memories, Verifiers, and Subagents sub-branches must explicitly propagate refresh callbacks. Core thus still knows the Provider authentication lifecycle; the complete Account Provider overhaul is out of M4 scope — a subsequent domain boundary, not required to be deleted in M4.

Questions: whether the Account Provider phase uniformly assembles account Request Auth Sources into ModelFactory; whether Core keeps only call context (Trace, Status) without credential refresh capabilities; whether dynamic credential refreshes only update access materials without re-parsing complete Provider/Models; whether this cleanup belongs to M5, M6, or a separate Auth convergence phase.

## 6. Currently Confirmed Retainable Boundaries

### 6.1 Adapter Internal Provider SDK Implementations

AI SDK, OpenAI, Anthropic, and other specific clients can continue in Adapters. Business layers must not depend on them directly; Adapters must not expose a second Model Selection or capability system to Core.

### 6.2 Adapter Execution Infrastructure

Adapters can maintain API factories, transports, signature caches, and similar execution infrastructure internally, but no Provider lists or queryable Execution Registries. baseURL, API type, static Headers, and Model Config are bound once at Model creation, not accepting temporary business-layer Overlays that re-become model fact sources.

### 6.3 Strict Protocol Schemas

Cross-process protocols need independent runtime schema validation. Protocol types need not share declarations with in-process TypeScript types, but their semantics must align with `ModelSelection`, not re-introduce complete Runtime Models, Provider snapshots, or alternative Options expressions.

### 6.4 One-Time Legacy Importers

Importers can recognize published old fields, old modalities, and historical reasoning configurations, but conversion results immediately enter new Config. Old types must not leak from importers into Registries, Runtimes, Service Views, or UIs.

## 7. Recommended Itemized Discussion Order

Proceed by dependencies, not one implementation branch:

1. **M4 Zero Gates**: continuously confirm old special execution symbols remain zero;
2. **Core Model-only**: rule whether ModelFactory is the mandatory dependency for all executable Runtimes;
3. **Selection / Model / Identity**: clarify the three concepts and identity expressions for Results, Events, and Telemetry;
4. **Old Catalog Retirement**: confirm the minimal retention scope of legacy importers;
5. **Capabilities and Wire Compatibility**: classify existing modelId, Provider, and Endpoint hardcodes item by item;
6. **Service/UI Old DTO Retirement**: eliminate reverse projections starting from idle model Views;
7. **Account Request Auth**: delete the Core Header refresh compatibility chain in the account Provider phase;
8. **Final Mechanical Gates**: solidify rules prohibiting old abstraction reintroduction into tests or static checks.

Items 2–6 constitute the candidate "M4 post-model abstraction unification cleanup"; whether it is an independent milestone and its numbering are decided after itemized rulings.

## 8. Candidate Mechanical Acceptance Conditions

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

Behavioral acceptances:

- Normal sessions, idle tasks, Compacts, Memories, Titles, Goals, Subagents, Workflows, and model-type tools all obtain Models from ModelFactory;
- Current Loops read only their own Active Models, falling back to Session default selections or mutable Registries;
- Registry updates affect only subsequently created Models;
- Model Properties are Core's sole fact for capability judgment;
- Adapter encoding limitations do not silently override Config's model capability declarations;
- Protocols, Telemetry, and persistence can record real execution models but resume no model selection or configuration responsibility;
- Legacy Configs import unidirectionally only and never serve as runtime fallbacks.

## 9. Confidence Boundaries and Subsequent Maintenance

Conclusions come from production static call scans, old export reference audits, Config/Registry/ModelFactory call chain checks, and read-only observation of the M4 work tree. `knip` output contains substantial repository noise, so only symbol-level reviewed results are recorded; "no static references found" does not prove absence of strings or dynamic imports.

M4 items were re-scanned and marked complete against current production code. Remaining symbol counts and call locations are pre-audit snapshots: re-scan production references before the next cleanup phase, and synchronize ruled conclusions to formal design and implementation documents. This file replaces neither formal design nor prematurely solidifies undiscussed suggestions into target contracts.
