# Chat Input Context Coding Plan Usage

## Background

The composer's context usage popover can show the current task context usage, the Start Plan daily balance and the Coding Plan remaining quota together. The sidebar footer no longer shows Usage Remaining, to avoid duplicating the Usage page and the composer context.

The composer popover is different: it sits close to the current message-sending model, so the Coding Plan remaining quota it shows must follow the provider of the model the user currently selected, and must not appear just because the account holds another vendor's Coding Plan entitlement.

## Rules

- When the selected model provider is `builtin:zai-coding-plan`, the context usage popover may show the Z.ai Coding Plan remaining quota.
- When the selected model provider is `builtin:bigmodel-coding-plan`, it may show the BigModel Coding Plan remaining quota.
- When the current BigModel family connection selects `team-plan:builtin:bigmodel-coding-plan:*`, the popover must show the remaining quota of that Team Plan team project; having no personal Coding Plan entitlement must not make the Team Plan popover entry disappear.
- When the selected provider is Start Plan, a plain API Key, a custom provider or any other non-Coding-Plan provider, no paid Coding Plan remaining quota is shown.
- Start Plan keeps its own Start Plan balance panel and does not reuse the paid Coding Plan quota display.
- The sidebar footer keeps only the upgrade/renew entry and the plan badge next to the account; remaining-quota details are viewed from the Usage page or the composer context.

## Implementation constraints

- The Coding Plan provider for context usage is resolved from the current model value or the custom supplier key.
- The result accepts only paid Coding Plan provider ids; Start Plan is not mapped back to the same-brand paid Coding Plan.
- BigModel Team Plan is not a new provider id; it reuses the `builtin:bigmodel-coding-plan` model catalog and expresses the concrete team project through the team source key in `modelProviderFamilySelectedKeys.bigmodel`.
- A Team Plan quota query must carry the matching `organizationId` / `projectId` so the service layer copies and uses the team project API Key; it must not use only the personal/default context of `builtin:bigmodel-coding-plan`.
- The provider and entitlement passed to the context panel must be filtered to the paid Coding Plan provider or Team Plan source of the current model, so `resolveCodingPlanUsageRemainingState` does not automatically fall back to another provider that has an entitlement.

## Quota popover layout

- The context usage popover is fixed at `w-80` (320px) and must not widen when the official Server MCP quota appears.
- The 5-hour, Weekly, Tool calls and official Server MCP quotas share a grid of at most three columns: with fewer than three main quotas MCP joins the same row and uses one to three columns by total card count; with three main quotas MCP takes the next row spanning three columns.
- MCP on the same row as main quotas uses the same vertical card structure: title with info icon, remaining percentage with reset date, progress bar; spanning a whole row it uses the compact horizontal order `ZCode MCP -> remaining percentage · reset date -> progress bar`.
- The MCP row's percentage and progress bar keep the "remaining" meaning; the progress bar reuses the chart palette's warm yellow `--color-usage-chart-5` with no separate MCP color variable. When date space is short it may truncate, and the progress bar keeps priority for readable width.
- With 3 main quotas, the MCP spanning row's progress bar must equal the width of a single card's progress bar above, consistent with the `(100% - 16px) / 3` and `gap-2` grid.
- The MCP spanning row has no separate background container; a top `border-border` divider separates it from the three quotas above. Same-row cards add no divider, keeping the grid rhythm of adjacent quotas.
- The `ZCode MCP` name matches the "5 hours / weekly" titles above, using `text-foreground-subtle` without extra bold; no gold gradient or shimmer, yellow remains only on the progress bar.
- The info icon follows the `ZCode MCP` name; on hover or keyboard focus the shared `ControlHintTooltip` shows "ZCode 预置插件 MCP 每日合计额度" (daily total quota of the ZCode preset plugin MCP). The text must be internationalized in Chinese and English, and the icon must not squeeze the remaining amount and progress bar on the right.
- Desktop and mobile Web share the same compact layout, with no single-platform width branch.
