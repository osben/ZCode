import type {
  ZCodeTrajectoryV2Record,
  ZCodeTrajectoryV2ToolTiming,
} from "@/model-trajectory-v2/contract.js";
import {
  contextSeries,
  summarizeTrajectory,
  toolTimeByName,
  unionLength,
} from "@/model-trajectory-v2/domain/metrics.js";
import type { ZCodeModelTrajectoryV2 } from "@/model-trajectory-v2/contract.js";
import { describe, expect, it } from "vitest";

const T0 = Date.parse("2026-06-03T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function record(
  requestId: string,
  over: Partial<ZCodeTrajectoryV2Record> = {},
): ZCodeTrajectoryV2Record {
  return {
    requestId,
    attempt: 1,
    startedAt: at(0),
    callSource: { kind: "main" },
    model: { modelId: "glm-test", providerId: "zai" },
    request: {
      messages: [],
      toolNames: [],
      params: {},
      cacheBreakpoints: [],
      cacheBreakpointsComplete: true,
    },
    ...over,
  };
}

function trajectory(
  records: ZCodeTrajectoryV2Record[],
  over: Partial<ZCodeModelTrajectoryV2> = {},
): ZCodeModelTrajectoryV2 {
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
    contextWindows: [{ providerId: "zai", modelId: "glm-test", tokens: 4000 }],
    toolTiming: { source: "session-db", entries: [] },
    budget: { toolDefBytes: 0, systemBytes: 0, omitted: false },
    ...over,
  };
}

function timingEntry(
  toolCallId: string,
  toolName: string,
  over: Partial<ZCodeTrajectoryV2ToolTiming> = {},
): ZCodeTrajectoryV2ToolTiming {
  return { toolCallId, toolName, status: "completed", scheduledAt: T0, ...over };
}

describe("unionLength", () => {
  it("counts overlaps once, nests, sums disjoint spans and ignores empty input", () => {
    expect(
      unionLength([
        { start: 0, end: 10 },
        { start: 5, end: 15 },
      ]),
    ).toBe(15);
    expect(
      unionLength([
        { start: 0, end: 10 },
        { start: 2, end: 3 },
      ]),
    ).toBe(10);
    expect(
      unionLength([
        { start: 20, end: 30 },
        { start: 0, end: 10 },
      ]),
    ).toBe(20);
    expect(unionLength([])).toBe(0);
    // Zero-length intervals contribute nothing even when interleaved.
    expect(
      unionLength([
        { start: 5, end: 5 },
        { start: 1, end: 1 },
      ]),
    ).toBe(0);
  });
});

describe("summarizeTrajectory", () => {
  const main1 = record("r1", {
    completedAt: at(1000),
    response: {
      toolCalls: [],
      usage: { inputTokens: 1000, outputTokens: 40, cacheReadTokens: 600, reasoningTokens: 10 },
    },
  });
  // Overlaps main1's tail: union counts [0,1500] once while the sum double-counts [500,1000].
  const sidecar = record("r2", {
    startedAt: at(500),
    durationMs: 1000,
    callSource: { kind: "sidecar" },
    response: { toolCalls: [], usage: { inputTokens: 200, outputTokens: 5 } },
  });
  const main2 = record("r3", {
    startedAt: at(2000),
    completedAt: at(3000),
    response: {
      toolCalls: [],
      usage: { inputTokens: 2000, outputTokens: 60, cacheReadTokens: 600 },
    },
  });
  const tools = [
    timingEntry("tc1", "Read", { execStartedAt: T0 + 100, execEndedAt: T0 + 400 }),
    timingEntry("tc2", "Bash", { execStartedAt: T0 + 300, execEndedAt: T0 + 600 }),
    // Missing exec times contribute to neither interval list.
    timingEntry("tc3", "Grep", { execDurationMs: 5000 }),
  ];

  it("computes cache hit and peak context over main calls only", () => {
    const summary = summarizeTrajectory(trajectory([main1, sidecar, main2]));

    expect(summary.mainCalls).toBe(2);
    expect(summary.otherCalls).toBe(1);
    expect(summary.inputTokens).toBe(3200);
    expect(summary.outputTokens).toBe(105);
    expect(summary.reasoningTokens).toBe(10);
    expect(summary.cacheHitRatio).toBeCloseTo(1200 / 3000, 10);
    expect(summary.peakContextRatio).toBeCloseTo(2000 / 4000, 10);
  });

  it("leaves peakContextRatio undefined when no context window is known", () => {
    const summary = summarizeTrajectory(trajectory([main1], { contextWindows: [] }));
    expect(summary.peakContextRatio).toBeUndefined();
    // A window for another model does not match either.
    const wrongWindow = summarizeTrajectory(
      trajectory([main1], { contextWindows: [{ providerId: "zai", modelId: "other" }] }),
    );
    expect(wrongWindow.peakContextRatio).toBeUndefined();
  });

  it("leaves cacheHitRatio undefined without main usage", () => {
    const noUsage = summarizeTrajectory(trajectory([record("r0")]));
    expect(noUsage.mainCalls).toBe(1);
    expect(noUsage.cacheHitRatio).toBeUndefined();
  });

  it("counts model busy time as the union and model sum time as the plain sum", () => {
    const summary = summarizeTrajectory(trajectory([main1, sidecar, main2]));
    expect(summary.modelBusyMs).toBe(2500);
    expect(summary.modelSumMs).toBe(3000);
  });

  it("exposes tool busy/sum only when tool timing comes from the session db", () => {
    const withTiming = trajectory([main1, sidecar, main2], {
      toolTiming: { source: "session-db", entries: tools },
    });
    expect(summarizeTrajectory(withTiming)).toMatchObject({ toolBusyMs: 500, toolSumMs: 600 });

    const unavailable = summarizeTrajectory(
      trajectory([main1], {
        toolTiming: { source: "unavailable", reason: "db-missing", entries: [] },
      }),
    );
    expect(unavailable).not.toHaveProperty("toolBusyMs");
    expect(unavailable).not.toHaveProperty("toolSumMs");
  });
});

describe("toolTimeByName", () => {
  it("sums execution time per tool name, longest first, name as tie-break", () => {
    const entries = [
      timingEntry("tc1", "Read", { execDurationMs: 100 }),
      timingEntry("tc2", "Bash", { execDurationMs: 500 }),
      timingEntry("tc3", "Grep", { execDurationMs: 300 }),
      timingEntry("tc4", "Read", { execDurationMs: 50 }),
      timingEntry("tc5", "Grep", { execDurationMs: 0 }),
      // No duration yet: counted as a call with zero time.
      timingEntry("tc6", "Read", {}),
    ];

    expect(
      toolTimeByName(trajectory([], { toolTiming: { source: "session-db", entries } })),
    ).toEqual([
      { name: "Bash", totalMs: 500, calls: 1 },
      { name: "Grep", totalMs: 300, calls: 2 },
      { name: "Read", totalMs: 150, calls: 3 },
    ]);
  });
});

describe("contextSeries", () => {
  it("emits one point per main call with usage and marks compaction and context rewrites", () => {
    const first = record("r1", {
      startedAt: at(0),
      inputDeltaOf: { previousRequestId: "r0", sharedPrefixCount: 0 },
      response: { toolCalls: [], usage: { inputTokens: 1000, outputTokens: 30 } },
    });
    const compact = record("r2", { startedAt: at(1000), callSource: { kind: "compact" } });
    // Delta call after the compact call: the compact marker lands here, not a reset.
    const afterCompact = record("r3", {
      startedAt: at(1500),
      inputDeltaOf: { previousRequestId: "r1", sharedPrefixCount: 2 },
      response: { toolCalls: [], usage: { inputTokens: 500 } },
    });
    // Full main call later in the window: context reset.
    const rewritten = record("r4", {
      startedAt: at(2000),
      response: { toolCalls: [], usage: { inputTokens: 700, outputTokens: 5 } },
    });
    // Main call without usage produces no point.
    const noUsage = record("r5", {
      startedAt: at(2500),
      response: { toolCalls: [] },
    });
    // Sidecar calls never produce points.
    const sidecar = record("r6", {
      startedAt: at(3000),
      callSource: { kind: "sidecar" },
      response: { toolCalls: [], usage: { inputTokens: 900 } },
    });

    const points = contextSeries(
      trajectory([first, compact, afterCompact, rewritten, noUsage, sidecar]),
    );

    expect(points).toEqual([
      { recordIndex: 0, t: T0, inputTokens: 1000, outputTokens: 30, window: 4000, ratio: 0.25 },
      {
        recordIndex: 2,
        t: T0 + 1500,
        inputTokens: 500,
        outputTokens: 0,
        window: 4000,
        ratio: 0.125,
        marker: "compact",
      },
      {
        recordIndex: 3,
        t: T0 + 2000,
        inputTokens: 700,
        outputTokens: 5,
        window: 4000,
        ratio: 0.175,
        marker: "context-reset",
      },
    ]);
  });

  it("omits window and ratio when the context window is unknown", () => {
    const first = record("r1", {
      response: { toolCalls: [], usage: { inputTokens: 1000 } },
    });
    const points = contextSeries(trajectory([first], { contextWindows: [] }));

    expect(points).toEqual([{ recordIndex: 0, t: T0, inputTokens: 1000, outputTokens: 0 }]);
    expect(points[0]).not.toHaveProperty("ratio");
  });
});
