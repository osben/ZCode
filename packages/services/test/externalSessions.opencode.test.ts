import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { opencodeSessionsAdapter } from "../src/external-sessions/adapters/opencode.js";
import type { ExternalSessionScanContext } from "../src/external-sessions/adapters/types.js";
import type { ExternalSessionSummary } from "../src/external-sessions/contract.js";

// specs/external-sessions.md "Sources": OpenCode is one SQLite store per home at
// <home>/.local/share/opencode/opencode.db (session_v2 + session_message; legacy session/message/part).
const T0 = 1_759_000_000_000;

const MAIN_ID = "sess_main";
const CHILD_ID = "sess_child";
const NOTITLE_ID = "sess_notitle";
const ARCHIVED_ID = "sess_archived";
const BADTIME_ID = "sess_notime";
const BADMODEL_ID = "sess_badmodel";
const BIG_ID = "sess_big";

let home: string;
let projDir: string;
let dbPath: string;
let legacyHome: string;
const warn = vi.fn();

function makeCtx(homeDir = home, extraHomeDirs?: string[]): ExternalSessionScanContext {
  return { homeDir, ...(extraHomeDirs ? { extraHomeDirs } : {}), now: () => Date.now(), warn };
}

function findSession(
  sessions: ExternalSessionSummary[],
  sessionId: string,
): ExternalSessionSummary {
  const found = sessions.find((item) => item.sessionId === sessionId);
  if (!found) throw new Error(`fixture session missing from listing: ${sessionId}`);
  return found;
}

interface V2SessionFixture {
  id: string;
  project?: string | null;
  parent?: string | null;
  directory?: string | null;
  title?: string;
  model?: string | null;
  created?: number | null;
  updated?: number | null;
  archived?: number | null;
}

function seedV2Store(db: DatabaseSync, projectDir: string, missingDir: string): void {
  db.exec(`
    create table session_v2 (
      id text primary key, project_id text, workspace_id text, parent_id text, fork_session_id text,
      slug text, directory text, title text, version integer, model text,
      time_created integer, time_updated integer, time_archived integer
    );
    create table project (id text primary key, worktree text);
    create table session_message (
      id text primary key, session_id text, type text, seq integer,
      time_created integer, time_updated integer, data text,
      unique (session_id, seq)
    );
  `);
  db.prepare("insert into project (id, worktree) values (?, ?)").run("proj_main", projectDir);

  const insertSession = db.prepare(
    `insert into session_v2
       (id, project_id, parent_id, directory, title, model, time_created, time_updated, time_archived)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const addSession = (fixture: V2SessionFixture): void => {
    insertSession.run(
      fixture.id,
      fixture.project ?? null,
      fixture.parent ?? null,
      fixture.directory ?? null,
      fixture.title ?? "",
      fixture.model ?? null,
      fixture.created ?? null,
      fixture.updated ?? null,
      fixture.archived ?? null,
    );
  };

  addSession({
    id: MAIN_ID,
    project: "proj_main",
    directory: projectDir,
    title: "Refactor the parser",
    model: '{"id":"gpt-5","providerID":"openai"}',
    created: T0,
    updated: T0 + 500_000,
  });
  // Child/subagent session: excluded from listing.
  addSession({
    id: CHILD_ID,
    project: "proj_main",
    parent: MAIN_ID,
    directory: projectDir,
    title: "Child branch",
    created: T0,
    updated: T0 + 100_000,
  });
  // Empty title and no directory: title from the first user message, cwd from project.worktree.
  addSession({
    id: NOTITLE_ID,
    project: "proj_main",
    directory: null,
    title: "",
    created: T0 + 1_000_000,
    updated: T0 + 1_200_000,
  });
  // Archived with a directory that no longer exists: still listed, workspaceMissing.
  addSession({
    id: ARCHIVED_ID,
    directory: missingDir,
    title: "Old work",
    created: T0 - 5_000_000,
    updated: T0 - 4_000_000,
    archived: T0 - 3_000_000,
  });
  // No usable timestamps: skipped with a warn.
  addSession({ id: BADTIME_ID, directory: projectDir, title: "No clock" });
  // Unparsable model JSON: soft-degrades to no model, session stays listed.
  addSession({
    id: BADMODEL_ID,
    directory: projectDir,
    title: "Weird model row",
    model: '{"broken',
    created: T0,
    updated: T0,
  });
  addSession({
    id: BIG_ID,
    directory: projectDir,
    title: "Big session",
    created: T0,
    updated: T0 + 9_000_000,
  });

  const insertMessage = db.prepare(
    `insert into session_message (id, session_id, type, seq, time_created, time_updated, data)
     values (?, ?, ?, ?, ?, ?, ?)`,
  );
  const addMessage = (
    id: string,
    sessionId: string,
    type: string,
    seq: number,
    time: number,
    data: unknown,
  ): void => {
    insertMessage.run(id, sessionId, type, seq, time, null, JSON.stringify(data));
  };

  addMessage("m1", MAIN_ID, "user", 1, T0 + 1_000, {
    text: "Fix the login bug",
    time: { created: T0 + 1_000 },
  });
  addMessage("m2", MAIN_ID, "assistant", 2, T0 + 2_000, {
    agent: "build",
    model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
    content: [
      { type: "text", text: "Looking into it" },
      { type: "reasoning", reasoning: "hidden thoughts" },
      { type: "tool", tool: "bash" },
    ],
  });
  // Assistant row with only reasoning content: counted in messageCount, skipped in the transcript.
  addMessage("m3", MAIN_ID, "assistant", 3, T0 + 3_000, {
    content: [{ type: "reasoning", reasoning: "only thoughts" }],
  });
  addMessage("m4", MAIN_ID, "user", 4, T0 + 4_000, { text: "Thanks" });
  addMessage("m5", MAIN_ID, "assistant", 5, T0 + 5_000, {
    content: [
      { type: "text", text: "Done" },
      { type: "text", text: "See patch" },
    ],
  });
  // Non user/assistant rows never count.
  addMessage("m6", MAIN_ID, "system", 6, T0 + 6_000, { text: "preamble" });

  addMessage("n1", NOTITLE_ID, "user", 1, T0 + 1_000_000, { text: "Hello OpenCode" });
  addMessage("n2", NOTITLE_ID, "assistant", 2, T0 + 1_100_000, {
    content: [{ type: "text", text: "Hi" }],
  });

  addMessage("b1", BADMODEL_ID, "user", 1, T0 + 1_000, { text: "still lists" });

  // 210 user/assistant messages: the transcript keeps the last 200 and reports truncated.
  for (let index = 1; index <= 210; index += 1) {
    const text = `m-${String(index).padStart(3, "0")}`;
    const data = index % 2 === 0 ? { content: [{ type: "text", text }] } : { text };
    addMessage(
      `big-${index}`,
      BIG_ID,
      index % 2 === 0 ? "assistant" : "user",
      index,
      T0 + index,
      data,
    );
  }
}

function seedLegacyStore(db: DatabaseSync, projectDir: string): void {
  // Upstream legacy schema (opencode session.sql.ts ≤ 1.x): role lives in message.data JSON and
  // type/text in part.data JSON; there are no standalone role/type/text columns.
  db.exec(`
    create table session (
      id text primary key, project_id text, parent_id text, directory text, title text,
      model text, time_created integer, time_updated integer
    );
    create table project (id text primary key, worktree text);
    create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
    create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
  `);
  db.prepare("insert into project (id, worktree) values (?, ?)").run("proj_leg", projectDir);
  const insertSession = db.prepare(
    "insert into session (id, project_id, parent_id, directory, title, model, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertSession.run("leg_main", null, null, projectDir, "Legacy chat", null, T0, T0 + 100_000);
  insertSession.run(
    "leg_notitle",
    "proj_leg",
    null,
    null,
    "",
    JSON.stringify({ providerID: "openrouter", modelID: "openrouter/free" }),
    T0 + 200_000,
    T0 + 300_000,
  );
  insertSession.run("leg_child", null, "leg_main", projectDir, "child", null, T0, T0);

  const insertMessage = db.prepare(
    "insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
  );
  const insertPart = db.prepare(
    "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
  );
  const message = (role: string, created: number, model?: Record<string, string>) =>
    JSON.stringify({ role, time: { created }, ...(model ? { model } : {}) });
  const textPart = (text: string) => JSON.stringify({ type: "text", text });
  insertMessage.run("lm1", "leg_main", T0 + 1_000, T0 + 1_000, message("user", T0 + 1_000));
  insertPart.run("lp1", "lm1", "leg_main", T0 + 1_000, T0 + 1_000, textPart("Hi there"));
  insertPart.run("lp2", "lm1", "leg_main", T0 + 1_001, T0 + 1_001, textPart("second line"));
  insertMessage.run(
    "lm2",
    "leg_main",
    T0 + 2_000,
    T0 + 2_000,
    message("assistant", T0 + 2_000, { providerID: "openrouter", modelID: "openrouter/free" }),
  );
  insertPart.run("lp3", "lm2", "leg_main", T0 + 2_000, T0 + 2_000, textPart("Answer"));
  insertPart.run(
    "lp3r",
    "lm2",
    "leg_main",
    T0 + 2_001,
    T0 + 2_001,
    JSON.stringify({ type: "reasoning", text: "hidden" }),
  );
  insertMessage.run("lm3", "leg_main", T0 + 3_000, T0 + 3_000, message("system", T0 + 3_000));
  insertPart.run("lp4", "lm3", "leg_main", T0 + 3_000, T0 + 3_000, textPart("system preamble"));

  insertMessage.run(
    "ln1",
    "leg_notitle",
    T0 + 210_000,
    T0 + 210_000,
    message("user", T0 + 210_000),
  );
  insertPart.run(
    "lnp1",
    "ln1",
    "leg_notitle",
    T0 + 210_000,
    T0 + 210_000,
    textPart("First legacy prompt"),
  );
}

const adapter = opencodeSessionsAdapter;

beforeEach(async () => {
  warn.mockReset();
  home = await mkdtemp(join(tmpdir(), "zcode-opencode-home-"));
  projDir = await mkdtemp(join(tmpdir(), "zcode-opencode-proj-"));
  legacyHome = await mkdtemp(join(tmpdir(), "zcode-opencode-legacy-"));
  dbPath = join(home, ".local", "share", "opencode", "opencode.db");
  await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    seedV2Store(db, projDir, join(home, "no-such-project"));
  } finally {
    db.close();
  }
  const legacyDbPath = join(legacyHome, ".local", "share", "opencode", "opencode.db");
  await mkdir(join(legacyHome, ".local", "share", "opencode"), { recursive: true });
  const legacyDb = new DatabaseSync(legacyDbPath);
  try {
    seedLegacyStore(legacyDb, projDir);
  } finally {
    legacyDb.close();
  }
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(projDir, { recursive: true, force: true });
  await rm(legacyHome, { recursive: true, force: true });
});

describe("opencodeSessionsAdapter.list (session_v2)", () => {
  it("lists sessions with model, timestamps and a grouped message count", async () => {
    const sessions = await adapter.list(makeCtx());
    const main = findSession(sessions, MAIN_ID);

    expect(main).toMatchObject({
      source: "opencode",
      sessionId: MAIN_ID,
      key: `opencode:${MAIN_ID}`,
      workspacePath: projDir,
      workspaceMissing: false,
      title: "Refactor the parser",
      createdAt: T0,
      updatedAt: T0 + 500_000,
      model: "openai/gpt-5",
      messageCount: 5,
      sourcePath: dbPath,
      transcriptAvailable: true,
      resumeCommand: `opencode --session ${MAIN_ID}`,
    });
  });

  it("excludes child sessions (parent_id) and warns about sessions without timestamps", async () => {
    const sessions = await adapter.list(makeCtx());

    expect(sessions.map((item) => item.sessionId)).not.toContain(CHILD_ID);
    expect(sessions.map((item) => item.sessionId)).not.toContain(BADTIME_ID);
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.includes(BADTIME_ID))).toBe(true);
  });

  it("falls back to project.worktree for cwd and to the first user message for the title", async () => {
    const sessions = await adapter.list(makeCtx());
    const noTitle = findSession(sessions, NOTITLE_ID);

    expect(noTitle).toMatchObject({
      workspacePath: projDir,
      workspaceMissing: false,
      title: "Hello OpenCode",
      messageCount: 2,
    });
    expect(noTitle.model).toBeUndefined();
  });

  it("includes archived sessions and flags a missing cwd", async () => {
    const sessions = await adapter.list(makeCtx());
    const archived = findSession(sessions, ARCHIVED_ID);

    expect(archived.workspacePath).toBe(join(home, "no-such-project"));
    expect(archived.workspaceMissing).toBe(true);
    expect(findSession(sessions, MAIN_ID).workspaceMissing).toBe(false);
  });

  it("soft-degrades an unparsable model column", async () => {
    const sessions = await adapter.list(makeCtx());
    const badModel = findSession(sessions, BADMODEL_ID);

    expect(badModel.title).toBe("Weird model row");
    expect(badModel.model).toBeUndefined();
  });

  it("returns [] when the store is missing and throws when it cannot be opened", async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), "zcode-opencode-empty-"));
    try {
      expect(await adapter.list(makeCtx(emptyHome))).toEqual([]);
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }

    const badHome = await mkdtemp(join(tmpdir(), "zcode-opencode-bad-"));
    try {
      const badPath = join(badHome, ".local", "share", "opencode", "opencode.db");
      await mkdir(join(badHome, ".local", "share", "opencode"), { recursive: true });
      await writeFile(badPath, "this is not a sqlite database", "utf-8");
      await expect(adapter.list(makeCtx(badHome))).rejects.toThrow();
    } finally {
      await rm(badHome, { recursive: true, force: true });
    }
  });

  it("de-duplicates when the same home is probed twice", async () => {
    const sessions = await adapter.list(makeCtx(home, [home]));

    expect(new Set(sessions.map((item) => item.sessionId)).size).toBe(sessions.length);
    expect(sessions.find((item) => item.sessionId === MAIN_ID)).toBeDefined();
  });
});

describe("opencodeSessionsAdapter.readTranscript (session_v2)", () => {
  it("keeps only user/assistant text in seq order and joins assistant text parts", async () => {
    const ctx = makeCtx();
    const sessions = await adapter.list(ctx);
    const transcript = await adapter.readTranscript(ctx, findSession(sessions, MAIN_ID));

    expect(transcript).not.toBeNull();
    expect(transcript?.messages).toEqual([
      { role: "user", text: "Fix the login bug", timestamp: T0 + 1_000 },
      {
        role: "assistant",
        text: "Looking into it",
        timestamp: T0 + 2_000,
        model: "anthropic/claude-sonnet-5-5",
      },
      { role: "user", text: "Thanks", timestamp: T0 + 4_000 },
      { role: "assistant", text: "Done\n\nSee patch", timestamp: T0 + 5_000 },
    ]);
    expect(transcript?.truncated).toBe(false);
  });

  it("caps the transcript at 200 messages keeping the tail", async () => {
    const ctx = makeCtx();
    const sessions = await adapter.list(ctx);
    const transcript = await adapter.readTranscript(ctx, findSession(sessions, BIG_ID));

    expect(transcript?.truncated).toBe(true);
    expect(transcript?.messages).toHaveLength(200);
    expect(transcript?.messages[0]?.text).toBe("m-011");
    expect(transcript?.messages[199]?.text).toBe("m-210");
  });

  it("returns null for an unknown session id and for a store that disappeared", async () => {
    const ctx = makeCtx();
    const sessions = await adapter.list(ctx);
    const main = findSession(sessions, MAIN_ID);
    const unknown = { ...main, sessionId: "does-not-exist" };

    expect(await adapter.readTranscript(ctx, unknown)).toBeNull();

    await rm(dbPath);
    expect(await adapter.readTranscript(ctx, main)).toBeNull();
  });
});

describe("opencodeSessionsAdapter (legacy session/message/part)", () => {
  it("lists legacy sessions with title fallback and worktree fallback", async () => {
    const ctx = makeCtx(legacyHome);
    const sessions = await adapter.list(ctx);
    const main = findSession(sessions, "leg_main");

    expect(main).toMatchObject({
      source: "opencode",
      key: "opencode:leg_main",
      workspacePath: projDir,
      title: "Legacy chat",
      createdAt: T0,
      updatedAt: T0 + 100_000,
      messageCount: 2,
      transcriptAvailable: true,
      resumeCommand: "opencode --session leg_main",
    });
    expect(main.model).toBeUndefined();
    expect(findSession(sessions, "leg_notitle")).toMatchObject({
      workspacePath: projDir,
      title: "First legacy prompt",
      model: "openrouter/openrouter/free",
    });
    expect(sessions.some((session) => session.sessionId === "leg_child")).toBe(false);
  });

  it("groups legacy text parts per message and filters roles", async () => {
    const ctx = makeCtx(legacyHome);
    const sessions = await adapter.list(ctx);
    const transcript = await adapter.readTranscript(ctx, findSession(sessions, "leg_main"));

    expect(transcript?.messages).toEqual([
      { role: "user", text: "Hi there\n\nsecond line", timestamp: T0 + 1_000 },
      {
        role: "assistant",
        text: "Answer",
        timestamp: T0 + 2_000,
        model: "openrouter/openrouter/free",
      },
    ]);
  });

  it("returns null for an unknown legacy session", async () => {
    const ctx = makeCtx(legacyHome);
    const sessions = await adapter.list(ctx);
    const unknown = { ...findSession(sessions, "leg_main"), sessionId: "leg-unknown" };

    expect(await adapter.readTranscript(ctx, unknown)).toBeNull();
  });
});
