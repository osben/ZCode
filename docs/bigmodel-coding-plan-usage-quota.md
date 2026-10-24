# BigModel Coding Plan usage quota integration

## Background

ZCode's "Plan usage" must show the user's real GLM Coding Plan usage, not local session estimates. The integration queries the BigModel quota API directly with the user's configured Z.AI / BigModel provider API key — no Z.AI OAuth token, no change to the existing login/auth flow.

## API

```http
GET <host>/api/monitor/usage/quota/limit
authorization: <full API key>
```

- Domestic host: `https://bigmodel.cn` or `https://open.bigmodel.cn`. Overseas / Z.AI host: `https://api.z.ai`.
- Domestic and overseas share the path, method, and response structure; the same key works on both hosts, with only the `msg` copy language possibly differing.
- The `authorization` header carries the full API key in the `<id>.<secret>` form. Do not add the `Bearer` prefix — this endpoint fails auth with it.
- ZCode prefers the `builtin:zai` API key from the current model provider config, then `builtin:bigmodel`, then custom providers whose endpoint points at `bigmodel.cn` or `api.z.ai`.
- `builtin:zai` and `api.z.ai`-endpoint providers default to `https://api.z.ai/api/monitor/usage/quota/limit`; other BigModel providers default to the environment's BigModel API main domain — `https://bigmodel.cn/api/monitor/usage/quota/limit` in production and under `ZCODE_ENV=test`.
- Local debugging can override the key with `ZCODE_BIGMODEL_USAGE_API_KEY` or `BIGMODEL_USAGE_API_KEY`, and the endpoint with `ZCODE_BIGMODEL_USAGE_QUOTA_URL` or `BIGMODEL_USAGE_QUOTA_URL`.

## Response parsing

Success example:

```json
{
  "code": 200,
  "msg": "操作成功",
  "data": {
    "limits": [
      {
        "type": "TOKENS_LIMIT",
        "unit": 3,
        "number": 5,
        "percentage": 1,
        "nextResetTime": 1778753640304
      },
      {
        "type": "TIME_LIMIT",
        "unit": 5,
        "number": 1,
        "usage": 100,
        "currentValue": 0,
        "remaining": 100,
        "percentage": 0,
        "nextResetTime": 1781345721976,
        "usageDetails": [
          { "modelCode": "search-prime", "usage": 0 },
          { "modelCode": "web-reader", "usage": 0 },
          { "modelCode": "zread", "usage": 0 }
        ]
      }
    ],
    "level": "lite"
  },
  "success": true
}
```

Field semantics:

| Field                              | Meaning                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `data.level`                       | GLM Coding Plan tier, e.g. `lite`, `pro`, `max`                          |
| `unit=3`                           | hour dimension; `number` is hours                                        |
| `unit=5`                           | month dimension; `number` is months                                      |
| `unit=6`                           | week dimension; `number` is weeks                                        |
| `TOKENS_LIMIT + unit=3 + number=5` | 5-hour prompt pool                                                       |
| `TOKENS_LIMIT + unit=6 + number=1` | 1-week prompt pool; not returned for some accounts, hide it when missing |
| `TIME_LIMIT + unit=5 + number=1`   | MCP / tools monthly quota pool                                           |
| `TIME_LIMIT.remaining`             | remaining tool quota                                                     |
| `TIME_LIMIT.percentage`            | used percentage of tool quota                                            |
| `TIME_LIMIT.nextResetTime`         | next tool-quota reset, ms timestamp                                      |
| `TIME_LIMIT.usageDetails`          | per-item tool usage, e.g. web search, web reader, open-repo MCP          |

`nextResetTime` is optional. The frontend must not use it to judge whether a quota item is valid; if missing, only hide that item's reset time.

## Tier display

The frontend uses only the API's `level` as the current real tier. Tier descriptions help the user and never replace the API value:

| Tier | 5-hour prompt pool | MCP / tools monthly | Concurrency priority |
| ---- | -----------------: | ------------------: | -------------------- |
| Lite |          ~120 uses |           100/month | low                  |
| Pro  |          ~600 uses |          1000/month | medium               |
| Max  |         ~2400 uses |          4000/month | high                 |

These numbers may change with platform policy; the latest wording follows the official Z.AI / BigModel usage docs.

## Frontend display

Coding Plan remaining quota uses one display basis across Model Provider, sidebar, and the composer context panel:

- Current tier: `data.level`
- 5-hour pool: `percentage` and `nextResetTime` of `TOKENS_LIMIT + unit=3 + number=5`
- Weekly pool: `percentage` and `nextResetTime` of `TOKENS_LIMIT + unit=6 + number=1`
- Tool calls: `remaining / usage` and `nextResetTime` of `TIME_LIMIT + unit=5 + number=1`

Only quota items returned and identifiable by `type + unit + number` are displayed. A missing item is hidden — never fall back to `limits` array indexes or render three fixed empty cards. Model Provider, sidebar, and the context panel then show the same item count for the same quota data.

Settings "Usage stats" shows:

- Remaining tool quota, tier, next reset time, 5-hour prompt pool used percentage
- MCP / tools quota notes
- `usageDetails` per-item usage
- Local session usage stats

When both Z.AI and BigModel sources are enabled with API keys, settings shows a source switch. Entitlement cards, model usage, tool usage, and refresh all follow the selected source, so a dual setup never implicitly shows only the first provider's data.

Coding Plan "Usage stats" keeps the `getCodingPlanUsageSnapshot` / `useCodingPlanUsageStats` entry and cache strategy, with the data sources aligned to BigModel's official personal usage page:

| Page area                   | API                                        | Notes                                                                                                                                               |
| --------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remaining quota card        | `/api/monitor/usage/quota/limit`           | 5-hour, weekly, MCP monthly only. `percentage` is used percentage; ZCode's `Usage remaining` view must uniformly invert it to remaining percentage. |
| Token activity              | `/api/monitor/credit-usage/activity`       | 365-day activity series and totals. Feeds the heatmap and totals like cumulative tokens, peak tokens, total active time, streak days.               |
| Usage trend / usage details | `/api/monitor/credit-usage/usage-detail`   | Per `usageType=MODEL/MCP`: model and tool credit/token/call series, cache hit rate, total credits, daily average credits.                           |
| System health               | `/api/monitor/usage/model-performance-day` | Peak-hour average decode speed for Max&Pro / Lite; feeds the health line chart.                                                                     |

The old `/api/monitor/usage/model-usage` and `/api/monitor/usage/tool-usage` are no longer the primary Coding Plan data sources. At most a compat fallback when the backend returns no new credit data, they must not override token activity, cache hit rate, or credit statistics.

Coding Plan does not follow the settings-top `All / 30d / 7d` App Usage dimension (local usage stats only); it has its own "Usage details" ranges:

| Range   | Request window                      | `granularity` | `x_time`                 |
| ------- | ----------------------------------- | ------------- | ------------------------ |
| Today   | 00:00:00–23:59:59 local             | `hour`        | `00:00:00`–`23:00:00`    |
| 7 days  | last 7 calendar days                | `day`         | consecutive `YYYY-MM-DD` |
| 30 days | last 30 calendar days               | `day`         | consecutive `YYYY-MM-DD` |
| Custom  | user-selected calendar days, max 30 | `day`         | consecutive `YYYY-MM-DD` |

The service layer aligns model and tool series by `x_time`, filling 0 for missing monitor buckets; the frontend charts consume by `x_time` index only and infer no own timeline.

"Usage details" charts split into two-level tabs like the official page:

| Level 1      | Level 2 | Metric        | Source                                                                                         |
| ------------ | ------- | ------------- | ---------------------------------------------------------------------------------------------- |
| Credit usage | Model   | model credits | `usageType=MODEL` `totalCreditsUsage`, merging cached / uncached / output credits when missing |
| Credit usage | Tool    | tool credits  | `usageType=MCP` `creditsUsage`                                                                 |
| Token usage  | Model   | tokens        | `usageType=MODEL` `totalTokensUsage`, merging cached / uncached / output tokens when missing   |
| Token usage  | Tool    | call count    | `usageType=MCP` `mcpCallCount` / `usageCount`                                                  |

Chart shape follows the official page:

- Bar charts, not line charts.
- Model bars stack cached input / uncached input / output; model names stay legend toggles — "cached / uncached / output" are not separate models.
- Tool bars render per tool series with no cached split.

Legend above the charts:

- "Total" sums the visible series; clicking restores all series.
- Each model/tool item shows its name and current-metric total; clicking toggles visibility.
- The last visible series cannot be hidden.
- An empty range shows an empty state, not an empty chart.

"Usage details" KPIs come from the current tab API's `summary`: cache hit rate, total credits, daily average credits; if `trend` is returned, show the rise/fall percentage beside the card title.

`credit-usage/activity` ignores the Today/7d/30d range and always reads the last 365 calendar days; the frontend switches over one 52-week grid:

| Token activity tab | Cell metric                                                     | Hover copy                                               |
| ------------------ | --------------------------------------------------------------- | -------------------------------------------------------- |
| Daily              | that day's tokens and message/call turns                        | `{date}\n{tokens} tokens · {turns} 轮消息`               |
| Weekly             | 7-day column sum, first row Sunday                              | `{date} 当周\n{tokens} tokens · {turns} 轮消息`          |
| Cumulative         | cumulative through that week; hover still highlights the column | `截至 {date} 当周累计\n{tokens} tokens · {turns} 轮消息` |

"System health" has its own range, independent of "Usage details": last 7 days (default) or last 30 days (user-selected). Its line chart shows two series — `proMaxDecodeSpeed` (Max&Pro peak-hour average decode speed) and `liteDecodeSpeed` (Lite) — with the y axis in `tokens/s` and tooltips showing each series' `tokens/s` like the official page.

All date boundaries use the caller's `timeZone`. Desktop local, Web, and mobile remote all read through the same injected UsageStatsService entry; the service layer must never substitute the host default timezone for the requested one.

## Error handling

- No Z.AI / BigModel API key configured: show “未找到可查询 quota 的 API key” (no API key found for quota queries).
- API returns "current user has no coding plan": show “暂无有效 Coding Plan” (no active Coding Plan).
- Other errors: show the API error message with manual refresh.

## Architecture boundaries

- The UI layer fetches data only through the `useUsageEntitlement` hook.
- The service layer reaches the quota API through `BigModelUsageQuotaProvider`.
- API key sourcing stays with the existing model provider config service; Z.AI OAuth login/logout/refresh and user auth are unchanged.
- Desktop local and remote workspace flows both pass the same usage stats service by dependency injection; the UI never touches local files or credentials directly.
