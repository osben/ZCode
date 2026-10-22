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

function runtimeWith(driver: ExternalAgentTurnDriver, sessionStore?: unknown) {
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
      ...(sessionStore === undefined ? {} : { sessionStore: sessionStore as never }),
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
      const turnComplete = stored.find((event) => event.type === SessionEventType.TurnComplete);
      expect((turnComplete?.payload as { usage?: { source?: string; inputTokens?: number } }).usage)
        .toMatchObject({ source: "external-agent", inputTokens: 3, outputTokens: 2 });
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

/** Store fake for the turn tests: records todo and title writes; other store calls are no-ops. */
function fakeStoreWithTodosAndTitle(session: Record<string, unknown>) {
  const writes = { todos: [] as unknown[], titles: [] as Record<string, unknown>[] };
  let current = { ...session };
  const base = {
    readTodos: async () => [],
    updateTodos: async (input: { todos: unknown[] }) => {
      writes.todos.push(input.todos);
    },
    getSession: async () => ({ ...current }),
    updateSession: async (input: Record<string, unknown>) => {
      writes.titles.push(input);
      current = { ...current, title: input.title, titleSource: input.titleSource };
      return { ...current };
    },
  };
  // Unknown reads return an empty list: the turn's boundary code iterates what it reads.
  const store = new Proxy(base, {
    get: (target, key) =>
      key in target ? target[key as keyof typeof target] : async () => [],
  });
  return { store, writes };
}

function toolUpdate(overrides: Record<string, unknown>) {
  return {
    toolCallId: "acp-tool-1",
    title: null,
    kind: null,
    status: null,
    input: undefined,
    output: null,
    ...overrides,
  };
}

function persistedParts(runtime: unknown) {
  const spy = vi.spyOn(runtime as { persistPart: (...args: unknown[]) => Promise<void> }, "persistPart");
  return () => spy.mock.calls.map((call) => call[0] as { type: string; state?: { status?: string }; tool?: string });
}

describe("external agent tool, plan and title events", () => {
  it("maps a tool call and its update to a ZCode lifecycle and keeps the text around it in order", async () => {
    const driver = fakeDriver(async (request) => {
      request.onEvent({ type: "message_delta", text: "before" });
      request.onEvent({
        type: "tool_call",
        update: toolUpdate({ title: "Read a.txt", kind: "read", status: "in_progress", input: { path: "a.txt" } }),
      });
      request.onEvent({
        type: "tool_call_update",
        update: toolUpdate({ status: "completed", output: "file body" }),
      });
      request.onEvent({ type: "message_delta", text: "after" });
      return { stopReason: "end_turn" };
    });
    const { runtime, eventStore } = runtimeWith(driver);
    const parts = persistedParts(runtime);
    try {
      await runtime.executeTurn("read it");
      const stored = await eventStore.getEvents(runtime.sessionId);
      const toolTypes = stored
        .map((event) => event.type)
        .filter((type) => String(type).startsWith("tool_call_"));
      expect(toolTypes).toEqual([
        SessionEventType.ToolCallScheduled,
        SessionEventType.ToolCallStarted,
        SessionEventType.ToolCallResult,
      ]);
      const scheduled = stored.find((event) => event.type === SessionEventType.ToolCallScheduled);
      expect(scheduled?.payload).toMatchObject({
        toolName: "acp:read",
        title: "Read a.txt",
        input: { path: "a.txt" },
      });
      const result = stored.find((event) => event.type === SessionEventType.ToolCallResult);
      expect(result?.payload).toMatchObject({ result: { success: true, content: "file body" } });

      const streamed = stored
        .filter((event) => event.type === SessionEventType.ModelStreaming)
        .map((event) => (event.payload as { delta?: string; kind?: string }).delta)
        .filter((delta) => delta === "before" || delta === "after");
      expect(streamed).toEqual(["before", "after"]);

      const persisted = parts();
      const textParts = persisted.filter((part) => part.type === "text");
      expect(textParts).toHaveLength(2);
      const toolPart = persisted.find((part) => part.type === "tool" && part.state?.status === "completed");
      expect(toolPart?.tool).toBe("acp:read");
      expect(persisted.indexOf(textParts[0]!)).toBeLessThan(persisted.indexOf(toolPart!));
      expect(persisted.indexOf(toolPart!)).toBeLessThan(persisted.indexOf(textParts[1]!));
    } finally {
      runtime.beginShutdown();
    }
  });

  it("creates the row on the fly for an update that names an unseen tool call and records a failure as an error", async () => {
    const driver = fakeDriver(async (request) => {
      request.onEvent({
        type: "tool_call_update",
        update: toolUpdate({ toolCallId: "late", title: "Run tests", kind: "execute", status: "failed", output: "exit 1" }),
      });
      return { stopReason: "end_turn" };
    });
    const { runtime, eventStore } = runtimeWith(driver);
    try {
      await runtime.executeTurn("test");
      const stored = await eventStore.getEvents(runtime.sessionId);
      expect(
        stored.map((event) => event.type).filter((type) => String(type).startsWith("tool_call_")),
      ).toEqual([
        SessionEventType.ToolCallScheduled,
        SessionEventType.ToolCallStarted,
        SessionEventType.ToolCallError,
      ]);
      const error = stored.find((event) => event.type === SessionEventType.ToolCallError);
      expect(error?.payload).toMatchObject({ error: { message: "exit 1" } });
    } finally {
      runtime.beginShutdown();
    }
  });

  it("closes an open tool row with an error when the turn is cancelled", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const driver = fakeDriver(async (request) => {
      request.onEvent({
        type: "tool_call",
        update: toolUpdate({ title: "Edit", kind: "edit", status: "in_progress" }),
      });
      markStarted();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { stopReason: "cancelled" };
    });
    const { runtime, eventStore } = runtimeWith(driver);
    const controller = new AbortController();
    try {
      const turn = runtime.executeTurn("edit", undefined, { abortSignal: controller.signal });
      await started;
      controller.abort();
      await expect(turn).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });
      const stored = await eventStore.getEvents(runtime.sessionId);
      expect(
        stored.map((event) => event.type).filter((type) => String(type).startsWith("tool_call_")),
      ).toEqual([
        SessionEventType.ToolCallScheduled,
        SessionEventType.ToolCallStarted,
        SessionEventType.ToolCallError,
      ]);
      const error = stored.find((event) => event.type === SessionEventType.ToolCallError);
      expect(error?.payload).toMatchObject({ error: { message: "Cancelled" } });
    } finally {
      runtime.beginShutdown();
    }
  });

  it("shows a plan as a TodoWrite row and writes the session todo state", async () => {
    const driver = fakeDriver(async (request) => {
      request.onEvent({
        type: "plan",
        entries: [
          { content: "Read the spec", priority: "high", status: "completed" },
          { content: "Write the code", priority: "medium", status: "in_progress" },
          { content: "  ", priority: "odd", status: "unknown" },
        ],
      });
      return { stopReason: "end_turn" };
    });
    const { store, writes } = fakeStoreWithTodosAndTitle({ title: "New task", titleSource: "default" });
    const { runtime, eventStore } = runtimeWith(driver, store);
    try {
      await runtime.executeTurn("plan it");
      const stored = await eventStore.getEvents(runtime.sessionId);
      const scheduled = stored.find((event) => event.type === SessionEventType.ToolCallScheduled);
      expect(scheduled?.payload).toMatchObject({
        toolName: "TodoWrite",
        input: {
          todos: [
            { content: "Read the spec", status: "completed", priority: "high" },
            { content: "Write the code", status: "in_progress", priority: "medium" },
            { content: "Untitled step", status: "pending", priority: "medium" },
          ],
        },
      });
      expect(writes.todos).toHaveLength(1);
      expect(writes.todos[0]).toEqual((scheduled?.payload as { input: { todos: unknown[] } }).input.todos);
      const result = stored.find((event) => event.type === SessionEventType.ToolCallResult);
      const output = JSON.parse((result?.payload as { result: { content: string } }).result.content);
      expect(output.summary).toEqual({ total: 3, pending: 1, inProgress: 1, completed: 1 });
    } finally {
      runtime.beginShutdown();
    }
  });

  it("applies the agent's session title through the title setter, and never replaces a custom title", async () => {
    const driver = fakeDriver(async (request) => {
      request.onEvent({ type: "session_title", title: "Fix the parser" });
      return { stopReason: "end_turn" };
    });
    const generated = fakeStoreWithTodosAndTitle({ title: "New task", titleSource: "default", taskType: "interactive" });
    const first = runtimeWith(driver, generated.store);
    try {
      await first.runtime.executeTurn("parse");
      expect(generated.writes.titles.filter((write) => "titleSource" in write)).toEqual([
        expect.objectContaining({ title: "Fix the parser", titleSource: "generated" }),
      ]);
      const stored = await first.eventStore.getEvents(first.runtime.sessionId);
      expect(
        stored.find(
          (event) =>
            event.type === SessionEventType.SessionTitleUpdated &&
            (event.payload as { source?: string }).source === "generated",
        )?.payload,
      ).toMatchObject({
        source: "generated",
        title: "Fix the parser",
      });
    } finally {
      first.runtime.beginShutdown();
    }

    const custom = fakeStoreWithTodosAndTitle({ title: "My name", titleSource: "custom", taskType: "interactive" });
    const second = runtimeWith(driver, custom.store);
    try {
      await second.runtime.executeTurn("parse");
      expect(custom.writes.titles.filter((write) => "titleSource" in write)).toEqual([]);
    } finally {
      second.runtime.beginShutdown();
    }
  });
});
