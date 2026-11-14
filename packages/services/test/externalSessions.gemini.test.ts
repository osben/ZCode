import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geminiSessionsAdapter } from "../src/external-sessions/adapters/gemini.js";
import type { ExternalSessionScanContext } from "../src/external-sessions/adapters/types.js";
import type { ExternalSessionSummary } from "../src/external-sessions/contract.js";

// specs/external-sessions.md "Sources": Gemini CLI chats under `<home>/.gemini/tmp/<name>/chats`.
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const MAIN_ID = "gemini-main-1";
const SUB_ID = "gemini-sub-1";
const MAIN_FILE = "session-2025-01-02T03-04-a1b2c3d4.jsonl";
const SUB_FILE = "session-2025-01-02T03-05-b2c3d4e5.jsonl";
const BROKEN_FILE = "session-broken.jsonl";

let home: string;
let projDir: string;
let startMs: number;
let headerUpdatedMs: number;
let m1Ms: number;
let m2Ms: number;
let m3Ms: number;
let m4Ms: number;
let m5Ms: number;
let set1Ms: number;
let set2Ms: number;
let mtimeMs: number;
const warn = vi.fn();

const adapter = geminiSessionsAdapter;

function makeCtx(homeDir = home): ExternalSessionScanContext {
  return { homeDir, now: () => Date.now(), warn };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf-8");
}

async function writeLines(path: string, lines: readonly unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const text = lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n");
  await writeFile(path, `${text}\n`, "utf-8");
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf-8");
}

beforeEach(async () => {
  warn.mockReset();
  home = await mkdtemp(join(tmpdir(), "zcode-gemini-home-"));
  projDir = await mkdtemp(join(tmpdir(), "zcode-gemini-proj-"));
  const base = Date.now();
  startMs = base - 2 * HOUR;
  headerUpdatedMs = base - 90 * MINUTE;
  m1Ms = base - 110 * MINUTE;
  m2Ms = base - 100 * MINUTE;
  m3Ms = base - 80 * MINUTE;
  set1Ms = base - 60 * MINUTE;
  m4Ms = base - 40 * MINUTE;
  m5Ms = base - 31 * MINUTE;
  set2Ms = base - 30 * MINUTE;
  mtimeMs = base - 3 * HOUR;

  await writeJson(join(home, ".gemini", "projects.json"), { projects: { [projDir]: "proj-name" } });
  const chatsDir = join(home, ".gemini", "tmp", "proj-name", "chats");

  // Main session: session_context preamble, multi-part user content, $set updates, an error record.
  const mainPath = join(chatsDir, MAIN_FILE);
  await writeLines(mainPath, [
    {
      sessionId: MAIN_ID,
      projectHash: "h1",
      startTime: iso(startMs),
      lastUpdated: iso(headerUpdatedMs),
      kind: "main",
    },
    {
      id: "m1",
      timestamp: iso(m1Ms),
      type: "user",
      content: [
        {
          text: "<session_context># Gemini added this\n\nProject: zcode\nFiles: many\n</session_context>",
        },
      ],
    },
    {
      id: "m2",
      timestamp: iso(m2Ms),
      type: "user",
      content: [{ text: "Refactor the auth module" }, { text: "and test it" }],
    },
    {
      id: "m3",
      timestamp: iso(m3Ms),
      type: "gemini",
      model: "gemini-2.5-pro",
      content: [{ text: "I'll start by reading the files." }],
    },
    { $set: { lastUpdated: iso(set1Ms) } },
    { id: "m4", timestamp: iso(m4Ms), type: "error", content: [{ text: "boom" }] },
    { id: "m5", timestamp: iso(m5Ms), type: "gemini", model: "gemini-2.5-flash", content: "Done." },
    { $set: { lastUpdated: iso(set2Ms) } },
  ]);
  // Pin the mtime below every in-file timestamp so `updatedAt` is deterministic.
  await utimes(mainPath, new Date(mtimeMs), new Date(mtimeMs));

  await writeLines(join(chatsDir, SUB_FILE), [
    { sessionId: SUB_ID, startTime: iso(startMs), lastUpdated: iso(headerUpdatedMs), kind: "sub" },
    { id: "s1", timestamp: iso(m2Ms), type: "user", content: "sidechain prompt" },
  ]);
  await writeLines(join(chatsDir, BROKEN_FILE), ["not json at all", "{{{"]);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(projDir, { recursive: true, force: true });
});

describe("geminiSessionsAdapter.list", () => {
  it("lists a main session with header dates, tail model and small-file message count", async () => {
    const sessions = await adapter.list(makeCtx());
    const main = sessions.find((item) => item.sessionId === MAIN_ID);

    expect(main).toMatchObject({
      source: "gemini",
      sessionId: MAIN_ID,
      key: `gemini:${MAIN_ID}`,
      workspacePath: projDir,
      workspaceMissing: false,
      title: "Refactor the auth module",
      createdAt: startMs,
      updatedAt: set2Ms,
      model: "gemini-2.5-flash",
      messageCount: 4,
      sourcePath: join(home, ".gemini", "tmp", "proj-name", "chats", MAIN_FILE),
      transcriptAvailable: true,
      resumeCommand: `gemini --resume ${MAIN_ID}`,
    });
    expect(main?.gitBranch).toBeUndefined();
  });

  it("excludes non-main kinds and skips a malformed jsonl with warn", async () => {
    const sessions = await adapter.list(makeCtx());

    expect(sessions.map((item) => item.sessionId)).toEqual([MAIN_ID]);
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(
      messages.some((message) => message.includes(BROKEN_FILE) && message.includes("malformed")),
    ).toBe(true);
  });

  it("returns [] when the .gemini root is missing", async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), "zcode-gemini-empty-"));
    try {
      expect(await adapter.list(makeCtx(emptyHome))).toEqual([]);
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it("falls back on history/<name>/.project_root when projects.json is absent", async () => {
    const fallbackHome = await mkdtemp(join(tmpdir(), "zcode-gemini-fallback-"));
    const projDir2 = await mkdtemp(join(tmpdir(), "zcode-gemini-proj2-"));
    try {
      const session = (sessionId: string) => [
        { sessionId, startTime: iso(startMs), lastUpdated: iso(headerUpdatedMs), kind: "main" },
        { id: "u1", timestamp: iso(m2Ms), type: "user", content: "hello gemini" },
      ];
      await writeLines(
        join(fallbackHome, ".gemini", "tmp", "fallback-name", "chats", "session-f1.jsonl"),
        session("gemini-fallback-1"),
      );
      await writeLines(
        join(fallbackHome, ".gemini", "tmp", "gone-name", "chats", "session-g1.jsonl"),
        session("gemini-gone-1"),
      );
      await writeLines(
        join(fallbackHome, ".gemini", "tmp", "orphan-name", "chats", "session-o1.jsonl"),
        session("gemini-orphan-1"),
      );
      await writeText(
        join(fallbackHome, ".gemini", "history", "fallback-name", ".project_root"),
        `${projDir2}\n`,
      );
      await writeText(
        join(fallbackHome, ".gemini", "history", "gone-name", ".project_root"),
        join(fallbackHome, "no-such-project"),
      );

      const sessions = await adapter.list(makeCtx(fallbackHome));
      const fallback = sessions.find((item) => item.sessionId === "gemini-fallback-1");
      const gone = sessions.find((item) => item.sessionId === "gemini-gone-1");

      expect(fallback?.workspacePath).toBe(projDir2);
      expect(fallback?.workspaceMissing).toBe(false);
      expect(gone?.workspaceMissing).toBe(true);
      expect(sessions.map((item) => item.sessionId)).not.toContain("gemini-orphan-1");
      const messages = warn.mock.calls.map(([message]) => String(message));
      expect(
        messages.some(
          (message) => message.includes("orphan-name") && message.includes("no project path"),
        ),
      ).toBe(true);
    } finally {
      await rm(fallbackHome, { recursive: true, force: true });
      await rm(projDir2, { recursive: true, force: true });
    }
  });
});

describe("geminiSessionsAdapter.readTranscript", () => {
  it("extracts user/gemini text in order, skipping $set, errors and the session_context preamble", async () => {
    const ctx = makeCtx();
    const sessions = await adapter.list(ctx);
    const main = sessions.find((item) => item.sessionId === MAIN_ID);
    const transcript = main ? await adapter.readTranscript(ctx, main) : null;

    expect(transcript).toEqual({
      truncated: false,
      messages: [
        { role: "user", text: "Refactor the auth module\nand test it", timestamp: m2Ms },
        {
          role: "assistant",
          text: "I'll start by reading the files.",
          timestamp: m3Ms,
          model: "gemini-2.5-pro",
        },
        { role: "assistant", text: "Done.", timestamp: m5Ms, model: "gemini-2.5-flash" },
      ],
    });
  });

  it("replays $rewindTo, $patch and $set.messages before extracting the transcript", async () => {
    const journalHome = await mkdtemp(join(tmpdir(), "zcode-gemini-journal-"));
    try {
      const project = join(journalHome, "proj");
      await mkdir(project, { recursive: true });
      await writeJson(join(journalHome, ".gemini", "projects.json"), {
        projects: { [project]: "proj" },
      });
      const file = join(journalHome, ".gemini", "tmp", "proj", "chats", "session-journal.jsonl");
      const at = (offset: number) => iso(Date.UTC(2026, 0, 1) + offset * MINUTE);
      await writeLines(file, [
        {
          sessionId: "gemini-journal",
          projectHash: "x",
          startTime: at(0),
          lastUpdated: at(9),
          kind: "main",
        },
        { id: "u1", timestamp: at(1), type: "user", content: [{ text: "Original prompt" }] },
        { id: "g1", timestamp: at(2), type: "gemini", content: [{ text: "Discarded answer" }] },
        { $rewindTo: "g1" },
        { id: "g2", timestamp: at(3), type: "gemini", content: [{ text: "Kept answer" }] },
        { $patch: { id: "u1", content: [{ text: "Patched prompt" }] } },
        { id: "u2", timestamp: at(4), type: "user", content: [{ text: "Removed later" }] },
        { $patch: { removeIds: ["u2"] } },
        { $set: { lastUpdated: at(9) } },
      ]);
      const ctx = makeCtx(journalHome);
      const sessions = await adapter.list(ctx);
      const journal = sessions.find((item) => item.sessionId === "gemini-journal");
      if (!journal) throw new Error("journal session missing");
      const transcript = await adapter.readTranscript(ctx, journal);
      expect(transcript?.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "Patched prompt"],
        ["assistant", "Kept answer"],
      ]);

      await writeLines(file, [
        {
          sessionId: "gemini-journal",
          projectHash: "x",
          startTime: at(0),
          lastUpdated: at(9),
          kind: "main",
        },
        { id: "a", timestamp: at(1), type: "user", content: "old" },
        { $set: { messages: [{ id: "b", timestamp: at(2), type: "user", content: "replaced" }] } },
      ]);
      const replaced = await adapter.readTranscript(ctx, journal);
      expect(replaced?.messages.map((message) => message.text)).toEqual(["replaced"]);
    } finally {
      await rm(journalHome, { recursive: true, force: true });
    }
  });

  it("returns null for an unknown session id and for a vanished source file", async () => {
    const ctx = makeCtx();
    const sessions = await adapter.list(ctx);
    const main = sessions.find((item) => item.sessionId === MAIN_ID);
    if (!main) throw new Error("fixture session missing");

    const wrongId: ExternalSessionSummary = { ...main, sessionId: "gemini-unknown" };
    const goneFile: ExternalSessionSummary = {
      ...main,
      sourcePath: join(main.sourcePath, "..", "session-gone.jsonl"),
    };
    expect(await adapter.readTranscript(ctx, wrongId)).toBeNull();
    expect(await adapter.readTranscript(ctx, goneFile)).toBeNull();
  });
});
