import { describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  SessionEventType,
  createExternalAgentModel,
  createSessionId,
  type CollaborationMode,
  type ExternalAgentPermissionAnswer,
  type ExternalAgentTurnDriver,
  type ExternalAgentTurnRequest,
  type ModelSelection,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

const selection: ModelSelection = {
  providerId: "acp:fake",
  modelId: "fake",
  options: { reasoningLevel: "auto" },
};

/** Asks the user through the turn's permission path once, then ends the turn. */
function askingDriver(options: { onAnswer?: (answer: ExternalAgentPermissionAnswer) => void } = {}) {
  const answers: ExternalAgentPermissionAnswer[] = [];
  const driver: ExternalAgentTurnDriver = {
    agentId: "fake",
    runTurn: vi.fn(async (request: ExternalAgentTurnRequest) => {
      request.onEvent({
        type: "tool_call",
        update: {
          toolCallId: "acp-1",
          title: "Run the tests",
          kind: "execute",
          status: "pending",
          input: { command: "pnpm test" },
          output: null,
        },
      });
      const answer = await request.requestPermission({
        toolCallId: "acp-1",
        title: "Run the tests",
        detail: "pnpm test",
        optionKinds: ["allow_once", "reject_once"],
      });
      answers.push(answer);
      options.onAnswer?.(answer);
      return { agentId: "fake", stopReason: answer === "allow" ? "end_turn" : "end_turn" };
    }),
  } as ExternalAgentTurnDriver;
  return { driver, answers };
}

/** Broker double: `answer` decides the outcome; `signal` is honored the way the real broker honors it. */
function brokerWith(answer: (request: PermissionBrokerRequest, signal?: AbortSignal) => Promise<PermissionBrokerResult>) {
  const requests: PermissionBrokerRequest[] = [];
  const port: PermissionBrokerPort = {
    requestPermission(request, options) {
      requests.push(request);
      return Object.assign(answer(request, options?.signal), { registered: Promise.resolve() });
    },
  };
  return { port, requests };
}

function runtimeWith(driver: ExternalAgentTurnDriver, port: PermissionBrokerPort, mode: CollaborationMode = "build") {
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
    createSessionId("external-agent-permission"),
    { mode, modelSelection: selection, workingDirectory: "/fixture" },
    { eventStore, modelFactory: () => model, permissionBroker: port },
  );
  return { runtime, eventStore };
}

function permissionEvents(events: readonly { type: unknown; payload: unknown }[]) {
  return events.filter(
    (event) =>
      event.type === SessionEventType.PermissionRequested ||
      event.type === SessionEventType.PermissionResolved,
  );
}

describe("external agent user-once permissions", () => {
  it("asks the user once through the broker and answers allow", async () => {
    const { driver, answers } = askingDriver();
    const broker = brokerWith(async () => ({ decision: "allow", reason: "Approved once" }));
    const { runtime, eventStore } = runtimeWith(driver, broker.port);
    try {
      await runtime.executeTurn("run tests");
      expect(answers).toEqual(["allow"]);
      expect(broker.requests).toHaveLength(1);
      expect(broker.requests[0]).toMatchObject({
        approvalMode: "user-once",
        toolName: "acp:execute",
        mode: "guarded",
      });
      const stored = await eventStore.getEvents(runtime.sessionId);
      const [requested, resolved] = permissionEvents(stored);
      expect(requested?.type).toBe(SessionEventType.PermissionRequested);
      expect(requested?.payload).toMatchObject({ approvalMode: "user-once", toolName: "acp:execute" });
      expect(resolved?.type).toBe(SessionEventType.PermissionResolved);
      expect(resolved?.payload).toMatchObject({ decision: "allow" });
      expect(permissionEvents(stored)).toHaveLength(2);
    } finally {
      runtime.beginShutdown();
    }
  });

  it("answers deny with the user's refusal and a single resolution", async () => {
    const { driver, answers } = askingDriver();
    const broker = brokerWith(async () => ({ decision: "deny", reason: "Not now" }));
    const { runtime, eventStore } = runtimeWith(driver, broker.port);
    try {
      await runtime.executeTurn("run tests");
      expect(answers).toEqual(["deny"]);
      const resolved = permissionEvents(await eventStore.getEvents(runtime.sessionId)).at(-1);
      expect(resolved?.payload).toMatchObject({ decision: "deny", reason: "Not now" });
    } finally {
      runtime.beginShutdown();
    }
  });

  it("resolves a pending ask cancelled when the turn is aborted, before the turn ends", async () => {
    const controller = new AbortController();
    // The broker waits on the user until the turn aborts, then rejects like a cancelled request.
    const broker = brokerWith(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    const driver: ExternalAgentTurnDriver = {
      agentId: "fake",
      runTurn: vi.fn(async (request: ExternalAgentTurnRequest) => {
        const settled = await request.requestPermission({
          toolCallId: "acp-2",
          title: "Edit",
          detail: null,
          optionKinds: ["allow_once", "reject_once"],
        });
        expect(settled).toBe("cancelled");
        return { agentId: "fake", stopReason: "cancelled" };
      }),
    } as ExternalAgentTurnDriver;
    const { runtime, eventStore } = runtimeWith(driver, broker.port);
    try {
      const turn = runtime.executeTurn("edit", undefined, { abortSignal: controller.signal });
      await vi.waitFor(() => expect(broker.requests).toHaveLength(1));
      controller.abort();
      await expect(turn).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });
      const stored = await eventStore.getEvents(runtime.sessionId);
      const resolved = permissionEvents(stored).at(-1);
      expect(resolved).toMatchObject({
        type: SessionEventType.PermissionResolved,
        payload: { decision: "deny", reason: "Permission request cancelled" },
      });
      const resolvedIndex = stored.indexOf(resolved!);
      const terminalIndex = stored.findLastIndex(
        (event) =>
          event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError,
      );
      expect(terminalIndex).toBeGreaterThan(resolvedIndex);
    } finally {
      runtime.beginShutdown();
    }
  });

  it("still asks the user in yolo mode, because ZCode modes never answer an ACP ask", async () => {
    const { driver, answers } = askingDriver();
    const broker = brokerWith(async () => ({ decision: "allow" }));
    const { runtime } = runtimeWith(driver, broker.port, "yolo");
    try {
      await runtime.executeTurn("run tests");
      expect(broker.requests).toHaveLength(1);
      expect(answers).toEqual(["allow"]);
    } finally {
      runtime.beginShutdown();
    }
  });

  it("publishes nothing for an ask the turn aborted before the broker registered it", async () => {
    const controller = new AbortController();
    const asked = Promise.withResolvers<void>();
    const requests: PermissionBrokerRequest[] = [];
    // The broker never registers the interaction; the abort is the only thing that settles the ask.
    const port: PermissionBrokerPort = {
      requestPermission(request, options) {
        requests.push(request);
        asked.resolve();
        const response = new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
        return Object.assign(response, { registered: new Promise<void>(() => undefined) });
      },
    } as PermissionBrokerPort;
    const driver: ExternalAgentTurnDriver = {
      agentId: "fake",
      runTurn: vi.fn(async (request: ExternalAgentTurnRequest) => {
        const settled = await request.requestPermission({
          toolCallId: "acp-3",
          title: "Edit",
          detail: null,
          optionKinds: ["allow_once", "reject_once"],
        });
        expect(settled).toBe("cancelled");
        return { agentId: "fake", stopReason: "cancelled" };
      }),
    } as ExternalAgentTurnDriver;
    const { runtime, eventStore } = runtimeWith(driver, port);
    try {
      const turn = runtime.executeTurn("edit", undefined, { abortSignal: controller.signal });
      await asked.promise;
      controller.abort();
      await expect(turn).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });
      expect(requests).toHaveLength(1);
      expect(permissionEvents(await eventStore.getEvents(runtime.sessionId))).toEqual([]);
    } finally {
      runtime.beginShutdown();
    }
  });
});
