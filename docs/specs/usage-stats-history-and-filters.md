# Usage Stats: History Rollup, Date Filters, Dimension Filters (DRAFT, awaiting approval)

Status: plan only, no code written. Spec-first per root `AGENTS.md`; each phase updates its specs
before code. Goals, in priority order: (1) break nothing, (2) stay backward compatible, (3) stay cheap.

## Problem

`model_usage` / `turn_usage` / `tool_usage` are pruned after 30 days (`USAGE_RETENTION_DAYS`,
`apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts`). App Usage
"all-time" metrics (total tokens, peak day, longest streak) and the 52-week heatmap therefore cover
at most 30 days. Date presets longer than 30 days would show nothing until history is retained.

## Hard constraints

- `~/.zcode/cli/db/db.sqlite` is shared with the upstream build, which runs its own `pruneUsage`
  on the raw tables. We cannot hook that prune; anything it deletes before we roll it up is lost.
- Never touch upstream migrations, raw usage tables, their columns or indexes. Fork additions only:
  ids `9001_fork_*`, additive, `fork_`-prefixed tables
  (`docs/specs/sqlite-session-migration-checksum-compatibility.md`). First fork migration in the CLI
  DB; the runner only uses the last ledger id for diagnostics (`safeParse(...).data`, non-throwing),
  but P1 must prove an upstream build opens a DB containing `9001_fork_*` rows.
- No backfill from session snapshots (`chars / 3` estimates must not mix with real token counts).
  History starts at rollout; state this in the UI empty state and the spec.
- Consumers of `AppUsageSnapshot` span processes: UI hook, `packages/services` usage-stats service,
  `zcodeAgent`, `zcode-protocol` + `zcode-protocol-v4/transport`, CLI `server-operations`,
  `usage-stats-builder`. Mobile remote and older desktop/web builds can lag the host: treat every
  protocol change as version-skewed.

## Compatibility rules (apply to every phase)

1. Protocol is additive only. `AppUsageRange` (`"all" | "7d" | "30d"`) is NOT extended. New request
   fields are optional (`window`, `compare`, `filters`); the response keeps `range` and adds optional
   fields. Zod object schemas strip unknown keys, so old clients/servers ignore new fields instead of
   failing. An old host that ignores `window` returns the old range: the UI detects the missing
   `window` echo in the response and shows "needs update" instead of silently showing wrong data.
2. Defaults reproduce today's behavior byte-for-byte: no new fields => same output as now.
3. Parity guarantee: for any data inside the 30-day raw window, the rollup-based result must equal the
   legacy raw-based result (golden test over a synthetic DB, many time zones). This is the main
   regression net for P1.
4. Legacy raw query stays in the code as the fallback. If the rollup tables are missing, a migration
   failed, or the rollup read throws, App Usage falls back to the raw path (not a union: one path
   per request) and logs a `warn`. Downgrading to an older fork build or upstream is safe because raw
   tables and their migrations are untouched and unknown fork tables are ignored.
5. No new env vars or `setting.json` keys (fork-unsafe). Persisted UI choices (last range) go to
   `localStorage`/UI-local state only.

## Performance rules

- Rollup grain: 15-minute UTC buckets, not hourly. All current IANA zones are whole multiples of
  15 minutes (e.g. +5:30, +5:45, +12:45), so local-day bucketing at read time is exact and matches
  today's behavior. Hourly buckets would misattribute up to 30-45 minutes of tokens for those zones,
  a regression. Rows are sparse (only active buckets), so volume stays small.
- Recompute is incremental and idempotent: window = max(watermark - 7 days, oldest surviving raw
  row), full only on first run. Replaces buckets in one `begin immediate` transaction; never
  increments. Concurrent recomputes (CLI + desktop host) are therefore benign.
- Recompute runs off the hot path: debounced (>= 5 min), chunked by day with yields between chunks
  because `node:sqlite` is synchronous. Never inside the turn/tool write path.
- Budget (verified by a benchmark test on a synthetic ~200k-row DB): full recompute < 1 s, incremental
  < 100 ms, 1-year query < 50 ms. Check `tool_usage(started_at)` has an index (only `model_usage` and
  `turn_usage` indexes were found); fork indexes go in the fork migration if needed.
- Read path uses SQL aggregation to day buckets; the UI receives <= ~370 daily points, never raw buckets.
- UI: cache snapshots per request key in `useUsageStats`, keep `all` cached across range changes,
  debounce custom-range inputs, keep charts lazy-loaded (existing Recharts boundary).

## Design (P1)

```text
fork_usage_bucket   bucket_15m_utc, provider_id, model_id, query_source ->
                    input/output/reasoning/cache_creation/cache_read/computed_total tokens,
                    request_count, model_error_count, ttft_sum_ms, ttft_count
fork_usage_turn     bucket_15m_utc -> turn_count, completed_duration_sum_ms, completed_count,
                    tool_call_count, tool_error_count
fork_usage_tool     bucket_15m_utc, tool_name -> call_count, error_count, duration_sum_ms, duration_count
fork_usage_session  session_id, workspace_id, first_at, last_at, completed_duration_ms, tokens, turns, tool_calls
fork_usage_meta     key, value   (watermark, schema version)
```

Sums and counts only, never averages/rates. `fork_usage_session` provides distinct sessions, longest
session, top sessions, and the workspace filter (`session.workspace_id`, nullable -> "Unknown").

```text
 runtime writes ──► raw usage tables ──(pruned >30d by fork AND upstream)──► rows gone
                         │
                         └─► recompute(window) ──► fork_usage_* (kept; own retention)
                               ▲        ▲
                         startup(once)  before App Usage query (debounced)

 App Usage request ─► rollup read ──ok──► snapshot
                          └─ error / tables missing ─► legacy raw read (warn)
```

Owner: the recompute function (single writer of `fork_usage_*`). Read: App Usage reads only rollup,
or only raw in fallback. Known limitation (document in `usage-observability.md`): rows whose whole
30-day life passes while no fork build runs are never rolled up.

## Phases (each = its own commit/PR, independently revertible)

| Phase | Scope                                                                                                                                                                                                                     | Exit criteria                                                                                                                                                         | Rollback                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| P0    | UI only: show data already in the snapshot (token split, cache hit rate, error rates, TTFT, avg turn duration, sessions/turns, tools table from `snapshot.tools`). Spec: `docs/ui/settings-usage-stats.md`.               | typecheck+lint, UI tests, desktop+mobile+both themes+zh/en visual check, no protocol diff                                                                             | revert commit                                                       |
| P1    | Specs + migration `9001_fork_usage_*` + recompute + parity tests + rollup read with raw fallback. Spec: `usage-observability.md`.                                                                                         | parity test green across zones (incl. +5:30, +5:45, -3:30), idempotency, simulated upstream prune keeps old buckets, benchmark within budget, upstream build opens DB | read path falls back to raw; tables are inert, can be left in place |
| P2    | Date filter: optional `window {from,to}` (presets Today/7d/30d/90d/1y/All + custom), previous-period compare (delta badges + dashed line), day/week/month granularity. Reuse Coding Plan `customStartDate/EndDate` shape. | validation tests (start > end, future, > rollup retention), old-host skew behavior, E2E per `docs/testing/usage-stats-e2e-coverage-matrix.md`                         | UI hides new controls; protocol fields are ignorable                |
| P3    | Filters: model, provider, query_source, workspace; heatmap-day drill-down.                                                                                                                                                | filter x range parity vs. unfiltered totals; "Unknown" workspace bucket                                                                                               | UI-only revert                                                      |
| P4    | Hour x weekday heatmap (from 15-min buckets), top sessions, CSV/JSON export.                                                                                                                                              | export size cap, E2E                                                                                                                                                  | UI-only revert                                                      |

P0 is independent and can ship first. P1 is the risk-bearing phase and must land before P2+ show
anything beyond 30 days. P2-P4 are read-side only, no further migrations expected (any new fork column
or table gets another additive `9001_fork_*` migration).

Every phase also: run `node scripts/check-workspace-freshness.mjs` first; `pnpm typecheck`,
`pnpm lint`, `pnpm architecture:check --changed`; CLI phases also `pnpm --dir apps/zcode-cli
typecheck` and `lint`; report real results, including anything not run.

## Acceptance scenarios

1. Default App Usage (no new fields) is identical to current output on the same data (parity).
2. After >30 days of use, All range shows totals/streaks/heatmap beyond 30 days.
3. Upstream build prunes raw rows; fork stats for older days are unchanged.
4. Same data in two time zones buckets days differently but totals are equal; India/Nepal exact.
5. Rollup tables dropped or migration failed: App Usage still renders from raw with a logged warning.
6. New host + old client and old host + new client both work (new controls degrade, nothing crashes).
7. Invalid custom range is rejected by protocol validation with a clear UI message.
8. Upstream build opens a DB containing `9001_fork_*` rows without error.

## Open questions

- Rollup retention (proposal: 2 years, pruned by fork recompute).
- Whether to surface "history starts <date>" in the UI (proposal: yes, subtle caption on All/long ranges).
