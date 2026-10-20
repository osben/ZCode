import { syncForkUsageProtectedRawRows } from "./fork-usage-detached.js";
import type { DatabaseSync } from "node:sqlite";
import { FORK_USAGE_BUCKET_MS, ensureForkUsageRollupSchema } from "./fork-usage-rollup-schema.js";
import { ensureForkUsageDetachedSchema } from "./fork-usage-detached-schema.js";

const REPLACE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ROLLUP_RETENTION_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const WRITE_DEBOUNCE_MS = 5 * 60 * 1000;
/** One App Usage page load sends several queries back to back; reuse a just-finished recompute. */
const READ_DEBOUNCE_MS = 2 * 1000;
const WATERMARK_KEY = "watermark_ms";

const lastRecomputeAt = new WeakMap<DatabaseSync, number>();
const scheduledDatabases = new WeakSet<DatabaseSync>();
/** Usage written through this connection since the last successful recompute; reads must not skip it. */
const dirtyDatabases = new WeakSet<DatabaseSync>();
const lastRecomputeError = new WeakMap<DatabaseSync, string>();

const BUCKET_EXPR = (column: string) =>
  `cast(${column} / ${FORK_USAGE_BUCKET_MS} as integer) * ${FORK_USAGE_BUCKET_MS}`;

export function alignDownToBucket(timeMs: number): number {
  return Math.floor(timeMs / FORK_USAGE_BUCKET_MS) * FORK_USAGE_BUCKET_MS;
}

/**
 * Rebuild rollup buckets from `windowStartMs` onwards. Idempotent: buckets are replaced, never
 * incremented, and a table only replaces buckets that its surviving raw rows fully cover, so rows
 * already pruned (by this or the upstream build) keep their rollup.
 */
export function recomputeForkUsageRollup(db: DatabaseSync, nowMs: number): void {
  ensureForkUsageRollupSchema(db);
  ensureForkUsageDetachedSchema(db);
  if (db.isTransaction) {
    recomputeForkUsageRollupInTransaction(db, nowMs);
    return;
  }
  db.exec("begin immediate");
  try {
    recomputeForkUsageRollupInTransaction(db, nowMs);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  lastRecomputeAt.set(db, nowMs);
}

/** Runs the rollup replacement body under a caller-owned write transaction. */
export function recomputeForkUsageRollupInTransaction(db: DatabaseSync, nowMs: number): void {
  ensureForkUsageRollupSchema(db);
  ensureForkUsageDetachedSchema(db);
  syncForkUsageProtectedRawRows(db);
  const watermark = readWatermark(db);
  const windowStart = watermark === null ? 0 : alignDownToBucket(watermark - REPLACE_WINDOW_MS);
  replaceBuckets(db, {
    table: "fork_usage_bucket",
    rawTable: "model_usage",
    countColumn: "request_count",
    protectedMatch: (alias) => `not exists (
        select 1 from fork_usage_protected_bucket p where p.kind = 'model'
          and p.bucket_start = ${alias}.bucket_start and p.workspace_key = ${alias}.workspace_key
          and p.provider_id = ${alias}.provider_id and p.model_id = ${alias}.model_id
          and p.query_source = ${alias}.query_source
      )`,
    windowStart,
    insertSql: (from) => `
        insert into fork_usage_bucket (
          bucket_start, workspace_key, provider_id, model_id, query_source,
          input_tokens, output_tokens, reasoning_tokens, cache_creation_tokens, cache_read_tokens,
          computed_total_tokens, request_count, model_error_count, ttft_sum_ms, ttft_count
        )
        select
          ${BUCKET_EXPR("m.started_at")},
          coalesce(s.directory, ''),
          m.provider_id,
          coalesce(m.model_id, ''),
          m.query_source,
          coalesce(sum(m.input_tokens), 0),
          coalesce(sum(m.output_tokens), 0),
          coalesce(sum(m.reasoning_tokens), 0),
          coalesce(sum(m.cache_creation_input_tokens), 0),
          coalesce(sum(m.cache_read_input_tokens), 0),
          coalesce(sum(m.computed_total_tokens), 0),
          count(*),
          coalesce(sum(case when m.status = 'error' then 1 else 0 end), 0),
          coalesce(sum(m.time_to_first_token_ms), 0),
          count(m.time_to_first_token_ms)
        from model_usage m
        left join session s on s.id = m.session_id
        where m.started_at >= ${from}
          and not exists (
            select 1 from fork_usage_protected_bucket p where p.kind = 'model'
              and p.bucket_start = ${BUCKET_EXPR("m.started_at")}
              and p.workspace_key = coalesce(s.directory, '') and p.provider_id = m.provider_id
              and p.model_id = coalesce(m.model_id, '') and p.query_source = m.query_source
          )
        group by 1, 2, 3, 4, 5`,
  });
  replaceBuckets(db, {
    table: "fork_usage_turn",
    rawTable: "turn_usage",
    countColumn: "turn_count",
    protectedMatch: () => "1 = 1",
    windowStart,
    insertSql: (from) => `
        insert into fork_usage_turn (
          bucket_start, session_id, workspace_key, turn_count,
          completed_duration_sum_ms, completed_count, total_tokens
        )
        select
          ${BUCKET_EXPR("t.started_at")},
          t.session_id,
          coalesce(s.directory, ''),
          count(*),
          coalesce(sum(case when t.status = 'completed' then coalesce(t.duration_ms, 0) else 0 end), 0),
          coalesce(sum(case when t.status = 'completed' and t.duration_ms is not null then 1 else 0 end), 0),
          coalesce(sum(t.computed_total_tokens), 0)
        from turn_usage t
        left join session s on s.id = t.session_id
        where t.started_at >= ${from}
        group by 1, 2, 3`,
  });
  replaceBuckets(db, {
    table: "fork_usage_tool",
    rawTable: "tool_usage",
    countColumn: "call_count",
    protectedMatch: (alias) => `not exists (
        select 1 from fork_usage_protected_bucket p where p.kind = 'tool'
          and p.bucket_start = ${alias}.bucket_start and p.workspace_key = ${alias}.workspace_key
          and p.tool_name = ${alias}.tool_name
      )`,
    windowStart,
    insertSql: (from) => `
        insert into fork_usage_tool (
          bucket_start, workspace_key, tool_name, call_count, error_count,
          duration_sum_ms, duration_count
        )
        select
          ${BUCKET_EXPR("u.started_at")},
          coalesce(s.directory, ''),
          u.tool_name,
          count(*),
          coalesce(sum(case when u.status = 'error' then 1 else 0 end), 0),
          coalesce(sum(u.duration_ms), 0),
          count(u.duration_ms)
        from tool_usage u
        left join session s on s.id = u.session_id
        where u.started_at >= ${from}
          and not exists (
            select 1 from fork_usage_protected_bucket p where p.kind = 'tool'
              and p.bucket_start = ${BUCKET_EXPR("u.started_at")}
              and p.workspace_key = coalesce(s.directory, '') and p.tool_name = u.tool_name
          )
        group by 1, 2, 3`,
  });
  pruneForkUsageRollup(db, nowMs);
  db.prepare(
    "insert into fork_usage_meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
  ).run(WATERMARK_KEY, String(nowMs));
}

function replaceBuckets(
  db: DatabaseSync,
  input: {
    table: string;
    rawTable: string;
    /** Rollup column that counts the raw rows a bucket row stands for. */
    countColumn: string;
    protectedMatch: (alias: string) => string;
    windowStart: number;
    insertSql: (fromParam: string) => string;
  },
): void {
  const oldest = db.prepare(`select min(started_at) as oldest from ${input.rawTable}`).get() as {
    oldest: number | null;
  };
  if (oldest.oldest === null) {
    return;
  }
  // The bucket holding the oldest surviving raw row may have lost earlier rows to a prune (by this
  // or the upstream build). It is complete, and therefore safe to rebuild, only when the raw table
  // still holds at least as many rows for it as the rollup already counted; otherwise keep it.
  const oldestBucket = alignDownToBucket(oldest.oldest);
  const rolledUp = db
    .prepare(
      `select coalesce(sum(${input.countColumn}), 0) as n from ${input.table} where bucket_start = ?`,
    )
    .get(oldestBucket) as { n: number };
  const raw = db
    .prepare(`select count(*) as n from ${input.rawTable} where started_at >= ? and started_at < ?`)
    .get(oldestBucket, oldestBucket + FORK_USAGE_BUCKET_MS) as { n: number };
  const earliestSafe =
    Number(raw.n) >= Number(rolledUp.n) ? oldestBucket : oldestBucket + FORK_USAGE_BUCKET_MS;
  const from = Math.max(input.windowStart, earliestSafe);
  db.prepare(
    `delete from ${input.table} where bucket_start >= ? and ${input.protectedMatch(input.table)}`,
  ).run(from);
  db.exec(input.insertSql(String(from)));
}

export function pruneForkUsageRollup(db: DatabaseSync, nowMs: number): void {
  const cutoff = nowMs - ROLLUP_RETENTION_MS;
  for (const table of [
    "fork_usage_bucket",
    "fork_usage_turn",
    "fork_usage_tool",
    "fork_usage_detached_turn",
    "fork_usage_protected_bucket",
    "fork_usage_protected_model",
    "fork_usage_protected_tool",
    "fork_usage_protected_model_raw",
    "fork_usage_protected_tool_raw",
  ]) {
    db.prepare(`delete from ${table} where bucket_start < ?`).run(cutoff);
  }
}

function readWatermark(db: DatabaseSync): number | null {
  const row = db.prepare("select value from fork_usage_meta where key = ?").get(WATERMARK_KEY) as
    | { value: string }
    | undefined;
  const parsed = row ? Number(row.value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Recompute before a read so a query does not miss rows written just before it. Skipped only when
 * nothing was written through this connection and a recompute finished within the read debounce
 * (the page-load burst); rows written by another process show up after at most that debounce.
 * The replace window is bounded to 7 days, so this stays cheap. Never throws.
 */
export function refreshForkUsageRollupForRead(db: DatabaseSync, nowMs: number): void {
  const last = lastRecomputeAt.get(db);
  if (
    !dirtyDatabases.has(db) &&
    last !== undefined &&
    nowMs >= last &&
    nowMs - last < READ_DEBOUNCE_MS
  ) {
    return;
  }
  runRecomputeQuietly(db, nowMs);
}

/** True once a recompute has completed at least once, i.e. the rollup holds a usable history. */
export function isForkUsageRollupReady(db: DatabaseSync): boolean {
  return readWatermark(db) !== null;
}

/** Why the last recompute did not complete, for fallback diagnostics. */
export function describeForkUsageRollupFailure(db: DatabaseSync): string {
  return lastRecomputeError.get(db) ?? "rollup_not_ready";
}

/** Deferred, debounced recompute after usage writes; keeps the synchronous write path short. */
export function scheduleForkUsageRollup(db: DatabaseSync): void {
  dirtyDatabases.add(db);
  const now = Date.now();
  const last = lastRecomputeAt.get(db);
  if (
    scheduledDatabases.has(db) ||
    (last !== undefined && now >= last && now - last < WRITE_DEBOUNCE_MS)
  ) {
    return;
  }
  scheduledDatabases.add(db);
  setImmediate(() => {
    scheduledDatabases.delete(db);
    runRecomputeQuietly(db, Date.now());
  });
}

function runRecomputeQuietly(db: DatabaseSync, nowMs: number): void {
  // A surrounding transaction or a busy database only skips this round; the next trigger retries.
  // Read callers fall back to the raw tables when the rollup is genuinely unavailable.
  try {
    // Reading `isTransaction` also throws on a closed connection (a deferred run after close()).
    if (db.isTransaction) {
      lastRecomputeError.set(db, "database_in_transaction");
      return;
    }
    recomputeForkUsageRollup(db, nowMs);
    dirtyDatabases.delete(db);
    lastRecomputeError.delete(db);
  } catch (error) {
    // Derived data, retried by the next trigger; remembered so a fallback can say why.
    lastRecomputeError.set(db, error instanceof Error ? error.message : String(error));
  }
}
