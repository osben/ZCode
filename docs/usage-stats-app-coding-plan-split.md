# Usage statistics: App Usage / Coding Plan split

## Goal

The Settings "Usage statistics" page is split into two independent chains:

- App Usage: reads only the local session history and shows in-product usage activity.
- Coding Plan: reads only the currently selected Coding Plan provider and shows plan quota and monitor usage.

Coding Plan does not fall back to App Usage, local sessions, an ordinary Z.AI/BigModel API Key or an environment variable key.

## Top layout

```text
Usage statistics    [ App Usage | Coding Plan | Project A | Project B ]
App Usage:  [ all-time summary ] [ 30d / 7d ]
Coding Plan:                         [ today / 7d / 30d ]
```

- The main tabs expand the account-level statistics sources: `App Usage`, the personal Coding Plan, and each subscribed Team Plan project.
- The Coding Plan tab no longer follows the current workspace connection mode; the current API Key, Start Plan or Team Plan selection does not hide the personal / team usage sources the account owns.
- App Usage's all-time overview is fixed above the time range control.
- Coding Plan's time range stays `today` / `7d` / `30d` and does not use App Usage's all-time overview scope.

## App Usage

```text
[ Total Tokens ] [ Peak Tokens ] [ Longest chat duration ] [ Current streak days ] [ Longest streak days ]
  // Always reads all data within the current usage DB retention, unaffected by the time range switch below.

[ Token Activity / Calendar Grid ]                  [ Daily / Weekly / Cumulative ]
  // independent range control, reads range=all, first row is Sunday, bottom row shows month labels.
  // Daily: one cell is one day. Weekly: one column is that week's total. Cumulative: one column is total through that week.

[ Time range: 7d | 30d | 90d | 1y | All | Custom ]   [ Compare ] [ Day | Week | Month ]
[ Filters: Models | Providers | Source | Workspaces ]   // options from the all-time snapshot facets

[ Daily Token Trend Chart ]

[ Details: 8 metric tiles ]
  input / output / cache hit rate / avg turn duration / avg first token / tool calls / tool error rate / model error rate

[ Model Usage Pie Chart ]
  donut chart                                model name + tokens + percent

[ Tools table ]
  tool | calls | errors | avg duration      // top 8, expandable

[ Activity by hour ]   7 x 24 weekday/hour grid, busiest cell caption
[ Busiest sessions ]   top 10 by tokens
[ Refresh ] [ Export CSV ] [ Export JSON ]
```

- In the zh-CN summary metrics, a compact Token value needs one space between the number and the unit
  (for example `3.7 亿`), consistent with the unit spacing of the duration and day metrics; other
  Token scenarios that stress compact display are not affected by this rule.
- The trend chart's plot area keeps a 24px safe zone on each side so the first and last date ticks show
  completely on desktop and mobile Web and are not clipped by the SVG boundary; the time range tabs
  below use the pill style, sized to match task tabs.
- The all-time overview row sits above the time range control and uses the `range=all` App Usage
  snapshot; it shows aggregate metrics only and does not change the 7d/30d chart window below.
- The all-time overview row has no outer frame, its container uses `rounded-xl`; when laid out
  horizontally on desktop, metrics are separated by a standalone `w-px h-7` vertical line, not border classes.
- Token activity sits below the all-time overview and uses an independent `Daily / Weekly / Cumulative`
  range switch (zh-CN `每日 / 每周 / 累计`); it reads the `range=all` heatmap data and is unaffected by
  the `Last 7 days / Last 30 days` chart range below.
- The Token activity grid fixedly shows the latest 52 natural weeks, aligned uniformly to natural weeks
  with Sunday as the first row; the 52 columns split the container equally with no horizontal scrolling,
  and months show at the bottom. `Weekly` mode fills a whole column bottom-up by the week's total;
  `Cumulative` mode fills a whole column bottom-up by cumulative Tokens through that week; in both
  modes hovering any cell highlights the whole column and the tooltip anchors to the column container.
  The tooltip has a two-line structure: the first line shows the date/week range and the second line
  shows the Token count and message-turn count.
- `Longest chat duration` takes the maximum over sessions of the sum of the completed turns'
  `duration_ms` within the same session, so a single turn's time is not mistaken for a whole chat's duration.

Data source: aggregated from the local session repo.

## Coding Plan

```text
[ Z.AI | BigModel ]   // shown only when both Coding Plan accounts are available

[ 5-hour remaining quota ]  [ Weekly remaining quota ]  [ Tool calls ]
  remaining percent           remaining percent           remaining percent
  remaining progress          remaining progress          remaining progress
  reset time (only the Usage stats settings page uniformly shows month-day + time, e.g. "9月16日 23:00"; not shown when nextResetTime is missing)

Model usage
[ Total Token consumption ] [ Top Model 1 ] [ Top Model 2 ] [ Top Model 3 ... ]
[ Multi-line Model Usage Chart ]

Tool usage
[ Web search MCP ] [ Web reader MCP ] [ Open-source repo MCP ... ]
[ Multi-line Tool Usage Chart ]
```

The Coding Plan status card in Settings Model Providers also shows the same group of quota remaining
amounts. The three progress bars must reuse the usage chart palette in order:

- 5-hour quota: `--color-usage-chart-1`
- weekly quota: `--color-usage-chart-2`
- tool calls (monthly): `--color-usage-chart-3`
- ZCode MCP daily quota: `--color-usage-chart-5` (warm yellow of the chart palette)

The Start Plan balance card keeps the success green and does not follow the Coding Plan multi-color quota palette.

Data sources:

- quota: the plan quota card. `percentage` is the used ratio returned by the server; the frontend must invert it to show the remaining quota percentage.
- `/api/monitor/usage/model-usage`: model usage trend and summary.
- `/api/monitor/usage/tool-usage`: tool usage trend and summary.

Only the new monitor fields are used: `x_time`, `granularity`, `modelDataList`, `modelSummaryList`, `toolDataList`, `toolSummaryList`.

## Provider / Source rules

An available Coding Plan provider must satisfy:

- provider id is `zaiCodingPlan` or `bigmodelCodingPlan`.
- provider enabled.
- provider apiKey non-empty.

Rules:

- The personal Coding Plan source comes from the active entitlement, and the tab label defaults to
  `Coding Plan`; if several personal sources exist at once, they can be distinguished by provider name.
- A Team Plan source comes from a subscribed enterprise plan project, and the tab label uses only the
  organization name; when the organization name is missing, the project name, organization / project ID,
  product name or `Team Plan` is not used as a fallback.
- A Team Plan request must carry `organizationId` / `projectId`, and a personal Coding Plan request carries no team context.
