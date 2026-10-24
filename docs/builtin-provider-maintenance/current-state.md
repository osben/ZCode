# Current Configuration and Maintenance State

New candidates, public-catalog gaps and rule-resolution differences are in the [expansion plan](./expansion-plan.md). The text below still records the actual revision 33 configuration; research suggestions are not yet implemented.

## Baseline and scope of figures

- Check date: 2026-10-14 (Beijing time). Code baseline: staging `68fac8de4fcc69972dc8c0a44b939702d3c571ea`, product source version 3.15.3; this does not mean that version has shipped.
- Production and test are both schemaVersion 1, revision 33. This documentation MR did not change configuration or revision.
- 21 ordinary API templates, 10 fixed-account Providers; 246 template members in total, including models duplicated across templates.
- Model rules 83, Model+API rules 73, production Site rules 54, test Site rules 63, template exact rules 248, fixed Provider exact rules 30.
- Production file SHA-256: `361b778f89496a37540d23a9d309efe6cb8fc97d557119cefbffc67df2f93998`.
- Test file SHA-256: `ae897a66877b52ff4b227e2a972e9a1aa15ac33de7493ab78d72a15dd68c6374`. The hashes are for the baseline Git content (LF); a local CRLF checkout must be normalized to the repository line endings before comparing.

The list is extracted directly from the [production JSON](../../config/provider/zcode-builtin.json). The enablement below comes from template exact rules and excludes user overrides or actual keys/entitlements; being in the list does not mean the entry was validated for real in this round.

## Template summary

| templateId                       | Protocol                  | Members | Default enabled |
| -------------------------------- | ------------------------- | ------- | --------------- |
| `zai-api`                        | `anthropic-messages`      | 2       | 2               |
| `zai-standard-api`               | `openai-chat-completions` | 24      | 2               |
| `bigmodel-api`                   | `anthropic-messages`      | 2       | 2               |
| `bigmodel-standard-api`          | `openai-chat-completions` | 24      | 2               |
| `moonshot-kimi`                  | `anthropic-messages`      | 6       | 3               |
| `minimax`                        | `anthropic-messages`      | 8       | 3               |
| `deepseek`                       | `anthropic-messages`      | 2       | 2               |
| `qwen-alibaba-model-studio-cn`   | `anthropic-messages`      | 13      | 2               |
| `qwen-alibaba-model-studio-intl` | `openai-chat-completions` | 14      | 2               |
| `xiaomi-mimo`                    | `anthropic-messages`      | 4       | 4               |
| `xiaomi-mimo-token-plan`         | `anthropic-messages`      | 2       | 2               |
| `openai`                         | `openai-responses`        | 10      | 4               |
| `anthropic`                      | `anthropic-messages`      | 5       | 5               |
| `xai`                            | `openai-responses`        | 3       | 2               |
| `openrouter`                     | `anthropic-messages`      | 59      | 11              |
| `opencode-go-chat`               | `openai-chat-completions` | 15      | 8               |
| `opencode-go-messages`           | `anthropic-messages`      | 8       | 3               |
| `opencode-go-responses`          | `openai-responses`        | 2       | 2               |
| `opencode-zen-responses`         | `openai-responses`        | 14      | 2               |
| `opencode-zen-messages`          | `anthropic-messages`      | 15      | 5               |
| `opencode-zen-chat`              | `openai-chat-completions` | 14      | 10              |

## Full members and default enablement

All template members are kept here to ease review of additions and removals; capabilities and parameters are not copied into a second configuration and are resolved per the [rule contract](./configuration.md). Later configuration MRs update this section, the summary and the baseline together.

### zai-api

- Base URL: `https://api.z.ai/api/anthropic`; Access: `zhipu-coding-plan-api-key`.
- Default enabled: `GLM-5.3`, `GLM-5.3-Flash`.
- Default disabled: none.

### zai-standard-api

- Base URL: `https://api.z.ai/api/paas/v4`; Access: `api-key`.
- Default enabled: `GLM-5.3`, `GLM-5.3-Flash`.
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
- Default enabled: `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`.
- Default disabled: `kimi-k2.7-code-highspeed`, `k3`, `k3-256k`.

### minimax

- Base URL: `https://api.minimaxi.com/anthropic`; Access: `api-key`.
- Default enabled: `MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`.
- Default disabled: `MiniMax-M2.5`, `MiniMax-M2.5-highspeed`, `MiniMax-M2.1`, `MiniMax-M2.1-highspeed`, `MiniMax-M2`.

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
- Default enabled: `mimo-v2.6-pro`, `mimo-v2.6-flash`, `mimo-v2.5-pro`, `mimo-v2.5`.
- Default disabled: none.

### xiaomi-mimo-token-plan

- Base URL: `https://token-plan-cn.xiaomimimo.com/anthropic`; Access: `api-key`.
- Default enabled: `mimo-v2.6-pro`, `mimo-v2.6-flash`.
- Default disabled: none.

### openai

- Base URL: `https://api.openai.com/v1`; Access: `api-key`.
- Default enabled: `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.
- Default disabled: `gpt-5.6`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex`.

### anthropic

- Base URL: `https://api.anthropic.com/v1`; Access: `api-key`.
- Default enabled: `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`.
- Default disabled: none.

### xai

- Base URL: `https://api.x.ai/v1`; Access: `api-key`.
- Default enabled: `grok-4.6`, `grok-build-0.1`.
- Default disabled: `grok-4.3`.

### openrouter

- Base URL: `https://openrouter.ai/api`; Access: `api-key`.
- Default enabled: `anthropic/claude-fable-5.1`, `openai/gpt-6-astra`, `openai/gpt-5.6-sol`, `anthropic/claude-opus-5`, `deepseek/deepseek-v4-pro`, `moonshotai/kimi-k3`, `z-ai/glm-5.3`, `qwen/qwen3.8-max`, `minimax/minimax-m3`, `xiaomi/mimo-v2.5-pro`, `x-ai/grok-4.6`.
- Default disabled: `deepseek/deepseek-v4.1-flash`, `qwen/qwen3.8-max-0902`, `openai/gpt-5.6-terra`, `openai/gpt-5.6-luna`, `openai/gpt-5.6`, `openai/gpt-5.4`, `openai/gpt-5.4-pro`, `openai/gpt-5.4-mini`, `openai/gpt-5.4-nano`, `openai/gpt-5.3-codex`, `anthropic/claude-sonnet-5`, `anthropic/claude-haiku-4.5`, `anthropic/claude-opus-4.8`, `anthropic/claude-opus-4.7`, `anthropic/claude-opus-4.6`, `anthropic/claude-opus-4.5`, `anthropic/claude-sonnet-4.6`, `anthropic/claude-sonnet-4.5`, `deepseek/deepseek-v4-flash`, `moonshotai/kimi-k2.7-code`, `moonshotai/kimi-k2.6`, `moonshotai/kimi-k2.5`, `z-ai/glm-5.3-flash`, `z-ai/glm-5.2`, `z-ai/glm-5.1`, `z-ai/glm-5v-turbo`, `z-ai/glm-5`, `z-ai/glm-5-turbo`, `z-ai/glm-4.7`, `z-ai/glm-4.7-flash`, `z-ai/glm-4.6`, `z-ai/glm-4.6v`, `z-ai/glm-4.5-air`, `z-ai/glm-4.5`, `qwen/qwen3.8-flash`, `qwen/qwen3.7-max`, `qwen/qwen3.7-plus`, `qwen/qwen3.7-flash`, `qwen/qwen3.6-plus`, `qwen/qwen3.6-flash`, `qwen/qwen3.5-plus-20260420`, `qwen/qwen3-vl-plus`, `qwen/qwen3-vl-flash`, `minimax/minimax-m2.7`, `minimax/minimax-m2.5`, `xiaomi/mimo-v2.5`, `x-ai/grok-build-0.1`, `x-ai/grok-4.3`.

### opencode-go-chat

- Base URL: `https://opencode.ai/zen/go/v1`; Access: `api-key`.
- Default enabled: `glm-5.3-flash`, `glm-5.3`, `kimi-k3`, `kimi-k2.7-code`, `deepseek-v4.1-flash`, `deepseek-v4-pro`, `mimo-v2.5`, `mimo-v2.5-pro`.
- Default disabled: `glm-5.2`, `glm-5.1`, `kimi-k2.6`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `hy4-preview`, `hy3`.

### opencode-go-messages

- Base URL: `https://opencode.ai/zen/go/v1`; Access: `api-key`.
- Default enabled: `minimax-m3`, `qwen3.8-max`, `qwen3.8-flash`.
- Default disabled: `minimax-m2.7`, `minimax-m2.5`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`.

### opencode-go-responses

- Base URL: `https://opencode.ai/zen/go/v1`; Access: `api-key`.
- Default enabled: `gpt-5.6-luna`, `grok-4.6`.
- Default disabled: none.

### opencode-zen-responses

- Base URL: `https://opencode.ai/zen/v1`; Access: `api-key`.
- Default enabled: `gpt-6-astra`, `gpt-5.6-sol`.
- Default disabled: `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`, `gpt-5.1`.

### opencode-zen-messages

- Base URL: `https://opencode.ai/zen/v1`; Access: `api-key`.
- Default enabled: `claude-fable-5-1`, `claude-fable-5`, `qwen3.7-max`, `qwen3.6-plus`, `qwen3.5-plus`.
- Default disabled: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `qwen3.7-plus`.

### opencode-zen-chat

- Base URL: `https://opencode.ai/zen/v1`; Access: `api-key`.
- Default enabled: `kimi-k3`, `minimax-m3`, `deepseek-v4-pro`, `glm-5.2`, `big-pickle`, `mimo-v2.5-free`, `hy3-free`, `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`, `muse-spark-1.2-contributor-free`.
- Default disabled: `minimax-m2.7`, `deepseek-v4-flash`, `glm-5.1`, `nemotron-3.5-lightning-free`.

## Adjacent fixed-account configuration

This round's maintenance topic is ordinary templates; fixed-account Providers share the Release and model rules, so they are counted and the account system description is not copied. Z.AI / BigModel each have personal, team, Start, off-peak and speed-up card, 10 fixed Providers in total. The test generator covers the production endpoint mapping for these five product paths.

## Known differences and follow-ups

| Item | Confirmed fact | Handling boundary |
| --- | --- | --- |
| Default baseline simplification | Revision 32 implemented the million-window / 128000 max-output baseline, simplified matching and the deletion of two rules | Trade-offs and compatibility boundary are in [Matching and simplification](./configuration.md#matching-and-simplification); no longer a to-do item |
| List drift | Some models and default enablement of the old maintenance list differ from this section; for example GLM-5V-Turbo in the ordinary GLM templates is currently default disabled | Do not auto-change configuration from historical asterisks; changing enablement is a separate behavior MR |
| Rules detached from static members | zai-api/bigmodel-api each have a default-disabled GLM-5-Turbo rule that is not a current template member; the four personal/team Providers each have GLM-5.2 and GLM-5-Turbo exact rules beyond their static members | First check personal models of the same ID, dynamic members and historical purpose; do not directly judge them orphans and delete |
| Historical removal intent | The deletion segment of the old inventory differs from members currently kept such as MiniMax M2.1/M2 | Re-verify the upstream entry and the product decision; do not delete in a documentation MR |
| MiMo two product entries | Revision 33 contains the `xiaomi-mimo` ordinary API and the `xiaomi-mimo-token-plan` plan template; the former enables V2.6 Pro/Flash and V2.5 Pro/V2.5, the latter enables V2.6 Pro/Flash | Merged into staging; verified this round by code and tests, which does not mean real-key calls or online adoption of the two products were verified |
| New vendors/cloud entries | Gemini and Mistral have no built-in template; Azure/Ark/Bedrock are still candidates | Additions the existing execution chain supports directly may proceed; paths needing extra adaptation are postponed; a candidate is not validated |
| New changes in official catalogs | OpenAI, Anthropic, Z.AI, xAI, MiMo, OpenCode have items to re-check | See the [research record](./research.md); not a validated configuration change |
| Online state | This round did not query the production/test control plane or actual installers | Do not infer online revision 33 from source revision 33 |

## Validation state

The configuration structure, template members and rule statistics of this baseline were checked statically; `pnpm provider:config:check-test` passed this round, and all members of the 21 templates, the default enablement and the two configuration hashes were reconciled item by item with the text. The targeted unit tests of the historical capacity simplification and the Linux desktop validation do not count toward this round's pass result and do not equal current measurement for all vendors.

After syncing revision 33, formal configuration completeness and the MiMo two-template tests passed, 2 files / 17 items; rerunning the completeness test on the specified test configuration passed, 1 file / 15 items. The MiMo tests include members of both environments, parameter Maps and preservation of old-instance overrides. The two configurations and the MiMo unit/browser cases are fully identical to this baseline staging, and this documentation MR did not delete or roll back them.

No API key was obtained this round, no billable API request was run, and the full Agent, desktop/mobile and cross-system acceptance of each vendor was not rerun. New maintenance items must add their own [validation evidence](./validation.md) in their own records.

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
