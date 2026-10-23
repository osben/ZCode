import { expect, it } from "vitest";
import type { ZCodeModelTrajectoryV2, ZCodeTrajectoryV2Record } from "./contract.js";
import { buildLedgerRows, filterRowsByRange } from "./index.js";

function record(
  requestId: string,
  startedAt: string,
  extra: Partial<ZCodeTrajectoryV2Record> = {},
): ZCodeTrajectoryV2Record {
  return {
    requestId,
    attempt: 1,
    startedAt,
    durationMs: 1000,
    turnId: "turn-1",
    callSource: { kind: "main", querySource: "main_turn" },
    model: { providerId: "p", modelId: "m" },
    request: {
      messages: [{ role: "user", parts: [{ kind: "text", text: "list files" }] }],
      toolNames: ["Bash"],
      params: {},
      cacheBreakpoints: [],
      cacheBreakpointsComplete: false,
    },
    response: {
      finishReason: "tool-calls",
      text: "Listing",
      toolCalls: [
        { kind: "tool-call", toolCallId: "call-1", toolName: "Bash", input: { command: "ls" } },
      ],
    },
    ...extra,
  };
}

function trajectory(records: ZCodeTrajectoryV2Record[]): ZCodeModelTrajectoryV2 {
  return {
    taskId: "task-1",
    available: true,
    truncated: false,
    sourceFiles: [],
    records,
    toolDefs: {},
    toolCatalogs: {},
    systemBlocks: {},
    systemPrompts: {},
    contextWindows: [],
    toolTiming: {
      source: "session-db",
      entries: [
        {
          toolCallId: "call-1",
          toolName: "Bash",
          status: "completed",
          scheduledAt: Date.parse("2026-10-22T10:00:01.000Z"),
          execStartedAt: Date.parse("2026-10-22T10:00:01.500Z"),
          execEndedAt: Date.parse("2026-10-22T10:00:02.000Z"),
          execDurationMs: 500,
        },
      ],
    },
    budget: { toolDefBytes: 0, systemBytes: 0, omitted: false },
  };
}

it("derives turn, request, user, assistant and tool rows with the joined tool result and timing", () => {
  const second = record("r2", "2026-10-22T10:00:03.000Z", {
    inputDeltaOf: { previousRequestId: "r1", sharedPrefixCount: 1 },
    request: {
      messages: [
        { role: "assistant", parts: [{ kind: "text", text: "Listing" }] },
        {
          role: "tool",
          parts: [{ kind: "tool-result", toolCallId: "call-1", toolName: "Bash", output: "a.ts" }],
        },
      ],
      toolNames: ["Bash"],
      params: {},
      cacheBreakpoints: [],
      cacheBreakpointsComplete: false,
    },
    response: { finishReason: "stop", text: "Done", toolCalls: [] },
  });
  const rows = buildLedgerRows(trajectory([record("r1", "2026-10-22T10:00:00.000Z"), second]));
  expect(rows.map((row) => row.kind)).toEqual([
    "turn",
    "request",
    "user",
    "assistant",
    "tool",
    "request",
    "assistant",
  ]);
  const assistants = rows.filter((row) => row.kind === "assistant");
  expect(assistants.map((row) => row.kind === "assistant" && row.toolCallCount)).toEqual([1, 0]);
  const tool = rows.find((row) => row.kind === "tool");
  expect(tool).toMatchObject({
    toolName: "Bash",
    result: { output: "a.ts", isError: false },
    t0: Date.parse("2026-10-22T10:00:01.500Z"),
  });
  const inRange = filterRowsByRange(rows, {
    from: Date.parse("2026-10-22T10:00:01.600Z"),
    to: Date.parse("2026-10-22T10:00:01.700Z"),
  });
  expect(inRange.map((row) => row.kind)).toEqual(["turn", "tool"]);
});
