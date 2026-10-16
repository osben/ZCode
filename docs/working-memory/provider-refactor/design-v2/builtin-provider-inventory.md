# Builtin Provider Maintenance List

> Status: Builtin maintenance baseline implemented by Todo 76/79 (under active maintenance)
>
> Date: 2026-09-10 (updated for Todo105/111/112/113)

This document only answers "which entrances does ZCode provide built-in, and which models does each entrance maintain." It is not a copy of Provider Config, and does not describe
reasoning maps, capability fields, request Headers, or Personal Provider Instances.

Protocol selection follows a unified principle: when a vendor or specific model/Endpoint supports Anthropic Messages, the official template preferentially uses Anthropic; otherwise, select another API Schema that the entrance actually supports and has the most validation for. When different models require different protocols, split template identities; do not disguise as a single fixed protocol entrance.

## Maintenance Levels

```text
Priority maintenance: default enabled=true, serving as the product's preferred and primary test target
Standard maintenance: default enabled=false, still providing full configuration and optional capabilities
No maintenance: does not enter Builtin Template, no compatibility migration
```

"Standard maintenance" is not a Legacy/Compatibility layer; it only indicates that the entrance still has practical value in the official offering, but is not the current default recommendation.

## Entrance List

Model IDs in the table represent the product maintenance scope. Standard API entrances use `templateId`; account entrances use specific `providerId`.
The `account:zai-*` / `account:bigmodel-*` in the table are merely documentation shorthand for merging the same vendor's plan entrances; actual configuration still preserves
each specific Account Provider ID.

| Vendor                   | Type             | ID                               | Base URL                                                 | Product-Maintained Models                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ---------------- | -------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Z.AI Coding Plan API     | API Template     | `zai-api`                        | `https://api.z.ai/api/anthropic`                         | `GLM-5.3`★, `GLM-5.3-Flash`★                                                                                                                                                                                                                                                                                                                                                                                            |
| Z.AI API                 | API Template     | `zai-standard-api`               | `https://api.z.ai/api/paas/v4`                           | `GLM-5.3`★, `GLM-5.3-Flash`★, `GLM-5V-Turbo`★, `GLM-5.1`○, `GLM-5.1-Highspeed`○, `GLM-5`○, `GLM-5-Turbo`○, `GLM-4.7`○, `GLM-4.7-FlashX`○, `GLM-4.7-Flash`○, `GLM-4.6`○, `GLM-4.5-Air`○, `GLM-4.5`○, `GLM-4.6V`○, `GLM-4.6V-Flash`○, `GLM-4.6V-FlashX`○, `GLM-4.1V-Thinking-FlashX`○, `GLM-4.1V-Thinking-Flash`○, `GLM-4-FlashX-250414`○, `GLM-4-Flash-250414`○, `GLM-4V-Flash`○, `codegeex-4`○, `charglm-4`○, `emohaa`○ |
| BigModel Coding Plan API | API Template     | `bigmodel-api`                   | `https://open.bigmodel.cn/api/anthropic`                 | `GLM-5.3`★, `GLM-5.3-Flash`★                                                                                                                                                                                                                                                                                                                                                                                            |
| BigModel API             | API Template     | `bigmodel-standard-api`          | `https://open.bigmodel.cn/api/paas/v4`                   | `GLM-5.3`★, `GLM-5.3-Flash`★, `GLM-5V-Turbo`★, `GLM-5.1`○, `GLM-5.1-Highspeed`○, `GLM-5`○, `GLM-5-Turbo`○, `GLM-4.7`○, `GLM-4.7-FlashX`○, `GLM-4.7-Flash`○, `GLM-4.6`○, `GLM-4.5-Air`○, `GLM-4.5`○, `GLM-4.6V`○, `GLM-4.6V-Flash`○, `GLM-4.6V-FlashX`○, `GLM-4.1V-Thinking-FlashX`○, `GLM-4.1V-Thinking-Flash`○, `GLM-4-FlashX-250414`○, `GLM-4-Flash-250414`○, `GLM-4V-Flash`○, `codegeex-4`○, `charglm-4`○, `emohaa`○ |
| Z.ai                     | Account Provider | `account:zai-*`                  | Fixed by plan entrance                                   | Personal/Team: `GLM-5.3`★, `GLM-5.3-Flash`★; Start/Off-Peak maintain their respective lists                                                                                                                                                                                                                                                                                                                             |
| BigModel                 | Account Provider | `account:bigmodel-*`             | Fixed by plan entrance                                   | Personal/Team: `GLM-5.3`★, `GLM-5.3-Flash`★; Start/Off-Peak maintain their respective lists                                                                                                                                                                                                                                                                                                                             |
| Kimi                     | API Template     | `moonshot-kimi`                  | `https://api.moonshot.cn/anthropic`                      | `kimi-k3`★, `kimi-k2.7-code`★, `kimi-k2.6`★, `k3`○, `k3-256k`○, `kimi-k2.5`○, `moonshot-v1-8k`○, `moonshot-v1-32k`○, `moonshot-v1-128k`○, `moonshot-v1-8k-vision-preview`○, `moonshot-v1-32k-vision-preview`○, `moonshot-v1-128k-vision-preview`○                                                                                                                                                                       |
| MiniMax                  | API Template     | `minimax`                        | `https://api.minimaxi.com/anthropic`                     | `MiniMax-M3`★, `MiniMax-M2.7`★, `MiniMax-M2.7-highspeed`★, `MiniMax-M2.5`○, `MiniMax-M2.5-highspeed`○, `MiniMax-M2.1`○, `MiniMax-M2.1-highspeed`○, `MiniMax-M2`○                                                                                                                                                                                                                                                        |
| DeepSeek                 | API Template     | `deepseek`                       | `https://api.deepseek.com/anthropic`                     | `deepseek-flash`★, `deepseek-v4-pro`★, `deepseek-v4-flash`○                                                                                                                                                                                                                                                                                                                                                             |
| Alibaba Cloud (China)    | API Template     | `qwen-alibaba-model-studio-cn`   | `https://dashscope.aliyuncs.com/apps/anthropic`          | `qwen3.8-max`★, `qwen3.8-flash`★, `qwen3.5-plus`○, `qwen3.5-flash`○, `qwen3-max`○, `qwen-plus`○, `qwen-flash`○, `qwen3-vl-plus`○                                                                                                                                                                                                                                                                                        |
| Alibaba Cloud (Global)   | API Template     | `qwen-alibaba-model-studio-intl` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen3.8-max`★, `qwen3.8-flash`★, `qwen3.5-plus`○, `qwen3.5-flash`○, `qwen3-max`○, `qwen-plus`○, `qwen-flash`○, `qwen3-vl-plus`○                                                                                                                                                                                                                                                                                        |
| Xiaomi MiMo              | API Template     | `xiaomi-mimo`                    | `https://api.xiaomimimo.com/anthropic`                   | `mimo-v2.5-pro`★, `mimo-v2.5`★, `mimo-v2-pro`○, `mimo-v2-omni`○, `mimo-v2-flash`○                                                                                                                                                                                                                                                                                                                                       |
| OpenAI                   | API Template     | `openai`                         | `https://api.openai.com/v1`                              | `gpt-6-astra`★, `gpt-5.6-sol`★, `gpt-5.6-terra`★, `gpt-5.6-luna`★, `gpt-5.6`○, `gpt-5.3-codex`○                                                                                                                                                                                                                                                                                                                         |
| Anthropic                | API Template     | `anthropic`                      | `https://api.anthropic.com/v1`                           | `claude-fable-5-1`★, `claude-fable-5`★, `claude-opus-5`★, `claude-sonnet-5`★, `claude-haiku-4-5-20251001`★                                                                                                                                                                                                                                                                                                              |
| xAI                      | API Template     | `xai`                            | `https://api.x.ai/v1`                                    | `grok-4.6`★, `grok-build-0.1`★, `grok-4.3`○                                                                                                                                                                                                                                                                                                                                                                             |

`★` indicates priority maintenance, enabled by default; `○` indicates standard maintenance, disabled by default.

### OpenRouter

OpenRouter is a standard API Template, currently using `templateId=openrouter`. Official templates uniformly adopt Anthropic Messages, with Base URL
`https://openrouter.ai/api`. This round assumes all models in this list support this entrance; no separate OpenRouter Chat/Responses template is created; only when clear counter-evidence appears in the future will subsequent Todo handle other schemas.

Model coverage spans all maintained models across every vendor's standard API Template in this list; as long as OpenRouter currently actually provides them, all are included, no longer selecting only a few
"representative models." Each upstream vendor has at least one priority model enabled by default, with other models from the same vendor under standard maintenance, disabled by default. OpenRouter's own full
dynamic catalog is not copied into Builtin Config; models not listed in ZCode maintenance scope continue to be used by users through custom Providers.

OpenRouter model IDs are registered by the values it actually returns. For example, `openai/gpt-5.6-sol` may currently appear, corresponding to the upstream `gpt-5.6-sol`; this is
only OpenRouter's naming fact, not a universal format for all aggregating vendors, and does not require the runtime to strip prefixes. OpenRouter's configuration remains independently maintained, without reusing upstream
Provider capabilities or Option configurations.

The current target maintenance list (based on actual IDs existing in the 2026-09-04 Models API) grouped by upstream vendor is as follows:

The list only registers model IDs directly usable for standard conversation/Agent requests; OpenRouter's `:batch` and other batch processing variants are not individually listed as model members; `:free`
and other variants affecting actual routing or billing are only registered separately when independent configuration is needed.

- OpenAI: `openai/gpt-6-astra`★, `openai/gpt-5.6-sol`★, `openai/gpt-5.6-terra`★, `openai/gpt-5.6-luna`★, `openai/gpt-5.3-codex`○;
- Anthropic: `anthropic/claude-fable-5.1`★, `anthropic/claude-fable-5`★, `anthropic/claude-opus-5`★, `anthropic/claude-sonnet-5`★, `anthropic/claude-haiku-4.5`★,
  `anthropic/claude-opus-4.8`○, `anthropic/claude-opus-4.7`○, `anthropic/claude-opus-4.6`○,
  `anthropic/claude-opus-4.5`○, `anthropic/claude-sonnet-4.6`○, `anthropic/claude-sonnet-4.5`○;
- DeepSeek: `deepseek/deepseek-v4-pro`★, `deepseek/deepseek-v4-flash`★;
- Moonshot: `moonshotai/kimi-k3`★, `moonshotai/kimi-k2.7-code`○, `moonshotai/kimi-k2.6`○, `moonshotai/kimi-k2.5`○;
- Z.AI: `z-ai/glm-5.3`★, `z-ai/glm-5.3-flash`★, `z-ai/glm-5.2`○, `z-ai/glm-5.1`○, `z-ai/glm-5v-turbo`○,
  `z-ai/glm-5`○, `z-ai/glm-5-turbo`○, `z-ai/glm-4.7`○, `z-ai/glm-4.7-flash`○, `z-ai/glm-4.6`○,
  `z-ai/glm-4.6v`○, `z-ai/glm-4.5-air`○, `z-ai/glm-4.5`○;
- Qwen: `qwen/qwen3.8-max`★, `qwen/qwen3.8-flash`★, `qwen/qwen3.7-max`○, `qwen/qwen3.7-plus`○,
  `qwen/qwen3.7-flash`○, `qwen/qwen3.6-plus`○, `qwen/qwen3.6-flash`○, `qwen/qwen3.5-plus-20260420`○;
- MiniMax: `minimax/minimax-m3`★, `minimax/minimax-m2.7`○, `minimax/minimax-m2.5`○;
- Xiaomi MiMo: `xiaomi/mimo-v2.5-pro`★, `xiaomi/mimo-v2.5`★;
- xAI: `x-ai/grok-4.6`★, `x-ai/grok-build-0.1`○, `x-ai/grok-4.3`○.

### OpenCode Zen

OpenCode here refers to the OpenCode Zen API, not the OpenCode Agent runtime. Zen uses the same site
`https://opencode.ai/zen/v1`, but models are divided into three Templates by official Endpoint/Schema:

- `opencode-zen-responses`: GPT 5.6 Sol, Terra, Luna, and other GPT Responses models;
- `opencode-zen-messages`: Claude, Qwen, and other Anthropic Messages models;
- `opencode-zen-chat`: Kimi, DeepSeek, MiniMax, GLM, and Zen's free Chat models.

OpenCode Zen's maintenance scope covers all vendors' models still valid in the official model table, without omitting other brands just because one brand has a priority model. Each upstream brand entering the list
has at least one priority model enabled by default; other official models from the same brand under standard maintenance, disabled by default. The current target list expanded by protocol:

- Responses: `gpt-6-astra`★, `gpt-5.6-sol`★, `gpt-5.6-terra`★, `gpt-5.6-luna`★, `gpt-5.5`○, `gpt-5.5-pro`○,
  `gpt-5.4`○, `gpt-5.4-pro`○, `gpt-5.4-mini`○, `gpt-5.4-nano`○, `gpt-5.3-codex`○, `gpt-5.3-codex-spark`○,
  `gpt-5.2`○, `gpt-5.1`○;
- Anthropic Messages: `claude-fable-5-1`★, `claude-fable-5`★, `claude-opus-5`★, `claude-sonnet-5`★, `claude-haiku-4-5`○,
  `claude-opus-4-8`○, `claude-opus-4-7`○, `claude-opus-4-6`○, `claude-opus-4-5`○,
  `claude-sonnet-4-6`○, `claude-sonnet-4-5`○; Qwen: `qwen3.7-max`★, `qwen3.7-plus`○, `qwen3.6-plus`○,
  `qwen3.5-plus`○;
- OpenAI-compatible Chat: `kimi-k3`★, `minimax-m3`★, `minimax-m2.7`○, `deepseek-v4-pro`★,
  `deepseek-v4-flash`○, `glm-5.2`★, `glm-5.1`○, `big-pickle`★, `mimo-v2.5-free`★, `hy3-free`○,
  `ling-3.0-flash-fin-free`○, `nemotron-3-ultra-free`○, `nemotron-3.5-lightning-free`○,
  `muse-spark-1.2-contributor-free`○.

The above is ZCode's maintenance list, not Zen's full dynamic catalog; the final gate remains Zen's official `/zen/v1/models` return value and protocol verification results before formal writing.

Z.ai, BigModel, Kimi, MiniMax, and Qwen "standard maintenance" models use the officially available model list at the time of implementation for each specific API entrance as the final gate;
if a particular ID is no longer accepted by that entrance, it is deleted from both the table and the corresponding Template. We do not continue maintenance simply because the vendor's website still hosts historical materials.

## Removal Scope

- Z.ai / BigModel Personal/Team Account and manual Coding Plan templates only preset `GLM-5.3`, `GLM-5.3-Flash`; do not delete other model rules or user-saved selections.
- Standard Z.ai / BigModel API templates retain other official GLM models under maintenance, non-priority members disabled by default; do not merge it with Coding Plan API as one entrance.
- Kimi: delete `moonshot-v1-*`; K2.5/K2.6 under standard maintenance as long as the official API still supports them, not deleted directly due to older version numbers.
- MiniMax: delete M2.1 and earlier models; M2.7/M2.5 still listed in official release documents, retained as standard maintenance candidates.
- MiMo: delete `mimo-v2-pro`, `mimo-v2-omni`, `mimo-v2-flash`; vendors have announced these old models retired as of 2026-06-30, migration target is the V2.5 series.
- Anthropic: delete retired Claude 3.x, Sonnet 4, Opus 4, and Opus 4.1; Opus 4.8/4.7, Sonnet 4.6, etc. still retained under standard maintenance.

## This Round's Boundaries

- This round modifies existing Builtin Provider template members and Model Rules, and incorporates OpenRouter and OpenCode Zen as two additional standard API entrances per this table.
- Azure, Volcano Ark, and AWS Bedrock are still handled separately by Todo 22, not written into this round's entrance table.
- Google Gemini continues to be excluded from this table due to its native API Schema being independent.
- Vendor models not appearing in the table do not enter Builtin Template; users may still fill them in through custom Providers.

### OpenRouter / OpenCode List Policy

- OpenRouter is a dynamic aggregation catalog; do not copy its full catalog into Builtin Config; but also do not make a narrow curation covering only a few brands. The maintenance set is the intersection of "upstream models maintained in this table" and OpenRouter's currently actually provided models: as long as each vendor's maintained models are provided by OpenRouter, all are included; at least one priority model per vendor is enabled by default, with other models under standard maintenance, disabled by default. "Each vendor" here refers to the standard API Template vendors in this table, not duplicating the same vendor's Account
  Providers. IDs with suffixes like `/`, `:free`, etc. are saved as-is.
- OpenRouter's model list is registered by the actual model IDs it returns; in the current example, upstream `gpt-5.6-sol` corresponds to `openai/gpt-5.6-sol`, but this is only
  OpenRouter's naming fact, not a universal format for all aggregating vendors, and does not require the runtime to perform ID stripping. Model Rules and Model+API Rules can
  express known variants with prefix/suffix patterns; Template Model, Provider Model, and Site Rule do not use this model wildcard. The model set is a slowly-updating closed maintenance
  scope; when new models are added or renamed, directly append an explicit `modelMatch` rule.
- OpenCode Zen's official models use the same site, but different models actually distribute across Responses, Anthropic Messages, and OpenAI-compatible Chat
  three Endpoints/Schemas. The current `ProviderTemplate`'s `api.type` is single-valued, so the list is first registered by three
  template identities: `responses`, `messages`, `chat`; during implementation, do not disguise models with different schemas as a single fixed template, and do not extend a temporary field set before a type design exists.
- OpenCode's model list is subject to Zen's official `/zen/v1/models` and documentation; the ★/○ in the table only express ZCode's default enable strategy, not Zen's billing or
  recommendation levels.
- OpenCode Zen's maintenance set covers all vendors' models still valid in its official model table, without omitting other brands just because one brand already has a priority model; each upstream brand with models entering
  the list has at least one model enabled by default, with other official models under standard maintenance, disabled by default.

## Reference Materials

- [Z.AI Models](https://docs.z.ai/guides/overview/overview)
- [Kimi Code Models](https://www.kimi.com/code/docs/en/kimi-code/models.html)
- [DeepSeek Models](https://api-docs.deepseek.com/quick_start/pricing/)
- [Alibaba Model Studio Models](https://help.aliyun.com/en/model-studio/models)
- [Xiaomi MiMo API Models](https://mimo.mi.com/docs/en-US/quick-start/model)
- [OpenAI Models](https://platform.openai.com/docs/models/gpt-4-turbo-and-gpt-4)
- [Anthropic Model Deprecations](https://docs.anthropic.com/en/docs/about-claude/model-deprecations)
- [MiniMax Model Releases](https://platform.minimaxi.com/docs/release-notes/models)
- [xAI Grok 4.6](https://docs.x.ai/developers/grok-4-6)
- [OpenRouter Models](https://openrouter.ai/docs/guides/overview/models)
- [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models)
- [OpenCode Zen](https://dev.opencode.ai/docs/zen)
