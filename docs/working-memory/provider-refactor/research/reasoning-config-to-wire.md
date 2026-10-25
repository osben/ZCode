# Reasoning: From Model Config to Final Request

> Status: Current status investigation complete, target boundaries formed; specific migration plan not yet implemented
> Date: 2026-08-10
> Corresponding stage design: [`../steps/01-model-and-request.md`](../steps/01-model-and-request.md)
>
> Terminology note: This investigation uses `ModelBinding` for the model object held by continuous execution; the current design has converged to a callable `Model` expressed as immutable derivation via `model.bind(options)`. The old terminology here only reconstructs the code chain at that time.

## Conclusion

Reasoning can stay simple at the product layer: models declare supported tiers, users select one tier, a continuous execution fixes this selection, and Adapters write it as request fields accepted by the target interface.

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

The current implementation has not formed this boundary: it converts logical tiers into an arbitrarily-structured `providerOptions` passed from Catalogs, Bootstrap, and Runtime all the way to Adapters, with conversion logic distributed across App config projections, CLI Catalog default policies, dynamic Provider overlays, historical compatibilities, and auxiliary model tasks. The repository Catalog saves explicit parameter mappings, the App strips mappings keeping only tiers, and the CLI reconstructs parameters through dynamic `first-match-wins` rules and Standalone CLI `last-match-wins` default policies, while Titles, Git, Compacts, and Memories further modify results before calls.

M1 retains only generic `reasoningLevel` in public boundaries: Selections save user selections, `Model.bind(options)` fixes continuous execution tiers, and Requests can override within the scope validated by Option Specs. Existing `providerOptionsByLevel` parsing concentrates into compatible assembly and Adapter paths, no longer exposed to business callers. Unified Catalogs, deleted name inference, unified priority, and re-done Adapter dialects are subsequent independent migrations; this document stays the baseline for the topic's current behavior.

Name glossary:

- `thoughtLevel`, `reasoningLevel`, and `ModelRef.variant` express the user-selected logical tier (e.g. `high`).
- `providerOptionsByLevel` is a "tier-to-vendor-parameters" lookup table; not sent as-is to model interfaces.
- `providerOptions` is an intermediate object for a run, containing reasoning, transport, output budgets, and other Provider parameters mixed in.
- `reasoning_effort`, `enable_thinking`, `thinking`, `output_config.effort` are the actual HTTP request fields.

These final fields are not unified under one OpenAI-compatible protocol. Current code selects dialects by explicit mappings, `provider.kind`, `providerId`, `modelId`, and tier lists; base URLs do not participate. Two Providers of the same kind and modelId but different URLs produce identical parameters without explicit mappings — a clear limitation of the current implementation.

### `apiFormat`, `defaultKind`, and `kind`

The settings page exposes `apiFormat` (`anthropic-messages` / `openai-chat-completions` / `openai-responses`) and, when saving Provider Configs, also writes the derived `defaultKind`. Hosts generating runtime Registries parse the final `apiFormat` first, then derive the CLI's `kind`:

```text
apiFormat                    defaultKind / kind
anthropic-messages        <-> anthropic
openai-responses          <-> openai
openai-chat-completions   <-> openai-compatible
```

Built-in Providers entering `ModelProviderConfig` typically populate both; hardcoded Start Plans write the pair directly; remote builtin schemas provide `primaryKind` first, deriving `apiFormat` at load.

Under the three protocols these fields carry no independent information; the runtime protocol allows both `kind` and `apiFormat` without excluding inconsistent combinations by type. Proposed evolution: `apiFormat` becomes the single source of truth in configs and protocols; Adapter factories keep internal implementation enums that no longer enter Provider Configs or cross-process protocols. Before implementing, verify Standalone CLI `provider.kind` migration and how to explicitly select the protocol when a Provider has multiple endpoints.

## A Complete Chain

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

`ModelCapability.reasoning` both describes user-selectable capability and stores vendor parameter mappings:

```ts
interface ModelReasoningCapability {
  enabled: boolean;
  levels: string[];
  defaultLevel?: string;
  providerOptionsByLevel?: Record<string, Record<string, unknown>>;
}
```

For example `levels: ["low","high"], defaultLevel: "high", providerOptionsByLevel: { low: { openaiCompatible: { reasoningEffort: "low" } }, high: { openaiCompatible: { reasoningEffort: "high" } } }`. After the user selects `high`, the Runtime receives `{ openaiCompatible: { reasoningEffort: "high" } }`, and OpenAI-compatible Adapters finally send `{"reasoning_effort": "high"}`.

## Where Configs Come From

### App's Persistent Configs

The App's authoritative file is `~/.zcode/v2/config.json`. Persisted reasoning describes tiers only, not vendor request parameters:

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

This converts to internal `ModelReasoningSpec` with name-only levels (`{ defaultLevel: "max", levels: { high: {}, max: {} } }`). The App clears old `model.variants`, `reasoningSpec`, and `zcode.reasoning` parameter mappings when saving: configs saved through the settings page cannot dictate whether `high` uses `reasoning_effort` or `enable_thinking`; zcode-cli supplements mappings at runtime. Conversions live in `modelProviderServiceStorage.ts` (`openCodeReasoningToModelReasoning()` / `modelReasoningToOpenCodeReasoning()`).

### Standalone CLI Configs

Standalone CLIs read `~/.zcode/cli/config.json`, accept structures closer to Runtimes, and can explicitly save `providerOptionsByLevel`:

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

Because the kind is `openai-compatible`, CLI schemas wrap un-namespaced parameters as `{ enabled: { openaiCompatible: { enable_thinking: true } }, ... }`; configs already carrying `anthropic` / `openai` / `openaiCompatible` namespaces remain as-is. App configs and Standalone CLI configs are therefore asymmetric: Apps save only tiers; CLIs can save tiers and sending parameters.

### Model Catalogs and Built-in Providers

Historical Model Catalogs and remote builtin configs describe per-transport parameters with patches:

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

When Apps project the current transport to zcode-cli, they extract only patches of the corresponding kind (`{ high: { openaiCompatible: { reasoningEffort: "high" } } }` for `openai-compatible`). Ordinary App persistent configs clear these patches, but built-in Coding Plans, Start Plans, and remote client configs can carry complete `ModelProviderReasoningSpec` in memory through the same projection function.

Plan login status, entitlement judgments, runtime API Keys, and one-time security verification Headers do not participate in reasoning dialect selection; they form callable Providers first, and reasoning still depends on the Provider's `kind` and model definitions. Current ZCode built-in Plans primarily project as Anthropic runtime, so GLM and others follow `anthropic.effort` / `anthropic.thinking` paths. Refreshing Tokens or Headers before requests changes only authentication materials, not the selected reasoning level.

Only five reasoning patch paths actually appear in local Catalogs:

```text
anthropic
├─ output_config.effort
└─ thinking

openai-compatible
├─ reasoningEffort
├─ enable_thinking
└─ thinking.type
```

The Catalog patch structure is config-layer expression; SDK acceptance still goes through zcode-cli model specifics and Adapter normalization — e.g., Kimi K3 regenerates `anthropic.effort` in CLI overlays rather than passing the Catalog's `anthropic.output_config.effort` directly.

## How zcode-cli Forms `providerOptionsByLevel`

### Dynamic App Providers

After Apps deliver Providers through the protocol, `workspace-model-catalog.ts` creates runtime capabilities per model:

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

Without inbound reasoning, CLIs supplement defaults by model names and Provider kinds, judging on `provider.kind`, `provider.providerId`, `model.modelId`, `model.reasoning.levels`, `model.reasoning.providerOptionsByLevel` — base URLs are not in the set. Current hardcoded recognitions:

- `gpt` models select OpenAI, OpenAI-compatible, or Anthropic parameters by `provider.kind`;
- `qwen` judges by providerId prefix or modelId, using `enable_thinking`;
- `glm` judges by model names and tiers whether switches or depth tiers;
- `deepseek-v4` simultaneously uses `thinking.type` and `reasoningEffort`;
- Kimi, MiMo, and others use `thinking.type` switches by providerId/modelId families;
- Kimi K3 forces `low/high/max` usage and uses efforts by transport.

The same-named model on two different URLs with the same kind and rules produces identical mappings; expressing different dialects today requires upstream explicitly carrying different reasoning patches or new code specifics.

### Standalone CLI Default Policies

Static Catalogs use default rules in `default-policy.ts` / `reasoning-policy.ts`:

```text
Kimi K3                 -> low / high / max
DeepSeek V4             -> high / max
GLM 5.2                 -> max / high / nothink
Other GLM / DeepSeek    -> enabled / disabled
Claude                   -> low / medium / high / xhigh
Claude Opus 4.7          -> low / medium / high / xhigh / max
GPT                      -> low / medium / high / xhigh
```

Again selected by `providerId` and `modelId`. For unspecified-reasoning custom `openai-compatible` models, config parsing also supplements a general `thinking.type = enabled/disabled` switch — broad coverage, not guaranteed suitable for all OpenAI-compatible services.

### How Tier Names Are Normalized

Selections match exactly, then case-insensitively; without explicit selection, valid `defaultLevels` apply, else `levels[0]`. Two model-specific alias sets exist:

```text
DeepSeek V4
├─ low / medium -> high
└─ xhigh         -> max

thinking toggle
├─ enabled       -> enabled
└─ disabled/off  -> disabled
```

App UIs translate `off`, `disabled`, `none`, `nothink` for display, but display aliases do not change Provider parameters; real execution normalization stays in Catalog/Bootstrap rules.

### How Static Options and Tier Options Merge

Model targets can carry a static `providerOptions` (API format, structured-output options, user custom fields). Bootstrap deep-merges the selected tier's options over them, tier options winning same-path values:

```text
target.providerOptions
        +
providerOptionsByLevel[selectedLevel]
        |
        | recursive merge, selected level takes priority
        v
Runtime.modelProviderOptions
```

If static options use old `extra_body` reasoning paths, Bootstrap first removes recognized old reasoning fields, then merges canonical tier options; other custom fields are retained. At Adapter runners, static options on Provider Registries and `ModelTextRequest.providerOptions` merge once more — the top-level merge, request objects winning same-name top namespaces. Normal main chains are fully synthesized by Bootstrap before this, but peripheral paths directly calling ModelPorts may still depend on it.

## All Current Main Parameter Dialects

There is no finite "reasoning state machine": five Catalog patch paths plus CLI default policies and SDK namespace conversions form seven main field shapes, allowing effort + thinking combinations.

| Runtime Interface           | Intermediate canonical field         | Typical final request fields |
| --------------------------- | ------------------------------------ | ---------------------------- |
| OpenAI Responses            | `openai.reasoningEffort`             | `reasoning.effort`           |
| OpenAI-compatible effort    | `openaiCompatible.reasoningEffort`   | `reasoning_effort`           |
| Qwen compatible             | `openaiCompatible.enable_thinking`   | `enable_thinking`            |
| Kimi/MiMo compatible toggle | `openaiCompatible.thinking.type`     | `thinking.type`              |
| Anthropic effort            | `anthropic.effort`                   | `output_config.effort`       |
| Anthropic fixed thinking    | `anthropic.thinking.budgetTokens`    | `thinking.budget_tokens`     |
| Anthropic adaptive thinking | `anthropic.thinking.type = adaptive` | `thinking.type = adaptive`   |

### OpenAI Responses: `reasoning.effort`

OpenAI Providers use AI SDK Responses models; logical tiers are typically `low / medium / high / xhigh`. Dynamic App Providers form `{ openai: { reasoningEffort: "high" } }`; standalone default policies sometimes produce top-level `{ reasoningEffort: "high" }`, which `runner-options.ts` wraps into the `openai` namespace. Final requests: `{"reasoning": {"effort": "high"}}`. Disabling reasoning on models supporting `none` sends `reasoningEffort: "none"` → `{"reasoning": {"effort": "none"}}`.

AI SDK generates `reasoning` objects only for reasoning models it recognizes; whether a specific model accepts a level is determined by the OpenAI API — not all GPT models support `none` and `xhigh`.

### OpenAI-compatible effort: `reasoning_effort`

Kimi K3, GLM 5.2, GPTs called through compatible interfaces, and some DeepSeek models. Intermediate `{ openaiCompatible: { reasoningEffort: "max" } }`; Adapters copy the contents to the dynamic Provider namespace and AI SDK converts camelCase to snake_case: `{"reasoning_effort": "max"}`. GLM 5.2's `nothink` maps to `reasoningEffort: "none"` → `{"reasoning_effort": "none"}`. Kimi K3's complete mapping: `low/high/max -> reasoning_effort: "low"/"high"/"max"`.

### Qwen Switches: `enable_thinking`

Qwen's OpenAI-compatible interfaces use booleans: enabled → `{ openaiCompatible: { enable_thinking: true } }`, disabled/off → `enable_thinking: false`; AI SDK transparently passes unrecognized compatible fields, so final requests are `{"enable_thinking": true}` / `{"enable_thinking": false}`. Recognition depends on providerId starting with `qwen-alibaba-model-studio` or modelId starting with `qwen`.

### Kimi K2, MiMo, and General Compatible Switches: `thinking.type`

Another batch uses object switches: enabled → `{ openaiCompatible: { thinking: { type: "enabled" } } }`, disabled → `type: "disabled"`; final requests keep the shape: `{"thinking": {"type": "enabled"}}`. Default rules also sort some unspecified GLM, DeepSeek, and unknown OpenAI-compatible models into this dialect.

### DeepSeek V4: Effort and Thinking Appearing Simultaneously

`high/max` carry depth and enabled state simultaneously: `{ openaiCompatible: { reasoningEffort: "high", thinking: { type: "enabled" } } }` → `{"reasoning_effort": "high", "thinking": {"type": "enabled"}}`. Local Catalogs also declare `off` as `{ thinking: { type: "disabled" } }` and unset `reasoningEffort`; dynamic overlays receiving inbound `off` also generate disabled thinking. Static default policies list only `high/max`, so selectable-tier coverage for DeepSeek V4 differs by source.

### Anthropic effort: `output_config.effort`

Kimi K3, GPT, and other depth-only models through Anthropic Messages: intermediate `{ anthropic: { effort: "xhigh" } }`, final `{"output_config": {"effort": "xhigh"}}`. Kimi K3's `low/high/max` follows this form without `thinking`.

### Anthropic fixed thinking: effort + budget

Claude default strategies convert tiers to fixed budgets:

```text
low    -> 4,000 tokens
medium -> 8,000 tokens
high   -> 16,000 tokens
xhigh  -> 32,000 tokens
```

`high` → `{ anthropic: { effort: "high", thinking: { type: "enabled", budgetTokens: 16000 } } }` → `{"thinking": {"type": "enabled", "budget_tokens": 16000}, "output_config": {"effort": "high"}}`. Fixed budgets also affect output budgets: Adapters first ensure reasoning budgets fall within the current `maxOutputTokens`; the final `max_tokens` keeps the total output budget, not infinitely increasing thinking tokens on top.

### Anthropic adaptive thinking

Opus 4.7 uses adaptive thinking and supports `max`: `{ anthropic: { effort: "max", thinking: { type: "adaptive" } } }` → `{"thinking": {"type": "adaptive"}, "output_config": {"effort": "max"}}`.

### Anthropic Switches

Models providing only switches through Anthropic Messages: enabled uses the 1,024-token compatible budget `{ anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } }` → `{"thinking": {"type": "enabled", "budget_tokens": 1024}}`. Disabled intermediates are `{ thinking: { type: "disabled" } }`; current AI SDKs omit `thinking` in final requests without generating `output_config` — they do not send `{"thinking": {"type": "disabled"}}`. Repository wire tests have locked this behavior.

### GLM / DeepSeek Through Anthropic Messages

GLM 5.2's `high/max` carry effort and fixed budgets: `max` → `{ anthropic: { effort: "max", thinking: { type: "enabled", budgetTokens: 32000 } } }`, final same shape as Claude fixed thinking. `nothink` produces `thinking: disabled` intermediates, ultimately omitting both `thinking` and `output_config`. DeepSeek V4 through Anthropic Messages uses respective efforts for `high/max` with fixed `thinking.budgetTokens = 1024`.

## `extra_body` and Historical Compatibility

Early configs crammed non-standard fields into OpenAI-compatible requests:

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

Bootstrap recognizes these old paths:

```text
openaiCompatible.extra_body.chat_template_kwargs.reasoning_effort
openaiCompatible.extra_body.chat_template_kwargs.enable_thinking
openaiCompatible.extra_body.thinking
openaiCompatible.extra_body.enable_thinking
openaiCompatible.thinking
```

If current Catalogs can match these fields to a level, Bootstrap removes the old reasoning sub-paths, then merges canonical mappings (e.g. `extra_body.chat_template_kwargs.reasoning_effort = "high"` → `openaiCompatible.reasoningEffort = "high"`). Unrecognized `extra_body` is retained raw to preserve user custom parameters. At Adapter boundaries, remaining `openaiCompatible.extra_body` is expanded once — e.g. `{ openaiCompatible: { extra_body: { thinking: { type: "enabled" } }, reasoningEffort: "max" } }` sends `{"thinking": {"type": "enabled"}, "reasoning_effort": "max"}`. New local Catalogs no longer save `extra_body` reasoning patches; current source catalog OpenAI-compatible patches all use direct canonical fields.

## How User Selections Enter Runtimes

### Apps and Protocols

The option's UI ID is `thought_level`. Model capabilities provide values; Composers, Drafts, Workspace defaults, Task meta, and Session snapshots save strings within their scopes. Switching tiers calls `session/setThoughtLevel`; the CLI's `setThoughtLevel()`:

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

Session persistence saves `{ providerId, modelId, thoughtLevel? }`. Runtimes store "logical selection + expanded parameters" as two fact sets — the root of extensive reverse inference in recovery and telemetry.

### TUI and Standalone CLIs

TUI's `/effort` and `/variant` read `listThoughtLevels()` then call the same `app.setThoughtLevel()`; they never splice vendor parameters. Standalone CLIs also save a global recent reasoning level in Session SQLite local settings:

```text
namespace = "model"
key       = "reasoningLevel"
scope     = "user"
scopeID   = "default"
value     = { level: "high" }
```

This global value participates in the preferred tier for new Runtimes or temporary Turn models; Sessions still persist their own `thoughtLevel`. One-time Prompt CLIs have no independent `--reasoning` / `--thought-level` parameters; when callers do not provide `modelProviderOptions` via Runtime configs, startup assemblies read the global value, and Session recovery uses the Session's own `thoughtLevel`.

### Automations, Bots, and Idle Tasks

Automations, Bots, and OffPeak Tasks can carry `thoughtLevel` strings; ordinary Automations/Bots apply tiers through parameters for creating or recovering Sessions, still via `setThoughtLevel()`.

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

Hosts inject temporary Providers as turn overlays; CLIs generate `TurnExecutionModels` already containing `modelRef` and `modelProviderOptions` — currently closest to the future ModelBinding input. Migration difference to correct: `ZCodeModelRuntimeConfig.thoughtLevel` is passed in with idle tasks, but `resolveTurnExecutionModel()` reads CLI global reasoning preferences instead of preferring `runtimeModel.thoughtLevel`; actual tiers match the Host-specified value only when both happen to be consistent or model defaults align.

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

`ModelTextRequest` then carries `{ model: ModelRef, messages, tools, providerOptions }`. Adapter Registries query Provider factories, endpoints, credentials, and SDK models using `model`; `runner-options.ts` merges Provider static options with request options and performs final namespace conversion. Model identity and reasoning parameters come from Runtime/Turn snapshots, Provider clients from Adapter Registries, capabilities from Catalogs; the target `Model` consolidates all three into one callable object.

## How Special Model Calls Handle Reasoning

### Automatic Compacts

Compacts default to inheriting the main Loop's `modelRef` and `providerOptions`. `ENABLE_COMPACT_SUMMARY_THINKING` is true, so summary requests keep the main Loop's reasoning. Disabled Compact reasoning branches remain in code (delete efforts, switch thinking to disabled) as historical switchable strategies not triggered by default.

### Session Titles and Goal Summary Titles

Title tasks fixed-disable reasoning: inherit Runtime `providerOptions`, then modify per model and dialect:

```text
Anthropic              -> thinking disabled, delete effort
OpenAI GPT supports none -> reasoningEffort = "none"
OpenAI-compatible      -> enable_thinking=false / thinking disabled / effort none
MiniMax M3             -> Supplement dedicated disable fields per apiFormat
```

Logic at `title-provider-options.ts`, which must understand model names, Provider namespaces, and three API formats simultaneously. If "titles do not think" is retained, the target expresses `reasoningLevel = disabled` through generic Model Options — whether `bind()` at task start or a single Request override follows the task lifecycle; Core stops directly modifying vendor parameter objects.

### Git Commit Messages

`workspace/generateText` calls inherit current Provider options; Git Commit Messages reuse the title task's no-thinking projections, sharing the same dialect branches.

### Repo Wikis

Repo Wikis bypass `ModelPort`, `workspace/generateText`, and the `providerOptions` chains: they read providers, models, endpoints, API Keys, headers, and `apiFormat` from workspace Provider Registries and construct three HTTP request shapes directly in `packages/services`:

```text
openai-chat-completions
└─ model / max_tokens / messages / temperature

openai-responses
└─ model / input / max_output_tokens

anthropic-messages
└─ model / max_tokens / messages / temperature
```

They carry no reasoning levels and send none of `reasoning_effort`, `enable_thinking`, `thinking`, `output_config` — neither inheriting session tiers nor having their own reasoning strategy. This independent model call chain must be consolidated by the Provider refactor: future implementations create their own Selections/Bindings and request through Bindings; default tiers or explicit disable follows Repo Wiki's product semantics.

### Bots

Bots have no separate model request Adapters. `/thoughtLevel` configs, draft status, and task parameters save logical levels; after creating or recovering ZCode Tasks they enter standard Session/Agent chains. Bots unify Selections, Submissions, and Session recovery semantics without new reasoning wire dialects.

### Project Memories

Memory Recall selectors use Lite or main models, generating only 256-token structured outputs. Current code clears the `anthropic` namespace to prevent fixed thinking from consuming budgets:

```ts
{
  ...providerOptions,
  anthropic: {}
}
```

No equivalent treatment for OpenAI / OpenAI-compatible and no explicit logical reasoning choice — a localized patch chain. Extractions and Dreams capture models and Provider options, then run their own small Agent Loops.

### Goal Completion Verification

Goal verifiers use current Runtime models and `modelProviderOptions` with no independent reasoning strategy. Model refs are captured during retries, but Provider options are still read from Runtime configs.

### Subagents

Subagent profiles can declare models and `thoughtLevel`. Current code calls `resolveModelProviderOptions(modelRef, profile.thoughtLevel)` for Child Runtimes only when profiles specify specific models; `inherit` / `main` profiles inherit the parent Runtime's `modelProviderOptions`; an idle `turnExecutionModel` forces Children to use the entire snapshot.

This already reflects the correct product semantics — Children changing models or reasoning form their own Bindings; inheriting reuses parent selections — but the implementation still passes `modelRef + providerOptions` separately.

## Reverse Inference and Telemetry

Runtimes often hold only `providerOptions`, so the system reverse-answers "which tier is this?" `runtime-thought-level.ts` deep-matches current options against `providerOptionsByLevel` per level. It recognizes control types:

```text
fixed_level   reasoningEffort / reasoning_effort / effort
fixed_budget  budgetTokens / budget_tokens
adaptive      thinking.type = adaptive
toggle        enable_thinking / reasoning_enabled / thinking.type
```

Telemetry checks only the current Adapter's actually consumed namespaces, avoiding misjudgment when both `anthropic` and `openaiCompatible` exist in one object; the actual OpenAI-compatible namespace is determined by `providerOptionsName`. This inference serves Session recovery, UI current levels, Trace, and telemetry attribution. Future Bindings directly holding `ModelSelection.reasoningLevel` let normal chains record logical selections directly; Adapters can still record final effective wire parameters for vendor troubleshooting but no longer guess user selections from arbitrary objects.

## Where Current Issues Concentrate

- **Capability declarations and serialization rules mixed**: `ModelCapability.reasoning` tells UIs "there is a high tier" and Adapters "what high sends." The Renderer needs only the first half; Core must not understand the second.
- **Multiple generation points for the same rules**: App Catalog patch projections; standalone default policies; standalone config normalizations; dynamic workspace-model-catalogs; Bootstrap legacy migrations; Title/Git/Compact/Memory request patches; Adapter runner namespace normalizations. A new model dialect often needs specifics in several places.
- **OpenAI-compatible dialect recognition depends on names**: kind/providerId/modelId/levels inference covers officially known models but cannot reliably express private gateways, proxies, or "same modelId, different compatible implementations" (URLs do not participate).
- **App and CLI config expressions differ**: Apps save variants; Standalone CLIs can save complete `providerOptionsByLevel`; builtin memory configs carry transport patches — three sources needing supplements and conversions before one Runtime.
- **Runtimes simultaneously save selections and expanded results**: `modelRef.variant` is the logical selection, `modelProviderOptions` the expanded result; both can be separately updated by different entries, forcing synchronization, recovery, and reverse matching.
- **Auxiliary tasks directly modify arbitrary parameters**: Titles, Git, Compacts, and Memories delete or write Provider fields per their needs; every call point must understand vendor differences — Adapter responsibility leaks into Core.

## Constraints on Model and ModelRequest Designs

Public Option semantics: `reasoningLevel` is the user-expected reasoning intensity, a soft constraint; `maxOutputTokens` is the total generation token limit shared by reasoning and final answers, a hard constraint. Models validate both separately, do not understand thinking budgets, and undertake no Provider-specific combination validations.

The first phase keeps existing Adapter behaviors — even where official recommendations shift to adaptive thinking, fixed-budget requests that still work keep current recognition, tier mappings, and wire requests. Existing fixed thinking keeps `min(levelBudget, maxOutputTokens - 1)`. A later Adapter topic evaluates native effort/adaptive migration and adjusts still-fixed-budget dialects to `min(levelDefaultBudget, floor(maxOutputTokens * 3 / 4))`, reserving stable space for final answers.

Target chain:

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

Target boundaries:

- UIs, Sessions, Submissions, Automations, and Subagents save logical levels, not vendor parameters.
- Derived Models fix providers, models, and reasoning levels; continuous executions no longer re-read mutable Runtime options.
- Adapter paths own reasoning dialects; OpenAI-compatible differences must not leak to Core.
- `providerOptionsByLevel` is read by a compatible boundary during migration, then encapsulated into Models/Adapters, no longer exposed to ModelRequests.
- Tasks that genuinely change reasoning (Titles, Git) express generic tiers via `bind()` or Request Options, never modifying vendor parameter objects.
- Compacts reuse current Models when only changing messages and budgets.
- Usage, Trace, and message histories record provider/model/reasoning from models actually initiating requests.
- Final-line Headers, token refreshes, routing, retries, and field serialization stay within Adapters.

Whether "more granular Adapter types" or "one Adapter with strengthened typed reasoning strategy" is adopted needs ruling in later Adapter designs; whatever the field names, they must become explicit facts in the Provider/Adapter path, capable of distinguishing the same modelId connected to different compatible services.

## Tests to Lock Before Implementation

Migrations cannot verify only intermediate `providerOptions`; keep three layers:

```text
Config/Definition tests
└─ Correct tiers, defaults, and dialect declarations

Model tests
└─ Options validated and fixed, Core does not see any providerOptions

Wire tests
└─ Capture real SDK request bodies, verify final fields
```

Existing wire tests already cover OpenAI Responses `none`, Anthropic effort, Anthropic thinking budgets, OpenAI-compatible `reasoning_effort`, `enable_thinking`, `thinking.type`, and legacy `extra_body` expansions; these serve as behavior baselines during migrations.

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
