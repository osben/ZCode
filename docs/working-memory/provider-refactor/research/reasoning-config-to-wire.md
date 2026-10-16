# Reasoning: From Model Config to Final Request

> Status: Current status investigation complete, target boundaries formed; specific migration plan not yet implemented
> Date: 2026-08-10
> Corresponding stage design: [`../steps/01-model-and-request.md`](../steps/01-model-and-request.md)
>
> Terminology note: This investigation uses `ModelBinding` to represent the model object held by continuous execution; the current design has converged to callable `Model`, expressed as immutable derivation by `model.bind(options)`. The old terminology in this document is used only to reconstruct the code chain at that time.

## Conclusion

Reasoning can maintain a very simple model at the product layer: models declare which tiers they support, users select one tier, a continuous execution fixes this selection, and Adapters then write it as request fields accepted by the target interface.

```text
Model declares levels
      |
      v
User selects reasoningLevel
      |
      v
Model.bind() fixes reasoningLevel
      |
      v
Specific Adapter serialization
      |
      v
Provider HTTP request
```

The current implementation has not yet formed this clean boundary. The system first converts logical tiers into an arbitrarily-structured `providerOptions`, then passes this object from Catalogs, Bootstrap, and Runtime all the way to Adapters. The conversion logic is distributed across App config projections, CLI Catalog default policies, dynamic Provider overlays, historical compatibilities, and auxiliary model tasks.

This investigation originally was just a parameter issue within M1 ModelBinding design. After code expansion, it can be confirmed that it has formed an independent migration topic: the repository Catalog saves explicit parameter mappings, the App side strips mappings and retains only tiers, and the CLI then reconstructs parameters through dynamic `first-match-wins` rules and Standalone CLI `last-match-wins` default policies, while Titles, Git, Compacts, and Memories further modify results before calls.

Therefore, this round's investigation stops at this point here. M1 retains only the generic `reasoningLevel` in public boundaries: Selections save user selections, `Model.bind(options)` fixes continuous execution tiers, and Requests can override within the scope validated by Option Specs. Existing `providerOptionsByLevel` parsing concentrates into compatible assembly and Adapter paths, no longer exposed to business callers. Unified Catalogs, deleted name inference, unified priority, and re-done Adapter dialects are subsequent independent migrations. This document continues as the baseline for this topic's current behavior.

The most easily confused names can be understood this way first:

- `thoughtLevel`, `reasoningLevel`, and `ModelRef.variant` express the user-selected logical tier, e.g., `high`.
- `providerOptionsByLevel` is a "tier-to-vendor-parameters" lookup table; it is not sent as-is to model interfaces.
- `providerOptions` is an intermediate object prepared for a run to give to AI SDK, containing reasoning, transport, output budgets, and other Provider parameters mixed in.
- `reasoning_effort`, `enable_thinking`, `thinking`, `output_config.effort` are the actual HTTP request fields.

These final fields are not unified under the same OpenAI-compatible protocol. Current code mainly selects dialects based on explicit mappings, `provider.kind`, `providerId`, `modelId`, and tier lists; Base URLs do not participate in reasoning dialect judgment. Therefore, two Providers of the same kind, same modelId, but different URLs produce the same parameters without explicit mappings. This is a clear limitation of the current implementation.

### `apiFormat`, `defaultKind`, and `kind`

The settings page exposes `apiFormat` to users:

```text
anthropic-messages
openai-chat-completions
openai-responses
```

When saving Provider Configs, the page simultaneously writes the derived `defaultKind`. When Hosts generate runtime Registries, the final `apiFormat` is first parsed, then the CLI's `kind` is derived:

```text
apiFormat                    defaultKind / kind
anthropic-messages        <-> anthropic
openai-responses          <-> openai
openai-chat-completions   <-> openai-compatible
```

Built-in Providers entering `ModelProviderConfig` also typically populate `apiFormat` and `defaultKind` simultaneously. Hardcoded Start Plans directly write this pair; remote builtin schemas typically provide `primaryKind` first, then derive `apiFormat` at load time.

Under the current three protocols, these fields do not express independent information. The runtime protocol allows both `kind` and `apiFormat`, but does not exclude inconsistent combinations from types. The proposed evolution direction is to make `apiFormat` the single source of truth in configs and protocols; Adapter factories can continue using their own implementation enums internally, but those enums no longer enter Provider Configs or cross-process protocols. This direction still needs to verify Standalone CLI `provider.kind` migration before implementation, and how to explicitly select the current protocol when a Provider has multiple endpoints.

## A Complete Chain

The following diagram places the main objects in the current status on the same line:

```text
App config / CLI config / builtin Catalog
                |
                |  Declares levels, some sources also declare parameter mappings
                v
ModelCapability.reasoning
├─ enabled
├─ levels
├─ defaultLevel
└─ providerOptionsByLevel
                |
                |  Users select in App / TUI / Automation / Subagent
                v
thoughtLevel / ModelRef.variant
                |
                | resolveThoughtProviderOptionsForLevel()
                v
Runtime.modelProviderOptions
                |
                | Model Step constructs ModelTextRequest
                v
ModelTextRequest.providerOptions
                |
                | runner-options normalize namespace by Provider kind
                v
AI SDK providerOptions
                |
                | Per-SDK serialization
                v
HTTP request body
```

`ModelCapability.reasoning` currently both describes user-selectable capabilities and saves vendor parameter mappings:

```ts
interface ModelReasoningCapability {
  enabled: boolean;
  levels: string[];
  defaultLevel?: string;
  providerOptionsByLevel?: Record<string, Record<string, unknown>>;
}
```

For example:

```ts
{
  enabled: true,
  levels: ["low", "high"],
  defaultLevel: "high",
  providerOptionsByLevel: {
    low:  { openaiCompatible: { reasoningEffort: "low" } },
    high: { openaiCompatible: { reasoningEffort: "high" } }
  }
}
```

After users select `high`, the Runtime receives:

```ts
{
  openaiCompatible: {
    reasoningEffort: "high";
  }
}
```

OpenAI-compatible Adapters ultimately send it as:

```json
{
  "reasoning_effort": "high"
}
```

## Where Configs Come From

### App's Persistent Configs

The App's authoritative file is `~/.zcode/v2/config.json`. Currently persisted reasoning only describes tiers, not vendor request parameters:

```jsonc
{
  "provider": {
    "deepseek": {
      "kind": "openai-compatible",
      "options": {
        "apiKey": "sk-...",
        "baseURL": "https://api.deepseek.com/v1",
      },
      "models": {
        "deepseek-v4-pro": {
          "reasoning": {
            "enabled": true,
            "variants": ["high", "max"],
            "defaultVariant": "max",
          },
        },
      },
    },
  },
}
```

This config converts to internal `ModelProviderReasoningSpec` after being read by the App. Each level temporarily has only a name, no patches:

```ts
{
  defaultLevel: "max",
  levels: {
    high: {},
    max: {}
  }
}
```

The App clears old `model.variants`, `reasoningSpec`, and `zcode.reasoning` parameter mappings when saving configs. In other words, configs saved through the App settings page cannot directly dictate whether `high` ultimately uses `reasoning_effort` or `enable_thinking`; zcode-cli will supplement mappings at runtime.

Relevant conversions are located at `modelProviderServiceStorage.ts`'s `openCodeReasoningToModelReasoning()` and `modelReasoningToOpenCodeReasoning()`.

### Standalone CLI Configs

Standalone CLIs read `~/.zcode/cli/config.json`. They accept structures closer to Runtimes and can explicitly save `providerOptionsByLevel`:

```jsonc
{
  "provider": {
    "custom-qwen": {
      "kind": "openai-compatible",
      "baseURL": "https://example.com/v1",
      "models": {
        "qwen3.5-plus": {
          "reasoning": {
            "enabled": true,
            "levels": ["enabled", "disabled"],
            "defaultLevel": "enabled",
            "providerOptionsByLevel": {
              "enabled": { "enable_thinking": true },
              "disabled": { "enable_thinking": false },
            },
          },
        },
      },
    },
  },
}
```

Because Provider kind is `openai-compatible`, CLI schemas wrap un-namespaced parameters as:

```ts
{
  enabled: {
    openaiCompatible: { enable_thinking: true }
  },
  disabled: {
    openaiCompatible: { enable_thinking: false }
  }
}
```

If configs already carry `anthropic`, `openai`, or `openaiCompatible` namespaces, they remain as-is.

This means App configs and Standalone CLI configs are currently asymmetric: Apps only save tiers; CLIs can simultaneously save tiers and sending parameters.

### Model Catalogs and Built-in Providers

Historical Model Catalogs and remote builtin configs use patches to describe parameters for each transport:

```ts
interface ModelProviderReasoningSpec {
  defaultLevel?: string;
  levels: Record<
    string,
    Partial<Record<"anthropic" | "openai" | "openai-compatible", ProviderOptionsPatch>>
  >;
}
```

A real Catalog config for Kimi K3:

```jsonc
{
  "defaultLevel": "max",
  "levels": {
    "high": {
      "anthropic": {
        "set": [{ "path": ["output_config", "effort"], "value": "high" }],
      },
      "openai-compatible": {
        "set": [{ "path": ["reasoningEffort"], "value": "high" }],
      },
    },
  },
}
```

When Apps project the current transport to zcode-cli, they only extract patches of the corresponding kind. Assuming the current kind is `openai-compatible`, the above becomes:

```ts
{
  high: {
    openaiCompatible: {
      reasoningEffort: "high";
    }
  }
}
```

Ordinary App persistent configs clear these patches, but built-in Coding Plans, Start Plans, and remote client configs can carry complete `ModelProviderReasoningSpec` in memory, entering zcode-cli through the same protocol projection function.

Plan login status, entitlement judgments, runtime API Keys, and one-time security verification Headers do not participate in reasoning dialect selection. They first form currently callable Providers; reasoning still depends on the Provider's `kind` and model definitions. Current ZCode built-in Plans primarily project as Anthropic runtime, so GLM and other models follow `anthropic.effort` / `anthropic.thinking` paths. Refreshing Tokens or Headers before requests only changes authentication materials, not already-selected reasoning levels.

Currently only five types of reasoning patch paths actually appear in local Catalogs:

```text
anthropic
├─ output_config.effort
└─ thinking

openai-compatible
├─ reasoningEffort
├─ enable_thinking
└─ thinking.type
```

The Catalog's patch structure is a config-layer expression; whether it can ultimately be directly accepted by the SDK also goes through zcode-cli model specifics and Adapter normalization. For example, Kimi K3 will regenerate `anthropic.effort` in CLI overlays, not directly giving the Catalog's `anthropic.output_config.effort` to the SDK.

## How zcode-cli Forms `providerOptionsByLevel`

### Dynamic App Providers

After Apps下发 Providers through the protocol, `workspace-model-catalog.ts` creates runtime capabilities for each model. The order is roughly:

```text
Kimi K3 model specifics
        |
        | Hits directly use K3 rules
        v
Inbound reasoning levels
        |
        +-- Generate missing mappings by kind / providerId / modelId
        |
        +-- Merge inbound explicit providerOptionsByLevel
        |   Explicit fields take priority
        v
Filter to inbound-declared levels
        |
        v
ModelCapability.reasoning
```

Without inbound reasoning, CLIs then try to supplement defaults by model names and Provider kinds. The main judgment fields are:

```text
provider.kind
provider.providerId
model.modelId
model.reasoning.levels
model.reasoning.providerOptionsByLevel
```

Base URLs are not in this judgment set.

Current hardcoded recognitions include:

- `gpt` models select OpenAI, OpenAI-compatible, or Anthropic parameters by `provider.kind`.
- `qwen` judges by providerId prefix or modelId, using `enable_thinking`.
- `glm` judges by model names and tiers whether switches or depth tiers.
- `deepseek-v4` simultaneously uses `thinking.type` and `reasoningEffort`.
- Kimi, MiMo, and other models use `thinking.type` switches by providerId/modelId families.
- Kimi K3 forces `low/high/max` usage and uses efforts by transport.

When the same-named model connects to two different URLs, as long as kind, providerId/modelId rules are the same, identical mappings are produced. To express different dialects, the current approach can only have upstream explicitly carry different reasoning patches, or add new code specifics.

### Standalone CLI Default Policies

Standalone CLIs' static Catalogs use another set of default rules, core at `default-policy.ts` and `reasoning-policy.ts`:

```text
Kimi K3                 -> low / high / max
DeepSeek V4             -> high / max
GLM 5.2                 -> max / high / nothink
Other GLM / DeepSeek    -> enabled / disabled
Claude                   -> low / medium / high / xhigh
Claude Opus 4.7          -> low / medium / high / xhigh / max
GPT                      -> low / medium / high / xhigh
```

Again, default mappings are selected by `providerId` and `modelId`. For unspecified reasoning custom `openai-compatible` models, current config parsing also supplements a general `thinking.type = enabled/disabled` switch. This rule has broad coverage and cannot guarantee suitability for all OpenAI-compatible services.

### How Tier Names Are Normalized

Normal selections first do exact matching, then case-insensitive matching. Without explicit selections, valid `defaultLevels` are used; without valid defaults, `levels[0]` is used.

Currently there are also two sets of model-specific aliases:

```text
DeepSeek V4
├─ low / medium -> high
└─ xhigh         -> max

thinking toggle
├─ enabled       -> enabled
└─ disabled/off  -> disabled
```

App UIs translate values like `off`, `disabled`, `none`, `nothink` into display-appropriate text, but display aliases themselves do not automatically change Provider parameters. True execution normalization is still completed by Catalog/Bootstrap rules.

### How Static Options and Tier Options Merge

Model targets can first carry a static `providerOptions`, e.g., API format, structured-output options, or user-configured custom fields. Bootstraps then deep-merge selected tier's options, with tier options overriding same-path static values:

```text
target.providerOptions
        +
providerOptionsByLevel[selectedLevel]
        |
        | recursive merge, selected level takes priority
        v
Runtime.modelProviderOptions
```

If static options use old `extra_body` reasoning paths, Bootstraps first remove recognized old reasoning fields, then merge canonical tier options; other custom fields continue to be retained.

At Adapter runners, static options on Provider Registries and `ModelTextRequest.providerOptions` are merged once more. This layer is the top-level merge, with same-name top namespaces of request objects taking priority. Normal main chains have already been fully synthesized by Bootstraps before entering here, but peripheral paths directly calling ModelPorts may still depend on this behavior.

## All Current Main Parameter Dialects

There is no finite-enumerated "reasoning state machine" here. Current local Catalogs only have five patch paths; after CLI default policies and SDK namespace conversions, they form the seven main field shapes in the table below, allowing effort and thinking combinations.

| Runtime Interface           | Intermediate canonical field         | Typical final request fields |
| --------------------------- | ------------------------------------ | ---------------------------- |
| OpenAI Responses            | `openai.reasoningEffort`             | `reasoning.effort`           |
| OpenAI-compatible effort    | `openaiCompatible.reasoningEffort`   | `reasoning_effort`           |
| Qwen compatible             | `openaiCompatible.enable_thinking`   | `enable_thinking`            |
| Kimi/MiMo compatible toggle | `openaiCompatible.thinking.type`     | `thinking.type`              |
| Anthropic effort            | `anthropic.effort`                   | `output_config.effort`       |
| Anthropic fixed thinking    | `anthropic.thinking.budgetTokens`    | `thinking.budget_tokens`     |
| Anthropic adaptive thinking | `anthropic.thinking.type = adaptive` | `thinking.type = adaptive`   |

Grouped by final interfaces below. Each section provides logical tiers, intermediate `providerOptions`, and final request bodies.

### OpenAI Responses: `reasoning.effort`

OpenAI Providers currently use AI SDK Responses models. Logical tiers are typically:

```text
low / medium / high / xhigh
```

Intermediate values formed by dynamic App Providers:

```ts
{
  openai: {
    reasoningEffort: "high";
  }
}
```

Standalone default policies sometimes still produce top-level canonical fields:

```ts
{
  reasoningEffort: "high";
}
```

`runner-options.ts` wraps top-level fields into `openai` namespaces. The final OpenAI Responses requests are:

```json
{
  "reasoning": {
    "effort": "high"
  }
}
```

When disabling reasoning, models supporting `none` receive:

```ts
{
  openai: {
    reasoningEffort: "none";
  }
}
```

Final requests:

```json
{
  "reasoning": {
    "effort": "none"
  }
}
```

AI SDK only generates `reasoning` objects for reasoning models it recognizes. Whether a specific model accepts a particular level is still determined by the OpenAI API; for example, not all GPT models support `none` and `xhigh`.

### OpenAI-compatible effort: `reasoning_effort`

Kimi K3, GLM 5.2, GPTs called through compatible interfaces, and some DeepSeek models follow this path.

Intermediate values:

```ts
{
  openaiCompatible: {
    reasoningEffort: "max";
  }
}
```

Adapters copy `openaiCompatible` contents to the dynamic Provider namespace actually used by AI SDK. AI SDK then converts camelCase to snake_case:

```json
{
  "reasoning_effort": "max"
}
```

GLM 5.2's `nothink` maps to:

```ts
{
  openaiCompatible: {
    reasoningEffort: "none";
  }
}
```

Ultimately:

```json
{
  "reasoning_effort": "none"
}
```

Kimi K3's complete tier mapping under compatible interfaces:

```text
low  -> reasoning_effort: "low"
high -> reasoning_effort: "high"
max  -> reasoning_effort: "max"
```

### Qwen Switches: `enable_thinking`

Qwen's OpenAI-compatible interfaces use boolean fields:

```ts
// enabled
{
  openaiCompatible: {
    enable_thinking: true;
  }
}

// disabled / off
{
  openaiCompatible: {
    enable_thinking: false;
  }
}
```

AI SDK transparently passes unrecognized compatible fields, so final requests are:

```json
{ "enable_thinking": true }
```

```json
{ "enable_thinking": false }
```

Current Qwen recognition depends on providerId starting with `qwen-alibaba-model-studio`, or modelId starting with `qwen`.

### Kimi K2, MiMo, and General Compatible Switches: `thinking.type`

Another batch of OpenAI-compatible services uses object switches:

```ts
// enabled
{
  openaiCompatible: {
    thinking: {
      type: "enabled";
    }
  }
}

// disabled / off
{
  openaiCompatible: {
    thinking: {
      type: "disabled";
    }
  }
}
```

Final requests maintain the same shape:

```json
{ "thinking": { "type": "enabled" } }
```

```json
{ "thinking": { "type": "disabled" } }
```

Current default rules also sort some unspecified GLM, DeepSeek, and unknown OpenAI-compatible models into this dialect.

### DeepSeek V4: Effort and Thinking Appearing Simultaneously

DeepSeek V4's `high/max` simultaneously carry depth and enabled state:

```ts
// high
{
  openaiCompatible: {
    reasoningEffort: "high",
    thinking: { type: "enabled" }
  }
}
```

Final requests:

```json
{
  "reasoning_effort": "high",
  "thinking": { "type": "enabled" }
}
```

Current local Catalogs also declare `off`:

```ts
{
  openaiCompatible: {
    thinking: {
      type: "disabled";
    }
  }
}
```

Catalog patches simultaneously unset `reasoningEffort`. Dynamic overlays receiving inbound `off` also generate disabled thinking. Static default policies only list `high/max`, so the coverage of selectable tiers for DeepSeek V4 from different sources is not fully consistent.

### Anthropic effort: `output_config.effort`

When calling Kimi K3, GPT, and other models requiring only depth tiers through Anthropic Messages, the intermediate value is:

```ts
{
  anthropic: {
    effort: "xhigh";
  }
}
```

Anthropic SDKs ultimately generate:

```json
{
  "output_config": {
    "effort": "xhigh"
  }
}
```

Kimi K3's `low/high/max` also follows this form, without carrying `thinking`.

### Anthropic fixed thinking: effort + budget

Current Claude default strategies convert tiers to fixed budgets:

```text
low    -> 4,000 tokens
medium -> 8,000 tokens
high   -> 16,000 tokens
xhigh  -> 32,000 tokens
```

For example, `high`:

```ts
{
  anthropic: {
    effort: "high",
    thinking: {
      type: "enabled",
      budgetTokens: 16000
    }
  }
}
```

Final requests:

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 16000
  },
  "output_config": {
    "effort": "high"
  }
}
```

Fixed thinking budgets also affect output budgets. Adapters first ensure reasoning budgets fall within the current `maxOutputTokens`, then hand to Anthropic SDKs; the final online `max_tokens` maintain the total output budget for this request, not additionally and infinitely increase thinking tokens on top of it.

### Anthropic adaptive thinking

Opus 4.7 currently uses adaptive thinking and supports `max`:

```ts
{
  anthropic: {
    effort: "max",
    thinking: {
      type: "adaptive"
    }
  }
}
```

Final requests:

```json
{
  "thinking": {
    "type": "adaptive"
  },
  "output_config": {
    "effort": "max"
  }
}
```

### Anthropic Switches

When calling models providing only switches through Anthropic Messages, enabled status typically uses a 1,024-token compatible budget:

```ts
{
  anthropic: {
    thinking: {
      type: "enabled",
      budgetTokens: 1024
    }
  }
}
```

Final requests:

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 1024
  }
}
```

Disabled state intermediates are:

```ts
{
  anthropic: {
    thinking: {
      type: "disabled";
    }
  }
}
```

Current AI SDKs omit `thinking` in final requests without generating `output_config`. They do not send `{ "thinking": { "type": "disabled" } }`. Repository wire tests have explicitly locked this behavior.

### GLM / DeepSeek Through Anthropic Messages

GLM 5.2's `high/max` simultaneously carry effort and fixed budgets:

```ts
// max
{
  anthropic: {
    effort: "max",
    thinking: {
      type: "enabled",
      budgetTokens: 32000
    }
  }
}
```

Final requests are the same as Claude fixed thinking:

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 32000
  },
  "output_config": {
    "effort": "max"
  }
}
```

`nothink` produces `thinking: disabled` intermediates, ultimately omitting `thinking` and `output_config`.

DeepSeek V4 through Anthropic Messages uses respective efforts for `high/max`, with fixed `thinking.budgetTokens = 1024`.

## `extra_body` and Historical Compatibility

Early configs used excessive nesting to cram non-standard fields into OpenAI-compatible requests:

```ts
{
  openaiCompatible: {
    extra_body: {
      chat_template_kwargs: {
        reasoning_effort: "high",
        enable_thinking: true
      }
    }
  }
}
```

Current Bootstraps recognize the following old paths:

```text
openaiCompatible.extra_body.chat_template_kwargs.reasoning_effort
openaiCompatible.extra_body.chat_template_kwargs.enable_thinking
openaiCompatible.extra_body.thinking
openaiCompatible.extra_body.enable_thinking
openaiCompatible.thinking
```

If current Catalogs can match these fields to a level, Bootstraps remove old reasoning sub-paths, then merge canonical mappings. For example:

```text
extra_body.chat_template_kwargs.reasoning_effort = "high"
        |
        v
openaiCompatible.reasoningEffort = "high"
```

If models do not recognize them, raw `extra_body` is retained, avoiding breaking user custom parameters.

At Adapter boundaries, remaining `openaiCompatible.extra_body` is expanded once:

```ts
{
  openaiCompatible: {
    extra_body: {
      thinking: { type: "enabled" }
    },
    reasoningEffort: "max"
  }
}
```

Final requests:

```json
{
  "thinking": { "type": "enabled" },
  "reasoning_effort": "max"
}
```

New local Catalogs no longer save `extra_body` reasoning patches; current source catalog OpenAI-compatible patches all use direct canonical fields.

## How User Selections Enter Runtimes

### Apps and Protocols

The option's ID in the UI is `thought_level`. Model capabilities provide optional values; Composers, Drafts, Workspace defaults, Task meta, and Session snapshots save strings within their respective scopes.

When switching tiers, the current protocol calls `session/setThoughtLevel`. The CLI's `setThoughtLevel()` will:

```text
Read current modelRef
        |
        v
Validate level from Catalog
        |
        v
Look up providerOptionsByLevel[level]
        |
        v
Modify Runtimes simultaneously
├─ modelRef.variant = level
└─ modelProviderOptions = corresponding options
        |
        v
Persist Session model selection
```

Session persistent entries save:

```ts
{
  providerId: string,
  modelId: string,
  thoughtLevel?: string
}
```

Runtimes currently save "logical selection + expanded parameters" as two sets of facts. The root of extensive reverse inference appearing in system recovery and telemetry is here.

### TUI and Standalone CLIs

TUI's `/effort` and `/variant` commands first read the current model's `listThoughtLevels()`, then call the same `app.setThoughtLevel()`. They do not splice vendor parameters themselves.

Standalone CLIs also save a global recent reasoning level at Session SQLite's local setting:

```text
namespace = "model"
key       = "reasoningLevel"
scope     = "user"
scopeID   = "default"
value     = { level: "high" }
```

This global value participates in the preferred tier for new Runtimes or temporary Turn models. Sessions themselves still persist their own `thoughtLevel`.

Current one-time Prompt CLIs have no independent `--reasoning` / `--thought-level` parameters. When callers do not explicitly provide `modelProviderOptions` through Runtime configs, startup assemblies read the above global values; existing Session recovery chains also use the Session's own saved `thoughtLevel` to recover current selections.

### Automations, Bots, and Idle Tasks

Automations, Bots, and OffPeak Tasks can all carry `thoughtLevel` strings. Ordinary Automations/Bots ultimately apply tiers through parameters for creating or recovering Sessions, then still go through `setThoughtLevel()`.

Idle tasks also carry a complete `turnRuntimeModel`:

```ts
{
  model: { providerId, modelId },
  thoughtLevel,
  provider: {
    kind,
    baseURL,
    apiKey,
    models: [...]
  }
}
```

Hosts inject temporary Providers as turn overlays; CLIs then generate `TurnExecutionModels`, which already contain `modelRef` and `modelProviderOptions`. This object is currently closest to the future ModelBinding input structure.

There is a noteworthy difference to correct when migrating: `ZCodeModelRuntimeConfig.thoughtLevel` is passed in with idle tasks, but current `resolveTurnExecutionModel()` reads CLI global reasoning preferences when parsing parameters, without directly passing `runtimeModel.thoughtLevel` as a preferred level. Actual tiers for this round only match Host-specified values when both happen to be consistent, or model defaults are consistent.

## How Model Steps Use Parameters

Main Agent Loops select at each Model Step start:

```text
turnExecutionModel exists
├─ modelRef            <- turnExecutionModel.modelRef
├─ context / output    <- turnExecutionModel
└─ providerOptions     <- turnExecutionModel.modelProviderOptions

turnExecutionModel does not exist
├─ modelRef            <- Runtime defaultModelRef
├─ context / output    <- Runtime config
└─ providerOptions     <- Runtime config.modelProviderOptions
```

Subsequently, `ModelTextRequest` simultaneously carries:

```ts
{
  model: ModelRef,
  messages: [...],
  tools: [...],
  providerOptions: Record<string, unknown>
}
```

Adapter Registries then query Provider factories, endpoints, credentials, and SDK models using `model`. `runner-options.ts` merges Provider static options with request options, and executes final namespace conversions.

In this chain, model identity and reasoning parameters come from Runtime/Turn snapshots, Provider clients come from Adapter Registries, and capabilities come from Catalogs. The target `Model`'s responsibility is to consolidate all three into a single callable object.

## How Special Model Calls Handle Reasoning

### Automatic Compacts

Automatic Compacts currently default to inheriting the main Loop's `modelRef` and `providerOptions`. `ENABLE_COMPACT_SUMMARY_THINKING` is currently true, so summary requests continue using the main Loop's reasoning.

Code still retains disabled Compact reasoning branches. These branches delete efforts and change Anthropic/OpenAI-compatible thinking to disabled. They belong to historical switchable strategies; current default paths do not trigger them.

### Session Titles and Goal Summary Titles

Title tasks fixed-disable reasoning. Current implementations first inherit Runtime `providerOptions`, then modify objects based on models and dialects:

```text
Anthropic              -> thinking disabled, delete effort
OpenAI GPT supports none -> reasoningEffort = "none"
OpenAI-compatible      -> enable_thinking=false / thinking disabled / effort none
MiniMax M3             -> Supplement dedicated disable fields per apiFormat
```

This logic is located at `title-provider-options.ts`, which must simultaneously understand model names, Provider namespaces, and three API formats. If the target design retains "titles do not think," it should express `reasoningLevel = disabled` through generic Model Options; whether to `bind()` at task start or as a single Request override is determined by the task's lifecycle. Core no longer directly modifies vendor parameter objects.

### Git Commit Messages

Normal calls to `workspace/generateText` inherit current Provider options; Git Commit Messages reuse title task's no-thinking projections, therefore having the same dialect branches.

### Repo Wikis

Repo Wikis currently do not go through `ModelPort`, `workspace/generateText`, or the above `providerOptions` chains. They read providers, models, endpoints, API Keys, headers, and `apiFormat` from Provider Registries corresponding to workspaces, then directly construct three HTTP requests within `packages/services`:

```text
openai-chat-completions
└─ model / max_tokens / messages / temperature

openai-responses
└─ model / input / max_output_tokens

anthropic-messages
└─ model / max_tokens / messages / temperature
```

These requests do not carry reasoning levels, nor send `reasoning_effort`, `enable_thinking`, `thinking`, or `output_config`. Therefore Repo Wikis currently neither inherit session tiers nor have their own reasoning strategies. This is an independent model call chain that the Provider refactor must consolidate: future implementations should first create their own Selections/Bindings, then initiate requests through Bindings; whether to use default tiers or explicitly disable reasoning is determined by Repo Wiki's product semantics.

### Bots

Bots do not have another set of model request Adapters. Bot `/thoughtLevel` configs, draft status, and task parameter save logical levels; after creating or recovering ZCode Tasks, they still enter standard Session/Agent execution chains. Therefore Bot needs to unify Selections, Submissions, and Session recovery semantics, without needing new reasoning wire dialects.

### Project Memories

Project Memory Recall selectors use Lite models or main models, generating only 256-token structured outputs. Current code simply clears the `anthropic` namespace to prevent fixed thinking from consuming budgets:

```ts
{
  ...providerOptions,
  anthropic: {}
}
```

It does not make equivalent treatments for OpenAI and OpenAI-compatible, nor forms an explicit logical reasoning choice. This is a localized patch chain.

Project Memory Extractions and Dreams capture models and Provider options, then run their own small Agent Loops.

### Goal Completion Verification

Goal verifiers use current Runtime models and `modelProviderOptions`, with no independent reasoning strategies. Model refs are captured during retries, but Provider options are still read from Runtime configs.

### Subagents

Subagent profiles can simultaneously declare models and `thoughtLevel`. Current code only calls `resolveModelProviderOptions(modelRef, profile.thoughtLevel)` to parse parameters for Child Runtimes when profiles specify specific models.

```text
profiles specify specific models and thoughtLevel
└─ Parse providerOptions by child model + profile thoughtLevel

profiles use inherit / main
└─ Inherit parent Runtime's modelProviderOptions

idle turnExecutionModel exists
└─ Force Children to use entire TurnExecutionModel snapshots
```

This already reflects the correct product semantics: when Children change models or reasoning, they should form their own Bindings; when inheriting, they reuse parent selections. Current implementations still pass through `modelRef + providerOptions` separately.

## Reverse Inference and Telemetry

Current Runtimes often have only `providerOptions`, so the system also needs to reverse-answer "which tier is this?" `runtime-thought-level.ts` deep-matches current options with `providerOptionsByLevel` item by item:

```text
Runtime providerOptions
        |
        | Compare with each level's options
        v
Reverse to effective thought level
```

It also recognizes the following control types:

```text
fixed_level   reasoningEffort / reasoning_effort / effort
fixed_budget  budgetTokens / budget_tokens
adaptive      thinking.type = adaptive
toggle        enable_thinking / reasoning_enabled / thinking.type
```

Telemetry only checks the current Adapter's actually consumed namespaces, avoiding misjudgments when both `anthropic` and `openaiCompatible` exist in one object. The actual namespace for OpenAI-compatible is also determined by `providerOptionsName`.

This reverse inference serves Session recovery, UI current levels, Trace, and telemetry attribution. Future Bindings directly holding `ModelSelection.reasoningLevel` means normal execution chains can directly record logical selections; Adapters can still record final line-effective parameters for troubleshooting vendor behaviors, but no longer need to guess user selections from arbitrary objects.

## Where Current Issues Concentrate

### Capability Declarations and Serialization Rules Mixed Together

`ModelCapability.reasoning` both tells UIs "there is a high tier" and tells Adapters "what objects high should send." Renderer only needs the first half; Core should not understand the second half.

### Multiple Generation Points for the Same Rules

Currently, at least the following generation or correction points exist:

```text
App Catalog patch projections
Standalone CLI default-policies
Standalone CLI config normalizations
Dynamic workspace-model-catalogs
Bootstrap legacy migrations
Title / Git / Compact / Memory request patches
Adapter runner namespace normalizations
```

A new model dialect often needs specifics added in multiple places.

### OpenAI-compatible Dialect Recognition Depends on Names

Current use of kind, providerId, modelId, and levels for inference; URLs do not participate. Names can cover officially known models, but cannot reliably express private gateways, proxy services, or "same modelId, different compatible implementations."

### App and CLI Config Expressions Differ

Apps only save variants; Standalone CLIs can save complete `providerOptionsByLevel`. Builtin memory configs can again carry transport patches. Three sources require multiple supplements and conversions before entering the same Runtime.

### Runtimes Simultaneously Save Selections and Expanded Results

`modelRef.variant` is the logical selection, `modelProviderOptions` is the expanded result. Both may be separately updated by different entries, so code requires substantial synchronization, recovery, and reverse matching.

### Auxiliary Tasks Directly Modify Arbitrary Parameters

Titles, Git, Compacts, and Memories delete or write Provider fields based on their respective needs. Each call point must understand vendor differences; Adapter responsibilities leak into Core.

## Constraints on Model and ModelRequest Designs

Public Option semantics have been further clarified: `reasoningLevel` is the user-expected reasoning intensity, a soft constraint; `maxOutputTokens` is the total generation token limit shared by reasoning and final answers, a hard constraint. Models validate both separately, do not understand thinking budgets, and do not undertake Provider-specific combination validations.

The first phase maintains existing Adapter behaviors. Even if some new Anthropic model official recommendations have shifted to adaptive thinking, as long as current fixed-budget requests still work, this round does not change model recognition, tier mappings, and wire requests. Existing fixed thinking continues to use `min(levelBudget, maxOutputTokens - 1)` to guarantee total budgets. Future Adapter topics then evaluate native effort/adaptive migrations and adjust dialects still needing fixed budgets to `min(levelDefaultBudget, floor(maxOutputTokens * 3 / 4))`, reserving stable space for final answers.

This investigation supports the following target chain:

```text
Model
├─ reasoning levels / defaults in Option Specs
├─ Current Model Options
└─ Adapter internal reasoning dialect implementations
                |
                | bind({ reasoningLevel })
                |
                v
Derived Models
├─ options.reasoningLevel
├─ properties / optionSpecs
├─ generateText()
└─ streamText()
                |
                v
Adapter private serialization
```

Target boundaries need to satisfy:

- UIs, Sessions, Submissions, Automations, and Subagents save logical levels, not vendor parameters.
- Derived Models fix providers, models, and reasoning levels; continuous executions no longer re-read mutable Runtime options.
- Adapter paths own reasoning dialects. OpenAI-compatible differences must no longer leak to Core.
- `providerOptionsByLevel` is read by a compatible boundary during the migration period, then encapsulated into Models/Adapters, no longer exposed to ModelRequests.
- Tasks that genuinely change reasoning, like Titles and Git, use `bind()` or Request Options to express generic tiers, no longer modifying vendor parameter objects.
- Compacts reuse current Models when only changing messages and budgets.
- Usage, Trace, and message histories record provider/model/reasoning from models actually initiating requests.
- Final-line Headers, token refreshes, routing, retries, and field serialization continue to stay within Adapters internally.

Whether "more granular Adapter types" or "one Adapter with strengthened type reasoning strategy" is adopted still needs ruling in subsequent Adapter designs. Regardless of what fields are ultimately named, they must become explicit facts in the Provider/Adapter path, capable of distinguishing the same modelId connected to different compatible services.

## Tests to Lock Before Implementation

Migrations cannot verify only intermediate `providerOptions`. At minimum, three layers of tests must be retained:

```text
Config/Definition tests
└─ Correct tiers, defaults, and dialect declarations

Model tests
└─ Options validated and fixed, Core does not see any providerOptions

Wire tests
└─ Capture real SDK request bodies, verify final fields
```

Existing wire tests already cover OpenAI Responses `none`, Anthropic effort, Anthropic thinking budgets, OpenAI-compatible `reasoning_effort`, `enable_thinking`, `thinking.type`, and legacy `extra_body` expansions. These should serve as behavior baselines during migrations.

## Main Code Evidence

- Capability types: `apps/zcode-cli/packages/contracts/src/model/catalog.ts`
- App provider/config types: `packages/shared/src/model-provider-types.ts`
- App config read/write: `packages/services/src/model-provider/modelProviderServiceStorage.ts`
- App-to-protocol reasoning patch projection: `packages/shared/src/zcode-protocol/index.ts`
- Dynamic App Provider mapping: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`
- CLI static default rules: `apps/zcode-cli/packages/adapters/src/model/default-policy.ts`
- Various built-in mappings: `apps/zcode-cli/packages/adapters/src/model/reasoning-policy.ts`
- Standalone CLI config normalization: `apps/zcode-cli/packages/adapters/src/config/schema.ts`
- Level parsing and telemetry reverse inference: `apps/zcode-cli/packages/adapters/src/model/runtime-thought-level.ts`
- Runtime options merging and old config migration: `apps/zcode-cli/packages/bootstrap/src/runtime-model-metadata.ts`
- Session tier switching: `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts`
- Model Step usage points: `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`
- Adapter final normalization: `apps/zcode-cli/packages/adapters/src/model/runner-options.ts`
- OpenAI-compatible wire tests: `apps/zcode-cli/packages/adapters/tests/openai-compatible-extra-body-wire.test.ts`
- Anthropic wire tests: `apps/zcode-cli/packages/adapters/tests/anthropic-effort-wire.test.ts`
- Disabled wire tests: `apps/zcode-cli/packages/adapters/tests/reasoning-disabled-wire.test.ts`
- Special call strategies: `apps/zcode-cli/packages/core/src/runtime/methods/title-provider-options.ts`, `compact-active.ts`, `workspace-generate-text.ts`, and `project-memory-recall.ts`
- Repo Wiki direct connection requests: `packages/services/src/repo-wiki/repoWikiModelClient.ts` and `repoWikiProviderRegistryModelConfig.ts`
- Bot tier selections and task dispatching: `packages/services/src/bots/botsService.ts`
