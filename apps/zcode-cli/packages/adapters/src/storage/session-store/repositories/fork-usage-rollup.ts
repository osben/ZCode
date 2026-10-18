import type { DatabaseSync } from "node:sqlite";
import {
  FORK_USAGE_BUCKET_MS,
  ensureForkUsageRollupSchema,
} from "./fork-usage-rollup-schema.js";

const REPLACE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ROLLUP_RETENTION_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const WRITE_DEBOUNCE_MS = 5 * 60 * 1000;
const WATERMARK_KEY = "watermark_ms";

const lastRecomputeAt = new WeakMap<DatabaseSync, number>();
const scheduledDatabases = new WeakSet<DatabaseSync>();

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
  const watermark = readWatermark(db);
  const windowStart = watermark === null ? 0 : alignDownToBucket(watermark - REPLACE_WINDOW_MS);

  db.exec("begin immediate");
  try {
    replaceBuckets(db, {
      table: "fork_usage_bucket",
      rawTable: "model_usage",
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
        group by 1, 2, 3, 4, 5`,
    });
    replaceBuckets(db, {
      table: "fork_usage_turn",
      rawTable: "turn_usage",
      windowStart,
      insertSql: (from) => `
        insert into fork_usage_turn (
          bucket_start, session_id, workspace_key, turn_count,
          completed_duration_sum_ms, completed_count
        )
        select
          ${BUCKET_EXPR("t.started_at")},
          t.session_id,
          coalesce(s.directory, ''),
          count(*),
          coalesce(sum(case when t.status = 'completed' then coalesce(t.duration_ms, 0) else 0 end), 0),
          coalesce(sum(case when t.status = 'completed' and t.duration_ms is not null then 1 else 0 end), 0)
        from turn_usage t
        left join session s on s.id = t.session_id
        where t.started_at >= ${from}
        group by 1, 2, 3`,
    });
    replaceBuckets(db, {
      table: "fork_usage_tool",
      rawTable: "tool_usage",
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
        group by 1, 2, 3`,
    });
    pruneRollup(db, nowMs);
    db.prepare(
      "insert into fork_usage_meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
    ).run(WATERMARK_KEY, String(nowMs));
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  lastRecomputeAt.set(db, nowMs);
}

function replaceBuckets(
  db: DatabaseSync,
  input: {
    table: string;
    rawTable: string;
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
  // The bucket holding the oldest surviving raw row may have lost earlier rows to a prune. Rebuild
  // it only when the rollup has nothing for it yet; otherwise keep what was already rolled up.
  const oldestBucket = alignDownToBucket(oldest.oldest);
  const oldestBucketRolledUp = db
    .prepare(`select 1 from ${input.table} where bucket_start = ? limit 1`)
    .get(oldestBucket);
  const earliestSafe = oldestBucketRolledUp ? oldestBucket + FORK_USAGE_BUCKET_MS : oldestBucket;
  const from = Math.max(input.windowStart, earliestSafe);
  db.prepare(`delete from ${input.table} where bucket_start >= ?`).run(from);
  db.exec(input.insertSql(String(from)));
}

function pruneRollup(db: DatabaseSync, nowMs: number): void {
  const cutoff = nowMs - ROLLUP_RETENTION_MS;
  for (const table of ["fork_usage_bucket", "fork_usage_turn", "fork_usage_tool"]) {
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
 * Recompute before every read so a query never misses rows written just before it (including by
 * another process). The replace window is bounded to 7 days, so this stays cheap. Never throws.
 */
export function refreshForkUsageRollupForRead(db: DatabaseSync, nowMs: number): void {
  runRecomputeQuietly(db, nowMs);
}

/** Deferred, debounced recompute after usage writes; keeps the synchronous write path short. */
export function scheduleForkUsageRollup(db: DatabaseSync): void {
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
      return;
    }
    recomputeForkUsageRollup(db, nowMs);
  } catch {
    // Intentionally ignored: derived data, retried by the next trigger.
  }
}
