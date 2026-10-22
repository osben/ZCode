import type { ZCodeTrajectoryV2Record } from "@/model-trajectory-v2/contract.js";
import {
  diffRequests,
  previousSameSource,
  requestFacts,
} from "@/model-trajectory-v2/domain/requestDiff.js";
import { describe, expect, it } from "vitest";

function record(
  requestId: string,
  over: Partial<ZCodeTrajectoryV2Record> = {},
): ZCodeTrajectoryV2Record {
  return {
    requestId,
    attempt: 1,
    startedAt: "2026-06-03T12:00:00.000Z",
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

const interned = {
  toolDefs: {
    td1: { name: "Read", bytes: 10 },
    td2: { name: "Grep", bytes: 10 },
    td3: { name: "Bash", bytes: 10 },
  },
  toolCatalogs: {
    cat1: { toolDefIds: ["td1", "td2"], bytes: 20 },
    cat2: { toolDefIds: ["td1", "td2", "td3"], bytes: 30 },
    catSameNames: { toolDefIds: ["td2", "td1"], bytes: 20 },
  },
  systemPrompts: {
    sp1: { blockIds: ["sb1"], bytes: 100 },
    sp2: { blockIds: ["sb1", "sb2"], bytes: 250 },
  },
};

const withRequest = (
  base: ZCodeTrajectoryV2Record,
  request: Partial<ZCodeTrajectoryV2Record["request"]>,
) => ({
  ...base,
  request: { ...base.request, ...request },
});

describe("diffRequests", () => {
  it("returns no changes without a previous request, and none for identical requests", () => {
    const current = record("r1");
    expect(diffRequests(undefined, current, interned)).toEqual([]);
    expect(diffRequests(record("r0"), current, interned)).toEqual([]);
  });

  it("reports a model change", () => {
    const previous = record("r0", { model: { modelId: "glm-5.3", providerId: "zai" } });
    const current = record("r1", { model: { modelId: "glm-5.3-air", providerId: "zai" } });

    expect(diffRequests(previous, current, interned)).toEqual([
      { kind: "model", from: "glm-5.3", to: "glm-5.3-air" },
    ]);
  });

  it("reports param changes rendered as display strings in a fixed key order", () => {
    const previous = withRequest(record("r0"), {
      params: {
        maxOutputTokens: 8192,
        thinking: { type: "enabled", budgetTokens: 4096 },
        effort: "high",
      },
    });
    const current = withRequest(record("r1"), {
      params: {
        maxOutputTokens: 4096,
        thinking: { type: "enabled", budgetTokens: 1024 },
        effort: "low",
      },
    });

    expect(diffRequests(previous, current, interned)).toEqual([
      { kind: "param", key: "maxOutputTokens", from: "8192", to: "4096" },
      { kind: "param", key: "thinking", from: "enabled 4096", to: "enabled 1024" },
      { kind: "param", key: "effort", from: "high", to: "low" },
    ]);
  });

  it("renders thinking without a budget as its type only", () => {
    const previous = withRequest(record("r0"), { params: { thinking: { type: "enabled" } } });
    const current = withRequest(record("r1"), { params: { thinking: { type: "disabled" } } });

    expect(diffRequests(previous, current, interned)).toEqual([
      { kind: "param", key: "thinking", from: "enabled", to: "disabled" },
    ]);
  });

  it("reports tools added and removed via interned catalogs", () => {
    const previous = withRequest(record("r0"), { toolCatalogId: "cat1" });
    const current = withRequest(record("r1"), { toolCatalogId: "cat2" });

    expect(diffRequests(previous, current, interned)).toEqual([
      { kind: "tools", added: ["Bash"], removed: [] },
    ]);

    const swap = diffRequests(
      withRequest(record("r0"), { toolCatalogId: "cat2" }),
      previous,
      interned,
    );
    expect(swap).toEqual([{ kind: "tools", added: [], removed: ["Bash"] }]);
  });

  it("skips the tools change when the catalog id changes but the tool names do not", () => {
    const previous = withRequest(record("r0"), { toolCatalogId: "cat1" });
    const current = withRequest(record("r1"), { toolCatalogId: "catSameNames" });

    expect(diffRequests(previous, current, interned)).toEqual([]);
  });

  it("falls back to toolNames when a record has no catalog", () => {
    const previous = withRequest(record("r0"), { toolNames: ["Read"] });
    const current = withRequest(record("r1"), { toolCatalogId: "cat2" });

    expect(diffRequests(previous, current, interned)).toEqual([
      { kind: "tools", added: ["Grep", "Bash"], removed: [] },
    ]);
  });

  it("reports a system prompt change", () => {
    const previous = withRequest(record("r0"), { systemPromptId: "sp1" });
    const current = withRequest(record("r1"), { systemPromptId: "sp2" });

    expect(diffRequests(previous, current, interned)).toEqual([{ kind: "system" }]);
  });
});

describe("previousSameSource", () => {
  it("returns the nearest earlier record index of the same call source kind", () => {
    const records = [
      record("r0"),
      record("r1", { callSource: { kind: "sidecar" } }),
      record("r2"),
      record("r3", { callSource: { kind: "subagent" } }),
      record("r4"),
    ];

    expect(previousSameSource(records)).toEqual([undefined, undefined, 0, undefined, 2]);
  });
});

describe("requestFacts", () => {
  it("reads sizes from the interned catalog and system prompt", () => {
    const current = withRequest(record("r1"), {
      toolCatalogId: "cat1",
      systemPromptId: "sp1",
      cacheBreakpoints: [{ location: "system", index: 0 }],
      cacheBreakpointsComplete: true,
    });

    expect(requestFacts(current, interned)).toEqual({
      model: "glm-test",
      toolCount: 2,
      toolBytes: 20,
      systemBytes: 100,
      systemBlockCount: 1,
      breakpointCount: 1,
      breakpointsComplete: true,
    });
  });

  it("falls back to toolNames and the response model without a catalog", () => {
    const current = record("r1", {
      model: { modelId: undefined, providerId: "zai" },
      response: { toolCalls: [], modelId: "glm-fallback" },
      request: {
        messages: [],
        toolNames: ["Read"],
        params: {},
        cacheBreakpoints: [],
        cacheBreakpointsComplete: false,
      },
    });

    const facts = requestFacts(current, interned);
    expect(facts.model).toBe("glm-fallback");
    expect(facts.toolCount).toBe(1);
    expect(facts.toolBytes).toBeUndefined();
    expect(facts.systemBytes).toBeUndefined();
    expect(facts.systemBlockCount).toBeUndefined();
    expect(facts.breakpointCount).toBe(0);
    expect(facts.breakpointsComplete).toBe(false);
  });

  it("leaves toolCount unknown when neither catalog nor toolNames exist", () => {
    const facts = requestFacts(withRequest(record("r1"), {}), interned);
    expect(facts.toolCount).toBeUndefined();
  });
});
