import { expect, it, vi } from "vitest";
import type { ModelTrajectoryV2Ports } from "./contract.js";
import { projectModelTrajectoryV2 } from "./index.js";

const tools = [
  { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
  {
    name: "Read",
    description: "Read a file",
    input_schema: { type: "object" },
    cache_control: { type: "ephemeral" },
  },
];

function rawRecord(requestId: string, startedAt: string, toolCallId?: string) {
  return {
    type: "model_io",
    sessionId: "task-1",
    requestId,
    attempt: 1,
    querySource: "main_turn",
    startedAt,
    durationMs: 1000,
    model: { providerId: "p", modelId: "m" },
    timing: { stream: true, timeToFirstContentMs: 300 },
    request: {
      messages: [{ role: "user", content: "hi" }],
      body: {
        max_tokens: 1000,
        thinking: { type: "enabled" },
        output_config: { effort: "high" },
        tool_choice: { type: "auto" },
        system: [
          { type: "text", text: "You are a coding agent", cache_control: { type: "ephemeral" } },
        ],
        tools,
        messages: [],
      },
    },
    response: {
      finishReason: toolCallId ? "tool-calls" : "stop",
      toolCalls: toolCallId ? [{ id: toolCallId, name: "Bash", input: { command: "ls" } }] : [],
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 5 },
    },
  };
}

it("enriches v1 records, interns the shared catalog once and joins tool timing and context windows", async () => {
  const readToolTiming = vi.fn(async () => ({
    source: "session-db" as const,
    entries: [
      { toolCallId: "call-1", toolName: "Bash", status: "completed" as const, scheduledAt: 1 },
    ],
  }));
  const ports: ModelTrajectoryV2Ports = {
    modelIo: {
      read: async () => ({
        records: [
          rawRecord("r1", "2026-10-22T10:00:00.000Z", "call-1"),
          rawRecord("r2", "2026-10-22T10:00:05.000Z"),
        ],
        sourceFiles: ["/tmp/model-io-task-1.jsonl"],
        truncated: false,
      }),
    },
    toolTiming: { read: readToolTiming },
    contextWindow: async () => 200_000,
  };

  const result = await projectModelTrajectoryV2("task-1", 200, ports);

  expect(result.records).toHaveLength(2);
  const [first, second] = result.records;
  expect(first?.request.params).toEqual({
    maxOutputTokens: 1000,
    thinking: { type: "enabled" },
    effort: "high",
    toolChoice: "auto",
  });
  expect(first?.request.cacheBreakpoints).toEqual([
    { location: "system", index: 0 },
    { location: "tools", index: 1 },
  ]);
  expect(first?.timing).toEqual({ stream: true, timeToFirstContentMs: 300 });
  expect(first?.response?.usage?.cacheWriteTokens).toBe(5);
  expect(first?.request.toolCatalogId).toBe(second?.request.toolCatalogId);
  expect(Object.keys(result.toolDefs)).toHaveLength(2);
  expect(Object.keys(result.systemBlocks)).toHaveLength(1);
  expect(readToolTiming).toHaveBeenCalledWith("task-1", ["call-1"]);
  expect(result.contextWindows).toEqual([{ providerId: "p", modelId: "m", tokens: 200_000 }]);
  expect(result.budget.omitted).toBe(false);
});

it("treats a throwing context window resolver as unknown", async () => {
  const result = await projectModelTrajectoryV2("task-1", 200, {
    modelIo: {
      read: async () => ({
        records: [rawRecord("r1", "2026-10-22T10:00:00.000Z")],
        sourceFiles: [],
        truncated: false,
      }),
    },
    toolTiming: {
      read: async () => ({ source: "unavailable", reason: "db-missing", entries: [] }),
    },
    contextWindow: async () => {
      throw new Error("registry offline");
    },
  });
  expect(result.contextWindows).toEqual([{ providerId: "p", modelId: "m" }]);
  expect(result.toolTiming).toEqual({ source: "unavailable", reason: "db-missing", entries: [] });
});
