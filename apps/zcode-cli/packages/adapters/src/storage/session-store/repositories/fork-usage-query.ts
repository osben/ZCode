import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  AppUsageDayModelRow,
  AppUsageFacets,
  AppUsageDayRow,
  AppUsageFilters,
  AppUsageModelRow,
  AppUsageQueryInput,
  AppUsageQueryResult,
  AppUsageSessionRow,
  AppUsageToolRow,
} from "@zcode/contracts";
import {
  alignDownToBucket,
  describeForkUsageRollupFailure,
  isForkUsageRollupReady,
  refreshForkUsageRollupForRead,
} from "./fork-usage-rollup.js";
import { ensureForkUsageRollupSchema } from "./fork-usage-rollup-schema.js";
import { queryAppUsage as queryAppUsageFromRawTables } from "./usage.js";

const DAY_MS = 86_400_000;

interface WhereClause {
  sql: string;
  params: SQLInputValue[];
}

function inList(column: string, values: readonly string[] | undefined, out: WhereClause): void {
  if (!values || values.length === 0) {
    return;
  }
  out.sql += ` and ${column} in (${values.map(() => "?").join(", ")})`;
  out.params.push(...values);
}

function buildWhere(
  since: number,
  until: number,
  filters: AppUsageFilters | undefined,
  scope: "bucket" | "workspace",
): WhereClause {
  const where: WhereClause = {
    sql: "bucket_start >= ? and bucket_start <= ?",
    params: [alignDownToBucket(since), until],
  };
  inList("workspace_key", filters?.workspaceKeys, where);
  if (scope === "bucket") {
    inList("model_id", filters?.modelIds, where);
    inList("provider_id", filters?.providerIds, where);
    inList("query_source", filters?.querySources, where);
  }
  return where;
}

function hasFilters(filters: AppUsageFilters | undefined): boolean {
  return Boolean(
    filters &&
    (filters.modelIds?.length ||
      filters.providerIds?.length ||
      filters.querySources?.length ||
      filters.workspaceKeys?.length),
  );
}

/** Mirrors the raw-table retention in usage.ts (not exported there, and that file stays upstream-identical). */
const RAW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** A bounded window that reaches past the raw retention cannot be answered from the raw tables. */
function reachesBeyondRawRetention(since: number, nowMs: number): boolean {
  return since > 0 && since < nowMs - RAW_RETENTION_MS;
}

/**
 * App Usage read path: the long-lived rollup first, the raw tables only as a fallback. A request
 * the raw tables cannot answer correctly (filters, or a bounded window older than the raw
 * retention) fails loudly instead of silently returning unfiltered or truncated data. The all-time
 * range (`since` = 0) keeps its legacy meaning, "whatever the raw tables still hold", and may fall
 * back; the result then carries `rollupFallbackReason` so the host can log it.
 */
export async function queryAppUsageWithRollup(
  db: DatabaseSync,
  input: AppUsageQueryInput,
): Promise<AppUsageQueryResult> {
  try {
    ensureForkUsageRollupSchema(db);
    refreshForkUsageRollupForRead(db, Date.now());
    // A skipped first recompute (busy lock, surrounding transaction) leaves empty tables that would
    // answer with zeros; "never computed" is unavailable, not empty.
    if (!isForkUsageRollupReady(db)) {
      throw new Error(describeForkUsageRollupFailure(db));
    }
    return queryAppUsageFromRollup(db, input);
  } catch (error) {
    if (hasFilters(input.filters) || reachesBeyondRawRetention(input.since, Date.now())) {
      throw new Error("usage_rollup_unavailable", { cause: error });
    }
    const result = await queryAppUsageFromRawTables(db, input);
    return {
      ...result,
      rollupFallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function queryAppUsageFromRollup(
  db: DatabaseSync,
  input: AppUsageQueryInput,
): AppUsageQueryResult {
  const { since, until, tzOffsetMs, filters } = input;
  const bucket = buildWhere(since, until, filters, "bucket");
  const scoped = buildWhere(since, until, filters, "workspace");
  const dayExpr = `cast((bucket_start + ?) / ? as integer)`;

  const totals = db
    .prepare(
      `select
         coalesce(sum(computed_total_tokens), 0) as totalTokens,
         coalesce(sum(input_tokens), 0) as inputTokens,
         coalesce(sum(output_tokens), 0) as outputTokens,
         coalesce(sum(reasoning_tokens), 0) as reasoningTokens,
         coalesce(sum(cache_creation_tokens), 0) as cacheCreationTokens,
         coalesce(sum(cache_read_tokens), 0) as cacheReadTokens,
         coalesce(sum(request_count), 0) as modelRequestCount,
         coalesce(sum(model_error_count), 0) as modelErrorCount,
         coalesce(sum(ttft_sum_ms), 0) as ttftSum,
         coalesce(sum(ttft_count), 0) as ttftCount
       from fork_usage_bucket where ${bucket.sql}`,
    )
    .get(...bucket.params) as Record<string, number>;

  const turnTotals = db
    .prepare(
      `select
         count(distinct session_id) as totalSessions,
         coalesce(sum(turn_count), 0) as totalTurns,
         coalesce(sum(completed_duration_sum_ms), 0) as durationSum,
         coalesce(sum(completed_count), 0) as durationCount
       from fork_usage_turn where ${scoped.sql}`,
    )
    .get(...scoped.params) as Record<string, number>;
  const longestSession = db
    .prepare(
      `select coalesce(max(sessionDurationMs), 0) as longestSessionMs
       from (
         select sum(completed_duration_sum_ms) as sessionDurationMs
         from fork_usage_turn where ${scoped.sql}
         group by session_id
       )`,
    )
    .get(...scoped.params) as Record<string, number>;

  const toolTotals = db
    .prepare(
      `select
         coalesce(sum(call_count), 0) as toolCallCount,
         coalesce(sum(error_count), 0) as toolErrorCount
       from fork_usage_tool where ${scoped.sql}`,
    )
    .get(...scoped.params) as Record<string, number>;

  const models = db
    .prepare(
      `select
         model_id as modelId,
         coalesce(sum(computed_total_tokens), 0) as totalTokens,
         coalesce(sum(input_tokens), 0) as inputTokens,
         coalesce(sum(output_tokens), 0) as outputTokens,
         coalesce(sum(request_count), 0) as requestCount
       from fork_usage_bucket where ${bucket.sql}
       group by model_id
       order by totalTokens desc`,
    )
    .all(...bucket.params) as unknown as AppUsageModelRow[];

  const tools = db
    .prepare(
      `select
         tool_name as toolName,
         coalesce(sum(call_count), 0) as callCount,
         coalesce(sum(error_count), 0) as errorCount,
         coalesce(sum(duration_sum_ms), 0) as durationSum,
         coalesce(sum(duration_count), 0) as durationCount
       from fork_usage_tool where ${scoped.sql}
       group by tool_name
       order by callCount desc`,
    )
    .all(...scoped.params) as unknown as Array<
    Omit<AppUsageToolRow, "avgDurationMs"> & { durationSum: number; durationCount: number }
  >;

  const tokenDays = db
    .prepare(
      `select ${dayExpr} as dayIndex, coalesce(sum(computed_total_tokens), 0) as totalTokens
       from fork_usage_bucket where ${bucket.sql} group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, ...bucket.params) as Array<{ dayIndex: number; totalTokens: number }>;
  const turnDays = db
    .prepare(
      `select ${dayExpr} as dayIndex, coalesce(sum(turn_count), 0) as turnCount
       from fork_usage_turn where ${scoped.sql} group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, ...scoped.params) as Array<{ dayIndex: number; turnCount: number }>;
  const toolDays = db
    .prepare(
      `select ${dayExpr} as dayIndex, coalesce(sum(call_count), 0) as toolCallCount
       from fork_usage_tool where ${scoped.sql} group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, ...scoped.params) as Array<{
    dayIndex: number;
    toolCallCount: number;
  }>;
  const dayModels = db
    .prepare(
      `select ${dayExpr} as dayIndex, model_id as modelId,
         coalesce(sum(computed_total_tokens), 0) as totalTokens
       from fork_usage_bucket where ${bucket.sql} group by dayIndex, model_id`,
    )
    .all(tzOffsetMs, DAY_MS, ...bucket.params) as unknown as AppUsageDayModelRow[];

  const dayMap = new Map<number, AppUsageDayRow>();
  const dayRow = (dayIndex: number): AppUsageDayRow => {
    const existing = dayMap.get(dayIndex);
    if (existing) return existing;
    const created = { dayIndex, totalTokens: 0, turnCount: 0, toolCallCount: 0 };
    dayMap.set(dayIndex, created);
    return created;
  };
  for (const row of tokenDays) dayRow(Number(row.dayIndex)).totalTokens = Number(row.totalTokens);
  for (const row of turnDays) dayRow(Number(row.dayIndex)).turnCount = Number(row.turnCount);
  for (const row of toolDays) dayRow(Number(row.dayIndex)).toolCallCount = Number(row.toolCallCount);

  return {
    ...(input.includeFacets ? { facets: queryFacets(db, since, until) } : {}),
    ...(input.include?.hourly
      ? { hourlyTokens: queryHourlyTokens(db, bucket, tzOffsetMs) }
      : {}),
    ...(input.include?.sessions ? { topSessions: queryTopSessions(db, scoped) } : {}),
    totals: {
      totalTokens: Number(totals.totalTokens),
      inputTokens: Number(totals.inputTokens),
      outputTokens: Number(totals.outputTokens),
      reasoningTokens: Number(totals.reasoningTokens),
      cacheCreationTokens: Number(totals.cacheCreationTokens),
      cacheReadTokens: Number(totals.cacheReadTokens),
      modelRequestCount: Number(totals.modelRequestCount),
      modelErrorCount: Number(totals.modelErrorCount),
      avgTimeToFirstTokenMs:
        Number(totals.ttftCount) > 0 ? Number(totals.ttftSum) / Number(totals.ttftCount) : null,
    },
    turnTotals: {
      totalSessions: Number(turnTotals.totalSessions),
      totalTurns: Number(turnTotals.totalTurns),
      avgTurnDurationMs:
        Number(turnTotals.durationCount) > 0
          ? Number(turnTotals.durationSum) / Number(turnTotals.durationCount)
          : null,
      longestSessionMs: Number(longestSession.longestSessionMs),
    },
    toolTotals: {
      toolCallCount: Number(toolTotals.toolCallCount),
      toolErrorCount: Number(toolTotals.toolErrorCount),
    },
    models: models.map((m) => ({
      modelId: String(m.modelId ?? ""),
      totalTokens: Number(m.totalTokens),
      inputTokens: Number(m.inputTokens),
      outputTokens: Number(m.outputTokens),
      requestCount: Number(m.requestCount),
    })),
    tools: tools.map((t) => ({
      toolName: t.toolName,
      callCount: Number(t.callCount),
      errorCount: Number(t.errorCount),
      avgDurationMs:
        Number(t.durationCount) > 0 ? Number(t.durationSum) / Number(t.durationCount) : null,
    })),
    days: [...dayMap.values()].sort((a, b) => a.dayIndex - b.dayIndex),
    dayModels: dayModels.map((d) => ({
      dayIndex: Number(d.dayIndex),
      modelId: String(d.modelId ?? ""),
      totalTokens: Number(d.totalTokens),
    })),
  };
}

const FACET_LIMIT = 200;

/** Filter options for the window; deliberately ignores the active filters so choices never vanish. */
function queryFacets(db: DatabaseSync, since: number, until: number): AppUsageFacets {
  const range: SQLInputValue[] = [alignDownToBucket(since), until];
  const distinct = (sql: string, params: SQLInputValue[]): string[] =>
    (db.prepare(sql).all(...params) as Array<{ value: string }>).map((row) => String(row.value));
  const where = "bucket_start >= ? and bucket_start <= ?";
  const bucketColumn = (column: string) =>
    distinct(
      `select distinct ${column} as value from fork_usage_bucket where ${where} order by value limit ${FACET_LIMIT}`,
      range,
    );
  return {
    models: bucketColumn("model_id"),
    providers: bucketColumn("provider_id"),
    querySources: bucketColumn("query_source"),
    workspaces: distinct(
      `select value from (
         select workspace_key as value from fork_usage_bucket where ${where}
         union select workspace_key from fork_usage_turn where ${where}
         union select workspace_key from fork_usage_tool where ${where}
       ) order by value limit ${FACET_LIMIT}`,
      [...range, ...range, ...range],
    ),
  };
}

const HOUR_MS = 3_600_000;
const HOURLY_CELLS = 7 * 24;
const TOP_SESSIONS_LIMIT = 10;

/** Tokens per local weekday and hour. 15-minute buckets never straddle a local hour boundary. */
function queryHourlyTokens(db: DatabaseSync, bucket: WhereClause, tzOffsetMs: number): number[] {
  const rows = db
    .prepare(
      `select
         (cast((bucket_start + ?) / ? as integer) + 4) % 7 as weekday,
         cast(((bucket_start + ?) % ?) / ? as integer) as hour,
         coalesce(sum(computed_total_tokens), 0) as totalTokens
       from fork_usage_bucket where ${bucket.sql}
       group by weekday, hour`,
    )
    .all(tzOffsetMs, DAY_MS, tzOffsetMs, DAY_MS, HOUR_MS, ...bucket.params) as Array<{
    weekday: number;
    hour: number;
    totalTokens: number;
  }>;
  const cells = Array.from({ length: HOURLY_CELLS }, () => 0);
  for (const row of rows) {
    const index = Number(row.weekday) * 24 + Number(row.hour);
    if (index >= 0 && index < HOURLY_CELLS) {
      cells[index] = Number(row.totalTokens);
    }
  }
  return cells;
}

function queryTopSessions(db: DatabaseSync, scoped: WhereClause): AppUsageSessionRow[] {
  const rows = db
    .prepare(
      `select
         t.session_id as sessionId,
         s.title as title,
         max(t.workspace_key) as workspaceKey,
         coalesce(sum(t.total_tokens), 0) as totalTokens,
         coalesce(sum(t.turn_count), 0) as turnCount,
         coalesce(sum(t.completed_duration_sum_ms), 0) as durationMs
       from fork_usage_turn t
       left join session s on s.id = t.session_id
       where ${scoped.sql.replace(/bucket_start/g, "t.bucket_start").replace(/workspace_key/g, "t.workspace_key")}
       group by t.session_id
       having totalTokens > 0
       order by totalTokens desc
       limit ${TOP_SESSIONS_LIMIT}`,
    )
    .all(...scoped.params) as unknown as Array<AppUsageSessionRow & { title: string | null }>;
  return rows.map((row) => ({
    sessionId: String(row.sessionId),
    title: row.title === null ? null : String(row.title),
    workspaceKey: String(row.workspaceKey),
    totalTokens: Number(row.totalTokens),
    turnCount: Number(row.turnCount),
    durationMs: Number(row.durationMs),
  }));
}
