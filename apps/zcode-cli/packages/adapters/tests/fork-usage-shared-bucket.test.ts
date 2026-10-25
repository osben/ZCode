import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it, expect } from "vitest";
import { createProjectId, createSessionId } from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";
import * as usage from "../src/storage/session-store/repositories/usage.js";
import { recomputeForkUsageRollup } from "../src/storage/session-store/repositories/fork-usage-rollup.js";
import { queryAppUsageWithRollup } from "../src/storage/session-store/repositories/fork-usage-query.js";

const MINUTE = 60_000;
const BUCKET = 15 * MINUTE;
const NOW = Math.ceil(1_900_000_000_000 / BUCKET) * BUCKET;

it("preserves a deletion-protected shared bucket and applies later external row deltas", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-shared-bucket-"));
  const dbPath = join(root, "session.sqlite");
  const store = await createSqliteSessionStore({ dbPath });
  const db = new DatabaseSync(dbPath);
  const s1 = createSessionId("s1");
  const s2 = createSessionId("s2");
  const record = (id: string, sessionID: typeof s1, tokens: number) =>
    usage.recordModelUsage(db, {
      id,
      logicalRequestId: id,
      sessionID,
      querySource: "main_turn",
      providerId: "provider",
      modelId: "shared-model",
      status: "completed",
      startedAt: NOW,
      inputTokens: tokens,
      outputTokens: 0,
      computedTotalTokens: tokens,
    });
  try {
    for (const id of ["s1", "s2"]) {
      await store.createSession({
        id: createSessionId(id),
        projectID: createProjectId(id),
        slug: id,
        directory: "/work/alpha",
        title: id,
        version: "test",
      });
    }
    await record("protected-s1", s1, 10);
    await record("protected-s2", s2, 20);
    recomputeForkUsageRollup(db, NOW);

    await store.deleteSessionTree!({ rootIds: [s1] });
    const input = { since: NOW - BUCKET, until: NOW + BUCKET, tzOffsetMs: 0 };
    expect((await queryAppUsageWithRollup(db, input)).totals.totalTokens).toBe(30);

    // The other shared-database connection updates a row already represented by the protected
    // baseline, then inserts a newer row in the same time bucket.
    await record("protected-s2", s2, 25);
    await record("protected-new", s2, 5);
    expect((await queryAppUsageWithRollup(db, input)).totals.totalTokens).toBe(40);
    recomputeForkUsageRollup(db, NOW + 10 * MINUTE);
    expect((await queryAppUsageWithRollup(db, input)).totals.totalTokens).toBe(40);
  } finally {
    db.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
