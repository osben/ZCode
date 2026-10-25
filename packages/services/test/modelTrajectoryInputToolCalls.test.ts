import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import { readModelTrajectory } from "../src/zcode-agent/modelTrajectory.js";
import { expandTrajectoryInputs } from "./helpers/modelTrajectoryInputs.js";

const TASK_ID = "sess_input_tool_calls";
const tempDirs: string[] = [];

afterEach(() => {
  setDataBaseDir(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

type RawMessage = Record<string, unknown>;

const system: RawMessage = { role: "system", content: "S" };
const user: RawMessage = { role: "user", content: "U1" };
// Shape written by the runtime: tool calls live in a top-level `toolCalls` array, not in content.
const assistantWithCalls: RawMessage = {
  role: "assistant",
  content: [
    { type: "reasoning", text: "need to read the file" },
    { type: "text", text: "Reading it." },
  ],
  toolCalls: [{ id: "call_read", name: "Read", input: { path: "a.ts" } }],
  providerId: "zai",
  modelId: "glm",
};
const toolResult: RawMessage = {
  role: "tool",
  content: "file body",
  toolCallId: "call_read",
  toolName: "Read",
};

function modelIO(order: number, messages: RawMessage[]) {
  return {
    type: "model_io",
    sessionId: TASK_ID,
    requestId: `r${order}`,
    startedAt: `2026-06-03T00:00:${String(order).padStart(2, "0")}.000Z`,
    querySource: "main_turn",
    request: { messages, toolNames: [] },
    response: { text: `reply ${order}`, toolCalls: [], finishReason: "stop" },
  };
}

async function readFixture(records: unknown[]) {
  const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-model-trajectory-tool-calls-"));
  tempDirs.push(dataBaseDir);
  const debugDir = join(dataBaseDir, ".zcode", "cli", "debug");
  mkdirSync(debugDir, { recursive: true });
  setDataBaseDir(dataBaseDir);
  writeFileSync(
    join(debugDir, `model-io-${TASK_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  return readModelTrajectory(TASK_ID);
}

describe("readModelTrajectory assistant input tool calls", () => {
  it("projects top-level toolCalls as tool-call parts after content and pairs the tool result", async () => {
    const result = await readFixture([modelIO(1, [system, user, assistantWithCalls, toolResult])]);

    const messages = result.records[0]?.request.messages ?? [];
    expect(messages[2]?.parts).toEqual([
      { kind: "reasoning", text: "need to read the file" },
      { kind: "text", text: "Reading it." },
      { kind: "tool-call", toolCallId: "call_read", toolName: "Read", input: { path: "a.ts" } },
    ]);
    const resultPart = messages[3]?.parts[0];
    expect(resultPart?.kind).toBe("tool-result");
    expect(resultPart && "toolCallId" in resultPart ? resultPart.toolCallId : undefined).toBe(
      "call_read",
    );
  });

  it("appends tool calls after string content", async () => {
    const result = await readFixture([
      modelIO(1, [
        user,
        {
          role: "assistant",
          content: "Checking.",
          toolCalls: [
            { id: "call_1", name: "Grep", input: { pattern: "x" } },
            { id: "call_2", name: "Read", input: { path: "b.ts" } },
          ],
        },
      ]),
    ]);

    const parts = result.records[0]?.request.messages[1]?.parts ?? [];
    expect(parts.map((part) => part.kind)).toEqual(["text", "tool-call", "tool-call"]);
    expect(parts.map((part) => ("toolCallId" in part ? part.toolCallId : undefined))).toEqual([
      undefined,
      "call_1",
      "call_2",
    ]);
  });

  it("bounds a large tool-call input like a response tool call", async () => {
    const result = await readFixture([
      modelIO(1, [
        user,
        {
          role: "assistant",
          content: [],
          toolCalls: [
            {
              id: "call_big",
              name: "Write",
              input: { file_path: "c.ts", body: "x".repeat(40_000) },
            },
          ],
        },
      ]),
    ]);

    const part = result.records[0]?.request.messages[1]?.parts[0];
    expect(part?.kind).toBe("tool-call");
    expect(part?.truncated?.originalBytes).toBeGreaterThan(40_000);
  });

  it("ignores toolCalls on non-assistant messages", async () => {
    const result = await readFixture([
      modelIO(1, [
        { role: "user", content: "U", toolCalls: [{ id: "c", name: "Read", input: {} }] },
      ]),
    ]);

    expect(result.records[0]?.request.messages[0]?.parts.map((part) => part.kind)).toEqual([
      "text",
    ]);
  });

  it("keeps a call whose input adds an assistant tool call and its result a delta", async () => {
    const fullInput = [system, user, assistantWithCalls, toolResult];
    const result = await readFixture([modelIO(1, [system, user]), modelIO(2, fullInput)]);

    const second = result.records[1];
    expect(second?.inputDeltaOf).toEqual({ previousRequestId: "r1", sharedPrefixCount: 2 });
    expect(second?.request.messages.map((message) => message.role)).toEqual(["assistant", "tool"]);

    const standalone = await readFixture([modelIO(2, fullInput)]);
    expect(expandTrajectoryInputs(result.records)[1]).toEqual(
      standalone.records[0]?.request.messages,
    );
  });
});
