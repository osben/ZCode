import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createProjectId, createSessionId } from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";
import { queryAppUsageFromRollup } from "../src/storage/session-store/repositories/fork-usage-query.js";
import { recomputeForkUsageRollup } from "../src/storage/session-store/repositories/fork-usage-rollup.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_900_000_000_000;
const MODEL_ROWS = 100_000;
const TURN_ROWS = 30_000;
const TOOL_ROWS = 100_000;

// Generous ceilings on a loaded CI box; the design budget (docs/specs/usage-stats-history-and-filters.md)
// is full recompute < 1 s, incremental < 100 ms, 1-year query < 50 ms on a developer machine.
const FULL_RECOMPUTE_CEILING_MS = 5_000;
const INCREMENTAL_CEILING_MS = 1_500;
const QUERY_CEILING_MS = 1_000;

describe("fork usage rollup performance", () => {
  it("stays within the recompute and query budgets on a heavy 30-day history", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-fork-rollup-perf-"));
    const dbPath = join(tempRoot, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    const sessionId = createSessionId("perf");
    await store.createSession({
      id: sessionId,
      projectID: createProjectId("perf"),
      slug: "perf",
      directory: "/work/perf",
      title: "perf",
      version: "0.1.0",
    });
    store.close();
    const db = new DatabaseSync(dbPath);
    try {
      const spreadMs = 29 * DAY;
      db.exec(`
        with recursive seq(i) as (select 1 union all select i + 1 from seq where i < ${MODEL_ROWS})
        insert into model_usage (id, logical_request_id, session_id, query_source, provider_id, model_id,
          status, started_at, input_tokens, output_tokens, computed_total_tokens, time_to_first_token_ms)
        select 'm' || i, 'r' || i, '${sessionId}', 'main_turn', 'p' || (i % 3), 'model-' || (i % 12),
          case when i % 50 = 0 then 'error' else 'completed' end,
          ${NOW} - (i * 7919) % ${spreadMs}, 100, 10, 110, 200 + i % 300
        from seq;
        with recursive seq(i) as (select 1 union all select i + 1 from seq where i < ${TURN_ROWS})
        insert into turn_usage (session_id, turn_id, status, started_at, duration_ms)
        select '${sessionId}', 't' || i, 'completed', ${NOW} - (i * 104729) % ${spreadMs}, 1000 + i % 5000
        from seq;
        with recursive seq(i) as (select 1 union all select i + 1 from seq where i < ${TOOL_ROWS})
        insert into tool_usage (id, session_id, tool_call_id, tool_name, status, started_at, duration_ms)
        select 'u' || i, '${sessionId}', 'c' || i, 'tool-' || (i % 25),
          case when i % 40 = 0 then 'error' else 'completed' end,
          ${NOW} - (i * 15485863) % ${spreadMs}, 20 + i % 400
        from seq;
      `);

      const full = timed(() => recomputeForkUsageRollup(db, NOW));
      const incremental = timed(() => recomputeForkUsageRollup(db, NOW + 60_000));
      const query = timed(() =>
        queryAppUsageFromRollup(db, { since: 0, until: NOW + DAY, tzOffsetMs: 5.5 * 3_600_000 }),
      );
      // Surfaced for humans reading the test log; the assertions are only loose ceilings.
      console.info(
        `[fork-usage-rollup-perf] full=${full}ms incremental=${incremental}ms query=${query}ms`,
      );
      expect(full).toBeLessThan(FULL_RECOMPUTE_CEILING_MS);
      expect(incremental).toBeLessThan(INCREMENTAL_CEILING_MS);
      expect(query).toBeLessThan(QUERY_CEILING_MS);

      const result = queryAppUsageFromRollup(db, { since: 0, until: NOW + DAY, tzOffsetMs: 0 });
      expect(result.totals.modelRequestCount).toBe(MODEL_ROWS);
      expect(result.turnTotals.totalTurns).toBe(TURN_ROWS);
      expect(result.toolTotals.toolCallCount).toBe(TOOL_ROWS);
    } finally {
      db.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  }, 60_000);
});

function timed(run: () => unknown): number {
  const start = performance.now();
  run();
  return Math.round(performance.now() - start);
}
