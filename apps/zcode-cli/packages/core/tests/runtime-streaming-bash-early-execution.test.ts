import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionEventType,
  createSessionId,
  type ExecutionPort,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionRunOptions,
} from "@zcode/contracts";
import { createToolRegistry } from "../src/tool/registry.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { isToolCallEligibleDuringStream } from "../src/runtime/methods/streaming-tool-eligibility.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// Upper bound for "did the call start before finish"; an eligible call starts within one tick.
const EARLY_START_WAIT_MS = 1_000;
const NOT_STARTED_WAIT_MS = 150;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function deferred<T = void>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);
}

function bashCall(id: string, command: string, extra: Record<string, unknown> = {}) {
  return { id, name: "Bash", input: { command, ...extra } };
}

function completedResult(request: ExecutionRequest, status: "completed" | "cancelled") {
  const now = new Date();
  return {
    status,
    exitCode: status === "completed" ? 0 : null,
    stdout: { text: "ok", bytes: 2, truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    durationMs: 1,
    timedOut: false,
    cancelled: status === "cancelled",
    startedAt: now,
    completedAt: now,
    resolvedCwd: request.cwd,
  } as ExecutionResult;
}

interface PortControl {
  commands: string[];
  firstStarted: Promise<void>;
  firstCompleted: Promise<void>;
  /** When set, a run waits for its abort signal and returns a cancelled result. */
  holdUntilAbort?: boolean;
}

function createExecutionPort(control: { holdUntilAbort?: boolean } = {}): {
  port: ExecutionPort;
  state: PortControl;
} {
  const started = deferred();
  const completed = deferred();
  const state: PortControl = {
    commands: [],
    firstStarted: started.promise,
    firstCompleted: completed.promise,
    holdUntilAbort: control.holdUntilAbort,
  };
  const port: ExecutionPort = {
    async run(request: ExecutionRequest, options?: ExecutionRunOptions) {
      state.commands.push(request.command.mode === "shell" ? request.command.command : "");
      started.resolve();
      if (state.holdUntilAbort) {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) return resolve();
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        completed.resolve();
        return completedResult(request, "cancelled");
      }
      completed.resolve();
      return completedResult(request, "completed");
    },
  };
  return { port, state };
}

function retryableStreamError(): Error {
  const error = new Error("Provider stream failed with ECONNRESET.") as Error & {
    code?: string;
    context?: Record<string, unknown>;
  };
  error.code = "model_network_error";
  error.context = { reason: "network_error", retryable: true };
  return error;
}

async function createFixture(options: {
  name: string;
  mode: "build" | "yolo" | "guarded";
  toolCalls: ReturnType<typeof bashCall>[];
  /** Runs after the tool calls were emitted and before the first stream ends. */
  midStream?: (state: PortControl) => Promise<void>;
  failFirstStream?: boolean;
  holdUntilAbort?: boolean;
  maxConcurrency?: number;
}) {
  const workingDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "zcode-stream-bash-early-")),
  );
  tempDirs.push(workingDirectory);
  const { port, state } = createExecutionPort({ holdUntilAbort: options.holdUntilAbort });
  const registry = createToolRegistry();
  registry.register(bashToolEntry);
  registry.register(readToolEntry);
  const eventStore = createTestSessionEventStore();
  const sessionId = createSessionId(options.name);
  const requests: any[] = [];
  const runtime = createTestAgentRuntime(
    sessionId,
    {
      mode: options.mode,
      modelStreaming: "on",
      workingDirectory,
      ...(options.maxConcurrency
        ? { toolConcurrency: { maxConcurrency: options.maxConcurrency } }
        : {}),
    },
    {
      eventStore,
      executionPort: port,
      toolRegistry: registry,
      modelFactory: createTestModelFactory({
        async generateText() {
          throw new Error("streaming path expected");
        },
        async *streamText(request: any) {
          requests.push(request);
          if (requests.length === 1) {
            for (const toolCall of options.toolCalls) {
              yield { type: "tool_call", toolCall };
            }
            await options.midStream?.(state);
            if (options.failFirstStream) throw retryableStreamError();
            yield { type: "finish", finishReason: "tool-calls", usage: {} };
            return;
          }
          yield { type: "text_delta", text: "done" };
          yield { type: "finish", finishReason: "stop", usage: {} };
        },
      } as never),
    },
  );
  return { runtime, state, requests, eventStore, sessionId };
}

describe("streaming early execution of read-only Bash", () => {
  it("starts a read-only Bash call before the stream finishes without a permission prompt", async () => {
    let startedBeforeFinish: unknown;
    const fixture = await createFixture({
      name: "stream-bash-early-read-only",
      mode: "build",
      toolCalls: [bashCall("bash-ls", "ls")],
      async midStream(state) {
        startedBeforeFinish = await within(state.firstStarted, EARLY_START_WAIT_MS);
      },
    });

    const result = await fixture.runtime.executeTurn("list files");
    const events = await fixture.eventStore.getEvents(fixture.sessionId);

    expect(result.response).toBe("done");
    expect(startedBeforeFinish).not.toBe("timeout");
    expect(fixture.state.commands).toEqual(["ls"]);
    expect(events.map((event) => event.type)).not.toContain(SessionEventType.PermissionRequested);
    const ledger = events
      .filter((event) => event.type === SessionEventType.StreamingToolLedgerUpdated)
      .map((event) => event.payload as any);
    expect(ledger.find((payload) => payload.status === "tool_started")).toMatchObject({
      concurrentSafe: true,
      executionTiming: "during_stream",
      readOnly: true,
      sideEffectScope: "none",
    });
  });

  it.each([
    { label: "mutating", command: "npm install" },
    { label: "directory-changing", command: "cd src && ls" },
  ])("keeps a $label Bash call until the stream finishes", async ({ command }) => {
    let startedBeforeFinish: unknown;
    const fixture = await createFixture({
      name: `stream-bash-early-${command.replace(/\W+/g, "-")}`,
      mode: "yolo",
      toolCalls: [bashCall("bash-1", command)],
      async midStream(state) {
        startedBeforeFinish = await within(state.firstStarted, NOT_STARTED_WAIT_MS);
      },
    });

    await fixture.runtime.executeTurn("run a command");

    expect(startedBeforeFinish).toBe("timeout");
    expect(fixture.state.commands).toEqual([command]);
  });

  it("does not start a read-only call declared after an ineligible call", async () => {
    let startedBeforeFinish: unknown;
    const fixture = await createFixture({
      name: "stream-bash-early-prefix-barrier",
      mode: "yolo",
      toolCalls: [bashCall("bash-build", "npm run build"), bashCall("bash-ls", "ls dist")],
      async midStream(state) {
        startedBeforeFinish = await within(state.firstStarted, NOT_STARTED_WAIT_MS);
      },
    });

    await fixture.runtime.executeTurn("build then list");

    expect(startedBeforeFinish).toBe("timeout");
    expect(fixture.state.commands).toEqual(["npm run build", "ls dist"]);
  });

  it("starts at most maxConcurrency calls early and runs the rest after the stream", async () => {
    let startedBeforeFinish: string[] = [];
    const fixture = await createFixture({
      name: "stream-bash-early-concurrency-cap",
      mode: "build",
      maxConcurrency: 2,
      toolCalls: [bashCall("ls-1", "ls a"), bashCall("ls-2", "ls b"), bashCall("ls-3", "ls c")],
      async midStream(state) {
        await within(state.firstStarted, EARLY_START_WAIT_MS);
        await new Promise((resolve) => setTimeout(resolve, NOT_STARTED_WAIT_MS));
        startedBeforeFinish = [...state.commands];
      },
    });

    await fixture.runtime.executeTurn("list three directories");

    expect(startedBeforeFinish.sort()).toEqual(["ls a", "ls b"]);
    expect(fixture.state.commands).toHaveLength(3);
    expect(fixture.state.commands.at(-1)).toBe("ls c");
  });

  it("commits a completed early Bash result once and retries the stream from it", async () => {
    const fixture = await createFixture({
      name: "stream-bash-early-retry-completed",
      mode: "build",
      toolCalls: [bashCall("bash-ls", "ls")],
      failFirstStream: true,
      async midStream(state) {
        await within(state.firstCompleted, EARLY_START_WAIT_MS);
      },
    });

    const result = await fixture.runtime.executeTurn("list files");

    expect(result.response).toBe("done");
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.state.commands).toEqual(["ls"]);
    const retryMessages = fixture.requests[1].messages;
    expect(retryMessages.find((message: any) => message.role === "assistant")).toMatchObject({
      toolCalls: [{ id: "bash-ls", name: "Bash" }],
    });
    expect(retryMessages.filter((message: any) => message.role === "tool")).toEqual([
      expect.objectContaining({ toolCallId: "bash-ls", toolName: "Bash" }),
    ]);
  });

  it("aborts an in-flight early Bash on stream failure and never re-runs it", async () => {
    const fixture = await createFixture({
      name: "stream-bash-early-retry-in-flight",
      mode: "build",
      toolCalls: [bashCall("bash-ls", "ls")],
      failFirstStream: true,
      holdUntilAbort: true,
      async midStream(state) {
        await within(state.firstStarted, EARLY_START_WAIT_MS);
      },
    });

    const result = await fixture.runtime.executeTurn("list files");

    expect(result.response).toBe("done");
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.state.commands).toEqual(["ls"]);
    expect(fixture.requests[1].messages.filter((message: any) => message.role === "tool")).toEqual([
      expect.objectContaining({ toolCallId: "bash-ls" }),
    ]);
  });
});

describe("isToolCallEligibleDuringStream", () => {
  async function eligibility(
    mode: "build" | "guarded" | "plan",
    toolCalls: { id: string; name: string; input: unknown }[],
  ) {
    const fixture = await createFixture({
      name: `stream-bash-eligibility-${mode}`,
      mode,
      toolCalls: [],
    });
    const runtime = fixture.runtime as unknown as AgentRuntimeInternal;
    return toolCalls.map((toolCall) => isToolCallEligibleDuringStream(runtime, toolCall as never));
  }

  it("accepts read-only Bash and Read in build and plan mode", async () => {
    for (const mode of ["build", "plan"] as const) {
      expect(
        await eligibility(mode, [
          bashCall("ls", "ls -la"),
          bashCall("rg", "rg foo src"),
          bashCall("git-status", "git status"),
          bashCall("git-diff", "git diff"),
          { id: "read", name: "Read", input: { file_path: "/tmp/a.txt" } },
        ]),
      ).toEqual([true, true, true, true, true]);
    }
  });

  it("rejects mutating, directory-changing and background Bash", async () => {
    expect(
      await eligibility("build", [
        bashCall("install", "npm install"),
        bashCall("cd", "cd src && ls"),
        bashCall("pushd", "pushd src && ls"),
        bashCall("bg", "ls", { run_in_background: true }),
      ]),
    ).toEqual([false, false, false, false]);
  });

  it("keeps read-only Bash eligible in Guarded mode", async () => {
    expect(
      await eligibility("guarded", [bashCall("rm", "rm -rf /"), bashCall("ls", "ls")]),
    ).toEqual([false, true]);
  });
});
