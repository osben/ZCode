import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { codexSessionsAdapter } from "../src/external-sessions/adapters/codex.js";
import { opencodeSessionsAdapter } from "../src/external-sessions/adapters/opencode.js";
import { titleFromPrompt } from "../src/external-sessions/adapters/shared.js";
import type { ExternalSessionScanContext } from "../src/external-sessions/adapters/types.js";
import {
  EXTERNAL_SESSION_ID_PATTERN,
  isSafeExternalSessionId,
  type ExternalSessionSummary,
} from "../src/external-sessions/contract.js";

// specs/external-sessions.md "Read-only stores", "Scan cost", "Transcript bounds" and "Session ids".

const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-ext-hardening-"));
  tempDirs.push(dir);
  return dir;
}

function makeCtx(homeDir: string): ExternalSessionScanContext {
  return { homeDir, now: () => NOW, warn: () => undefined };
}

/** Lists every entry under a directory tree as sorted relative paths with sizes; used to prove nothing was written. */
async function snapshotTree(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const full = join(dir, name);
      const info = await stat(full);
      entries.push(`${full.slice(root.length)}:${info.isDirectory() ? "dir" : info.size}`);
      if (info.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  return entries;
}

async function writeRollout(homeDir: string, sessionId: string, records: unknown[]): Promise<void> {
  const dir = join(homeDir, ".codex", "sessions", "2026", "11", "12");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `rollout-2026-11-12T10-00-00-${sessionId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf-8",
  );
}

function sessionMeta(sessionId: string, cwd: string | undefined): unknown {
  return {
    timestamp: "2026-11-12T10:00:00.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp: "2026-11-12T10:00:00.000Z",
      ...(cwd === undefined ? {} : { cwd }),
    },
  };
}

function userMessage(text: string): unknown {
  return {
    timestamp: "2026-11-12T10:00:01.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}

function assistantMessage(text: string): unknown {
  return {
    timestamp: "2026-11-12T10:00:02.000Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  };
}

describe("read-only store access", () => {
  it("never adds -wal or -shm next to a store, including a store with pending wal rows", async () => {
    const home = await tempHome();
    const workspace = join(home, "project");
    await mkdir(workspace, { recursive: true });

    // Codex: keep a writer open in WAL mode so committed rows live in state_5.sqlite-wal.
    const codexDir = join(home, ".codex");
    await mkdir(codexDir, { recursive: true });
    const codexDb = new DatabaseSync(join(codexDir, "state_5.sqlite"));
    codexDb.exec("PRAGMA journal_mode=WAL");
    codexDb.exec(
      "CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)",
    );
    const rolloutRel = "sessions/2026/11/12/rollout-wal.jsonl";
    await mkdir(join(codexDir, "sessions", "2026", "11", "12"), { recursive: true });
    await writeFile(
      join(codexDir, rolloutRel),
      `${JSON.stringify(sessionMeta("wal-session", workspace))}\n`,
      "utf-8",
    );
    codexDb
      .prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)")
      .run("wal-session", rolloutRel, workspace, "from wal", NOW, NOW);
    expect((await stat(join(codexDir, "state_5.sqlite-wal"))).size).toBeGreaterThan(0);

    // OpenCode: a closed store with no wal file.
    const openDir = join(home, ".local", "share", "opencode");
    await mkdir(openDir, { recursive: true });
    const openDb = new DatabaseSync(join(openDir, "opencode.db"));
    openDb.exec(
      `CREATE TABLE project (id TEXT, worktree TEXT);
       CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT, project_id TEXT);
       CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, data TEXT, time_created INTEGER);`,
    );
    openDb
      .prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)")
      .run("open-session", workspace, "from opencode", null, NOW, NOW);
    openDb.close();

    const before = await snapshotTree(home);
    const sessions = await codexSessionsAdapter.list(makeCtx(home));
    const openSessions = await opencodeSessionsAdapter.list(makeCtx(home));
    const after = await snapshotTree(home);
    codexDb.close();

    expect(after).toEqual(before);
    // The rows are still read: the pending wal row is visible through the temp copy.
    expect(sessions.map((session) => session.sessionId)).toContain("wal-session");
    expect(openSessions.map((session) => session.sessionId)).toContain("open-session");
  });
});

describe("titleFromPrompt", () => {
  it("keeps the first-line title for a normal prompt, dropping a closed system block", () => {
    expect(titleFromPrompt("<system>context</system>\nFix the build")).toBe("Fix the build");
  });

  it("finishes quickly on a 920 KB prompt full of unclosed tags", () => {
    const huge = `${"<x>".repeat(300_000)}\nsecond line`;
    expect(huge.length).toBeGreaterThan(900_000);
    const started = performance.now();
    const title = titleFromPrompt(huge);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(500);
    expect(title).toBeDefined();
    expect(title!.length).toBeLessThanOrEqual(80);
  });
});

describe("codex transcript replay", () => {
  it("keeps the last 200 messages, cuts oversized text, and flags truncation", async () => {
    const home = await tempHome();
    const workspace = join(home, "project");
    await mkdir(workspace, { recursive: true });
    const records: unknown[] = [sessionMeta("long-session", workspace)];
    for (let index = 0; index < 500; index += 1) {
      records.push(
        index === 3 ? userMessage("x".repeat(20_000)) : userMessage(`m${index}`),
        assistantMessage(`a${index}`),
      );
    }
    await writeRollout(home, "long-session", records);
    const ctx = makeCtx(home);
    const summary = requireSession(await codexSessionsAdapter.list(ctx), "long-session");
    const read = await codexSessionsAdapter.readTranscript(ctx, summary);
    expect(read).not.toBeNull();
    expect(read!.truncated).toBe(true);
    expect(read!.messages).toHaveLength(200);
    expect(read!.messages.at(-1)?.text).toBe("a499");
    expect(read!.messages.every((message) => message.text.length <= 8001)).toBe(true);
  });

  it("replays a thread_rolled_back event in file order before later messages", async () => {
    const home = await tempHome();
    const workspace = join(home, "project");
    await mkdir(workspace, { recursive: true });
    await writeRollout(home, "rolled-session", [
      sessionMeta("rolled-session", workspace),
      userMessage("first"),
      assistantMessage("answer one"),
      userMessage("second"),
      assistantMessage("answer two"),
      { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
      userMessage("third"),
      assistantMessage("answer three"),
    ]);
    const ctx = makeCtx(home);
    const summary = requireSession(await codexSessionsAdapter.list(ctx), "rolled-session");
    const read = await codexSessionsAdapter.readTranscript(ctx, summary);
    expect(read!.messages.map((message) => message.text)).toEqual([
      "first",
      "answer one",
      "third",
      "answer three",
    ]);
  });
});

describe("workspace and id rules", () => {
  it("does not list a codex rollout without a cwd for any workspace", async () => {
    const home = await tempHome();
    await writeRollout(home, "no-cwd", [sessionMeta("no-cwd", undefined)]);
    const sessions = await codexSessionsAdapter.list(makeCtx(home));
    expect(sessions.map((session) => session.sessionId)).not.toContain("no-cwd");
  });

  it("rejects a session id that starts with a dash", () => {
    expect(isSafeExternalSessionId("-rf")).toBe(false);
    expect(isSafeExternalSessionId("--resume")).toBe(false);
    expect(EXTERNAL_SESSION_ID_PATTERN.test("a-b.c:d_e")).toBe(true);
    expect(isSafeExternalSessionId("")).toBe(false);
    expect(isSafeExternalSessionId("a".repeat(129))).toBe(false);
    expect(isSafeExternalSessionId("a".repeat(128))).toBe(true);
  });
});

function requireSession(
  sessions: ExternalSessionSummary[],
  sessionId: string,
): ExternalSessionSummary {
  const found = sessions.find((session) => session.sessionId === sessionId);
  if (!found) throw new Error(`session ${sessionId} not listed`);
  return found;
}
