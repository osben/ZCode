# 02 AI SDK Execution Registry Retirement

> Status: Complete
>
> Confirmed boundary: when an Adapter creates a Model it receives a single already-validated Registry Provider Config
> and Registry Model Config directly; old execution Registry fields, defaults, query surfaces, Provider
> classifications or equivalent execution DTOs must not migrate into the new business Registry.
>
> Date: 2026-08-24
>
> Total roadmap: [`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)
>
> Related design: [`../design/registry/model-creation.md`](../design/registry/model-creation.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-02-ai-sdk-execution-registry-retirement.md`

## 1. Objective

Remove the mutable Registry semantics of `AiSdkModelRegistry` inside Adapters so the business Provider Registry is the
sole source of Provider/Model static facts. At Model creation, ModelFactory looks up Provider/Model once and passes the
fully resolved facts to the Adapter, which returns a Model wrapping AI SDK execution (no querying another Registry by
ModelRef). Before: Business Registry -> `ApiProviderModelRuntime.modelFactory` and a revision subscription ->
`AiSdkModelAdapter.replaceRegistryConfig` -> mutable `AiSdkModelRegistry` (providers map, `defaultProviderId`,
`resolve(ModelRef)`, `bindModel(ModelRef)`, `resolveConnection(ModelRef)`). Target: one lookup at ModelFactory create
time -> `RegistryProviderConfig + RegistryModelConfig + ModelOptions` -> `Adapter.createModel(full Config + explicit
execution deps)` -> a Model closure holding static AI SDK execution facts; request attempts only parse dynamic Request
Auth.

## 2. Rules

1. **Retire the Registry, not AI SDK execution capability.** Must retain: the declared `ProviderApiType`s (Anthropic
   Messages, OpenAI Responses, OpenAI Chat Completions; no old `gateway/custom` classification without a formal Config
   API type), baseURL, static headers and API Key projection, proxy / CA / no-proxy / Endpoint Routing, client request
   signing and necessary process-level cache, request-auth dynamic override, Provider request body compatibility,
   Retry, Stream Recovery, Usage, Status, Telemetry and error normalization. Deleted: the Adapter as a business query
   surface for which Providers exist, the default Provider, string model resolution and Connection return.
2. **No same structure under another name** (`ExecutionModelRegistry`, `ExecutionModelBindingRegistry`,
   `ConnectionRegistry`, `Runtime Provider Registry`). Adapter-private parameter types, closures and factory caches are
   allowed, but no Provider lists, default selection, ModelRef resolution, mutable config replacement or general
   Connection lookup.
3. **Model creation freezes static facts:** providerId / modelId; API kind/type; baseURL; static headers; static API
   Key or account `accessId`; Provider options mapping; Model properties / optionSpecs / options; infrastructure
   references. The `LanguageModel` after dynamic authentication is not frozen. Later Registry updates do not change
   created Models; each request attempt parses current dynamic Request Auth (refreshed on retry), which may override
   only explicitly allowed dynamic API Keys/Headers and never Endpoints, API kinds, Provider options or capabilities.
   The old `apiKeyEnv`, `apiKeyRequired`, default environment variables, `defaultProviderId`, bare modelId resolution
   and Connection lookup are deleted and never enter Provider Config, Registry, Model Config or new public execution
   abstractions.
4. **Adapter consumes the full Registry Config.** It receives the same `RegistryProviderConfig` and
   `RegistryModelConfig` objects produced by Todo 03's validation boundary (sparse Config -> overlay + resolve +
   validateComplete + requireComplete -> same object passed to `Adapter.createModel`), never copied/split into
   `AiSdkModelProviderConfig`, `ExecutionProviderConfig`, `ExecutionModelConfig`, `ResolvedConnection` or equivalents.
   It may ignore non-execution fields (`label`, `visibility`, model members) without declaring another `Pick<>` public
   type. `@zcode/adapters` may depend on the complete types from `@zcode/provider` (no copy into `@zcode/contracts`).
5. **Only facts Config cannot express are passed beyond it:** `providerId`, `modelId` (index keys); `ModelOptions`
   (execution value bound by the current Selection / `Model.bind()`); `ModelRequestDependencies` (this scope's
   request-auth Source); process-level runtime, network, proxy, CA, routing, signing, retry, logger and status/telemetry
   sinks injected by the Adapter constructor or private infrastructure Service. The static Key for `api-key` comes from
   `providerConfig.access`; account Providers use a non-secret Account Access snapshot fixed in Config with dynamic
   account credentials parsed per attempt (selection and Access Context specifics are Todo 07); no reverse-parsing of
   account facts from `accessId`, no second authentication Config.

Target entry (a function parameter only, not a queryable/persistable/synchronizable business type):

```ts
adapter.createModel({
  providerId,
  modelId,
  providerConfig,
  modelConfig,
  options,
  requestDependencies,
});
```

`properties`, `optionSpecs`, `reasoningMapping` come from `modelConfig`; `api`, `access`, static headers from
`providerConfig`. Bootstrap does not destructure fields ahead of time and the Adapter does not validate, judge member /
enabled or complete defaults. The Adapter may closure-capture the two references and create short-lived private call
parameters but must not store another Provider map nor export new execution Config types to Core/Service/Protocol.
Shared signing state, network transport, Endpoint Routing service, logger, runtime and status sink stay Bootstrap-injected;
shared caches cache expensive execution resources only.

## 3. Deletion and Migration Scope

- **`AiSdkModelRegistry`:** `providers` mutable map, `replaceConfig()`, `defaultProviderId`, `parseModelRef()`
  dependency, `resolve()`, `bindModel()`, `resolveConnection()`, `AiSdkResolvedModelConnection`, list/default helpers,
  structures putting `ModelProperties` into Registry resolved values. Extractable as Adapter-private pure
  functions/services: single-Provider-Config to `LanguageModel` factory, controlled static + dynamic auth merge,
  transport composition, signing manager lifecycle, Provider Business Error fetch wrapping, SDK model instance cache
  (cache content never answers business Provider/Model queries).
- **`AiSdkModelAdapter`:** delete the `registry` constructor parameter, `replaceRegistryConfig()`, old
  `generateText/streamText(AiSdkModelTextRequest)` (if not already gone via Todo 01), `registry.bindModel(options.model)`
  in `createModel()`, and string ModelRef/default Provider support. `createModel()` takes providerId/modelId, full
  configs, binding options and execution dependencies; the Model closure calls the request-auth source each attempt and
  projects it onto frozen Provider execution facts; the runner receives a per-attempt `LanguageModel`/execution
  parameter and holds no Registry.
- **Bootstrap `ApiProviderModelRuntime`:** delete the revision subscription for `#syncExecutionRegistry()`,
  `createApiProviderAiSdkRegistryConfig(view)` full copy, `#modelAdapter.replaceRegistryConfig(...)`, and any conversion
  of the Business Registry View into a second `providers` map. Keep: `modelFactory` looks up Provider/Model from the
  business Registry; validation and option checks at the Registry/ModelFactory boundary; single full Provider/Model
  Config, binding options and request dependencies passed to the Adapter; visible output budget and other Selection
  scope constraints folded into final binding options. If only `modelFactory` remains, inline it as a creation
  function (no start/subscription lifecycle just to keep the class).
- **Old Bootstrap model-config:** narrow `createAiSdkModelRegistryConfig()` / `createRuntimeAiSdkModelRegistryInfrastructure()`;
  Provider lists and default providers no longer enter the Adapter; network, signing, Endpoint Routing, runtime and env
  infrastructure retained and renamed accurately; Probe/E2E helpers create explicit test Models.
- **Reasoning differences move into ZCode Built-in Model Config Rules:** `optionSpecs.reasoningLevel.values/default`
  declares public tiers; `reasoningMapping[level]` declares Provider request parameters; extra mappings for `disabled`,
  `off`, `nothink`, `none` can declare execution parameters that close reasoning; Personal Rules come after Built-in
  Rules. The Adapter only maps forward: `Model.options.reasoningLevel` -> `modelConfig.reasoningMapping[level]` ->
  protocol encoding for `providerConfig.api.type`. Deleted: `resolveReasoningDisabledProviderOptions()`, old Model
  Catalog request assembly, and reverse-guessing tiers by modelId, old Provider kind, arbitrary providerOptions fields or
  legacy `extra_body`. `runtime-thought-level` (Telemetry) is not refactored; it only drops old Catalog / modelId /
  Provider-classification dependence (observations obtainable from Model options and explicit mappings continue;
  otherwise existing unknown/default semantics).

## 4. Cross-boundary with Todo 03

Sparse Rule -> resolve + validateComplete -> Complete Registry Model -> `Adapter.createModel`. Todo 02 does not
supplement capability defaults or add its own `requireCompleteProperties()`; formal switching of the Adapter interface
and deletion of the old Registry rest on Todo 03's complete types (until merged, no temporary complete types or
duplicate validation helpers).

## 5. Tests

- **Lifecycle:** Model A created before a Registry update keeps the old API kind/baseURL/static headers; Model B
  created afterwards uses new facts; after a Provider is deleted, created A completes its current request and new
  creations fail; the Adapter neither subscribes to nor queries the business Registry; no `defaultProviderId` / bare
  modelId fallback.
- **Authentication:** api-key Models use the creation-time Key; zhipu-account Models fix `accessId` and refresh dynamic
  credentials per attempt; request-auth without Source/material fails before the network call; retries obtain updated
  auth; dynamic auth cannot override baseURL, API kind, Provider options or properties; Secrets do not enter
  ModelSelection, Session events, logs or Registry Views.
- **Provider execution capability** (old Registry tests migrated by responsibility): each API type creates the correct
  AI SDK LanguageModel; proxy/CA/no-proxy and Endpoint Routing composition unchanged; signing gate/key cache isolation
  and lifecycle unchanged; OpenAI Responses JSON compat, Anthropic stream compat and body compatibility unchanged;
  Provider Business Error, TLS, Retry/Stream Recovery normalization unchanged; generate/stream share static execution
  facts.
- **Config and Reasoning:** the Provider/Model Config received by the Adapter is the same reference as the Registry
  published object; the Adapter does not supplement sparse fields or re-judge enabled/member/validation;
  `reasoningLevel` produces request parameters only through `reasoningMapping[level]`; Built-in + Personal overlaid
  mappings are executable; disabled/off/nothink/none use explicit mappings (no generic field scrubbing or model
  hardcoding); missing public level mappings fail at the Registry validation boundary; Telemetry adds no Context,
  Observation DTO or reverse inference.
- **Mechanical boundaries:** no `new AiSdkModelRegistry`, `replaceRegistryConfig` / `replaceConfig`, Adapter entry
  accepting `ModelRef | string`, `AiSdkModelProviderConfig` / `AiSdkModelRegistryConfig` or equivalent DTOs,
  import of old Model Catalog / `AiSdkProviderKind` / modelId reasoning hardcoding in request assembly, or Core/Service/
  Protocol imports of Adapter-private execution projections; `dep:refs` and `rg` confirm the old query methods have no
  references.

Implementation order: A lock behavior tests (classify old Registry tests as business query vs execution infrastructure;
failing tests for static-fact freezing and Request Auth refresh; minimum test per Provider API); B single-Provider
execution creation path (extract factory/transport/signing from the Registry class; `createModel()` takes full configs;
delete Bootstrap's field-by-field projection; runner consumes bound execution closures); C switch business ModelFactory
(direct single Provider/Model projection; delete full sync/subscription; verify old Models isolated from new revisions);
D physical deletion (Registry class, Config, resolved connection types, old Catalog / reasoning-disabled assembly,
Probe/E2E/test helpers, defaultProvider/list/parse tests); E verification (affected Adapter/Bootstrap/Core tests,
`pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, representative E2E/protocol regression for endpoint routing, request
auth, stream/retry), submitted with Todo 03.

## 6. Completion and Result

"Registry" in the repository refers only to the business Provider Registry. The Adapter may have execution resource
caches and infrastructure services but no Provider list, ModelSelection parsing, Connection queries or config hot
replacement; each Model holds the complete Registry Provider/Model Config and binding options from creation; dynamic
access materials are parsed only at request attempts; reasoning request parameters come only from explicit mappings in
the Effective Model Config.

Result: the Adapter's mutable Provider map, default Provider, `resolve` / `bindModel` / `resolveConnection` and
hot-replacement interfaces are deleted (no `AiSdkModelRegistry` in production); `createModel()` receives the same
`RegistryProviderConfig` / `RegistryModelConfig` reference and freezes creation-time static facts; Bootstrap deleted
the full sync/subscription from business Registry revision to Adapter Registry and looks up a single Provider/Model at
ModelFactory creation; request-auth and account dynamic credentials are parsed per request attempt (missing materials
fail before the network); Provider SDK, proxy, CA, Endpoint Routing, signing, Retry, Stream Recovery, Usage, Status and
error normalization stay in Adapter-private infrastructure; old reasoning-disabled helpers and modelId/Provider
classification guessing are deleted, with reasoning closure using only explicit extra Mapping keys (no reasoning
parameter when missing); Todo 02 and Todo 03 were implemented and submitted together as one fact chain.
