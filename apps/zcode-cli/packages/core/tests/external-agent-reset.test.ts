import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createExternalAgentModel,
  createSessionId,
  type ExternalAgentTurnDriver,
  type ExternalAgentTurnRequest,
  type ModelSelection,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

const selection: ModelSelection = {
  providerId: "acp:fake",
  modelId: "fake",
  options: { reasoningLevel: "auto" },
};

describe("external agent context reset notice", () => {
  it("persists a context reset notice before the agent's first reply", async () => {
    const driver = {
      agentId: "fake",
      runTurn: vi.fn(async (request: ExternalAgentTurnRequest) => {
        request.onEvent({ type: "context_reset" });
        request.onEvent({ type: "message_delta", text: "hello again" });
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
      createSessionId("external-agent-reset"),
      { mode: "build", modelSelection: selection, workingDirectory: "/fixture" },
      { eventStore, modelFactory: () => model },
    );
    try {
      await runtime.executeTurn("continue");
      const stored = await eventStore.getEvents(runtime.sessionId);
      const notice = stored.findIndex(
        (event) =>
          event.type === SessionEventType.SystemMessage &&
          (event.payload as { type?: string }).type === "external_agent_context_reset",
      );
      const firstText = stored.findIndex(
        (event) =>
          event.type === SessionEventType.ModelStreaming &&
          (event.payload as { delta?: string }).delta === "hello again",
      );
      expect(notice).toBeGreaterThanOrEqual(0);
      expect(stored[notice]?.payload).toMatchObject({ content: "fake" });
      expect(notice).toBeLessThan(firstText);
    } finally {
      runtime.beginShutdown();
    }
  });
});
