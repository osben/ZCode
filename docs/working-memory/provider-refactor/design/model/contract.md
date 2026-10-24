# Model Public Contract

The Model type visible to business callers. How Provider config is formed:
[`../registry/configuration.md`](../registry/configuration.md); how Models are created:
[`../registry/model-creation.md`](../registry/model-creation.md).

## Type Relationships

```text
Model
├─ identity
│  ├─ providerId
│  └─ modelId
├─ properties
├─ optionSpecs
├─ options
├─ bind()
├─ generateText()
└─ streamText()
       |
       v
ModelRequest
├─ messages
├─ tools
├─ responseJsonSchema
├─ options
└─ abortSignal
```

| Data            | Meaning                                                                       | Can Request modify?           |
| --------------- | ----------------------------------------------------------------------------- | ----------------------------- |
| Properties      | Currently determined properties of the current model                          | No                            |
| Option Specs    | Optional values, order, upper limits, and request mapping for general Options | No                            |
| Model Options   | Options bound to the current Model                                            | Derive new Model via `bind()` |
| Request Options | Per-call Option override                                                      | Yes, affects only this call   |

## Properties

```ts
interface ModelProperties {
  contextWindow: number;
  input_format: {
    support_text: boolean;
    support_image: boolean;
    support_video: boolean;
    support_audio: boolean;
    support_pdf: boolean;
  };
  output_format: {
    support_text: boolean;
  };
  supportsToolCall: boolean;
  supportsJsonSchemaOutput: boolean;
  supportsNativeWebSearch: boolean;
  supportsMidConversationSystem: boolean;
}
```

Properties are used by callers to choose request strategies and by Models to check request/model
compatibility before sending.

| Property                        | Usage location                                            |
| ------------------------------- | --------------------------------------------------------- |
| `contextWindow`                 | Context budgeting and Compact judgment                    |
| `input_format`                  | Text, Image, Video, Audio, PDF input format check         |
| `output_format`                 | Current Text output format check                          |
| `supportsToolCall`              | Agent Tool request check                                  |
| `supportsJsonSchemaOutput`      | JSON Schema request check                                 |
| `supportsNativeWebSearch`       | Whether to use Provider native search capability          |
| `supportsMidConversationSystem` | Provider message conversion strategy for history messages |

`supportsNativeWebSearch` and `supportsMidConversationSystem` are final capability facts of Effective Model
Config, fixed during Model creation. The Model Config Rules producing them may match on model, Provider, API
type, and other resolution-context combinations; capabilities need not be determined by modelId alone. Core
reads only the fixed conclusions; it does not infer temporarily from Provider type, URL, or modelId.

## Option Specs

Public Options use fixed fields. Each model declares the valid range, semantic order, hard upper limits,
request mapping, and default level for new selections:

```ts
interface EnumOptionSpec {
  type: "enum";
  // Ordered from lowest to highest by semantic intensity; values[0] is the lowest public level.
  values: readonly string[];
  // Fresh model selections use this level; null explicitly clears an inherited default.
  default?: string | null;
  map: string;
}

interface LimitOptionSpec {
  type: "limit";
  max: number;
  map: string;
}

interface ModelOptionSpecs {
  reasoningLevel: EnumOptionSpec;
  maxOutputTokens: LimitOptionSpec;
}

interface ModelOptions {
  reasoningLevel?: string;
  maxOutputTokens?: number;
}
```

`reasoningLevel` is the user's expected reasoning intensity — a soft constraint: the Adapter expresses it as
far as the target protocol's effort, level, toggle, or compatible budget allows. `reasoningLevel.values` is
ordered lowest to highest; `values[0]` is the lowest publicly exposed level but is not guaranteed to be
"disabled". Standard model new selections prefer `default`; when unset or cleared via `null`, Host Selection
falls back to `values.at(-1)`. After the value list is replaced, an inherited `default` no longer in the new
list must be discarded; a Personal Overlay must not save defaults outside its valid `values`. Explicit
low-cost auxiliary requests select `values[0]`. Do not scan names like `off`, `nothink`, or `none` to guess
disabling capability.

`maxOutputTokens` is the hard upper limit for total generation tokens shared by reasoning and final answer.
The Model validates that the call value does not exceed `LimitOptionSpec.max`; it never silently truncates
for the caller.

Option fields are a closed set. Providers cannot add arbitrary `Record<string, unknown>` parameters through
the public interface. New general Options need cross-Provider semantics defined first, then entry into
`ModelOptionSpecs`, `ModelOptions`, and Adapter.

## Option Resolution

```text
Specific Options bound to Model
        |
        | ModelRequest.options override
        v
Request Effective Options
```

Request explicit values override Model-bound values. `ModelOptions` is a sparse Overlay at the
binding/request phase, but both valid `reasoningLevel` and `maxOutputTokens` must exist before entering the
Executor. Missing values fail before network I/O; Model, Adapter, and Runner do not guess execution values
from Option Specs. Standard initial selection fills once, at the Host Selection boundary, by
`values.at(-1)`; auxiliary calls explicitly bind `values[0]`.

```ts
const model = baseModel.bind({
  reasoningLevel: "high",
  maxOutputTokens: 32_000,
});

await model.generateText({
  messages,
  options: {
    maxOutputTokens: 8_000,
  },
});
```

The request above uses `reasoningLevel = high` and `maxOutputTokens = 8_000` without modifying
`model.options`.

## ModelRequest

```ts
interface ModelRequest {
  messages: ModelMessage[];
  tools?: ModelTool[];
  responseJsonSchema?: JsonSchema;
  options?: ModelOptions;
  abortSignal?: AbortSignal;
}
```

ModelRequest describes a single model call. Model identity, API Key, Request Auth, Endpoint, Provider type,
and Provider-specific parameters are already determined by the Model's execution implementation and its
dependencies; they do not appear in the Request. Dynamic access materials for `zhipu-account` are resolved
by the Account Request Auth Service on each request attempt, without changing the public ModelRequest
Schema.

## Request Checks

Model performs unified checks before calling the Adapter:

| Request content      | Check basis                             |
| -------------------- | --------------------------------------- |
| Image messages       | `properties.input_format.support_image` |
| PDF messages         | `properties.input_format.support_pdf`   |
| Video messages       | `properties.input_format.support_video` |
| `tools`              | `properties.supportsToolCall`           |
| `responseJsonSchema` | `properties.supportsJsonSchemaOutput`   |
| `reasoningLevel`     | `optionSpecs.reasoningLevel.values`     |
| `maxOutputTokens`    | `optionSpecs.maxOutputTokens.max`       |

Requests exceeding an Option Spec return explicit errors; so do requests using input or capabilities the
model explicitly declares unsupported. This is a unified double check before sending; callers may still read
Properties early to choose their own strategy.

Registry-published ModelConfig must have complete Properties; `unknown` does not exist in the target design.
Complete structure, Rule Overlay, and migration boundary for input/output formats:
[`input-output-format.md`](./input-output-format.md).

## Adapter Boundary

```text
ModelRequest
      |
      | resolve options + validate
      v
Provider-neutral request
      |
      | AI SDK / Adapter serialization
      v
Target API raw JSON Request Body
      |
      | per-option map (reasoningLevel then maxOutputTokens)
      v
Final Provider request
├─ Option JSON Merge Patch
├─ Dynamic Token / Header
├─ Routing and retry
└─ Error normalization
```

The public Model layer understands `reasoningLevel` and `maxOutputTokens` separately; it understands no
thinking budget and adds no Provider-specific combined constraints. Each Option Spec's `map` is the sole
configuration authority for final request fields; Runtime does not parallel-pass AI SDK reasoning namespace,
standard max-output fields, or fixed-thinking budget conversions. Full contract:
[`model-option-map.md`](./model-option-map.md).

## Result, Event, and Attribution

`ModelResult` and `ModelEvent` use the unified result types established in M1: the former expresses final
messages, usage, and end reasons; the latter expresses streaming increments, tool calls, usage, and end
events. Provider SDK raw objects stay within the Adapter; no parallel result types exist for different
callers.

Usage, Trace, Model IO, cost, quota, and errors are attributed to the requesting Model's identity and this
round's Effective Options; they do not read Composer Selection, later-changed Session Selection, or rely on
the provider response's optional model field.
