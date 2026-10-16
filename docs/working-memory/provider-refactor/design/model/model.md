# Model and ModelRequest

Business code initiates model requests through the Model. Callers only select models, prepare messages/tools/schema, and per-call general Options; they do not read Provider credentials, Endpoints, or protocol parameters.

```ts
const model = modelFactory({
  providerId: "zai",
  modelId: "glm-5",
  options: { reasoningLevel: "high" },
});

const result = await model.generateText({
  messages,
  tools,
});
```

The main Agent, Subagent, Automatic Compact, Title, Goal, Project Memory, Git, Repo Wiki, WebFetch, WebSearch, and other model tasks all use this call boundary.

## What Model Expresses

Model is a callable object with determined Provider, model config, and general Options:

```ts
interface Model {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  readonly properties: ModelProperties;
  readonly optionSpecs: ModelOptionSpecs;
  readonly options: ModelOptions;

  bind(options?: ModelOptions): Model;

  generateText(request: ModelRequest): Promise<ModelResult>;
  streamText(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

`providerId` and `modelId` provide stable identity; `properties`, `optionSpecs`, and `options` are complete execution facts fixed by ModelFactory at creation time. Complete `RegistryProviderConfig/RegistryModelConfig` serves only as a private creation input for ModelFactory交给 Adapter; it is not exposed through the public Model. Model does not accept sparse Overlay Config, nor fills Properties at execution time.

Model is immutable after creation, and allows concurrent calls. Provider Config or Registry updates do not modify existing Models; new executions create new Models through ModelFactory based on the current Registry.

`bind(options)` derives another immutable Model on the same Provider and model. It mainly serves Agent Loops, Subagents, or independent tasks to fix their own Options. Implementation can reuse underlying executors and long-term Services; it does not require recreating HTTP Clients or Provider SDK infrastructure.

## A Single Request

ModelRequest only describes this call:

```ts
interface ModelRequest {
  messages: ModelMessage[];
  tools?: ModelTool[];
  responseJsonSchema?: JsonSchema;
  options?: ModelOptions;
  abortSignal?: AbortSignal;
}
```

The request's valid Options are formed in the following order:

```text
Model Options
        |
        | Request's per-call value override
        v
Effective Request Options
```

Request Options only affect this call and do not modify Model. Tasks such as Compact that want a smaller output limit should explicitly provide `maxOutputTokens` when constructing the Request; Model validates, without silently clamping on behalf of the caller.

The Request does not carry providerId, modelId, API Key, Endpoint, Adapter kind, or any `providerOptions`. These are already determined by Model's execution implementation.

Properties, Option Specs, Options merge, and Request validation are documented in [`contract.md`](./contract.md).

## From Model to Provider API

```text
ModelRequest
      |
      | merge options + validate
      v
Provider-neutral effective request
      |
      v
Provider Adapter
├─ Protocol field conversion
├─ per-option raw Request Body Patch
├─ Dynamic Token / Header
├─ Routing and retry
└─ Error normalization
      |
      v
Provider API
```

Business callers do not understand the field shapes of different Providers. Ordinary API Keys can come from the ProviderConfig at Model creation time; Account Provider dynamic auth is provided by request-time services. The complete boundary is documented in [`../registry/model-creation.md`](../registry/model-creation.md).

Temperature, top-p, top-k, penalty, and seed do not enter the public ModelRequest. New general Options need to first form fixed Schema, Option Specs, and cross-Adapter semantics; they cannot be exposed to business layers through arbitrary Records. The constrained CEL and final request body boundary for Option Maps are documented in [`model-option-map.md`](./model-option-map.md).

## Model Lifecycle

Sessions persist complete ModelSelection: model identity is fixed; models that support Reasoning simultaneously save the specific level. At execution start,
Registry/ModelFactory validates and freezes the Option explicitly specified by Selection; per-output budget is provided by specific execution callers:

```text
Session ModelSelection
        |
        | ModelFactory(selection)
        v
Agent Loop Active Model
├─ Step 1
├─ Tool Calls
├─ Step 2
├─ Automatic Compact
└─ Step N
```

Normal Steps and Automatic Compact use the Loop's current Active Model. Composer Selection, Session Selection, and ordinary changes to Registry do not modify it. After a Guide/"Immediate" is received by the current Loop, a new Active Model is created and switched at the Model Step boundary; already-issued requests continue to use the old Model.

Subagents have their own Models. When there is an explicit Selection, create the corresponding model; when there is no explicit Selection, obtain the parent Selection according to Execution inheritance rules. Independent tasks such as Title, Memory, Repo Wiki also each obtain Models; they do not bypass the public call interface.

Ordinary Model objects are reclaimed by JavaScript GC. Timers, Sockets, Watchers, subprocesses, and other resources requiring definite release are managed by long-term Service owners; they do not depend on when Model objects are reclaimed.

## Result, Event, and Attribution

`ModelResult` unifies non-streaming call results; `ModelEvent` unifies streaming events. Provider SDK raw types and raw errors are encapsulated within the Adapter and do not leak directly to business code.

Usage, Trace, Model IO, cost, quota, and errors for each request are obtained from the actual Model:

```text
Actual Model
├─ providerId
├─ modelId
└─ effective options
        |
        v
Usage / Trace / Diagnostics
```

Attribution does not read the input box's current selection, later-changed Session Selection, or the optional model field in the Provider's response. The model name returned by the Provider can serve as routing diagnostic information.

## View and Execution Separation

Settings pages and model selection pages read ProviderConfig, ModelConfig, member source, and status from Registry/Facade projections:

```text
View and Selection
└─ Registry / Facade View
   ├─ ProviderConfig
   ├─ ModelConfig
   └─ builtin / enabled / completeness

True Execution
└─ ModelFactory(selection)
   ├─ Registry lookup / validate
   ├─ Adapter private create
   └─ Model
```

Therefore, the Host can display, group, and validate models without constructing callable Models. disabled and incomplete are pre-creation states;
they do not enter the Model request contract; duplicate members are already deterministic at the Inventory stage per "keep the first, Built-in-wins." Models are created only when Agent Loops or independent model tasks truly begin.

## Sub-documents

[`contract.md`](./contract.md) defines ModelProperties, ModelOptionSpecs, ModelOptions, ModelRequest checks, result semantics, and Provider reasoning mapping boundaries.
