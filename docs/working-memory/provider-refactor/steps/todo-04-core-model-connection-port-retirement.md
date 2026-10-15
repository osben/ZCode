# 04 Core Model Connection Port Retirement

> Status: Completed
>
> Date: 2026-08-24
>
> Overall roadmap: [`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)
>
> Prerequisites: [`todo-02-ai-sdk-execution-registry-retirement.md`](./todo-02-ai-sdk-execution-registry-retirement.md)、
> [`todo-03-provider-model-ownership-and-property-totality.md`](./todo-03-provider-model-ownership-and-property-totality.md)

## 1. Task Objective

Delete `ModelConnectionPort` / `ModelConnectionInfo` from Core and public business Contracts. Core capability judgments uniformly read the current
Active Model's `properties`; physical connection facts such as API Key, Header, baseURL, Provider SDK kind, and providerOptions only exist in Adapter's request execution implementation.

```text
Current

Core Runtime / Tool
  |- Active Model.properties
  `- ModelConnectionPort.resolveConnection(ModelRef)
       |- apiKey / headers
       |- baseURL / providerKind
       `- providerOptions
             |
             `--> Core infers WebSearch / MCS / diagnostics again

Target

Core Runtime / Tool
  `- Active Model.properties
       |- supportsNativeWebSearch
       `- supportsMidConversationSystem

Adapter private execution
  `- baseURL / SDK kind / credentials / headers / providerOptions
```

## 2. Core Principles

1. Model capabilities are static facts of Effective Model Config, readable only from Active Model.properties;
2. Model Config Rules that produce capability facts can match based on model, Provider, API type, and other resolution context, but Core
   does not infer capabilities again based on Endpoint, Provider type, or specific modelId;
3. Connection is an Adapter request implementation detail, not a query service for Tool/Runtime;
4. API Key and Header should not enter Core for capability judgment;
5. This Todo does not refactor Telemetry, does not create masked Connection, Observation, or Context DTOs;
6. If Adapter internals still need connection parameters, use private types that cannot be exported from `@zcode/contracts`.

## 3. Current Consumers and Target Handling

### 3.1 Mid-conversation System

Current `mid-conversation-system.ts` infers MCS through `providerKind + baseURL + modelId hardcode` and constructs a masked
Connection Context. Target change:

```text
Active Model.properties.supportsMidConversationSystem
        +
execution override.mode = force
        |
        v
useMidConversationSystem
```

- Final formula fixed as `mode === "force" || model.properties.supportsMidConversationSystem`;
- `auto` directly reads property; `force` is this invocation override, does not modify Model properties, nor enters Model Config;
- Judgment occurs at the invocation position generating this round's Provider messages; `midConversationSystemMode` does not enter ModelFactory;
- Delete fast model ID, baseURL allowlist, provider kind, and Connection resolve fallback;
- Decision result only retains business-needed boolean/reason, does not carry Connection;
- Model Config Rules are responsible for declaring facts for different models and connection combinations.

### 3.2 Native WebSearch

Current WebSearch first parses Connection, then determines support by Anthropic/provider endpoint. Target change:

- Tool reads `properties.supportsNativeWebSearch` from current Model;
- On false, return existing recoverable configuration error;
- On true, continue by Adapter encoding Provider native tool;
- Adapter selects encoding implementation only based on complete Provider Config's `api.type`, does not infer capabilities by baseURL allowlist;
- If Adapter cannot encode for that API type, must throw typed `InvalidModelRequest` before network request, cannot return
  `undefined` and silently delete Tool, nor bypass implementation limits via Config;
- generate and stream share the same encoding and fail-closed path;
- Delete Core `resolveWebSearchModelConnection()`, `supportsProviderNativeWebSearch(connection)`, and Connection
  diagnostic fields.

### 3.2.1 Model Config Capability Rules

`s supportsNativeWebSearch` and `supportsMidConversationSystem` uniformly written to ZCode Built-in / Personal Model
Config Rules, becoming Effective Model Config.properties. Config ownership is at Model Config, not meaning rules can only match by
modelId:

```text
Model Config Rule resolve context
|- providerId
|- modelId
`- provider.api.type
          |
          v
Effective Model Config.properties
|- supportsNativeWebSearch
`- supportsMidConversationSystem
```

- When capabilities universally hold for models, only use `modelMatch`;
- When capabilities only hold in specific product Providers, combine `modelMatch + providerMatch`;
- When capabilities depend on protocol connection form, combine `modelMatch + apiMatch`;
- If future deployment distinctions by Endpoint are truly needed, extend Model Rule's declarative resolution context; do not put URL judgment back into
  Runtime, Core, Importer, or Adapter;
- Built-in general Rules provide complete conservative defaults; subsequent precise Rules override real differences;
- Specific capability values based on actual model and service support materials, not mechanically translated from old hostname allowlist;
- Legacy importer only migrates facts explicitly expressed by old configs; on missing facts, do not infer and fix capabilities by Provider kind, baseURL, or modelId.

### 3.3 Embedded Search

Current Embedded Search's final gate only depends on global flag and Bash availability; Connection only constructs diagnostic
context. Target is to directly delete Connection/ModelRef context:

```text
embeddedSearchBranchEnabled + bashAvailable -> decision
```

Do not continue passing baseURL/providerKind/modelId for retained diagnostic objects.

### 3.4 Tool/Runtime Context

Delete the following public fields and passthroughs:

- `AgentRuntimeDeps.modelConnectionPort`;
- `AgentRuntime` / `AgentRuntimeInternal.modelConnectionPort`;
- `ToolExecutionContext.modelConnectionPort`;
- Tool executor, Child Runtime, Workflow passthroughs of Port;
- `modelRef + modelConnectionPort` combination parameters created solely for capability judgment.

Invocation points needing current model capabilities receive or access current `Model`. Do not extract another `ModelCapabilities` or Connection-aware
context.

Tool acquisition divides into two clear semantics:

```text
Tool Registry
|- non-execution inventory -> return registered Tools, no Model needed
`- this request's tool set -> must receive current Active Model, then filter by properties
```

- Persistent compatibility fields, Context guidance, Plugin inventory, and other non-execution uses directly read Tool Registry;
- Code entering main requests, Compact, Memory, or Child Agent execution must use that execution's own Active Model;
- Child Agent models may differ; parent only passes registered Tool inventory; Child Runtime then filters by its own Active Model;
- No fallback Model, default Model, or fake Model constructed from Session Selection or Connection.

### 3.5 Contracts and Adapter

Delete public:

- `model-connection.port.ts`;
- `ModelConnectionProviderKind`;
- `ModelConnectionInfo`;
- `ModelConnectionPort`;
- barrel exports;
- `AiSdkModelAdapter.resolveConnection()`;
- `AiSdkResolvedModelConnection`.

If Adapter internal execution functions need `baseURL/providerKind/apiKey/headers/providerOptions`, define as local or Adapter
private types. They cannot be imported by Core, Bootstrap business layer, or Tool.

## 4. Telemetry Boundary

Current network Status/Telemetry already holds fields like providerId, model, baseURL, providerKind. This Todo does not judge whether this design is reasonable, nor refactor it through Connection Port.

Allowed: After deleting Port, Adapter continues filling existing fields at existing network event production positions using its own known execution facts.

Forbidden:

- New `TelemetryContext`;
- New `ModelTelemetryObservation`;
- Passing complete Connection as event payload;
- Letting Core retain Connection for Telemetry;
- Conveniently splitting Product Status and Telemetry.

Telemetry's long-term design discussed separately.

## 5. Tests First

### 5.1 Capability Facts

1. `supportsMidConversationSystem=true/false` respectively enable/close MCS;
2. MCS `force` maintains existing override semantics;
3. Different modelId/baseURL but same property get same Core behavior;
4. `supportsNativeWebSearch=true/false` respectively allow/deny WebSearch;
5. Adapter-unsupported API types still fail-closed before network request even with property=true; generate/stream behavior consistent;
6. Embedded Search determined only by feature flag and Bash availability.

### 5.2 Data Boundary

1. Core/Tool context does not expose apiKey, headers, baseURL, providerKind, providerOptions;
2. Active Model.properties is the sole input for capability judgment;
3. Main, Compact, Subagent use their own current Active Model's properties;
4. Config updates do not change capabilities of loops already started;
5. Non-execution Tool inventory does not create Model; execution Tool filtering must hold current Active Model;
6. Existing network Status/Telemetry still emitted by Adapter, event count and timing unchanged.

### 5.3 Mechanical Zero

- `rg 'ModelConnectionPort|ModelConnectionInfo' apps/zcode-cli/packages/core` is zero;
- Public Contracts no longer export Connection types;
- `resolveConnection` no longer an Adapter public capability;
- MCS/WebSearch helpers judging by baseURL/providerKind/modelId in Core are zero;
- Legacy importer logic inferring MCS/WebSearch by baseURL/providerKind/modelId is zero;
- Provider-native Tool encoding no longer uses `undefined` to mean "not supported and silently delete";
- No new `*Capabilities`, `*ConnectionContext`, or `*Observation` substitute DTOs.

## 6. Implementation Order

### Step A: Pass Active Model to capability consumers

- Add property-based failure tests for MCS, WebSearch, Embedded Search;
- Trace current Model source for Tool context;
- Pass only Model, not Connection or derived capability snapshot.

### Step B: Migrate capability judgment

- MCS reads `supportsMidConversationSystem`;
- WebSearch reads `supportsNativeWebSearch`;
- Embedded Search deletes ineffective Connection context;
- Delete old Endpoint/model hardcode and fallback reason.

### Step C: Delete Port

- Delete Runtime/Tool/Workflow fields and passthroughs;
- Delete Contracts files and barrel export;
- Delete Adapter public `resolveConnection()`;
- Retain Adapter private execution facts.

### Step D: Verification and Commit

- Run Core WebSearch, MCS, Embedded Search, Compact, Subagent unit tests;
- Run Adapter encoding and network event regression;
- Run `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`;
- Independent Conventional Commit.

## 7. Completion Definition

Core cannot obtain physical Provider Connection, nor infer model capabilities through Connection anymore. Business capabilities come from current Active
Model.properties; connection, authentication, and Provider SDK details only used when Adapter executes requests. Telemetry maintains existing design,
without producing new Context or Observation abstractions for this deletion.
