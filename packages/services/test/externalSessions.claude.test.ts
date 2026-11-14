import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeSessionsAdapter } from "../src/external-sessions/adapters/claude.js";
import type { ExternalSessionScanContext } from "../src/external-sessions/adapters/types.js";

// specs/external-sessions.md "Sources" (Claude Code row) and "Acceptance scenarios" 1 and 3.

const tempDirs: string[] = [];

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-ext-claude-"));
  tempDirs.push(dir);
  return dir;
}

function ctx(homeDir: string): ExternalSessionScanContext {
  return { homeDir, now: () => Date.now(), warn: vi.fn() };
}

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

function userRecord(sessionId: string, cwd: string, text: string, timestamp: string) {
  return {
    type: "user",
    sessionId,
    cwd,
    gitBranch: "feat/x",
    timestamp,
    isSidechain: false,
    uuid: `${sessionId}-u`,
    message: { role: "user", content: text },
  };
}

function assistantRecord(sessionId: string, cwd: string, text: string, timestamp: string) {
  return {
    type: "assistant",
    sessionId,
    cwd,
    gitBranch: "feat/x",
    timestamp,
    isSidechain: false,
    uuid: `${sessionId}-a`,
    message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("claudeSessionsAdapter", () => {
  it("lists top-level sessions with cwd, title, branch, model and skips sidechains and subagent files", async () => {
    const home = await makeHome();
    const workspace = join(home, "repo");
    await mkdir(workspace, { recursive: true });
    const slugDir = join(home, ".claude", "projects", "-repo");
    await mkdir(join(slugDir, "s1", "subagents"), { recursive: true });
    await writeFile(
      join(slugDir, "s1.jsonl"),
      line(
        userRecord("s1", workspace, "Fix the login bug\nsecond line", "2026-11-01T10:00:00.000Z"),
      ) +
        line(assistantRecord("s1", workspace, "Sure, looking.", "2026-11-01T10:00:05.000Z")) +
        line({ type: "custom-title", sessionId: "s1", customTitle: "Login fix" }),
    );
    await writeFile(
      join(slugDir, "s2.jsonl"),
      line({
        ...userRecord("s2", workspace, "side", "2026-11-01T11:00:00.000Z"),
        isSidechain: true,
      }),
    );
    await writeFile(
      join(slugDir, "s1", "subagents", "agent-a.jsonl"),
      line(userRecord("agent-a", workspace, "sub task", "2026-11-01T12:00:00.000Z")),
    );

    const sessions = await claudeSessionsAdapter.list(ctx(home));

    expect(sessions.map((item) => item.sessionId)).toEqual(["s1"]);
    const [s1] = sessions;
    expect(s1).toMatchObject({
      source: "claude",
      key: "claude:s1",
      workspacePath: workspace,
      workspaceMissing: false,
      title: "Login fix",
      gitBranch: "feat/x",
      model: "claude-opus-5-5",
      transcriptAvailable: true,
      importable: true,
      resumeCommand: "claude --resume s1",
    });
    expect(s1?.createdAt).toBe(Date.parse("2026-11-01T10:00:00.000Z"));
    expect(s1?.updatedAt).toBeGreaterThanOrEqual(Date.parse("2026-11-01T10:00:05.000Z"));
  });

  it("lists sessions under .claude/worktrees but marks them not importable", async () => {
    const home = await makeHome();
    const worktree = join(home, "repo", ".claude", "worktrees", "wt-1");
    await mkdir(worktree, { recursive: true });
    const slugDir = join(home, ".claude", "projects", "-repo--claude-worktrees-wt-1");
    await mkdir(slugDir, { recursive: true });
    await writeFile(
      join(slugDir, "w1.jsonl"),
      line(userRecord("w1", worktree, "worktree task", "2026-11-01T10:00:00.000Z")),
    );
    const [session] = await claudeSessionsAdapter.list(ctx(home));
    expect(session).toMatchObject({
      sessionId: "w1",
      workspacePath: worktree,
      transcriptAvailable: true,
      importable: false,
      resumeCommand: "claude --resume w1",
    });
  });

  it("returns [] without a projects root and skips a malformed file with a warning", async () => {
    const home = await makeHome();
    expect(await claudeSessionsAdapter.list(ctx(home))).toEqual([]);

    const slugDir = join(home, ".claude", "projects", "-x");
    await mkdir(slugDir, { recursive: true });
    await writeFile(join(slugDir, "broken.jsonl"), "{not json\n");
    await writeFile(join(slugDir, "empty.jsonl"), "");
    const context = ctx(home);
    expect(await claudeSessionsAdapter.list(context)).toEqual([]);
  });

  it("reads a transcript as user/assistant text only and returns null when the file is gone", async () => {
    const home = await makeHome();
    const workspace = join(home, "repo");
    await mkdir(workspace, { recursive: true });
    const slugDir = join(home, ".claude", "projects", "-repo");
    await mkdir(slugDir, { recursive: true });
    await writeFile(
      join(slugDir, "s1.jsonl"),
      line(userRecord("s1", workspace, "Hello", "2026-11-01T10:00:00.000Z")) +
        line(assistantRecord("s1", workspace, "Hi there", "2026-11-01T10:00:05.000Z")),
    );
    const [summary] = await claudeSessionsAdapter.list(ctx(home));
    expect(summary).toBeDefined();
    const transcript = await claudeSessionsAdapter.readTranscript(ctx(home), summary!);
    expect(transcript?.truncated).toBe(false);
    expect(transcript?.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Hello"],
      ["assistant", "Hi there"],
    ]);

    await rm(join(slugDir, "s1.jsonl"));
    expect(await claudeSessionsAdapter.readTranscript(ctx(home), summary!)).toBeNull();
  });
});
