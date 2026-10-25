# English-only model-visible tool text

## Problem

The tool definitions sent to the model (`tools[].description` and
`tools[].input_schema.properties.*.description`) contained Chinese trigger phrases
and examples (`使用 workflow`, `8分钟后`, `闲时任务`, `每20分钟提醒我喝水`, …).
They show up in the model trajectory (Schema tab) and mix two languages into the
provider payload.

## Rules

- Everything the model sees in a tool definition is English. This covers tool
  descriptions, schema field descriptions and the bundled skill text that restates
  the same routing rule.
- Routing and scheduling rules are written language-agnostically ("in any
  language", "the user's own wording") instead of listing non-English phrases. The
  model recognises the intent from the English description whatever language the
  user writes in.
- User-supplied text (prompts, titles) is still preserved verbatim; only the
  instruction text is English.
- Code comments and unrelated Chinese content are out of scope.

## Owners

| Surface                       | File                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------- |
| Agent tool routing hint       | `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts`                       |
| CreateWorkflow description    | `apps/zcode-cli/packages/core/src/tool/handlers/create-workflow-description.ts` |
| Cron description              | `apps/zcode-cli/packages/core/src/tool/handlers/cron.ts`                        |
| Off-peak description          | `apps/zcode-cli/packages/core/src/tool/handlers/off-peak.ts`                    |
| Cron / off-peak schema fields | `apps/zcode-cli/packages/contracts/src/tools/automation.ts`, `.../off-peak.ts`  |
| Dynamic workflows skill       | `apps/zcode-cli/packages/bundled-skills/skills/dynamic-workflows/SKILL.md`      |

## Acceptance

1. Serialising every registered tool definition (description + schema) yields no
   CJK character (guarded by a test).
2. Existing routing assertions still hold with the English wording
   (`workflow-routing-hints`, automation and off-peak tests).
3. A fresh trajectory request shows no Chinese in the Schema tab.
