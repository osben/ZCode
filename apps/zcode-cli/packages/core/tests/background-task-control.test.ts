import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  createSessionEvent,
  createSessionId,
  createTurnId,
  type ExecutionPort,
  type SessionEvent,
} from "@zcode/contracts";
import type { AgentRuntime } from "../src/runtime.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import {
  InMemoryRuntimeTaskRegistry,
  hasRunningBackgroundRuntimeTask,
} from "../src/runtime-task/registry.js";
import { BackgroundTaskTracker } from "../src/tool/executor/background-tasks.js";
import { updateRuntimeBackgroundTask } from "../src/tool/executor/background-task-registry.js";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { taskStopToolEntry } from "../src/tool/handlers/task-stop.js";
import { createTestSessionEventStore } from "./test-event-store.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("background task control", () => {
  it("stops running local Bash tasks through the runtime registry dispatcher", async () => {
    const sessionId = createSessionId("background-control-bash");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const startedAt = new Date(0);
    const completedAt = new Date(1);
    const cancelledTaskIds: string[] = [];
    const executionPort: ExecutionPort = {
      async run() {
        throw new Error("run should not be called");
      },
      async cancelBackgroundTask(taskId) {
        cancelledTaskIds.push(taskId);
        return {
          taskId,
          status: "cancelled",
          startedAt,
          completedAt,
          stdoutTail: "cancelled",
        };
      },
    };
    runtimeTaskRegistry.register({
      agentId: "bash_bg",
      agentType: "local_bash",
      command: "npm run dev",
      description: "npm run dev",
      isBackgrounded: true,
      startedAt,
      status: "running",
      taskId: "bash_bg",
      taskType: "local_bash",
      type: "local_bash",
    } as never);
    await eventStore.append(
      createSessionEvent(SessionEventType.BackgroundTaskStarted, sessionId, {
        cancellable: true,
        command: "npm run dev",
        startedAt,
        status: "running",
        taskId: "bash_bg",
        terminalId: "bash_bg",
        toolCallId: "tool_bash",
        toolName: "Bash",
      }),
    );
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      { eventStore, executionPort, runtimeTaskRegistry },
    );

    const result = await runtime.cancelBackgroundTask("bash_bg");
    const events = await eventStore.getEvents(sessionId);

    expect(cancelledTaskIds).toEqual(["bash_bg"]);
    expect(result).toMatchObject({
      cancelled: true,
      status: "cancelled",
      taskId: "bash_bg",
    });
    expect(
      events.filter((event) => event.type === SessionEventType.BackgroundTaskUpdated),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    ).toHaveLength(0);
  });

  it("does not ask the execution port to stop an unknown UI-control task", async () => {
    const sessionId = createSessionId("background-control-missing-ui");
    const eventStore = createTestSessionEventStore();
    let cancelCalled = false;
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore,
        executionPort: {
          async run() {
            throw new Error("run should not be called");
          },
          async cancelBackgroundTask() {
            cancelCalled = true;
            return undefined;
          },
        },
      },
    );

    const result = await runtime.cancelBackgroundTask("missing_bg");

    expect(cancelCalled).toBe(false);
    expect(result).toMatchObject({
      cancelled: false,
      reason: "background_task_not_found",
      status: "lost",
      taskId: "missing_bg",
    });
  });

  it("marks a registry-backed local Bash task lost when the execution adapter no longer has it", async () => {
    const sessionId = createSessionId("background-control-bash-lost-adapter");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const startedAt = new Date(0);
    const executionPort: ExecutionPort = {
      async run() {
        throw new Error("run should not be called");
      },
      async cancelBackgroundTask() {
        return undefined;
      },
    };
    runtimeTaskRegistry.register({
      agentId: "bash_lost_adapter",
      agentType: "local_bash",
      command: "sleep 999",
      description: "sleep 999",
      isBackgrounded: true,
      startedAt,
      status: "running",
      taskId: "bash_lost_adapter",
      taskType: "local_bash",
      type: "local_bash",
    } as never);
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      { eventStore, executionPort, runtimeTaskRegistry },
    );

    const result = await runtime.cancelBackgroundTask("bash_lost_adapter");
    const events = await eventStore.getEvents(sessionId);

    expect(result).toMatchObject({
      cancelled: false,
      reason: "background_task_not_found",
      status: "lost",
      taskId: "bash_lost_adapter",
    });
    expect(runtimeTaskRegistry.get("bash_lost_adapter")).toMatchObject({
      status: "lost",
    });
    expect(
      events.filter((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    ).toHaveLength(1);
  });

  it("returns strict not-found and not-running results for model-tool callers", async () => {
    const sessionId = createSessionId("background-control-strict");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    runtimeTaskRegistry.register({
      agentId: "terminal_bg",
      agentType: "local_bash",
      description: "finished",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "completed",
      taskId: "terminal_bg",
      taskType: "local_bash",
      type: "local_bash",
    } as never);
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore,
        runtimeTaskRegistry,
        executionPort: {
          async run() {
            throw new Error("run should not be called");
          },
        },
      },
    );

    await expect(
      (runtime as any).stopBackgroundTask("missing_bg", {
        strict: true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "background_task_not_found",
      taskId: "missing_bg",
    });
    await expect(
      (runtime as any).stopBackgroundTask("terminal_bg", {
        strict: true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "background_task_not_running",
      status: "completed",
      taskId: "terminal_bg",
      type: "local_bash",
    });
  });

  it("treats stopped runtime task results as successful cancellation", async () => {
    const sessionId = createSessionId("background-control-stopped-status");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    runtimeTaskRegistry.register({
      agentId: "agent_stopped",
      agentType: "general-purpose",
      description: "stoppable agent",
      isBackgrounded: true,
      outputFile: "/tmp/agent_stopped/output.txt",
      parentToolCallId: "tool_agent_stopped",
      startedAt: new Date(0),
      status: "running",
      taskId: "agent_stopped",
      taskType: "local_agent",
      type: "local_agent",
    } as never);
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore,
        runtimeTaskRegistry,
        subagentPort: {
          async launch() {
            throw new Error("launch should not be called");
          },
          async run() {
            throw new Error("run should not be called");
          },
          async stopTask(taskId) {
            return {
              agentId: taskId,
              agentType: "general-purpose",
              childSessionId: "child_stopped" as never,
              description: "stoppable agent",
              isBackgrounded: true,
              outputFile: "/tmp/agent_stopped/output.txt",
              parentToolCallId: "tool_agent_stopped",
              parentSessionId: sessionId,
              prompt: "stop",
              startedAt: new Date(0),
              status: "stopped",
              taskId,
              taskType: "local_agent",
              type: "local_agent",
            } as never;
          },
        },
      },
    );

    await expect(runtime.cancelBackgroundTask("agent_stopped")).resolves.toMatchObject({
      cancelled: true,
      status: "cancelled",
      taskId: "agent_stopped",
    });
  });

  it("returns unsupported for runtime task types without a stop handler", async () => {
    const sessionId = createSessionId("background-control-unsupported");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    runtimeTaskRegistry.register({
      agentId: "workflow_bg",
      agentType: "local_workflow",
      description: "workflow",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "running",
      taskId: "workflow_bg",
      taskType: "local_workflow",
      type: "local_workflow",
    } as never);
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      { eventStore, runtimeTaskRegistry },
    );

    await expect((runtime as any).stopBackgroundTask("workflow_bg", {})).resolves.toMatchObject({
      ok: false,
      reason: "background_task_cancel_not_supported",
      taskId: "workflow_bg",
      type: "local_workflow",
    });
  });

  it("stops running local Agent tasks through the subagent port", async () => {
    const sessionId = createSessionId("background-control-agent");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const stoppedTaskIds: string[] = [];
    runtimeTaskRegistry.register({
      agentId: "agent_bg",
      agentType: "general-purpose",
      description: "research",
      isBackgrounded: true,
      outputFile: "/tmp/agent_bg/output.txt",
      parentToolCallId: "tool_agent",
      startedAt: new Date(0),
      status: "running",
      taskId: "agent_bg",
      taskType: "local_agent",
      type: "local_agent",
    } as never);
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore,
        runtimeTaskRegistry,
        subagentPort: {
          async launch() {
            throw new Error("launch should not be called");
          },
          async run() {
            throw new Error("run should not be called");
          },
          async stopTask(taskId, options) {
            stoppedTaskIds.push(`${taskId}:${options?.initiator}`);
            return {
              agentId: taskId,
              agentType: "general-purpose",
              description: "research",
              outputFile: "/tmp/agent_bg/output.txt",
              startedAt: new Date(0),
              status: "killed",
              taskId,
            };
          },
        },
      },
    );

    const result = await runtime.cancelBackgroundTask("agent_bg");

    // The GUI entry is a user stop: the stopper travels to the subagent with stopTask, and the final-state notification writes "was stopped by user" from it.
    expect(stoppedTaskIds).toEqual(["agent_bg:user"]);
    expect(result).toMatchObject({
      cancelled: true,
      status: "cancelled",
      taskId: "agent_bg",
    });
  });

  it("uses the local Agent description as the TaskStop command", async () => {
    const sessionId = createSessionId("background-control-agent-command");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const prompt = "Read every source and return a complete multi-section report.";
    runtimeTaskRegistry.register({
      agentId: "agent_command",
      agentType: "general-purpose",
      description: "Research the current odds",
      isBackgrounded: true,
      prompt,
      startedAt: new Date(0),
      status: "running",
      taskId: "agent_command",
      taskType: "local_agent",
      type: "local_agent",
    } as never);
    await eventStore.append(
      createSessionEvent(SessionEventType.BackgroundTaskStarted, sessionId, {
        cancellable: true,
        command: prompt,
        description: "Research the current odds",
        startedAt: new Date(0),
        status: "running",
        taskId: "agent_command",
        terminalId: "agent_command",
        toolCallId: "tool_agent_command",
        toolName: "Agent",
      }),
    );
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore,
        runtimeTaskRegistry,
        subagentPort: {
          async launch() {
            throw new Error("launch should not be called");
          },
          async run() {
            throw new Error("run should not be called");
          },
          async stopTask(taskId) {
            return {
              agentId: taskId,
              agentType: "general-purpose",
              description: "Research the current odds",
              startedAt: new Date(0),
              status: "killed",
              taskId,
            };
          },
        },
      },
    );

    await expect(
      (runtime as any).stopBackgroundTask("agent_command", { strict: true }),
    ).resolves.toMatchObject({
      command: "Research the current odds",
      ok: true,
      status: "killed",
      taskId: "agent_command",
      type: "local_agent",
    });
  });

  it("aborts a running background subagent and enqueues one stopped notification", async () => {
    const sessionId = createSessionId("background-control-agent-port");
    const turnId = createTurnId("turn_background_control_agent_port");
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-background-control-agent-port-"));
    const aborted = deferred();
    let abortObserved = false;
    const notifications: string[] = [];
    const notificationOriginMetas: unknown[] = [];
    const notificationArtifactStates: Array<{ exists: boolean; content: string }> = [];
    const emittedEvents: Array<{ type: SessionEventType; payload: unknown }> = [];
    const backgroundCompletedAbortStates: boolean[] = [];
    const registry = new InMemoryRuntimeTaskRegistry();
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_stop",
      emitParentEvent: async (event) => {
        if (event.type === SessionEventType.BackgroundTaskCompleted) {
          backgroundCompletedAbortStates.push(abortObserved);
        }
        emittedEvents.push({ type: event.type, payload: event.payload });
      },
      enqueueParentTaskNotification: (notification) => {
        const outputFile = notification.text.match(/<output-file>([^<]+)<\/output-file>/u)?.[1];
        notificationArtifactStates.push({
          exists: outputFile ? existsSync(outputFile) : false,
          content: outputFile && existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "",
        });
        notifications.push(notification.text);
        notificationOriginMetas.push(notification.originMeta);
      },
      outputRootDir,
      runtimeTaskRegistry: registry,
      async runExploreAgent(request, options) {
        await request.onSessionReady?.();
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              abortObserved = true;
              aborted.resolve();
              reject(options.signal?.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    });

    try {
      await port.start?.({
        agentType: "general-purpose",
        description: "Stop me",
        parentToolCallId: "tool_agent_stop",
        prompt: "Wait until stopped",
        sessionId,
        trace: {
          traceId: "trace_background_control_agent_port",
          spanId: "span_background_control_agent_port",
          sessionId,
          turnId,
        },
        turnId,
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
      });

      const stopped = await port.stopTask?.("agent_stop", { initiator: "model" });
      await aborted.promise;

      expect(stopped).toMatchObject({
        status: "killed",
        taskId: "agent_stop",
      });
      expect(registry.get("agent_stop")).toMatchObject({
        notified: true,
        status: "killed",
      });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain("<status>killed</status>");
      // The stopper passed to TaskStop reaches the notification; killed notifications carry no usage.
      expect(notifications[0]).toContain('<summary>Agent "Stop me" was stopped by ZCode</summary>');
      expect(notifications[0]).not.toContain("<usage>");
      // The final state is delivered structurally via originMeta; killed carries no error.
      expect(notificationOriginMetas).toEqual([
        {
          backgroundSource: "subagent",
          title: "Stop me",
          workId: "agent_stop",
          subagentResult: { status: "killed" },
        },
      ]);
      expect(notificationArtifactStates).toEqual([
        expect.objectContaining({
          exists: true,
          content: expect.stringContaining("Background agent task stopped."),
        }),
      ]);
      expect(backgroundCompletedAbortStates).toEqual([true]);
      expect(
        emittedEvents.filter((event) => event.type === SessionEventType.BackgroundTaskCompleted),
      ).toHaveLength(1);
    } finally {
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  // Stopper full chain: stop entry → runtime.stopBackgroundTask → subagent stopTask → killed notification summary.
  it.each([
    { initiator: "model", summary: "was stopped by ZCode" },
    { initiator: "user", summary: "was stopped by user" },
  ])(
    "carries the $initiator stop initiator from the stop entry into the killed notification",
    async ({ initiator, summary }) => {
      const sessionId = createSessionId(`background-control-agent-initiator-${initiator}`);
      const turnId = createTurnId(`turn_background_control_agent_initiator_${initiator}`);
      const outputRootDir = await mkdtemp(
        join(tmpdir(), "zcode-background-control-agent-initiator-"),
      );
      const aborted = deferred();
      const notifications: string[] = [];
      const registry = new InMemoryRuntimeTaskRegistry();
      const port = createExploreSubagentPort({
        createAgentId: () => "agent_initiator",
        emitParentEvent: async () => {},
        enqueueParentTaskNotification: (notification) => {
          notifications.push(notification.text);
        },
        outputRootDir,
        runtimeTaskRegistry: registry,
        async runExploreAgent(request, options) {
          await request.onSessionReady?.();
          return await new Promise((_, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                reject(options.signal?.reason ?? new Error("aborted"));
              },
              { once: true },
            );
          });
        },
      });
      const runtime = createTestAgentRuntime(
        sessionId,
        { mode: "build" },
        {
          eventStore: createTestSessionEventStore(),
          runtimeTaskRegistry: registry,
          subagentPort: port,
        },
      );

      try {
        await port.start?.({
          agentType: "general-purpose",
          description: "Stop me",
          parentToolCallId: "tool_agent_initiator",
          prompt: "Wait until stopped",
          sessionId,
          trace: {
            traceId: "trace_background_control_agent_initiator",
            spanId: "span_background_control_agent_initiator",
            sessionId,
            turnId,
          },
          turnId,
          workingDirectory: outputRootDir,
          workspaceRoot: outputRootDir,
        });

        if (initiator === "model") {
          // Model entry: TaskStop uses the same binding runtime handed to the tool execution context.
          await taskStopToolEntry.handler({ task_id: "agent_initiator" }, {
            backgroundTaskControlPort: {
              stopBackgroundTask: runtime.stopBackgroundTask.bind(runtime),
            },
            toolCallId: "tool_task_stop",
          } as never);
        } else {
          // App entry: v4 cancelBackgroundWork calls cancelBackgroundTask.
          await runtime.cancelBackgroundTask("agent_initiator");
        }
        await aborted.promise;

        expect(registry.get("agent_initiator")).toMatchObject({ status: "killed" });
        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toContain(`<summary>Agent "Stop me" ${summary}</summary>`);
      } finally {
        await rm(outputRootDir, { force: true, recursive: true });
      }
    },
  );

  it("cleans up a background subagent when startup event emission fails before run starts", async () => {
    const sessionId = createSessionId("background-control-agent-startup-failure");
    const turnId = createTurnId("turn_background_control_agent_startup_failure");
    const outputRootDir = await mkdtemp(
      join(tmpdir(), "zcode-background-control-agent-startup-failure-"),
    );
    const registry = new InMemoryRuntimeTaskRegistry();
    let runCalled = false;
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_startup_fail",
      emitParentEvent: async (event) => {
        if (event.type === SessionEventType.SubagentSpawned) {
          throw new Error("spawn event failed");
        }
      },
      enqueueParentTaskNotification: () => {},
      outputRootDir,
      runtimeTaskRegistry: registry,
      async runExploreAgent(request) {
        runCalled = true;
        await request.onSessionReady?.();
        throw new Error("run should not be called");
      },
    });

    try {
      await expect(
        port.start?.({
          agentType: "general-purpose",
          description: "Fail before run",
          parentToolCallId: "tool_agent_startup_fail",
          prompt: "This should not start",
          sessionId,
          trace: {
            traceId: "trace_background_control_agent_startup_failure",
            spanId: "span_background_control_agent_startup_failure",
            sessionId,
            turnId,
          },
          turnId,
          workingDirectory: outputRootDir,
          workspaceRoot: outputRootDir,
        }),
      ).rejects.toThrow("spawn event failed");

      expect(runCalled).toBe(true);
      expect(registry.get("agent_startup_fail")).toBeUndefined();
    } finally {
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it("does not mark a stopped background subagent terminal until its notification is enqueued", async () => {
    const sessionId = createSessionId("background-control-agent-stop-finalize-failure");
    const turnId = createTurnId("turn_background_control_agent_stop_final_failure");
    const outputRootDir = await mkdtemp(
      join(tmpdir(), "zcode-background-control-agent-stop-finalize-failure-"),
    );
    const aborted = deferred();
    let abortObserved = false;
    const registry = new InMemoryRuntimeTaskRegistry();
    const port = createExploreSubagentPort({
      createAgentId: () => "agent_stop_finalize_fail",
      emitParentEvent: async () => {},
      enqueueParentTaskNotification: () => {
        throw new Error("enqueue failed");
      },
      outputRootDir,
      runtimeTaskRegistry: registry,
      async runExploreAgent(request, options) {
        await request.onSessionReady?.();
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              abortObserved = true;
              aborted.resolve();
              reject(options.signal?.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    });

    try {
      await port.start?.({
        agentType: "general-purpose",
        description: "Stop finalize failure",
        parentToolCallId: "tool_agent_stop_finalize_fail",
        prompt: "Wait until stopped",
        sessionId,
        trace: {
          traceId: "trace_background_control_agent_stop_final_failure",
          spanId: "span_background_control_agent_stop_final_failure",
          sessionId,
          turnId,
        },
        turnId,
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
      });

      await expect(port.stopTask?.("agent_stop_finalize_fail")).rejects.toThrow(
        "stopped notification was not enqueued",
      );

      expect(abortObserved).toBe(false);
      expect(registry.get("agent_stop_finalize_fail")).toMatchObject({
        status: "running",
      });
    } finally {
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it("aborts a SendMessage-resumed background subagent when it is stopped", async () => {
    const sessionId = createSessionId("background-control-agent-resume");
    const turnId = createTurnId("turn_background_control_agent_resume");
    const childSessionId = createSessionId("subagent_agent_resume");
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-background-control-agent-resume-"));
    const agentOutputDir = join(outputRootDir, sessionId, "agent_resume");
    const aborted = deferred();
    const parentEvents: SessionEvent[] = [];
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register({
      agentId: "agent_resume",
      agentType: "general-purpose",
      childSessionId,
      description: "Resume me",
      isBackgrounded: true,
      parentSessionId: sessionId,
      parentToolCallId: "tool_agent_resume",
      prompt: "Original prompt",
      startedAt: new Date(0),
      status: "completed",
      taskId: "agent_resume",
      taskType: "local_agent",
      traceContext: {
        traceId: "trace_background_control_agent_resume",
        spanId: "span_background_control_agent_resume",
        sessionId,
        turnId,
      },
      turnId,
      type: "local_agent",
    } as never);
    const port = createExploreSubagentPort({
      createAgentId: () => "unused_agent_id",
      emitParentEvent: async (event) => {
        parentEvents.push(event);
      },
      enqueueParentTaskNotification: () => {},
      outputRootDir,
      runtimeTaskRegistry: registry,
      async runExploreAgent(request, options) {
        await request.onSessionReady?.();
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(options.signal?.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    });

    try {
      const result = await port.sendMessage?.({
        message: "Continue in background",
        parentToolCallId: "tool_agent_resume_send",
        sessionId,
        summary: "Continue resumed work",
        to: "agent_resume",
        trace: {
          traceId: "trace_background_control_agent_resume_send",
          spanId: "span_background_control_agent_resume_send",
          sessionId,
          turnId,
        },
        turnId,
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
      });

      expect(result).toMatchObject({
        agentId: "agent_resume",
        delivery: "resumed_background",
        message: `Agent "agent_resume" was stopped (completed); resumed it in the background with your message. You'll be notified when it finishes. Output: ${join(agentOutputDir, "output.txt")}`,
        outputFile: join(agentOutputDir, "output.txt"),
        status: "success",
        taskId: "agent_resume",
      });
      const resumedStartEvents = parentEvents.filter(
        (event) =>
          event.type === SessionEventType.SubagentSpawned ||
          event.type === SessionEventType.BackgroundTaskStarted,
      );
      expect(resumedStartEvents.map((event) => event.type)).toEqual([
        SessionEventType.SubagentSpawned,
      ]);
      expect(resumedStartEvents[0]?.payload).toMatchObject({
        agentId: "agent_resume",
        background: true,
        childSessionId,
        resumed: true,
        status: "running",
      });

      const stopped = await port.stopTask?.("agent_resume");
      await Promise.race([
        aborted.promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("resumed subagent was not aborted")), 100),
        ),
      ]);

      expect(stopped).toMatchObject({
        status: "killed",
        taskId: "agent_resume",
      });
      expect(registry.get("agent_resume")).toMatchObject({
        status: "killed",
      });
    } finally {
      await rm(outputRootDir, { force: true, recursive: true });
    }
  });

  it("does not overwrite a terminal runtime task when a late tracker snapshot arrives", () => {
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    runtimeTaskRegistry.register({
      agentId: "bash_race",
      agentType: "local_bash",
      description: "sleep 30",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "killed",
      taskId: "bash_race",
      taskType: "local_bash",
      type: "local_bash",
    } as never);

    updateRuntimeBackgroundTask(
      { runtimeTaskRegistry } as never,
      {
        id: "tool_bash_race",
        input: { command: "sleep 30" },
        name: "Bash",
      } as never,
      "bash_race",
      "completed",
      {
        taskId: "bash_race",
        status: "completed",
        startedAt: new Date(0),
        completedAt: new Date(1),
        stdoutTail: "done",
      },
    );

    expect(runtimeTaskRegistry.get("bash_race")).toMatchObject({
      status: "killed",
    });
    expect(runtimeTaskRegistry.get("bash_race")).not.toHaveProperty("stdoutTail");
  });

  /**
   * TaskOutput's projection can only read the registry entry (dwf never writes outputFile), so
   * the artifact must land on the entry at terminal-update time. The tests below pin "what is
   * stored, when it is stored, and never clearing an existing value with undefined".
   */
  describe("dwf run 产物落到 registry 条目上", () => {
    const CREATE_WORKFLOW_CALL = {
      id: "tool_dwf_result",
      input: { script: "return 1;" },
      name: "CreateWorkflow",
    };

    function registryWithDwfRun(): InMemoryRuntimeTaskRegistry {
      const registry = new InMemoryRuntimeTaskRegistry();
      registry.register({
        agentId: "dwfrun-result",
        agentType: "local_dynamic_workflow",
        description: "Dynamic workflow run",
        isBackgrounded: true,
        startedAt: new Date(0),
        status: "running",
        taskId: "dwfrun-result",
        taskType: "local_dynamic_workflow",
        type: "local_dynamic_workflow",
      } as never);
      return registry;
    }

    function update(
      registry: InMemoryRuntimeTaskRegistry,
      status: string,
      snapshot: Record<string, unknown>,
    ): void {
      updateRuntimeBackgroundTask(
        { runtimeTaskRegistry: registry } as never,
        CREATE_WORKFLOW_CALL as never,
        "dwfrun-result",
        status,
        snapshot as never,
      );
    }

    it("终态的字符串产物原样存为 resultText", () => {
      const registry = registryWithDwfRun();
      update(registry, "completed", {
        taskId: "dwfrun-result",
        status: "completed",
        output: "the final answer",
      });

      expect(registry.get("dwfrun-result")?.resultText).toBe("the final answer");
    });

    it("终态的对象产物存为 pretty JSON", () => {
      const registry = registryWithDwfRun();
      update(registry, "completed", {
        taskId: "dwfrun-result",
        status: "completed",
        output: { report: "done" },
      });

      expect(registry.get("dwfrun-result")?.resultText).toBe(
        JSON.stringify({ report: "done" }, null, 2),
      );
    });

    it("running 的中途快照不写 resultText", () => {
      const registry = registryWithDwfRun();
      update(registry, "running", {
        taskId: "dwfrun-result",
        status: "running",
        output: "not settled yet",
      });

      expect(registry.get("dwfrun-result")?.resultText).toBeUndefined();
    });

    it("产物缺席的终态不写 resultText", () => {
      const registry = registryWithDwfRun();
      update(registry, "completed", { taskId: "dwfrun-result", status: "completed" });

      expect(registry.get("dwfrun-result")?.resultText).toBeUndefined();
    });

    // undefined never clears an existing value: one artifact-absent update must not erase the artifact stored previously.
    it("已有的 resultText 不被产物缺席的更新清掉", () => {
      const registry = registryWithDwfRun();
      registry.update("dwfrun-result", (current) => ({
        ...current,
        resultText: "already captured",
      }));
      update(registry, "running", { taskId: "dwfrun-result", status: "running" });

      expect(registry.get("dwfrun-result")?.resultText).toBe("already captured");
    });

    it("legacy Workflow 的终态不写 resultText（不改它的契约）", () => {
      const registry = new InMemoryRuntimeTaskRegistry();
      registry.register({
        agentId: "wfrun-legacy",
        agentType: "local_workflow",
        description: "Workflow background task",
        isBackgrounded: true,
        startedAt: new Date(0),
        status: "running",
        taskId: "wfrun-legacy",
        taskType: "local_workflow",
        type: "local_workflow",
      } as never);

      updateRuntimeBackgroundTask(
        { runtimeTaskRegistry: registry } as never,
        { id: "tool_wf_legacy", input: { scriptPath: "w.ts" }, name: "Workflow" } as never,
        "wfrun-legacy",
        "completed",
        { runId: "wfrun-legacy", status: "completed", output: { response: "legacy" } } as never,
      );

      expect(registry.get("wfrun-legacy")?.resultText).toBeUndefined();
    });
  });

  it("emits non-cancellable terminal background task events", async () => {
    const sessionId = createSessionId("background-control-terminal-cancellable");
    const turnId = createTurnId("turn_background_control_terminal_cancellable");
    const events: Array<{ type: SessionEventType; payload: unknown }> = [];
    const tracker = new BackgroundTaskTracker({
      emitEvent: async (event) => {
        events.push({ type: event.type, payload: event.payload });
      },
      executionPort: {
        async run() {
          throw new Error("run should not be called");
        },
        async cancelBackgroundTask() {
          throw new Error("cancelBackgroundTask should not be called");
        },
        async waitForBackgroundTask() {
          return {
            taskId: "bash_terminal_cancellable",
            status: "completed",
            startedAt: new Date(0),
            completedAt: new Date(1),
            stdoutTail: "done",
          };
        },
      },
      getWorkingDirectory: () => "/tmp",
      getWorkspaceRoot: () => "/tmp",
      readFileState: new Map(),
      runtimeScope: "main",
      sessionId,
    } as never);

    await tracker.trackBackgroundTask(
      {
        id: "tool_bash_terminal_cancellable",
        input: { command: "echo done" },
        name: "Bash",
      } as never,
      {
        backgroundTaskId: "bash_terminal_cancellable",
        status: "backgrounded",
      },
      {
        traceId: "trace_background_control_terminal_cancellable",
        spanId: "span_background_control_terminal_cancellable",
        sessionId,
        turnId,
      },
      turnId,
    );

    await waitForCondition(() =>
      events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    );

    const completed = events.find(
      (event) => event.type === SessionEventType.BackgroundTaskCompleted,
    );
    expect(completed?.payload).toMatchObject({
      cancellable: false,
      status: "completed",
      taskId: "bash_terminal_cancellable",
    });
  });
});

/**
 * The background lifecycle's per-tool-name hard dispatch has become a per-tool table lookup
 * (see docs/dynamic-workflow/presentation.md's "generalized background lifecycle"). This group
 * tests two things: CreateWorkflow getting the full snapshot/wait/cancel capabilities through
 * dynamicWorkflowRunPort, and the existing tools' semantics unchanged verbatim.
 */
describe("background task per-tool provider lookup", () => {
  interface TrackedRun {
    events: { payload: Record<string, unknown>; type: string }[];
    notifications: { taskId?: string; text: string; toolName?: string; originMeta?: unknown }[];
  }

  async function trackDynamicWorkflowRun(options: {
    getTask?: () => Promise<unknown>;
    input?: Record<string, unknown>;
    launchOutput?: Record<string, unknown>;
    name?: string;
    port?: Record<string, unknown>;
    waitForTask?: () => Promise<unknown>;
  }): Promise<TrackedRun> {
    const sessionId = createSessionId(options.name ?? "dwf-tracker");
    const turnId = createTurnId(options.name ?? "dwf-tracker");
    const events: TrackedRun["events"] = [];
    const notifications: TrackedRun["notifications"] = [];

    const tracker = new BackgroundTaskTracker({
      emitEvent: async (event) => {
        events.push({ payload: event.payload as Record<string, unknown>, type: event.type });
      },
      enqueueBackgroundTaskNotification: (notification) => {
        notifications.push(notification);
        return undefined;
      },
      dynamicWorkflowRunPort:
        options.port ??
        ({
          async submit() {
            throw new Error("submit should not be called by the tracker");
          },
          getTask: options.getTask ?? (async () => ({ status: "running", taskId: "dwfrun-1" })),
          waitForTask:
            options.waitForTask ??
            (async () => ({
              status: "completed",
              taskId: "dwfrun-1",
              output: { response: "workflow answer" },
            })),
          async cancel() {
            return true;
          },
          async listEvents() {
            return [];
          },
        } as never),
      getWorkingDirectory: () => "/tmp",
      getWorkspaceRoot: () => "/tmp",
      readFileState: new Map(),
      runtimeScope: "main",
      sessionId,
    } as never);

    await tracker.trackBackgroundTask(
      {
        id: "tool_create_workflow_1",
        input: options.input ?? { script: 'const r = await agent("a").ask("x");' },
        name: "CreateWorkflow",
      } as never,
      { backgroundTaskId: "dwfrun-1", status: "backgrounded", ...options.launchOutput },
      {
        traceId: `trace_${options.name ?? "dwf-tracker"}`,
        spanId: `span_${options.name ?? "dwf-tracker"}`,
        sessionId,
        turnId,
      },
      turnId,
    );

    return { events, notifications };
  }

  // The fifth dispatch site (canCancelBackgroundTask): it decides the started payload's cancellable.
  // Without fixing it, the detail page's and background panel's Cancel buttons do nothing — the whole cancel path is unreachable.
  it("CreateWorkflow 的 started payload 可取消", async () => {
    const { events } = await trackDynamicWorkflowRun({ name: "dwf-cancellable" });

    const started = events.find((event) => event.type === SessionEventType.BackgroundTaskStarted);
    expect(started?.payload).toMatchObject({
      cancellable: true,
      status: "running",
      taskId: "dwfrun-1",
      toolName: "CreateWorkflow",
    });
  });

  // taskKind is the display category (panel grouping and icons). A dwf run previously landed in
  // "bash" — a mislabel we were aware of. Lifecycle semantics are unaffected (already dispatched
  // by per-tool lifecycleProvider), but the panel groups by it, and a run that can open a detail
  // page and be cancelled is not the same kind of thing as a background shell command.
  it("CreateWorkflow 的 taskKind 是 workflow，不再错标成 bash", async () => {
    const { events } = await trackDynamicWorkflowRun({ name: "dwf-task-kind" });

    const started = events.find((event) => event.type === SessionEventType.BackgroundTaskStarted);
    expect((started?.payload as { taskKind?: string }).taskKind).toBe("workflow");
  });

  /**
   * The payload's `description` is the title of the task island's Workflows section row (via
   * backgroundWorks.title). The original implementation only recognized `input.description`,
   * which does not exist at all in CreateWorkflow's input schema (only `{name?, script}`,
   * contracts/src/tools/create-workflow.ts), so the panel row fell back to toolName and showed
   * "CreateWorkflow" — every run with the same name. Now it goes through the existing
   * workflowTaskSubject fallback chain.
   */
  it("CreateWorkflow 的展示名取 input.name", async () => {
    const { events } = await trackDynamicWorkflowRun({
      input: { name: "Nightly release audit", script: "" },
      name: "dwf-description-name",
    });

    const started = events.find((event) => event.type === SessionEventType.BackgroundTaskStarted);
    expect(started?.payload).toMatchObject({ description: "Nightly release audit" });
  });

  // With the name absent the fallback chain reaches its last link, taskId: not undefined, and not toolName.
  // The projection already treats those two identically (both land in the UI-side fallbackName), so taskId is acceptable.
  it("CreateWorkflow 无 name 时展示名兜底到 taskId 而不是工具名", async () => {
    const { events } = await trackDynamicWorkflowRun({ name: "dwf-description-fallback" });

    const started = events.find((event) => event.type === SessionEventType.BackgroundTaskStarted);
    expect((started?.payload as { description?: string }).description).toBe("dwfrun-1");
  });

  // The snapshot provider and the direct waiter both come from the same port: the terminal state arrives via waitForTask and settles as completed.
  it("经端口的快照提供者与等待者把 run 结算成终态", async () => {
    const { events } = await trackDynamicWorkflowRun({ name: "dwf-terminal" });

    await waitForCondition(() =>
      events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    );
    const completed = events.find(
      (event) => event.type === SessionEventType.BackgroundTaskCompleted,
    );
    expect(completed?.payload).toMatchObject({ status: "completed", taskId: "dwfrun-1" });
  });

  // The completion notification reuses formatWorkflowTaskNotification and carries
  // backgroundSource "workflow", so the main agent's new turn renders as a background result
  // header instead of degrading into a bare model-only message.
  it("终态通知走 workflow 通知格式并标记 backgroundSource", async () => {
    const { events, notifications } = await trackDynamicWorkflowRun({ name: "dwf-notify" });

    await waitForCondition(() =>
      events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    );
    expect(notifications).toHaveLength(1);
    const notification = notifications[0]!;
    expect(notification.taskId).toBe("dwfrun-1");
    expect(notification.toolName).toBe("CreateWorkflow");
    // formatWorkflowTaskNotification's shape (not Bash's): a workflow-worded summary plus the truncated result.
    expect(notification.text).toContain('<summary>Workflow &quot;dwfrun-1&quot; completed.</summary>');
    expect(notification.text).toContain("workflow answer");
    expect(notification.originMeta).toMatchObject({
      backgroundSource: "workflow",
      workId: "dwfrun-1",
    });
  });

  /**
   * The run artifact's feed-back into the notification (bug observed on desktop). The original
   * implementation took `output.response` per the legacy `Workflow` output shape: a dwf artifact
   * is the script's arbitrary top-level return value, so on a record there is no `response` key
   * → `<result>` entirely absent; on a non-record the `isRecord` gate demoted output to the
   * **launch output**, whose `response` is the stale prose of "the run has started in the
   * background" — worse than absence. The tests below pin the serialization rules and "never
   * fall back to prose".
   *
   * launchOutput only reaches the notification on the two `lost` paths (terminal paths never
   * pass it), so the only place "no prose fallback" can genuinely fail is the lost case.
   */
  const LAUNCH_PROSE =
    "The workflow script compiled cleanly and the run started in the background with ID: dwfrun-1.";

  async function notificationFor(name: string, artifact: unknown): Promise<string> {
    const { events, notifications } = await trackDynamicWorkflowRun({
      name,
      waitForTask: async () => ({
        status: "completed",
        taskId: "dwfrun-1",
        ...(artifact === undefined ? {} : { output: artifact }),
      }),
    });
    await waitForCondition(() =>
      events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    );
    return notifications[0]!.text;
  }

  it("字符串产物原样进 <result>（不加 JSON 引号）", async () => {
    const text = await notificationFor("dwf-artifact-string", "the final answer");

    expect(text).toContain("<result>the final answer</result>");
    expect(text).not.toContain('"the final answer"');
  });

  it("对象产物按 pretty JSON 进 <result>", async () => {
    const text = await notificationFor("dwf-artifact-object", {
      report: "done",
      steps: [1, 2],
    });

    // JSON.stringify(v, null, 2), then through escapeXml (quotes become &quot;).
    expect(text).toContain("&quot;report&quot;: &quot;done&quot;");
    expect(text).toContain("&quot;steps&quot;");
    expect(text).toContain("<result>{\n");
  });

  it("非 record 的数组产物也走 pretty JSON", async () => {
    const text = await notificationFor("dwf-artifact-array", ["one", "two"]);

    expect(text).toContain("&quot;one&quot;");
    expect(text).toContain("<result>[\n");
  });

  // With the artifact absent, `<result>` is absent as a whole field.
  it("undefined 产物没有 <result>", async () => {
    const text = await notificationFor("dwf-artifact-absent", undefined);

    expect(text).not.toContain("<result>");
  });

  it("失败的 run 带 <error> 不带 <result>", async () => {
    const { events, notifications } = await trackDynamicWorkflowRun({
      name: "dwf-artifact-failed",
      waitForTask: async () => ({
        status: "failed",
        taskId: "dwfrun-1",
        error: "script threw TypeError",
      }),
    });
    await waitForCondition(() =>
      events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    );

    const text = notifications[0]!.text;
    expect(text).toContain("<error>script threw TypeError</error>");
    expect(text).not.toContain("<result>");
  });

  // This is the "worse than absence" case: the lost path hands launch output into the
  // notification, and the original implementation then fed the model the stale prose of "the
  // run has started in the background" as the run's result. dwf must leave the whole field
  // absent.
  it("lost 的 dwf run 绝不把 launch 散文当结果回投", async () => {
    const { events, notifications } = await trackDynamicWorkflowRun({
      launchOutput: { response: LAUNCH_PROSE },
      name: "dwf-artifact-lost",
      waitForTask: async () => undefined,
    });
    await waitForCondition(() =>
      events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    );

    const text = notifications[0]!.text;
    expect(text).toContain("its in-process state was lost");
    expect(text).not.toContain("<result>");
    expect(text).not.toContain(LAUNCH_PROSE);
  });

  // ── Progressive artifacts (reports) fed back with the completion notification (docs/dynamic-workflow/transcript-and-notifications.md "Notifications") ──
  //
  // All three terminal states carry it, because a run that died halfway still finished the
  // earlier work — salvaging it is the very reason report exists, and a bare "failed" would
  // throw it all away. Entries come from the journal's kind="report" rows (the run service puts
  // them on the snapshot's `reports`), not the memory-only workflowRuns projection.

  async function notificationWithReports(
    name: string,
    snapshot: Record<string, unknown>,
  ): Promise<string> {
    const { events, notifications } = await trackDynamicWorkflowRun({
      name,
      waitForTask: async () => ({ taskId: "dwfrun-1", ...snapshot }),
    });
    await waitForCondition(() =>
      events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
    );
    return notifications[0]!.text;
  }

  it("completed 的通知带 <reports>：真实总数 + 逐条预览（string 原样 / object pretty JSON）", async () => {
    const text = await notificationWithReports("dwf-reports-completed", {
      status: "completed",
      output: "final answer",
      reports: ["3 stale imports", { file: "a.ts", severity: "warn" }],
    });

    expect(text).toContain('<reports count="2">');
    expect(text).toContain("[1] 3 stale imports");
    // Serialization shares the <result> rules: object goes pretty JSON (through escapeXml, quotes become &quot;).
    expect(text).toContain("[2] {");
    expect(text).toContain("&quot;file&quot;: &quot;a.ts&quot;");
    // All entries fit the preview, so no shown attribute (the presence of shown itself means "the preview is partial").
    expect(text).not.toContain("shown=");
    // The artifact and the run result are two different things; both present at once.
    expect(text).toContain("<result>final answer</result>");
  });

  it("failed 与 cancelled 的通知一样带 reports（这条是 report 特性的目的）", async () => {
    const failed = await notificationWithReports("dwf-reports-failed", {
      status: "failed",
      error: "script threw TypeError",
      reports: ["finding before the crash"],
    });
    expect(failed).toContain('<reports count="1">');
    expect(failed).toContain("[1] finding before the crash");
    expect(failed).toContain("<error>script threw TypeError</error>");
    // A failed run has no artifact but does have reports — the two must be distinguishable.
    expect(failed).not.toContain("<result>");

    const cancelled = await notificationWithReports("dwf-reports-cancelled", {
      status: "cancelled",
      reports: ["finding before the cancel"],
    });
    expect(cancelled).toContain('<reports count="1">');
    expect(cancelled).toContain("[1] finding before the cancel");
  });

  // ── Presentation guidance (docs/dynamic-workflow/authoring.md "What the main agent is told when a run ends") ──
  //
  // A prose paragraph appended after the XML tells the main agent to present the run's result as
  // a deliverable. One paragraph each for completed and non-completed; the prose comes after
  // reports, so the total truncation cuts it first.
  it("completed 的通知在 XML 之后带交付物呈现指引", async () => {
    const text = await notificationWithReports("dwf-guidance-completed", {
      status: "completed",
      output: "final answer",
      reports: ["one finding"],
    });
    const close = text.indexOf("</task-notification>");
    const guidance = text.indexOf("Present its outcome to the user as a deliverable");
    expect(close).toBeGreaterThanOrEqual(0);
    expect(guidance).toBeGreaterThan(close);
    expect(text).toContain("which findings were confirmed by a deterministic check or an independent subagent");
    expect(text).toContain("Do not restate the phase graph or the script.");
    expect(text).not.toContain("Present what it salvaged first");
  });

  it("failed / cancelled 的通知带抢救优先的指引", async () => {
    const failed = await notificationWithReports("dwf-guidance-failed", {
      status: "failed",
      error: "script threw TypeError",
      reports: ["finding before the crash"],
    });
    expect(failed.indexOf("Present what it salvaged first")).toBeGreaterThan(
      failed.indexOf("</task-notification>"),
    );
    expect(failed).toContain("AmendWorkflow");
    expect(failed).not.toContain("Present its outcome to the user as a deliverable");

    const cancelled = await notificationWithReports("dwf-guidance-cancelled", {
      status: "cancelled",
      reports: ["finding before the cancel"],
    });
    expect(cancelled).toContain("Present what it salvaged first");
  });

  it("零条 report 时整节缺席，不发一节空的 <reports>", async () => {
    const noKey = await notificationWithReports("dwf-reports-absent", {
      status: "completed",
      output: "done",
    });
    expect(noKey).not.toContain("<reports");

    const emptyList = await notificationWithReports("dwf-reports-empty", {
      status: "completed",
      output: "done",
      reports: [],
    });
    expect(emptyList).not.toContain("<reports");
  });

  /**
   * Truncation and counting are **both important**: the count is the signal that tells the main
   * agent "the preview is partial, the full set can be fetched via the run id". Giving only the
   * preview would make the model think it saw everything.
   */
  it("预览按预算截断，但 count 是真实总数且 shown 说明预览有多少条", async () => {
    const reports = Array.from({ length: 300 }, (_, index) => `finding ${index + 1} `.repeat(20));
    const text = await notificationWithReports("dwf-reports-truncated", {
      status: "completed",
      reports,
    });

    expect(text).toContain('count="300"');
    const shown = /shown="(\d+)"/u.exec(text);
    expect(shown).not.toBeNull();
    const shownCount = Number(shown![1]);
    expect(shownCount).toBeGreaterThan(0);
    expect(shownCount).toBeLessThan(300);
    // The preview starts from the first entry (the earliest findings are most likely premises of later entries).
    expect(text).toContain("[1] finding 1");
  });

  // The snapshot carries only the first 256 items; the real total is in `reportCount`
  // (docs/execution-engine.md "Reading the journal"): count must state the run's total, not the
  // snapshot's item count — otherwise a run reporting 65,536 entries would claim in the
  // notification that it reported only 256, and the model would never fetch the rest.
  it("count 读快照的 reportCount：快照截在 256 条时仍报真实总数", async () => {
    const reports = Array.from({ length: 256 }, (_, index) => `f${index + 1}`);
    const text = await notificationWithReports("dwf-reports-count-from-snapshot", {
      status: "completed",
      reports,
      reportCount: 65_536,
    });
    expect(text).toContain('count="65536"');
    const shown = /shown="(\d+)"/u.exec(text);
    expect(Number(shown?.[1])).toBeLessThanOrEqual(256);
    expect(text).toContain("[1] f1");
  });

  it("没有 reportCount 的老快照退回条目数", async () => {
    const text = await notificationWithReports("dwf-reports-count-legacy", {
      status: "completed",
      reports: ["a", "b", "c"],
    });
    expect(text).toContain('<reports count="3">');
  });

  // ── The run's script file (docs/dynamic-workflow/launch.md "Script files") ──
  //
  // The port gives an absolute path on the snapshot (part of the run's identity); what the
  // tracker hands to the guidance is the **workspace-relative** spelling: the main agent is
  // about to Edit this file, and that is the kind of path it uses for file reads and writes
  // elsewhere.
  it("errored 的指引带上快照里的脚本文件，写成工作区相对路径", async () => {
    const text = await notificationWithReports("dwf-script-path-errored", {
      status: "failed",
      runStatus: "errored",
      error: "script threw TypeError",
      scriptPath: "/tmp/.zcode/workflow-drafts/audit.dwf.ts",
    });

    expect(text).toContain(
      'The run\'s script is at .zcode/workflow-drafts/audit.dwf.ts. Edit that file in place, then call AmendWorkflow (run_id="dwfrun-1", path=".zcode/workflow-drafts/audit.dwf.ts")',
    );
    expect(text).not.toContain("Fix the script and submit it with AmendWorkflow");
    // The path goes into the guidance only, not the XML block: the user face never displays it (the spec's "What the user sees").
    expect(text.indexOf(".zcode/workflow-drafts")).toBeGreaterThan(
      text.indexOf("</task-notification>"),
    );
  });

  it("工作目录之外的脚本文件原样给绝对路径", async () => {
    const text = await notificationWithReports("dwf-script-path-outside", {
      status: "failed",
      runStatus: "errored",
      error: "script threw TypeError",
      scriptPath: "/elsewhere/shared/audit.dwf.ts",
    });

    expect(text).toContain("The run's script is at /elsewhere/shared/audit.dwf.ts.");
  });

  it("stopped(model) 的指引在快照有文件时多一句「编辑它、传 path」", async () => {
    const text = await notificationWithReports("dwf-script-path-stopped", {
      status: "cancelled",
      runStatus: "stopped",
      stopReason: "model",
      scriptPath: "/tmp/.zcode/workflow-drafts/audit.dwf.ts",
    });

    expect(text).toContain(
      "Its script is at .zcode/workflow-drafts/audit.dwf.ts: edit that file and pass `path`.",
    );
  });

  it("快照没有脚本文件时指引逐字节退回旧话（老端口 / 草稿写不下去的项目）", async () => {
    const text = await notificationWithReports("dwf-script-path-absent", {
      status: "failed",
      runStatus: "errored",
      error: "script threw TypeError",
    });

    expect(text).toContain(
      'Fix the script and submit it with AmendWorkflow (run_id="dwfrun-1") so finished work is reused.',
    );
    expect(text).not.toContain("Edit that file in place");
  });

  // ── User-facing artifacts (docs/dynamic-workflow/authoring.md "How the user sees them") ──
  //
  // ⚠ Terminology: "artifact" has two senses in this describe. The `<result>` family is the
  // script's **top-level return value** (the engine-internal `RunSettlement.artifact`), while
  // the `<artifacts>` section is output the script **published for the user to see** via
  // `artifact.*`. The two appear side by side in the same notification; the wording must keep
  // them distinguishable.

  it("completed 的通知带 <artifacts>，排在 <reports> 之后，一行一件", async () => {
    const text = await notificationWithReports("dwf-artifacts-completed", {
      status: "completed",
      output: "final answer",
      reports: ["a finding"],
      artifacts: [
        {
          id: "audit",
          kind: "file",
          title: "审计报告",
          version: 2,
          contentType: "application/pdf",
          itemCount: 0,
          versions: [{ version: 1, publishedAt: 1, bytes: 10 }, { version: 2, publishedAt: 2, bytes: 4096 }],
        },
        {
          id: "perf",
          kind: "chart",
          version: 1,
          itemCount: 12,
          versions: [{ version: 1, publishedAt: 3 }],
        },
      ],
    });

    expect(text).toContain('<artifacts count="2">');
    // Content artifact: contentType plus the latest version's byte count.
    expect(text).toContain("- audit (file, v2, application/pdf, 4096 bytes): 审计报告");
    // Preset dashboard: no bytes; the data volume is the label report's entry count; no colon without a title.
    expect(text).toContain("- perf (chart, v1, 12 items)");
    expect(text).not.toContain("- perf (chart, v1, 12 items):");
    // Order: <reports> first, <artifacts> after (the 120k total truncation cuts the latter first).
    expect(text.indexOf("<reports")).toBeGreaterThan(-1);
    expect(text.indexOf("<artifacts")).toBeGreaterThan(text.indexOf("</reports>"));
    // The presentation guidance appendage appears only when artifacts are present.
    expect(text).toContain("already in front of the user as cards");
  });

  it("failed 与 cancelled 的通知一样带 <artifacts>，并给一句更短的指引", async () => {
    const artifacts = [
      { id: "notes", kind: "markdown", version: 1, contentType: "text/markdown", itemCount: 0, versions: [{ version: 1, publishedAt: 1, bytes: 128 }] },
    ];
    const failed = await notificationWithReports("dwf-artifacts-failed", {
      status: "failed",
      error: "ask #12 threw",
      artifacts,
    });
    expect(failed).toContain('<artifacts count="1">');
    expect(failed).toContain("- notes (markdown, v1, text/markdown, 128 bytes)");
    expect(failed).toContain("Artifacts listed above are already in front of the user.");
    expect(failed).not.toContain("already in front of the user as cards");

    const cancelled = await notificationWithReports("dwf-artifacts-cancelled", {
      status: "cancelled",
      artifacts,
    });
    expect(cancelled).toContain('<artifacts count="1">');
  });

  it("零件时整节缺席，指引也不长出那一句（没有清单可引用）", async () => {
    const noKey = await notificationWithReports("dwf-artifacts-absent", { status: "completed" });
    expect(noKey).not.toContain("<artifacts");
    expect(noKey).not.toContain("already in front of the user");

    const emptyList = await notificationWithReports("dwf-artifacts-empty", {
      status: "completed",
      artifacts: [],
    });
    expect(emptyList).not.toContain("<artifacts");
  });

  it("超过 8 件时 shown 在场且 count 仍是真实总数", async () => {
    const artifacts = Array.from({ length: 11 }, (_, index) => ({
      id: `a${index + 1}`,
      kind: "markdown",
      version: 1,
      itemCount: 0,
      versions: [{ version: 1, publishedAt: 1, bytes: 8 }],
    }));
    const text = await notificationWithReports("dwf-artifacts-truncated", {
      status: "completed",
      artifacts,
    });

    expect(text).toContain('<artifacts count="11" shown="8">');
    expect(text).toContain("- a1 (markdown, v1, 8 bytes)");
    expect(text).toContain("- a8 (markdown, v1, 8 bytes)");
    expect(text).not.toContain("- a9 (");
  });

  it("形状不合的条目被跳过而不是让整节消失", async () => {
    const text = await notificationWithReports("dwf-artifacts-malformed", {
      status: "completed",
      artifacts: [
        null,
        "not an object",
        { id: "ok", kind: "file", version: 1, itemCount: 0, versions: [] },
        // version absent ⇒ cannot locate the version; the whole entry is dropped.
        { id: "broken", kind: "file", itemCount: 0, versions: [] },
      ],
    });
    expect(text).toContain('<artifacts count="1">');
    expect(text).toContain("- ok (file, v1)");
    expect(text).not.toContain("broken");
  });

  // The legacy `Workflow` notification stays byte-for-byte unchanged: its `output.response`
  // genuinely exists, and the lost-path launchOutput fallback is its own contract. dwf's
  // revision must not spill onto this path.
  it("legacy Workflow 的通知仍取 output.response 并保留 launchOutput 回退", async () => {
    async function legacyNotification(getTask?: () => Promise<unknown>): Promise<string> {
      const sessionId = createSessionId("legacy-workflow-result");
      const turnId = createTurnId("legacy-workflow-result");
      const events: { payload: Record<string, unknown>; type: string }[] = [];
      const notifications: { text: string }[] = [];
      const tracker = new BackgroundTaskTracker({
        emitEvent: async (event) => {
          events.push({ payload: event.payload as Record<string, unknown>, type: event.type });
        },
        enqueueBackgroundTaskNotification: (notification) => {
          notifications.push(notification);
          return undefined;
        },
        ...(getTask ? { workflowPort: { getTask } } : {}),
        getWorkingDirectory: () => "/tmp",
        getWorkspaceRoot: () => "/tmp",
        readFileState: new Map(),
        runtimeScope: "main",
        sessionId,
      } as never);

      await tracker.trackBackgroundTask(
        { id: "tool_workflow_result", input: { scriptPath: "w.ts" }, name: "Workflow" } as never,
        { backgroundTaskId: "wfrun-1", response: "legacy launch prose", status: "backgrounded" },
        { traceId: "trace_legacy_result", spanId: "span_legacy_result", sessionId, turnId },
        turnId,
      );
      await waitForCondition(() =>
        events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
      );
      return notifications[0]!.text;
    }

    const withResponse = await legacyNotification(async () => ({
      status: "completed",
      runId: "wfrun-1",
      output: { response: "legacy workflow answer" },
      // Even if the port force-feeds a reports field, the legacy notification does not grow a
      // <reports> section: progressive artifacts are a dwf-exclusive concept; the two workflow
      // mechanisms do not share a notification shape.
      reports: ["should not surface"],
      // Same for user-facing artifacts (docs/dynamic-workflow/authoring.md: the legacy `Workflow` notification stays byte-for-byte unchanged).
      artifacts: [
        {
          id: "should-not-surface",
          kind: "file",
          version: 1,
          itemCount: 0,
          versions: [{ version: 1, publishedAt: 1, bytes: 4 }],
        },
      ],
    }));
    expect(withResponse).toContain("<result>legacy workflow answer</result>");
    expect(withResponse).not.toContain("<reports");
    expect(withResponse).not.toContain("should not surface");
    expect(withResponse).not.toContain("<artifacts");
    expect(withResponse).not.toContain("should-not-surface");
    // The presentation guidance block does not belong to legacy either: its notification has no such paragraph.
    expect(withResponse).not.toContain("already in front of the user");

    // Port absent (lost): falls back to the launch output's response — legacy's existing contract, kept verbatim.
    const fallback = await legacyNotification();
    expect(fallback).toContain("<result>legacy launch prose</result>");
  });

  // CreateWorkflow with the port absent: with no snapshot source it is marked lost per the
  // existing semantics instead of hanging in the polling forever.
  it("端口缺席时 CreateWorkflow 立即标记 lost", async () => {
    const sessionId = createSessionId("dwf-no-port");
    const turnId = createTurnId("dwf-no-port");
    const events: { payload: Record<string, unknown>; type: string }[] = [];
    const tracker = new BackgroundTaskTracker({
      emitEvent: async (event) => {
        events.push({ payload: event.payload as Record<string, unknown>, type: event.type });
      },
      getWorkingDirectory: () => "/tmp",
      getWorkspaceRoot: () => "/tmp",
      readFileState: new Map(),
      runtimeScope: "main",
      sessionId,
    } as never);

    await tracker.trackBackgroundTask(
      { id: "tool_cw_lost", input: { script: "" }, name: "CreateWorkflow" } as never,
      { backgroundTaskId: "dwfrun-lost", status: "backgrounded" },
      { traceId: "trace_dwf_lost", spanId: "span_dwf_lost", sessionId, turnId },
      turnId,
    );

    const completed = events.find(
      (event) => event.type === SessionEventType.BackgroundTaskCompleted,
    );
    expect(completed?.payload).toMatchObject({ status: "lost", taskId: "dwfrun-lost" });
  });

  // Regression guard: legacy Workflow's four semantics must not be rewritten by the
  // generalization — it has no cancel capability beyond the snapshot provider, and the started
  // payload's cancellable must remain false.
  it("legacy Workflow 的 cancellable 仍为 false", async () => {
    const sessionId = createSessionId("legacy-workflow-cancellable");
    const turnId = createTurnId("legacy-workflow-cancellable");
    const events: { payload: Record<string, unknown>; type: string }[] = [];
    const tracker = new BackgroundTaskTracker({
      emitEvent: async (event) => {
        events.push({ payload: event.payload as Record<string, unknown>, type: event.type });
      },
      workflowPort: {
        async getTask() {
          return { status: "running", runId: "wfrun-1" };
        },
      },
      getWorkingDirectory: () => "/tmp",
      getWorkspaceRoot: () => "/tmp",
      readFileState: new Map(),
      runtimeScope: "main",
      sessionId,
    } as never);

    await tracker.trackBackgroundTask(
      { id: "tool_workflow_1", input: { scriptPath: "w.ts" }, name: "Workflow" } as never,
      { backgroundTaskId: "wfrun-1", status: "backgrounded" },
      { traceId: "trace_legacy_wf", spanId: "span_legacy_wf", sessionId, turnId },
      turnId,
    );

    const started = events.find((event) => event.type === SessionEventType.BackgroundTaskStarted);
    expect(started?.payload).toMatchObject({ cancellable: false, taskId: "wfrun-1" });
  });

  /**
   * Regression guard: the display-name revision applies only to CreateWorkflow; other tools'
   * `description` stays byte-for-byte unchanged. Bash's existing precedence is
   * `input.description` before `snapshot.description`, with the whole field absent when both are
   * (the panel falls back to the command-line text) — all three cases pinned at once.
   */
  it("Bash 的展示名仍是 input.description 优先于快照，缺席时为 undefined", async () => {
    async function trackBash(input: Record<string, unknown>): Promise<
      { payload: Record<string, unknown>; type: string }[]
    > {
      const sessionId = createSessionId("bash-description-pin");
      const turnId = createTurnId("bash-description-pin");
      const events: { payload: Record<string, unknown>; type: string }[] = [];
      const tracker = new BackgroundTaskTracker({
        emitEvent: async (event) => {
          events.push({ payload: event.payload as Record<string, unknown>, type: event.type });
        },
        executionPort: {
          async run() {
            throw new Error("run should not be called");
          },
          async waitForBackgroundTask() {
            return {
              taskId: "bash_description",
              status: "completed",
              description: "snapshot description",
              startedAt: new Date(0),
              completedAt: new Date(1),
              stdoutTail: "done",
            };
          },
        },
        getWorkingDirectory: () => "/tmp",
        getWorkspaceRoot: () => "/tmp",
        readFileState: new Map(),
        runtimeScope: "main",
        sessionId,
      } as never);

      await tracker.trackBackgroundTask(
        { id: "tool_bash_description", input, name: "Bash" } as never,
        { backgroundTaskId: "bash_description", status: "backgrounded" },
        { traceId: "trace_bash_description", spanId: "span_bash_description", sessionId, turnId },
        turnId,
      );
      await waitForCondition(() =>
        events.some((event) => event.type === SessionEventType.BackgroundTaskCompleted),
      );
      return events;
    }

    const withDescription = await trackBash({ command: "npm run dev", description: "dev server" });
    // started has no snapshot, so it can only come from input; completed has a snapshot, yet input still wins.
    expect(
      withDescription.find((event) => event.type === SessionEventType.BackgroundTaskStarted)
        ?.payload.description,
    ).toBe("dev server");
    expect(
      withDescription.find((event) => event.type === SessionEventType.BackgroundTaskCompleted)
        ?.payload.description,
    ).toBe("dev server");

    const withoutDescription = await trackBash({ command: "npm run dev" });
    expect(
      withoutDescription.find((event) => event.type === SessionEventType.BackgroundTaskStarted)
        ?.payload.description,
    ).toBeUndefined();
    expect(
      withoutDescription.find((event) => event.type === SessionEventType.BackgroundTaskCompleted)
        ?.payload.description,
    ).toBe("snapshot description");
  });
});

/**
 * The only cancel path: `cancelBackgroundWork {workId}` → `app.cancelBackgroundTask` →
 * `runtime.cancelBackgroundTask` → `runtime.stopBackgroundTask` → the port's `cancel(runId)`.
 *
 * This chain dispatches by RuntimeTaskType (runtime/methods/background.ts), a separate dispatch
 * site from the tracker's per-tool-name table. The spec only called out the tracker's five
 * sites; this group tests the chain's second half — without wiring it, `cancellable: true` only
 * yields a button that does nothing when clicked.
 */
describe("dynamic workflow run cancellation", () => {
  it("cancelBackgroundTask 经运行时分派打到端口的 cancel", async () => {
    const sessionId = createSessionId("dwf-cancel-dispatch");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const cancelled: string[] = [];
    const startedAt = new Date(0);

    runtimeTaskRegistry.register({
      agentId: "dwfrun-cancel",
      agentType: "local_dynamic_workflow",
      description: "workflow run",
      isBackgrounded: true,
      startedAt,
      status: "running",
      taskId: "dwfrun-cancel",
      taskType: "local_dynamic_workflow",
      type: "local_dynamic_workflow",
    } as never);
    await eventStore.append(
      createSessionEvent(SessionEventType.BackgroundTaskStarted, sessionId, {
        cancellable: true,
        startedAt,
        status: "running",
        taskId: "dwfrun-cancel",
        terminalId: "dwfrun-cancel",
        toolCallId: "tool_create_workflow",
        toolName: "CreateWorkflow",
      }),
    );

    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        dynamicWorkflowRunPort: {
          async submit() {
            throw new Error("submit should not be called");
          },
          async getTask(taskId: string) {
            return { taskId, status: cancelled.includes(taskId) ? "cancelled" : "running" };
          },
          async waitForTask(taskId: string) {
            return { taskId, status: "cancelled" };
          },
          async cancel(runId: string) {
            cancelled.push(runId);
            return true;
          },
          async listEvents() {
            return [];
          },
        },
        eventStore,
        runtimeTaskRegistry,
      } as never,
    );

    const result = await runtime.cancelBackgroundTask("dwfrun-cancel");

    // The port received the runId (workId ≡ taskId ≡ runId; no identity mapping table).
    expect(cancelled).toEqual(["dwfrun-cancel"]);
    expect(result).toMatchObject({ cancelled: true, status: "cancelled", taskId: "dwfrun-cancel" });
  });

  it("端口对未知 run 返回 false 时归一成 not_found 而不是静默成功", async () => {
    const sessionId = createSessionId("dwf-cancel-unknown");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    runtimeTaskRegistry.register({
      agentId: "dwfrun-gone",
      agentType: "local_dynamic_workflow",
      description: "workflow run",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "running",
      taskId: "dwfrun-gone",
      taskType: "local_dynamic_workflow",
      type: "local_dynamic_workflow",
    } as never);

    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        dynamicWorkflowRunPort: {
          async submit() {
            throw new Error("submit should not be called");
          },
          async getTask() {
            return undefined;
          },
          async waitForTask() {
            return undefined;
          },
          async cancel() {
            return false;
          },
          async listEvents() {
            return [];
          },
        },
        eventStore,
        runtimeTaskRegistry,
      } as never,
    );

    const result = await runtime.cancelBackgroundTask("dwfrun-gone");
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe("background_task_not_found");
  });

  // The port is entirely absent (an unwired host): get a structured "capability unsupported", not a faked successful cancel.
  it("端口缺席时报能力不支持", async () => {
    const sessionId = createSessionId("dwf-cancel-no-port");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    runtimeTaskRegistry.register({
      agentId: "dwfrun-noport",
      agentType: "local_dynamic_workflow",
      description: "workflow run",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "running",
      taskId: "dwfrun-noport",
      taskType: "local_dynamic_workflow",
      type: "local_dynamic_workflow",
    } as never);

    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      { eventStore, runtimeTaskRegistry } as never,
    );

    const result = await runtime.cancelBackgroundTask("dwfrun-noport");
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe("background_task_cancel_not_supported");
  });
});

/**
 * FORK-1's two consequences, one test each.
 *
 * 1. **Reclamation guard**: the runtime task registry is the data source of
 *    `hasRunningBackgroundRuntimeTask`, and that predicate decides whether a resident session is
 *    reclaimed. CreateWorkflow previously had no mapping in `runtimeTaskTypeForToolCall`, so
 *    registerRuntimeBackgroundTask bailed out entirely — an in-flight run would make the session
 *    look idle, and once reclaimed the completion notification would have nowhere to land. This
 *    is harder to debug than "the cancel button does nothing", hence its own test.
 * 2. **Two entries, one implementation**: the GUI's cancelBackgroundWork and the model's
 *    TaskStop both land in runtime.stopBackgroundTask (the latter via backgroundTaskControlPort;
 *    runtime-tools.ts:144 binds exactly the same method), differing only in strictness.
 */
describe("dynamic workflow background task registration", () => {
  async function trackWithRegistry(runtimeTaskRegistry: InMemoryRuntimeTaskRegistry) {
    const sessionId = createSessionId("dwf-registry");
    const turnId = createTurnId("dwf-registry");
    const tracker = new BackgroundTaskTracker({
      emitEvent: async () => {},
      dynamicWorkflowRunPort: {
        async submit() {
          throw new Error("submit should not be called");
        },
        async getTask(taskId: string) {
          return { taskId, runId: taskId, startedAt: new Date(0), status: "running" };
        },
        // Never settles: the run stays in flight for the duration of the test.
        waitForTask: () => new Promise(() => {}),
        async cancel() {
          return true;
        },
        async listEvents() {
          return [];
        },
      },
      getWorkingDirectory: () => "/tmp",
      getWorkspaceRoot: () => "/tmp",
      readFileState: new Map(),
      runtimeScope: "main",
      runtimeTaskRegistry,
      sessionId,
    } as never);

    await tracker.trackBackgroundTask(
      { id: "tool_cw_registry", input: { script: "" }, name: "CreateWorkflow" } as never,
      { backgroundTaskId: "dwfrun-live", status: "backgrounded" },
      { traceId: "trace_dwf_registry", spanId: "span_dwf_registry", sessionId, turnId },
      turnId,
    );
  }

  it("在飞的 run 登记进 registry，回收护栏因此为真", async () => {
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    // Prerequisite: the guard is false when there is no in-flight background task.
    expect(hasRunningBackgroundRuntimeTask(runtimeTaskRegistry)).toBe(false);

    await trackWithRegistry(runtimeTaskRegistry);

    // Registration happened, and the type is the dwf-exclusive one (not legacy local_workflow, and not undefined).
    expect(runtimeTaskRegistry.get("dwfrun-live")).toMatchObject({
      isBackgrounded: true,
      status: "running",
      taskId: "dwfrun-live",
      type: "local_dynamic_workflow",
    });
    // Guard true → a session with an in-flight run will not be reclaimed as idle.
    expect(hasRunningBackgroundRuntimeTask(runtimeTaskRegistry)).toBe(true);
  });

  it("模型侧 TaskStop 与 GUI 侧取消共用 runtime.stopBackgroundTask，同样打到 port.cancel", async () => {
    const sessionId = createSessionId("dwf-taskstop");
    const eventStore = createTestSessionEventStore();
    const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
    const cancelled: string[] = [];
    runtimeTaskRegistry.register({
      agentId: "dwfrun-taskstop",
      agentType: "local_dynamic_workflow",
      description: "workflow run",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "running",
      taskId: "dwfrun-taskstop",
      taskType: "local_dynamic_workflow",
      type: "local_dynamic_workflow",
    } as never);

    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        dynamicWorkflowRunPort: {
          async submit() {
            throw new Error("submit should not be called");
          },
          async getTask(taskId: string) {
            return { taskId, runId: taskId, startedAt: new Date(0), status: "running" };
          },
          async waitForTask(taskId: string) {
            return { taskId, runId: taskId, startedAt: new Date(0), status: "cancelled" };
          },
          async cancel(runId: string) {
            cancelled.push(runId);
            return true;
          },
          async listEvents() {
            return [];
          },
        },
        eventStore,
        runtimeTaskRegistry,
      } as never,
    );

    // This is the exact binding runtime-tools.ts:144 hands to the tool execution context.
    const backgroundTaskControlPort = {
      stopBackgroundTask: runtime.stopBackgroundTask.bind(runtime),
    };
    const output = (await taskStopToolEntry.handler(
      { task_id: "dwfrun-taskstop" },
      { backgroundTaskControlPort, toolCallId: "tool_task_stop" } as never,
    )) as { task_id?: string; task_type?: string };

    // Key assertion: the model-side entry also delivered the runId straight to the port's cancel.
    expect(cancelled).toEqual(["dwfrun-taskstop"]);
    // And what the tool reports to the model is the dwf-exclusive type, not something lumped into bash/legacy workflow.
    expect(output.task_id).toBe("dwfrun-taskstop");
    expect(output.task_type).toBe("local_dynamic_workflow");
  });
});

// The stop branch records "who stopped it" (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Cancel and resume", 2026-09-09): written only on the dwf branch,
// only when the caller supplied an initiator; written before port.cancel.
describe("dwf 停止分支记录 stopInitiator", () => {
  function dwfRuntime(
    name: string,
    cancelled: string[],
  ): {
    runtime: AgentRuntime;
    registry: InMemoryRuntimeTaskRegistry;
  } {
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register({
      agentId: "dwfrun-stop",
      agentType: "local_dynamic_workflow",
      description: "Dynamic workflow run",
      isBackgrounded: true,
      startedAt: new Date(0),
      status: "running",
      taskId: "dwfrun-stop",
      taskType: "local_dynamic_workflow",
      type: "local_dynamic_workflow",
    } as never);
    const runtime = createTestAgentRuntime(
      createSessionId(name),
      { mode: "build" },
      {
        eventStore: createTestSessionEventStore(),
        runtimeTaskRegistry: registry,
        dynamicWorkflowRunPort: {
          async submit() {
            throw new Error("submit should not be called");
          },
          async getTask() {
            return {
              runId: "dwfrun-stop",
              taskId: "dwfrun-stop",
              startedAt: new Date(),
              status: "running",
            };
          },
          async waitForTask() {
            return new Promise(() => undefined);
          },
          async cancel(runId: string) {
            // Assertion order: at abort time the initiator is already on the entry.
            cancelled.push(`${runId}:${registry.get(runId)?.stopInitiator ?? "none"}`);
            return true;
          },
          async listEvents() {
            return [];
          },
        } as never,
      },
    );
    return { runtime, registry };
  }

  it("stopBackgroundTask({initiator}) 在 abort 之前把 initiator 写进条目", async () => {
    const cancelled: string[] = [];
    const { runtime, registry } = dwfRuntime("dwf-stop-model", cancelled);
    await expect(
      (runtime as any).stopBackgroundTask("dwfrun-stop", { initiator: "model", strict: true }),
    ).resolves.toMatchObject({ ok: true, status: "cancelled", type: "local_dynamic_workflow" });
    expect(cancelled).toEqual(["dwfrun-stop:model"]);
    expect(registry.get("dwfrun-stop")?.stopInitiator).toBe("model");
  });

  it("cancelBackgroundTask（GUI 入口）写 user；不带 initiator 的停止不写", async () => {
    const viaGui: string[] = [];
    const gui = dwfRuntime("dwf-stop-user", viaGui);
    await gui.runtime.cancelBackgroundTask("dwfrun-stop");
    expect(viaGui).toEqual(["dwfrun-stop:user"]);
    expect(gui.registry.get("dwfrun-stop")?.stopInitiator).toBe("user");

    const plain: string[] = [];
    const system = dwfRuntime("dwf-stop-system", plain);
    await (system.runtime as any).stopBackgroundTask("dwfrun-stop", {});
    expect(plain).toEqual(["dwfrun-stop:none"]);
    expect(system.registry.get("dwfrun-stop")?.stopInitiator).toBeUndefined();
  });
});
