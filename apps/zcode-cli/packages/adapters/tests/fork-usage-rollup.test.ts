import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProjectId,
  createSessionId,
  createToolCallId,
  createTurnId,
  type AppUsageQueryResult,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";
import {
  queryAppUsageFromRollup,
  queryAppUsageWithRollup,
} from "../src/storage/session-store/repositories/fork-usage-query.js";
import { recomputeForkUsageRollup } from "../src/storage/session-store/repositories/fork-usage-rollup.js";
import { FORK_USAGE_ROLLUP_MIGRATION_ID } from "../src/storage/session-store/repositories/fork-usage-rollup-schema.js";
import * as usage from "../src/storage/session-store/repositories/usage.js";

const MINUTE = 60_000;
const BUCKET = 15 * MINUTE;
const DAY = 24 * 60 * MINUTE;
// Bucket-aligned "now" far in the future so the real-clock raw prune never touches fixtures.
const NOW = Math.ceil(1_900_000_000_000 / BUCKET) * BUCKET;
const OFFSETS = [0, 5.5 * 60 * MINUTE, 5.75 * 60 * MINUTE, -3.5 * 60 * MINUTE, 9 * 60 * MINUTE];

let tempRoot: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "zcode-fork-rollup-"));
  dbPath = join(tempRoot, "session.sqlite");
  // Opening a store runs the upstream migrations once; afterwards the repositories are driven
  // directly so no write-triggered recompute interferes with explicit control of the rollup.
  const store = createSqliteSessionStore({ dbPath });
  const sessions = [
    ["s1", "/work/alpha"],
    ["s2", "/work/alpha"],
    ["s3", "/work/beta"],
  ] as const;
  for (const [id, directory] of sessions) {
    await store.createSession({
      id: createSessionId(id),
      projectID: createProjectId(id),
      slug: id,
      directory,
      title: id,
      version: "0.1.0",
    });
  }
  store.close();
  db = new DatabaseSync(dbPath);
});

afterEach(async () => {
  db.close();
  await rm(tempRoot, { force: true, recursive: true });
});

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

/** Deterministic fixtures spread over 20 days, including instants near every tested local midnight. */
async function seedUsage(): Promise<void> {
  const random = lcg(42);
  const sessionIds = ["s1", "s2", "s3"];
  const models = ["model-a", "model-b", ""];
  const tools = ["Read", "Bash", "Edit"];
  const boundaryTimes = OFFSETS.flatMap((offset) => [
    NOW - 5 * DAY - offset - 2 * MINUTE,
    NOW - 5 * DAY - offset + 2 * MINUTE,
  ]);
  const times = [
    ...Array.from({ length: 60 }, () => NOW - Math.floor(random() * 20 * DAY) - BUCKET),
    ...boundaryTimes,
  ];
  let index = 0;
  for (const startedAt of times) {
    index += 1;
    const sessionID = createSessionId(sessionIds[index % 3]!);
    const turnID = createTurnId(`t${index}`);
    await usage.recordModelUsage(db, {
      id: `m${index}`,
      logicalRequestId: `r${index}`,
      sessionID,
      turnID,
      querySource: index % 7 === 0 ? "subagent" : "main_turn",
      providerId: index % 2 === 0 ? "p1" : "p2",
      modelId: models[index % 3]!,
      status: index % 11 === 0 ? "error" : "completed",
      startedAt,
      timeToFirstTokenMs: index % 5 === 0 ? undefined : 100 + index,
      inputTokens: 100 + index,
      outputTokens: 10 + (index % 9),
      reasoningTokens: index % 4,
      cacheReadInputTokens: index % 3 === 0 ? 40 : 0,
      cacheCreationInputTokens: index % 6 === 0 ? 5 : 0,
    });
    await usage.upsertTurnUsage(db, {
      sessionID,
      turnID,
      status: index % 8 === 0 ? "error" : "completed",
      startedAt,
      durationMs: index % 9 === 0 ? undefined : 1000 + index * 37,
      computedTotalTokens: 100 + index,
    });
    await usage.upsertToolUsage(db, {
      id: `tool${index}`,
      sessionID,
      turnID,
      toolCallID: createToolCallId(`c${index}`),
      toolName: tools[index % 3]!,
      status: index % 10 === 0 ? "error" : "completed",
      startedAt,
      durationMs: index % 6 === 0 ? undefined : 50 + index,
    });
  }
}

function normalize(result: AppUsageQueryResult): unknown {
  const round = (value: number | null) => (value === null ? null : Math.round(value * 1e6) / 1e6);
  return {
    totals: { ...result.totals, avgTimeToFirstTokenMs: round(result.totals.avgTimeToFirstTokenMs) },
    turnTotals: { ...result.turnTotals, avgTurnDurationMs: round(result.turnTotals.avgTurnDurationMs) },
    toolTotals: result.toolTotals,
    models: [...result.models].sort((a, b) => String(a.modelId).localeCompare(String(b.modelId))),
    tools: [...result.tools]
      .map((tool) => ({ ...tool, avgDurationMs: round(tool.avgDurationMs) }))
      .sort((a, b) => a.toolName.localeCompare(b.toolName)),
    days: result.days,
    dayModels: [...result.dayModels].sort(
      (a, b) => a.dayIndex - b.dayIndex || String(a.modelId).localeCompare(String(b.modelId)),
    ),
  };
}

describe("fork usage rollup", () => {
  it("matches the raw-table result for bucket-aligned windows across time zones", async () => {
    await seedUsage();
    recomputeForkUsageRollup(db, NOW);

    for (const tzOffsetMs of OFFSETS) {
      for (const days of [7, 30]) {
        const input = { since: NOW - days * DAY, until: NOW, tzOffsetMs };
        const rollup = queryAppUsageFromRollup(db, input);
        const raw = await usage.queryAppUsage(db, input);
        expect(raw.totals.modelRequestCount).toBeGreaterThan(0);
        expect(normalize(rollup)).toEqual(normalize(raw));
      }
    }
  });

  it("is idempotent when recomputed repeatedly", async () => {
    await seedUsage();
    recomputeForkUsageRollup(db, NOW);
    const input = { since: 0, until: NOW, tzOffsetMs: 0 };
    const count = () =>
      (db.prepare("select count(*) as n from fork_usage_bucket").get() as { n: number }).n;
    const before = { rows: count(), result: normalize(queryAppUsageFromRollup(db, input)) };
    recomputeForkUsageRollup(db, NOW + 10 * MINUTE);
    recomputeForkUsageRollup(db, NOW + 20 * MINUTE);
    expect(count()).toBe(before.rows);
    expect(normalize(queryAppUsageFromRollup(db, input))).toEqual(before.result);
  });

  it("keeps rolled-up history after the raw rows are pruned", async () => {
    await seedUsage();
    recomputeForkUsageRollup(db, NOW);
    const input = { since: 0, until: NOW, tzOffsetMs: 0 };
    const full = normalize(queryAppUsageFromRollup(db, input));

    // Simulate the upstream build pruning raw rows older than 10 days, then a later recompute.
    await usage.pruneUsage(db, { beforeTime: NOW - 10 * DAY });
    expect((await usage.queryAppUsage(db, input)).totals.modelRequestCount).toBeLessThan(
      (full as { totals: { modelRequestCount: number } }).totals.modelRequestCount,
    );
    recomputeForkUsageRollup(db, NOW + 2 * 60 * MINUTE);
    expect(normalize(queryAppUsageFromRollup(db, input))).toEqual(full);
  });

  it("does not rewrite buckets that a stale watermark would reach beyond surviving raw rows", async () => {
    await seedUsage();
    recomputeForkUsageRollup(db, NOW - 25 * DAY);
    recomputeForkUsageRollup(db, NOW);
    const input = { since: 0, until: NOW, tzOffsetMs: 0 };
    const full = normalize(queryAppUsageFromRollup(db, input));
    await usage.pruneUsage(db, { beforeTime: NOW - 3 * DAY });
    // Watermark is NOW, so the replace window starts 7 days back, older than the surviving raw rows.
    recomputeForkUsageRollup(db, NOW + MINUTE);
    expect(normalize(queryAppUsageFromRollup(db, input))).toEqual(full);
  });

  it("records the ledger row once and ensures the schema idempotently", () => {
    recomputeForkUsageRollup(db, NOW);
    recomputeForkUsageRollup(db, NOW + MINUTE);
    const rows = db
      .prepare("select id, checksum from schema_migration where id = ?")
      .all(FORK_USAGE_ROLLUP_MIGRATION_ID);
    expect(rows).toHaveLength(1);
  });

  it("applies workspace and model filters to the right sections", async () => {
    await seedUsage();
    recomputeForkUsageRollup(db, NOW);
    const base = { since: 0, until: NOW, tzOffsetMs: 0 };
    const all = queryAppUsageFromRollup(db, base);

    const alpha = queryAppUsageFromRollup(db, {
      ...base,
      filters: { workspaceKeys: ["/work/alpha"] },
    });
    expect(alpha.turnTotals.totalSessions).toBe(2);
    expect(alpha.totals.totalTokens).toBeLessThan(all.totals.totalTokens);

    const modelA = queryAppUsageFromRollup(db, { ...base, filters: { modelIds: ["model-a"] } });
    expect(modelA.models.map((m) => m.modelId)).toEqual(["model-a"]);
    // Turns and tools are not narrowed by model filters.
    expect(modelA.turnTotals.totalTurns).toBe(all.turnTotals.totalTurns);
    expect(modelA.toolTotals).toEqual(all.toolTotals);

    const unknown = queryAppUsageFromRollup(db, { ...base, filters: { modelIds: [""] } });
    expect(unknown.models.map((m) => m.modelId)).toEqual([""]);
  });

  it("lists filter options for the window and ignores the active filters", async () => {
    await seedUsage();
    recomputeForkUsageRollup(db, NOW);
    const base = { since: 0, until: NOW, tzOffsetMs: 0, includeFacets: true };

    const unfiltered = queryAppUsageFromRollup(db, base);
    expect(unfiltered.facets?.models).toEqual(["", "model-a", "model-b"]);
    expect(unfiltered.facets?.providers).toEqual(["p1", "p2"]);
    expect(unfiltered.facets?.querySources).toEqual(["main_turn", "subagent"]);
    expect(unfiltered.facets?.workspaces).toEqual(["/work/alpha", "/work/beta"]);

    const filtered = queryAppUsageFromRollup(db, { ...base, filters: { modelIds: ["model-a"] } });
    expect(filtered.facets).toEqual(unfiltered.facets);
    expect(queryAppUsageFromRollup(db, { ...base, includeFacets: false }).facets).toBeUndefined();
  });

  it("falls back to raw tables for unfiltered reads and fails filtered reads when the rollup is gone", async () => {
    await seedUsage();
    const input = { since: NOW - 30 * DAY, until: NOW, tzOffsetMs: 0 };
    recomputeForkUsageRollup(db, NOW);
    db.exec("drop table fork_usage_bucket");

    const fallback = await queryAppUsageWithRollup(db, input);
    expect(normalize(fallback)).toEqual(normalize(await usage.queryAppUsage(db, input)));
    await expect(
      queryAppUsageWithRollup(db, { ...input, filters: { modelIds: ["model-a"] } }),
    ).rejects.toThrow("usage_rollup_unavailable");
  });
});
