# 01 Core Model Adapter Boundary Cleanup

> Status: Complete
>
> Date: 2026-08-24
>
> Source: [`../research/model-abstraction-unification-cleanup-audit.md`](../research/model-abstraction-unification-cleanup-audit.md)
>
> Related design: [`../design/model/model.md`](../design/model/model.md), [`../design/registry/model-creation.md`](../design/registry/model-creation.md)

## 1. Task objective

Remove Core's direct dependency on `AiSdkModelAdapter` and Compatibility Model fallback, so that all Core model requests
execute only through the standard chain:

```text
Provider Registry
        |
        v
ModelFactory
        |
        v
Core AgentRuntime
        |
        v
Active Model
        |
        v
AiSdkModelAdapter
        |
        v
Provider API
```

This task does not delete `AiSdkModelAdapter` as the Provider API execution implementation. It still handles message
and tool encoding, Provider parameters, request authentication, AI SDK calls, retries, stream recovery, Usage/Event
normalization, and network state observation. What is deleted are the bypasses:

```text
Core AgentRuntime
        |
        `-> modelAdapter -> Compatibility Model / old ModelTextRequest
```

After completion, Core only knows about `ModelSelection`, `ModelFactory`, and `Model`, and does not hold, inspect, or call Adapters.

## 2. Confirmed principles

### 2.1 Model is Core's only executable abstraction

Core can only call:

```ts
model.generateText(request);
model.streamText(request);
```

Core must not call Adapters directly, nor assemble Provider-specific requests itself.

### 2.2 ModelFactory is the sole root execution Model production entry

All production model execution entries must obtain a formal `ModelFactory`. When a Factory is missing, do not fall back
to an Adapter; do not let Core supplement Properties, Options, Provider Connections, or default model capabilities.

`Model.bind()` is a legal derivation entry: it can only create a bound Model from an existing Model with the same
providerId/modelId, same Properties, same Option Specs, and same Executor. It does not re-query the Registry,
nor does it constitute a second root Model creation chain.

### 2.3 Adapters exist only in Bootstrap / ModelFactory downstream

Permitted:

```text
createZCodeApp
      |
      v
AiSdkModelAdapter
      |
      v
ApiProviderModelRuntime / ModelFactory
      |
      v
Model
```

Prohibited:

```text
Core / Workflow business logic / Service / UI -> AiSdkModelAdapter
```

### 2.4 Tests follow the same abstraction

Model call tests use Fake Model / Fake ModelFactory. Do not create a test-only Adapter fallback to preserve old
tests, nor simply wrap old Adapter mocks in a compatible Factory that continues to protect old `ModelTextRequest` forms.

Bootstrap integration tests that need to control model results should provide a standard `ModelRequest -> ModelResult/ModelEvent`
Executor directly, and let the test assemble model creation; do not wrap old `AiSdkModelTextRequest` Adapter mocks
as a compatible Factory.

### 2.5 Missing dependencies fail explicitly

Production `AgentRuntime` should obtain a formal Factory. If a read-only state-only construction truly exists,
it must guarantee that model requests cannot be executed; a missing Factory must not serve as an implicit switch
to another execution path.

A state-only Runtime must not expose Subagent tools that require model creation. The Bootstrap's state-only Adapter
must explicitly refuse execution at the sole `createModel()` boundary, must not continue to disguise the deleted
`generateText/streamText` public entries, and must not rely on dual type casting to hide the missing `createModel()`
at runtime.

## 3. Deletion scope

### 3.1 Core Runtime fields and dependencies

Delete:

- `AgentRuntimeDeps.modelAdapter`;
- `AgentRuntime.modelAdapter`;
- `AgentRuntimeInternal.modelAdapter`;
- Parent / Child Runtime replication and propagation of `modelAdapter`;
- Core's runtime judgment of `AiSdkModelAdapter` specific method existence.

### 3.2 Compatibility Model

Delete from Core `runtime-model.ts`:

- `createCompatibilityModel`;
- `resolveCompatibilityConnection`;
- `toCompatibilityRequest`;
- `resolveCompatibilityProviderOptions`;
- `COMPATIBILITY_CONTEXT_WINDOW`;
- `COMPATIBILITY_MAX_OUTPUT_TOKENS`;
- Compatibility Model-specific output token / thinking budget calculation;
- Compatibility Model-specific `ModelRef` / `ModelSelection` conversion;
- Core's hardcoded input/output format for Compatibility Models;
- Core's logic to infer capabilities for Compatibility Models based on Endpoint, providerKind, or modelId.

If `createRuntimeModel()` is retained, it can only delegate to the formal Factory:

```ts
export function createRuntimeModel(
  runtime: AgentRuntimeInternal,
  input: RuntimeModelFactoryInput,
): Model {
  return runtime.modelFactory(input);
}
```

If this helper provides no additional semantics after implementation, inline and delete it.

### 3.3 Adapter existence gate

Delete or rewrite patterns such as:

```ts
if (!this.modelFactory && !this.modelAdapter) return;
if (!runtime.sessionStore || !runtime.modelAdapter) return false;
typeof this.modelAdapter?.streamText === "function";
```

Handling rules:

- Title, Memory, Compact, Subagent etc. only read their own product switches and necessary business dependencies;
- The `Model` contract already provides `streamText()`; streaming enablement only reads `modelStreaming`;
- A normal production Runtime does not express an Agent feature's availability through Adapter or Factory "existence";
- A state-only path must not unexpectedly trigger model execution due to removed gates, which must be verified
  through actual call boundaries.

### 3.4 Workflow and Child Runtime assembly

The following execution forms must use a formal Factory:

- Main Agent Runtime;
- Workflow Child;
- Script Workflow Child;
- Foreground / Background Subagent Child;
- Workspace generateText.

The currently optional `modelFactory` for Workflow and Script Workflow is changed to a required dependency.
When a Child has an independent Selection, create a Child Model through the same standard Factory; do not
pass the parent Runtime's Adapter to the Child.

### 3.5 Old ModelPort

Delete without valid production references:

- `ModelPort`;
- `ModelPortOptions`;
- corresponding barrel export;
- comments and test types served only by this interface.

Do not change `modelAdapter: any` to `ModelPort` to prolong the old abstraction's lifecycle.

### 3.6 Adapter old direct execution entry

After Core and test migration, audit and delete old public entries of `AiSdkModelAdapter`:

```ts
generateText(AiSdkModelTextRequest);
streamText(AiSdkModelTextRequest);
```

Standard creation entry retained:

```ts
createModel(options): Model;
```

The following Bootstrap / Adapter combination capabilities are temporarily retained by this task:

- `replaceRegistryConfig`;
- `resolveReasoningDisabledProviderOptions`;
- `addStatusSink`;
- `setModelIoFullRetentionEnabled`.

## 4. Explicitly retained and out of scope

### 4.1 Retained Adapter implementation

Retain `AiSdkModelAdapter` and its internals:

- AI SDK Runtime;
- SDK Factory / Endpoint / Header execution projection;
- Provider request encoding;
- Request Auth consumption;
- Retry / Stream Recovery;
- Model I/O and Status / Telemetry;
- Usage / Stream Event normalization.

### 4.2 This task does not handle

The following issues enter subsequent cleanup items separately and are not mixed with this task:

- `ModelConnectionPort` and Core's Connection/capability inference;
- `ModelRef`, `variant`, Result/Event Identity closure;
- Old Model Catalog and models.dev data;
- Account Provider dynamic credential lifecycle;
- Reasoning-disabled specific model hardcoding;
- Final naming and further slimming of Adapter internal AI SDK Execution Registry.

This task can delete Compatibility Model-specific Connection calls, but does not use "full repository
`ModelConnectionPort = 0`" as a completion condition.

## 5. Pre-implementation facts

Preliminary static scan after M4 merge shows:

- 17 Core production files still reference `modelAdapter`;
- `createRuntimeModel` has 15 static references covering Turn, Compact, Memory, Title, Goal, and workspace
  generateText;
- Workflow Child and Script Workflow Factory types are still optional;
- About 29 Core / Bootstrap test files only provide Adapters, not Factories;
- `workspace/readState` uses a temporary Adapter that disallows model requests to create a temporary App;
  this Adapter can remain in the Bootstrap composition boundary, but must no longer be injected into Core;
- The parallel M4 conformance review is modifying `runtime-model-lifecycle.test.ts`; a non-overlapping
  stable working tree must be obtained before formal implementation.

Therefore this task has a clear boundary and controlled risk, but is not a trivial deletion.

## 6. Test-first plan

### 6.1 Test utilities

First establish or extend unified test utilities:

```ts
createTestRuntimeModel(...);
createTestModelFactory(...);
createUnavailableTestModelFactory(...);
```

These return an executable Fake Model, record Factory creation input, and provide an explicit failure implementation
for tests that should not execute models.

### 6.2 Add failing tests first

Cover:

1. Main Runtime creates Models only through Factory;
2. Without an available Factory, model requests cannot be executed via Adapter;
3. Workflow Child uses a formal Factory;
4. Script Workflow Child uses a formal Factory;
5. Subagent Child uses inherited or overridden Factory;
6. All Steps in the current Loop continue to use the same Active Model;
7. Registry updates do not change already-created Models;
8. Request Auth, Usage, Status, and Trace continue to apply to actual Models;
9. Both streaming and non-streaming go through the Model interface;
10. state-only workspace reads do not initiate model requests.

### 6.3 Old test migration rules

- Test Core request content: Fake Model collects `ModelRequest`;
- Test Core stream events: Fake Model implements `streamText()`;
- Test Provider encoding, Retry, or SDK behavior: remain in Adapter tests;
- Runtime tests that do not execute models: use an unavailable Factory;
- Do not continue to assert that Core produces old `ModelTextRequest`, Provider Options, or Connection requests.

## 7. Implementation order

### Step A: Stable baseline and test assembly

- Wait for parallel M4 Review to release overlapping test files;
- Re-run static reference audit and record accurate call surface;
- Add test Factory helper;
- Submit failing tests first or confirm tests fail first within the same development sequence.

### Step B: Production Factory assembly

- Change Workflow / Script Workflow Factory to required;
- Verify Factory sources for Main, Workflow, Script Workflow, Subagent, and workspace generateText;
- Delete Adapter passing from Child Runtime.

### Step C: Core deletion

- Delete Core `modelAdapter` field and dependencies;
- Delete Compatibility Model and all specific helpers;
- Delete Adapter existence gates;
- Let all model formation processes call only the standard Factory.

### Step D: Test migration

- Convert old Adapter-shaped Core mocks to Fake Model / Factory;
- Move assertions about Provider encoding back to Adapter tests;
- Run Core, Bootstrap, and Adapter targeted tests.

### Step E: Public interface contraction

- Delete `ModelPort` / `ModelPortOptions`;
- Use `dep:refs` to confirm no cross-package calls remain for old Adapter direct entries;
- Delete `AiSdkModelAdapter.generateText/streamText` old public entries;
- Clean up related imports, barrel exports, comments, and compatibility tests.

## 8. Risk and verification focus

The main model requests already use Factory; the primary risks come from side paths previously controlled
by Adapter existence gates:

- Session Title / Goal Summary Title;
- Automatic / Reactive / Micro Compact;
- Project Memory Recall / Extraction / Dream;
- Target Completion Verification;
- Workspace generateText;
- Workflow / Script Workflow Child;
- Foreground / Background Subagent;
- Streaming and non-streaming;
- Request Auth;
- Usage, Status, Trace, and Model I/O.

A normal production App currently has both Adapter and Factory, so deleting the Core Adapter gate should
not change production functionality in principle. Old assemblies that inject only Adapters in tests
are the largest migration surface.

## 9. Completion conditions

Mechanical zero:

```text
Core modelAdapter                                       = 0
Core createCompatibilityModel                           = 0
Core COMPATIBILITY_CONTEXT_WINDOW/MAX_OUTPUT_TOKENS      = 0
Core direct call to adapter.generateText/streamText       = 0
ModelPort / ModelPortOptions                            = 0
Production AgentRuntime construction without modelFactory = 0
Workflow/Script Workflow/Subagent passing modelAdapter     = 0
Adapter old generateText/streamText non-Adapter test calls = 0
```

Behavior acceptance:

- All Core model requests can be traced to one `Model`;
- All production root `Models` can be traced to a standard `ModelFactory`; bound Models can only be traced
  to an existing Model's `bind()`;
- Core no longer produces Model Properties, Options, or Provider Connections;
- The current Loop continues to fix the same Active Model;
- Registry updates only affect subsequently created Models;
- Normal requests and all Sidecar, Child Runtime retain existing Request Auth, Usage, Status, and Trace behavior;
- Tests follow the same abstraction, with no test-specific old execution bypasses retained.

## 10. Verification commands

After implementation, at least execute:

```bash
pnpm test:unit:affected
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm knip
```

Additionally, use `pnpm dep:refs` to verify item-by-item that `ModelPort` and old Adapter direct execution methods
have no remaining cross-package calls. If full `knip` continues to include repository-wide existing noise,
document the independent verification results of task-relevant symbols; do not skip cleanup using existing noise.

## 11. Completion record

Todo 01's main implementation was completed by `a3f1082734`. Post-submission cleanup discovered and fixed three
types of omissions:

- The state-only Adapter for workspace/readState was changed to explicitly refuse at the sole `createModel()` boundary,
  no longer disguising the deleted `generateText/streamText`;
- A state-only Runtime without a ModelFactory no longer registers Subagent tools;
- Bootstrap integration tests deleted the old `AiSdkModelTextRequest` Adapter mock compatibility bridge,
  unified to use the standard Model Request Executor; simultaneously cleaning up duplicate `modelFactory`
  fields left by mechanical migration.

Root execution Models come uniformly from ModelFactory; `Model.bind()` and transparent call context wrapping
continue as legitimate derivation paths for existing Models, unaffected by the early erroneous statement that
"ModelFactory is the sole production entry for all Models."
