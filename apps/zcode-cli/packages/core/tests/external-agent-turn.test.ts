import { describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  ExternalAgentTurnError,
  ExternalAgentUnsupportedError,
  SessionEventType,
  assertNotExternalAgentModel,
  createExternalAgentModel,
  createSessionId,
  externalAgentTurnDriverOf,
  type ExternalAgentTurnDriver,
  type ExternalAgentTurnRequest,
  type Model,
  type ModelSelection,
} from "@zcode/contracts";
import { withModelInvocationContext } from "../src/runtime/methods/runtime-model.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

const selection: ModelSelection = {
  providerId: "acp:fake",
  modelId: "fake",
  options: { reasoningLevel: "auto" },
};

/** A marker Model with the same shape as the bootstrap factory builds for an `acp-agent` provider. */
function markerModel(driver: ExternalAgentTurnDriver): Model {
  const base = createTestRuntimeModel({
    generateText: async () => {
      throw new Error("regular model API must not be used for an external agent");
    },
    providerId: "acp:fake",
    modelId: "fake",
  });
  return createExternalAgentModel({
    driver,
    providerId: "acp:fake",
    modelId: "fake",
    properties: base.properties,
    optionSpecs: base.optionSpecs,
    options: {},
  });
}

function runtimeWith(driver: ExternalAgentTurnDriver) {
  const model = markerModel(driver);
  const eventStore = createTestSessionEventStore();
  const runtime = createTestAgentRuntime(
    createSessionId("external-agent-turn"),
    {
      mode: "build",
      modelSelection: selection,
      workingDirectory: "/fixture",
    },
    {
      eventStore,
      modelFactory: () => model,
    },
  );
  return { runtime, eventStore };
}

function fakeDriver(
  run: (request: ExternalAgentTurnRequest) => Promise<{ stopReason: string; usage?: object }>,
): ExternalAgentTurnDriver & { runTurn: ReturnType<typeof vi.fn> } {
  return {
    agentId: "fake",
    runTurn: vi.fn(async (request: ExternalAgentTurnRequest) => ({
      agentId: "fake",
      ...(await run(request)),
    })),
  } as ExternalAgentTurnDriver & { runTurn: ReturnType<typeof vi.fn> };
}

function eventTypes(events: readonly { type: string }[]) {
  return events.map((event) => event.type);
}

describe("external agent turn path", () => {
  it("streams text and reasoning in order and completes with exactly one terminal event", async () => {
    const driver = fakeDriver(async (request) => {
      request.onEvent({ type: "reasoning_delta", text: "thinking" });
      request.onEvent({ type: "message_delta", text: "po" });
      request.onEvent({ type: "message_delta", text: "ng" });
      return { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } };
    });
    const { runtime, eventStore } = runtimeWith(driver);
    try {
      const result = await runtime.executeTurn("ping");

      expect(result.response).toBe("pong");
      const kinds = result.events
        .filter((event) => event.type === SessionEventType.ModelStreaming)
        .map((event) => (event.payload as { kind?: string }).kind);
      expect(kinds).toEqual([
        "reasoning_start",
        "reasoning_delta",
        "reasoning_end",
        "text_start",
        "text_delta",
        "text_delta",
        "text_end",
        "finish",
      ]);
      const stored = await eventStore.getEvents(runtime.sessionId);
      const terminal = stored.filter(
        (event) =>
          event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError,
      );
      expect(eventTypes(terminal)).toEqual([SessionEventType.TurnComplete]);
      expect(driver.runTurn).toHaveBeenCalledTimes(1);
      const request = driver.runTurn.mock.calls[0]![0] as ExternalAgentTurnRequest;
      expect(request.workingDirectory).toBe("/fixture");
      expect(request.prompt).toEqual([{ type: "text", text: "ping" }]);
    } finally {
      runtime.beginShutdown();
    }
  });

  it("ends a failed agent turn with one TurnError carrying the agent's actionable message", async () => {
    const driver = fakeDriver(async () => {
      throw new ExternalAgentTurnError("auth_required", "fake requires sign-in. Run login first.");
    });
    const { runtime, eventStore } = runtimeWith(driver);
    try {
      await expect(runtime.executeTurn("ping")).rejects.toMatchObject({
        message: "fake requires sign-in. Run login first.",
      });
      const stored = await eventStore.getEvents(runtime.sessionId);
      const terminal = stored.filter(
        (event) =>
          event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError,
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]!.type).toBe(SessionEventType.TurnError);
      expect(JSON.stringify(terminal[0]!.payload)).toContain("Run login first");
    } finally {
      runtime.beginShutdown();
    }
  });

  it("cancels a running agent turn through the turn abort signal with one terminal event", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const driver = fakeDriver(async (request) => {
      markStarted();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { stopReason: "cancelled" };
    });
    const { runtime, eventStore } = runtimeWith(driver);
    const controller = new AbortController();
    try {
      const turn = runtime.executeTurn("long", undefined, { abortSignal: controller.signal });
      await started;
      controller.abort();
      await expect(turn).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });
      const stored = await eventStore.getEvents(runtime.sessionId);
      const terminal = stored.filter(
        (event) =>
          event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError,
      );
      expect(terminal).toHaveLength(1);
    } finally {
      runtime.beginShutdown();
    }
  });

  it("refuses non-chat turns on an external agent before any agent call", async () => {
    const driver = fakeDriver(async () => ({ stopReason: "end_turn" }));
    const { runtime } = runtimeWith(driver);
    try {
      await expect(
        runtime.executeTurn("nightly", undefined, { automationId: "automation-1" }),
      ).rejects.toMatchObject({
        type: CoreErrorType.ModelError,
        message: expect.stringContaining("interactive chat turns"),
      });
      expect(driver.runTurn).not.toHaveBeenCalled();
    } finally {
      runtime.beginShutdown();
    }
  });

  it("fails closed for side callers that reach the marker through the regular API", async () => {
    const model = markerModel(fakeDriver(async () => ({ stopReason: "end_turn" })));
    expect(externalAgentTurnDriverOf(model)).toBeDefined();

    await expect(model.generateText({ messages: [] })).rejects.toBeInstanceOf(
      ExternalAgentUnsupportedError,
    );
    await expect(
      (async () => {
        for await (const _event of model.streamText({ messages: [] })) {
          // Not reached: the marker fails before yielding.
        }
      })(),
    ).rejects.toBeInstanceOf(ExternalAgentUnsupportedError);
    expect(() => assertNotExternalAgentModel(model, "title generation")).toThrow(
      /title generation/,
    );
  });

  it("keeps the driver on a model wrapped by the invocation-context layer", async () => {
    const driver = fakeDriver(async () => ({ stopReason: "end_turn" }));
    const wrapped = withModelInvocationContext(markerModel(driver), () => ({}));

    expect(externalAgentTurnDriverOf(wrapped)).toBe(driver);
    await expect(wrapped.generateText({ messages: [] })).rejects.toBeInstanceOf(
      ExternalAgentUnsupportedError,
    );
  });

  it("leaves regular models untouched by the external-agent guard", () => {
    const regular = createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop", usage: {} }) as never,
    });
    expect(externalAgentTurnDriverOf(regular)).toBeUndefined();
    expect(assertNotExternalAgentModel(regular, "title generation")).toBe(regular);
  });
});
