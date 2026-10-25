# Coding Plan Usage Layout

## Background

The Coding Plan panel of the Usage settings page shows three quota cards: 5 hours, weekly and MCP quota. The card body shows the remaining quota percentage and reset time, not the total quota, so the title and card names must state "remaining" or the quota type clearly.

The same page also shows the Model Usage and Tool Usage time series. `today / 7d / 30d` affects only these two usage trends and must not visually cover `Quota Remaining`, otherwise users may think switching the time range also filters the remaining quota.

## Spec

- In the Model Provider plan card, the small title rows of 5 hours, weekly, tool calls and ZCode MCP all use `min-h-6` (at least 24px, growing with content at large font sizes), with text, reset entry and info icon vertically centered; desktop and mobile Web share this height.
- The Coding Plan usage panel shows the main title "剩余额度" (remaining quota) above the quota card group, and shows the current Coding Plan provider on the same title row.
- Title text must go through i18n and not be hard-coded into the component.
- `Quota Remaining` and `Usage Trends` use a stronger title level than Model Usage / Tool Usage.
- Quota card names express the remaining-quota period or quota type: 5 hours remaining, weekly remaining, tool calls.
- Quota cards keep their original data source and calculation and continue to show the remaining percentage and reset time.
- Model Usage and Tool Usage belong to the same `Usage Trends` area.
- `today / 7d / 30d` and the refresh button sit on the `Usage Trends` title row, showing that they control trend data.
- The top no longer shows a separate provider area; the provider name or multi-provider switch entry merges into the `Quota Remaining` title row.
- `Quota Remaining` prefers the entitlement quota snapshot and does not depend on the range snapshot of `Usage Trends`.
- When opening `Settings -> Usage -> Coding Plan`, the page must actively reconcile the current provider's entitlement quota; the trend data on the same page keeps being requested on page mount.
- The refresh button on the `Usage Trends` title row must refresh both the trend data and the current provider's entitlement quota, so the chart below does not update while `Quota Remaining` still shows an old snapshot.
- Switching `today / 7d / 30d` for the same provider keeps the previous trend snapshot, so the page content does not flash empty.
- Desktop may keep multiple columns; narrow screens must drop to a single column automatically, so the three cards do not crowd mobile Web.

## Acceptance

- When any quota card can be shown, the remaining-quota main title and the current provider show above the card group.
- With no quota card, the whole quota area is still not rendered.
- `Usage Trends` main title shows above Model Usage and Tool Usage.
- The `today / 7d / 30d` switch sits on the `Usage Trends` title row, not the page-top provider row.
- Switching `today / 7d / 30d` does not clear or flash the `Quota Remaining` area.
- After entering the Coding Plan Usage page, `Quota Remaining` reconciles once bypassing the shared TTL; after clicking the refresh button, `Quota Remaining` and the trend charts update together.
- The English and Chinese UI both show the matching quota text; the in-plan monthly MCP tool quota is shown uniformly as "工具调用 / Tool calls" and no longer as "MCP 额度 / MCP quota"; the separate official Server MCP daily quota keeps the brand name "ZCode MCP".
- In both Usage stats and the Model Provider plan card, the `ZCode MCP` title is followed by an info icon; on hover or keyboard focus it reuses `ControlHintTooltip` and `sidebar.usage.plan.zcodeMcpDescription`, consistent with the quota description in the composer context.
