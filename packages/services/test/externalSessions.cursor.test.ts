import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cursorSessionsAdapter } from "../src/external-sessions/adapters/cursor.js";
import type { ExternalSessionScanContext } from "../src/external-sessions/adapters/types.js";

// specs/external-sessions.md "Sources": Cursor is metadata-only (transcriptAvailable: false).
const DAY_MS = 24 * 60 * 60 * 1000;

const ACP_ID = "11111111-2222-3333-4444-555555555555";
const CORRUPT_ACP_ID = "22222222-3333-4444-5555-666666666666";
const NO_CWD_ACP_ID = "33333333-4444-5555-6666-777777777777";
const CHAT_ID = "agent-alpha";
const EMPTY_CHAT_ID = "agent-beta";

let home: string;
let projDir: string;
let acpMetaTime: number;
let acpStoreTime: number;
const warn = vi.fn();

function makeCtx(homeDir = home): ExternalSessionScanContext {
  return { homeDir, now: () => Date.now(), warn };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf-8");
}

/** utimes round-trips through the filesystem clock; allow a few ms of drift. */
function expectAround(actual: number | undefined, expected: number): void {
  expect(actual).toBeGreaterThanOrEqual(expected - 5);
  expect(actual).toBeLessThanOrEqual(expected + 5);
}

const adapter = cursorSessionsAdapter;

beforeEach(async () => {
  warn.mockReset();
  home = await mkdtemp(join(tmpdir(), "zcode-cursor-home-"));
  projDir = await mkdtemp(join(tmpdir(), "zcode-cursor-proj-"));

  // acp-sessions: one healthy session, one corrupt meta.json, one meta.json without cwd.
  const acpDir = join(home, ".cursor", "acp-sessions");
  acpMetaTime = Date.now() - 20 * DAY_MS;
  acpStoreTime = Date.now() - 10 * DAY_MS;
  await writeJson(join(acpDir, ACP_ID, "meta.json"), {
    schemaVersion: "1",
    cwd: projDir,
    title: "Fix the login flow",
  });
  await writeFile(join(acpDir, ACP_ID, "store.db"), "opaque-blob-bytes", "utf-8");
  await utimes(join(acpDir, ACP_ID, "meta.json"), new Date(acpMetaTime), new Date(acpMetaTime));
  await utimes(join(acpDir, ACP_ID, "store.db"), new Date(acpStoreTime), new Date(acpStoreTime));
  await mkdir(join(acpDir, CORRUPT_ACP_ID), { recursive: true });
  await writeFile(join(acpDir, CORRUPT_ACP_ID, "meta.json"), "{not json", "utf-8");
  await writeJson(join(acpDir, NO_CWD_ACP_ID, "meta.json"), {
    schemaVersion: "1",
    title: "no cwd",
  });

  // chats: one hash dir with two agents (one hasConversation:false), one bare-store hash dir.
  const chatsDir = join(home, ".cursor", "chats", "d41d8cd98f00b204e9800998ecf8427e");
  await writeJson(join(chatsDir, CHAT_ID, "meta.json"), {
    schemaVersion: "1",
    createdAtMs: 1_759_000_000_000,
    updatedAtMs: 1_760_300_000_000,
    hasConversation: true,
    cwd: projDir,
  });
  await writeJson(join(chatsDir, EMPTY_CHAT_ID, "meta.json"), {
    schemaVersion: "1",
    createdAtMs: 1_759_100_000_000,
    updatedAtMs: 1_759_200_000_000,
    hasConversation: false,
    cwd: projDir,
  });
  await mkdir(join(home, ".cursor", "chats", "0123456789abcdef0123456789abcdef"), {
    recursive: true,
  });
  await writeFile(
    join(home, ".cursor", "chats", "0123456789abcdef0123456789abcdef", "store.db"),
    "bare-store",
    "utf-8",
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(projDir, { recursive: true, force: true });
});

describe("cursorSessionsAdapter.list", () => {
  it("lists acp sessions from meta.json with filesystem timestamps", async () => {
    const sessions = await adapter.list(makeCtx());
    const acp = sessions.find((item) => item.sessionId === ACP_ID);

    expect(acp).toMatchObject({
      source: "cursor",
      sessionId: ACP_ID,
      key: `cursor:${ACP_ID}`,
      workspacePath: projDir,
      workspaceMissing: false,
      title: "Fix the login flow",
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
      sourcePath: join(home, ".cursor", "acp-sessions", ACP_ID),
      transcriptAvailable: false,
      resumeCommand: `cursor-agent --resume ${ACP_ID}`,
    });
    expectAround(acp?.createdAt, acpMetaTime);
    expectAround(acp?.updatedAt, acpStoreTime);
  });

  it("lists chats agents from meta.json, ignoring the hash dir and falling back on title", async () => {
    const sessions = await adapter.list(makeCtx());
    const chat = sessions.find((item) => item.sessionId === CHAT_ID);

    expect(chat).toMatchObject({
      workspacePath: projDir,
      title: `Cursor · ${CHAT_ID.slice(0, 8)}`,
      createdAt: 1_759_000_000_000,
      updatedAt: 1_760_300_000_000,
      transcriptAvailable: false,
      resumeCommand: `cursor-agent --resume ${CHAT_ID}`,
      sourcePath: join(home, ".cursor", "chats", "d41d8cd98f00b204e9800998ecf8427e", CHAT_ID),
    });
    expect(chat?.model).toBeUndefined();
    expect(chat?.messageCount).toBeUndefined();
    expect(chat?.gitBranch).toBeUndefined();
  });

  it("excludes hasConversation:false agents and bare store.db hash dirs", async () => {
    const sessions = await adapter.list(makeCtx());

    expect(sessions.map((item) => item.sessionId).sort()).toEqual([ACP_ID, CHAT_ID]);
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages.some((message) => message.includes("0123456789abcdef"))).toBe(false);
  });

  it("flags sessions whose cwd no longer exists", async () => {
    const goneDir = join(
      home,
      ".cursor",
      "chats",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "agent-gone",
    );
    await writeJson(join(goneDir, "meta.json"), {
      schemaVersion: "1",
      createdAtMs: 1_759_000_000_000,
      updatedAtMs: 1_759_050_000_000,
      hasConversation: true,
      cwd: join(home, "no-such-project"),
    });

    const sessions = await adapter.list(makeCtx());
    const gone = sessions.find((item) => item.sessionId === "agent-gone");
    const present = sessions.find((item) => item.sessionId === CHAT_ID);

    expect(gone?.workspaceMissing).toBe(true);
    expect(present?.workspaceMissing).toBe(false);
  });

  it("warns and skips a corrupt meta.json or one without cwd", async () => {
    const sessions = await adapter.list(makeCtx());

    expect(sessions.map((item) => item.sessionId)).not.toContain(CORRUPT_ACP_ID);
    expect(sessions.map((item) => item.sessionId)).not.toContain(NO_CWD_ACP_ID);
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(
      messages.some((message) => message.includes(CORRUPT_ACP_ID) && message.includes("malformed")),
    ).toBe(true);
    expect(
      messages.some((message) => message.includes(NO_CWD_ACP_ID) && message.includes("no cwd")),
    ).toBe(true);
  });

  it("returns [] when the .cursor root is missing", async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), "zcode-cursor-empty-"));
    try {
      expect(await adapter.list(makeCtx(emptyHome))).toEqual([]);
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  });
});

describe("cursorSessionsAdapter.readTranscript", () => {
  it("always returns null (blob store format is not understood)", async () => {
    const ctx = makeCtx();
    const sessions = await adapter.list(ctx);

    for (const summary of sessions) {
      expect(await adapter.readTranscript(ctx, summary)).toBeNull();
    }
  });

  it("returns null for an unknown session", async () => {
    const sessions = await adapter.list(makeCtx());
    const fabricate = {
      ...sessions[0],
      sessionId: "00000000-0000-0000-0000-000000000000",
    };

    expect(await adapter.readTranscript(makeCtx(), fabricate)).toBeNull();
  });
});
