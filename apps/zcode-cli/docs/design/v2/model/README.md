# ZCode CLI Model Design v2

> **Historical design note (2026-08-24)**: this document records the model layer design before the
> Provider Refactor. The mutable AI SDK Registry, Model Catalog, `models.dev`, per-modelId capability and
> thinking-level inference and the `providerOptionsByLevel` Runtime projection described here are all
> retired and are no longer the current implementation contract. The current authoritative design is in
> [Model Contract](../../../../../../docs/working-memory/provider-refactor/design/model/contract.md),
> [Registry Configuration](../../../../../../docs/working-memory/provider-refactor/design/registry/configuration.md)
> and [Model Creation](../../../../../../docs/working-memory/provider-refactor/design/registry/model-creation.md).
> The rest of this document is kept as historical background only and is not a basis for new
> implementation.

## Scope

The model layer design of ZCode v2. `ModelRef`, the provider-neutral request/result, the AI SDK
registry/runner, the model capability catalog and the core runtime wiring reached `L2 Implemented
Contract`; user-configurable gateway/custom providers, remote catalog sync and complex provider fallback
stay `L1 Candidate Contract`.

The previous design was too heavy. This one restarts around two lines only:

- provider-agnostic: the model layer is built on multi-provider as the base abstraction, not bound to one
  API shape or a few compatible backends.
- Vercel AI SDK: the runtime abstraction that unifies different provider APIs in the TypeScript ecosystem.

---

## 1. Core judgment

ZCode should not implement the request format of every model API from scratch. The main path of the model
layer:

```text
ZCode core intent
  -> adapters/model converts messages, tools and config into AI SDK calls
  -> Vercel AI SDK provider / OpenAI-compatible provider
  -> adapters/model converts stream, tool call, usage and error back into ZCode events
```

The AI SDK is a runtime dependency inside the adapter and does not enter core. Core knows only ZCode's own
messages, tools, permissions, session events and trace.

The default AI SDK provider transport can also rewrite explicit provider endpoints before the final
network egress per the remote config of [`provider-endpoint-routing.md`](./provider-endpoint-routing.md).
This capability changes neither the provider config nor core/session state.

Benefits:

- No rewriting of streaming, tool calling and structured output for every provider.
- The first config surface directly supports only the three provider kinds `anthropic`, `openai` and
  `openai-compatible`.
- User-declared custom providers first go through `openai-compatible`; the AI SDK provider registry,
  `gateway` and custom factories are for trusted internal extension only.
- ZCode keeps only what a coding agent must control itself: tool permissions, session, compact, trace,
  artifacts and cross-platform I/O.

---

## 2. Design basis

### 2.1 Provider-agnostic boundary

A multi-provider coding agent model layer needs these engineering boundaries:

- The user-visible model is `provider/model`.
- Provider config contains kind, API address, environment variables, options and models.
- The provider runtime provides `list`, `getProvider`, `getModel`, `getLanguage`, `defaultModel`.
- Requests finally go to `streamText` of the Vercel AI SDK.
- All provider differences are concentrated in `ProviderTransform`: message cleaning, tool call id, cache
  marker, reasoning parameters, unsupported media, providerOptions.
- Message history records the `providerID` and `modelID` that produced the message, and after a model
  switch the private metadata of the old provider is not reused.

ZCode's approach: use `provider/model` as the unified model reference in CLI, config and session events;
parse it early into `{ providerId, modelId }`; handle provider differences in one central transform layer;
record the model used at that time on every assistant/tool history entry so a model switch does not
pollute requests.

### 2.2 Vercel AI SDK

Key capabilities: `generateText` and `streamText` as unified entries; a provider registry that puts
several providers in one registry accessed by simple strings; providers covering mainstream model
services and cloud platforms; `@ai-sdk/openai-compatible` for OpenAI-compatible APIs; unified
abstractions for tool calling, structured output, reasoning, providerOptions and middleware; Vercel AI
Gateway addressing `<provider>/<model>` strings through a unified entry.

ZCode's approach:

- The adapter calls `streamText` / `generateText` instead of implementing provider wire protocols.
- The provider registry assembles available models; `gateway` and custom factories belong to the trusted
  internal config of adapter/bootstrap and cannot be declared in user files.
- Provider-specific advanced capabilities enter the adapter through controlled `providerOptions`, not
  core.
- Gateways/proxies on the first user config surface still go through `openai-compatible`. The adapter may
  internally accept an already constructed `gateway` provider config for trusted bootstrap injection or
  tests, but the file config schema does not accept the `gateway` kind; opening it to user config later
  requires authentication, proxy, audit, error and test contracts first.

AI SDK docs entries:

- <https://ai-sdk.dev/docs/ai-sdk-core/provider-management>
- <https://ai-sdk.dev/docs/reference/ai-sdk-core/provider-registry>
- <https://ai-sdk.dev/docs/ai-sdk-core/generating-text>
- <https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling>
- <https://ai-sdk.dev/providers/openai-compatible-providers>
- <https://vercel.com/docs/ai-gateway/models-and-providers>

---

## 3. Module boundaries

The model layer has only four parts.

### 3.1 Model Config

Reads config and produces provider definitions. Model run config must come from explicit user, project,
session or CLI config; system defaults provide no directly callable provider/model.

The minimal user config uses provider-first: `provider` declares connections and model metadata, and
`model` stores only the `provider/model` reference of the current main model.

```json
{
  "$schema": "https://zcode.ai/schema/config-v2.json",
  "provider": {
    "deepseek": {
      "kind": "openai-compatible",
      "name": "DeepSeek",
      "options": {
        "baseURL": "https://api.deepseek.com",
        "apiKey": "sk-..."
      },
      "models": {
        "deepseek-v4-pro": {
          "name": "DeepSeek V4 Pro"
        }
      }
    }
  },
  "model": "deepseek/deepseek-v4-pro"
}
```

To distinguish the main and the light model explicitly, `model` expands into a role map whose role values
are still only `provider/model` references:

```json
{
  "provider": {
    "deepseek": {
      "kind": "openai-compatible",
      "name": "DeepSeek",
      "options": {
        "baseURL": "https://api.deepseek.com",
        "apiKey": "sk-..."
      },
      "models": {
        "deepseek-v4-pro": {},
        "deepseek-chat": {}
      }
    }
  },
  "model": {
    "main": "deepseek/deepseek-v4-pro",
    "lite": "deepseek/deepseek-chat"
  }
}
```

`model` and `model.main` / `model.lite` must point to a provider/model explicitly declared in `provider`.
The config file supports neither inline model targets nor the legacy `small_model` / `model.small` keys.

```json
{
  "$schema": "https://zcode.ai/schema/config-v2.json",
  "provider": {
    "provider-auth-zai": {
      "kind": "openai-compatible",
      "name": "Z.AI",
      "options": {
        "baseURL": "https://api.z.ai/api/coding/v1",
        "apiKey": "sk-..."
      },
      "models": {
        "glm-5": {
          "name": "GLM-5",
          "reasoning": {
            "enabled": true,
            "levels": ["low", "medium", "high"],
            "defaultLevel": "medium"
          },
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 200000,
            "output": 8192
          }
        },
        "glm-4.7": {
          "name": "GLM-4.7"
        }
      }
    }
  },
  "model": {
    "main": "provider-auth-zai/glm-5",
    "lite": "provider-auth-zai/glm-4.7"
  }
}
```

`provider.*.kind` is how a provider adapter is resolved in user file config. The first version allows only
`anthropic`, `openai` and `openai-compatible`; other kinds (including the adapter-internal `gateway` /
`custom`) must be rejected by the config schema. The config file exposes no `npm` field, so dynamic
package loading does not become a user contract; if dynamic npm providers are supported later, the
permission, install, cache, audit and error contracts come first.

`provider.*.models.*` is model capability metadata, projected into `modelCatalog.overrides` on load. The
key of the models map is by default the runtime model id and is passed to the matching AI SDK provider
unchanged; `name` is only the display name. If aliases are supported in the future, an independent field
and tests must define the key to runtime id mapping explicitly. `reasoning` states whether thinking is
supported and the selectable levels, `modalities.input` / `attachment` whether images are supported, and
`limit.context` and `limit.output` the context window and maximum output. Capability metadata alone cannot
make a model available; a runnable model must still be explicitly selected by `model` or
`model.main` / `model.lite`. `models.*.options` and `reasoning.providerOptionsByLevel.*` may carry the raw
parameters of that kind; on load the config service wraps them by `kind` into the AI SDK `providerOptions`
namespace, for example `openai-compatible` normalizes to `openaiCompatible`.

When `provider.*.models.*` has no explicit `reasoning` metadata, the config-derived default reasoning must
generate provider options by provider kind: GLM / DeepSeek defaults inferred from the model id must not be
applied as OpenAI-compatible first and then handed to an Anthropic-compatible transport, otherwise the
TUI/ZCode app-server shows thinking as on while the final Anthropic-compatible request body contains no
`thinking`. For `kind: "anthropic"`, the default switch of GLM / non-V4 DeepSeek must map to
`providerOptions.anthropic.thinking.type`; `deepseek-v4*` must map to
`providerOptions.anthropic.thinking.type = "enabled"` and `providerOptions.anthropic.effort = level`.

### 3.1.1 DeepSeek V4 Pro compatibility

The thinking switch of DeepSeek V4 is on by default and the user only chooses the reasoning effort. The
OpenAI-compatible interface splits the thinking switch and reasoning effort into two parameters: the
ZCode config/policy layer expresses the thinking extension through
`providerOptions.openaiCompatible.thinking.type`, the adapter projects the canonical namespace to the
provider-name namespace the SDK actually reads, and the final HTTP body sends `thinking.type` at the top
level and must not contain a literal `extra_body`; `reasoning_effort` accepts only `high` / `max`. The
Anthropic-compatible interface likewise exposes only the `high` / `max` levels in the final request,
controlling intensity through `output_config.effort`; the input field ZCode gives the AI SDK is
`providerOptions.anthropic.effort`, mapped by the SDK to the final `output_config.effort`. ZCode keeps
the same contract for `deepseek-v4*`:

- The model default policy declares the canonical reasoning levels of DeepSeek V4 as `high` / `max`, with
  default level `max`.
- Under the OpenAI-compatible transport, every DeepSeek V4 reasoning level must generate both ZCode
  canonical provider options: `providerOptions.openaiCompatible.reasoningEffort` and
  `providerOptions.openaiCompatible.thinking.type = "enabled"`. The SDK maps them to the top-level
  `reasoning_effort` and `thinking.type` respectively; the final request must not contain a literal
  `extra_body`.
- For an Anthropic-compatible injected target, the ZCode app-server likewise shows only `high` / `max`
  and outputs `providerOptions.anthropic.effort = level` and
  `providerOptions.anthropic.thinking.type = "enabled"`.
- The model id of DeepSeek V4 cannot decide the transport. A model injected by the ZCode app-server still
  defaults to Anthropic-compatible; it switches to another transport only when the client explicitly
  passes a provider kind or a config target, or hits the independent GPT-prefix OpenAI native routing
  policy.
- For compatibility with old thought levels, `low` / `medium` normalize to `high` and `xhigh` to `max`;
  these aliases are not canonical levels shown for a new session.
- Runtime requests must still come from explicit `model` / `provider` config; the catalog provides only
  display names and capability metadata.
- Model transform recognizes the `deepseek-v4` series in the model id and replays
  `providerOptions.openaiCompatible.reasoning_content` on historical assistant messages. An ordinary
  assistant history sends the field only when non-empty reasoning text exists (including an existing
  non-empty `reasoning_content`); with no non-empty reasoning no empty field is created. An assistant
  history with tool calls keeps the existing compatible behavior: even without replayable reasoning text it
  may send an empty string, to satisfy the backend's requirement on the message shape of tool-call
  continuation turns.
- This `reasoning_content` compatibility applies only to the OpenAI / OpenAI-compatible transport. If
  DeepSeek or an aggregation gateway connects through an Anthropic-compatible transport, the `reasoning`
  block in historical assistant messages must be kept as Anthropic reasoning/thinking content and must not
  be rewritten into `openaiCompatible` provider options.
- The runtime must save the reasoning/thinking returned by the model as a provider-visible assistant
  content block into in-memory history and session parts; when a later tool result request replays the
  same assistant turn, it must not keep only the tool call and drop the reasoning block.
- This history replay contract is a general policy of Anthropic-compatible and not a DeepSeek or MiMo
  special case. When any Anthropic-compatible provider returns `thinking` + `tool_use` in thinking mode,
  the next request carrying `tool_result` must replay the thinking block of the same assistant message.
- The AI SDK Anthropic provider sends a `thinking` block only when the reasoning part carries Anthropic
  reasoning metadata; if a compatible backend returns no signature, ZCode must add
  `anthropic.signature = ""` in the history transform of the Anthropic transport, so the reasoning is not
  silently dropped by the AI SDK as `unsupported reasoning metadata`.
- When DeepSeek V4 Anthropic-compatible replays assistant tool-call history and the runtime captured no
  replayable reasoning block, an empty `thinking` block with `signature = ""` must also be synthesized
  before `tool_use`. This covers stream recovery and providers that expose no thinking delta, so the
  DeepSeek thinking mode requirement that the `content[].thinking` field exist is not lost in later
  `tool_result` requests.
- When the Runtime aggregates streamed reasoning it cannot assume a provider always sends
  `reasoning_start` first; on an isolated `reasoning_delta` it must also create and save a reasoning block.
- The final request projection must remove reasoning blocks with `text === ""` and no `providerOptions`
  key at all, so streaming shells without provider semantics are not sent to the backend. The rule acts
  only on the request-local transform and does not modify in-memory history or session parts; whitespace is
  not an empty string, and any known or unknown provider metadata is kept as opaque data. The empty
  thinking placeholder of tool calls for DeepSeek V4 Anthropic-compatible is synthesized per the previous
  rule after filtering and is therefore unaffected.
- For DeepSeek OpenAI-compatible replay the adapter aggregates non-empty `reasoning` blocks into the
  message-level `providerOptions.openaiCompatible.reasoning_content` and removes the reasoning blocks from
  the `content` array. Empty reasoning blocks of an ordinary assistant must be removed too without
  creating an empty `reasoning_content`; an assistant with tool calls still follows the empty-string
  compatible behavior above.

### 3.1.2 MiMo reasoning_content replay compatibility

For the MiMo series, when thinking mode is on and tool call history exists, later multi-turn requests must
send back the `reasoning_content` of the assistant history in full. ZCode keeps for any MiMo model the
same contract as the DeepSeek V4 OpenAI-compatible replay:

- Model transform recognizes provider id `mimo`, or a model id that begins with `mimo`
  case-insensitively.
- The compatibility applies only to the OpenAI / OpenAI-compatible transport; the Anthropic-compatible
  transport does not rewrite reasoning blocks.
- On OpenAI-compatible replay the adapter aggregates non-empty `reasoning` blocks of assistant history
  into the message-level `providerOptions.openaiCompatible.reasoning_content` and removes the reasoning
  blocks from the `content` array.
- An ordinary assistant without replayable reasoning text sends no empty string; an assistant with tool
  calls keeps the existing empty-string compatible behavior, keeping the message shape of later tool
  result requests stable.

Principles:

- ZCode's own environment variables keep the `ZCODE_` prefix.
- If no `~/.zcode/cli/config.json`, project config, session config or CLI override containing model
  config is loaded, the model request must fail with the error code `model_config_missing`.
- `modelCatalog.overrides` and `ZCODE_API_KEY` cannot by themselves make a model usable; they only provide
  capability metadata or a key fallback.
- `ZCODE_MODEL` is the only entry that can declare the currently runnable model from an environment
  variable. When a non-empty `ZCODE_MODEL` exists, the env scope generates a complete main model target
  that overrides the `model` config in user/project `config.json` by config precedence; this equals this
  process ignoring the model selection and provider connection of the files. CLI/session overrides still
  rank above env.
- An env model target uses the `anthropic` adapter by default. `ZCODE_MODEL` may be a bare model id, in
  which case the provider id defaults to `anthropic`; or `provider/model`, in which case the provider id
  is the slash prefix but the adapter kind is still `anthropic`, for Anthropic-compatible gateways.
  `ZCODE_BASE_URL` acts as the base URL of this target only when `ZCODE_MODEL` is effective; setting
  `ZCODE_BASE_URL` alone does not make a model usable and does not rewrite file config.
- A non-empty but unparsable `ZCODE_MODEL` is a config error: startup must fail with the original parse
  error cause kept, and must not silently fall back to the file model config.
- An env model target does not write `ZCODE_API_KEY` into the runtime config. The API key keeps being
  resolved at the model registry boundary by the existing fallback: standard provider key, provider
  derived key, and finally `ZCODE_API_KEY`.
- The API key is read preferably from `model.apiKey` / `model.main.apiKey` / `model.lite.apiKey`; when
  config provides none the adapter may fall back to environment variables, for example the provider
  derived key, a standard provider key or `ZCODE_API_KEY`.
- `apiKeyEnv` is not exposed as a user config field. The environment variable name is an internal
  compatibility policy of the adapter and does not enter the long-term user config surface.
- `headers` supports a custom string map passed to the provider adapter unchanged, but logs, errors and
  session events must go through sensitive-field redaction.
- The CLI entry loads, at run time, the nearest `.env` found upward from the current working directory
  into the environment; existing shell environment variables take precedence and are not overridden by
  `.env`.
- The build process must not read `.env` or inline API keys into `dist` artifacts, to avoid stale secrets
  and secret leaks.
- core does not read `process.env`.
- Config only declares model targets and provider connection parameters and cannot directly create network
  requests or SDK instances.
- Model capability metadata stores no API key and does not decide which model is used; it provides only
  the capability metadata of provider/model, and explicit user config always wins.

### 3.2 Model Registry

Assembles provider config into an AI SDK provider or provider factory.

Responsibilities:

- Register built-in providers.
- Register OpenAI-compatible providers.
- The first version of file config rejects provider kinds other than `anthropic`, `openai` and
  `openai-compatible`.
- The registry typed API may assemble the `gateway` provider config and custom provider factories passed
  by trusted callers; these are not a long-term user config surface and cannot bypass the config schema,
  permission and audit boundaries.
- If AI Gateway or custom provider packages are later opened to user config, the permission, install,
  cache, audit and error contracts come first.
- Resolve `provider/model`.
- Return the provider model handle to the request runner.

Does not:

- Expose the AI SDK `LanguageModel` in core.
- Write secrets into session events.
- Silently swallow provider init errors.

### 3.3 Model Runner

Runs one model request.

Responsibilities:

- Receive the provider-agnostic request intent of core.
- Call the transform to convert ZCode messages/tools into AI SDK `ModelMessage` / `ToolSet`.
- Call `streamText` or `generateText`.
- When calling the AI SDK `allowSystemInMessages: true` must be set explicitly. The ZCode system messages
  are built and audited uniformly by core/the context builder and are part of this project's formal
  context contract; do not let the generic safety notice of the AI SDK be written to the user-visible
  `stderr`, and the runner layer must not use the global `AI_SDK_LOG_WARNINGS` or coarse stderr muting to
  hide other provider diagnostics. The ZCode Protocol stdio entry may install a dedicated warning logger
  writing AI SDK warnings to structured logs, so ordinary text does not pollute the NDJSON protocol frames
  on stdout.
- Convert the AI SDK stream back into ZCode model events.
- Hand tool calls to the ZCode ToolRuntime instead of letting tools bypass the permission system.
- Normalize usage and errors.
- Propagate the current `TraceContext.traceId` in the HTTP header of every outbound model request, so
  provider, gateway, proxy and local logs can be correlated by the same `traceId`.

Principles:

- Tool execution still goes through the ZCode tool lifecycle: schema, permission, trace, adapter I/O,
  artifact.
- The AI SDK handles only the model-side tool calling protocol and streaming.
- Side-effecting tools do not rely on the AI SDK approval as the only safety boundary.
- Header injection happens at the adapter per-request call layer, not at the static provider config layer;
  the same provider factory is reused by many sessions/turns, so the dynamic `traceId` cannot be baked into
  the provider config.

The adapter per-request layer sends these attribution headers on every outbound model request:

- `x-request-id`: required, equal to the `requestId` of the current physical model request.
- `x-zcode-trace-id`: required, equal to the `traceId` of the current model request.
- `x-session-id`: sent when a session exists, using the session id with the internal prefix stripped.
- `x-query-id`: sent when a query exists, using the query id with the internal prefix stripped.
- `x-zcode-session-type`: required, only `main`, `subagent`, `side_chat` or `other`.
  `selection_side_chat` (including `/side`, `/btw`) maps to `side_chat`. The runtime model handle binds the
  host session type uniformly; title, Memory and tool-internal requests inherit the host; independent
  workspace requests are `other`. It is independent of the purpose field below and the session type is not
  overwritten by purpose. Full semantics:
  `docs/superpowers/specs/2026-06-09-agent-model-request-session-header-design.md`.
- `x-zcode-query-source`: sent when a legal `metadata.querySource` exists, preserving purposes such as
  `compact`, `session_title`, `project_memory_extract`. After trimming only 1–128 ASCII letters, digits,
  underscore, dot, colon or hyphen are accepted; a missing or illegal value is omitted without falling
  back to a same-named static header. generate/stream, retries and requests that skip the transcript share
  this rule.

Finer diagnostic information such as `turnId`, `spanId`, `parentSpanId` enters only model status events,
session events, trace spans and structured logs, not the provider-visible HTTP headers. The attribution
headers above are for statistics, diagnostics and audit only and are not a basis for authentication,
billing, rate limiting or business routing.

If a legacy call passes no `TraceContext` or metadata trace, the adapter may create a fallback `traceId`,
but must ensure the status events, logs and request headers use the same value. The runtime main path must
still pass `TraceContext` explicitly.

### 3.4 Model Transform

The most important boundary of the model layer.

Responsibilities:

- ZCode message -> AI SDK message.
- ZCode tool contract -> AI SDK tool.
- ZCode artifact/attachment -> content the provider supports.
- providerOptions injection.
- usage/error/event normalization.

The first version does only necessary transforms:

- Drop incompatible provider metadata on model switch.
- Turn unsupported image, PDF, audio and similar inputs into explicit model-visible hints or user-visible
  errors.
- Truncate tool results over budget and return an artifact reference.
- Complete pending/running tool calls as interrupted results when resuming a request.
- providerOptions come only from the config allowlist or an explicit role policy of the caller.

Later provider quirks can continue to be added here but must not scatter into the agent loop.

---

## 4. Core data

### 4.1 ModelRef

The ZCode session internally stores a structured model reference:

```text
providerId
modelId
source
role
variant?
```

A user may type `zai/glm-5`, but the session event does not store the bare string as the only fact.

### 4.2 ModelLevel and ModelRole

The first version of ZCode defines only two model capability levels:

- `main`: the primary model for ordinary conversation, code changes, the tool loop, complex reasoning and
  default subtasks.
- `lite`: the light model for titles, short summaries, hook judgments, light classification and low-risk
  structured small tasks.

`lite` is optional config. When `lite` is not configured the runtime must resolve `lite` to the current
`main`, instead of forcing a second model, a second provider or an extra environment variable.

ModelRole describes the purpose of a request, not the model level. The first version supports a few
roles: `main`, `lite`, `compact`, `review`, `subagent`.

Default policy:

- `main` comes from user config or CLI parameters.
- `lite` comes from `model.lite`; inherits `main` when not configured.
- `compact` inherits `main` by default and can later point to `lite` or an independent model via a role
  policy.
- `review` inherits `main` by default and can later point to a stronger or more conservative model via a
  role policy.
- `subagent` inherits the parent by default; agent config can explicitly override it to `main`, `lite` or
  a full `provider/model`.

Config policy:

- A single-model config uses `model: "provider/model"` directly, a multi-role config uses
  `model.main` / `model.lite`.
- The legacy `small_model`, `model.small` and inline model targets are no longer config input; the config
  schema should reject these shapes.
- The old `model.compact` is not a user config item; compact is a request role that resolves to `main` by
  default.
- The session event must record the finally resolved `ModelRef` and role, for example `role: "lite"`, so
  recovery is not affected by config drift.

Implementation plan: see [`lite-model-plan.md`](./lite-model-plan.md).

### 4.3 Model Config (compatibility config)

Model Config and Agent/Tools are **two independent dimensions**:

| Dimension | Determined by | Owner |
| --------- | ------------- | ----- |
| **Agent + Tools** | role/capability | decides "what can be done" |
| **Model Config** | API compatibility | decides "how to do it" |

Model Config mainly handles **API compatibility differences between models**, usually solved by a thin
layer of `if` in code.

| Compatibility scenario | Example |
| ---------------------- | ------- |
| **Capability support** | some models do not support tool calling, streaming or reasoning |
| **Parameter defaults** | different default maxTokens and temperature per model |
| **Request format** | some models need special headers, body fields or prompt format |
| **Response parsing** | different error formats and tool call structures need normalizing |

**Design principles:**

- Keep Model Config thin; do not over-abstract.
- Compatibility handling converges in the adapter layer and does not enter core.
- Do not make config for what an `if` solves; do not make code branches for what config solves.

```typescript
interface ModelConfig {
  supportsTools?: boolean; // default true
  supportsStreaming?: boolean; // default true
  supportsReasoning?: boolean; // default false
  maxContextTokens?: number; // for context window calculation
  defaultMaxTokens?: number;
  defaultTemperature?: number;
  requiresThoughtTag?: boolean; // some models need a tag in the prompt
}
```

### 4.4 Model Catalog and Reasoning Level

Model capability metadata no longer comes from a bundled `catalog.json` or a local
`models-catalog.json`. The effective catalog starts from an empty set and consists of the
`provider.*.models.*` projection, the `modelCatalog.overrides` of `config.json` and the deterministic
model default policy. The override key is `provider/model`, split at the first `/` into provider and model,
allowing the model id itself to contain `/`. The catalog cannot provide a default runnable model; the ZCode
app-server/TUI may offer only explicitly configured models as options of the current session, and the
catalog only supplements the capability, display name and reasoning level of those models.

Reasoning capability keeps two layers:

- `supportsReasoning`: a coarse switch to judge whether the model has reasoning/thinking capability.
- `reasoning.levels`: an optional level list for the ZCode app-server, TUI or other clients to show
  choices.

Example:

```json
{
  "modelCatalog": {
    "overrides": {
      "openai/glm-4.7": {
        "supportsReasoning": true,
        "reasoning": {
          "enabled": true,
          "levels": ["low", "medium", "high"],
          "defaultLevel": "medium",
          "providerOptionsByLevel": {
            "high": {
              "reasoningEffort": "high"
            }
          }
        }
      }
    }
  }
}
```

Rules:

- Capability metadata only declares capabilities and does not decide which model the current session uses.
- A config override only overrides the specified fields and does not require copying the whole model
  declaration.
- Configuring only `supportsReasoning` means a boolean capability override; if the provider/model id hits
  the `Model Default Policy`, the catalog service fills in the matching reasoning level or thinking
  toggle. A fully unknown model that hits no default policy gets no levels out of thin air.
- When `reasoning.levels` is configured, `supportsReasoning: true` is assumed unless
  `reasoning.enabled: false` is explicit.
- The session stores only the currently selected model and thought level; after a model switch the catalog
  recomputes the available levels.

### 4.4.1 Model Default Policy

ZCode may keep a very thin model default policy beside the catalog, to handle "the model id is already
recognizable but the user did not write complete capability metadata in `config.json`". The policy only
fills capability defaults and does not make a model usable; a runnable model must still be explicitly
selected by `model` / `model.main` / `model.lite`, and the provider must be configurable.

Merge and fallback order:

1. `provider.*.models.*` is projected into `modelCatalog.overrides` first; explicit
   `modelCatalog.overrides` then override the projected fields of the same key.
2. The catalog service starts from an empty set; each override first takes the model default policy by
   provider/model id and then overrides the defaults with config fields.
3. A pure catalog query hitting a recognizable model id may return a synthetic capability containing only
   default policy fields, but it does not appear in `listCapabilities()` and does not make the model
   runnable.
4. The Runtime may still use its own fallback when capability is missing, such as the 200000 token default
   window of the compact policy.

Default policies:

- If the model id (compatible gateway prefix allowed) exactly hits `kimi-k3`, `k3` or `k3-256k`, the
  default `contextWindow` is `1048576`, `1048576` and `262144` respectively, all three have
  `maxOutputTokens` of `131072` and support visual input; reasoning contains `low` / `high` / `max`, default
  `max`. OpenAI-compatible maps to `openaiCompatible.reasoningEffort`, Anthropic-compatible to
  `anthropic.effort` (the AI SDK outputs `output_config.effort`); neither chain injects the `thinking`
  switch of K2.x.
- If the model id ends with `-[1m]` case-insensitively, the default `contextWindow` is `1000000`.
- If the model id equals `deepseek-v4-pro` or `deepseek-v4-flash` case-insensitively, the default
  `contextWindow` is `1000000`; when a compatible gateway encodes the provider into the model id, for
  example `deepseek/deepseek-v4-flash` or `deepseek-ai/deepseek-v4-pro`, it matches by the model name
  after the last `/`.
- This policy affects everything depending on the model context window: context usage display, the auto
  compact threshold, the runtime context window after a model switch.
- If the model id contains `claude` case-insensitively, the default reasoning uses depth levels
  `low` / `medium` / `high` / `xhigh` with default `medium`, mapped to Anthropic fixed-budget thinking:
  `anthropic.effort = level`, `anthropic.thinking.type = "enabled"`.
- If the provider id is `openai` and the model id contains `gpt` case-insensitively, the default reasoning
  uses depth levels `low` / `medium` / `high`, default `medium`, mapped to OpenAI native
  `reasoningEffort = level`. OpenAI-compatible GPT models use the same levels but the provider option
  namespace is `openaiCompatible.reasoningEffort = level`. The canonical field of native OpenAI is merged
  into the `openai` namespace only at the Adapter runner boundary, keeping the static options of the same
  namespace before handing it to the Responses SDK.
- If the model id begins with `deepseek-v4` case-insensitively, the default reasoning uses the two
  canonical levels `high` / `max`, default `max`. Both levels enable
  `openaiCompatible.thinking.type = "enabled"` and set `openaiCompatible.reasoningEffort = "high"` /
  `"max"` respectively. Anthropic-compatible injected models use the same canonical levels, but the
  provider options input maps to `anthropic.effort`, and the final request body is output by the AI SDK as
  `output_config.effort`. For old-level compatibility `low` / `medium` map to `high` and `xhigh` to `max`.
- If the model id contains `glm` case-insensitively, or contains `deepseek` but is not the `deepseek-v4`
  series, the default reasoning is not `low` / `medium` / `high` levels but the two-state switch
  `enabled` / `disabled`, default `enabled`.
- Other `anthropic` or `openai-compatible` models declared through `provider.*.models.*` of `config.json`
  without explicit reasoning metadata also default to the `enabled` / `disabled` switch, so TUI/CLI/ZCode
  app-server always have a selectable thought level for configured models. A pure catalog query does not
  synthesize a generic switch for fully unknown models, to avoid widening catalog query semantics.
- The OpenAI-compatible switch `enabled` maps to the request provider option
  `openaiCompatible.thinking.type = "enabled"`; `disabled` likewise maps to `"disabled"`. The
  Anthropic-compatible non-Claude switch maps to `anthropic.thinking.type` and outputs no Claude-specific
  `anthropic.effort`.
- The GLM default policy does not set `clear_thinking: false`. A "preserved thinking" policy may be
  considered only after ZCode can fully save and send back `reasoning_content` in assistant history.
- If the model id contains `opus-4.7` or `opus-4-7` case-insensitively, the default reasoning levels
  include `low`, `medium`, `high`, `xhigh`, `max` with default level still `medium`. The default Anthropic
  provider options of each level use `anthropic.effort = level` and
  `anthropic.thinking.type = "adaptive"`, so the TUI, CLI and ZCode app-server share the same Opus 4.7
  thinking depth compatibility logic from catalog/config. The rule is for Claude Opus 4.7 and its hyphen
  variants in user config; it only fills reasoning metadata and provider options and does not change
  provider connections or runnable model selection.
- If the request goes through `@ai-sdk/anthropic` and the caller passes no explicit `maxOutputTokens`, the
  model adapter fills `64000` by default. An explicit request value wins; the rule acts only on the
  request layer and does not change the catalog or the model default policy.
- If the user explicitly writes the related capability fields in `config.json` or a catalog override, the
  explicit value wins over the model default policy.

### 4.4.1 Reasoning effort command surface

The TUI local command `/effort [list|<level>]` reads the selectable thinking depths from the current
model's `reasoning.levels` and maps the selected level to the same
`reasoning.providerOptionsByLevel[level]` runtime provider options. `/variant` is only an input
compatibility alias and introduces no independent model variant config.

The interactive TUI `/effort` entry uses a composer candidate popup of the same form as `/model`: typing
`/effort` or `/variant` filters the selectable level list exposed by the app/server, and Tab/Enter
submits an explicit `/effort <level>`. An empty `/effort`, `/variant` and the `list` argument still return
a plain-text list from the command center, for non-popup clients and the debug path.

A successful `/effort` switch only updates the current session runtime `modelProviderOptions` and the
global `local_setting(model.reasoningLevel)` preference and does not patch `model` or provider config in
`config.json`. A later new session without explicit runtime provider options reads this global preference;
if the current model does not support the level it falls back to the `defaultLevel` of the model catalog
or the first level.

### 4.5 ModelMetadata

The first version of metadata stays thin:

```text
displayName?
contextWindow?
maxOutputTokens?
supportsTools?
supportsJsonSchemaOutput?
cost?
```

This early metadata sketch is superseded for input/output formats. Current runtime format facts use the
complete Active Model `properties.input_format` / `properties.output_format` contract documented in
`docs/working-memory/provider-refactor/design/model/input-output-format.md`.

Sources: user config; provider static declaration; optional remote models list; fallback defaults.

No large model catalog. When a catalog is needed the `models.dev` data source can be hooked in, but it is
not P0.

---

## 5. Request flow

```text
user turn
  -> core selects ModelRef
  -> Model Registry resolves provider/model
  -> Model Transform compiles messages/tools/providerOptions
  -> Model Runner calls AI SDK streamText/generateText
  -> the AI SDK returns a text/tool/reasoning/usage/error stream
  -> Model Runner converts to ZCode session events
  -> ToolRuntime executes tools
  -> next round continues
```

`workspace/generateText` is a controlled short-text sidecar: the caller provides only one user prompt and
tools are not opened. Git commit message generation fixedly uses `querySource = "git_commit_message"`; such
requests have a very small output budget, so the runtime must turn off reasoning/thinking provider options
before calling `modelAdapter.generateText`, so a high reasoning level of the user's current session does
not consume all `max_tokens` on thinking tokens and return empty text. The turn-off conversion must
consume both the `modelRef` and the original provider options: existing `thinking`/`enable_thinking` use
the matching direct switch, effort-only models that explicitly support `none`, such as GLM-5.2, write the
canonical `reasoningEffort=none`; it must not just delete effort and must not re-synthesize `extra_body`.

Key events:

- `model.selected`
- `model.request.started`
- `model.stream.delta`
- `model.tool_call.started`
- `model.tool_call.completed`
- `model.usage.recorded`
- `model.network.started`
- `model.network.retry_scheduled`
- `model.network.failed`
- `model.network.completed`
- `model.request.failed`
- `model.request.completed`

All events must carry `traceId`, `sessionId`, `turnId` and `ModelRef`.

The Model Runner exposes only the provider-neutral `ModelStatusSink` to the UI layer and never passes AI
SDK, HTTP library or raw provider error objects to the UI. The event form is `ModelNetworkStatusEvent`,
containing at least:

```text
type
timestamp
traceId
sessionId?
turnId?
requestId
model
transport          # http | sse | websocket
attempt
maxAttempts
```

`requestId` denotes one physical provider request, not the logical request of the whole user turn. Every
time an adapter retry issues a new HTTP/SSE provider request it must generate a new `requestId` and write
it into the event and the `x-request-id` header; the retry chain of one turn is correlated by the stable
`traceId`, `sessionId`, `turnId` and the increasing `attempt`. The first attempt may reuse the
`metadata.requestId` passed by the caller; later attempts must not reuse it.

Current stable events: `model_request_started`, `model_request_completed`, `model_request_failed`,
`model_retry_scheduled`, `model_stream_stalled`.

`model_request_failed` must carry a stable `reason`, `retryable`, a safe `message` and an optional
`statusCode`; `model_retry_scheduled` must carry `reason`, `delayMs`, `nextAttempt` and a safe `message`.
The UI may consume only these stable fields and must not depend on provider error text, headers, response
body or SDK private fields.

---

## 6. Error handling

The first version defines only these stable errors:

- `provider_not_found`
- `provider_not_configured`
- `invalid_model_ref`
- `invalid_model_request`
- `model_not_found`
- `model_request_failed`
- `model_request_cancelled`
- `model_request_timeout`
- `model_rate_limited`
- `model_context_exceeded`

Error requirements: keep the original cause; give the user an actionable hint; do not depend on provider
error text for flow decisions; do not leak API keys, headers or the full prompt.

Network request failure reasons are normalized to a stable enum; the first version includes:
`rate_limited`, `provider_overloaded`, `server_error`, `network_error`, `timeout`, `stream_idle_timeout`,
`stale_connection`, `auth_refresh`, `auth_failed`, `cancelled`, `context_exceeded`, `invalid_request`,
`provider_not_configured`, `proxy_error`, `tls_error`, `unknown`.

The default internal retry of the AI SDK cannot meet observability requirements because the UI and logs do
not see the reason of each retry. The ZCode adapter should set the SDK internal `maxRetries` to `0`,
implement its own retry loop at the adapter boundary, and publish `ModelNetworkStatusEvent` at each
failure, retry scheduling and final failure. Default retries may only happen in the request phase that has
not yet produced committed output; a streaming request may buffer and discard side-effect-free prelude
events such as `reasoning_delta` and `tool_input_delta` and retry, but once `text_delta`, `tool_call` or
`finish` has been produced upstream there is no automatic replay, to avoid duplicated content or duplicated
tool calls. If early tool execution during the model SSE is enabled later, retries must follow the ledger
and recovery anchor semantics of `streaming-tool-execution-and-recovery.md`; it must not fall back to a
non-stream fallback and must not resume from half an assistant text to implicitly recover tool state.

The model SSE is a long connection and must not use the ordinary HTTP total request timeout. The ZCode
adapter must use an inter-event idle timeout: the first request defaults to 600000ms, overridable via
`modelStream.idleTimeoutMs` in `~/.zcode/cli/config.json`; it waits from the request start for the first
stream event and resets the timer after every AI SDK stream chunk / SSE event; as long as events keep
arriving, continuing is allowed even if the total time exceeds the initial idle timeout. The SSE idle
timeout increases in retry scenarios: for every adapter retry or core stream recovery retry, 30000ms is
added to the adapter base timeout, e.g. default first request 600s, first retry 630s, second retry 660s.
When the idle timeout is exceeded the adapter publishes `model_stream_stalled`, terminates the current
provider request, normalizes the failure to `stream_idle_timeout` and retries automatically under the
unified retry budget while no committed output has been produced. This config is read when the model
adapter is constructed, so after modifying `config.json` a new agent/runtime must be created to guarantee
it takes effect.

Retry semantics use the user-understandable "retry count" as the default config measure, with default
`maxRetries = 10`. Runtime events keep the `maxAttempts` field for the total attempt count, so the default
events have `maxAttempts = 11`, i.e. 1 first request and 10 retries. The implementation must not mistake
`maxAttempts` for the retry count; logs carry both `maxAttempts` and the derived `maxRetries` to ease
investigating wait and final failure reasons. User-side displays such as TUI and ZCode app-server must
convert `attempt` / `maxAttempts` into `retry` / `maxRetries` in the projection layer: the first retry
shows `1/10` by default rather than internal attempt measures like `2/11`.

The backoff policy defaults to exponential backoff with jitter: `baseDelayMs = 2000`,
`backoffFactor = 2`, ordinary backoff cap `maxDelayMs = 60000`. If the provider returns `retry-after-ms`
or `retry-after`, the adapter must prefer the provider-indicated wait; `retry-after-ms` is more precise
and has higher priority than `retry-after`. If the provider also returns `x-should-retry: false`, the
adapter must ignore the provider `retry-after-ms` / `retry-after` wait hints and fall back to the local
retry backoff. To avoid uncontrolled waits from abnormal headers, the provider header is adopted only when
`0 <= delay <= 5min` or the delay is less than the current exponential backoff time, otherwise the local
exponential backoff is used. `retry-after` supports seconds and HTTP date.

When a structured business code clearly indicates long-term quota exhaustion, arrears or an expired plan,
the adapter must normalize it to a terminal failure: keep the provider's original safe message, set
`retryable = false` and end the current request at once; it must not fall into the generic HTTP `429`
automatic retry. Classification input may only come from the error data already parsed by the AI SDK or
the existing `ProviderBusinessError.providerCode`; no raw response field bypass parsing may be added for a
vendor and no natural-language error text may be matched. The same AI SDK parsed error detail must serve
failure classification, the `model_request_failed` diagnostic fields and the final adapter error context
together, without losing the provider code, message or request id after classification and without each
consumer parsing again. The OpenAI-compatible `insufficient_quota`; the OpenAI
`credit_balance_exhausted` / `organization_spend_limit_exceeded` / `project_spend_limit_exceeded` /
`organization_usage_limit_exceeded`; Kimi `exceeded_current_quota_error`; MiniMax `1008` / `2056`;
BigModel long-term quota and plan business codes; and TokenHub `20097` are all terminal signals; but only
codes that the current AI SDK provider schema actually exposes in the unified error object enter the
mapping, and the AI SDK cannot be bypassed to fill fields.

The terminal semantics of `insufficient_quota` must not depend on whether `Retry-After` exists or on its
wait duration; `Retry-After` keeps only its existing parsing and diagnostic use and does not take part in
the `retryable` judgment of business codes. Transient capacity and rate codes such as Kimi
`engine_overloaded_error` / `rate_limit_reached_error` and Anthropic `overloaded_error` /
`rate_limit_error` must remain retryable.

The model I/O diagnostic trajectory is stored per session at
`~/.zcode/cli/{debug,rollout}/model-io-<sessionId>.jsonl`. It is neither a product timeline nor part of
the session recovery chain; it is only for debugging real provider request/response. Development mode is
decided by `ZCODE_RUNTIME_ENV=development`; `NODE_ENV` plays no part in the ZCode runtime decision. A
bounded policy is used by default: production limits the number of session files and the single-file
size, development limits the single-file size, and repeated request context uses `full` / `delta` /
`tail` compression. The App Settings "keep model I/O in full" is off by default; once on, from the next
model attempt on no file eviction, single-file reset, message compression or production field trimming is
performed. Credential redaction of headers and request metadata must be kept in both modes, and a
recording failure must not affect the model request main path. Full setting contract:
`docs/model-io-full-retention-setting.md`.

When a provider returns HTTP 200 but a business protocol failure, the adapter must treat it as a model
request failure instead of letting the AI SDK propagate an empty result or `finishReason: other` upstream.
The compatibility judgment sits at the provider HTTP fetch boundary: if the JSON response body contains
`success: false`, or `code` / `error_code` exists and is not `0` / `"0"`, a provider business error is
thrown. The user-visible error message prefers `msg`, then `message`, then the nested `error.message`;
without a safe message a generic provider business error text is used. The error is normalized by the
Model Runner to `model_request_failed`, preserving the original cause, a safe summary of the business
`statusCode` / provider code, and the response headers used for retry attribution. Business errors are
not retried by default, but when a business error can safely map to `HTTP 5xx` it is treated as a provider
server error and reuses the unified retry budget; when the structured code of a provider business error
clearly indicates an upstream network failure, for example the BigModel compatibility layer returning
`code=1234` with a user-visible message usually reading "network error, error id ..., please retry later",
or the provider explicitly returning `network_error` / `network_error_retryable`, it is normalized to
`network_error` and reuses the unified retry budget; the BigModel codes
`1120` / `1230` / `1302` / `1303` / `1305` / `1312` documented as temporary account access anomalies, call
flow anomalies, concurrency/frequency/platform traffic limits or model access overload also reuse the
unified retry budget. 4xx, permission, plan, long-term quota reset and other business errors not mapped
to `5xx`, network failure, rate limiting or overload stay non-retryable. Diagnostic logs may only enter
the structured log summary containing `requestId`, `traceId`, finish reason, usage, text length, tool call
count, stream chunk count and a safe summary of the provider body, and never the full prompt, full headers
or a large response body.

Streaming SSE must run the same kind of business error recognition. Some OpenAI-compatible providers
return `event: error` in an HTTP 200 `text/event-stream` and put the business error in the `data` JSON,
for example `{ "error": { "code": "1311", "message": "当前订阅套餐暂未开放GLM-5V-Turbo权限" }, "request_id": "..." }`
(message: the current subscription plan does not yet open GLM-5V-Turbo permission), and then send
`[DONE]`. The provider fetch boundary must check SSE frame by frame without buffering the whole stream and
without changing the order of normal frames: when the event of a frame is `error`, or the data JSON hits
the business failure rules `success/code/error_code/error.message` above, it terminates the response body
and throws `ProviderBusinessError`. The error must keep the provider code, request id, response HTTP
status, a safe body summary and response headers; the Model Runner keeps normalizing error semantics, and,
when no committed model event has yet been produced and the business error maps to `HTTP 5xx` or clearly
indicates a provider network failure, rate limit or overload, reuses the unified retry budget; otherwise
it publishes the final `model_request_failed`, with the user-visible message using the safe message
provided by the provider. Non-JSON frames, `data: [DONE]` and normal incremental frames pass through
unchanged.

---

## 7. Current implementation anchors

This stage introduced the Vercel AI SDK and connected it to the core runtime through the adapter.
Verified on 2026-05-07.

- `packages/contracts/src/model/index.ts`: provider-neutral `ModelRef`, request, usage, tool contract,
  stream event and error codes.
- `packages/contracts/src/model/catalog.ts`: `ModelCapability`, `ProviderMeta`, reasoning metadata,
  catalog override and the `ModelCapabilityProvider` query interface.
- `packages/contracts/src/events/session.events.ts`: model events can carry a structured `ModelRef`.
- `packages/adapters/src/model/catalog.ts`, `catalog-source.ts`, `default-policy.ts`: start from the
  `models.dev` capability catalog, merge `modelCatalog.overrides` and the `provider.*.models.*`
  projection; OpenRouter can serve as a factual capability anchor when an injected provider ID cannot be
  matched directly; and fill default context windows and reasoning provider options for `-[1m]`, DeepSeek,
  GLM, Claude, OpenAI/GPT, Opus 4.7 and similar models. The catalog provides only capability metadata and
  does not make models runnable automatically.
- `packages/adapters/src/model/registry.ts`: assembles `anthropic`, `openai`, `openai-compatible` and
  supports the adapter-internal `gateway` and custom provider factories; the file config schema still
  rejects `gateway` / `custom`.
- `packages/adapters/src/model/transform.ts`: conversion of ZCode message/tool contract to AI SDK
  `ModelMessage` / `ToolSet`.
- `packages/adapters/src/model/runner.ts`: the adapter wrapper of `generateText` / `streamText`,
  responsible for disabling the invisible SDK retry, publishing model network status, and outputting
  ZCode's own text result and stream events.
- `packages/adapters/src/config/schema.ts`: file config accepts only the provider kinds `anthropic`,
  `openai`, `openai-compatible`, rejects `gateway`, `custom`, `npm`, `small_model`, `model.small` and
  inline targets; also projects `provider.*.models.*` into the model catalog overrides.
- `packages/bootstrap/src/model-config.ts`: assembles the runtime model config into the AI SDK registry
  config, fills provider headers, derives the API key fallback by provider/name, and keeps the
  `model_config_missing` error boundary.
- `packages/core/src/runtime/methods/model.ts`, `turn-model-step.ts`: the core runtime calls the model
  adapter through `runModelTextRequest`, supporting streaming events, tool calls, usage, reasoning block
  persistence, trace/status sink, provider context usage and context-overflow reactive compact.

Test anchors:

- `packages/contracts/tests/model-ref.test.ts`, `model-usage.test.ts`
- `packages/adapters/tests/model-catalog.test.ts`, `config.test.ts`, `registry.test.ts`,
  `runner.test.ts`, `model-transform.test.ts`
- `packages/bootstrap/tests/model-config.test.ts`, `model-selection.test.ts`
- `packages/core/tests/runtime-tool-loop.test.ts`, `runtime-trace.test.ts`, `runtime-compact.test.ts`

Remaining gap: Provider Capability is currently an implementation of a model capability catalog plus
adapter default policy; network/cache/parallel-tool/retry budget have not all been promoted to an
independent stable capability schema. If user-configurable gateway/custom providers or a remote catalog
are to be supported later, the permission, install, cache, audit, error and test contracts must come
first.

---

## 8. Implementation order

1. Add the minimal `ModelRef`, model event and model error to protocol.
2. Add the `model` adapter in adapters, using the Vercel AI SDK internally.
3. Support the `provider/model` parser.
4. Support config assembly of `anthropic`, `openai`, `openai-compatible`; reject loading of other kinds.
5. Implement the `streamText` runner and stream event normalization.
6. Add the `main/lite` role resolver; `lite` resolves to `main` when not configured.
7. Convert the existing tool contract to AI SDK tools, with the execution callback still entering the
   ZCode ToolRuntime.
8. Add unit tests for provider differences in the central transform layer.
9. Then consider the remote catalog, dynamic loading of provider packages and complex providerOptions.

---

## 9. Test requirements

Must cover:

- `provider/model` parsing, still correct when the model id contains `/`.
- `lite` resolves to `main` when not configured.
- `ZCODE_MODEL` + `ZCODE_BASE_URL` generate an env model target for the Anthropic adapter and override the
  file model config.
- An illegal `ZCODE_MODEL` produces a config error instead of falling back to `config.json`.
- `ZCODE_MODEL` does not store `ZCODE_API_KEY` in the runtime config, and the registry can still get the
  key through the `ZCODE_API_KEY` fallback.
- The schema rejects `small_model`, `model.small` and inline model targets.
- Provider not configured, model missing, env key missing.
- OpenAI-compatible provider baseURL config.
- Parsing of a provider-qualified model id containing `/`, such as `gateway/zai/glm-5`.
- Tool calls enter the ZCode ToolRuntime.
- Old provider metadata is not reused on model switch.
- Unsupported attachment handling.
- stream abort and provider error.
- The session event completes even when usage is missing.

Verification commands:

```text
npm run lint
npm test
```

---

## 10. Design principles

- The AI SDK is the provider API abstraction layer, not the ZCode core type system.
- Uniformly use the structure of `provider/model` references plus a central transform layer.
- ZCode itself implements only the state, permissions, trace and tool lifecycle an agent must own.
- P0 has no large model catalog, no provider marketplace and no complex automatic fallback.
- Any provider special case enters `Model Transform` first and must not pollute the agent loop.

## Selection side first input

The App's `createSelectionSideSession.firstInput.modelSelection` is an optional complete model selection;
details in the [side-panel contract](../../../../../../docs/ui/conversation-selection-side-chat.md). When
present, the child's model config is written by the original fork creation path and the first input keeps
that config; it neither updates the parent nor sends a separate model switch command. When absent the
original runtime inheritance is kept; old clients stay compatible.
