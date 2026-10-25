# 01 Core Model Adapter Boundary Cleanup

> Status: Complete
>
> Date: 2026-08-24
>
> Source: [`../research/model-abstraction-unification-cleanup-audit.md`](../research/model-abstraction-unification-cleanup-audit.md)
>
> Related design: [`../design/model/model.md`](../design/model/model.md), [`../design/registry/model-creation.md`](../design/registry/model-creation.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-01-core-model-adapter-boundary-cleanup.md`

## 1. Objective

Remove Core's direct dependency on `AiSdkModelAdapter` and the Compatibility Model fallback so all Core model requests
execute only through the standard chain: Provider Registry -> ModelFactory -> Core AgentRuntime -> Active Model ->
`AiSdkModelAdapter` -> Provider API. `AiSdkModelAdapter` remains the Provider API execution implementation (message and
tool encoding, Provider parameters, request authentication, AI SDK calls, retries, stream recovery, Usage/Event
normalization, network state observation); what is deleted are the bypasses (Core AgentRuntime -> `modelAdapter` ->
Compatibility Model / old `ModelTextRequest`). Afterwards Core knows only `ModelSelection`, `ModelFactory` and `Model`
and never holds, inspects or calls Adapters.

## 2. Rules

1. **Model is Core's only executable abstraction.** Core calls only `model.generateText(request)` /
   `model.streamText(request)`; it never calls Adapters or assembles Provider-specific requests.
2. **ModelFactory is the sole root execution Model production entry.** When a Factory is missing, do not fall back to
   an Adapter and do not let Core supplement Properties, Options, Provider Connections or default capabilities.
   `Model.bind()` is a legal derivation (same providerId/modelId, Properties, Option Specs and Executor; no Registry
   re-query; not a second root creation chain).
3. **Adapters live only in Bootstrap / ModelFactory downstream** (createZCodeApp -> AiSdkModelAdapter ->
   ApiProviderModelRuntime / ModelFactory -> Model). Core / Workflow business logic / Service / UI must not use
   `AiSdkModelAdapter`.
4. **Tests follow the same abstraction.** Use Fake Model / Fake ModelFactory; no test-only Adapter fallback and no
   wrapping old Adapter mocks (`AiSdkModelTextRequest`) as a compatible Factory; Bootstrap integration tests supply a
   standard `ModelRequest -> ModelResult/ModelEvent` Executor.
5. **Missing dependencies fail explicitly.** A production `AgentRuntime` must obtain a formal Factory. A state-only
   construction must guarantee model requests cannot execute and must not expose Subagent tools needing model creation;
   the Bootstrap state-only Adapter explicitly refuses at the sole `createModel()` boundary (no disguised deleted
   `generateText/streamText`, no dual type casting hiding a missing `createModel()`).

## 3. Deletion Scope

- Core Runtime: `AgentRuntimeDeps.modelAdapter`, `AgentRuntime.modelAdapter`, `AgentRuntimeInternal.modelAdapter`,
  Parent/Child replication of `modelAdapter`, runtime judgments of specific Adapter methods.
- Compatibility Model in Core `runtime-model.ts`: `createCompatibilityModel`, `resolveCompatibilityConnection`,
  `toCompatibilityRequest`, `resolveCompatibilityProviderOptions`, `COMPATIBILITY_CONTEXT_WINDOW`,
  `COMPATIBILITY_MAX_OUTPUT_TOKENS`, its output-token / thinking-budget calculation, `ModelRef` / `ModelSelection`
  conversion, hardcoded input/output format, and capability inference from Endpoint, providerKind or modelId.
  `createRuntimeModel()` may remain only as `runtime.modelFactory(input)` delegation, else inline and delete.
- Adapter existence gates (`if (!this.modelFactory && !this.modelAdapter) return;`, `!runtime.modelAdapter`,
  `typeof this.modelAdapter?.streamText === "function"`): Title, Memory, Compact, Subagent etc. read only their own
  product switches; streaming enablement reads `modelStreaming`; production Runtime does not express feature
  availability through Adapter or Factory existence; a state-only path must not trigger model execution because a gate
  was removed (verified at actual call boundaries).
- Workflow and Child Runtime assembly: Main Agent Runtime, Workflow Child, Script Workflow Child, Foreground /
  Background Subagent Child and Workspace generateText all use a formal Factory; the optional `modelFactory` of
  Workflow and Script Workflow becomes required; a Child with its own Selection creates its Model through the same
  Factory (no parent Adapter passed down).
- Old `ModelPort` and `ModelPortOptions` (and barrel export, comments, test types); do not retype `modelAdapter: any`
  as `ModelPort`.
- Old `AiSdkModelAdapter.generateText/streamText(AiSdkModelTextRequest)` public entries after Core and tests migrate.
  Retained standard entry `createModel(options): Model`. Temporarily retained Bootstrap / Adapter capabilities:
  `replaceRegistryConfig`, `resolveReasoningDisabledProviderOptions`, `addStatusSink`,
  `setModelIoFullRetentionEnabled`.

## 4. Retained and Out of Scope

Retained Adapter internals: AI SDK Runtime; SDK Factory / Endpoint / Header execution projection; Provider request
encoding; Request Auth consumption; Retry / Stream Recovery; Model I/O and Status / Telemetry; Usage / Stream Event
normalization. Not handled here (separate cleanup items): `ModelConnectionPort` and Core's Connection/capability
inference; `ModelRef`, `variant`, Result/Event Identity closure; old Model Catalog and models.dev data; Account
Provider dynamic credential lifecycle; reasoning-disabled model hardcoding; final naming and slimming of the Adapter
internal AI SDK Execution Registry. Full-repository `ModelConnectionPort = 0` is not a completion condition.

## 5. Test-first Plan

Test utilities: `createTestRuntimeModel(...)`, `createTestModelFactory(...)`, `createUnavailableTestModelFactory(...)`
(return an executable Fake Model, record Factory creation input, and fail explicitly where models must not execute).

Cases: Main Runtime creates Models only through Factory; without an available Factory model requests cannot run via
Adapter; Workflow Child, Script Workflow Child and Subagent Child use a formal (inherited or overridden) Factory; all
Steps in the Loop keep the same Active Model; Registry updates do not change created Models; Request Auth, Usage,
Status and Trace apply to actual Models; streaming and non-streaming go through the Model interface; state-only
workspace reads initiate no model requests. Migration rules: Core request content -> Fake Model collects
`ModelRequest`; stream events -> Fake Model `streamText()`; Provider encoding, Retry or SDK behavior stay in Adapter
tests; Runtime tests not executing models use an unavailable Factory; never assert Core produces old
`ModelTextRequest`, Provider Options or Connection requests.

Pre-implementation facts: 17 Core production files referenced `modelAdapter`; `createRuntimeModel` had 15 static
references (Turn, Compact, Memory, Title, Goal, workspace generateText); Workflow Child and Script Workflow Factory
types were optional; about 29 Core / Bootstrap test files provided Adapters only; `workspace/readState` used a
temporary Adapter that disallows model requests (may stay in the Bootstrap composition boundary but is no longer
injected into Core).

## 6. Risk Focus

Side paths previously controlled by Adapter existence gates: Session Title / Goal Summary Title; Automatic / Reactive /
Micro Compact; Project Memory Recall / Extraction / Dream; Target Completion Verification; Workspace generateText;
Workflow / Script Workflow Child; Foreground / Background Subagent; streaming and non-streaming; Request Auth; Usage,
Status, Trace and Model I/O. A normal production App had both Adapter and Factory, so deletion should not change
production functionality; tests injecting only Adapters are the largest migration surface.

## 7. Completion

Mechanical zero: Core `modelAdapter`, `createCompatibilityModel`,
`COMPATIBILITY_CONTEXT_WINDOW/MAX_OUTPUT_TOKENS`, direct `adapter.generateText/streamText`, `ModelPort` /
`ModelPortOptions`, production `AgentRuntime` construction without `modelFactory`, Workflow/Script Workflow/Subagent
passing `modelAdapter`, and non-Adapter-test calls of the old Adapter `generateText/streamText` are all 0.

Behavior: every Core model request traces to one `Model`; every root `Model` to a standard `ModelFactory` (bound Models
to an existing Model's `bind()`); Core produces no Model Properties, Options or Provider Connections; the Loop fixes
one Active Model; Registry updates affect only later-created Models; normal requests, sidecars and Child Runtimes keep
Request Auth, Usage, Status and Trace; no test-specific old execution bypasses.

Verification: `pnpm test:unit:affected`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm knip`, plus
`pnpm dep:refs` for `ModelPort` and old Adapter direct execution methods (document independent results of
task-relevant symbols if full `knip` has repository-wide noise).

Record: the main implementation landed in `a3f1082734`. Post-submission cleanup fixed three omissions: the state-only
Adapter for `workspace/readState` refuses explicitly at `createModel()`; a state-only Runtime without a ModelFactory no
longer registers Subagent tools; Bootstrap integration tests dropped the old `AiSdkModelTextRequest` Adapter mock
bridge in favor of the standard Model Request Executor (duplicate `modelFactory` fields from mechanical migration
removed). Root execution Models come uniformly from ModelFactory; `Model.bind()` and transparent call-context wrapping
remain legitimate derivation paths (correcting an early wrong statement that ModelFactory is the sole production entry
for all Models).
