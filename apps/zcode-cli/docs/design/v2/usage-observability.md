# Usage Observability

## Goal

Persist short-lived usage facts for `/usage` and local diagnostics. The data answers:

- Daily token usage by provider and model.
- Daily user turn count, similar to an activity heatmap.
- Model latency versus tool latency versus whole-turn latency.
- Cache hit and cache creation token volume.
- Error, retry, cancellation, and context-overflow rates.

Usage observability is not a permanent billing ledger. Rows are retained for 30 days. Automatic
pruning runs after usage writes at most once per hour per open database connection; the first write
for a connection attempts pruning immediately. Expired rows can remain until a later write after
that interval. A failed automatic prune does not advance the interval, so a later write retries it.
An explicit `pruneUsage` call always prunes immediately.

## Source Of Truth

`model_usage` is the canonical token source. One row represents one logical model request recorded
at the runtime boundary, including main turns, compact summaries, title generation, target
completion verification, workflow child sessions, subagents, and background project memory
requests (`project_memory_extract` for per-turn Extraction, `dream` for consolidation). Background
memory requests record one row per memory-agent request, attributed to the session that scheduled
them.

`message` and `part` may keep token snapshots for transcript rendering, but `/usage` must not read
them as the canonical source after this migration. `part` is a UI transcript unit, not a billing or
usage unit.

## Token Fields

Persist provider-normalized token fields separately:

- `input_tokens`
- `output_tokens`
- `reasoning_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `provider_total_tokens`
- `computed_total_tokens`

`input_tokens` stores provider-normalized total input. For AI SDK v6 Anthropic
usage this already includes ordinary input, cache-hit input, and cache-write
input. `cache_read_input_tokens` is cache-hit volume and
`cache_creation_input_tokens` is cache-write volume; both stay separate only as
breakdown fields so `/usage` can render cache behavior without hiding it.

`computed_total_tokens` is:

```text
input_tokens + output_tokens
```

`reasoning_tokens` is stored as its own provider detail. It is not added to `computed_total_tokens`
by default because providers may already include it in output totals.

## Tables

### `model_usage`

One row per logical model request. The row includes request identity, query source, model identity,
latency, token split, retry/error flags, and raw usage JSON for later adapter debugging.

### `turn_usage`

One row per user turn. The row aggregates model usage and tool usage for that turn. It is the source
for activity-style turn counts and loop-level latency.

### `tool_usage`

One row per tool call. The row tracks tool name, side-effect metadata, approval status, latency,
output byte counts, truncation, errors, and cancellation flags.

Rollups are intentionally deferred. `/usage` can group over 30 days of facts directly; if the facts
grow expensive later, daily rollups can be rebuilt from these tables.

## Retention

The store prunes rows older than 30 days using:

```sql
delete from model_usage where started_at < ?;
delete from turn_usage where started_at < ?;
delete from tool_usage where started_at < ?;
```

The cutoff is `Date.now() - 30 days`. Pruning must never block the model/tool path if it fails; it is
best-effort observability.

## Write Points

- Runtime writes `model_usage` after every successful `ModelComplete` and after model request
  failures when a request reached the runtime boundary.
- 明确超窗且无有效输出的 finish 在 Adapter 归一为失败；若 provider 已报告 usage，将其保留在
  `model_request_failed.usage`。既有失败记账消费该事实，不添加额外 usage 数组。
  Turn 和 Subagent 汇总计入失败事件的 usage；成功响应仍只从 `ModelComplete` 计入，避免双计。
  记账在 Reactive Compact 前完成，压缩成功、失败、禁用和取消均不得遗漏原请求。
- Runtime writes `turn_usage` at turn completion or turn error.
- Runtime writes `tool_usage` from tool lifecycle events:
  `tool_call_scheduled`, `permission_requested`, `permission_resolved`,
  `permission_denied`, `tool_call_started`, `tool_call_progress`, `tool_call_result`, and
  `tool_call_error`.

All writes must use trace/session/turn identifiers already present in the runtime trace context.
Statistics rows must not store full prompts, full tool input/output, secrets, tokens, cookies, or
private file contents.

## `/usage` Query Shape

Daily model usage:

```sql
select
  date(started_at / 1000, 'unixepoch', 'localtime') as day,
  provider_id,
  model_id,
  sum(input_tokens) as input_tokens,
  sum(output_tokens) as output_tokens,
  sum(cache_creation_input_tokens) as cache_creation_input_tokens,
  sum(cache_read_input_tokens) as cache_read_input_tokens,
  sum(computed_total_tokens) as computed_total_tokens,
  count(*) as model_request_count,
  avg(duration_ms) as avg_duration_ms,
  avg(time_to_first_token_ms) as avg_time_to_first_token_ms
from model_usage
where started_at >= ?
group by day, provider_id, model_id
order by day asc;
```

Daily turn activity:

```sql
select
  date(started_at / 1000, 'unixepoch', 'localtime') as day,
  count(*) as turn_count,
  sum(computed_total_tokens) as computed_total_tokens
from turn_usage
where started_at >= ?
group by day
order by day asc;
```

Tool latency:

```sql
select
  tool_name,
  count(*) as calls,
  avg(duration_ms) as avg_duration_ms,
  sum(case when status = 'error' then 1 else 0 end) as error_count
from tool_usage
where started_at >= ?
group by tool_name
order by calls desc;
```

## Fork History Rollup

The raw usage tables above stay the canonical write target and keep the 30-day retention, because the
upstream build shares this database and runs its own `pruneUsage`. The fork adds a long-lived,
read-only-derived rollup so App Usage can show history beyond 30 days. Spec of record for the whole
plan: `docs/specs/usage-stats-history-and-filters.md`.

- Tables (fork-owned, `fork_` prefix, created idempotently by `ensureForkUsageRollupSchema`, tracked
  in `schema_migration` as `9001_fork_usage_rollup`; upstream migration definitions are untouched and
  upstream builds ignore the unknown ledger row):
  - `fork_usage_bucket(bucket_start, workspace_key, provider_id, model_id, query_source)` with token
    sums, request/error counts, and TTFT sum + count.
  - `fork_usage_turn(bucket_start, session_id)` with turn count, completed duration sum + count,
    and `workspace_key`.
  - `fork_usage_tool(bucket_start, workspace_key, tool_name)` with call/error counts and duration sum + count.
  - `fork_usage_meta(key, value)` for the recompute watermark.
  - `fork_usage_detached_turn` for per-deleted-session turn aggregates under a fresh opaque identity;
    detached rows retain bucket, workspace, turn count, completed-duration sum/count and tokens, but
    no original session identity or title.
  - `fork_usage_protected_bucket` plus fork-owned raw-row snapshots for model and tool groups touched
    by permanent session deletion. Existing aggregates remain the baseline, including already-pruned
    contributions. Raw-row snapshots track later insert/update deltas without guessing which part of
    a partial bucket the baseline contains.
- `bucket_start` is a UTC 15-minute boundary in ms. Every modern IANA zone offset is a multiple of 15
  minutes, so local-day bucketing at read time stays exact. `workspace_key` is the session
  `directory` (empty when the session row is gone). `model_id` is `NOT NULL` in the raw table and kept as is.
- Rows are sums and counts only. Averages and rates are derived at read time.
- The single owner is `recomputeForkUsageRollup`. It is idempotent: it replaces (never increments)
  the buckets from a window start onwards using `delete` + `insert ... select` in one
  `begin immediate` transaction. Window start = `max(watermark - 7 days, oldest surviving raw
  bucket)`; the oldest surviving raw bucket itself is rebuilt only when the raw table still holds at least
  as many rows for it as the rollup already counted (otherwise earlier rows were pruned and the
  rollup keeps its value; a brand-new history therefore keeps refreshing its first bucket), so buckets whose raw rows were already
  pruned (by either build) are never rewritten. First run has no watermark and backfills the whole surviving raw span from real usage
  facts; nothing is estimated or imported from session snapshots.
- Permanent session-tree deletion preserves usage in the same SQLite `begin immediate` transaction
  as content deletion. It first synchronizes raw-backed complete groups, then protects affected
  model/tool aggregate buckets in place. Existing totals remain the baseline, so partial-prune
  history is never subtracted or counted a second time. Fork-owned snapshots of current raw
  model/tool rows in those groups let later repository writes and reads compare before/after row
  values and apply exact deltas to the protected aggregate. New rows add their full contribution;
  updated rows apply the field-by-field difference. A raw row disappearing through retention or
  session deletion never subtracts from the preserved aggregate. Recompute skips protected groups;
  query refresh notices writes made through another process sharing the SQLite database.
- Turn aggregates move from `fork_usage_turn` to `fork_usage_detached_turn` with a new random opaque
  identity and no mapping to the deleted session ID. These rows continue to contribute to exact
  distinct session counts and longest-session duration, but Top Sessions only selects live sessions.
  Detached accounting follows the same 2-year bucket retention as the existing rollups.
- Triggers: debounced (>= 5 min) and deferred with `setImmediate` after usage writes, and before
  every App Usage query so a read never misses rows written just before it (the replace window is
  bounded to 7 days, so this stays cheap). A busy database or a surrounding transaction skips the round.
- Rollup rows older than 2 years are pruned during recompute.
- Read path: `queryAppUsage` reads the rollup and detached turn aggregates. Fallback to the legacy raw query happens when the
  rollup tables are missing, were never computed (no watermark: the first recompute was skipped by a
  busy lock or a surrounding transaction), or the rollup read throws; the result then carries
  `rollupFallbackReason` and the host logs a `warn`. Once `fork_usage_detached_turn` or
  `fork_usage_protected_bucket` holds any rows, the raw fallback is disabled entirely (raw-only totals would drop
  the usage of deleted sessions) and the query fails with `usage_rollup_unavailable`. The read-time protected-row
  sync is best-effort: a busy lock skips it and the next read or recompute applies the deltas. Requests the raw tables cannot answer correctly
  (any filter, or a bounded window that starts before the 30-day raw retention) fail with
  `usage_rollup_unavailable` instead. The all-time range (`since` = 0) keeps its legacy meaning and may
  fall back. Windows snap to 15-minute bucket boundaries (the bucket containing `since` is included),
  which can differ from the legacy exact-millisecond boundary by at most one bucket at the oldest edge.
- Filters and facets: `AppUsageQueryInput.filters` narrows by model, provider, query source, and
  workspace (session directory). Model/provider/source filters apply to the token bucket table only;
  the turn and tool tables carry only the workspace dimension, so they follow only the workspace
  filter. `includeFacets` additionally returns the distinct values per dimension for the window,
  ignoring the active filters (the host asks for it only on the unfiltered all-time request).
- Breakdowns: `include.hourly` returns tokens for 168 local weekday x hour cells (15-minute buckets
  never straddle a local hour boundary, including +5:30 / +5:45 zones); `include.sessions` returns the
  ten busiest live sessions by `fork_usage_turn.total_tokens` (sum of `turn_usage.computed_total_tokens`)
  joined to the live `session` row for the title. Anonymous detached sessions are excluded.
  `total_tokens` was added after the first rollout;
  `ensureForkUsageRollupSchema` adds the missing column and resets the watermark so the next recompute
  backfills it for every bucket whose raw rows still exist (older buckets keep 0).
- Known limitation: raw rows that live and are pruned entirely while no fork build runs are never
  rolled up. History starts when the rollup is first created.

## Tests

- SQLite migration creates all usage tables and indexes.
- Rollup parity: for bucket-aligned windows the rollup result equals the raw result across several
  time zones, including +5:30, +5:45 and -3:30; recompute is idempotent; an upstream-style prune of
  raw rows keeps older rollup buckets; schema ensure is idempotent and records the ledger row.
- SQLite usage repository upserts model, turn, and tool rows and prunes old rows.
- Permanent deletion preserves aggregate tokens, errors, tool metrics, day/hour facets, exact
  distinct session counts and longest-session duration across complete and partially-pruned buckets;
  recompute, reopen, retention and repeated deletion do not duplicate detached data or expose
  deleted sessions in Top Sessions.
- Runtime records main-turn model usage, turn usage, and tool usage.
- Runtime records non-transcript model calls such as session title generation and compact through
  the same `model_usage` path.
