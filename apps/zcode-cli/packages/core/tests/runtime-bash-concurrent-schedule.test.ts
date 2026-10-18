import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionId,
  type ExecutionPort,
  type ExecutionRequest,
  type ExecutionResult,
} from "@zcode/contracts";
import { createToolRegistry } from "../src/tool/registry.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const OVERLAP_WAIT_MS = 500;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createRegistry() {
  const registry = createToolRegistry();
  registry.register(bashToolEntry);
  registry.register(readToolEntry);
  return registry;
}

function bashCall(id: string, command: string) {
  return { id, name: "Bash", input: { command } } as any;
}

function createScheduleRuntime(name: string) {
  return createTestAgentRuntime(
    createSessionId(name),
    { mode: "yolo" },
    {
      eventStore: createTestSessionEventStore(),
      toolRegistry: createRegistry(),
      modelFactory: createTestModelFactory({
        async generateText() {
          throw new Error("model should not be called");
        },
      } as never),
    },
  );
}

describe("runtime scheduling of read-only Bash", () => {
  it("groups read-only Bash calls with other concurrency-safe tools", async () => {
    const runtime = createScheduleRuntime("bash-schedule-read-only-group");

    const schedule = await runtime.scheduleTools([
      bashCall("ls", "ls"),
      bashCall("rg", "rg foo src"),
      { id: "read", name: "Read", input: { file_path: "/tmp/example.txt" } } as any,
    ]);

    expect(schedule.parallelGroups).toEqual([["ls", "rg", "read"]]);
    expect(schedule.items[0]).toMatchObject({
      canRunParallel: true,
      concurrentSafe: true,
      readOnly: true,
      sideEffectScope: "none",
    });
  });

  it("keeps mutating Bash calls serial between read-only calls", async () => {
    const runtime = createScheduleRuntime("bash-schedule-mutating-serial");

    const schedule = await runtime.scheduleTools([
      bashCall("ls", "ls"),
      bashCall("install", "npm install"),
      bashCall("pwd", "pwd"),
    ]);

    expect(schedule.parallelGroups).toEqual([["ls"], ["install"], ["pwd"]]);
    expect(schedule.items[1]).toMatchObject({
      canRunParallel: false,
      concurrentSafe: false,
      sideEffectScope: "system",
    });
  });

  it("keeps read-only directory changes serial", async () => {
    const runtime = createScheduleRuntime("bash-schedule-cd-serial");

    const schedule = await runtime.scheduleTools([
      bashCall("cd", "cd src && ls"),
      bashCall("ls", "ls"),
    ]);

    expect(schedule.parallelGroups).toEqual([["cd"], ["ls"]]);
  });

  it("runs read-only Bash calls from one assistant message concurrently", async () => {
    const workingDirectory = await realpath(
      await mkdtemp(join(tmpdir(), "zcode-bash-concurrent-")),
    );
    tempDirs.push(workingDirectory);
    let inFlight = 0;
    let maxInFlight = 0;
    let started = 0;
    let releaseBarrier: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const commands: string[] = [];

    const executionPort: ExecutionPort = {
      async run(request: ExecutionRequest): Promise<ExecutionResult> {
        commands.push(request.command.mode === "shell" ? request.command.command : "");
        inFlight += 1;
        started += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (started === 2) releaseBarrier();
        // A serial executor never starts the second call while the first waits, so bound the wait.
        await Promise.race([
          bothStarted,
          new Promise((resolve) => setTimeout(resolve, OVERLAP_WAIT_MS)),
        ]);
        inFlight -= 1;
        const now = new Date();
        return {
          status: "completed",
          exitCode: 0,
          stdout: { text: "ok", bytes: 2, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: now,
          completedAt: now,
          resolvedCwd: request.cwd,
        };
      },
    };

    let modelCalls = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("bash-concurrent-execution"),
      { mode: "yolo", workingDirectory },
      {
        eventStore: createTestSessionEventStore(),
        executionPort,
        toolRegistry: createRegistry(),
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCalls += 1;
            if (modelCalls === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [bashCall("bash-ls", "ls"), bashCall("bash-rg", "rg foo")],
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

    await runtime.executeTurn("list files");

    expect(commands).toHaveLength(2);
    expect(maxInFlight).toBe(2);
    // The cwd policy may report the logical form of a symlinked temp dir (macOS /var -> /private/var).
    expect(await realpath((runtime as any).workingDirectory)).toBe(workingDirectory);
  });

  it("keeps a hook-rewritten directory change when a parallel sibling finishes last", async () => {
    const workingDirectory = await realpath(await mkdtemp(join(tmpdir(), "zcode-bash-cwd-race-")));
    tempDirs.push(workingDirectory);
    const subdirectory = join(workingDirectory, "src");
    await mkdir(subdirectory);
    let releaseDirectoryChange: () => void = () => {};
    const directoryChangeDone = new Promise<void>((resolve) => {
      releaseDirectoryChange = resolve;
    });

    const executionPort: ExecutionPort = {
      async run(request: ExecutionRequest): Promise<ExecutionResult> {
        const command = request.command.mode === "shell" ? request.command.command : "";
        const changesDirectory = command.startsWith("cd src");
        // Force the unchanged sibling to finish after the directory change.
        if (changesDirectory) releaseDirectoryChange();
        else await directoryChangeDone;
        const now = new Date();
        return {
          status: "completed",
          exitCode: 0,
          stdout: { text: "ok", bytes: 2, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: now,
          completedAt: now,
          resolvedCwd: changesDirectory ? subdirectory : request.cwd,
        };
      },
    };

    let modelCalls = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("bash-hook-rewrite-cwd-race"),
      { mode: "yolo", workingDirectory },
      {
        eventStore: createTestSessionEventStore(),
        executionPort,
        hookRunner: {
          async run(input: unknown) {
            const hookInput = input as { hookEventName?: string; toolCallId?: string };
            return {
              additionalContexts: [],
              ...(hookInput.hookEventName === "PreToolUse" && hookInput.toolCallId === "bash-first"
                ? { updatedInput: { command: "cd src && pwd" } }
                : {}),
            };
          },
        },
        toolRegistry: createRegistry(),
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCalls += 1;
            if (modelCalls === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [bashCall("bash-first", "pwd"), bashCall("bash-second", "pwd")],
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

    await runtime.executeTurn("print the directory twice");

    expect(await realpath((runtime as any).workingDirectory)).toBe(subdirectory);
  });
});
