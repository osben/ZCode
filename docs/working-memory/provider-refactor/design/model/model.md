# Model and ModelRequest

Business code initiates model requests through the Model. Callers only select models, prepare
messages/tools/schema, and pass per-call general Options; they do not read Provider credentials, Endpoints,
or protocol parameters.

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

The main Agent, Subagent, Automatic Compact, Title, Goal, Project Memory, Git, Repo Wiki, WebFetch,
WebSearch, and other model tasks all use this call boundary.

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

`providerId` and `modelId` provide stable identity; `properties`, `optionSpecs`, and `options` are complete
execution facts fixed by ModelFactory at creation time. Complete `RegistryProviderConfig/RegistryModelConfig`
is a private creation input for ModelFactory handed to the Adapter; it is not exposed through the public
Model. Model accepts no sparse Overlay Config and fills no Properties at execution time.

Model is immutable after creation and allows concurrent calls. Provider Config or Registry updates do not
modify existing Models; new executions create new Models through ModelFactory from the current Registry.

`bind(options)` derives another immutable Model on the same Provider and model. It mainly serves Agent Loops,
Subagents, or independent tasks fixing their own Options. The implementation may reuse underlying executors
and long-term Services; it need not recreate HTTP Clients or Provider SDK infrastructure.

## A Single Request

ModelRequest describes only this call:

```ts
interface ModelRequest {
  messages: ModelMessage[];
  tools?: ModelTool[];
  responseJsonSchema?: JsonSchema;
  options?: ModelOptions;
  abortSignal?: AbortSignal;
}
```

The request's valid Options form in order: `Model Options` overridden by `Request's per-call value` →
`Effective Request Options`. Request Options affect only this call and do not modify Model. Tasks such as
Compact wanting a smaller output limit explicitly provide `maxOutputTokens` in the Request; Model validates
without silently clamping for the caller.

The Request carries no providerId, modelId, API Key, Endpoint, Adapter kind, or any `providerOptions` —
these are already determined by Model's execution implementation.

Properties, Option Specs, Options merge, and Request validation: [`contract.md`](./contract.md).

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

Business callers do not understand different Providers' field shapes. Ordinary API Keys come from the
ProviderConfig at Model creation time; Account Provider dynamic auth is provided by request-time services.
Complete boundary: [`../registry/model-creation.md`](../registry/model-creation.md).

Temperature, top-p, top-k, penalty, and seed do not enter the public ModelRequest. New general Options need
fixed Schema, Option Specs, and cross-Adapter semantics first; they cannot be exposed to business layers
through arbitrary Records. Constrained CEL and the final request body boundary for Option Maps:
[`model-option-map.md`](./model-option-map.md).

## Model Lifecycle

Sessions persist complete ModelSelection: model identity is fixed; models supporting Reasoning also save
the specific level. At execution start, Registry/ModelFactory validates and freezes the Option explicitly
specified by Selection; per-output budget is provided by specific execution callers:

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

Normal Steps and Automatic Compact use the Loop's current Active Model. Composer Selection, Session
Selection, and ordinary Registry changes do not modify it. After a Guide/"Immediate" is received by the
current Loop, a new Active Model is created and switched at the Model Step boundary; already-issued requests
continue on the old Model.

Subagents have their own Models: with an explicit Selection, create the corresponding model; without one,
obtain the parent Selection per execution inheritance rules. Independent tasks such as Title, Memory, and
Repo Wiki also each obtain Models; they do not bypass the public call interface.

Ordinary Model objects are reclaimed by JavaScript GC. Timers, Sockets, Watchers, subprocesses, and other
resources requiring definite release are managed by long-term Service owners, independent of when Model
objects are reclaimed.

## Result, Event, and Attribution

`ModelResult` unifies non-streaming call results; `ModelEvent` unifies streaming events. Provider SDK raw
types and raw errors are encapsulated within the Adapter and do not leak to business code.

Usage, Trace, Model IO, cost, quota, and errors for each request are obtained from the actual Model
(`providerId`, `modelId`, effective options). Attribution does not read the input box's current selection,
later-changed Session Selection, or the optional model field in the Provider's response. The model name
returned by the Provider can serve as routing diagnostic information.

## View and Execution Separation

Settings pages and model selection pages read ProviderConfig, ModelConfig, member source, and status from
Registry/Facade projections:

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

The Host can therefore display, group, and validate models without constructing callable Models. `disabled`
and `incomplete` are pre-creation states; they do not enter the Model request contract; duplicate members
are already deterministic at the Inventory stage per "keep the first, Built-in-wins." Models are created
only when Agent Loops or independent model tasks truly begin.

## Sub-documents

[`contract.md`](./contract.md) defines ModelProperties, ModelOptionSpecs, ModelOptions, ModelRequest checks,
result semantics, and Provider reasoning mapping boundaries.
