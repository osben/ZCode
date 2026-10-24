# Builtin Provider Historical Maintenance List

> Snapshot of the target list and rulings at the original investigation time (2026-09-10, updated for
> Todo105/111/112/113; Todo 76/79 maintenance baseline). It does not represent current configuration or
> upstream live state. Since 2026-10-14, daily maintenance lives in the
> [maintenance entry](../../../builtin-provider-maintenance/README.md); configured members and default
> enable/disable live in [current state](../../../builtin-provider-maintenance/current-state.md). The tables
> and removal sections below have historical drift — do not restore or delete models from them directly.

This document answers only "which entrances ZCode provides built-in, and which models each maintains." It is
not a copy of Provider Config and does not describe reasoning maps, capability fields, request Headers, or
Personal Provider Instances.

Protocol selection principle: when a vendor or specific model/Endpoint supports Anthropic Messages, the
official template prefers Anthropic; otherwise select another API Schema the entrance actually supports and
has the most validation for. When different models need different protocols, split template identities; do not
disguise them as one fixed-protocol entrance.

## Maintenance Levels

```text
Priority maintenance: default enabled=true, serving as the product's preferred and primary test target
Standard maintenance: default enabled=false, still providing full configuration and optional capabilities
No maintenance: does not enter Builtin Template, no compatibility migration
```

"Standard maintenance" is not a Legacy/Compatibility layer; it only means the entrance still has practical
value in the official offering but is not the current default recommendation.

## Entrance List

Model IDs in the table are the product maintenance scope. Standard API entrances use `templateId`; account
entrances use specific `providerId`. The `account:zai-*` / `account:bigmodel-*` rows are documentation
shorthand merging the same vendor's plan entrances; actual configuration preserves each specific Account
Provider ID.

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

`★` = priority maintenance, enabled by default; `○` = standard maintenance, disabled by default.

Z.ai, BigModel, Kimi, MiniMax, and Qwen "standard maintenance" models use the officially available model
list at implementation time for each specific API entrance as the final gate; if an ID is no longer accepted
by that entrance, it is deleted from both the table and the corresponding Template. Maintenance does not
continue merely because the vendor's website still hosts historical materials.

## OpenRouter

OpenRouter is a standard API Template, `templateId=openrouter`, Base URL `https://openrouter.ai/api`, using
Anthropic Messages. All models in this list are assumed to support the entrance; no separate OpenRouter
Chat/Responses template is created unless clear counter-evidence appears (a subsequent Todo would handle
other schemas).

- The maintenance set is the intersection of "upstream models maintained in this table" and what OpenRouter
  currently actually provides: every vendor's maintained models that OpenRouter provides are included; each
  vendor ("each vendor" = the standard API Template vendors in this table, not duplicating Account Providers)
  has at least one priority model enabled by default, other models under standard maintenance, disabled by
  default. Do not copy OpenRouter's full dynamic catalog into Builtin Config, and do not narrow the curation
  to a few brands. Models outside ZCode's maintenance scope remain reachable through custom Providers.
- Model IDs are registered by the values OpenRouter actually returns — e.g. `openai/gpt-5.6-sol` corresponds
  to upstream `gpt-5.6-sol`. That is only OpenRouter's naming fact, not a universal aggregator format, and
  requires no runtime ID stripping. IDs with suffixes like `/`, `:free` are saved as-is. Model Rules and
  Model+API Rules can express known variants with prefix/suffix patterns; Template Model, Provider Model, and
  Site Rules do not use this model wildcard. The set is a slowly-updating closed maintenance scope; new or
  renamed models append an explicit `modelMatch` rule.
- OpenRouter's configuration is independently maintained, without reusing upstream Provider capabilities or
  Option configurations.

Target maintenance list (based on actual IDs in the 2026-09-04 Models API), grouped by upstream vendor. Only
model IDs directly usable for standard conversation/Agent requests are registered; `:batch` variants are not
listed as members; `:free` and other routing/billing variants are registered separately only when independent
configuration is needed.

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

## OpenCode Zen

"OpenCode" here is the OpenCode Zen API, not the OpenCode Agent runtime. Zen uses one site
`https://opencode.ai/zen/v1`, but models distribute across three Templates by official Endpoint/Schema,
because `ProviderTemplate.api.type` is single-valued — do not disguise different-schema models as one fixed
template, and do not extend a temporary field set before a type design exists:

- `opencode-zen-responses`: GPT 5.6 Sol, Terra, Luna, and other GPT Responses models;
- `opencode-zen-messages`: Claude, Qwen, and other Anthropic Messages models;
- `opencode-zen-chat`: Kimi, DeepSeek, MiniMax, GLM, and Zen's free Chat models.

Zen's maintenance scope covers all vendors' models still valid in the official model table, without omitting
other brands because one brand already has a priority model; each upstream brand entering the list has at
least one priority model enabled by default, other official models under standard maintenance, disabled by
default. The list is ZCode's maintenance list, not Zen's full dynamic catalog; the final gate remains Zen's
official `/zen/v1/models` return value and protocol verification before formal writing. The ★/○ marks express
only ZCode's default enable strategy, not Zen's billing or recommendation levels.

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

## Removal Scope

- Z.ai / BigModel Personal/Team Account and manual Coding Plan templates preset only `GLM-5.3`,
  `GLM-5.3-Flash`; other model rules and user-saved selections are not deleted.
- Standard Z.ai / BigModel API templates retain other official GLM models under maintenance, non-priority
  members disabled by default; they are not merged with Coding Plan API as one entrance.
- Kimi: delete `moonshot-v1-*`; K2.5/K2.6 stay under standard maintenance as long as the official API still
  supports them — not deleted merely for older version numbers.
- MiniMax: delete M2.1 and earlier; M2.7/M2.5 still listed in official release documents, retained as
  standard maintenance candidates.
- MiMo: delete `mimo-v2-pro`, `mimo-v2-omni`, `mimo-v2-flash`; the vendor announced these retired as of
  2026-06-30, migration target is the V2.5 series.
- Anthropic: delete retired Claude 3.x, Sonnet 4, Opus 4, and Opus 4.1; Opus 4.8/4.7, Sonnet 4.6, etc.
  remain under standard maintenance.

## This Round's Boundaries

- This round modifies existing Builtin Provider template members and Model Rules, and adds OpenRouter and
  OpenCode Zen as two standard API entrances per this table.
- Azure, Volcano Ark, and AWS Bedrock stay with Todo 22, not written into this round's entrance table.
- Google Gemini stays excluded due to its independent native API Schema.
- Vendor models not in the table do not enter Builtin Templates; users may still add them through custom
  Providers.

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
