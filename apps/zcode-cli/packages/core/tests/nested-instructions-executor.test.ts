import { describe, expect, it, vi } from "vitest";
import {
  createFileSystemError,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type FileSystemPort,
  type Logger,
} from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { readNestedInstructionHistory } from "../src/context/nested-instructions/history.js";
import { NestedInstructionTracker } from "../src/context/nested-instructions/tracker.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import type { ToolSchedule } from "../src/tool/scheduler.js";
import { createToolExecutor } from "../src/tool/executor.js";
import type { NestedInstructionContext } from "../src/tool/executor/types.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry } from "../src/tool/types.js";

const ROOT = "/repo";
const FOO_AGENTS = `${ROOT}/packages/foo/AGENTS.md`;
const FILE_TEXT = "file text";

/** Only the stat/readTextFile surface used by discovery; Read itself is replaced by a stub handler. */
class MemoryFileSystem {
  constructor(private readonly files: Record<string, string>) {}

  async stat(request: { path: string }) {
    const content = this.files[request.path];
    if (content === undefined) return { path: request.path, kind: "missing" as const, sizeBytes: 0 };
    return {
      path: request.path,
      kind: "file" as const,
      sizeBytes: Buffer.byteLength(content, "utf8"),
    };
  }

  async readTextFile(request: { path: string; maxBytes?: number }) {
    const content = this.files[request.path];
    if (content === undefined) {
      throw createFileSystemError({ code: "not_found", path: request.path, message: "missing" });
    }
    return {
      path: request.path,
      content,
      encoding: "utf8" as const,
      bytesRead: Buffer.byteLength(content, "utf8"),
      sizeBytes: Buffer.byteLength(content, "utf8"),
      truncated: false,
    };
  }
}

function readEntry(): ToolEntry {
  return {
    capability: "Read stub for nested instruction delivery",
    metadata: {
      name: "Read",
      description: "Read stub",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: 1_000,
      maxOutputBytes: 10_000,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: async () => ({ content: FILE_TEXT }),
    // The model sees the plain file text, as Read does; the object output only satisfies the executor's object schema.
    formatModelContent: (output) => (output as { content: string }).content,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    permission: {
      permission: "read",
      reason: "Read stub",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: { maxInlineBytes: 10_000, maxModelBytes: 10_000, strategy: "truncate" },
    timeout: { defaultMs: 1_000, maxMs: 1_000, allowCallOverride: false },
    cancellation: { supported: false, cleanup: "none", userVisibleMessage: "n/a" },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

function createLogger(): Logger & { debug: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger as unknown as Logger & { debug: ReturnType<typeof vi.fn> };
}

function createHarness(options: {
  files: Record<string, string>;
  nested?: Partial<NestedInstructionContext>;
  /** Mirrors the runtime returning no nested context for an incognito session. */
  nestedDisabled?: boolean;
  logger?: Logger;
  fileSystem?: Partial<FileSystemPort>;
}) {
  const sessionId = createSessionId("nested-exec");
  const turnId = createTurnId("nested-exec");
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const registry = createToolRegistry();
  registry.register(readEntry());

  // History is the owner of "delivered". Tests append each committed result here, as the runtime does.
  const history: RuntimeMessageEntry[] = [];
  const tracker = new NestedInstructionTracker();
  const nestedInstructions: NestedInstructionContext = {
    priorityFiles: ["AGENTS.md"],
    rootSourcePaths: [],
    // Same platform source as the executor helper; discovery and history keys must agree.
    readHistory: () => readNestedInstructionHistory(history, process.platform),
    tracker,
    ...options.nested,
  };
  // Bind explicitly: spreading a class instance would drop its prototype methods.
  const memory = new MemoryFileSystem(options.files);
  const fileSystem = {
    stat: memory.stat.bind(memory),
    readTextFile: memory.readTextFile.bind(memory),
    ...options.fileSystem,
  } as unknown as FileSystemPort;

  const executor = createToolExecutor({
    emitEvent: async () => {},
    hookRunner: { run: async () => ({ additionalContexts: [] }) } as never,
    mode: "build",
    permissionBroker: {
      async requestPermission() {
        return { decision: "allow" as const };
      },
    },
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    turnId,
    traceContext,
    workingDirectory: ROOT,
    workspaceRoot: ROOT,
    fileSystemPort: fileSystem,
    logger: options.logger,
    nestedInstructions: options.nestedDisabled ? undefined : nestedInstructions,
  });

  return { executor, traceContext, history, tracker };
}

function readCall(id: string, filePath: string) {
  return { id: createToolCallId(id), name: "Read", input: { file_path: filePath } };
}

async function runSchedule(
  executor: ReturnType<typeof createToolExecutor>,
  calls: Array<ReturnType<typeof readCall>>,
  traceContext: ReturnType<typeof createRootTraceContext>,
) {
  const schedule: ToolSchedule = {
    items: calls.map((call) => ({
      toolCallId: call.id,
      toolName: "Read",
      dependencies: [],
      canRunParallel: true,
      readOnly: true,
    })),
    parallelGroups: [calls.map((call) => call.id)],
    executionOrder: calls.map((call) => call.id),
  };
  const generator = executor.executeSchedule(calls, schedule, { traceContext });
  let next = await generator.next();
  while (!next.done) next = await generator.next();
  return next.value;
}

/** Text the model would see for one result, including every appended suffix. */
function modelText(result: { modelContent?: unknown; output?: unknown }): string {
  return typeof result.modelContent === "string"
    ? result.modelContent
    : JSON.stringify(result.modelContent ?? result.output ?? "");
}

function countMarkers(text: string): number {
  return (text.match(/\[nested-agents-md path=/g) ?? []).length;
}

describe("nested AGENTS.md delivery through the tool executor", () => {
  it("appends the nested reminder to the Read result of a file in a subfolder", async () => {
    const harness = createHarness({
      files: { [FOO_AGENTS]: "foo rules", [`${ROOT}/packages/foo/src/a.ts`]: "code" },
    });

    const [result] = await runSchedule(
      harness.executor,
      [readCall("r1", `${ROOT}/packages/foo/src/a.ts`)],
      harness.traceContext,
    );

    const text = modelText(result!);
    expect(text).toContain(FILE_TEXT);
    expect(text).toContain("<system-reminder>");
    expect(text).toContain("foo rules");
    expect(countMarkers(text)).toBe(1);
  });

  it("does not add anything for a Read at the workspace root", async () => {
    const harness = createHarness({
      files: { [`${ROOT}/AGENTS.md`]: "root rules", [`${ROOT}/x.ts`]: "code" },
    });

    const [result] = await runSchedule(
      harness.executor,
      [readCall("r1", `${ROOT}/x.ts`)],
      harness.traceContext,
    );

    expect(modelText(result!)).toBe(FILE_TEXT);
  });

  it("delivers a parallel pair of Reads in one folder exactly once", async () => {
    const harness = createHarness({
      files: {
        [FOO_AGENTS]: "foo rules",
        [`${ROOT}/packages/foo/src/a.ts`]: "a",
        [`${ROOT}/packages/foo/src/b.ts`]: "b",
      },
    });

    const results = await runSchedule(
      harness.executor,
      [
        readCall("r1", `${ROOT}/packages/foo/src/a.ts`),
        readCall("r2", `${ROOT}/packages/foo/src/b.ts`),
      ],
      harness.traceContext,
    );

    const total = results.reduce((sum, result) => sum + countMarkers(modelText(result)), 0);
    expect(total).toBe(1);
  });

  it("does not deliver again on a later call once the earlier result is in history", async () => {
    const harness = createHarness({
      files: { [FOO_AGENTS]: "foo rules", [`${ROOT}/packages/foo/src/a.ts`]: "a" },
    });

    const [first] = await runSchedule(
      harness.executor,
      [readCall("r1", `${ROOT}/packages/foo/src/a.ts`)],
      harness.traceContext,
    );
    harness.history.push({
      message: {
        role: "tool",
        toolCallId: "r1",
        content: modelText(first!),
        isError: false,
      } as never,
    });

    const [second] = await runSchedule(
      harness.executor,
      [readCall("r2", `${ROOT}/packages/foo/src/a.ts`)],
      harness.traceContext,
    );

    expect(countMarkers(modelText(first!))).toBe(1);
    expect(countMarkers(modelText(second!))).toBe(0);
  });

  it("leaves the result unchanged when the nested context is disabled (incognito)", async () => {
    const harness = createHarness({
      files: { [FOO_AGENTS]: "foo rules", [`${ROOT}/packages/foo/src/a.ts`]: "a" },
      nestedDisabled: true,
    });

    const [result] = await runSchedule(
      harness.executor,
      [readCall("r1", `${ROOT}/packages/foo/src/a.ts`)],
      harness.traceContext,
    );

    expect(modelText(result!)).toBe(FILE_TEXT);
  });

  it("does not fail the tool call when discovery throws unexpectedly", async () => {
    const logger = createLogger();
    const harness = createHarness({
      files: { [FOO_AGENTS]: "foo rules", [`${ROOT}/packages/foo/src/a.ts`]: "a" },
      logger,
      fileSystem: {
        stat: async () => {
          throw new Error("boom");
        },
      },
    });

    const [result] = await runSchedule(
      harness.executor,
      [readCall("r1", `${ROOT}/packages/foo/src/a.ts`)],
      harness.traceContext,
    );

    expect(result!.success).toBe(true);
    expect(modelText(result!)).toBe(FILE_TEXT);
    // Nested discovery logs at debug only; the executor's own lifecycle info logs are not part of this contract.
    expect(logger.info.mock.calls.filter((call) => String(call[0]).includes("nested"))).toEqual([]);
  });

  it("ignores a Read outside the workspace", async () => {
    const harness = createHarness({
      files: { "/elsewhere/AGENTS.md": "outside", "/elsewhere/x.ts": "x" },
    });

    const [result] = await runSchedule(
      harness.executor,
      [readCall("r1", "/elsewhere/x.ts")],
      harness.traceContext,
    );

    expect(modelText(result!)).toBe(FILE_TEXT);
  });

  it("leaves the tool result unchanged when no executor context is supplied", async () => {
    const registry = createToolRegistry();
    registry.register(readEntry());
    const sessionId = createSessionId("no-context");
    const turnId = createTurnId("no-context");
    const executor = createToolExecutor({
      emitEvent: async () => {},
      mode: "build",
      permissionBroker: {
        async requestPermission() {
          return { decision: "allow" as const };
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      workingDirectory: ROOT,
      workspaceRoot: ROOT,
      fileSystemPort: new MemoryFileSystem({ [FOO_AGENTS]: "foo" }) as unknown as FileSystemPort,
    });

    const result = await executor.execute(readCall("r1", `${ROOT}/packages/foo/a.ts`), {
      traceContext: createRootTraceContext({ sessionId, turnId }),
    });

    expect(modelText(result)).toBe(FILE_TEXT);
  });
});
