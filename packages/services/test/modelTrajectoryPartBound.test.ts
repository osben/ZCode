import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import { readModelTrajectory } from "../src/zcode-agent/modelTrajectory.js";

// Mirrors the host budget in modelTrajectory.ts (12 KiB head + 4 KiB tail, separator "\n…\n").
const KEPT_BYTES = 12 * 1024 + 4 * 1024;
const SEPARATOR = "\n…\n";

const tempDirs: string[] = [];

afterEach(() => {
  setDataBaseDir(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function writeSession(sessionId: string, records: Record<string, unknown>[]) {
  const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-model-trajectory-bound-"));
  tempDirs.push(dataBaseDir);
  const debugDir = join(dataBaseDir, ".zcode", "cli", "debug");
  mkdirSync(debugDir, { recursive: true });
  setDataBaseDir(dataBaseDir);
  writeFileSync(
    join(debugDir, `model-io-${sessionId}.jsonl`),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8",
  );
}

function modelIO(
  sessionId: string,
  requestId: string,
  startedAt: string,
  request: object,
  extra = {},
) {
  return { type: "model_io", sessionId, requestId, startedAt, request, ...extra };
}

function userText(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("readModelTrajectory per-segment byte budget", () => {
  it("cuts a text segment over the budget into head and tail with an originalBytes marker", async () => {
    const sessionId = "sess_bound_text";
    const text = `START${"x".repeat(30_000)}END`;
    writeSession(sessionId, [
      modelIO(sessionId, "req_1", "2026-06-03T00:00:00.000Z", { messages: [userText(text)] }),
    ]);

    const part = (await readModelTrajectory(sessionId)).records[0]?.request.messages[0]?.parts[0];

    const originalBytes = Buffer.byteLength(text, "utf8");
    expect(part).toMatchObject({
      kind: "text",
      truncated: { originalBytes, omittedBytes: originalBytes - KEPT_BYTES },
    });
    if (part?.kind !== "text") throw new Error("expected a text part");
    expect(part.text.startsWith("START")).toBe(true);
    expect(part.text.endsWith("END")).toBe(true);
    expect(part.text.includes(SEPARATOR)).toBe(true);
    expect(Buffer.byteLength(part.text, "utf8")).toBe(KEPT_BYTES + Buffer.byteLength(SEPARATOR));
  });

  it("leaves a segment exactly at the budget untouched and without a marker", async () => {
    const sessionId = "sess_bound_exact";
    const text = "a".repeat(KEPT_BYTES);
    writeSession(sessionId, [
      modelIO(sessionId, "req_1", "2026-06-03T00:00:00.000Z", { messages: [userText(text)] }),
    ]);

    const part = (await readModelTrajectory(sessionId)).records[0]?.request.messages[0]?.parts[0];

    expect(part).toEqual({ kind: "text", text });
    expect(part).not.toHaveProperty("truncated");
  });

  it("never splits a multi-byte character at the cut", async () => {
    const sessionId = "sess_bound_utf8";
    // The leading ASCII byte misaligns every 3-byte character against the 12 KiB head boundary.
    const text = `a${"中".repeat(10_000)}`;
    writeSession(sessionId, [
      modelIO(sessionId, "req_1", "2026-06-03T00:00:00.000Z", { messages: [userText(text)] }),
    ]);

    const part = (await readModelTrajectory(sessionId)).records[0]?.request.messages[0]?.parts[0];

    if (part?.kind !== "text") throw new Error("expected a text part");
    expect(part.text.includes("�")).toBe(false);
    const [head, tail] = part.text.split(SEPARATOR);
    expect(head?.startsWith("a")).toBe(true);
    expect(/^中+$/u.test((head ?? "").slice(1))).toBe(true);
    expect(/^中+$/u.test(tail ?? "")).toBe(true);
    const keptBytes = Buffer.byteLength(head ?? "") + Buffer.byteLength(tail ?? "");
    expect(part.truncated).toEqual({
      originalBytes: Buffer.byteLength(text, "utf8"),
      omittedBytes: Buffer.byteLength(text, "utf8") - keptBytes,
    });
  });

  it("keeps a string TOOL output over the budget as a string instead of parsing a cut JSON", async () => {
    const sessionId = "sess_bound_tool_string";
    const content = JSON.stringify({ data: "y".repeat(20_000) });
    writeSession(sessionId, [
      modelIO(sessionId, "req_1", "2026-06-03T00:00:00.000Z", {
        messages: [{ role: "tool", toolCallId: "call_1", toolName: "Read", content }],
      }),
    ]);

    const part = (await readModelTrajectory(sessionId)).records[0]?.request.messages[0]?.parts[0];

    expect(part).toMatchObject({
      kind: "tool-result",
      toolCallId: "call_1",
      toolName: "Read",
      truncated: { originalBytes: Buffer.byteLength(content, "utf8") },
    });
    if (part?.kind !== "tool-result") throw new Error("expected a tool-result part");
    expect(typeof part.output).toBe("string");
    expect(String(part.output).startsWith('{"data":"')).toBe(true);
  });

  it("keeps the error-text type of an oversized TOOL error while cutting its value", async () => {
    const sessionId = "sess_bound_tool_error";
    const content = "E".repeat(20_000);
    writeSession(sessionId, [
      modelIO(sessionId, "req_1", "2026-06-03T00:00:00.000Z", {
        messages: [
          { role: "tool", toolCallId: "call_e", toolName: "Bash", content, isError: true },
        ],
      }),
    ]);

    const part = (await readModelTrajectory(sessionId)).records[0]?.request.messages[0]?.parts[0];

    expect(part).toMatchObject({
      kind: "tool-result",
      output: { type: "error-text" },
      truncated: { originalBytes: 20_000 },
    });
    if (part?.kind !== "tool-result") throw new Error("expected a tool-result part");
    const value = (part.output as { value: string }).value;
    expect(value.startsWith("EEEE")).toBe(true);
    expect(value.length).toBeLessThan(content.length);
  });

  it("serializes an oversized object tool-call input into a bounded JSON string", async () => {
    const sessionId = "sess_bound_call_input";
    writeSession(sessionId, [
      modelIO(sessionId, "req_1", "2026-06-03T00:00:00.000Z", {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call_big",
                toolName: "Write",
                input: { blob: "z".repeat(20_000) },
              },
            ],
          },
        ],
      }),
    ]);

    const part = (await readModelTrajectory(sessionId)).records[0]?.request.messages[0]?.parts[0];

    expect(part).toMatchObject({ kind: "tool-call", toolName: "Write", truncated: {} });
    if (part?.kind !== "tool-call") throw new Error("expected a tool-call part");
    expect(typeof part.input).toBe("string");
    expect(String(part.input).startsWith('{"blob":"')).toBe(true);
  });

  it("bounds response text and reasoning text with response-level markers", async () => {
    const sessionId = "sess_bound_response";
    const text = "t".repeat(20_000);
    writeSession(sessionId, [
      modelIO(
        sessionId,
        "req_1",
        "2026-06-03T00:00:00.000Z",
        { messages: [userText("hi")] },
        {
          response: { finishReason: "stop", text, reasoningText: "short thought", toolCalls: [] },
        },
      ),
    ]);

    const response = (await readModelTrajectory(sessionId)).records[0]?.response;

    expect(response?.text?.length ?? 0).toBeLessThan(text.length);
    expect(response?.truncated).toEqual({
      text: { originalBytes: 20_000, omittedBytes: 20_000 - KEPT_BYTES },
    });
    expect(response?.reasoningText).toBe("short thought");
  });

  it("bounds every returned record when the limit keeps only the latest calls", async () => {
    const sessionId = "sess_bound_limit";
    const big = "L".repeat(40_000);
    writeSession(
      sessionId,
      [1, 2, 3].map((n) =>
        modelIO(sessionId, `req_${n}`, `2026-06-03T00:00:0${n}.000Z`, {
          messages: [userText(big)],
        }),
      ),
    );

    const result = await readModelTrajectory(sessionId, 2);

    expect(result.truncated).toBe(true);
    expect(result.records.map((record) => record.requestId)).toEqual(["req_2", "req_3"]);
    for (const record of result.records) {
      const part = record.request.messages[0]?.parts[0];
      expect(part).toHaveProperty("truncated.originalBytes", 40_000);
      if (part?.kind !== "text") throw new Error("expected a text part");
      expect(Buffer.byteLength(part.text, "utf8")).toBe(KEPT_BYTES + Buffer.byteLength(SEPARATOR));
    }
  });
});
