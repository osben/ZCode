import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectId, createSessionId, createTurnId, createToolCallId } from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";
import * as usage from "../src/storage/session-store/repositories/usage.js";
import { deleteSessionTree } from "../src/storage/session-store/repositories/session-tree.js";
import { recomputeForkUsageRollup } from "../src/storage/session-store/repositories/fork-usage-rollup.js";
import {
  queryAppUsageFromRollup,
  queryAppUsageWithRollup,
} from "../src/storage/session-store/repositories/fork-usage-query.js";

const DAY = 86_400_000;
const roots: string[] = [];
const handles: DatabaseSync[] = [];
afterEach(async () => {
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(age = DAY) {
  const root = await mkdtemp(join(tmpdir(), "zcode-detached-"));
  roots.push(root);
  const dbPath = join(root, "usage.sqlite");
  const store = createSqliteSessionStore({ dbPath });
  for (const id of ["deleted", "surviving"])
    await store.createSession({
      id: createSessionId(id),
      projectID: createProjectId(id),
      slug: id,
      directory: "/repo",
      title: `${id} private title`,
      version: "test",
    });
  store.close();
  const db = new DatabaseSync(dbPath);
  handles.push(db);
  db.exec("pragma foreign_keys = on");
  const now = Date.now();
  const startedAt = Math.floor((now - age) / 900_000) * 900_000;
  for (const [id, tokens, duration] of [
    ["deleted", 100, 1000],
    ["surviving", 200, 2000],
  ] as const) {
    const sessionID = createSessionId(id);
    const turnID = createTurnId(`turn-${id}`);
    await usage.recordModelUsage(db, {
      id: `model-${id}`,
      logicalRequestId: `req-${id}`,
      sessionID,
      turnID,
      querySource: "main_turn",
      providerId: "provider",
      modelId: "model",
      status: "completed",
      startedAt,
      inputTokens: tokens,
      outputTokens: 0,
      computedTotalTokens: tokens,
    });
    await usage.upsertTurnUsage(db, {
      sessionID,
      turnID,
      status: "completed",
      startedAt,
      durationMs: duration,
      computedTotalTokens: tokens,
    });
    await usage.upsertToolUsage(db, {
      id: `${String(sessionID)}:tool`,
      sessionID,
      turnID,
      toolCallID: createToolCallId(`call-${id}`),
      toolName: "Read",
      status: "completed",
      startedAt,
      durationMs: duration / 100,
    });
  }
  recomputeForkUsageRollup(db, now);
  const input = {
    since: 0,
    until: now,
    tzOffsetMs: 0,
    includeFacets: true,
    include: { sessions: true, hourly: true },
  };
  return { db, dbPath, now, startedAt, input };
}

function comparable(value: ReturnType<typeof queryAppUsageFromRollup>) {
  const { topSessions: _sessions, ...aggregates } = value;
  return aggregates;
}

describe("anonymous deletion accounting edges", () => {
  it("preserves old shared buckets, filters and exact session metrics after reopen/recompute", async () => {
    const h = await fixture(15 * DAY);
    const before = queryAppUsageFromRollup(h.db, h.input);
    deleteSessionTree(h.db, [createSessionId("deleted")]);
    recomputeForkUsageRollup(h.db, h.now + 1);
    const reopened = new DatabaseSync(h.dbPath);
    handles.push(reopened);
    const after = await queryAppUsageWithRollup(reopened, h.input);
    expect(comparable(after)).toEqual(comparable(before));
    expect(after.turnTotals).toMatchObject({ totalSessions: 2, longestSessionMs: 2000 });
    expect(after.topSessions?.map((row) => row.sessionId)).toEqual([
      String(createSessionId("surviving")),
    ]);
    const filtered = queryAppUsageFromRollup(reopened, {
      ...h.input,
      filters: { workspaceKeys: ["/repo"], modelIds: ["model"] },
    });
    expect(filtered.totals.totalTokens).toBe(300);
    expect(
      queryAppUsageFromRollup(reopened, { ...h.input, filters: { workspaceKeys: ["/elsewhere"] } })
        .totals.totalTokens,
    ).toBe(0);
  });

  it("preserves a partial raw bucket and incorporates subsequent external updates exactly once", async () => {
    const h = await fixture();
    h.db.prepare("delete from model_usage where id = ?").run("model-deleted");
    const before = queryAppUsageFromRollup(h.db, h.input);
    deleteSessionTree(h.db, [createSessionId("deleted")]);
    expect(comparable(queryAppUsageFromRollup(h.db, h.input))).toEqual(comparable(before));
    const external = new DatabaseSync(h.dbPath);
    handles.push(external);
    external
      .prepare(
        "update model_usage set input_tokens = 400, computed_total_tokens = 400 where id = ?",
      )
      .run("model-surviving");
    external
      .prepare("update tool_usage set duration_ms = 100 where id = ?")
      .run(`${String(createSessionId("surviving"))}:tool`);
    const after = await queryAppUsageWithRollup(h.db, h.input);
    expect(after.totals.totalTokens).toBe(500);
    expect(after.tools[0]?.avgDurationMs).toBe(55);
    recomputeForkUsageRollup(h.db, h.now + 2);
    expect((await queryAppUsageWithRollup(h.db, h.input)).totals.totalTokens).toBe(500);
    await usage.recordModelUsage(external, {
      id: "new-same-bucket",
      logicalRequestId: "new-request",
      sessionID: createSessionId("surviving"),
      turnID: createTurnId("turn-surviving"),
      querySource: "main_turn",
      providerId: "provider",
      modelId: "model",
      status: "completed",
      startedAt: h.startedAt,
      inputTokens: 50,
      outputTokens: 0,
      computedTotalTokens: 50,
    });
    expect((await queryAppUsageWithRollup(h.db, h.input)).totals.totalTokens).toBe(550);
    external.prepare("delete from model_usage where id = ?").run("model-surviving");
    expect((await queryAppUsageWithRollup(h.db, h.input)).totals.totalTokens).toBe(550);
  });

  it("rolls back anonymous transfer together with content and retries without duplication", async () => {
    const h = await fixture();
    h.db.exec(
      "create trigger reject_delete before delete on session begin select raise(abort, 'injected rollback'); end",
    );
    expect(() => deleteSessionTree(h.db, [createSessionId("deleted")])).toThrow(
      "injected rollback",
    );
    expect(
      h.db.prepare("select id from session where id = ?").get(String(createSessionId("deleted"))),
    ).toBeTruthy();
    expect(queryAppUsageFromRollup(h.db, h.input).turnTotals.totalSessions).toBe(2);
    h.db.exec("drop trigger reject_delete");
    deleteSessionTree(h.db, [createSessionId("deleted")]);
    deleteSessionTree(h.db, [createSessionId("deleted")]);
    expect(queryAppUsageFromRollup(h.db, h.input).totals.totalTokens).toBe(300);
    const detached = h.db.prepare("select * from fork_usage_detached_turn").all();
    expect(detached).toHaveLength(1);
    expect(JSON.stringify(detached)).not.toContain("private title");
    expect(
      JSON.stringify(h.db.prepare("select * from fork_usage_protected_tool_raw").all()),
    ).not.toContain(String(createSessionId("deleted")));
    expect(
      h.db.prepare("select opaque_session_id from fork_usage_detached_turn").get(),
    ).not.toEqual({ opaque_session_id: String(createSessionId("deleted")) });
  });

  it("does not fall back to raw-only totals when protected data becomes unavailable", async () => {
    const h = await fixture();
    deleteSessionTree(h.db, [createSessionId("deleted")]);
    h.db.exec("drop view fork_usage_bucket_all");
    await expect(queryAppUsageWithRollup(h.db, h.input)).rejects.toThrow(
      "usage_rollup_unavailable",
    );
  });

  it("expires anonymous and protected contributions at the existing retention boundary", async () => {
    const h = await fixture();
    deleteSessionTree(h.db, [createSessionId("deleted")]);
    h.db.exec("delete from model_usage; delete from turn_usage; delete from tool_usage");
    recomputeForkUsageRollup(h.db, h.now + 731 * DAY);
    const after = queryAppUsageFromRollup(h.db, { ...h.input, until: h.now + 731 * DAY });
    expect(after.totals.totalTokens).toBe(0);
    expect(after.turnTotals.totalSessions).toBe(0);
  });
  it("does not double count a protected group rewritten by an older rollup writer", async () => {
    const h = await fixture();
    deleteSessionTree(h.db, [createSessionId("deleted")]);
    h.db.exec("insert into fork_usage_bucket select * from fork_usage_protected_model");
    h.db.exec("insert into fork_usage_tool select * from fork_usage_protected_tool");
    const after = await queryAppUsageWithRollup(h.db, h.input);
    expect(after.totals.totalTokens).toBe(300);
    expect(after.toolTotals.toolCallCount).toBe(2);
  });

  it("does not revive expired raw usage when deleting an old unopened database", async () => {
    const h = await fixture();
    const expired = h.now - 731 * DAY;
    for (const table of ["model_usage", "turn_usage", "tool_usage"]) {
      h.db.prepare(`update ${table} set started_at = ?`).run(expired);
    }
    recomputeForkUsageRollup(h.db, h.now);
    deleteSessionTree(h.db, [createSessionId("deleted")]);
    expect(queryAppUsageFromRollup(h.db, h.input).totals.totalTokens).toBe(0);
    expect(queryAppUsageFromRollup(h.db, h.input).turnTotals.totalSessions).toBe(0);
  });
});
