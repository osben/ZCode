# App Usage: migrate the data source to the zcode agent database

Date: 2026-06-02. Branch: feat/new-agent

## Goal and background

The App Usage panel was fed by local session JSON files (`~/.zcode/sessions/*.json`) aggregated by
the host's `usageStatsAggregator.ts` with a chars/3 token estimate. The zcode agent observability
database (migration `0010_usage_observability`, retention 30 days via `USAGE_RETENTION_DAYS = 30`)
now records real usage:

- `model_usage` — real tokens (input/output/reasoning/cache read+write), provider/model,
  query_source, status, latency (duration, TTFT), retries, errors.
- `turn_usage` — per user turn: tool calls/errors, tokens, latency.
- `tool_usage` — per tool call: tool name, approval state, read-only vs destructive, duration,
  output bytes, errors.

The panel's data source is fully replaced by agent-database statistics: the character-estimation
pipeline is removed, and real token splits, tool-usage stats, and reliability metrics are added.

## Confirmed decisions

1. Retention conflict → UI adapts to 30 days: range filter becomes `7d / 30d` (no "all"); heatmap
   shrinks from 52 weeks to 30 days. The DB retention period is not changed.
2. New metrics: real token split + tool usage + quality/reliability. No split by query_source
   (main conversation / compaction / sub-agent / workflow).
3. Heatmap: 30-day calendar grid (~5 columns, GitHub style), each cell = the day's real token total.
4. Data path: a new ZCode Protocol method; the agent side aggregates in SQL and returns the result.

## Architecture and data flow

The host never opens the agent's SQLite directly — the agent is a separate child process reached
only via ZCode Protocol (stdio JSON-RPC), like `session/list`. Aggregation happens on the agent side
in SQL (saves stdio transfer, naturally bounds to 30 days):

```
old: useAppUsageStats → usageStatsService.getAppUsageSnapshot()
       → readPersistedSessionFiles(~/.zcode/sessions/*.json)        [deleted]
       → buildUsageStatsSnapshot() chars/3 estimate                  [deleted]

new: useAppUsageStats → usageStatsService.getAppUsageSnapshot()
       → zcodeProtocolClient.request("usage/stats", {range,timeZone})  [new protocol method]
       → [agent child] handler → SessionStore read methods
       → SQL GROUP BY over model_usage / turn_usage / tool_usage      [real data]
       → returns AppUsageSnapshot
```

Rejected alternative: the host opening `default.db` read-only — concurrent access with the agent,
duplicate schema coupling, and it violates the "new data goes through ZCode Protocol" rule.

## Metric changes

Summary keeps 8 cards:

| Card                                                                              | Source                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Real tokens (total; subtitle split input/output/cache)                            | `model_usage.computed_total_tokens` etc.                     |
| Conversation turns (replaces message count)                                       | `turn_usage` row count                                       |
| Sessions                                                                          | distinct `session_id`                                        |
| Active days                                                                       | distinct day(`started_at`)                                   |
| Consecutive active days (30d; merges current/longest streak)                      | day(`started_at`)                                            |
| Cache hit rate (replaces peak-hour card)                                          | `cache_read / (input + cache_creation + cache_read)`         |
| Most used model (by real tokens)                                                  | `model_usage` GROUP BY model                                 |
| Tool calls (total + error rate) and/or reliability (model error rate / mean TTFT) | `tool_usage`; `model_usage.status`, `time_to_first_token_ms` |

Of the 9 candidates, 8 are kept: streak and reliability are preferred because tool usage has its
own section; the exact pick may be tuned without affecting the architecture.

Heatmap: 52-week calendar and chars-based `activityScore` deleted; 30-day grid colored by daily
`computed_total_tokens`, tooltip shows tokens / turns / tool calls.

Trend: keeps the per-model stacked daily bars, now on real tokens; range tabs lose "all" (`7d`/`30d`);
bucketing simplified to daily.

New 4th section, Tool Usage: top tools by call count, error rate, mean duration; horizontal bars +
small table.

## Files

Agent side: `UsageStorePort` gains read-only aggregate methods and result types
(`apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`); SQL aggregation with
GROUP BY day/model/tool and 30-day + range filters (`adapters/src/storage/session-store/repositories/usage.ts`,
proxied by `sqlite-session-store.ts`); the `usage/stats` protocol method with zod schemas registered
in `zcodeProtocolMethods` (`packages/shared/src/zcode-protocol/index.ts`) plus its agent handler.

Host side: `getAppUsageSnapshot()` switches to the protocol client
(`packages/services/src/usage-stats/usageStatsService.ts`); deleted: `usageStatsAggregator.ts`,
`repo/sessionUsageRepo.ts`, `usageStatsSeries.ts`, and the estimate constants
(`ESTIMATED_TOKEN_CHAR_DIVISOR`, `estimateTokensFromCharacterCount`). Types updated in
`packages/shared/src/usage-stats.ts` (estimation fields out; token split / cache hit / tools /
reliability in).

UI: `AppUsagePanel.tsx` (new summary cards; `UsageStatsRange` = `"7d" | "30d"`),
`usageStatsUiParts.tsx` (30-day heatmap; tool-usage section), `AppUsageDailyModelBarChart.tsx` (real
tokens); i18n keys adjusted (`settings.usage.range.all` removed).

Unchanged: the Coding Plan tab and the BigModel monitor API line.

## Tests

- Agent SQL aggregation against in-memory SQLite seeded with known rows (mirrors existing usage
  repository tests).
- Protocol: `usage/stats` schema round-trips.
- Host service: mock protocol client, assert `getAppUsageSnapshot` field mapping.
- UI: snapshot rendering (summary cards / 30-day heatmap / trend / tool table).

## Risks and notes

- 30-day retention means older data is never visible; copy must say "last 30 days".
- Real tokens are not comparable with the old estimate; a visible break in history is expected.
- `turn_usage` turns differ semantically from the old "message count"; copy must follow.
- Agent not running / empty DB needs empty and error states (reuse `UsageStatsErrorNotice`).
