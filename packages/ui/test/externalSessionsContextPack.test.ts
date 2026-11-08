import { describe, expect, it } from "vitest";
import { buildExternalSessionContextPack } from "../src/external-sessions/contextPack.js";
import type { ExternalSessionTranscript } from "../src/external-sessions/contract.js";

// specs/external-sessions.md "Continue in ZCode".

function transcript(count: number): ExternalSessionTranscript {
  return {
    summary: {
      source: "codex",
      sessionId: "abc",
      key: "codex:abc",
      workspacePath: "/repo",
      workspaceMissing: false,
      title: "Fix build",
      createdAt: 1,
      updatedAt: 2,
      sourcePath: "/x",
      transcriptAvailable: true,
      resumeCommand: "codex resume abc",
    },
    messages: Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `message ${index}`,
    })),
    truncated: false,
  };
}

describe("buildExternalSessionContextPack", () => {
  it("keeps only the newest messages and names the source, title and path", () => {
    const pack = buildExternalSessionContextPack(transcript(20), { messages: 3 });
    expect(pack.startsWith('Continue the work from a Codex session "Fix build" (/repo).')).toBe(
      true,
    );
    expect(pack).toContain("last 3 of 20 messages");
    expect(pack).not.toContain("message 16");
    expect(pack).toContain("**Assistant:** message 17");
    expect(pack).toContain("**User:** message 18");
    expect(pack).toContain("**Assistant:** message 19");
    expect(pack.trimEnd().endsWith("Continue from here.")).toBe(true);
  });

  it("trims long messages and skips empty ones", () => {
    const long = transcript(2);
    long.messages[0]!.text = "x".repeat(50);
    long.messages[1]!.text = "   ";
    const pack = buildExternalSessionContextPack(long, { charsPerMessage: 10 });
    expect(pack).toContain(`**User:** ${"x".repeat(9)}…`);
    expect(pack).not.toContain("**Assistant:**");
    expect(pack).toContain("Previous conversation (trimmed):");
  });
});
