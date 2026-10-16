# 02 AI SDK Execution Registry Retirement

> Status: Complete
>
> Confirmed boundary: When an Adapter creates a Model, it receives a single, already-validated Registry Provider
> Config and Registry Model Config directly; old execution Registry fields, defaults, query surfaces, Provider
> classifications, or equivalent execution DTOs must not be migrated into the new business Registry.
>
> Date: 2026-08-24
>
> Total roadmap: [`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)
>
> Related design: [`../design/registry/model-creation.md`](../design/registry/model-creation.md)

## 1. Task objective

Remove the mutable Registry semantics of `AiSdkModelRegistry` inside Adapters, making the business Provider Registry
the sole source of Provider/Model static facts. ModelFactory passes fully resolved facts to the Adapter at once
when creating a Model; the Adapter returns a Model wrapping AI SDK execution, no longer querying another Registry
back by ModelRef.

```text
Current

Business Provider Registry
        |
        +--> ApiProviderModelRuntime.modelFactory
        |
        `--> revision subscription
                 |
                 v
        AiSdkModelAdapter.replaceRegistryConfig
                 |
                 v
        mutable AiSdkModelRegistry
        |- providers map
        |- defaultProviderId
        |- resolve(ModelRef)
        |- bindModel(ModelRef)
        `- resolveConnection(ModelRef)

Target

Business Provider Registry
        |
        | One lookup at ModelFactory create time
        v
RegistryProviderConfig + RegistryModelConfig + ModelOptions
        |
        | Single creation; no copy as second Config
        v
Adapter.createModel(full Config + explicit execution deps)
        |
        v
Model closure holds static AI SDK execution facts
        |
        `--> request attempts only parse dynamic Request Auth
```

## 2. Core decisions

### 2.1 What is retired is the Registry, not AI SDK execution capability

Must retain:

- Official `ProviderApiType` currently declared: Anthropic Messages, OpenAI Responses, and OpenAI Chat Completions SDK
  execution capabilities; old `gateway/custom` execution classifications must not migrate into a new abstraction
  without a formal Config API type;
- API baseURL, static headers, and API Key projection;
- proxy, CA, no-proxy, and Endpoint Routing;
- Client request signing and necessary process-level cache;
- request-auth dynamic override;
- Provider request body compatibility;
- Retry, Stream Recovery, Usage, Status, Telemetry, and error normalization.

What is deleted is the ability for an Adapter to serve as a business query surface for "which Providers currently
exist, what is the default Provider, which model is resolved by string, and what Connection is returned."

### 2.2 Do not preserve the same structure under another name

Prohibited to rename `AiSdkModelRegistry` identically as:

- `ExecutionModelRegistry`;
- `ExecutionModelBindingRegistry`;
- `ConnectionRegistry`;
- `Runtime Provider Registry`.

An implementation may have Adapter-private parameter types, closures, and factory caches, but must not provide
Provider lists, default selection, ModelRef resolution, mutable config replacement, or general Connection lookup.

### 2.3 Model creation freezes static facts

Model creation freezes:

- providerId / modelId;
- API kind/type;
- baseURL;
- static headers;
- static API Key or account accessId;
- Provider options mapping;
- Model properties / optionSpecs / options;
- infrastructure references needed for this execution.

What is frozen here is static execution facts and dependency references, not the final `LanguageModel` after
dynamic authentication is complete. Subsequent Registry updates do not change created Models; each request
attempt still parses current dynamic Request Auth and obtains refreshed material during retries. Request-time
auth can only override explicitly allowed dynamic API Keys/Headers, not change Endpoints, API kinds, Provider
options, or model capabilities.

The old Registry's `apiKeyEnv`, `apiKeyRequired`, default environment variables, `defaultProviderId`, bare
modelId resolution, and Connection lookup are all deleted and must not enter business Provider Config, Registry,
Model Config, or new public execution abstractions.

### 2.4 Adapter directly consumes full Registry Config

The Adapter creation entry receives the same `RegistryProviderConfig` and `RegistryModelConfig` objects produced
by Todo 03's validation boundary. Do not copy or split them into `AiSdkModelProviderConfig`,
`ExecutionProviderConfig`, `ExecutionModelConfig`, `ResolvedConnection`, or other equivalent DTOs.

```text
Sparse Provider / Model Config
             |
             v
Overlay + resolve + validateComplete + requireComplete
             |
             v
RegistryProviderConfig + RegistryModelConfig
             |
             | Same object passed directly
             v
Adapter.createModel
```

The Adapter may ignore non-execution fields like `label`, `visibility`, and model members; "consuming only
part of it" does not constitute a reason to declare another `Pick<>` public type or copy the execution projection.
`@zcode/adapters` may depend on the complete types from the pure domain package `@zcode/provider`; do not
copy Provider/Model Config to `@zcode/contracts` to avoid that dependency.

### 2.5 Config, binding options, and execution dependency division

Beyond full Config, only facts that Config cannot express are passed:

- `providerId`, `modelId`: these are Registry index keys, no need to redundantly write into Config objects;
- `ModelOptions`: the execution value bound by the current Selection/`Model.bind()`, not a Model Config declaration;
- `ModelRequestDependencies`: dynamic request-auth Source for this execution scope, not part of Config;
- Process-level runtime, network, proxy, CA, routing, signing, retry, logger, status/telemetry sink: injected
  by the Adapter constructor or its private infrastructure Service, not passed repeatedly with each Provider/Model Config.

The static Key for `api-key` comes directly from `providerConfig.access`. For account-type Providers, a non-secret
Account Access snapshot fixed in Config is used; dynamic account credentials are parsed per attempt; the structured
connection selection and Access Context switching specifics are handled by Todo 07. This Todo does not reverse-parse
account facts from `accessId`, nor does it create a second authentication Config.

## 3. Target interface shape

The domain public interface continues to be only `ModelFactory` and `Model`. The Adapter creation entry receives
the following facts; the implementation may use an object parameter, but that object is just a function parameter,
not a queryable, persistable, synchronizable, or reusable business Config type:

```ts
adapter.createModel({
  providerId,
  modelId,
  providerConfig, // RegistryProviderConfig
  modelConfig, // RegistryModelConfig
  options,
  requestDependencies,
});
```

The Adapter gets `properties`, `optionSpecs`, and `reasoningMapping` directly from `modelConfig`, and gets
`api`, `access`, and static headers directly from `providerConfig`. Do not destructure fields ahead of time
in Bootstrap, and do not let the Adapter perform validation, model member judgment, enabled judgment, or
Config default completion itself.

The Adapter may closure-capture these two full Config references internally and create short-lived private call
parameters for AI SDK creation; but it must not save another Provider map, nor export new execution Config types
from the barrel to Core/Service/Protocol.

Process-level shared signing state, network transport, Endpoint Routing service, logger, runtime, status sink, etc.
continue to be injected by the Bootstrap. Shared caches only cache expensive execution resources, not provide
business query capabilities.

## 4. Deletion and migration scope

### 4.1 `AiSdkModelRegistry`

Delete or decompose:

- `providers` mutable map;
- `replaceConfig()`;
- `defaultProviderId`;
- `parseModelRef()` dependency;
- `resolve()`;
- `bindModel()`;
- `resolveConnection()`;
- `AiSdkResolvedModelConnection`;
- list/default helpers for querying by Provider/Model;
- structures that put `ModelProperties` into Adapter Registry resolved values.

Can be extracted as Adapter-private pure functions or execution services:

- Creation of a single Provider Config to `LanguageModel` factory;
- Controlled merge of static and dynamic auth;
- Transport composition;
- Signing manager lifecycle;
- Provider Business Error fetch wrapping;
- SDK model instance cache.

If a cache key needs fields like providerId/modelId/baseURL, it remains an execution resource cache; it must not
answer business Provider/Model queries with cache content.

### 4.2 `AiSdkModelAdapter`

Delete:

- `registry` parameter of the constructor;
- `replaceRegistryConfig()`;
- old `generateText(AiSdkModelTextRequest)` / `streamText(...)` if Todo 01 has not yet deleted;
- `registry.bindModel(options.model)` within `createModel()`;
- Support for string ModelRef/default Provider.

Change to:

- `createModel()` directly receives providerId/modelId, full `RegistryProviderConfig`, full
  `RegistryModelConfig`, binding options, and necessary execution dependencies;
- `properties`, `optionSpecs`, `reasoningMapping`, API type, baseURL, static headers, and Access are all read
  from the full Config, no longer projected field-by-field by Bootstrap;
- The Model closure calls the request-auth source on each attempt call, and projects the result onto the frozen
  Provider execution facts;
- The runner receives a `LanguageModel`/execution parameter parsed for each request attempt with the current
  Request Auth combined, no longer holding a Registry; the `LanguageModel` after dynamic authentication completion
  is not frozen at Model creation time.

### 4.3 Bootstrap `ApiProviderModelRuntime`

Delete:

- Registry revision subscription logic only used for `#syncExecutionRegistry()`;
- `createApiProviderAiSdkRegistryConfig(view)` full copy;
- `#modelAdapter.replaceRegistryConfig(...)`;
- Code that converts the Business Registry View into a second `providers` map.

Retain or simplify:

- `modelFactory` looks up Provider/Model from the business Registry;
- Validation and options checks occur at the business Registry/ModelFactory boundary;
- Pass a single full Provider/Model Config, binding options, and request dependencies directly to the Adapter;
- Visible output budget and other Selection/execution scope constraints form final binding options before calling the Adapter.

If `ApiProviderModelRuntime` ends up wrapping only `modelFactory` after completion, it can be further inlined
as a ModelFactory creation function; do not create a start/subscription lifecycle just to preserve the class name.

### 4.4 Old Bootstrap model-config

Audit and narrow `createAiSdkModelRegistryConfig()`, `createRuntimeAiSdkModelRegistryInfrastructure()`:

- Provider lists and default providers no longer enter the Adapter;
- Network, signing, Endpoint Routing, runtime, and env execution infrastructure can be retained and renamed accurately;
- Probe/E2E helpers changed to explicitly create test Models, not build an entire Registry first.

### 4.5 Reasoning differences folded into ZCode Built-in Model Config Rules

All formal model and API type reasoning difference facts are uniformly declared by ZCode Built-in Model Config Rules:

- `optionSpecs.reasoningLevel.values/default` declares public tiers;
- `reasoningMapping[level]` declares the Provider request parameters for each tier;
- Additional mappings for `disabled`, `off`, `nothink`, `none` can declare execution parameters that close reasoning;
- Personal Model Config Rules continue to be placed after Built-in Rules and override explicitly provided config.

The Adapter only performs forward mapping:

```text
Model.options.reasoningLevel
             |
             v
modelConfig.reasoningMapping[level]
             |
             v
Protocol encoding corresponding to providerConfig.api.type
```

Delete `resolveReasoningDisabledProviderOptions()`, old Model Catalog request assembly responsibilities, and the logic
to reverse-guess tiers by modelId, old Provider kind, arbitrary providerOptions fields, or legacy `extra_body`.
What migrates into Built-in Config is model/API difference facts, not those old inference algorithms.

`runtime-thought-level` currently still serves existing Telemetry. This Todo does not refactor Telemetry schema,
Context, or reporting channels; it only removes its dependency on old Catalog, modelId hardcoding, and old
Provider classifications. Observations that can be obtained from this Model options and explicit mappings continue
to be recorded; fields that cannot be reliably obtained retain existing unknown/default semantics; do not restore
reverse-guessing for telemetry.

## 5. Cross-boundary with Todo 03

Todo 03 is tightening the complete types of Registry Provider/Model. The common principle of both:

```text
Sparse Rule -> resolve + validateComplete -> Complete Registry Model
                                          |
                                          v
                               Adapter.createModel
```

Todo 02 should not itself supplement capability defaults, nor redundantly establish `requireCompleteProperties()`.
Formal switching of the Adapter interface and deletion of the old Registry must be based on the complete types
already merged by Todo 03; until then, tests can be classified and recognizable execution infrastructure can be
identified, but no temporary complete types or duplicate validation helpers should be introduced.

## 6. Test-first

### 6.1 Lifecycle

1. After creating Model A, update the business Registry; A continues to use the old API kind/baseURL/static headers;
2. Create Model B after the update; B uses the new facts;
3. After deleting a Provider, already-created A can complete its current request, new creations fail;
4. The Adapter no longer subscribes to or queries the business Registry;
5. No defaultProviderId/bare modelId fallback exists.

### 6.2 Authentication

1. api-key Models use the Key fixed at creation time;
2. zhipu-account Models fix accessId; each attempt can refresh dynamic credentials;
3. request-auth without Source/material fails before the network call;
4. Retries can obtain updated auth;
5. Dynamic auth cannot override baseURL, API kind, Provider options, or properties;
6. Secrets do not enter ModelSelection, Session events, logs, or Registry Views.

### 6.3 Provider execution capability

Migrate old Registry tests by responsibility, rather than preserving construction methods one-to-one:

- Each API type creates the correct AI SDK LanguageModel;
- proxy/CA/no-proxy and Endpoint Routing composition unchanged;
- Signing gate/key cache isolation and lifecycle unchanged;
- OpenAI Responses JSON compat, Anthropic stream compat, and body compatibility unchanged;
- Provider Business Error, TLS, Retry/Stream Recovery normalization unchanged;
- generate/stream share the same static execution facts.

### 6.4 Config and Reasoning

1. The Provider/Model Config received by the Adapter is the same reference as the Registry published object,
   not passing through an equivalent execution DTO;
2. The Adapter does not supplement sparse fields, re-execute enabled, member, or validation judgments;
3. reasoningLevel only generates request parameters through `reasoningMapping[level]`;
4. Built-in and Personal Rule post-overlap effective mappings are all executable;
5. disabled/off/nothink/none use explicit mappings, not generic field scrubbing or model hardcoding;
6. Missing public level mappings fail at the Registry validation boundary, do not enter the Adapter;
7. Telemetry does not add Context, Observation DTOs, or new reverse inference due to Catalog removal.

### 6.5 Mechanical boundaries

- No `new AiSdkModelRegistry` in production code;
- No `replaceRegistryConfig` / `replaceConfig` in production code;
- The Adapter public entry does not accept `ModelRef | string`;
- No `AiSdkModelProviderConfig`, `AiSdkModelRegistryConfig`, or equivalent alternative DTOs in production code;
- The Adapter request assembly does not import old Model Catalog, `AiSdkProviderKind`, or modelId reasoning hardcoding;
- Core/Service/Protocol do not import Adapter-private execution projections;
- `dep:refs` and `rg` confirm the old Registry query methods have no references.

## 7. Implementation order

### Step A: Lock behavior tests

- Classify old Registry tests by "business query behavior" and "execution infrastructure behavior";
- Add failing tests for Model static fact freezing and Request Auth dynamic refresh;
- Define the minimum representative test for each Provider API.

### Step B: Establish single-Provider execution creation path

- Extract pure Provider factory/transport/signing composition from the Registry class;
- Let Adapter `createModel()` directly receive full Registry Provider/Model Config;
- Delete Bootstrap's field-by-field secondary projection of API/access/properties/optionSpecs/reasoningMapping;
- Change the runner to consume already-bound execution closures.

### Step C: Switch business ModelFactory

- `ApiProviderModelRuntime.modelFactory` directly projects a single Provider/Model;
- Delete full Registry sync/subscription;
- Verify old Models are isolated from new Registry revisions.

### Step D: Physical deletion of Registry API

- Delete `AiSdkModelRegistry`, Config, and resolved connection types;
- Delete old Catalog/reasoning-disabled request assembly and reverse inference;
- Migrate Probe/E2E/test helpers;
- Delete old test cases that only verify defaultProvider/list/parse.

### Step E: Verification and submission

- Run affected Adapter, Bootstrap, and Core unit tests;
- Run `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`;
- Run representative E2E/protocol regressions for endpoint routing, request auth, stream/retry;
- Implement and submit together with the ratified and synchronized Todo 03 as a single Conventional Commit.

## 8. Completion definition

After completion, "Registry" in the repository refers only to the business Provider Registry. The Adapter may
have execution resource caches and infrastructure services, but can no longer save another Provider list, parse
ModelSelection, provide Connection queries, or respond to config hot replacement. Each Model directly holds
the complete Registry Provider/Model Config and binding options at creation time; dynamic access materials
are parsed only at request attempts. Reasoning request parameters come only from explicit mappings in the
Effective Model Config, not from old Catalog, Provider classifications, or modelId inference.

## 9. Implementation result

- The Adapter's mutable Provider map, default Provider, `resolve` / `bindModel` / `resolveConnection`, and
  hot-replacement interfaces have been deleted; production code no longer contains `AiSdkModelRegistry`;
- `AiSdkModelAdapter.createModel()` directly receives the same `RegistryProviderConfig` / `RegistryModelConfig`
  reference; the Model closure freezes creation-time static facts, without creating an equivalent execution Config;
- Bootstrap has deleted the full sync and subscription from business Registry revision to Adapter Registry,
  looking up only a single Provider/Model at ModelFactory creation time;
- request-auth and account dynamic credentials continue to be parsed per request attempt; missing materials
  fail before network requests are initiated;
- Provider SDK, proxy, CA, Endpoint Routing, signing, Retry, Stream Recovery, Usage, Status, and error
  normalization continue to be handled by the Adapter's private execution infrastructure;
- Old reasoning-disabled helpers and reverse-guessing execution paths by modelId/Provider classification have
  been deleted; explicit mappings come from Effective Model Config Rules; reasoning closure only uses explicit
  extra Mapping keys; when missing, no reasoning parameter is sent;
- Todo 02 and Todo 03 were implemented and submitted together as a single fact chain, not artificially split
  into two interdependent commits.
