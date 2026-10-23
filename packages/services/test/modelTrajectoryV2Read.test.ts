import { expect, it, vi } from "vitest";
import type { ZCodeTrajectoryV2Record } from "../src/model-trajectory-v2/contract.js";
import { projectModelTrajectoryV2 } from "../src/model-trajectory-v2/index.js";
import {
  mapModelTrajectoryRecord,
  projectModelTrajectoryInputDeltas,
} from "../src/zcode-agent/modelTrajectory.js";

const TASK_ID = "task_v2_read";
const STARTED_AT = "2026-10-22T10:00:00.000Z";

interface RawRecordInput {
  requestId: string;
  messages: unknown[];
  model?: { providerId?: string; modelId?: string };
  body?: Record<string, unknown>;
  response?: Record<string, unknown>;
  timing?: unknown;
  querySource?: string;
}

function rawRecord(input: RawRecordInput): Record<string, unknown> {
  return {
    type: "model_io",
    sessionId: TASK_ID,
    requestId: input.requestId,
    attempt: 1,
    querySource: input.querySource ?? "main_turn",
    startedAt: STARTED_AT,
    durationMs: 1500,
    model: input.model ?? { providerId: "anthropic", modelId: "claude-sonnet-5-5" },
    request: {
      messages: input.messages,
      toolNames: ["Bash"],
      ...(input.body ? { body: input.body } : {}),
    },
    ...(input.response ? { response: input.response } : {}),
    ...(input.timing !== undefined ? { timing: input.timing } : {}),
  };
}

const BODY = {
  max_tokens: 1000,
  thinking: { type: "enabled", budget_tokens: 512 },
  output_config: { effort: "high" },
  tool_choice: { type: "tool", name: "Bash" },
  temperature: 0.2,
  stream: true,
  system: [
    {
      type: "text",
      text: "You are a coding agent.",
      cache_control: { type: "ephemeral", ttl: "5m" },
    },
  ],
  tools: [
    { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
    { name: "Read", description: "Read a file", input_schema: { type: "object" } },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
  ],
};

const RESPONSE = {
  finishReason: "stop",
  text: "hello",
  toolCalls: [],
  usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 7 },
};

const unavailableTiming = {
  source: "unavailable" as const,
  reason: "db-path-unknown" as const,
  entries: [],
};

function ports(
  records: Record<string, unknown>[],
  readToolTiming = vi.fn(async () => unavailableTiming),
) {
  return {
    modelIo: {
      read: vi.fn(async () => ({
        records,
        sourceFiles: ["/tmp/model-io.jsonl"],
        truncated: false,
      })),
    },
    toolTiming: { read: readToolTiming },
    contextWindow: undefined,
  };
}

/** The v2 record minus the fields projectModelTrajectoryV2 adds, i.e. the v1 projection. */
function v1View(record: ZCodeTrajectoryV2Record) {
  const { timing: _timing, ...rest } = record;
  const {
    params: _params,
    cacheBreakpoints: _cacheBreakpoints,
    cacheBreakpointsComplete: _complete,
    toolCatalogId: _toolCatalogId,
    systemPromptId: _systemPromptId,
    ...request
  } = record.request;
  const next = { ...rest, request };
  if (record.response?.usage && "cacheWriteTokens" in record.response.usage) {
    const { cacheWriteTokens: _cacheWriteTokens, ...usage } = record.response.usage;
    next.response = { ...record.response, usage };
  }
  return next;
}

it("projects the v1 records unchanged and enriches them with wire facts", async () => {
  const records = [
    rawRecord({
      requestId: "r1",
      messages: [{ role: "user", content: "hi" }],
      body: BODY,
      response: RESPONSE,
      timing: {
        stream: true,
        timeToFirstProviderEventMs: 120,
        timeToFirstContentMs: 300,
        timeToFirstTextMs: -5,
      },
    }),
    // Second main call whose full input extends r1's, so it must project to an input delta.
    rawRecord({
      requestId: "r2",
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: "do it" },
      ],
      body: { ...BODY, tool_choice: "auto" },
      response: { ...RESPONSE, text: "done" },
    }),
  ];
  const expectedV1 = projectModelTrajectoryInputDeltas(records.map(mapModelTrajectoryRecord));
  expect(expectedV1[1]?.inputDeltaOf).toEqual({ previousRequestId: "r1", sharedPrefixCount: 1 });

  const result = await projectModelTrajectoryV2(TASK_ID, 200, ports(records));

  expect(result.taskId).toBe(TASK_ID);
  expect(result.available).toBe(true);
  expect(result.truncated).toBe(false);
  expect(result.sourceFiles).toEqual(["/tmp/model-io.jsonl"]);
  expect(result.toolTiming).toEqual(unavailableTiming);
  expect(v1View(result.records[0] as ZCodeTrajectoryV2Record)).toEqual(expectedV1[0]);
  expect(v1View(result.records[1] as ZCodeTrajectoryV2Record)).toEqual(expectedV1[1]);

  const first = result.records[0];
  expect(first?.request.params).toEqual({
    maxOutputTokens: 1000,
    thinking: { type: "enabled", budgetTokens: 512 },
    effort: "high",
    toolChoice: "tool:Bash",
    temperature: 0.2,
    stream: true,
  });
  expect(first?.request.cacheBreakpoints).toEqual([
    { location: "system", index: 0, ttl: "5m" },
    { location: "message", index: 0 },
  ]);
  expect(first?.request.cacheBreakpointsComplete).toBe(true);
  expect(first?.request.toolCatalogId).toBe("tc:0");
  expect(first?.request.systemPromptId).toBe("sp:0");
  expect(first?.response?.usage?.cacheWriteTokens).toBe(7);
  expect(first?.timing).toEqual({
    stream: true,
    timeToFirstProviderEventMs: 120,
    timeToFirstContentMs: 300,
  });
  // The second call reuses the identical catalog and system prompt.
  expect(result.records[1]?.request.toolCatalogId).toBe("tc:0");
  expect(result.records[1]?.request.systemPromptId).toBe("sp:0");
  expect(Object.keys(result.toolDefs)).toEqual(["td:0", "td:1"]);
  expect(Object.keys(result.systemBlocks)).toEqual(["sb:0"]);
});

it("keeps a legacy record usable without body, timing or cache-write usage", async () => {
  const records = [
    rawRecord({
      requestId: "legacy-1",
      messages: [{ role: "user", content: "hi" }],
      response: {
        finishReason: "stop",
        text: "hello",
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    }),
  ];
  const result = await projectModelTrajectoryV2(TASK_ID, 200, ports(records));
  const record = result.records[0];
  expect(record).toBeDefined();
  expect(record?.request.params).toEqual({});
  expect(record?.request.cacheBreakpoints).toEqual([]);
  expect(record?.request.cacheBreakpointsComplete).toBe(false);
  expect("toolCatalogId" in (record?.request ?? {})).toBe(false);
  expect("systemPromptId" in (record?.request ?? {})).toBe(false);
  expect("timing" in (record ?? {})).toBe(false);
  expect("cacheWriteTokens" in (record?.response?.usage ?? {})).toBe(false);
  expect(result.toolDefs).toEqual({});
  expect(result.systemPrompts).toEqual({});
});

it("collects tool call ids from responses and from input-history tool-call parts", async () => {
  const records = [
    rawRecord({
      requestId: "r1",
      messages: [{ role: "user", content: "list files" }],
      response: {
        finishReason: "tool-calls",
        text: "",
        toolCalls: [{ id: "call-1", name: "Bash", input: { command: "ls" } }],
      },
    }),
    rawRecord({
      requestId: "r2",
      // Assistant history keeps tool calls in a top-level `toolCalls` array, not in content.
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-2", name: "Read", input: { path: "/tmp" } }],
        },
        { role: "tool", content: "result", toolCallId: "call-2", toolName: "Read" },
      ],
      response: { finishReason: "stop", text: "done" },
    }),
  ];
  const readToolTiming = vi.fn(async () => unavailableTiming);
  await projectModelTrajectoryV2(TASK_ID, 200, ports(records, readToolTiming));
  expect(readToolTiming).toHaveBeenCalledTimes(1);
  expect(readToolTiming).toHaveBeenCalledWith(TASK_ID, ["call-1", "call-2"]);
});

it("resolves the context window once per provider and model", async () => {
  const records = [
    rawRecord({ requestId: "r1", messages: [], model: { providerId: "p", modelId: "m1" } }),
    rawRecord({ requestId: "r2", messages: [], model: { providerId: "p", modelId: "m1" } }),
    rawRecord({ requestId: "r3", messages: [], model: { providerId: "p", modelId: "m2" } }),
    rawRecord({ requestId: "r4", messages: [], model: { providerId: "q", modelId: "m3" } }),
    // Records without a model id never reach the resolver.
    rawRecord({ requestId: "r5", messages: [], model: { providerId: "p" } }),
  ];
  const resolve = vi.fn(async ({ modelId }: { providerId: string; modelId: string }) => {
    if (modelId === "m3") throw new Error("registry down");
    return modelId === "m1" ? 200_000 : undefined;
  });
  const base = ports(records);
  const result = await projectModelTrajectoryV2(TASK_ID, 200, { ...base, contextWindow: resolve });
  expect(result.contextWindows).toEqual([
    { providerId: "p", modelId: "m1", tokens: 200_000 },
    { providerId: "p", modelId: "m2" },
    { providerId: "q", modelId: "m3" },
  ]);
  expect(resolve).toHaveBeenCalledTimes(3);
});
