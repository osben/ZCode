import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toToolTimings } from "../src/model-trajectory-v2/domain/toolTiming.js";
import { createSqliteToolTimingPort } from "../src/model-trajectory-v2/index.js";

describe("toToolTimings", () => {
  it("derives execution start from completed_at - duration_ms", () => {
    expect(
      toToolTimings([
        {
          tool_call_id: "call-1",
          tool_name: "Bash",
          approval_status: "approved",
          turn_id: "turn-1",
          status: "completed",
          started_at: 1000,
          completed_at: 5000,
          duration_ms: 1500,
        },
      ]),
    ).toEqual([
      {
        toolCallId: "call-1",
        toolName: "Bash",
        approvalStatus: "approved",
        turnId: "turn-1",
        status: "completed",
        scheduledAt: 1000,
        execStartedAt: 3500,
        execEndedAt: 5000,
        execDurationMs: 1500,
      },
    ]);
  });

  it("clamps the execution start to scheduledAt", () => {
    const [entry] = toToolTimings([
      {
        tool_call_id: "call-1",
        tool_name: "Bash",
        status: "completed",
        started_at: 1000,
        completed_at: 5000,
        duration_ms: 6000,
      },
    ]);
    expect(entry?.execStartedAt).toBe(1000);
    expect(entry?.execEndedAt).toBe(5000);
    expect(entry?.execDurationMs).toBe(6000);
  });

  it("omits execution fields when duration_ms is null or negative", () => {
    const entries = toToolTimings([
      {
        tool_call_id: "call-1",
        tool_name: "Bash",
        status: "running",
        started_at: 1000,
        completed_at: 5000,
        duration_ms: null,
      },
      {
        tool_call_id: "call-2",
        tool_name: "Read",
        status: "running",
        started_at: 2000,
        duration_ms: -1,
      },
    ]);
    for (const entry of entries) {
      expect("execStartedAt" in entry).toBe(false);
      expect("execEndedAt" in entry).toBe(false);
      expect("execDurationMs" in entry).toBe(false);
    }
  });

  it("maps an unknown status to running and keeps the error type", () => {
    const [entry] = toToolTimings([
      {
        tool_call_id: "call-1",
        tool_name: "Bash",
        status: "pending",
        started_at: 1000,
        error_type: "ENOENT",
      },
    ]);
    expect(entry).toMatchObject({ status: "running", errorType: "ENOENT" });
  });

  it("skips malformed rows", () => {
    expect(
      toToolTimings([
        {},
        { tool_call_id: "no-start" },
        { started_at: 5 },
        { tool_call_id: 42, started_at: 5 },
        { tool_call_id: "ok", tool_name: "Grep", started_at: 7, completed_at: 9, duration_ms: 2 },
      ]),
    ).toEqual([
      {
        toolCallId: "ok",
        toolName: "Grep",
        status: "running",
        scheduledAt: 7,
        execStartedAt: 7,
        execEndedAt: 9,
        execDurationMs: 2,
      },
    ]);
  });
});

describe("createSqliteToolTimingPort", () => {
  let tempDir = "";
  let dbPath = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-tool-timing-"));
    dbPath = join(tempDir, "session.sqlite");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createDb(): DatabaseSync {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE tool_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        trace_id TEXT,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT,
        approval_status TEXT,
        status TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        duration_ms INTEGER,
        error_type TEXT
      )
    `);
    return db;
  }

  function insert(
    db: DatabaseSync,
    row: {
      session_id: string;
      tool_call_id: string;
      tool_name?: string;
      approval_status?: string;
      status?: string;
      started_at?: number;
      completed_at?: number | null;
      duration_ms?: number | null;
      error_type?: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO tool_usage
           (session_id, turn_id, trace_id, tool_call_id, tool_name, approval_status, status, started_at, completed_at, duration_ms, error_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.session_id,
      `turn-${row.tool_call_id}`,
      `trace-${row.tool_call_id}`,
      row.tool_call_id,
      row.tool_name ?? "Bash",
      row.approval_status ?? null,
      row.status ?? "completed",
      row.started_at ?? 1000,
      row.completed_at ?? null,
      row.duration_ms ?? null,
      row.error_type ?? null,
    );
  }

  it("joins rows by session and tool call id and ignores other sessions", async () => {
    const db = createDb();
    insert(db, {
      session_id: "sess-a",
      tool_call_id: "call-1",
      started_at: 1000,
      completed_at: 5000,
      duration_ms: 1500,
    });
    insert(db, { session_id: "sess-b", tool_call_id: "call-2", started_at: 2000 });
    insert(db, {
      session_id: "sess-a",
      tool_call_id: "call-3",
      status: "error",
      started_at: 3000,
      duration_ms: null,
      error_type: "EACCES",
    });
    db.close();

    const port = createSqliteToolTimingPort({ resolveDbPath: async () => dbPath });
    const result = await port.read("sess-a", ["call-1", "call-2", "call-3"]);
    expect(result.source).toBe("session-db");
    if (result.source !== "session-db") return;
    expect(result.entries.map((entry) => entry.toolCallId).sort()).toEqual(["call-1", "call-3"]);
    expect(result.entries[0]).toMatchObject({
      toolCallId: "call-1",
      scheduledAt: 1000,
      execStartedAt: 3500,
    });
    expect(result.entries[1]).toMatchObject({
      toolCallId: "call-3",
      status: "error",
      errorType: "EACCES",
    });
  });

  it("queries more than 500 ids across chunks", async () => {
    const db = createDb();
    const insertAll = db.prepare(
      `INSERT INTO tool_usage (session_id, tool_call_id, started_at) VALUES (?, ?, ?)`,
    );
    for (let index = 0; index < 520; index += 1) {
      insertAll.run("chunk-sess", `call-${index}`, 1000);
    }
    db.close();

    const port = createSqliteToolTimingPort({ resolveDbPath: async () => dbPath });
    const result = await port.read(
      "chunk-sess",
      Array.from({ length: 520 }, (_, index) => `call-${index}`),
    );
    expect(result.source).toBe("session-db");
    if (result.source !== "session-db") return;
    expect(result.entries).toHaveLength(520);
    expect(new Set(result.entries.map((entry) => entry.toolCallId)).size).toBe(520);
  });

  it("reports db-path-unknown when the path cannot be resolved", async () => {
    const port = createSqliteToolTimingPort({ resolveDbPath: async () => null });
    await expect(port.read("sess", ["call-1"])).resolves.toEqual({
      source: "unavailable",
      reason: "db-path-unknown",
      entries: [],
    });
  });

  it("reports db-missing when the file does not exist", async () => {
    const port = createSqliteToolTimingPort({
      resolveDbPath: async () => join(tempDir, "missing.sqlite"),
    });
    await expect(port.read("sess", ["call-1"])).resolves.toEqual({
      source: "unavailable",
      reason: "db-missing",
      entries: [],
    });
  });

  it("reports read-failed for a file that is not a database", async () => {
    const notDb = join(tempDir, "not-a-db.sqlite");
    writeFileSync(notDb, "definitely not sqlite", "utf8");
    const port = createSqliteToolTimingPort({ resolveDbPath: async () => notDb });
    await expect(port.read("sess", ["call-1"])).resolves.toEqual({
      source: "unavailable",
      reason: "read-failed",
      entries: [],
    });
  });

  it("reports read-failed for a database without the tool_usage table", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE unrelated (id INTEGER)");
    db.close();
    const port = createSqliteToolTimingPort({ resolveDbPath: async () => dbPath });
    await expect(port.read("sess", ["call-1"])).resolves.toEqual({
      source: "unavailable",
      reason: "read-failed",
      entries: [],
    });
  });

  it("reports read-failed when path resolution throws", async () => {
    const port = createSqliteToolTimingPort({
      resolveDbPath: async () => {
        throw new Error("resolver exploded");
      },
    });
    await expect(port.read("sess", ["call-1"])).resolves.toEqual({
      source: "unavailable",
      reason: "read-failed",
      entries: [],
    });
  });

  it("leaves the database file untouched after reading", async () => {
    const db = createDb();
    insert(db, { session_id: "sess-a", tool_call_id: "call-1" });
    db.close();

    const before = statSync(dbPath);
    const beforeBytes = readFileSync(dbPath);
    const port = createSqliteToolTimingPort({ resolveDbPath: async () => dbPath });
    const result = await port.read("sess-a", ["call-1"]);
    expect(result.source).toBe("session-db");

    const after = statSync(dbPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(readFileSync(dbPath).equals(beforeBytes)).toBe(true);
  });
});
