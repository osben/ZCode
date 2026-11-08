import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { codexSessionsAdapter } from "../src/external-sessions/adapters/codex.js";
import type { ExternalSessionScanContext } from "../src/external-sessions/adapters/types.js";
import type { ExternalSessionSummary } from "../src/external-sessions/contract.js";

// specs/external-sessions.md "Codex" row: state_5.sqlite threads table + rollout JSONL bodies.
const NOW = Date.parse("2026-11-07T12:00:00.000Z");

const THREAD_COLUMNS = [
  "id",
  "rollout_path",
  "created_at",
  "created_at_ms",
  "updated_at",
  "updated_at_ms",
  "cwd",
  "title",
  "name",
  "first_user_message",
  "preview",
  "model",
  "model_provider",
  "reasoning_effort",
  "git_branch",
  "git_sha",
  "archived",
  "archived_at",
  "source",
  "thread_source",
  "originator",
  "cli_version",
  "tokens_used",
  "is_pinned",
  "agent_role",
  "attached_thread_parent_id",
] as const;

const INTEGER_COLUMNS = new Set([
  "created_at_ms",
  "updated_at_ms",
  "archived",
  "tokens_used",
  "is_pinned",
]);

type ThreadFixture = Partial<Record<(typeof THREAD_COLUMNS)[number], string | number | null>>;

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "zcode-codex-sessions-"));
});

afterEach(async () => {
  // Windows needs SQLite handles released before the temp dir can be removed.
  if (process.platform === "win32") await new Promise((resolve) => setTimeout(resolve, 50));
  await rm(home, { recursive: true, force: true });
});

function makeCtx(homeDir = home): { ctx: ExternalSessionScanContext; warn: Mock } {
  const warn = vi.fn();
  return { ctx: { homeDir, now: () => NOW, warn }, warn };
}

async function createThreadsDb(homeDir: string, rows: ThreadFixture[]): Promise<string> {
  await mkdir(join(homeDir, ".codex"), { recursive: true });
  const dbPath = join(homeDir, ".codex", "state_5.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE threads (${THREAD_COLUMNS.map(
      (column) => `${column} ${INTEGER_COLUMNS.has(column) ? "INTEGER" : "TEXT"}`,
    ).join(", ")})`,
  );
  for (const row of rows) {
    const columns = THREAD_COLUMNS.filter((column) => row[column] !== undefined);
    const values = columns.map((column): string | number | null => row[column] ?? null);
    db.prepare(
      `INSERT INTO threads (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...values);
  }
  db.close();
  return dbPath;
}

async function writeRollout(
  homeDir: string,
  sessionId: string,
  records: unknown[],
): Promise<string> {
  const dir = join(homeDir, ".codex", "sessions", "2026", "11", "07");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `rollout-2026-11-07T10-00-00-${sessionId}.jsonl`);
  await writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf-8",
  );
  return filePath;
}

function sessionMeta(sessionId: string, cwd: string): unknown {
  return {
    timestamp: "2026-11-07T10:00:00.000Z",
    type: "session_meta",
    payload: { id: sessionId, cwd, timestamp: "2026-11-07T10:00:00.000Z" },
  };
}

function requireSession(
  sessions: ExternalSessionSummary[],
  sessionId: string,
): ExternalSessionSummary {
  const found = sessions.find((session) => session.sessionId === sessionId);
  if (!found) throw new Error(`session ${sessionId} not listed`);
  return found;
}

describe("codexSessionsAdapter.list (state_5.sqlite)", () => {
  it("maps thread rows to summaries and drops stale rollouts", async () => {
    const workspace = join(home, "project");
    await mkdir(workspace, { recursive: true });
    const mainId = "aa11aa11-1111-4111-8111-aa11aa11aa11";
    const untitledId = "bb22bb22-2222-4222-8222-bb22bb22bb22";
    const previewId = "cc33cc33-3333-4333-8333-cc33cc33cc33";
    const zstId = "dd44dd44-4444-4444-8444-dd44dd44dd44";
    const staleId = "ee55ee55-5555-4555-8555-ee55ee55ee55";

    const createdMs = Date.parse("2026-11-06T09:00:00.000Z");
    const updatedMs = Date.parse("2026-11-06T11:30:00.000Z");
    const mainRollout = await writeRollout(home, mainId, [sessionMeta(mainId, workspace)]);
    const untitledRollout = await writeRollout(home, untitledId, [
      sessionMeta(untitledId, workspace),
    ]);
    const previewRollout = await writeRollout(home, previewId, [sessionMeta(previewId, workspace)]);
    const zstDir = join(home, ".codex", "sessions", "2026", "11", "07");
    const zstPath = join(zstDir, `rollout-2026-11-07T10-00-00-${zstId}.jsonl.zst`);
    await writeFile(zstPath, "zstd archive bytes", "utf-8");

    await createThreadsDb(home, [
      {
        id: mainId,
        rollout_path: mainRollout,
        cwd: workspace,
        title: "Codex main session",
        model: "gpt-5.1-codex",
        git_branch: "feat/codex",
        created_at: "2026-11-06T09:00:00.000Z",
        created_at_ms: createdMs,
        updated_at: "2026-11-06T11:30:00.000Z",
        updated_at_ms: updatedMs,
        archived: 0,
        thread_source: null,
      },
      {
        // No _ms columns set: ISO strings must convert through toTimestampMs.
        id: untitledId,
        rollout_path:
          "sessions/2026/11/07/rollout-2026-11-07T10-00-00-bb22bb22-2222-4222-8222-bb22bb22bb22.jsonl",
        cwd: join(home, "gone-project"),
        created_at: "2026-11-05T08:00:00.000Z",
        updated_at: "2026-11-05T09:00:00.000Z",
        first_user_message: "Fix the login bug\nand add tests",
      },
      {
        // Archived but still a session; thread_source "main" is not a subagent.
        id: previewId,
        rollout_path: previewRollout,
        cwd: workspace,
        preview: "preview of the session",
        archived: 1,
        thread_source: "main",
      },
      {
        id: zstId,
        rollout_path: zstPath,
        cwd: workspace,
        created_at_ms: createdMs,
        updated_at_ms: updatedMs,
      },
      {
        // Rollout deleted from disk: a known stale-row state, dropped silently.
        id: staleId,
        rollout_path: join(home, ".codex", "sessions", "2026", "11", "07", "rollout-gone.jsonl"),
        cwd: workspace,
      },
      {
        id: "ff66ff66-6666-4666-8666-ff66ff66ff66",
        rollout_path: mainRollout,
        cwd: workspace,
        thread_source: "subagent",
      },
      {
        id: "ab12ab12-1212-4121-8121-ab12ab12ab12",
        rollout_path: mainRollout,
        cwd: workspace,
        thread_source: "guardian_review",
      },
      {
        id: "cd34cd34-3434-4343-8343-cd34cd34cd34",
        rollout_path: mainRollout,
        cwd: workspace,
        agent_role: "executor",
      },
      {
        id: "ef56ef56-5656-4565-8565-ef56ef56ef56",
        rollout_path: mainRollout,
        cwd: workspace,
        attached_thread_parent_id: mainId,
      },
      {
        id: "ab90ab90-9090-4909-8909-ab90ab90ab90",
        rollout_path: mainRollout,
        cwd: workspace,
        source: '{"origin":"subagent"}',
      },
    ]);

    const { ctx, warn } = makeCtx();
    const sessions = await codexSessionsAdapter.list(ctx);

    expect(sessions.map((session) => session.sessionId).sort()).toEqual(
      [mainId, untitledId, previewId, zstId].sort(),
    );

    const main = requireSession(sessions, mainId);
    expect(main).toMatchObject({
      source: "codex",
      key: `codex:${mainId}`,
      workspacePath: workspace,
      workspaceMissing: false,
      title: "Codex main session",
      createdAt: createdMs,
      updatedAt: updatedMs,
      model: "gpt-5.1-codex",
      gitBranch: "feat/codex",
      sourcePath: mainRollout,
      transcriptAvailable: true,
      resumeCommand: `codex resume ${mainId}`,
    });
    // The rollout body is never read during listing, so no message count is known.
    expect("messageCount" in main).toBe(false);

    const untitled = requireSession(sessions, untitledId);
    expect(untitled.title).toBe("Fix the login bug");
    expect(untitled.workspaceMissing).toBe(true);
    expect(untitled.sourcePath).toBe(untitledRollout);
    expect(untitled.createdAt).toBe(Date.parse("2026-11-05T08:00:00.000Z"));
    expect(untitled.updatedAt).toBe(Date.parse("2026-11-05T09:00:00.000Z"));

    const preview = requireSession(sessions, previewId);
    expect(preview.title).toBe("preview of the session");
    expect(preview.transcriptAvailable).toBe(true);

    const zst = requireSession(sessions, zstId);
    expect(zst.transcriptAvailable).toBe(false);

    expect(warn).not.toHaveBeenCalled();
  });

  it("returns [] when .codex is missing or has no store", async () => {
    const { ctx } = makeCtx();
    expect(await codexSessionsAdapter.list(ctx)).toEqual([]);
    await mkdir(join(home, ".codex"), { recursive: true });
    expect(await codexSessionsAdapter.list(ctx)).toEqual([]);
  });

  it("throws when state_5.sqlite exists but cannot be opened", async () => {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "state_5.sqlite"),
      "definitely not a sqlite database",
      "utf-8",
    );
    const { ctx } = makeCtx();
    await expect(codexSessionsAdapter.list(ctx)).rejects.toThrow();
  });

  it("dedupes by id across home dirs, keeping the first home's row", async () => {
    const workspace = join(home, "project");
    await mkdir(workspace, { recursive: true });
    const sessionId = "aa11aa11-1111-4111-8111-aa11aa11aa11";
    const rollout = await writeRollout(home, sessionId, [sessionMeta(sessionId, workspace)]);
    await createThreadsDb(home, [
      {
        id: sessionId,
        rollout_path: rollout,
        cwd: workspace,
        title: "From db",
        created_at_ms: NOW,
        updated_at_ms: NOW,
      },
    ]);
    const other = await mkdtemp(join(tmpdir(), "zcode-codex-sessions-"));
    try {
      // Same session id discovered by the rollout-head fallback in a second home.
      await writeRollout(other, sessionId, [
        {
          timestamp: "2026-11-07T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cwd: join(other, "other-project"),
            timestamp: "2026-11-07T10:00:00.000Z",
          },
        },
      ]);
      const { ctx } = makeCtx();
      ctx.extraHomeDirs = [other];
      const sessions = await codexSessionsAdapter.list(ctx);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.title).toBe("From db");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("codexSessionsAdapter.list (rollout-head fallback)", () => {
  it("reads session_meta heads and skips malformed files with a warn", async () => {
    const workspace = join(home, "fallback-project");
    await mkdir(workspace, { recursive: true });
    const fallbackId = "cc33cc33-3333-4333-8333-cc33cc33cc33";
    await writeRollout(home, fallbackId, [
      {
        timestamp: "2026-11-07T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: fallbackId,
          cwd: workspace,
          timestamp: "2026-11-07T10:00:00.000Z",
          git: { branch: "feat/fallback" },
        },
      },
      {
        timestamp: "2026-11-07T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      },
    ]);
    await writeRollout(home, "no-meta", [
      {
        timestamp: "2026-11-07T10:00:02.000Z",
        type: "event_msg",
        payload: { type: "user_message" },
      },
    ]);
    const sessionsDir = join(home, ".codex", "sessions", "2026", "11", "07");
    await writeFile(
      join(sessionsDir, "rollout-2026-11-07T10-00-00-dd44.jsonl.zst"),
      "zstd",
      "utf-8",
    );

    const { ctx, warn } = makeCtx();
    const sessions = await codexSessionsAdapter.list(ctx);

    expect(sessions).toHaveLength(1);
    const fallback = requireSession(sessions, fallbackId);
    expect(fallback).toMatchObject({
      source: "codex",
      workspacePath: workspace,
      workspaceMissing: false,
      title: `Codex · ${fallbackId.slice(0, 8)}`,
      createdAt: Date.parse("2026-11-07T10:00:00.000Z"),
      gitBranch: "feat/fallback",
      transcriptAvailable: true,
      resumeCommand: `codex resume ${fallbackId}`,
    });
    // session_meta carries the creation time only; a resumed rollout keeps growing, so the file mtime is the
    // activity time (spec "Sources", Codex row). The fixture was just written, so its mtime is newer than 10:00.
    expect(fallback.updatedAt).toBeGreaterThan(Date.parse("2026-11-07T10:00:00.000Z"));
    expect(fallback.updatedAt).toBeGreaterThanOrEqual(fallback.createdAt);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("codexSessionsAdapter.readTranscript", () => {
  const sessionId = "ee55ee55-5555-4555-8555-ee55ee55ee55";
  const t1 = Date.parse("2026-11-06T09:00:01.000Z");
  const t2 = Date.parse("2026-11-06T09:00:02.000Z");
  const t3 = Date.parse("2026-11-06T09:00:04.000Z");

  async function setupTranscriptHome(): Promise<ExternalSessionSummary[]> {
    const workspace = join(home, "project");
    await mkdir(workspace, { recursive: true });
    const rollout = await writeRollout(home, sessionId, [
      sessionMeta(sessionId, workspace),
      {
        timestamp: "2026-11-06T09:00:00.500Z",
        type: "turn_context",
        payload: { model: "gpt-5.1-codex" },
      },
      {
        timestamp: "2026-11-06T09:00:00.900Z",
        type: "event_msg",
        payload: { type: "user_message", message: "event copy" },
      },
      {
        timestamp: "2026-11-06T09:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "internal" }],
        },
      },
      {
        timestamp: "2026-11-06T09:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<environment_context>\nOperating System: mac\n</environment_context>",
            },
          ],
        },
      },
      {
        timestamp: "2026-11-06T09:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<user_instructions>hidden</user_instructions>" }],
        },
      },
      {
        timestamp: "2026-11-06T09:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md\n(none)" }],
        },
      },
      {
        timestamp: "2026-11-06T09:00:01.500Z",
        type: "response_item",
        payload: { type: "function_call", name: "shell", arguments: "{}" },
      },
      {
        timestamp: t1,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What is 2+2?" }],
        },
      },
      {
        timestamp: "2026-11-06T09:00:01.800Z",
        type: "response_item",
        payload: { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
      },
      {
        timestamp: t2,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "text", text: "plain text part" }],
        },
      },
      {
        timestamp: "2026-11-06T09:00:03.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.2-codex" },
      },
      {
        timestamp: t3,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "The answer" },
            { type: "output_text", text: "is 4" },
          ],
        },
      },
    ]);
    await createThreadsDb(home, [
      {
        id: sessionId,
        rollout_path: rollout,
        cwd: workspace,
        title: "Transcript session",
        created_at_ms: Date.parse("2026-11-06T09:00:00.000Z"),
        updated_at_ms: Date.parse("2026-11-06T09:05:00.000Z"),
      },
    ]);
    const { ctx } = makeCtx();
    return codexSessionsAdapter.list(ctx);
  }

  it("extracts user/assistant text in order, filtering roles and injected context", async () => {
    const sessions = await setupTranscriptHome();
    const { ctx } = makeCtx();
    const transcript = await codexSessionsAdapter.readTranscript(
      ctx,
      requireSession(sessions, sessionId),
    );

    expect(transcript).not.toBeNull();
    expect(transcript?.messages).toEqual([
      { role: "user", text: "What is 2+2?", timestamp: t1, model: "gpt-5.1-codex" },
      { role: "user", text: "plain text part", timestamp: t2, model: "gpt-5.1-codex" },
      { role: "assistant", text: "The answer\n\nis 4", timestamp: t3, model: "gpt-5.2-codex" },
    ]);
    expect(transcript?.truncated).toBe(false);
  });

  it("relocates the rollout through the state db when sourcePath is stale", async () => {
    const sessions = await setupTranscriptHome();
    const { ctx } = makeCtx();
    const stale = {
      ...requireSession(sessions, sessionId),
      sourcePath: join(home, ".codex", "sessions", "2026", "11", "07", "rollout-moved.jsonl"),
    };
    const transcript = await codexSessionsAdapter.readTranscript(ctx, stale);
    expect(transcript?.messages.length).toBe(3);
  });

  it("returns null for an unknown session and for .zst sources", async () => {
    const workspace = join(home, "project");
    await mkdir(workspace, { recursive: true });
    const zstId = "dd44dd44-4444-4444-8444-dd44dd44dd44";
    const zstPath = join(
      home,
      ".codex",
      "sessions",
      "2026",
      "11",
      "07",
      `rollout-2026-11-07T10-00-00-${zstId}.jsonl.zst`,
    );
    await mkdir(join(home, ".codex", "sessions", "2026", "11", "07"), { recursive: true });
    await writeFile(zstPath, "zstd archive bytes", "utf-8");
    await createThreadsDb(home, [
      { id: zstId, rollout_path: zstPath, cwd: workspace, created_at_ms: NOW, updated_at_ms: NOW },
    ]);

    const { ctx } = makeCtx();
    const sessions = await codexSessionsAdapter.list(ctx);
    const zstSummary = requireSession(sessions, zstId);
    expect(await codexSessionsAdapter.readTranscript(ctx, zstSummary)).toBeNull();

    const unknown = {
      ...zstSummary,
      sessionId: "00000000-0000-4000-8000-000000000000",
      sourcePath: join(home, ".codex", "sessions", "2026", "11", "07", "rollout-missing.jsonl"),
    };
    expect(await codexSessionsAdapter.readTranscript(ctx, unknown)).toBeNull();
  });
});

describe("codexSessionsAdapter.list (older threads schema)", () => {
  it("lists threads when optional columns such as attached_thread_parent_id are absent", async () => {
    // Codex 0.163 ships `threads` without attached_thread_parent_id / agent_role / thread_source.
    const sessionId = "aa11aa11-1111-4111-8111-aa11aa11aa11";
    const workspace = join(home, "older-repo");
    await mkdir(workspace, { recursive: true });
    const rolloutPath = await writeRollout(home, sessionId, [
      {
        timestamp: "2026-11-07T10:00:00.000Z",
        type: "session_meta",
        payload: { id: sessionId, cwd: workspace, timestamp: "2026-11-07T10:00:00.000Z" },
      },
    ]);
    await mkdir(join(home, ".codex"), { recursive: true });
    const db = new DatabaseSync(join(home, ".codex", "state_5.sqlite"));
    db.exec(
      "CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)",
    );
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)").run(
      sessionId,
      rolloutPath,
      workspace,
      "older schema",
      Date.parse("2026-11-07T10:00:00.000Z"),
      Date.parse("2026-11-07T11:00:00.000Z"),
    );
    db.close();

    const { ctx, warn } = makeCtx();
    const sessions = await codexSessionsAdapter.list(ctx);
    expect(sessions.map((session) => [session.sessionId, session.title])).toEqual([
      [sessionId, "older schema"],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("marks the source unavailable when the threads table lacks id or rollout_path", async () => {
    await mkdir(join(home, ".codex"), { recursive: true });
    const db = new DatabaseSync(join(home, ".codex", "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT, cwd TEXT)");
    db.close();
    await expect(codexSessionsAdapter.list(makeCtx().ctx)).rejects.toThrow(/rollout_path/);
  });
});
