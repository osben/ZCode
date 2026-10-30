# Current Configuration and Maintenance State

The current Git configuration is revision 43, clarifying that TokenHub is the Guangzhou / Singapore API under the China-site account; revision 42 turned off video for the GLM-5.3 standard edition on the Coding Plan and speed-up card entries, keeping image and Flash; earlier, `doubao-seed-evolving` was added default enabled. The three Pro/Lite/Turbo members of the Ark ordinary API are default disabled for video input because the current Messages entry rejects video content blocks; the remaining capabilities are unchanged. On 2026-10-27 it was confirmed that the native JSON Schema declaration of OpenCode Go Chat is uniformly turned off; template members and same-site self-built vendors follow that policy, with other capabilities and entries unchanged. On 2026-10-26 the four entry members of MiniMax M3.1 Flash were added default enabled; the original vendor's two M2.7 entries and the plan Preview were default disabled, and the three M2/M2.1 members explicitly retired by the original vendor were deleted — exact differences and evidence are in the [M3.1 Flash spec](./minimax-m31-flash.md). Revision 37 tidied the template brand order; revision 36 added the eight Kimi K3.1 Pro/Highspeed entries, see the [K3.1 Pro spec](./kimi-k3-1-pro.md). The earlier mainstream-vendor and plan expansions are in the [implementation spec](./expansion-2026-10-15.md). Account configuration and shared model rules are unchanged; the text below is the Git state and does not represent being live or that all real calls passed.

On top of upstream revision 43, this fork's build carries one additional local provider entry `account:chatgpt-plan` (ChatGPT Plan). It is fork-only and not present upstream, so it is not part of the upstream figures and lists below.

## Current issue handling (2026-10-27)

This round's default configuration has no remaining confirmed onboarding blockers, which does not mean all capabilities and service stability are validated.

| Item                                   | Current evidence and handling                                                                                                                                                                                                                        | Blocks this round's default configuration           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Ark ordinary API entitlement and video | All four activated models are callable; Messages video uniformly returns 400. The three built-in dated models and Evolving disable video, and the other applicable cases pass                                                                        | No; the declaration is narrowed to the actual entry |
| GLM-5.3 video                          | Confirmed that the Coding Plan standard edition does not support video and the built-in site declaration is turned off; image and Flash keep their original values                                                                                   | No; closed out per the confirmed capability         |
| StepFun 3.7 Flash medium               | A new single retest succeeded with the raw stream consistent with the product counts: thinking 10,567 characters, answer 2,603 characters, about 86.5 s in total. All three levels are kept; the root cause of the old empty answers is undetermined | No; levels are not deleted over the old failures    |
| Go Chat native JSON Schema             | Confirmed that the declaration is uniformly turned off; not widened into all models being fully without JSON support                                                                                                                                 | No                                                  |
| GLM MCS, image and Go Flash PDF        | Passed after fixing the test chain or by product measurement; the unfounded adapter-fault judgment is withdrawn                                                                                                                                      | No                                                  |
| Kimi capacity issues                   | Not pursued for now within the confirmed scope; no model is deleted and no capability declaration changed on this basis                                                                                                                              | No                                                  |
| Seed Evolving                          | Added to the ordinary API built-in catalog default enabled with video disabled; passes the other applicable cases and does not replace the existing dated models                                                                                     | No                                                  |

Externally reported issues resume investigation only when new evidence appears or a product-side adjustment is needed. One success can rule out a likely static adaptation problem but cannot prove the root cause of earlier failures or long-term stability. The engineering checks and commit wrap-up of the regression tool code are recorded separately; pre-existing unrelated test failures are neither interpreted as vendor unavailability nor hidden or claimed as a full-validation pass.

## Baseline and scope of figures

- Check date: 2026-10-26. The latest merged baseline is staging `e06710b7bd`, product source version 3.16.3; the text below is this round's working-branch configuration and does not mean that version has shipped.
- Production and test are both schemaVersion 1, revision 43; the test file is generated from the production file.
- 34 ordinary API/plan templates, 10 fixed-account Providers; 314 template members in total, of which 127 are default enabled, including models duplicated across templates. Relative to the original revision 33, 13 templates and 71 members were added cumulatively (Preview has moved to general maintenance); 22 default-disable changes accumulated in total, and 3 members explicitly retired by the original vendor were deleted.
- Model rules 83, Model+API rules 73, production Site rules 58, test Site rules 70, template exact rules 316, fixed Provider exact rules 30.
- Production file SHA-256: `e537b380df05656e3757c2b220ae1044fe8a32c0ac148de265a05a94cc24b3a9`.
- Test file SHA-256: `10df0ce6d9a6ae68e4d6bbb4e8984974be8b0899ced2e48ecc36d8c6d32a7890`. The hashes are for the Git content (LF); a local CRLF checkout must be normalized to the repository line endings before comparing.

The list is extracted directly from the [production JSON](../../config/provider/zcode-builtin.json). The enablement below comes from template exact rules and excludes user overrides or actual keys/entitlements; being in the list does not mean the entry was validated for real in this round.

## Template summary

| templateId                       | Protocol                  | Members | Default enabled |
| -------------------------------- | ------------------------- | ------- | --------------- |
| `zai-api`                        | `anthropic-messages`      | 2       | 2               |
| `zai-standard-api`               | `openai-chat-completions` | 25      | 3               |
| `bigmodel-api`                   | `anthropic-messages`      | 2       | 2               |
| `bigmodel-standard-api`          | `openai-chat-completions` | 24      | 2               |
| `moonshot-kimi`                  | `anthropic-messages`      | 8       | 5               |
| `kimi-code-cn`                   | `openai-chat-completions` | 6       | 6               |
| `kimi-code-intl`                 | `openai-chat-completions` | 6       | 6               |
| `minimax`                        | `anthropic-messages`      | 6       | 2               |
| `minimax-m-plan-cn`              | `anthropic-messages`      | 2       | 1               |
| `deepseek`                       | `anthropic-messages`      | 2       | 2               |
| `qwen-alibaba-model-studio-cn`   | `anthropic-messages`      | 13      | 2               |
| `qwen-alibaba-model-studio-intl` | `openai-chat-completions` | 14      | 2               |
| `qwen-coding-plan-cn`            | `openai-chat-completions` | 1       | 1               |
| `qwen-token-plan-team-cn`        | `openai-chat-completions` | 2       | 2               |
| `xiaomi-mimo`                    | `anthropic-messages`      | 4       | 2               |
| `xiaomi-mimo-token-plan`         | `anthropic-messages`      | 2       | 2               |
| `tencent-tokenhub-cn`            | `openai-chat-completions` | 2       | 2               |
| `tencent-tokenhub-intl`          | `openai-chat-completions` | 2       | 2               |
| `volcengine-ark`                 | `anthropic-messages`      | 4       | 4               |
| `volcengine-coding-plan`         | `anthropic-messages`      | 2       | 2               |
| `volcengine-agent-plan`          | `anthropic-messages`      | 2       | 2               |
| `stepfun`                        | `anthropic-messages`      | 2       | 2               |
| `stepfun-step-plan`              | `anthropic-messages`      | 2       | 2               |
| `openai`                         | `openai-responses`        | 12      | 4               |
| `anthropic`                      | `anthropic-messages`      | 8       | 4               |
| `xai`                            | `openai-responses`        | 4       | 2               |
| `siliconflow-cn`                 | `openai-chat-completions` | 3       | 3               |
| `openrouter`                     | `anthropic-messages`      | 70      | 18              |
| `opencode-go-responses`          | `openai-responses`        | 4       | 2               |
| `opencode-go-messages`           | `anthropic-messages`      | 9       | 4               |
| `opencode-go-chat`               | `openai-chat-completions` | 19      | 10              |
| `opencode-zen-responses`         | `openai-responses`        | 17      | 4               |
| `opencode-zen-messages`          | `anthropic-messages`      | 18      | 7               |
| `opencode-zen-chat`              | `openai-chat-completions` | 15      | 11              |

## Full members and default enablement

The list is generated directly from the production configuration. Full capabilities and parameters are resolved per the [configuration spec](./configuration.md); no second set of rules is maintained on this page.

### zai-api

- Base URL: `https://api.z.ai/api/anthropic`; Access: `zhipu-coding-plan-api-key`.
- Default enabled: `GLM-5.3`, `GLM-5.3-Flash`.
- Default disabled: none.

### zai-standard-api

- Base URL: `https://api.z.ai/api/paas/v4`; Access: `api-key`.
- Default enabled: `GLM-5.3`, `GLM-5.3-Flash`, `glm-5.3-flashx`.
- Default disabled: `GLM-5V-Turbo`, `GLM-5.1`, `GLM-5.1-Highspeed`, `GLM-5`, `GLM-5-Turbo`, `GLM-4.7`, `GLM-4.7-FlashX`, `GLM-4.7-Flash`, `GLM-4.6`, `GLM-4.5-Air`, `GLM-4.5`, `GLM-4.6V`, `GLM-4.6V-Flash`, `GLM-4.6V-FlashX`, `GLM-4.1V-Thinking-FlashX`, `GLM-4.1V-Thinking-Flash`, `GLM-4-FlashX-250414`, `GLM-4-Flash-250414`, `GLM-4V-Flash`, `codegeex-4`, `charglm-4`, `emohaa`.

### bigmodel-api

- Base URL: `https://open.bigmodel.cn/api/anthropic`; Access: `zhipu-coding-plan-api-key`.
- Default enabled: `GLM-5.3`, `GLM-5.3-Flash`.
- Default disabled: none.

### bigmodel-standard-api

- Base URL: `https://open.bigmodel.cn/api/paas/v4`; Access: `api-key`.
- Default enabled: `GLM-5.3`, `GLM-5.3-Flash`.
- Default disabled: `GLM-5V-Turbo`, `GLM-5.1`, `GLM-5.1-Highspeed`, `GLM-5`, `GLM-5-Turbo`, `GLM-4.7`, `GLM-4.7-FlashX`, `GLM-4.7-Flash`, `GLM-4.6`, `GLM-4.5-Air`, `GLM-4.5`, `GLM-4.6V`, `GLM-4.6V-Flash`, `GLM-4.6V-FlashX`, `GLM-4.1V-Thinking-FlashX`, `GLM-4.1V-Thinking-Flash`, `GLM-4-FlashX-250414`, `GLM-4-Flash-250414`, `GLM-4V-Flash`, `codegeex-4`, `charglm-4`, `emohaa`.

### moonshot-kimi

- Base URL: `https://api.moonshot.cn/anthropic`; Access: `api-key`.
- Default enabled: `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`.
- Default disabled: `kimi-k2.7-code-highspeed`, `k3`, `k3-256k`.

### minimax

- Base URL: `https://api.minimaxi.com/anthropic`; Access: `api-key`.
- Default enabled: `MiniMax-M3.1-Flash`, `MiniMax-M3`.
- Default disabled: `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M2.5`, `MiniMax-M2.5-highspeed`.

### deepseek

- Base URL: `https://api.deepseek.com/anthropic`; Access: `api-key`.
- Default enabled: `deepseek-flash`, `deepseek-v4-pro`.
- Default disabled: none.

### qwen-alibaba-model-studio-cn

- Base URL: `https://dashscope.aliyuncs.com/apps/anthropic`; Access: `api-key`.
- Default enabled: `qwen3.8-max`, `qwen3.8-flash`.
- Default disabled: `qwen3.7-max`, `qwen3.7-plus`, `qwen3.7-flash`, `qwen3.6-plus`, `qwen3.6-flash`, `qwen3.5-plus`, `qwen3.5-flash`, `qwen3-max`, `qwen-plus`, `qwen-flash`, `qwen3-vl-plus`.

### qwen-alibaba-model-studio-intl

- Base URL: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`; Access: `api-key`.
- Default enabled: `qwen3.8-max`, `qwen3.8-flash`.
- Default disabled: `qwen3.8-omni-flash`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.7-flash`, `qwen3.6-plus`, `qwen3.6-flash`, `qwen3.5-plus`, `qwen3.5-flash`, `qwen3-max`, `qwen-plus`, `qwen-flash`, `qwen3-vl-plus`.

### xiaomi-mimo

- Base URL: `https://api.xiaomimimo.com/anthropic`; Access: `api-key`.
- Default enabled: `mimo-v2.6-pro`, `mimo-v2.6-flash`.
- Default disabled: `mimo-v2.5-pro`, `mimo-v2.5`.

### xiaomi-mimo-token-plan

- Base URL: `https://token-plan-cn.xiaomimimo.com/anthropic`; Access: `api-key`.
- Default enabled: `mimo-v2.6-pro`, `mimo-v2.6-flash`.
- Default disabled: none.

### openai

- Base URL: `https://api.openai.com/v1`; Access: `api-key`.
- Default enabled: `gpt-6-astra`, `gpt-5.6-terra`, `gpt-6.1-sol`, `gpt-6-luna`.
- Default disabled: `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex`.

### anthropic

- Base URL: `https://api.anthropic.com/v1`; Access: `api-key`.
- Default enabled: `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`.
- Default disabled: `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`.

### xai

- Base URL: `https://api.x.ai/v1`; Access: `api-key`.
- Default enabled: `grok-build-0.1`, `grok-4.7`.
- Default disabled: `grok-4.6`, `grok-4.3`.

### openrouter

- Base URL: `https://openrouter.ai/api`; Access: `api-key`.
- Default enabled: `minimax/minimax-m3.1-flash`, `moonshotai/kimi-k3.1-pro`, `anthropic/claude-fable-5.1`, `openai/gpt-6-astra`, `deepseek/deepseek-v4-pro`, `moonshotai/kimi-k3`, `z-ai/glm-5.3`, `qwen/qwen3.8-max`, `minimax/minimax-m3`, `openai/gpt-6.1-sol`, `openai/gpt-6-luna`, `anthropic/claude-opus-5.5`, `anthropic/claude-sonnet-5.5`, `anthropic/claude-haiku-5.5`, `x-ai/grok-4.7`, `z-ai/glm-5.3-flashx`, `xiaomi/mimo-v2.6-pro`, `xiaomi/mimo-v2.6-flash`.
- Default disabled: `openai/gpt-5.6-sol`, `anthropic/claude-opus-5`, `xiaomi/mimo-v2.5-pro`, `x-ai/grok-4.6`, `deepseek/deepseek-v4.1-flash`, `qwen/qwen3.8-max-0902`, `openai/gpt-5.6-terra`, `openai/gpt-5.6-luna`, `openai/gpt-5.6`, `openai/gpt-5.4`, `openai/gpt-5.4-pro`, `openai/gpt-5.4-mini`, `openai/gpt-5.4-nano`, `openai/gpt-5.3-codex`, `anthropic/claude-sonnet-5`, `anthropic/claude-haiku-4.5`, `anthropic/claude-opus-4.8`, `anthropic/claude-opus-4.7`, `anthropic/claude-opus-4.6`, `anthropic/claude-opus-4.5`, `anthropic/claude-sonnet-4.6`, `anthropic/claude-sonnet-4.5`, `deepseek/deepseek-v4-flash`, `moonshotai/kimi-k2.7-code`, `moonshotai/kimi-k2.6`, `moonshotai/kimi-k2.5`, `z-ai/glm-5.3-flash`, `z-ai/glm-5.2`, `z-ai/glm-5.1`, `z-ai/glm-5v-turbo`, `z-ai/glm-5`, `z-ai/glm-5-turbo`, `z-ai/glm-4.7`, `z-ai/glm-4.7-flash`, `z-ai/glm-4.6`, `z-ai/glm-4.6v`, `z-ai/glm-4.5-air`, `z-ai/glm-4.5`, `qwen/qwen3.8-flash`, `qwen/qwen3.7-max`, `qwen/qwen3.7-plus`, `qwen/qwen3.7-flash`, `qwen/qwen3.6-plus`, `qwen/qwen3.6-flash`, `qwen/qwen3.5-plus-20260420`, `qwen/qwen3-vl-plus`, `qwen/qwen3-vl-flash`, `minimax/minimax-m2.7`, `minimax/minimax-m2.5`, `xiaomi/mimo-v2.5`, `x-ai/grok-build-0.1`, `x-ai/grok-4.3`.

### opencode-go-chat

- Base URL: `https://opencode.ai/zen/go/v1`; Access: `api-key`.
- Default enabled: `minimax-m3.1-flash`, `kimi-k3.1-pro`, `glm-5.3-flash`, `glm-5.3`, `kimi-k3`, `kimi-k2.7-code`, `deepseek-v4.1-flash`, `deepseek-v4-pro`, `mimo-v2.6-pro`, `mimo-v2.6-flash`.
- Default disabled: `mimo-v2.5`, `mimo-v2.5-pro`, `glm-5.2`, `glm-5.1`, `kimi-k2.6`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `hy4-preview`, `hy3`.

### opencode-go-messages

- Base URL: `https://opencode.ai/zen/go/v1`; Access: `api-key`.
- Default enabled: `minimax-m3`, `qwen3.8-max`, `qwen3.8-flash`, `claude-haiku-5-5`.
- Default disabled: `minimax-m2.7`, `minimax-m2.5`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`.

### opencode-go-responses

- Base URL: `https://opencode.ai/zen/go/v1`; Access: `api-key`.
- Default enabled: `gpt-6-luna`, `grok-4.7`.
- Default disabled: `gpt-5.6-luna`, `grok-4.6`.

### opencode-zen-responses

- Base URL: `https://opencode.ai/zen/v1`; Access: `api-key`.
- Default enabled: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`, `grok-4.7`.
- Default disabled: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`, `gpt-5.1`.

### opencode-zen-messages

- Base URL: `https://opencode.ai/zen/v1`; Access: `api-key`.
- Default enabled: `claude-fable-5-1`, `qwen3.7-max`, `qwen3.6-plus`, `qwen3.5-plus`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`.
- Default disabled: `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `qwen3.7-plus`.

### opencode-zen-chat

- Base URL: `https://opencode.ai/zen/v1`; Access: `api-key`.
- Default enabled: `kimi-k3`, `minimax-m3`, `deepseek-v4-pro`, `glm-5.2`, `big-pickle`, `mimo-v2.5-free`, `hy3-free`, `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`, `muse-spark-1.2-contributor-free`, `mimo-v2.6-flash-free`.
- Default disabled: `minimax-m2.7`, `deepseek-v4-flash`, `glm-5.1`, `nemotron-3.5-lightning-free`.

### tencent-tokenhub-cn

- Base URL: `https://tokenhub.tencentmaas.com/v1`; Access: `api-key`.
- Default enabled: `hy3`, `hy4-preview`.
- Default disabled: none.

### tencent-tokenhub-intl

- Base URL: `https://tokenhub-intl.tencentmaas.com/v1`; Access: `api-key`.
- Default enabled: `hy3`, `hy4-preview`.
- Default disabled: none.

### volcengine-ark

- Base URL: `https://ark.cn-beijing.volces.com/api/compatible`; Access: `api-key`.
- Default enabled: `doubao-seed-evolving`, `doubao-seed-2-1-pro-260915`, `doubao-seed-2-1-lite-260915`, `doubao-seed-2-1-turbo-260628`.
- Default disabled: none.

### volcengine-coding-plan

- Base URL: `https://ark.cn-beijing.volces.com/api/coding`; Access: `api-key`.
- Default enabled: `doubao-seed-2.1-pro`, `doubao-seed-2.1-lite`.
- Default disabled: none.

### volcengine-agent-plan

- Base URL: `https://ark.cn-beijing.volces.com/api/plan`; Access: `api-key`.
- Default enabled: `doubao-seed-2.1-pro`, `doubao-seed-2.1-lite`.
- Default disabled: none.

### stepfun

- Base URL: `https://api.stepfun.com`; Access: `api-key`.
- Default enabled: `step-5-preview`, `step-3.7-flash`.
- Default disabled: none.

### stepfun-step-plan

- Base URL: `https://api.stepfun.com/step_plan`; Access: `api-key`.
- Default enabled: `step-5-preview`, `step-3.7-flash`.
- Default disabled: none.

### siliconflow-cn

- Base URL: `https://api.siliconflow.cn/v1`; Access: `api-key`.
- Default enabled: `zai-org/GLM-5.3`, `deepseek-ai/DeepSeek-V4-Flash`, `moonshotai/Kimi-K2.7-Code`.
- Default disabled: none.

### qwen-coding-plan-cn

- Base URL: `https://coding.dashscope.aliyuncs.com/v1`; Access: `api-key`.
- Default enabled: `qwen3.7-plus`.
- Default disabled: none.

### qwen-token-plan-team-cn

- Base URL: `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`; Access: `api-key`.
- Default enabled: `qwen3.8-max`, `qwen3.8-flash`.
- Default disabled: none.

### kimi-code-cn

- Base URL: `https://api.kimi.com/coding/v1`; Access: `api-key`.
- Default enabled: `k3.1-pro`, `k3.1-pro-highspeed`, `k3`, `k3-256k`, `kimi-for-coding`, `kimi-for-coding-highspeed`.
- Default disabled: none.

### kimi-code-intl

- Base URL: `https://api.kimi.ai/coding/v1`; Access: `api-key`.
- Default enabled: `k3.1-pro`, `k3.1-pro-highspeed`, `k3`, `k3-256k`, `kimi-for-coding`, `kimi-for-coding-highspeed`.
- Default disabled: none.

### minimax-m-plan-cn

- Base URL: `https://api.minimax.cn/anthropic`; Access: `api-key`.
- Default enabled: `MiniMax-M3.1-Flash`.
- Default disabled: `MiniMax-M3.1-Flash-Preview`.

## Adjacent fixed-account configuration

This round's maintenance topic is ordinary templates; fixed-account Providers share the Release and model rules, so they are counted and the account system description is not copied. Z.AI / BigModel each have personal, team, Start, off-peak and speed-up card, 10 fixed Providers in total. The test generator covers the production endpoint mapping for these five product paths.

## Known differences and follow-ups

| Item                               | Confirmed fact                                                                                                                                                                                                       | Handling boundary                                                                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default baseline simplification    | Revision 32 implemented the million-window / 128000 max-output baseline, simplified matching and the deletion of two rules                                                                                           | Trade-offs and compatibility boundary are in [Matching and simplification](./configuration.md#matching-and-simplification); no longer a to-do item                                                             |
| List drift                         | Some models and default enablement of the old maintenance list differ from this section; for example GLM-5V-Turbo in the ordinary GLM templates is currently default disabled                                        | Do not auto-change configuration from historical asterisks; changing enablement is a separate behavior MR                                                                                                      |
| Rules detached from static members | zai-api/bigmodel-api each have a default-disabled GLM-5-Turbo rule that is not a current template member; the four personal/team Providers each have GLM-5.2 and GLM-5-Turbo exact rules beyond their static members | First check personal models of the same ID, dynamic members and historical purpose; do not directly judge them orphans and delete                                                                              |
| Historical removal intent          | The original vendor's three M2/M2.1 entries were removed per the retirement list; the M2.5/M2.7 grace and Preview forwarding are recorded separately                                                                 | Removed only within the original-vendor-confirmed scope; old aggregating members are unaffected                                                                                                                |
| MiMo two product entries           | Revision 33 contains the `xiaomi-mimo` ordinary API and the `xiaomi-mimo-token-plan` plan template; revision 35 default enables V2.6 Pro/Flash in both; the ordinary API's V2.5 is now default disabled              | Merged into staging; verified this round by code and tests, which does not mean real-key calls or online adoption of the two products were verified                                                            |
| New vendors/cloud entries          | TokenHub, Ark, StepFun, SiliconFlow and their plans have landed in configuration; Google native and Mistral adaptation are postponed; Azure/Bedrock await concrete resource identities                               | Additions that fit the scope and existing capabilities may proceed directly; the Google direct connection is postponed and protocol/authentication gaps are discussed separately; a candidate is not validated |
| New changes in official catalogs   | 70 members added cumulatively, of which Preview members have become default disabled; other models, regions and plans continue to be verified per entry                                                              | See the [research record](./research.md); added configurations and unverified boundaries are in this round's implementation spec                                                                               |
| Online state                       | On 2026-10-26 the test control plane delivered revision 36, and the Active status and logs of the 3.16.2 Preview confirmed successful adoption; revisions 37–43 are not yet confirmed released                       | The production environment has not released this ordering; later deliveries verify each environment's revision/hash separately                                                                                 |

## Validation state

2026-10-28 revision 43: the TokenHub region naming first triggered 4 failures from the old configuration, and after the fix the configuration-focused tests passed 86 items; affected unit tests passed in 78 files, 1444 items. G149-01 completed creation of the three Go protocols, full member reconciliation and fake-key saving in Linux Electron; it also fixed an old case assertion of the English get-key button. Root types, E2E types, lint, architecture, format and the two-environment generation sync checks passed. All 17 Logo keys of the two configurations have local assets, keeping the existing rule that a dark-mode default uses light assets; the retired Logo unit test file was not restored. No billable model call or configuration release was made.

Revision 37 ordering focus: the production/test sync check passed; 7 files related to vendor configuration, ordering, old-content protection and personal configuration passed 156 tests. A full structural comparison with revision 36 confirmed that only the template block order and the revision changed. Typecheck, lint (191 pre-existing warnings, 0 errors) and architecture checks passed. No UI E2E or revision 37 release was performed; the online observation corresponds to revision 36 only.

The test and validation results of revision 38 are in the [M3.1 Flash spec](./minimax-m31-flash.md#validation-and-delivery). Full content protection has been continued onto the revision 37 baseline, allowing only this round's four additions, three deletions and three enablement changes; historical behavior tests are kept.

The structure, full member inventory and two-environment derivation of the earlier expansion were reconciled against the configuration at that time. Focused tests cover the final capabilities and per-level Maps of the 58 members added cumulatively, template instances, personal overrides and plan isolation; the old configuration summary allows only explicit additions, the approved 19 default-disable changes and stable grouping of affected members. Actual command results and unverified items are recorded together in [this round's implementation spec](./expansion-2026-10-15.md).

The early expansion obtained no key. This round observed a successful real request on the Kimi open platform standard edition followed by upstream overload, but the full Agent, level, media and desktop/mobile acceptance of each entry is not finished; a single success cannot be generalized to all entries passing real measurement. The ordering change only re-verified configuration and added no model requests. Later, per the [validation spec](./validation.md), credentials, product entitlements, streaming, tool passback, per-level thinking and media evidence will be completed.

## Re-check list

From the repository root run the following read-only command, which prints current members and the corresponding exact rules; also check the production/test derivation and do not treat old docs as the configuration source:

```bash
node --input-type=module - <<'JS'
import { readFile } from 'node:fs/promises';
const release = JSON.parse(await readFile('config/provider/zcode-builtin.json', 'utf8'));
const rules = release.config.modelConfigRules.templateModelRules;
for (const template of release.config.providerConfigRules.templateRules) {
  console.log(template.templateId, template.config.api);
  for (const modelId of template.config.builtinModelIds) {
    console.log(modelId, rules.filter(rule =>
      rule.templateId === template.templateId && rule.modelId === modelId));
  }
}
JS
pnpm provider:config:check-test
```
