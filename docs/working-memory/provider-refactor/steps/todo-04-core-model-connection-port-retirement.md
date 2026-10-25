# 04 Core Model Connection Port Retirement

> Status: Completed
>
> Date: 2026-08-24
>
> Overall roadmap: [`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)
>
> Prerequisites: [`todo-02-ai-sdk-execution-registry-retirement.md`](./todo-02-ai-sdk-execution-registry-retirement.md),
> [`todo-03-provider-model-ownership-and-property-totality.md`](./todo-03-provider-model-ownership-and-property-totality.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-04-core-model-connection-port-retirement.md`

## 1. Objective

Delete `ModelConnectionPort` / `ModelConnectionInfo` from Core and public business Contracts. Core capability judgments
read only the current Active Model's `properties`; physical connection facts (API Key, Header, baseURL, Provider SDK
kind, providerOptions) exist only in the Adapter's request execution implementation. Before: Core Runtime / Tool read
Active Model.properties and also `ModelConnectionPort.resolveConnection(ModelRef)` (apiKey / headers, baseURL /
providerKind, providerOptions) to infer WebSearch / MCS / diagnostics again. Target: Core reads
`supportsNativeWebSearch` and `supportsMidConversationSystem` from Active Model.properties; the Adapter privately holds
baseURL / SDK kind / credentials / headers / providerOptions.

## 2. Principles

1. Model capabilities are static facts of Effective Model Config, readable only from Active Model.properties.
2. Model Config Rules producing capability facts may match on model, Provider, API type and other resolution context;
   Core never re-infers by Endpoint, Provider type or specific modelId.
3. Connection is an Adapter request implementation detail, not a query service for Tool/Runtime; API Key and Header
   never enter Core for capability judgment.
4. No Telemetry refactor; no masked Connection, Observation or Context DTOs. Adapter-internal connection parameters use
   private types not exported from `@zcode/contracts`.

## 3. Consumers and Target Handling

**3.1 Mid-conversation System (MCS).** `mid-conversation-system.ts` previously inferred MCS through
`providerKind + baseURL + modelId hardcode` and built a masked Connection Context. Now:
`useMidConversationSystem = mode === "force" || model.properties.supportsMidConversationSystem`. `auto` reads the
property; `force` is this invocation's override and neither modifies Model properties nor enters Model Config; the
judgment occurs where this round's Provider messages are generated and `midConversationSystemMode` does not enter
ModelFactory. Fast model ID / baseURL allowlist / provider kind / Connection resolve fallback are deleted; the decision
keeps only a business-needed boolean/reason; Model Config Rules declare facts per model and connection combination.

**3.2 Native WebSearch.** The Tool reads `properties.supportsNativeWebSearch` from the current Model: false returns the
existing recoverable configuration error; true continues with Adapter Provider-native tool encoding. The Adapter selects
encoding only by the complete Provider Config's `api.type` (no baseURL allowlist); if it cannot encode for that API
type it throws typed `InvalidModelRequest` before the network request (never returns `undefined` and silently deletes
the Tool, never bypassed via Config); generate and stream share the same encoding and fail-closed path. Deleted:
`resolveWebSearchModelConnection()`, `supportsProviderNativeWebSearch(connection)` and Connection diagnostic fields.

**3.2.1 Model Config capability rules.** `supportsNativeWebSearch` and `supportsMidConversationSystem` live in ZCode
Built-in / Personal Model Config Rules and become Effective Model Config.properties; rules resolve with context
`providerId`, `modelId`, `provider.api.type`. Capabilities universal to models use `modelMatch`; Provider-specific ones
combine `modelMatch + providerMatch`; protocol-dependent ones combine `modelMatch + apiMatch`. If deployment
distinctions by Endpoint are truly needed, extend the Model Rule's declarative resolution context (never put URL
judgment back into Runtime, Core, Importer or Adapter). Built-in general Rules supply complete conservative defaults,
precise Rules override real differences based on actual model/service support materials (not mechanical translation of
the old hostname allowlist). The legacy importer migrates only facts explicitly expressed by old configs; missing facts
are not inferred from Provider kind, baseURL or modelId.

**3.3 Embedded Search.** The final gate depends only on the global flag and Bash availability
(`embeddedSearchBranchEnabled + bashAvailable -> decision`); the Connection/ModelRef diagnostic context is deleted.

**3.4 Tool/Runtime context.** Delete `AgentRuntimeDeps.modelConnectionPort`, `AgentRuntime` /
`AgentRuntimeInternal.modelConnectionPort`, `ToolExecutionContext.modelConnectionPort`, Port passthroughs in the Tool
executor, Child Runtime and Workflow, and `modelRef + modelConnectionPort` parameter pairs created only for capability
judgment. Call sites needing capabilities receive/access the current `Model` (no extracted `ModelCapabilities` or
Connection-aware context). Tool acquisition has two semantics: non-execution inventory (persistent compatibility
fields, Context guidance, Plugin inventory) reads the Tool Registry directly without a Model; this request's tool set
(main requests, Compact, Memory, Child Agent) must use that execution's own Active Model and filter by `properties`.
Child Agent models may differ: the parent passes only the registered Tool inventory and the Child Runtime filters by its
own Active Model. No fallback / default / fake Model built from Session Selection or Connection.

**3.5 Contracts and Adapter.** Delete public `model-connection.port.ts`, `ModelConnectionProviderKind`,
`ModelConnectionInfo`, `ModelConnectionPort`, barrel exports, `AiSdkModelAdapter.resolveConnection()` and
`AiSdkResolvedModelConnection`. Adapter execution functions needing `baseURL/providerKind/apiKey/headers/providerOptions`
use local or Adapter-private types that Core, Bootstrap business layer and Tools cannot import.

## 4. Telemetry Boundary

Network Status/Telemetry already holds providerId, model, baseURL, providerKind. This Todo neither judges nor refactors
that. Allowed: after Port deletion the Adapter fills the existing fields at the existing network event production points
from its own execution facts. Forbidden: a new `TelemetryContext`, `ModelTelemetryObservation`, passing a complete
Connection as event payload, Core retaining Connection for Telemetry, splitting Product Status and Telemetry.

## 5. Tests and Mechanical Zero

- Capability facts: `supportsMidConversationSystem=true/false` enable/close MCS; MCS `force` keeps override semantics;
  different modelId/baseURL with the same property yield the same Core behavior; `supportsNativeWebSearch=true/false`
  allow/deny WebSearch; Adapter-unsupported API types fail closed before the network even with property=true (generate
  and stream consistent); Embedded Search depends only on the feature flag and Bash availability.
- Data boundary: Core/Tool context exposes no apiKey, headers, baseURL, providerKind, providerOptions; Active
  Model.properties is the sole capability input; Main, Compact and Subagent use their own Active Model's properties;
  Config updates do not change capabilities of started loops; non-execution Tool inventory creates no Model while
  execution Tool filtering holds the current Active Model; network Status/Telemetry is still emitted by the Adapter
  with unchanged event count and timing.
- Mechanical zero: `rg 'ModelConnectionPort|ModelConnectionInfo' apps/zcode-cli/packages/core`; public Contracts export
  no Connection types; `resolveConnection` not an Adapter public capability; Core MCS/WebSearch helpers judging by
  baseURL/providerKind/modelId; legacy importer logic inferring MCS/WebSearch by those; provider-native Tool encoding
  using `undefined` for "not supported, silently delete"; new `*Capabilities`, `*ConnectionContext`, `*Observation`
  substitute DTOs: all zero.

## 6. Implementation Order and Completion

Steps: A pass Active Model to capability consumers (failing property-based tests for MCS, WebSearch, Embedded Search;
trace the current Model source for Tool context; pass only Model, not Connection or derived snapshots); B migrate
capability judgment (MCS, WebSearch, Embedded Search; delete old Endpoint/model hardcode and fallback reason); C delete
the Port (Runtime/Tool/Workflow fields and passthroughs, Contracts files and barrel export, Adapter public
`resolveConnection()`; keep Adapter private execution facts); D verify (Core WebSearch, MCS, Embedded Search, Compact,
Subagent unit tests; Adapter encoding and network event regression; `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`;
independent Conventional Commit).

Completion: Core cannot obtain physical Provider Connection nor infer model capabilities through it; business
capabilities come from the current Active Model.properties; connection, authentication and Provider SDK details are used
only when the Adapter executes requests; Telemetry keeps its existing design with no new Context or Observation
abstraction.
