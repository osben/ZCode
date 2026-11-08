import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExternalSessionsService } from "../src/external-sessions/service.js";
import type { ExternalSessionSourceAdapter } from "../src/external-sessions/adapters/types.js";
import {
  EXTERNAL_SESSION_NOT_FOUND,
  EXTERNAL_SESSION_TRANSCRIPT_UNAVAILABLE,
  buildExternalSessionResumeCommand,
  isSafeExternalSessionId,
  quoteShellArgument,
  type ExternalSessionSummary,
} from "../src/external-sessions/contract.js";
import { buildResumeCommandLine } from "../src/external-sessions/terminal.js";

// specs/external-sessions.md "Contract" (cache, per-source isolation, filters) and "Terminal resume".

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function summary(
  partial: Partial<ExternalSessionSummary> & Pick<ExternalSessionSummary, "source" | "sessionId">,
): ExternalSessionSummary {
  return {
    key: `${partial.source}:${partial.sessionId}`,
    workspacePath: "/tmp/ws",
    workspaceMissing: true,
    title: `title ${partial.sessionId}`,
    createdAt: 1,
    updatedAt: 1,
    sourcePath: "/tmp/src",
    transcriptAvailable: true,
    resumeCommand: buildExternalSessionResumeCommand(partial.source, partial.sessionId),
    ...partial,
  };
}

function adapter(
  source: ExternalSessionSourceAdapter["source"],
  list: ExternalSessionSourceAdapter["list"],
  readTranscript: ExternalSessionSourceAdapter["readTranscript"] = async () => ({
    messages: [{ role: "user", text: "hi" }],
    truncated: false,
  }),
): ExternalSessionSourceAdapter {
  return { source, list, readTranscript };
}

describe("createExternalSessionsService", () => {
  it("merges sources sorted by updatedAt, isolates a failing source and applies workspace/search/limit", async () => {
    const claude = adapter("claude", async () => [
      summary({ source: "claude", sessionId: "a", updatedAt: 10, workspacePath: "/tmp/ws" }),
      summary({
        source: "claude",
        sessionId: "b",
        updatedAt: 30,
        workspacePath: "/tmp/other",
        title: "needle",
      }),
    ]);
    const codex = adapter("codex", async () => {
      throw new Error("db locked");
    });
    const opencode = adapter("opencode", async () => [
      summary({ source: "opencode", sessionId: "c", updatedAt: 20, workspacePath: "/tmp/ws/" }),
    ]);
    const service = createExternalSessionsService({
      adapters: [claude, codex, opencode],
      homeDir: "/tmp",
    });

    const all = await service.listExternalSessions({});
    expect(all.sessions.map((item) => item.key)).toEqual(["claude:b", "opencode:c", "claude:a"]);
    expect(all.sources.codex).toEqual({ available: false, count: 0, reason: "db locked" });
    expect(all.sources.claude).toEqual({ available: true, count: 2 });
    expect(all.sources.cursor.available).toBe(false);

    const scoped = await service.listExternalSessions({ workspacePath: "/tmp/ws" });
    expect(scoped.sessions.map((item) => item.key)).toEqual(["opencode:c", "claude:a"]);

    const searched = await service.listExternalSessions({ search: "NEEDLE" });
    expect(searched.sessions.map((item) => item.key)).toEqual(["claude:b"]);

    const limited = await service.listExternalSessions({ limit: 1, sources: ["claude"] });
    expect(limited.sessions.map((item) => item.key)).toEqual(["claude:b"]);
  });

  it("serves repeated lists from the cache until the TTL passes or refresh is requested", async () => {
    let clock = 1_000;
    const list = vi.fn(async () => [summary({ source: "gemini", sessionId: "g" })]);
    const service = createExternalSessionsService({
      adapters: [adapter("gemini", list)],
      homeDir: "/tmp",
      now: () => clock,
      cacheTtlMs: 100,
    });
    await service.listExternalSessions({});
    await service.listExternalSessions({ search: "x" });
    expect(list).toHaveBeenCalledTimes(1);
    clock += 101;
    await service.listExternalSessions({});
    expect(list).toHaveBeenCalledTimes(2);
    await service.listExternalSessions({ refresh: true });
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("rejects unknown params and sources", async () => {
    const service = createExternalSessionsService({ adapters: [], homeDir: "/tmp" });
    await expect(service.listExternalSessions({ sources: ["nope" as never] })).rejects.toThrow();
    await expect(service.listExternalSessions({ limit: 10_000 })).rejects.toThrow();
  });

  it("reads a transcript, rescans once for an unknown id and reports unavailable transcripts", async () => {
    const list = vi.fn(async () => [
      summary({ source: "cursor", sessionId: "c1", transcriptAvailable: false }),
      summary({ source: "cursor", sessionId: "c2" }),
    ]);
    const service = createExternalSessionsService({
      adapters: [adapter("cursor", list)],
      homeDir: "/tmp",
    });
    const transcript = await service.readExternalSessionTranscript({
      source: "cursor",
      sessionId: "c2",
    });
    expect(transcript.summary.key).toBe("cursor:c2");
    expect(transcript.messages).toHaveLength(1);
    await expect(
      service.readExternalSessionTranscript({ source: "cursor", sessionId: "c1" }),
    ).rejects.toThrow(EXTERNAL_SESSION_TRANSCRIPT_UNAVAILABLE);
    await expect(
      service.readExternalSessionTranscript({ source: "cursor", sessionId: "missing" }),
    ).rejects.toThrow(EXTERNAL_SESSION_NOT_FOUND);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("opens the terminal with cd into the existing cwd and falls back to the home dir when it is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-ext-svc-"));
    tempDirs.push(home);
    const openTerminal = vi.fn(async () => ({ opened: true }));
    const service = createExternalSessionsService({
      adapters: [
        adapter("claude", async () => [
          summary({
            source: "claude",
            sessionId: "s1",
            workspacePath: home,
            workspaceMissing: false,
          }),
          summary({ source: "claude", sessionId: "s2", workspacePath: join(home, "gone") }),
        ]),
      ],
      homeDir: home,
      openTerminal,
      platform: "darwin",
    });
    const opened = await service.openExternalSessionInTerminal({
      source: "claude",
      sessionId: "s1",
    });
    expect(opened).toEqual({
      opened: true,
      command: `cd ${quoteShellArgument(home)} && claude --resume s1`,
    });
    const fallback = await service.openExternalSessionInTerminal({
      source: "claude",
      sessionId: "s2",
    });
    expect(fallback.command).toBe(`cd ${quoteShellArgument(home)} && claude --resume s2`);
    expect(openTerminal).toHaveBeenCalledTimes(2);

    const linux = createExternalSessionsService({
      adapters: [
        adapter("claude", async () => [
          summary({
            source: "claude",
            sessionId: "s1",
            workspacePath: home,
            workspaceMissing: false,
          }),
        ]),
      ],
      homeDir: home,
      openTerminal,
      platform: "linux",
    });
    const result = await linux.openExternalSessionInTerminal({ source: "claude", sessionId: "s1" });
    expect(result.opened).toBe(false);
    expect(result.command).toContain("claude --resume s1");
    expect(openTerminal).toHaveBeenCalledTimes(2);
  });
});

describe("resume command helpers", () => {
  it("accepts only shell-safe ids and quotes the cwd", () => {
    expect(isSafeExternalSessionId("01a1958e-a343-7e73-8da8-e600646c6e52")).toBe(true);
    expect(isSafeExternalSessionId("a b")).toBe(false);
    expect(isSafeExternalSessionId("$(rm -rf /)")).toBe(false);
    expect(buildExternalSessionResumeCommand("codex", "x;y")).toBe("");
    expect(buildExternalSessionResumeCommand("opencode", "abc")).toBe("opencode --session abc");
    expect(quoteShellArgument("/Users/me/My Repo")).toBe("'/Users/me/My Repo'");
    expect(quoteShellArgument("/Users/me/it's")).toBe("'/Users/me/it'\\''s'");
    expect(buildResumeCommandLine({ cwd: "/a b", resumeCommand: "claude --resume s" })).toBe(
      "cd '/a b' && claude --resume s",
    );
    expect(() =>
      buildResumeCommandLine({ cwd: "/a\nb", resumeCommand: "claude --resume s" }),
    ).toThrow();
    expect(() => buildResumeCommandLine({ cwd: "/a", resumeCommand: "" })).toThrow();
  });
});
