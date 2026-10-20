/**
 * Tests for the SQLite JournalStorePort (dwf_* tables).
 *
 * Two layers: the shared contract suite (the same one as the in-memory implementation, from
 * `@zcode/dynamic-workflow/testing`) plus SQLite-specific semantics the in-memory implementation
 * fundamentally cannot express — records survive a cross-process close/reopen, event sequences
 * keep counting on, and deleting a run cascades to its actors/nodes/events. The latter is the real
 * purpose of roadmap step 8.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import type {
  ActorRecord,
  Caps,
  JournalStorePort,
  NodeRecord,
  RunRecord,
} from "@zcode/dynamic-workflow";
import { runJournalStoreContract } from "@zcode/dynamic-workflow/testing";
import type { DwfRunIntrospectionQueries, DwfRunSessionListItem } from "../src/storage/index.js";
import { createDwfJournalStore, createSqliteSessionStore } from "../src/storage/index.js";
import { runSqliteSessionMigrationsSync } from "../src/storage/session-store/migration-runner.js";

const openDatabases: DatabaseSync[] = [];

/** Opens a brand-new migrated database per call; the contract suite requires implementations to share no state. */
function openJournalDb(dbPath = ":memory:"): { db: DatabaseSync; journal: JournalStorePort } {
  const db = new DatabaseSync(dbPath);
  openDatabases.push(db);
  runSqliteSessionMigrationsSync(db, dbPath);
  return { db, journal: createDwfJournalStore(db) };
}

afterAll(() => {
  for (const db of openDatabases) {
    try {
      db.close();
    } catch {
      // Test-only database; a close failure must not mask a real assertion failure.
    }
  }
});


runJournalStoreContract(() => openJournalDb().journal);

const CAPS: Caps = { maxConcurrency: 4 };

const RUN: RunRecord = {
  runId: "dwf_run_1",
  parentSessionId: "ses_parent",
  cwd: "/repo",
  scriptText: "const planner = agent('planner');",
  scriptHash: "sha-1",
  caps: CAPS,
  spentTokens: 0,
  status: "running",
};

const ACTOR: ActorRecord = {
  runId: RUN.runId,
  siteId: "actor#1",
  ordinal: 1,
  name: "planner",
  persona: { name: "planner", system: "plan carefully" },
  sessionId: "ses_actor",
  // The frozen persona and the model the subagent actually ran with are stored in separate
  // columns; both must survive a reopen.
  resolvedModel: "anthropic/haiku",
};

const NODE: NodeRecord = {
  runId: RUN.runId,
  siteId: "ask#1",
  ordinal: 1,
  kind: "ask",
  actorSiteId: "actor#1",
  actorOrdinal: 1,
  actorSeq: 0,
  inputHash: "abc123",
  status: "completed",
  result: { plan: ["step one", "step two"], nested: { depth: 2 } },
  stats: { tokens: 120, toolCalls: 2, turns: 1 },
};

describe("SQLite dwf journal store", () => {
  it("survives closing and reopening the database file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-journal-"));
    const dbPath = join(tempRoot, "session.sqlite");

    try {
      const first = createSqliteSessionStore({ dbPath });
      const journal = first.workflowJournalStore();
      journal.createRun(RUN);
      journal.putActor(ACTOR);
      journal.putNode(NODE);
      journal.appendEvent(RUN.runId, { type: "run-started", runId: RUN.runId, caps: CAPS });
      journal.appendEvent(RUN.runId, { type: "log", message: "before the crash" });
      // The last usage write-back before settlement: resume must see it, not start over from zero.
      journal.updateRunUsage(RUN.runId, 120);
      first.close();

      const second = createSqliteSessionStore({ dbPath });
      const resumed = second.workflowJournalStore();

      expect(resumed.getRun(RUN.runId)).toEqual({ ...RUN, spentTokens: 120 });
      expect(resumed.getActor(RUN.runId, "actor#1", 1)).toEqual(ACTOR);
      expect(resumed.getNode(RUN.runId, "ask#1", 1)).toEqual(NODE);
      expect(resumed.listActors(RUN.runId, { withPersona: true })).toEqual([ACTOR]);
      expect(resumed.listNodes(RUN.runId, { kinds: "all", withResult: true })).toEqual([NODE]);
      expect(
        resumed.listEvents(RUN.runId, { types: "all", reportItems: "all" }).map((e) => e.sequence),
      ).toEqual([0, 1]);

      // Event sequences keep counting across reopens (engine-assigned, monotonic across resumes).
      // The assertion uses toMatchObject: the append also returns the write instant
      // (StoredEvent.timeCreated), but this case is about the sequence, not the clock — the clock
      // is pinned by the contract suite's timeCreated case.
      expect(resumed.appendEvent(RUN.runId, { type: "log", message: "after resume" })).toMatchObject({
        sequence: 2,
        event: { type: "log", message: "after resume" },
      });
      expect(
        resumed.listEvents(RUN.runId, { types: "all", reportItems: "all" }).at(-1)?.event,
      ).toEqual({
        type: "log",
        message: "after resume",
      });
      second.close();
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  // The second writer of `caps_max_concurrency` (docs/dynamic-workflow/concurrency.md
  // "Two bounds on a run"). The contract suite already pins the read/write semantics; what is
  // pinned here are the two things the in-memory implementation cannot express: the UPDATE really
  // lists only that column (every other column verbatim untouched), and the new value survives a
  // cross-process reopen — resume inherits exactly it.
  it("retunes caps_max_concurrency in place, touching no other column", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-journal-caps-"));
    const dbPath = join(tempRoot, "session.sqlite");
    try {
      const first = createSqliteSessionStore({ dbPath });
      const journal = first.workflowJournalStore();
      journal.createRun(RUN);
      journal.updateRunUsage(RUN.runId, 120);
      journal.updateRunCaps(RUN.runId, { maxConcurrency: 2 });

      // In the same database, every column except caps still holds the value from run creation.
      expect(journal.getRun(RUN.runId)).toEqual({
        ...RUN,
        caps: { maxConcurrency: 2 },
        spentTokens: 120,
      });
      first.close();

      const second = createSqliteSessionStore({ dbPath });
      expect(second.workflowJournalStore().getRun(RUN.runId)?.caps).toEqual({ maxConcurrency: 2 });
      second.close();
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("cascades a run delete to its actors, nodes and events", () => {
    const { db, journal } = openJournalDb();
    journal.createRun(RUN);
    journal.createRun({ ...RUN, runId: "dwf_run_2" });
    journal.putActor(ACTOR);
    journal.putNode(NODE);
    journal.appendEvent(RUN.runId, { type: "log", message: "doomed" });
    journal.putActor({ ...ACTOR, runId: "dwf_run_2" });

    db.prepare("delete from dwf_run where id = ?").run(RUN.runId);

    expect(journal.getRun(RUN.runId)).toBeUndefined();
    expect(journal.listActors(RUN.runId, { withPersona: true })).toEqual([]);
    expect(journal.listNodes(RUN.runId, { kinds: "all", withResult: true })).toEqual([]);
    expect(journal.listEvents(RUN.runId, { types: "all", reportItems: "all" })).toEqual([]);
    // The cascade eats only the deleted run's rows.
    expect(journal.listActors("dwf_run_2", { withPersona: true })).toHaveLength(1);
  });

  it("rejects an actor belonging to no run", () => {
    // FK is on (the migration runner sets pragma foreign_keys = on), so an orphan write must fail
    // on the spot instead of leaving a record that can never be read back. Orphan events and
    // null/absent-result semantics are already covered by the shared contract suite on both
    // implementations; this only adds that the FK itself really takes effect.
    const { journal } = openJournalDb();
    expect(() => journal.putActor({ ...ACTOR, runId: "ghost" })).toThrow();
  });

  // The run artifact's column. The in-memory implementation cannot express either "the column
  // exists" or "decoding old rows".
  it("dwf_run 带 result_json 列", () => {
    const { db } = openJournalDb();
    const columns = (
      db.prepare("select name from pragma_table_info('dwf_run')").all() as unknown as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(columns).toContain("result_json");
  });

  it("run 产物跨重开数据库文件存活", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-result-"));
    const dbPath = join(tempRoot, "session.sqlite");

    try {
      const first = createSqliteSessionStore({ dbPath });
      const journal = first.workflowJournalStore();
      journal.createRun(RUN);
      journal.updateRunStatus(RUN.runId, "completed", {
        result: { report: "done", steps: [1, 2, 3] },
      });
      first.close();

      // The persistence face of a desktop-observed bug: once the process exits, the artifact must
      // still be readable back from the journal.
      const second = createSqliteSessionStore({ dbPath });
      const resumed = second.workflowJournalStore().getRun(RUN.runId);
      expect(resumed?.status).toBe("completed");
      expect(resumed?.result).toEqual({ report: "done", steps: [1, 2, 3] });
      second.close();
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("result_json 为 NULL 的旧行解码不炸且 result 缺席", () => {
    // A run row written before 0020: the column is newly added and its value is NULL. decodeRun
    // must return a record without a result key, not an undefined value or a throw — otherwise
    // every historical run becomes unreadable after the upgrade.
    const { db, journal } = openJournalDb();
    journal.createRun(RUN);
    db.prepare("update dwf_run set result_json = null where id = ?").run(RUN.runId);

    const record = journal.getRun(RUN.runId);
    expect(record).toEqual(RUN);
    expect("result" in (record ?? {})).toBe(false);
  });

  // The actor's resolved model tier. Again the two things the in-memory implementation cannot
  // express.
  it("dwf_actor 带 resolved_model 列", () => {
    const { db } = openJournalDb();
    const columns = (
      db.prepare("select name from pragma_table_info('dwf_actor')").all() as unknown as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(columns).toContain("resolved_model");
  });

  it("resolved_model 为 NULL 的旧行解码不炸且 resolvedModel 缺席", () => {
    // Actor rows written before 0023 (and rows the host has not resolved yet): must decode into a
    // record without a resolvedModel key, not an undefined value or a throw. The tier inside the
    // persona and this column are independently absent.
    const { db, journal } = openJournalDb();
    journal.createRun(RUN);
    journal.putActor(ACTOR);
    db.prepare("update dwf_actor set resolved_model = null where run_id = ?").run(RUN.runId);

    const record = journal.getActor(RUN.runId, "actor#1", 1);
    expect(record).toEqual({ ...ACTOR, resolvedModel: undefined });
    expect("resolvedModel" in (record ?? {})).toBe(false);
    // The persona still lives in persona_json: losing the model record is not losing the identity.
    expect(record?.persona?.system).toBe("plan carefully");
  });

  it("同键重写只换 resolved_model，persona 与 session_id 原样保留", () => {
    // In production this is exactly the driver-side read-modify-write shape of
    // `journalActorResolvedModel`: putActor replaces the whole row, so "update only the resolved
    // result" requires the caller to supply every other field, and the storage layer must write
    // them faithfully.
    const { journal } = openJournalDb();
    journal.createRun(RUN);
    journal.putActor(ACTOR);
    journal.putActor({ ...ACTOR, resolvedModel: "anthropic/sonnet" });

    expect(journal.getActor(RUN.runId, "actor#1", 1)).toEqual({
      ...ACTOR,
      resolvedModel: "anthropic/sonnet",
    });
    expect(journal.listActors(RUN.runId, { withPersona: true })).toHaveLength(1);
  });

  it("终态与产物一笔写：单条 UPDATE 同时落 status 与 result_json", () => {
    // Writing in two statements would open a crash window of "completed but artifact lost" —
    // exactly the loss category this column is meant to shut out.
    const { db, journal } = openJournalDb();
    journal.createRun(RUN);
    journal.updateRunStatus(RUN.runId, "completed", { result: "artifact text" });

    const row = db.prepare("select status, result_json from dwf_run where id = ?").get(RUN.runId) as
      | { result_json: string | null; status: string }
      | undefined;
    expect(row?.status).toBe("completed");
    expect(row?.result_json).toBe(JSON.stringify("artifact text"));
  });

  // The `kind` CHECK includes 'report' — verifiable only against a real database; the in-memory
  // implementation has no CHECK at all.
  it("dwf_node 接受 kind:\"report\" 并原样回读", () => {
    const { journal } = openJournalDb();
    journal.createRun(RUN);
    const report: NodeRecord = {
      runId: RUN.runId,
      siteId: "report#1",
      ordinal: 1,
      kind: "report",
      inputHash: "h1",
      status: "completed",
      result: { finding: "两处重复实现", paths: ["src/a.ts", "src/b.ts"] },
    };
    journal.putNode(report);

    // A whole-row toEqual: the three actor columns must come back absent (a report has no actor),
    // and status is always completed.
    expect(journal.getNode(RUN.runId, "report#1", 1)).toEqual(report);
    const stored = journal.getNode(RUN.runId, "report#1", 1);
    expect(stored !== undefined && "actorSeq" in stored).toBe(false);
    expect(stored !== undefined && "actorSiteId" in stored).toBe(false);
  });

  it("CHECK 仍然拒绝一个不存在的 kind", () => {
    // The point of rebuilding the CHECK is that it **still blocks**: allowing one value is not
    // tearing down the gate.
    const { journal } = openJournalDb();
    journal.createRun(RUN);
    expect(() =>
      journal.putNode({
        runId: RUN.runId,
        siteId: "bogus#1",
        ordinal: 1,
        kind: "made-up" as NodeRecord["kind"],
        inputHash: "h",
        status: "completed",
      }),
    ).toThrow();
  });


  // The `kind` CHECK includes 'world-run' (the journaled command execution of world.run,
  // docs/dynamic-workflow/authoring.md).
  it("dwf_node 接受 kind:\"world-run\" 并原样回读", () => {
    const { journal } = openJournalDb();
    journal.createRun(RUN);
    const worldRun: NodeRecord = {
      runId: RUN.runId,
      siteId: "world-read#3",
      ordinal: 2,
      kind: "world-run",
      inputHash: "h-run",
      status: "completed",
      result: { exitCode: 1, stdout: "", stderr: "proof failed" },
    };
    journal.putNode(worldRun);
    expect(journal.getNode(RUN.runId, "world-read#3", 2)).toEqual(worldRun);
  });

  it("dwf_node 带 input_json 列：有界输入原样回读，ask 行缺席", () => {
    // The workspace transcript's "what ran" (docs/dynamic-workflow/transcript-and-notifications.md).
    const { db, journal } = openJournalDb();
    journal.createRun(RUN);
    const worldRun: NodeRecord = {
      runId: RUN.runId,
      siteId: "world-read#4",
      ordinal: 1,
      kind: "world-run",
      inputHash: "h-in",
      input: { op: "run", args: ["pnpm", ["vitest", "run", "--changed"], { timeoutMs: 60_000 }] },
      status: "running",
    };
    journal.putNode(worldRun);
    expect(journal.getNode(RUN.runId, "world-read#4", 1)).toEqual(worldRun);
    // Settlement is a whole-row upsert: input must come back with the row, not be wiped to NULL.
    const settled: NodeRecord = {
      ...worldRun,
      status: "completed",
      result: { exitCode: 1, stdout: "FAIL", stderr: "" },
    };
    journal.putNode(settled);
    expect(journal.getNode(RUN.runId, "world-read#4", 1)).toEqual(settled);
    const column = db
      .prepare("select input_json from dwf_node where site_id = ?")
      .get("world-read#4") as { input_json: string | null };
    expect(JSON.parse(column.input_json ?? "null")).toEqual(worldRun.input);
    journal.putNode(NODE);
    const ask = journal.getNode(RUN.runId, NODE.siteId, NODE.ordinal);
    expect(ask !== undefined && "input" in ask).toBe(false);
  });

  it("input_json 为 NULL 的旧行解码不炸且 input 缺席", () => {
    const { db, journal } = openJournalDb();
    journal.createRun(RUN);
    db.prepare(
      `insert into dwf_node (run_id, site_id, ordinal, kind, input_hash, status, result_json, time_created, time_updated)
       values (?, ?, ?, 'world-read', 'h', 'completed', ?, 1, 2)`,
    ).run(RUN.runId, "world-read#9", 1, JSON.stringify("file body"));
    const row = journal.getNode(RUN.runId, "world-read#9", 1);
    expect(row).toBeDefined();
    expect(row !== undefined && "input" in row).toBe(false);
    expect(row?.result).toBe("file body");
  });

  it("listWorldNodes 只回 world-read / world-run 行，按落库先后，带时间戳与正文字节数、不带正文", () => {
    const { journal } = openJournalDb();
    const queries = journal as unknown as DwfRunIntrospectionQueries;
    journal.createRun(RUN);
    journal.putNode(NODE);
    journal.putNode({
      runId: RUN.runId,
      siteId: "world-read#2",
      ordinal: 1,
      kind: "world-read",
      inputHash: "a",
      input: { op: "read", args: ["src/x.ts"] },
      status: "completed",
      result: "export const x = 1;\n",
    });
    journal.putNode({
      runId: RUN.runId,
      siteId: "world-read#3",
      ordinal: 1,
      kind: "world-run",
      inputHash: "b",
      input: { op: "run", args: ["lake", ["build"]] },
      status: "running",
    });
    journal.putNode({
      runId: RUN.runId,
      siteId: "report#1",
      ordinal: 1,
      kind: "report",
      inputHash: "r",
      status: "completed",
      result: { finding: "x" },
    });
    const rows = queries.listWorldNodes(RUN.runId);
    expect(rows.map((row) => row.siteId)).toEqual(["world-read#2", "world-read#3"]);
    expect(rows[0]).toMatchObject({
      kind: "world-read",
      status: "completed",
      input: { op: "read", args: ["src/x.ts"] },
      resultBytes: JSON.stringify("export const x = 1;\n").length,
    });
    expect("result" in rows[0]!).toBe(false);
    expect(typeof rows[0]!.timeCreated).toBe("number");
    expect(typeof rows[0]!.timeUpdated).toBe("number");
    expect("resultBytes" in rows[1]!).toBe(false);
    expect(queries.listWorldNodes("dwfrun-unknown")).toEqual([]);
  });

  it("listWorldNodes 用 SQLite 的 JSON 函数在库内算摘要：数组计数、run 的 exitCode 与输出字节数", () => {
    const { journal } = openJournalDb();
    const queries = journal as unknown as DwfRunIntrospectionQueries;
    journal.createRun(RUN);
    journal.putNode({
      runId: RUN.runId,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: "g",
      input: { op: "glob", args: ["src/**/*.ts"] },
      status: "completed",
      result: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    journal.putNode({
      runId: RUN.runId,
      siteId: "world-read#2",
      ordinal: 1,
      kind: "world-run",
      inputHash: "r",
      input: { op: "run", args: ["pnpm", ["test"]] },
      status: "completed",
      result: { exitCode: 1, stdout: "ok\n", stderr: "é" },
    });
    journal.putNode({
      runId: RUN.runId,
      siteId: "world-read#3",
      ordinal: 1,
      kind: "world-read",
      inputHash: "s",
      input: { op: "git-status", args: [] },
      status: "completed",
      result: " M src/a.ts\n",
    });
    journal.putNode({
      runId: RUN.runId,
      siteId: "world-read#4",
      ordinal: 1,
      kind: "world-run",
      inputHash: "f",
      input: { op: "run", args: ["false"] },
      status: "failed",
      error: { code: "DriverError", message: "boom" },
    });
    const rows = queries.listWorldNodes(RUN.runId);
    expect(rows[0]).toMatchObject({ resultCount: 3 });
    expect("exitCode" in rows[0]!).toBe(false);
    // stderr is a two-byte character: the report is UTF-8 bytes, not character count.
    expect(rows[1]).toMatchObject({ exitCode: 1, stdoutBytes: 3, stderrBytes: 2 });
    expect("resultCount" in rows[1]!).toBe(false);
    // String body: neither array nor object, so every summary column is absent except the byte
    // count.
    expect(rows[2]).toMatchObject({ resultBytes: JSON.stringify(" M src/a.ts\n").length });
    expect("resultCount" in rows[2]!).toBe(false);
    expect("exitCode" in rows[2]!).toBe(false);
    // A failed row has no body: no summary at all, only the error.
    expect(rows[3]).toMatchObject({ status: "failed", error: { code: "DriverError", message: "boom" } });
    expect("resultBytes" in rows[3]!).toBe(false);
    expect("exitCode" in rows[3]!).toBe(false);
  });



  // The expression index on dwf_event must not merely exist, it must **actually be used**: its
  // entire reason to exist is letting the board fetch data without scanning a long run's whole
  // event table (the largest table there is). If the query plan changes, this test goes off.
  it("dwf_event 的表达式索引真的服务于按 artifactId 取事件", () => {
    const { db } = openJournalDb();
    const plan = (
      db
        .prepare(
          `explain query plan
           select sequence from dwf_event
           where run_id = ? and type = 'report' and json_extract(payload_json, '$.artifactId') = ?
           order by sequence`,
        )
        .all("run_1", "perf") as unknown as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(" | ");
    expect(plan).toContain("dwf_event_artifact_idx");
  });
});

/**
 * The narrow query for orphan sweeping. Deliberately **not** on `JournalStorePort`: the engine
 * never looks up runs by parent session, and this query serves only the host-side sweep
 * (`bootstrap/src/app/dynamic-workflow-run-service.ts` calls it after capability probing at
 * construction). The in-memory implementation does not provide it, so its semantics can only be
 * pinned here, against the real database.
 */
interface DwfNonTerminalRunQuery {
  listNonTerminalRuns(parentSessionId: string): RunRecord[];
}

/**
 * Opens a journal with the narrow query. Uses the **same kind** of capability probing as the host
 * side: if the method name drifts, the host's sweep would silently skip (back to the
 * "orphan runs stay running forever" bug), so it must fail loudly here.
 */
function openSweepableJournal(): JournalStorePort & DwfNonTerminalRunQuery {
  const { journal } = openJournalDb();
  if (typeof (journal as Partial<DwfNonTerminalRunQuery>).listNonTerminalRuns !== "function") {
    throw new Error("sqlite dwf journal 缺少 listNonTerminalRuns：宿主侧的孤儿收敛会静默跳过");
  }
  return journal as JournalStorePort & DwfNonTerminalRunQuery;
}

describe("SQLite dwf journal store — listNonTerminalRuns", () => {
  const PARENT = "ses_sweep_parent";

  /** Seeds a dwf_run row (only parent session and status matter). */
  function seed(
    journal: JournalStorePort,
    input: { runId: string; status: RunRecord["status"]; parentSessionId?: string },
  ): void {
    journal.createRun({
      runId: input.runId,
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      caps: CAPS,
      spentTokens: 0,
      status: input.status,
    });
  }

  it("只回本父会话的非终态行", () => {
    const journal = openSweepableJournal();
    seed(journal, { parentSessionId: PARENT, runId: "run_running", status: "running" });
    seed(journal, { parentSessionId: PARENT, runId: "run_pending", status: "pending" });
    seed(journal, { parentSessionId: PARENT, runId: "run_completed", status: "completed" });
    seed(journal, { parentSessionId: PARENT, runId: "run_errored", status: "errored" });
    seed(journal, { parentSessionId: PARENT, runId: "run_stopped", status: "stopped" });
    // A sibling session's in-flight run and rows with no parent session do not belong to this
    // session — querying too broadly would mark them dead.
    seed(journal, { parentSessionId: "ses_other", runId: "run_sibling", status: "running" });
    seed(journal, { runId: "run_parentless", status: "running" });

    const rows = journal.listNonTerminalRuns(PARENT);

    expect(rows.map((row) => row.runId).sort()).toEqual(["run_pending", "run_running"]);
    // What comes back is the full RunRecord (the same decodeRun); the sweep strategy branches on
    // status and needs no second query.
    expect(rows.every((row) => row.parentSessionId === PARENT)).toBe(true);
    expect(rows.find((row) => row.runId === "run_running")?.status).toBe("running");
  });

  it("收敛写入之后同一个查询返回空（幂等的 SQL 侧依据）", () => {
    const journal = openSweepableJournal();
    seed(journal, { parentSessionId: PARENT, runId: "run_orphan", status: "running" });

    journal.updateRunStatus("run_orphan", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owning process exited" },
    });

    expect(journal.listNonTerminalRuns(PARENT)).toEqual([]);
  });

  it("未知父会话返回空数组", () => {
    const journal = openSweepableJournal();
    seed(journal, { parentSessionId: PARENT, runId: "run_running", status: "running" });

    expect(journal.listNonTerminalRuns("ses_never_seen")).toEqual([]);
  });
});

/**
 * The host-side query face for run introspection (`ListWorkflowRuns` / `GetWorkflowRun`). Same
 * treatment as listNonTerminalRuns: the engine never enumerates runs, so these methods stay out of
 * the domain `JournalStorePort` and the in-memory implementation does not provide them either —
 * their semantics can only be pinned here, against the real database (the "enumeration query
 * ownership" row of docs/dynamic-workflow/launch.md).
 */
function openIntrospectableJournal(): {
  db: DatabaseSync;
  journal: JournalStorePort & DwfRunIntrospectionQueries;
} {
  const { db, journal } = openJournalDb();
  // The **same kind** of capability probing as the host side: if a method name drifts, the two
  // tools silently degrade to "this session lacks the capability", so it must fail loudly here.
  for (const method of [
    "listRuns",
    "getRunRow",
    "countNodesByStatus",
    "listRecentLogEvents",
    "listArtifactRows",
    "listArtifactItems",
    "countTaggedReports",
    "listEventPage",
    "listRunLifeSpans",
  ] as const) {
    if (typeof (journal as Partial<DwfRunIntrospectionQueries>)[method] !== "function") {
      throw new Error(`sqlite dwf journal 缺少 ${method}：run 内省工具会静默不可用`);
    }
  }
  return { db, journal: journal as JournalStorePort & DwfRunIntrospectionQueries };
}

/**
 * Seeds a dwf_run row. `timeUpdated` must be pinnable explicitly: createRun writes Date.now(), so
 * several runs created within the same millisecond get the same timestamp and a descending-order
 * assertion would be impossible.
 */
function seedRun(
  db: DatabaseSync,
  journal: JournalStorePort,
  input: {
    args?: Record<string, unknown>;
    cwd?: string;
    name?: string;
    parentSessionId?: string;
    result?: unknown;
    runId: string;
    scriptText?: string;
    status?: RunRecord["status"];
    timeUpdated?: number;
  },
): void {
  journal.createRun({
    runId: input.runId,
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.args === undefined ? {} : { args: input.args }),
    ...(input.scriptText === undefined ? {} : { scriptText: input.scriptText }),
    caps: CAPS,
    spentTokens: 0,
    status: input.status ?? "running",
  });
  if (input.result !== undefined) {
    journal.updateRunStatus(input.runId, input.status ?? "completed", { result: input.result });
  }
  if (input.timeUpdated !== undefined) {
    db.prepare("update dwf_run set time_updated = ? where id = ?").run(
      input.timeUpdated,
      input.runId,
    );
  }
}

describe("SQLite dwf journal store — dwf_run.name 与 cwd 索引", () => {
  it("dwf_run 带 name 列，且 dwf_run_cwd_idx 的形状正对枚举查询", () => {
    const { db } = openJournalDb();
    const columns = (
      db.prepare("select name from pragma_table_info('dwf_run')").all() as unknown as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(columns).toContain("name");

    // The index column order is the query shape (cwd equality + time_updated ordering): reversed,
    // the index could only be scanned.
    const indexed = (
      db.prepare("select name from pragma_index_info('dwf_run_cwd_idx')").all() as unknown as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(indexed).toEqual(["cwd", "time_updated"]);
  });

  it("name 为 NULL 的旧行解码不炸且 name 缺席", () => {
    // Run rows written before 0021: the column is newly added and its value is NULL (no
    // backfill). decodeRun must return a record without a name key, otherwise every historical run
    // becomes unreadable after the upgrade.
    const { db, journal } = openJournalDb();
    journal.createRun(RUN);
    db.prepare("update dwf_run set name = null where id = ?").run(RUN.runId);

    const record = journal.getRun(RUN.runId);
    expect(record).toEqual(RUN);
    expect("name" in (record ?? {})).toBe(false);
  });

  it("updateRunStatus 不改写 name 列", () => {
    // name is written only at createRun time (the engine-exclusive metadata path). If the
    // settlement statement also listed name, a run would lose its name the moment it settled.
    const { db, journal } = openJournalDb();
    journal.createRun({ ...RUN, name: "triage the flake" });
    journal.updateRunStatus(RUN.runId, "completed", { result: "ok" });

    const row = db.prepare("select name from dwf_run where id = ?").get(RUN.runId) as
      | { name: string | null }
      | undefined;
    expect(row?.name).toBe("triage the flake");
  });
});

describe("SQLite dwf journal store — 基线形状", () => {
  // docs/dynamic-workflow/authoring.md: the budget constructor was removed wholesale. Baseline
  // 0019 creates the table directly with terminal states; this pins that the two columns do not
  // exist, that the usage column is named spent_tokens, and that reading an old-shape run record
  // back through the store leaves caps with only maxConcurrency.
  it("dwf_run 没有节点上限 / 预算列，用量列叫 spent_tokens", () => {
    const { db } = openJournalDb();
    const columns = (db.prepare("pragma table_info(dwf_run)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).not.toContain("caps_max_nodes");
    expect(columns).not.toContain("caps_budget_total");
    expect(columns).not.toContain("budget_spent");
    expect(columns).toContain("spent_tokens");

    db.prepare(
      `insert into dwf_run (id, caps_max_concurrency, spent_tokens, status, time_created, time_updated)
       values ('run_legacy', 8, 4242, 'completed', 1, 2)`,
    ).run();
    const journal = createDwfJournalStore(db);
    expect(journal.getRun("run_legacy")).toEqual({
      runId: "run_legacy",
      caps: { maxConcurrency: 8 },
      spentTokens: 4242,
      status: "completed",
    });
  });
});

describe("SQLite dwf journal store — listRuns", () => {
  const CWD = "/repo/project";

  it("只回本 cwd 的 run，按 time_updated 倒序", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_old", cwd: CWD, timeUpdated: 1_000 });
    seedRun(db, journal, { runId: "run_new", cwd: CWD, timeUpdated: 3_000 });
    seedRun(db, journal, { runId: "run_mid", cwd: CWD, timeUpdated: 2_000 });
    // Other projects' runs and rows without a cwd do not belong to this project: queried too
    // broadly, someone else's run would be placed in front of the model.
    seedRun(db, journal, { runId: "run_other", cwd: "/repo/elsewhere", timeUpdated: 9_000 });
    seedRun(db, journal, { runId: "run_cwdless", timeUpdated: 9_000 });

    const rows = journal.listRuns({ cwd: CWD, limit: 20 });
    expect(rows.map((row) => row.runId)).toEqual(["run_new", "run_mid", "run_old"]);
  });

  it("cwd 是字面匹配，不做路径规范化", () => {
    // Same source as the submit write (context.workingDirectory is stored and queried verbatim).
    // Normalizing unilaterally on the read side would only create one-sided mismatches.
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: CWD });

    expect(journal.listRuns({ cwd: `${CWD}/`, limit: 20 })).toEqual([]);
    expect(journal.listRuns({ cwd: CWD, limit: 20 })).toHaveLength(1);
  });

  it("limit 只截最新的那几条", () => {
    const { db, journal } = openIntrospectableJournal();
    for (let i = 0; i < 5; i++) {
      seedRun(db, journal, { runId: `run_${i}`, cwd: CWD, timeUpdated: 1_000 + i });
    }

    expect(journal.listRuns({ cwd: CWD, limit: 2 }).map((row) => row.runId)).toEqual([
      "run_4",
      "run_3",
    ]);
    // No padding when over the count; limit 0 is an empty page, not everything (the `limit -1`
    // SQLite idiom does not apply here).
    expect(journal.listRuns({ cwd: CWD, limit: 50 })).toHaveLength(5);
    expect(journal.listRuns({ cwd: CWD, limit: 0 })).toEqual([]);
  });

  it("statuses 过滤到给定子集", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_running", cwd: CWD, status: "running" });
    seedRun(db, journal, { runId: "run_pending", cwd: CWD, status: "pending" });
    seedRun(db, journal, { runId: "run_completed", cwd: CWD, status: "completed" });
    seedRun(db, journal, { runId: "run_errored", cwd: CWD, status: "errored" });

    expect(
      journal
        .listRuns({ cwd: CWD, limit: 20, statuses: ["running", "pending"] })
        .map((row) => row.runId)
        .sort(),
    ).toEqual(["run_pending", "run_running"]);
    expect(journal.listRuns({ cwd: CWD, limit: 20, statuses: ["stopped"] })).toEqual([]);
    // An empty set means "matches no status", not "no filter" — the latter would silently cancel
    // the filter.
    expect(journal.listRuns({ cwd: CWD, limit: 20, statuses: [] })).toEqual([]);
  });

  it("name 过滤下推到 SQL，且与 statuses 可叠加（GUI 中枢按工作流名归属运行历史）", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_a1", cwd: CWD, name: "release-check", timeUpdated: 3 });
    seedRun(db, journal, { runId: "run_a2", cwd: CWD, name: "release-check", timeUpdated: 1 });
    seedRun(db, journal, { runId: "run_b", cwd: CWD, name: "port-driver", timeUpdated: 2 });
    seedRun(db, journal, { runId: "run_nameless", cwd: CWD, timeUpdated: 9 });
    seedRun(db, journal, {
      runId: "run_a_failed",
      cwd: CWD,
      name: "release-check",
      status: "errored",
      timeUpdated: 5,
    });

    expect(
      journal.listRuns({ cwd: CWD, limit: 20, name: "release-check" }).map((row) => row.runId),
    ).toEqual(["run_a_failed", "run_a1", "run_a2"]);
    expect(
      journal
        .listRuns({ cwd: CWD, limit: 20, name: "release-check", statuses: ["errored"] })
        .map((row) => row.runId),
    ).toEqual(["run_a_failed"]);
    // The name is literal equality; a nonexistent name returns an empty page rather than falling
    // back to "no filter".
    expect(journal.listRuns({ cwd: CWD, limit: 20, name: "nope" })).toEqual([]);
    // Without name the behavior is unchanged (nameless rows are still included).
    expect(journal.listRuns({ cwd: CWD, limit: 20 })).toHaveLength(5);
  });

  it("cwd 缺省即跨所有项目枚举（全局工作流的运行历史跨 cwd），行带 cwd", () => {
    // A global workflow is launched from different projects; dwf_run.cwd records the project each
    // run actually ran in. The global variant of `workflows/runs` does not filter by cwd and pulls
    // the history of that name across all projects, with cwd on each row so the GUI can label the
    // project (docs/dynamic-workflow/launch.md "Data path").
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_a", cwd: "/repo/one", name: "deep-research", timeUpdated: 3 });
    seedRun(db, journal, { runId: "run_b", cwd: "/repo/two", name: "deep-research", timeUpdated: 2 });
    seedRun(db, journal, { runId: "run_c", cwd: "/repo/one", name: "other", timeUpdated: 5 });
    seedRun(db, journal, { runId: "run_cwdless", name: "deep-research", timeUpdated: 1 });

    const rows = journal.listRuns({ name: "deep-research", limit: 20 });
    // Across two cwds plus the row with no cwd, descending by time_updated; other names stay out.
    expect(rows.map((row) => row.runId)).toEqual(["run_a", "run_b", "run_cwdless"]);
    const byId = new Map(rows.map((row) => [row.runId, row]));
    expect(byId.get("run_a")?.cwd).toBe("/repo/one");
    expect(byId.get("run_b")?.cwd).toBe("/repo/two");
    // A row with NULL cwd carries no cwd key (the new column is not backfilled; absence is
    // distinguishable).
    expect(byId.get("run_cwdless") !== undefined && "cwd" in (byId.get("run_cwdless") ?? {})).toBe(false);

    // With a cwd given, still only this project's share (mutually exclusive with the global
    // variant; behavior verbatim unchanged).
    expect(journal.listRuns({ cwd: "/repo/one", limit: 20, name: "deep-research" }).map((r) => r.runId)).toEqual([
      "run_a",
    ]);
  });

  it("枚举行带 args（实参是小 JSON 袋，中枢的运行历史要展示它）；无实参的行键缺席", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, {
      runId: "run_args",
      cwd: CWD,
      name: "release-check",
      args: { target: "packages/ui", skipTests: false },
    });
    seedRun(db, journal, { runId: "run_bare", cwd: CWD, name: "release-check" });

    const byId = new Map(journal.listRuns({ cwd: CWD, limit: 20 }).map((row) => [row.runId, row]));
    expect(byId.get("run_args")?.args).toEqual({ target: "packages/ui", skipTests: false });
    expect(byId.get("run_bare")).not.toHaveProperty("args");
  });

  it("空结果回空数组", () => {
    const { journal } = openIntrospectableJournal();
    expect(journal.listRuns({ cwd: "/never/seen", limit: 20 })).toEqual([]);
  });

  it("每行带齐下游合成真相所需的字段，但不驮 result/failure", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, {
      runId: "run_1",
      cwd: CWD,
      name: "nightly triage",
      parentSessionId: "ses_owner",
      scriptText: "const planner = agent('planner');",
      status: "completed",
      result: { big: "artifact" },
      timeUpdated: 4_242,
    });

    const [row] = journal.listRuns({ cwd: CWD, limit: 20 });
    expect(row).toMatchObject({
      runId: "run_1",
      name: "nightly triage",
      // parentSessionId is the criterion for ownedByThisSession / possiblyInterrupted, and
      // scriptText is the raw material for the label fallback — missing either forces the
      // downstream to query again.
      parentSessionId: "ses_owner",
      cwd: CWD,
      scriptText: "const planner = agent('planner');",
      status: "completed",
      spentTokens: 0,
      caps: CAPS,
      timeUpdated: 4_242,
    });
    expect(typeof row?.timeCreated).toBe("number");
    // The list is deliberately light: artifacts can be huge, and decoding all 50 rows of a page
    // equals reading the whole database's artifacts into memory.
    expect(row !== undefined && "result" in row).toBe(false);
    expect(row !== undefined && "failure" in row).toBe(false);
  });

  it("name 缺席的行不带 name 键", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: CWD, scriptText: "log('hi');" });

    const [row] = journal.listRuns({ cwd: CWD, limit: 20 });
    expect(row !== undefined && "name" in row).toBe(false);
  });
});

describe("SQLite dwf journal store — getRunRow", () => {
  it("回完整记录 + journal 时间戳", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, {
      runId: "run_1",
      cwd: "/repo",
      name: "named run",
      status: "completed",
      result: { report: "done" },
      timeUpdated: 5_000,
    });

    const row = journal.getRunRow("run_1");
    // Timestamps read straight from the journal: RunRecord itself carries no times, while the
    // detail page must report createdAt / updatedAt.
    expect(row).toMatchObject({
      runId: "run_1",
      name: "named run",
      status: "completed",
      result: { report: "done" },
      timeUpdated: 5_000,
    });
    expect(typeof row?.timeCreated).toBe("number");
  });

  it("未知 runId 回 undefined", () => {
    const { journal } = openIntrospectableJournal();
    expect(journal.getRunRow("nope")).toBeUndefined();
  });
});

describe("SQLite dwf journal store — countNodesByStatus", () => {
  /** Seeds a node (only status and owning run matter). */
  function seedNode(
    journal: JournalStorePort,
    runId: string,
    siteId: string,
    ordinal: number,
    status: NodeRecord["status"],
  ): void {
    journal.putNode({ runId, siteId, ordinal, kind: "ask", inputHash: "h", status });
  }

  it("按三态计数，且只数本 run 的节点", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedRun(db, journal, { runId: "run_2", cwd: "/repo" });
    seedNode(journal, "run_1", "ask#1", 1, "completed");
    seedNode(journal, "run_1", "ask#1", 2, "completed");
    seedNode(journal, "run_1", "ask#2", 1, "running");
    seedNode(journal, "run_1", "ask#3", 1, "failed");
    seedNode(journal, "run_2", "ask#1", 1, "completed");

    expect(journal.countNodesByStatus("run_1")).toEqual({ running: 1, completed: 2, failed: 1 });
  });

  it("无节点（含未知 run）回三个 0，而不是缺键", () => {
    // Downstream computes nodesObserved from it directly; missing keys would turn both "no nodes
    // yet" and "no such run" into NaN.
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });

    expect(journal.countNodesByStatus("run_1")).toEqual({ running: 0, completed: 0, failed: 0 });
    expect(journal.countNodesByStatus("nope")).toEqual({ running: 0, completed: 0, failed: 0 });
  });
});

describe("SQLite dwf journal store — listRecentLogEvents", () => {
  it("只取 log 事件的末 N 条，按时序回", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    journal.appendEvent("run_1", { type: "run-started", runId: "run_1", caps: CAPS });
    for (const message of ["l0", "l1", "l2", "l3"]) {
      journal.appendEvent("run_1", { type: "log", message });
      journal.appendEvent("run_1", {
        type: "usage-updated",
        spentTokens: 10,
      });
    }

    const tail = journal.listRecentLogEvents("run_1", 3);
    // The last N are taken by sequence desc, then reversed back into chronological order: reading
    // everything into memory and filtering is the opposite of why this query exists.
    expect(
      tail.map((e) => (e.event.type === "log" ? e.event.message : `<${e.event.type}>`)),
    ).toEqual(["l1", "l2", "l3"]);
    // The sequence numbers are the journal's real ones (other events are interleaved between
    // logs, hence the gaps), not re-numbered indexes — downstream uses them to locate "where the
    // narrative has reached".
    expect(tail.map((e) => e.sequence)).toEqual([3, 5, 7]);
  });

  it("limit 超过条数时给出全部 log 事件", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    journal.appendEvent("run_1", { type: "log", message: "only" });
    journal.appendEvent("run_1", { type: "run-settled", status: "completed" });

    expect(journal.listRecentLogEvents("run_1", 20).map((e) => e.event.type)).toEqual(["log"]);
  });

  it("没有 log 事件（含未知 run、limit 0）回空数组", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    journal.appendEvent("run_1", { type: "run-started", runId: "run_1", caps: CAPS });

    expect(journal.listRecentLogEvents("run_1", 20)).toEqual([]);
    expect(journal.listRecentLogEvents("nope", 20)).toEqual([]);
    expect(journal.listRecentLogEvents("run_1", 0)).toEqual([]);
  });

  it("按 runId 隔离", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedRun(db, journal, { runId: "run_2", cwd: "/repo" });
    journal.appendEvent("run_1", { type: "log", message: "mine" });
    journal.appendEvent("run_2", { type: "log", message: "theirs" });

    expect(
      journal
        .listRecentLogEvents("run_1", 20)
        .map((e) => (e.event.type === "log" ? e.event.message : "")),
    ).toEqual(["mine"]);
  });
});

describe("SQLite dwf journal store — listRunsByParentSession", () => {
  const PARENT = "ses_enum_parent";

  interface DwfRunEnumerationQuery {
    listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[];
  }

  /** Capability probing same as the host side (supportsRunEnumeration): a drifted method name must go red here first. */
  function openEnumerableJournal(): JournalStorePort & DwfRunEnumerationQuery {
    const { journal } = openJournalDb();
    if (
      typeof (journal as Partial<DwfRunEnumerationQuery>).listRunsByParentSession !== "function"
    ) {
      throw new Error(
        "sqlite dwf journal 缺少 listRunsByParentSession：UI 的重启后发现面会静默为空",
      );
    }
    return journal as JournalStorePort & DwfRunEnumerationQuery;
  }

  function seed(
    journal: JournalStorePort,
    input: {
      runId: string;
      status: RunRecord["status"];
      parentSessionId?: string;
      toolCallId?: string;
    },
  ): void {
    journal.createRun({
      runId: input.runId,
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      caps: CAPS,
      spentTokens: 0,
      status: input.status,
    });
  }

  it("只回本父会话的行，完整解码（含 toolCallId 与 failure）", () => {
    const journal = openEnumerableJournal();
    seed(journal, {
      parentSessionId: PARENT,
      runId: "run_a",
      status: "stopped",
      toolCallId: "call-a",
    });
    seed(journal, { parentSessionId: PARENT, runId: "run_b", status: "completed" });
    seed(journal, { parentSessionId: "ses_other", runId: "run_sibling", status: "running" });
    seed(journal, { runId: "run_parentless", status: "running" });
    journal.updateRunStatus("run_b", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owning process exited" },
    });

    const rows = journal.listRunsByParentSession(PARENT, 10);

    expect(rows.map((row) => row.runId).sort()).toEqual(["run_a", "run_b"]);
    expect(rows.find((row) => row.runId === "run_a")?.toolCallId).toBe("call-a");
    // The logical vocabulary comes back as-is: stopped + reason + structured failure (the physical
    // layer is cancelled + envelope).
    expect(rows.find((row) => row.runId === "run_a")).toMatchObject({
      status: "stopped",
      stopReason: "user",
    });
    expect(rows.find((row) => row.runId === "run_b")).toMatchObject({
      status: "stopped",
      stopReason: "interrupted",
      failure: { code: "Interrupted" },
    });
  });

  it("最近更新在前，limit 截断在最旧一侧", async () => {
    const journal = openEnumerableJournal();
    seed(journal, { parentSessionId: PARENT, runId: "run_old", status: "completed" });
    seed(journal, { parentSessionId: PARENT, runId: "run_mid", status: "completed" });
    seed(journal, { parentSessionId: PARENT, runId: "run_new", status: "running" });
    // Make time_updated genuinely diverge (createRun within the same millisecond ties): touch the
    // oldest row so it becomes the newest.
    await new Promise((resolve) => setTimeout(resolve, 5));
    journal.updateRunUsage("run_old", 42);

    const rows = journal.listRunsByParentSession(PARENT, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.runId).toBe("run_old"); // just touched → most recently updated
  });

  it("未知父会话返回空数组；limit 0 返回空", () => {
    const journal = openEnumerableJournal();
    seed(journal, { parentSessionId: PARENT, runId: "run_a", status: "running" });
    expect(journal.listRunsByParentSession("ses_never_seen", 10)).toEqual([]);
    expect(journal.listRunsByParentSession(PARENT, 0)).toEqual([]);
  });

  // Narrow projection: the enumeration face reports updatedAt, so rows must carry the journal
  // timestamps (`RunRecord` itself carries none).
  it("行带 journal 时间戳（createdAt/updatedAt 的来源）", () => {
    const journal = openEnumerableJournal();
    seed(journal, { parentSessionId: PARENT, runId: "run_timed", status: "running" });

    const [row] = journal.listRunsByParentSession(PARENT, 10);

    expect(typeof row?.timeCreated).toBe("number");
    expect(typeof row?.timeUpdated).toBe("number");
    expect(row?.timeUpdated).toBeGreaterThanOrEqual(row?.timeCreated ?? 0);
    // Metadata columns complete (label derivation needs name/scriptText, ownership needs
    // parentSessionId).
    expect(row).toMatchObject({ parentSessionId: PARENT, runId: "run_timed", status: "running" });
  });

  /**
   * `result_json` **does not enter this query's SQL**.
   *
   * The assertion must hit the SQL, not the decoded result: `decodeRunListItem` never reads
   * result_json anyway, so after changing the select back to `select *` the behavior is
   * **completely unchanged** (the row still has no `result` key) — only the memory cost quietly
   * comes back, a page of runs reading every artifact into memory. A behavioral assertion is a
   * false sentinel here; verified in practice.
   *
   * Conversely `failure_json` must be in the SQL: the resumable predicate depends on
   * failure.code (see the next case).
   */
  it("枚举查询的 SQL 取 failure_json 而不取 result_json", () => {
    const db = new DatabaseSync(":memory:");
    openDatabases.push(db);
    runSqliteSessionMigrationsSync(db, ":memory:");
    const prepared: string[] = [];
    // A bypass recorder for prepare: only to see the real column list this query sends.
    const recordingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (sql: string) => {
            prepared.push(sql);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseSync;
    const journal = createDwfJournalStore(recordingDb) as JournalStorePort & DwfRunEnumerationQuery;
    seed(journal, { parentSessionId: PARENT, runId: "run_a", status: "running" });

    // Look only at the SQL the enumeration query itself sends (the row-creation/migration
    // statements naturally mention result_json).
    prepared.length = 0;
    journal.listRunsByParentSession(PARENT, 10);
    const sql = prepared.join("\n");

    expect(sql).toContain("failure_json");
    expect(sql).not.toContain("result_json");
    expect(sql).not.toMatch(/select\s+\*/i);
  });

  /** failure must survive the narrow projection: Interrupted is the resumable shape the resume gate accepts. */
  it("窄投影仍解出 failure（resumable 谓词的输入）", () => {
    const journal = openEnumerableJournal();
    seed(journal, { parentSessionId: PARENT, runId: "run_dead", status: "running" });
    journal.updateRunStatus("run_dead", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owning process exited" },
    });

    const [row] = journal.listRunsByParentSession(PARENT, 10);

    expect(row?.failure).toEqual({ code: "Interrupted", message: "owning process exited" });
    expect(row?.stopReason).toBe("interrupted");
  });
});

/**
 * The two host queries for user-facing artifacts (docs/dynamic-workflow/authoring.md "Journal rows
 * and events").
 * ⚠ The artifact here is the deliverable the script published to the user, not
 * `RunSettlement.artifact` (the top-level return value).
 *
 * Both are deliberately **not** on `JournalStorePort` (same argument as `listRuns`: what the
 * engine does not do should not enter the domain port), so their semantics can only be pinned
 * here, against the real database — the in-memory implementation does not provide them at all.
 */
describe("SQLite dwf journal store — listArtifactRows", () => {
  /** Seeds an artifact row (published or declared). */
  function seedArtifact(
    journal: JournalStorePort,
    runId: string,
    siteId: string,
    ordinal: number,
    artifactId: string,
    record: Record<string, unknown> | undefined,
  ): void {
    journal.putNode({
      runId,
      siteId,
      ordinal,
      kind: "artifact",
      inputHash: `${siteId}@${ordinal}`,
      status: record === undefined ? "failed" : "completed",
      ...(record === undefined
        ? { error: { code: "ArtifactSourceMissing" as const, message: "缺文件" } }
        : { result: record }),
      artifactId,
    });
  }

  it("只回本 run 的产物行，按落库先后", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedRun(db, journal, { runId: "run_2", cwd: "/repo" });

    // Interleaved publishing: rows with the same id are **not** naturally adjacent, so the only
    // possible ordering is insertion order (which is also the version order).
    seedArtifact(journal, "run_1", "artifact#1", 1, "perf", {
      id: "perf",
      kind: "chart",
      version: 1,
    });
    seedArtifact(journal, "run_1", "artifact#2", 1, "book", {
      id: "book",
      kind: "file",
      version: 1,
      bytes: 10,
    });
    seedArtifact(journal, "run_1", "artifact#2", 2, "book", {
      id: "book",
      kind: "file",
      version: 2,
      bytes: 20,
    });
    // Tagged reports and ordinary nodes are not artifact rows — mixed in, the read face would
    // treat every data point as a deliverable.
    journal.putNode({
      runId: "run_1",
      siteId: "report#1",
      ordinal: 1,
      kind: "report",
      inputHash: "r",
      status: "completed",
      result: { round: 1 },
      artifactId: "perf",
    });
    journal.putNode({
      runId: "run_1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "k",
      status: "completed",
    });
    // Another run's artifacts: queried too broadly, someone else's deliverables would land in
    // this run's card area.
    seedArtifact(journal, "run_2", "artifact#1", 1, "other", {
      id: "other",
      kind: "markdown",
      version: 1,
    });

    const rows = journal.listArtifactRows("run_1");
    expect(rows.map((row) => [row.siteId, row.ordinal, row.artifactId])).toEqual([
      ["artifact#1", 1, "perf"],
      ["artifact#2", 1, "book"],
      ["artifact#2", 2, "book"],
    ]);
    expect(rows[2]?.result).toEqual({ id: "book", kind: "file", version: 2, bytes: 20 });
  });

  it("失败的发布照样在结果里（带 error、无 result）", () => {
    // Filtering out failed rows would make a user-visible failure nonexistent on every surface.
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedArtifact(journal, "run_1", "artifact#1", 1, "book", undefined);

    const [row] = journal.listArtifactRows("run_1");
    expect(row?.status).toBe("failed");
    expect(row?.artifactId).toBe("book");
    expect(row?.error).toEqual({ code: "ArtifactSourceMissing", message: "缺文件" });
    expect(row !== undefined && "result" in row).toBe(false);
  });

  it("无产物（含未知 run）回空数组", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    expect(journal.listArtifactRows("run_1")).toEqual([]);
    expect(journal.listArtifactRows("nope")).toEqual([]);
  });
});

describe("SQLite dwf journal store — countTaggedReports", () => {
  it("counts tagged report rows per artifact id in SQL, ignoring untagged rows, other kinds and other runs", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedRun(db, journal, { runId: "run_2", cwd: "/repo" });
    const put = (
      runId: string,
      siteId: string,
      ordinal: number,
      extra: Partial<NodeRecord>,
    ): void =>
      journal.putNode({
        runId,
        siteId,
        ordinal,
        kind: "report",
        inputHash: `${siteId}@${ordinal}`,
        status: "completed",
        result: { big: "x".repeat(1024) },
        ...extra,
      });
    put("run_1", "report#1", 1, { artifactId: "perf" });
    put("run_1", "report#1", 2, { artifactId: "perf" });
    put("run_1", "report#2", 1, { artifactId: "queue" });
    put("run_1", "report#3", 1, {}); // untagged
    put("run_1", "artifact#1", 1, { kind: "artifact", artifactId: "perf" }); // artifact rows do not count
    put("run_2", "report#1", 1, { artifactId: "perf" }); // another run

    expect(journal.countTaggedReports("run_1")).toEqual(
      new Map([
        ["perf", 2],
        ["queue", 1],
      ]),
    );
    expect(journal.countTaggedReports("nope")).toEqual(new Map());
  });
});

describe("SQLite dwf journal store — listArtifactItems", () => {
  /** A byte bound large enough that cases testing only counts / cursors / filtering can keep it out of the picture. */
  const ANY_BYTES = 1 << 30;

  /** Appends a tagged report event and returns its assigned sequence. */
  function seedTaggedReport(
    journal: JournalStorePort,
    runId: string,
    siteId: string,
    ordinal: number,
    item: unknown,
    artifactId?: string,
  ): number {
    return journal.appendEvent(runId, {
      type: "report",
      instance: { siteId, ordinal },
      item,
      ...(artifactId === undefined ? {} : { artifactId }),
    }).sequence;
  }

  it("按 sequence 升序回该 id 的条目，带站点坐标与原值", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    const s0 = seedTaggedReport(journal, "run_1", "report#1", 1, { round: 1 }, "perf");
    const s1 = seedTaggedReport(journal, "run_1", "report#1", 2, { round: 2 }, "perf");

    expect(journal.listArtifactItems("run_1", "perf", { limit: 10, maxBytes: ANY_BYTES })).toEqual({
      items: [
        { sequence: s0, siteId: "report#1", ordinal: 1, item: { round: 1 } },
        { sequence: s1, siteId: "report#1", ordinal: 2, item: { round: 2 } },
      ],
      hasMore: false,
    });
  });

  it("排除未打标签的 report、别的 id、别种事件与别的 run", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedRun(db, journal, { runId: "run_2", cwd: "/repo" });
    seedTaggedReport(journal, "run_1", "report#1", 1, { mine: true }, "perf");
    // Untagged: the payload has no artifactId key at all, and SQL's `= ?` does not match NULL.
    seedTaggedReport(journal, "run_1", "report#2", 1, { untagged: true });
    seedTaggedReport(journal, "run_1", "report#3", 1, { other: true }, "queue");
    // Other event kinds: `artifact-published`'s id hides inside the nested `artifact.id`, not a
    // top-level artifactId; but the type filter is the gatekeeper of this invariant (tomorrow some
    // other event might carry a top-level artifactId).
    journal.appendEvent("run_1", {
      type: "artifact-published",
      instance: { siteId: "artifact#1", ordinal: 1 },
      artifact: { id: "perf", kind: "chart", version: 1 },
    });
    journal.appendEvent("run_1", { type: "log", message: "perf" });
    seedTaggedReport(journal, "run_2", "report#1", 1, { crossRun: true }, "perf");

    const page = journal.listArtifactItems("run_1", "perf", { limit: 10, maxBytes: ANY_BYTES });
    expect(page.items.map((entry) => entry.item)).toEqual([{ mine: true }]);
    expect(page.hasMore).toBe(false);
  });

  it("afterSequence 是严格大于的游标", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    const s0 = seedTaggedReport(journal, "run_1", "report#1", 1, 1, "perf");
    // Another event interleaved in between: the cursor is the journal's global sequence, not "the
    // Nth artifact item".
    journal.appendEvent("run_1", { type: "log", message: "between" });
    const s1 = seedTaggedReport(journal, "run_1", "report#1", 2, 2, "perf");

    const after = (afterSequence: number) =>
      journal.listArtifactItems("run_1", "perf", { afterSequence, limit: 10, maxBytes: ANY_BYTES });
    expect(after(s0).items.map((entry) => entry.sequence)).toEqual([s1]);
    expect(after(s1)).toEqual({ items: [], hasMore: false });
  });

  it("limit 逐字兑现，hasMore 由存储层判定：页之后还有没有条目", () => {
    // The storage layer adds no ceiling of its own and does not ask the caller to over-fetch one
    // row to guess: whether the row after the page end exists is exactly hasMore.
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    for (let round = 0; round < 5; round += 1) {
      seedTaggedReport(journal, "run_1", "report#1", round + 1, round, "perf");
    }
    const page = (limit: number) =>
      journal.listArtifactItems("run_1", "perf", { limit, maxBytes: ANY_BYTES });

    expect(page(2)).toMatchObject({ hasMore: true });
    expect(page(2).items.map((entry) => entry.item)).toEqual([0, 1]);
    expect(page(4).hasMore).toBe(true);
    // Exactly exhausted: no hasMore (so the board does not flip to an empty page for nothing).
    expect(page(5)).toMatchObject({ hasMore: false });
    expect(page(5).items).toHaveLength(5);
    expect(page(99).items).toHaveLength(5);
  });

  it("字节界：再加一条就超界时收尾并报 hasMore，第一条总是带上", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    const pad = "x".repeat(1000);
    for (let round = 0; round < 4; round += 1) {
      seedTaggedReport(journal, "run_1", "report#1", round + 1, { round, pad }, "perf");
    }
    // Each payload is about 1.1 KB: a 2.5 KB bound fits two items but not the third.
    const first = journal.listArtifactItems("run_1", "perf", { limit: 10, maxBytes: 2500 });
    expect(first.items.map((entry) => (entry.item as { round: number }).round)).toEqual([0, 1]);
    expect(first.hasMore).toBe(true);
    // Continuation picks up from the page end, no gaps and no repeats.
    const rest = journal.listArtifactItems("run_1", "perf", {
      afterSequence: first.items.at(-1)!.sequence,
      limit: 10,
      maxBytes: 2500,
    });
    expect(rest.items.map((entry) => (entry.item as { round: number }).round)).toEqual([2, 3]);
    expect(rest.hasMore).toBe(false);
    // One item alone exceeds the bound: it forms its own page (otherwise paging would be stuck on
    // it forever), and what follows still reports hasMore.
    const tiny = journal.listArtifactItems("run_1", "perf", { limit: 10, maxBytes: 10 });
    expect(tiny.items).toHaveLength(1);
    expect(tiny.hasMore).toBe(true);
  });

  it("limit ≤ 0 是空页，未知 run / 未知 id 同样", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedTaggedReport(journal, "run_1", "report#1", 1, { round: 1 }, "perf");
    const empty = { items: [], hasMore: false };

    expect(journal.listArtifactItems("run_1", "perf", { limit: 0, maxBytes: ANY_BYTES })).toEqual(
      empty,
    );
    expect(journal.listArtifactItems("run_1", "perf", { limit: -1, maxBytes: ANY_BYTES })).toEqual(
      empty,
    );
    expect(journal.listArtifactItems("run_1", "nope", { limit: 10, maxBytes: ANY_BYTES })).toEqual(
      empty,
    );
    expect(journal.listArtifactItems("nope", "perf", { limit: 10, maxBytes: ANY_BYTES })).toEqual(
      empty,
    );
  });

  it("条目原值原样回来：null、标量与数组都不被加工", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seedTaggedReport(journal, "run_1", "report#1", 1, null, "perf");
    seedTaggedReport(journal, "run_1", "report#1", 2, "文本", "perf");
    seedTaggedReport(journal, "run_1", "report#1", 3, [1, { two: true }], "perf");

    const page = journal.listArtifactItems("run_1", "perf", { limit: 10, maxBytes: ANY_BYTES });
    expect(page.items.map((e) => e.item)).toEqual([null, "文本", [1, { two: true }]]);
  });
});

describe("SQLite dwf journal store — listArtifactItems with fields", () => {
  const FIELD_VALUE_BYTES = 4096;

  function seed(journal: JournalStorePort, runId: string, items: unknown[]): void {
    items.forEach((item, index) =>
      journal.appendEvent(runId, {
        type: "report",
        instance: { siteId: "report#1", ordinal: index + 1 },
        item,
        artifactId: "perf",
      }),
    );
  }

  function readFields(
    journal: JournalStorePort & DwfRunIntrospectionQueries,
    paths: string[],
    page: { limit?: number; maxBytes?: number; afterSequence?: number } = {},
  ) {
    return journal.listArtifactItems("run_1", "perf", {
      limit: page.limit ?? 10,
      maxBytes: page.maxBytes ?? 1 << 30,
      ...(page.afterSequence === undefined ? {} : { afterSequence: page.afterSequence }),
      fields: { paths, maxValueBytes: FIELD_VALUE_BYTES },
    });
  }

  it("回点名的字段、不回整条 item；JSON 的 null 在表里，走不通的路径不在", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seed(journal, "run_1", [
      { round: 1, ok: true, timing: { ms: 12.5 }, note: null, big: "x".repeat(99) },
    ]);

    const page = readFields(journal, [
      "round",
      "ok",
      "timing.ms",
      "note",
      "missing",
      "round.deeper",
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.items).toEqual([
      {
        sequence: expect.any(Number),
        siteId: "report#1",
        ordinal: 1,
        fields: { round: 1, ok: true, "timing.ms": 12.5, note: null },
      },
    ]);
    expect(page.items[0]).not.toHaveProperty("item");
  });

  it("像整数的段在数组上是下标、在对象上是键，与渲染器的路径规则相同", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seed(journal, "run_1", [
      {
        rows: [{ v: 1 }, { v: 2 }],
        byKey: { "0": "zero", "01": "zero-one" },
        empty: { "": { b: 7 } },
      },
    ]);

    const [entry] = readFields(journal, [
      "rows.1.v",
      "rows.01.v", // Number("01") = 1: still index 1 on an array
      "rows.5.v", // out of bounds
      "rows.x", // non-integer segment on an array
      "byKey.0",
      "byKey.01",
      "empty..b", // an empty segment is an empty key
    ]).items;
    expect(entry?.fields).toEqual({
      "rows.1.v": 2,
      "rows.01.v": 2,
      "byKey.0": "zero",
      "byKey.01": "zero-one",
      "empty..b": 7,
    });
  });

  it("键里带引号与反斜杠照样取得到", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seed(journal, "run_1", [{ 'say"hi': 1, "back\\slash": 2, 中文: 3 }]);

    const [entry] = readFields(journal, ['say"hi', "back\\slash", "中文"]).items;
    expect(entry?.fields).toEqual({ 'say"hi': 1, "back\\slash": 2, 中文: 3 });
  });

  it("超过值的字节上界的值回成截短的字符串，一个大值不会整段进 JavaScript", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seed(journal, "run_1", [
      { text: "y".repeat(10_000), list: Array.from({ length: 2000 }, (_v, i) => i) },
    ]);

    const [entry] = readFields(journal, ["text", "list"]).items;
    expect(entry?.fields?.text).toBe(`${"y".repeat(1000)}…`);
    const list = entry?.fields?.list as string;
    expect(typeof list).toBe("string");
    expect(list.startsWith("[0,1,2,3")).toBe(true);
    expect(list).toHaveLength(1001);
  });

  it("页按取出的字段值计字节：大 item 里只取一个小字段时一页装得下很多条", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    seed(
      journal,
      "run_1",
      Array.from({ length: 5 }, (_v, round) => ({ round, pad: "z".repeat(50_000) })),
    );

    // A whole item is 50 KB each, but only round is fetched: 5 items fit far inside 1 KB.
    const small = readFields(journal, ["round"], { maxBytes: 1000 });
    expect(small.items.map((entry) => entry.fields?.round)).toEqual([0, 1, 2, 3, 4]);
    expect(small.hasMore).toBe(false);
    // Fetching pad (truncated to about 1 KB each), the same 2.5 KB fits only two items and reports
    // hasMore.
    const padded = readFields(journal, ["pad"], { maxBytes: 2500 });
    expect(padded.items).toHaveLength(2);
    expect(padded.hasMore).toBe(true);
    // The count bound and cursor work as usual.
    const limited = readFields(journal, ["round"], { limit: 2 });
    expect(limited.items.map((entry) => entry.fields?.round)).toEqual([0, 1]);
    expect(limited.hasMore).toBe(true);
    const rest = readFields(journal, ["round"], { afterSequence: limited.items[1]!.sequence });
    expect(rest.items.map((entry) => entry.fields?.round)).toEqual([2, 3, 4]);
  });
});

describe("SQLite dwf journal store — listEventPage", () => {
  it("全部类型、item 原样，按条数分页并判定 hasMore", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    journal.appendEvent("run_1", { type: "log", message: "a" });
    journal.appendEvent("run_1", {
      type: "report",
      instance: { siteId: "report#1", ordinal: 1 },
      item: { finding: 1 },
    });
    journal.appendEvent("run_1", { type: "log", message: "b" });
    const all = journal.listEvents("run_1", { types: "all", reportItems: "all" });

    const first = journal.listEventPage("run_1", { limit: 2, maxBytes: 1 << 30 });
    expect(first.events).toEqual(all.slice(0, 2));
    expect(first.hasMore).toBe(true);
    const rest = journal.listEventPage("run_1", {
      afterSequence: first.events.at(-1)!.sequence,
      limit: 2,
      maxBytes: 1 << 30,
    });
    expect(rest).toEqual({ events: all.slice(2), hasMore: false });
  });

  it("字节界同看板条目：带大 item 的事件让页提前收尾，但每页至少一条", () => {
    const { db, journal } = openIntrospectableJournal();
    seedRun(db, journal, { runId: "run_1", cwd: "/repo" });
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      journal.appendEvent("run_1", {
        type: "report",
        instance: { siteId: "report#1", ordinal },
        item: "y".repeat(4096),
      });
    }
    const seen: number[] = [];
    let cursor: number | undefined;
    for (;;) {
      const page = journal.listEventPage("run_1", {
        ...(cursor === undefined ? {} : { afterSequence: cursor }),
        limit: 500,
        maxBytes: 5000,
      });
      expect(page.events).toHaveLength(1);
      seen.push(...page.events.map((stored) => stored.sequence));
      cursor = page.events.at(-1)!.sequence;
      if (!page.hasMore) break;
    }
    expect(seen).toHaveLength(3);
  });
});

// ————————————————————————————————————————————————————————————————
// Zero-migration terminal-state encoding
// (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "The journal"): the physical
// column still holds the old five values; the logical `errored` / `stopped{reason}` live only in
// the codec. The table below is the very table the spec's user reviewed.
// ————————————————————————————————————————————————————————————————
describe("SqliteDwfJournalStore 终态编码（零迁移）", () => {
  const PARENT = "ses_terminal";

  function insertPhysicalRow(
    db: DatabaseSync,
    runId: string,
    status: string,
    failureJson: string | null,
    timeUpdated = 1,
  ): void {
    db.prepare(
      `insert into dwf_run (id, parent_session_id, cwd, caps_max_concurrency, spent_tokens, status,
         failure_json, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, PARENT, "/repo", 4, 0, status, failureJson, 1, timeUpdated);
  }

  it("历史行按表解码：cancelled→stopped(user)，failed+Interrupted→stopped(interrupted)，其余 failed→errored", () => {
    const { db, journal } = openIntrospectableJournal();
    insertPhysicalRow(db, "old_pending", "pending", null);
    insertPhysicalRow(db, "old_running", "running", null);
    insertPhysicalRow(db, "old_completed", "completed", null);
    insertPhysicalRow(db, "old_cancelled", "cancelled", null);
    insertPhysicalRow(
      db,
      "old_interrupted",
      "failed",
      JSON.stringify({ code: "Interrupted", message: "owning process exited" }),
    );
    insertPhysicalRow(
      db,
      "old_provider_crash",
      "failed",
      JSON.stringify({
        code: "DriverError",
        message: "Subagent turn failed",
        modelFailureReason: "rate_limited",
      }),
    );
    insertPhysicalRow(
      db,
      "old_script_error",
      "failed",
      JSON.stringify({ code: "DriverError", message: "boom" }),
    );
    insertPhysicalRow(
      db,
      "old_cap",
      "failed",
      JSON.stringify({ code: "ReportCapExceeded", message: "over" }),
    );
    insertPhysicalRow(db, "old_failed_bare", "failed", null);

    const statusOf = (runId: string) => {
      const record = journal.getRun(runId)!;
      return { status: record.status, stopReason: record.stopReason, code: record.failure?.code };
    };
    expect(statusOf("old_pending")).toEqual({
      status: "pending",
      stopReason: undefined,
      code: undefined,
    });
    expect(statusOf("old_running")).toEqual({
      status: "running",
      stopReason: undefined,
      code: undefined,
    });
    expect(statusOf("old_completed")).toEqual({
      status: "completed",
      stopReason: undefined,
      code: undefined,
    });
    expect(statusOf("old_cancelled")).toEqual({
      status: "stopped",
      stopReason: "user",
      code: undefined,
    });
    expect(statusOf("old_interrupted")).toEqual({
      status: "stopped",
      stopReason: "interrupted",
      code: "Interrupted",
    });
    // Row 6 (the user-reviewed ruling): an old provider crash is still errored, not resumable.
    expect(statusOf("old_provider_crash")).toEqual({
      status: "errored",
      stopReason: undefined,
      code: "DriverError",
    });
    expect(statusOf("old_script_error")).toEqual({
      status: "errored",
      stopReason: undefined,
      code: "DriverError",
    });
    expect(statusOf("old_cap")).toEqual({
      status: "errored",
      stopReason: undefined,
      code: "ReportCapExceeded",
    });
    expect(statusOf("old_failed_bare")).toEqual({
      status: "errored",
      stopReason: undefined,
      code: undefined,
    });
    // Absent keys are genuinely absent (the contract suite's toEqual style).
    expect("stopReason" in journal.getRun("old_completed")!).toBe(false);
    expect("failure" in journal.getRun("old_cancelled")!).toBe(false);
  });

  it("新写入的 stopped 落成 cancelled + 信封，errored 落成 failed + 原样失败；往返逐字段相等", () => {
    const { db, journal } = openIntrospectableJournal();
    for (const runId of ["s_user", "s_model", "s_provider", "s_interrupted", "e_script"]) {
      journal.createRun({
        runId,
        parentSessionId: PARENT,
        cwd: "/repo",
        caps: CAPS,
        spentTokens: 0,
        status: "running",
      });
    }
    journal.updateRunStatus("s_user", "stopped", { stopReason: "user" });
    journal.updateRunStatus("s_model", "stopped", { stopReason: "model" });
    const providerStop = {
      code: "ProviderStop" as const,
      message: "Sign-in to BigModel expired.",
      providerStop: {
        kind: "auth" as const,
        reason: "auth_failed",
        providerCode: "1006",
        subagent: "verify@2",
      },
    };
    journal.updateRunStatus("s_provider", "stopped", {
      stopReason: "provider",
      failure: providerStop,
    });
    journal.updateRunStatus("s_interrupted", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owning process exited" },
    });
    journal.updateRunStatus("e_script", "errored", {
      failure: { code: "DriverError", message: "boom" },
    });

    const physical = db
      .prepare(
        "select id, status, failure_json from dwf_run where parent_session_id = ? order by id",
      )
      .all(PARENT) as { id: string; status: string; failure_json: string | null }[];
    expect(physical.map((row) => [row.id, row.status])).toEqual([
      ["e_script", "failed"],
      ["s_interrupted", "cancelled"],
      ["s_model", "cancelled"],
      ["s_provider", "cancelled"],
      ["s_user", "cancelled"],
    ]);
    expect(JSON.parse(physical.find((row) => row.id === "s_user")!.failure_json!)).toEqual({
      stopReason: "user",
    });
    expect(JSON.parse(physical.find((row) => row.id === "s_provider")!.failure_json!)).toEqual({
      stopReason: "provider",
      error: providerStop,
    });
    expect(JSON.parse(physical.find((row) => row.id === "e_script")!.failure_json!)).toEqual({
      code: "DriverError",
      message: "boom",
    });

    expect(journal.getRun("s_user")).toMatchObject({ status: "stopped", stopReason: "user" });
    expect("failure" in journal.getRun("s_user")!).toBe(false);
    expect(journal.getRun("s_model")).toMatchObject({ status: "stopped", stopReason: "model" });
    expect(journal.getRun("s_provider")).toMatchObject({
      status: "stopped",
      stopReason: "provider",
      failure: providerStop,
    });
    expect(journal.getRun("s_interrupted")).toMatchObject({
      status: "stopped",
      stopReason: "interrupted",
    });
    expect(journal.getRun("e_script")).toMatchObject({
      status: "errored",
      failure: { code: "DriverError" },
    });
    expect("stopReason" in journal.getRun("e_script")!).toBe(false);
    // The physical terminal-state set is unchanged: the non-terminal query returns none of them.
    expect(journal.listNonTerminalRuns(PARENT)).toEqual([]);
    // resume flips back to running and clears the envelope (same semantics as the contract suite).
    journal.updateRunStatus("s_provider", "running");
    expect(journal.getRun("s_provider")).toMatchObject({ status: "running" });
    expect("stopReason" in journal.getRun("s_provider")!).toBe(false);
  });

  it("statuses 过滤在 SQL 里分清 errored 与 stopped（共享物理 failed）", () => {
    const { db, journal } = openIntrospectableJournal();
    insertPhysicalRow(db, "p_cancelled", "cancelled", null, 5);
    insertPhysicalRow(
      db,
      "p_interrupted",
      "failed",
      JSON.stringify({ code: "Interrupted", message: "x" }),
      4,
    );
    insertPhysicalRow(
      db,
      "p_errored",
      "failed",
      JSON.stringify({ code: "DriverError", message: "x" }),
      3,
    );
    insertPhysicalRow(db, "p_errored_bare", "failed", null, 2);
    insertPhysicalRow(db, "p_completed", "completed", null, 1);
    journal.createRun({
      runId: "n_stopped",
      parentSessionId: PARENT,
      cwd: "/repo",
      caps: CAPS,
      spentTokens: 0,
      status: "running",
    });
    journal.updateRunStatus("n_stopped", "stopped", { stopReason: "provider" });

    const ids = (statuses: RunRecord["status"][]) =>
      journal
        .listRuns({ cwd: "/repo", limit: 20, statuses })
        .map((row) => row.runId)
        .sort();
    expect(ids(["stopped"])).toEqual(["n_stopped", "p_cancelled", "p_interrupted"]);
    expect(ids(["errored"])).toEqual(["p_errored", "p_errored_bare"]);
    expect(ids(["completed", "errored"])).toEqual(["p_completed", "p_errored", "p_errored_bare"]);
    // limit applies after filtering: with only two errored rows, limit 1 returns the most
    // recently updated one, not crowded out by stopped rows.
    expect(
      journal.listRuns({ cwd: "/repo", limit: 1, statuses: ["errored"] }).map((row) => row.runId),
    ).toEqual(["p_errored"]);
    // Enumeration rows carry stopReason (logical vocabulary) but not failure (still the narrow
    // projection).
    const stopped = journal.listRuns({ cwd: "/repo", limit: 20, statuses: ["stopped"] });
    expect(stopped.find((row) => row.runId === "p_interrupted")).toMatchObject({
      stopReason: "interrupted",
    });
    expect(stopped.find((row) => row.runId === "n_stopped")).toMatchObject({
      stopReason: "provider",
    });
    expect(stopped.every((row) => !("failure" in row))).toBe(true);
  });
});

/**
 * The active spans of each life (the duration basis of the completion card,
 * docs/dynamic-workflow/transcript-and-notifications.md "How long it took").
 *
 * Event instants are stamped by appendEvent with `Date.now()`, so "how long a life lasted" can
 * only be pinned after the fact in tests: append the events, then rewrite `time_created` by
 * sequence to simulate a run that ran for hours and was interrupted by a restart midway. What gets
 * rewritten is the only column this read face reads, with a query shape verbatim identical to the
 * real database's.
 */
describe("SQLite dwf journal store — listRunLifeSpans", () => {
  const RUN_ID = "run_lives";

  /** Pins the instants of specific events by sequence. */
  function stampEvent(db: DatabaseSync, sequence: number, timeCreated: number): void {
    db.prepare("update dwf_event set time_created = ? where run_id = ? and sequence = ?").run(
      timeCreated,
      RUN_ID,
      sequence,
    );
  }

  function seedLifeRun(): {
    db: DatabaseSync;
    journal: JournalStorePort & DwfRunIntrospectionQueries;
  } {
    const { db, journal } = openIntrospectableJournal();
    journal.createRun({ runId: RUN_ID, caps: CAPS, spentTokens: 0, status: "running" });
    return { db, journal };
  }

  it("单世：从 run-started 到这一世最后一条事件", () => {
    const { db, journal } = seedLifeRun();
    journal.appendEvent(RUN_ID, { type: "run-started", runId: RUN_ID, caps: CAPS });
    journal.appendEvent(RUN_ID, { type: "log", message: "工作中" });
    journal.appendEvent(RUN_ID, { type: "run-settled", status: "completed" });
    stampEvent(db, 0, 1_000);
    stampEvent(db, 1, 5_000);
    stampEvent(db, 2, 61_000);

    expect(journal.listRunLifeSpans(RUN_ID)).toEqual([{ startedAt: 1_000, lastActivityAt: 61_000 }]);
  });

  it("多世：每一世各算一段，世与世之间的空档不出现在任何一段里", () => {
    const { db, journal } = seedLifeRun();
    // First life: ran for an hour, then interrupted by a restart (no run-settled).
    journal.appendEvent(RUN_ID, { type: "run-started", runId: RUN_ID, caps: CAPS });
    journal.appendEvent(RUN_ID, { type: "log", message: "第一世的最后一次动作" });
    // Second life: resumed after an entire weekend, completed two minutes later.
    journal.appendEvent(RUN_ID, { type: "run-started", runId: RUN_ID, caps: CAPS });
    journal.appendEvent(RUN_ID, { type: "log", message: "重放" });
    journal.appendEvent(RUN_ID, { type: "run-settled", status: "completed" });
    stampEvent(db, 0, 0);
    stampEvent(db, 1, 3_600_000);
    stampEvent(db, 2, 200_000_000);
    stampEvent(db, 3, 200_060_000);
    stampEvent(db, 4, 200_120_000);

    const spans = journal.listRunLifeSpans(RUN_ID);

    expect(spans).toEqual([
      { startedAt: 0, lastActivityAt: 3_600_000 },
      { startedAt: 200_000_000, lastActivityAt: 200_120_000 },
    ]);
    // Sum of active durations = 1 hour + 2 minutes; the dead time between the two lives
    // (about 54 hours) is not in it.
    const activeMs = spans.reduce((sum, span) => sum + (span.lastActivityAt - span.startedAt), 0);
    expect(activeMs).toBe(3_600_000 + 120_000);
  });

  it("一世里只有 run-started 一条事件：区间退化成 0，不是 null", () => {
    const { db, journal } = seedLifeRun();
    journal.appendEvent(RUN_ID, { type: "run-started", runId: RUN_ID, caps: CAPS });
    stampEvent(db, 0, 7_000);

    expect(journal.listRunLifeSpans(RUN_ID)).toEqual([{ startedAt: 7_000, lastActivityAt: 7_000 }]);
  });

  it("没有 run-started 的 run 与未知 run 都回空数组（无证据，不是 0 时长）", () => {
    const { journal } = seedLifeRun();
    journal.appendEvent(RUN_ID, { type: "log", message: "只有日志" });

    expect(journal.listRunLifeSpans(RUN_ID)).toEqual([]);
    expect(journal.listRunLifeSpans("run_never_seen")).toEqual([]);
  });

  it("只看本 run 的事件：另一条 run 的世不混进来", () => {
    const { db, journal } = seedLifeRun();
    journal.createRun({ runId: "run_other", caps: CAPS, spentTokens: 0, status: "running" });
    journal.appendEvent(RUN_ID, { type: "run-started", runId: RUN_ID, caps: CAPS });
    journal.appendEvent("run_other", { type: "run-started", runId: "run_other", caps: CAPS });
    journal.appendEvent("run_other", { type: "log", message: "别人的活" });
    stampEvent(db, 0, 10_000);
    db.prepare("update dwf_event set time_created = ? where run_id = 'run_other'").run(999_000);

    expect(journal.listRunLifeSpans(RUN_ID)).toEqual([
      { startedAt: 10_000, lastActivityAt: 10_000 },
    ]);
    expect(journal.listRunLifeSpans("run_other")).toEqual([
      { startedAt: 999_000, lastActivityAt: 999_000 },
    ]);
  });
});
