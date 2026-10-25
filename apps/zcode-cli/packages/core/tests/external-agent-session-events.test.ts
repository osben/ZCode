import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createExternalAgentModel,
  createSessionId,
  type ExternalAgentConfigOption,
  type ExternalAgentTurnDriver,
  type ExternalAgentTurnRequest,
  type ModelSelection,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

// specs/acp-agent-runtime.md "S6": config options and stalls are session events, never transcript rows.

const selection: ModelSelection = {
  providerId: "acp:fake",
  modelId: "fake",
  options: { reasoningLevel: "auto" },
};

const OPTIONS: ExternalAgentConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    description: null,
    category: "mode",
    currentValue: "plan",
    options: [
      { value: "build", name: "Build", description: null, group: null },
      { value: "plan", name: "Plan", description: null, group: null },
    ],
  },
];

async function runExternalTurn(script: (request: ExternalAgentTurnRequest) => void) {
  const driver = {
    agentId: "fake",
    runTurn: vi.fn(async (request: ExternalAgentTurnRequest) => {
      script(request);
      return { agentId: "fake", stopReason: "end_turn" };
    }),
  } as ExternalAgentTurnDriver;
  const base = createTestRuntimeModel({
    generateText: async () => {
      throw new Error("regular model API must not be used for an external agent");
    },
    providerId: "acp:fake",
    modelId: "fake",
  });
  const model = createExternalAgentModel({
    driver,
    providerId: "acp:fake",
    modelId: "fake",
    properties: base.properties,
    optionSpecs: base.optionSpecs,
    options: {},
  });
  const eventStore = createTestSessionEventStore();
  const runtime = createTestAgentRuntime(
    createSessionId("external-agent-session-events"),
    { mode: "build", modelSelection: selection, workingDirectory: "/fixture" },
    { eventStore, modelFactory: () => model },
  );
  try {
    await runtime.executeTurn("continue");
    return await eventStore.getEvents(runtime.sessionId);
  } finally {
    runtime.beginShutdown();
  }
}

describe("external agent session events", () => {
  it("persists offered config options as external_agent_config_updated", async () => {
    const stored = await runExternalTurn((request) => {
      request.onEvent({ type: "config_options", options: OPTIONS });
      request.onEvent({ type: "message_delta", text: "done" });
    });

    const updates = stored.filter((event) => event.type === SessionEventType.ExternalAgentConfigUpdated);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload).toEqual({ agentId: "fake", options: OPTIONS });
    expect(updates[0]?.turnId).toBeDefined();
  });

  it("persists a stall and its resume in wire order, before the turn ends", async () => {
    const stored = await runExternalTurn((request) => {
      request.onEvent({ type: "stalled", silentMs: 30_000 });
      request.onEvent({ type: "resumed" });
      request.onEvent({ type: "message_delta", text: "back" });
    });

    const statuses = stored.filter((event) => event.type === SessionEventType.ExternalAgentStatus);
    expect(statuses.map((event) => event.payload)).toEqual([
      { agentId: "fake", status: "stalled", silentMs: 30_000 },
      { agentId: "fake", status: "resumed" },
    ]);
    const resumed = stored.indexOf(statuses[1]!);
    const complete = stored.findIndex((event) => event.type === SessionEventType.TurnComplete);
    expect(resumed).toBeLessThan(complete);
  });

  it("writes no transcript part for config or status events", async () => {
    const stored = await runExternalTurn((request) => {
      request.onEvent({ type: "config_options", options: OPTIONS });
      request.onEvent({ type: "stalled", silentMs: 30_000 });
    });

    const systemMessages = stored.filter((event) => event.type === SessionEventType.SystemMessage);
    expect(systemMessages).toEqual([]);
    const streamed = stored.filter(
      (event) =>
        event.type === SessionEventType.ModelStreaming &&
        typeof (event.payload as { delta?: string }).delta === "string" &&
        (event.payload as { delta: string }).delta.length > 0,
    );
    expect(streamed).toEqual([]);
  });
});
