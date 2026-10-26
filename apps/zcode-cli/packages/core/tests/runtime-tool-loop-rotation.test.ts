import { describe, expect, it } from "vitest";
import { SessionEventType, createSessionId, modelMessageContentToText } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { drainInlineGuideForNextRequest } from "../src/runtime/methods/turn-guide-drain.js";
import { createToolLoopHistory } from "../src/runtime/helpers/tool-loop-patterns.js";

describe("AgentRuntime tool-loop rotation and polling exemption", () => {
  it("warns once at the sixth call of a two-tool rotation", async () => {
    const steps: ScriptedToolCall[][] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      steps.push([{ id: `ping-${cycle * 2 + 1}`, name: "Ping", input: { file: "a" } }]);
      steps.push([{ id: `pong-${cycle * 2 + 2}`, name: "Pong", input: { file: "b" } }]);
    }

    const { warningEvents, requestContexts, executedToolCount } = await runLoopScenario({
      sessionId: "runtime-rotation-two-tool",
      steps,
      tools: [{ name: "Ping" }, { name: "Pong" }],
    });

    expect(executedToolCount).toBe(6);
    expect(warningEvents).toHaveLength(1);
    expect(warningEvents[0]?.payload).toMatchObject({
      category: "tool_call_rotation",
      severity: "warning",
      observedCount: 3,
      threshold: 3,
      toolCallId: "pong-6",
      toolName: "Pong",
      warningInjected: true,
    });
    expect(requestContexts[6]).toContain(
      "You have been cycling between Ping, Pong (period 2) 3 times without progress.",
    );
  });

  it("warns at the ninth call of a three-tool rotation", async () => {
    const steps: ScriptedToolCall[][] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      steps.push([{ id: `ping-${cycle * 3 + 1}`, name: "Ping", input: { file: "a" } }]);
      steps.push([{ id: `pong-${cycle * 3 + 2}`, name: "Pong", input: { file: "b" } }]);
      steps.push([{ id: `mark-${cycle * 3 + 3}`, name: "Mark", input: { file: "c" } }]);
    }

    const { warningEvents, executedToolCount } = await runLoopScenario({
      sessionId: "runtime-rotation-three-tool",
      steps,
      tools: [{ name: "Ping" }, { name: "Pong" }, { name: "Mark" }],
    });

    expect(executedToolCount).toBe(9);
    expect(warningEvents).toHaveLength(1);
    expect(warningEvents[0]?.payload).toMatchObject({
      category: "tool_call_rotation",
      observedCount: 3,
      threshold: 3,
      toolCallId: `mark-${3 * 3}`,
      toolName: "Mark",
      warningInjected: true,
    });
  });

  it("warns on an Edit ping-pong with alternating inputs", async () => {
    const steps: ScriptedToolCall[][] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      steps.push([{ id: `edit-a-${cycle + 1}`, name: "Edit", input: { path: "f", old: "a", new: "b" } }]);
      steps.push([{ id: `edit-b-${cycle + 1}`, name: "Edit", input: { path: "f", old: "b", new: "a" } }]);
    }

    const { warningEvents } = await runLoopScenario({
      sessionId: "runtime-rotation-edit-ping-pong",
      steps,
      tools: [{ name: "Edit" }],
    });

    expect(warningEvents).toHaveLength(1);
    expect(warningEvents[0]?.payload).toMatchObject({
      category: "tool_call_rotation",
      toolCallId: "edit-b-3",
      toolName: "Edit",
    });
  });

  it("does not warn when the cycle inputs change every round", async () => {
    const steps: ScriptedToolCall[][] = [];
    for (let round = 1; round <= 3; round += 1) {
      steps.push([{ id: `ping-${round * 2 - 1}`, name: "Ping", input: { file: `a${round}` } }]);
      steps.push([{ id: `pong-${round * 2}`, name: "Pong", input: { file: `b${round}` } }]);
    }

    const { warningEvents, executedToolCount } = await runLoopScenario({
      sessionId: "runtime-rotation-changing-inputs",
      steps,
      tools: [{ name: "Ping" }, { name: "Pong" }],
    });

    expect(executedToolCount).toBe(6);
    expect(warningEvents).toHaveLength(0);
  });

  it("does not warn for a build-fix-build-fix-build sequence", async () => {
    const steps: ScriptedToolCall[][] = [
      [{ id: "build-1", name: "Bash", input: { command: "pnpm build" } }],
      [{ id: "edit-2", name: "Edit", input: { path: "f", content: "fix1" } }],
      [{ id: "build-3", name: "Bash", input: { command: "pnpm build" } }],
      [{ id: "edit-4", name: "Edit", input: { path: "f", content: "fix2" } }],
      [{ id: "build-5", name: "Bash", input: { command: "pnpm build" } }],
    ];

    const { warningEvents } = await runLoopScenario({
      sessionId: "runtime-rotation-build-fix-build",
      steps,
      tools: [{ name: "Bash" }, { name: "Edit" }],
    });

    expect(warningEvents).toHaveLength(0);
  });

  it("does not warn when polling TaskOutput that is not ready", async () => {
    const steps: ScriptedToolCall[][] = [];
    for (let index = 1; index <= 5; index += 1) {
      steps.push([{ id: `task-output-${index}`, name: "TaskOutput", input: { task_id: "t1" } }]);
    }

    const { warningEvents, executedToolCount } = await runLoopScenario({
      sessionId: "runtime-rotation-task-output-polling",
      steps,
      tools: [{ name: "TaskOutput", handler: () => "not ready" }],
    });

    expect(executedToolCount).toBe(5);
    expect(warningEvents).toHaveLength(0);
  });

  it("keeps the exact-repeat warning transparent across exempt TaskOutput calls", async () => {
    const steps: ScriptedToolCall[][] = [
      [{ id: "ping-1", name: "Ping", input: { file: "a" } }],
      [{ id: "task-output-2", name: "TaskOutput", input: { task_id: "t1" } }],
      [{ id: "ping-3", name: "Ping", input: { file: "a" } }],
      [{ id: "task-output-4", name: "TaskOutput", input: { task_id: "t1" } }],
      [{ id: "ping-5", name: "Ping", input: { file: "a" } }],
    ];

    const { warningEvents, requestContexts } = await runLoopScenario({
      sessionId: "runtime-rotation-transparent-polling",
      steps,
      tools: [{ name: "Ping" }, { name: "TaskOutput", handler: () => "not ready" }],
    });

    expect(warningEvents).toHaveLength(1);
    expect(warningEvents[0]?.payload).toMatchObject({
      category: "repeated_tool_call",
      observedCount: 3,
      threshold: 3,
      toolCallId: "ping-5",
      toolName: "Ping",
      warningInjected: true,
    });
    expect(requestContexts[5]).toContain("You have called Ping with the same input 3 times in a row.");
  });

  it("does not warn for a rotation batched inside one model step", async () => {
    const batch: ScriptedToolCall[] = [];
    for (let index = 0; index < 6; index += 1) {
      const ping = index % 2 === 0;
      batch.push({
        id: `call-${index + 1}`,
        name: ping ? "Ping" : "Pong",
        input: { file: ping ? "a" : "b" },
      });
    }

    const { warningEvents, executedToolCount } = await runLoopScenario({
      sessionId: "runtime-rotation-batched-single-step",
      steps: [batch],
      tools: [{ name: "Ping" }, { name: "Pong" }],
    });

    expect(executedToolCount).toBe(6);
    expect(warningEvents).toHaveLength(0);
  });

  it("does not warn for repeated successful log tails but warns for failing ones", async () => {
    const tail = (index: number) => ({
      id: `bash-${index}`,
      name: "Bash",
      input: { command: "tail -n 50 build.log" },
    });

    const successScenario = await runLoopScenario({
      sessionId: "runtime-rotation-tail-success",
      steps: [1, 2, 3, 4].map((index) => [tail(index)]),
      tools: [{ name: "Bash", handler: () => "log line" }],
    });
    expect(successScenario.executedToolCount).toBe(4);
    expect(successScenario.warningEvents).toHaveLength(0);

    const failureScenario = await runLoopScenario({
      sessionId: "runtime-rotation-tail-failure",
      steps: [1, 2, 3].map((index) => [tail(index)]),
      tools: [{ name: "Bash", handler: () => ({ result: false, errorCode: 1, message: "no such file" }) }],
    });
    expect(failureScenario.warningEvents).toHaveLength(1);
    expect(failureScenario.warningEvents[0]?.payload).toMatchObject({
      category: "repeated_tool_call",
      observedCount: 3,
      toolCallId: "bash-3",
      toolName: "Bash",
      warningInjected: true,
    });
  });

  it("emits the rotation event with warningInjected=false once the budget is exhausted", async () => {
    const steps: ScriptedToolCall[][] = [];
    const loops: Array<[string, string]> = [
      ["Ping", "a"],
      ["Pong", "b"],
      ["Mark", "c"],
    ];
    let index = 0;
    for (const [name, file] of loops) {
      for (let repeat = 0; repeat < 3; repeat += 1) {
        index += 1;
        steps.push([{ id: `${name.toLowerCase()}-${index}`, name, input: { file } }]);
      }
    }
    for (let cycle = 0; cycle < 3; cycle += 1) {
      steps.push([{ id: `edit-x-${cycle + 1}`, name: "Edit", input: { path: "x" } }]);
      steps.push([{ id: `edit-y-${cycle + 1}`, name: "Edit", input: { path: "y" } }]);
    }

    const { warningEvents, requestContexts } = await runLoopScenario({
      sessionId: "runtime-rotation-budget-exhausted",
      steps,
      tools: [{ name: "Ping" }, { name: "Pong" }, { name: "Mark" }, { name: "Edit" }],
    });

    expect(warningEvents).toHaveLength(4);
    expect(warningEvents.slice(0, 3).map((event) => event.payload)).toMatchObject([
      { category: "repeated_tool_call", warningInjected: true },
      { category: "repeated_tool_call", warningInjected: true },
      { category: "repeated_tool_call", warningInjected: true },
    ]);
    expect(warningEvents[3]?.payload).toMatchObject({
      category: "tool_call_rotation",
      observedCount: 3,
      toolCallId: "edit-y-3",
      toolName: "Edit",
      warningInjected: false,
    });
    expect(requestContexts[steps.length]).not.toContain("cycling between");
  });

  it("resets the rotation window when a guide input is drained mid-cycle", async () => {
    const runtime = {
      activeTurn: { pendingInputs: [{}] },
      hasInlineGuidePendingInput: () => true,
      drainPendingInput: async () => ({
        injectedMessageIds: [],
        latestMessageId: undefined,
        pendingInputIds: ["guide-input"],
        runtimeEntries: [],
      }),
    };
    const history = createToolLoopHistory();
    history.entries.push(
      { modelStepIndex: 1, signature: "sig-ping", toolCallId: "ping-1", toolName: "Ping" },
      { modelStepIndex: 2, signature: "sig-pong", toolCallId: "pong-2", toolName: "Pong" },
      { modelStepIndex: 3, signature: "sig-ping", toolCallId: "ping-3", toolName: "Ping" },
    );
    const state = {
      activeTurn: runtime.activeTurn,
      events: [],
      repeatedToolCallSignature: "sig-ping",
      repeatedToolCallStreakCount: 2,
      toolLoopHistory: history,
      turnRequestState: { entries: [], outputTokenContinuationCount: 0 },
      turnTraceContext: { traceId: "guide-trace" },
    };

    const drained = await drainInlineGuideForNextRequest(runtime as never, state as never);

    expect(drained).toBe(true);
    expect(state.repeatedToolCallSignature).toBeUndefined();
    expect(state.toolLoopHistory).toBeUndefined();
  });
});

interface ScriptedToolCall {
  id: string;
  name: string;
  input: unknown;
}

interface ScenarioTool {
  name: string;
  handler?: () => unknown;
}

async function runLoopScenario(options: {
  sessionId: string;
  steps: ScriptedToolCall[][];
  tools: ScenarioTool[];
  config?: Record<string, unknown>;
}) {
  const sessionId = createSessionId(options.sessionId);
  const eventStore = createTestSessionEventStore();
  const registry = createToolRegistry();
  let executedToolCount = 0;
  for (const tool of options.tools) {
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: tool.name,
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => {
        executedToolCount += 1;
        return tool.handler ? tool.handler() : "ok";
      },
    });
  }

  const requestContexts: string[] = [];
  let modelCallCount = 0;
  const runtime = createTestAgentRuntime(
    sessionId,
    // An empty built-in allowlist keeps registry registrations intact: the runtime constructor
    // otherwise overwrites test tools that collide with built-in names (TaskOutput, Bash).
    { mode: "yolo", toolAllowlist: [], ...(options.config ?? {}) } as never,
    {
      eventStore,
      toolRegistry: registry,
      modelFactory: createTestModelFactory({
        async generateText(request: any) {
          modelCallCount += 1;
          requestContexts.push(
            request.messages
              .map((message: any) => modelMessageContentToText(message.content))
              .join("\n---\n"),
          );
          if (modelCallCount <= options.steps.length) {
            return {
              finishReason: "tool-calls",
              providerMetadata: undefined,
              text: "",
              toolCalls: options.steps[modelCallCount - 1],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }
          return {
            finishReason: "stop",
            providerMetadata: undefined,
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never),
    },
  );

  await runtime.executeTurn("trigger tool loop scenario");
  const events = await eventStore.getEvents(sessionId);
  const warningEvents = events.filter((event) => event.type === SessionEventType.ModelAnomalyWarning);
  return { warningEvents, requestContexts, executedToolCount };
}
