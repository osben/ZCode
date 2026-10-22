import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import { readModelTrajectory } from "../src/zcode-agent/modelTrajectory.js";
import { expandTrajectoryInputs } from "./helpers/modelTrajectoryInputs.js";

const TASK_ID = "sess_input_delta";
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

const system = (content: string): RawMessage => ({ role: "system", content });
const user = (content: string): RawMessage => ({ role: "user", content });
const assistant = (content: string): RawMessage => ({ role: "assistant", content });
const tool = (content: string): RawMessage => ({
  role: "tool",
  toolCallId: "call_1",
  toolName: "Read",
  content,
});

// Records are ordered by `order`, which also drives startedAt so the reader sorts them as written.
function modelIO(order: number, messages: RawMessage[], querySource = "main_turn") {
  return {
    type: "model_io",
    sessionId: TASK_ID,
    requestId: `r${order}`,
    startedAt: `2026-06-03T00:00:${String(order).padStart(2, "0")}.000Z`,
    querySource,
    request: { messages, toolNames: [] },
    response: { text: `reply ${order}`, toolCalls: [], finishReason: "stop" },
  };
}

async function readFixture(records: unknown[], limit?: number) {
  const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-model-trajectory-delta-"));
  tempDirs.push(dataBaseDir);
  const debugDir = join(dataBaseDir, ".zcode", "cli", "debug");
  mkdirSync(debugDir, { recursive: true });
  setDataBaseDir(dataBaseDir);
  writeFileSync(
    join(debugDir, `model-io-${TASK_ID}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  return readModelTrajectory(TASK_ID, limit);
}

describe("readModelTrajectory input deltas", () => {
  it("sends only the messages after an exact main-session prefix and references the base", async () => {
    const result = await readFixture([
      modelIO(1, [system("S"), user("U1")]),
      modelIO(2, [system("S"), user("U1"), assistant("A1"), tool("out")]),
    ]);

    const [first, second] = result.records;
    expect(first?.inputDeltaOf).toBeUndefined();
    expect(first?.request.messages).toHaveLength(2);
    expect(second?.inputDeltaOf).toEqual({ previousRequestId: "r1", sharedPrefixCount: 2 });
    expect(second?.request.messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(expandTrajectoryInputs(result.records)[1]?.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("keeps a record full when a prefix message has the same role but different content", async () => {
    // Same message count as the base, and the first message is identical: only the content of
    // the second message differs. A count-based or first-message-based check would wrongly send a delta.
    const result = await readFixture([
      modelIO(1, [system("S"), user("U1")]),
      modelIO(2, [system("S"), user("U1 edited"), tool("out")]),
    ]);

    const second = result.records[1];
    expect(second?.inputDeltaOf).toBeUndefined();
    expect(second?.request.messages).toHaveLength(3);
    expect(second?.request.messages[1]?.parts).toEqual([{ kind: "text", text: "U1 edited" }]);
  });

  it("keeps a record full when a prefix message differs only by role", async () => {
    const result = await readFixture([
      modelIO(1, [system("S"), user("U1")]),
      modelIO(2, [system("S"), assistant("U1"), tool("out")]),
    ]);

    expect(result.records[1]?.inputDeltaOf).toBeUndefined();
    expect(result.records[1]?.request.messages).toHaveLength(3);
  });

  it("makes the first main record of the kept window full and chains later records inside the window", async () => {
    const records = [
      modelIO(1, [system("S"), user("U1")]),
      modelIO(2, [system("S"), user("U1"), assistant("A1"), user("U2")]),
      modelIO(3, [
        system("S"),
        user("U1"),
        assistant("A1"),
        user("U2"),
        assistant("A2"),
        user("U3"),
      ]),
    ];

    const windowed = await readFixture(records, 2);
    expect(windowed.truncated).toBe(true);
    const [kept, latest] = windowed.records;
    expect(kept?.requestId).toBe("r2");
    expect(kept?.inputDeltaOf).toBeUndefined();
    expect(kept?.request.messages).toHaveLength(4);
    expect(latest?.inputDeltaOf).toEqual({ previousRequestId: "r2", sharedPrefixCount: 4 });
    expect(latest?.request.messages.map((message) => message.role)).toEqual(["assistant", "user"]);

    const full = await readFixture(records);
    expect(full.records[1]?.inputDeltaOf).toEqual({
      previousRequestId: "r1",
      sharedPrefixCount: 2,
    });
    expect(full.records[2]?.inputDeltaOf).toEqual({
      previousRequestId: "r2",
      sharedPrefixCount: 4,
    });
  });

  it("keeps sidecar, subagent and compact records full and uses the nearest preceding main record as base", async () => {
    const result = await readFixture([
      modelIO(1, [system("S"), user("U1")]),
      modelIO(2, [system("S"), user("U1"), assistant("A1"), user("U2")], "session_title"),
      modelIO(3, [system("S"), user("U1"), assistant("A1"), user("U2"), assistant("A2")]),
      modelIO(4, [system("S"), user("U1"), assistant("A1")], "subagent"),
      modelIO(5, [
        system("S"),
        user("U1"),
        assistant("A1"),
        user("U2"),
        assistant("A2"),
        user("U3"),
      ]),
      modelIO(6, [system("S"), user("compact summary")], "compact"),
    ]);

    const [, title, main, subagent, mainAgain, compact] = result.records;
    expect(title?.callSource?.kind).toBe("sidecar");
    expect(title?.inputDeltaOf).toBeUndefined();
    expect(title?.request.messages).toHaveLength(4);
    // Base is r1 (the nearest preceding main record), not the adjacent sidecar r2.
    expect(main?.inputDeltaOf).toEqual({ previousRequestId: "r1", sharedPrefixCount: 2 });
    expect(main?.request.messages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect(subagent?.callSource?.kind).toBe("subagent");
    expect(subagent?.inputDeltaOf).toBeUndefined();
    // Base is r3, the nearest preceding main record; subagent r4 is never a base.
    expect(mainAgain?.inputDeltaOf).toEqual({ previousRequestId: "r3", sharedPrefixCount: 5 });
    expect(compact?.callSource?.kind).toBe("compact");
    expect(compact?.inputDeltaOf).toBeUndefined();
  });

  it("does not use a main record with an empty requestId as a base", async () => {
    const result = await readFixture([
      { ...modelIO(1, [system("S"), user("U1")]), requestId: "" },
      modelIO(2, [system("S"), user("U1"), assistant("A1")]),
    ]);

    expect(result.records[1]?.inputDeltaOf).toBeUndefined();
    expect(result.records[1]?.request.messages).toHaveLength(3);
  });

  it("treats segments equal after bounding as the same prefix, and a head difference as a mismatch", async () => {
    // Both texts are larger than the 16 KiB segment budget. Head (12 KiB) and tail (4 091 bytes) are kept,
    // so the two texts differ only in the omitted middle and project identically.
    const head = "H".repeat(12 * 1024);
    const tailPart = "T".repeat(8 * 1024);
    const longWithMiddle = (middle: string) => `${head}${middle.repeat(20 * 1024)}${tailPart}`;

    const result = await readFixture([
      modelIO(1, [system("S"), user(longWithMiddle("x"))]),
      modelIO(2, [system("S"), user(longWithMiddle("y")), assistant("A1")]),
      modelIO(3, [system("S"), user(`G${longWithMiddle("y").slice(1)}`), assistant("A1")]),
    ]);

    const [, middleOnly, headChanged] = result.records;
    expect(middleOnly?.inputDeltaOf).toEqual({ previousRequestId: "r1", sharedPrefixCount: 2 });
    expect(middleOnly?.request.messages.map((message) => message.role)).toEqual(["assistant"]);
    expect(headChanged?.inputDeltaOf).toBeUndefined();
    expect(headChanged?.request.messages).toHaveLength(3);
    expect(headChanged?.request.messages[1]?.parts[0]).toMatchObject({
      kind: "text",
      truncated: { originalBytes: expect.any(Number), omittedBytes: expect.any(Number) },
    });
  });
});
