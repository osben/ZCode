import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile as writeRealFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  createModelId,
  createModelProviderId,
  createProjectId,
  createRootTraceContext,
  createSessionId,
  createTurnId,
  createWorkspaceId,
  type MessageInfo,
  type MessagePart,
  type MessageWithParts,
  type ModelInvocationContext,
  type ModelRequest,
  type ModelResult,
  type ModelSelection,
  type SessionInfo,
  type SessionStorePort,
} from "@zcode/contracts";

import { resolveProjectMemoryRoot } from "../src/memory/project-root.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import {
  runProjectMemoryDream,
  selectProjectDreamSessions,
} from "../src/runtime/helpers/project-memory-dream.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { MemoryFileSystem } from "./memory-test-utils.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const WORKSPACE_PATH = "/workspace/project";
const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const MEMORY_UPDATE_FIXTURE = readFileSync(
  new URL("./fixtures/memory/memory-update.md", import.meta.url),
  "utf8",
).trimEnd();
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Dream session selection", () => {
  it("keeps Main-equivalent sessions from the current workspace and leaves recency to transcript mtime", () => {
    const current = createSessionId("current");
    const workspaceIdentity = createWorkspaceId("remote:opaque");
    const sessions = [
      session("one", NOW, { workspaceID: workspaceIdentity }),
      session("two", NOW - 1, { taskType: "fork", workspaceID: workspaceIdentity }),
      session("child", NOW, { taskType: "subagent_child", workspaceID: workspaceIdentity }),
      session("other", NOW, { workspaceID: createWorkspaceId("remote:other") }),
      session("old", NOW - 10_000, { workspaceID: workspaceIdentity }),
      session("current", NOW, { workspaceID: workspaceIdentity }),
    ];

    expect(
      selectProjectDreamSessions({
        currentSessionId: current,
        sessions,
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity,
      }).map((item) => item.id),
    ).toEqual([createSessionId("one"), createSessionId("two"), createSessionId("old")]);
  });
});

describe("AgentRuntime Dream handler", () => {
  it("consumes a Dream update at the next Main request in the same tool loop", async () => {
    const mainRequestTexts: string[] = [];
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "CompleteMemoryUpdateBoundary",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => "tool complete",
    });
    let runtime!: AgentRuntime;
    runtime = createTestAgentRuntime(
      createSessionId("same-turn-memory-update"),
      {
        memory: {
          cliStorageRoot: "/storage/cli",
          enabled: true,
          use: true,
        },
        mode: "yolo",
        workingDirectory: WORKSPACE_PATH,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort: new MemoryFileSystem({}),
        modelFactory: createTestModelFactory({
          properties: { supportsMidConversationSystem: true },
          async generateText(request, observation) {
            mainRequestTexts.push(providerMessagesToText(request.messages));
            if (mainRequestTexts.length === 1) {
              (runtime as any).pendingMemoryUpdate = {
                inContextPaths: [],
                paths: ["/memory/fact.md"],
                source: "dream",
                summary: "consolidated 1 memory file",
              };
              return {
                ...textResult(observation.model, ""),
                finishReason: "tool_calls",
                toolCalls: [
                  { id: "memory-update-boundary", input: {}, name: "CompleteMemoryUpdateBoundary" },
                ],
              };
            }
            return textResult(observation.model, "done");
          },
        }),
        toolRegistry: registry,
      },
    );

    await runtime.executeTurn("please check the updated memory");

    expect(mainRequestTexts).toHaveLength(2);
    expect(mainRequestTexts[0]).not.toContain("Background memory consolidation updated");
    expect(mainRequestTexts[1]).toContain(
      "Background memory consolidation updated your memory directory: consolidated 1 memory file",
    );
    expect((runtime as any).pendingMemoryUpdate).toBeUndefined();
  });

  it("is not auto-triggered and uses newer transcript mtimes when explicitly invoked", async () => {
    const cliStorageRoot = await temporaryDirectory();
    const modelIoDir = join(cliStorageRoot, "rollout");
    const memoryRoot = resolveProjectMemoryRoot({
      cliStorageRoot,
      workspacePath: WORKSPACE_PATH,
    });
    const factPath = join(memoryRoot, "release-tagging-policy.md");
    const indexPath = join(memoryRoot, "MEMORY.md");
    const pastSessions = Array.from({ length: 6 }, (_, index) =>
      session(`past-${index + 1}`, NOW - index),
    );
    const transcriptFiles = Object.fromEntries(
      pastSessions.map((pastSession) => [
        join(modelIoDir, `model-io-${pastSession.id}.jsonl`),
        "{}\n",
      ]),
    );
    const transcriptMtimes = Object.fromEntries(
      pastSessions.map((pastSession, index) => [
        join(modelIoDir, `model-io-${pastSession.id}.jsonl`),
        index < 5 ? NOW : 0,
      ]),
    );
    const fileSystemPort = new MemoryFileSystem(transcriptFiles, transcriptMtimes);
    const dreamResponseSeen = deferred<void>();
    const mainRequests: ModelRequest["messages"][] = [];
    const mainRequestTexts: string[] = [];
    let dreamTurn = 0;
    const dreamContexts: ModelInvocationContext[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("current-dream"),
      {
        memory: {
          cliStorageRoot,
          enabled: true,
          use: true,
        },
        mode: "yolo",
        modelSelection: {
          modelId: createModelId("claude-opus-4-8-cc"),
          providerId: createModelProviderId("anthropic"),
        },
        workingDirectory: WORKSPACE_PATH,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort,
        modelFactory: createTestModelFactory({
          properties: { supportsMidConversationSystem: true },
          async generateText(request, observation) {
            const text = providerMessagesToText(request.messages);
            if (!text.includes("# Dream: Memory Consolidation")) {
              mainRequests.push(request.messages);
              mainRequestTexts.push(text);
              return textResult(observation.model, `main ${mainRequestTexts.length}`);
            }
            dreamTurn += 1;
            dreamContexts.push(observation.invocationContext!);
            if (dreamTurn === 1) {
              for (const pastSession of pastSessions.slice(0, 5)) {
                expect(text).toContain(String(pastSession.id));
              }
              expect(text).not.toContain(String(pastSessions[5]!.id));
              return {
                ...textResult(observation.model, ""),
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "write-fact",
                    name: "Write",
                    input: { file_path: factPath, content: "fact" },
                  },
                  {
                    id: "write-index",
                    name: "Write",
                    input: { file_path: indexPath, content: "- [Fact](release-tagging-policy.md)" },
                  },
                ],
              };
            }
            dreamResponseSeen.resolve();
            return textResult(observation.model, "Dream complete");
          },
        }),
        modelIoDir,
        now: () => new Date(NOW),
        sessionStore: createMemorySessionStore(pastSessions),
        toolRegistry: createToolRegistry(),
      },
    );
    const recallState = (runtime as any).memoryRecallState;
    recallState.manifest = [
      {
        filePath: "/old-memory.md",
        filename: "old-memory.md",
        mtimeMs: 1,
      },
    ];
    recallState.selectorMessages = [{ role: "user", content: "old manifest" }];
    recallState.recalledContentCharacters = 123;

    await runtime.executeTurn("start");
    expect(dreamTurn).toBe(0);
    await runProjectMemoryDream(runtime as never, {
      traceContext: createRootTraceContext({
        sessionId: createSessionId("current-dream"),
        turnId: createTurnId("explicit-dream-handler"),
      }),
    });
    await dreamResponseSeen.promise;
    await waitFor(() => (runtime as any).pendingMemoryUpdate !== undefined);
    expect(dreamContexts).toHaveLength(2);
    for (const context of dreamContexts) {
      expect(context).toMatchObject({
        modelRequestSessionType: "main",
        metadata: { querySource: "project_memory_dream", skipTranscript: true },
      });
    }

    expect(fileSystemPort.files[factPath]).toBe("fact");
    expect(fileSystemPort.files[indexPath]).toContain("[Fact]");
    expect(recallState.manifest).toBeUndefined();
    expect(recallState.selectorMessages).toBeUndefined();
    expect(recallState.recalledContentCharacters).toBe(123);

    await runtime.executeTurn("next");
    const expectedUpdate = MEMORY_UPDATE_FIXTURE.replaceAll("<MEMORY_ROOT>", memoryRoot);
    const nextRequest = mainRequests[1] ?? [];
    const updateIndex = nextRequest.findIndex(
      (message) => message.role === "system" && message.content === expectedUpdate,
    );
    expect(updateIndex).toBe(nextRequest.length - 1);
    expect(nextRequest[updateIndex]).toEqual({ role: "system", content: expectedUpdate });
    expect((runtime as any).pendingMemoryUpdate).toBeUndefined();

    await runtime.executeTurn("again");
    expect(mainRequestTexts[2]).not.toContain("Background memory consolidation updated");
    expect(dreamTurn).toBe(2);
  });

  it("requires five transcript files newer than the last consolidation", async () => {
    const cliStorageRoot = await temporaryDirectory();
    const modelIoDir = join(cliStorageRoot, "rollout");
    const pastSessions = Array.from({ length: 5 }, (_, index) =>
      session(`gate-${index + 1}`, NOW - index),
    );
    const fileSystemPort = new MemoryFileSystem(
      Object.fromEntries(
        pastSessions
          .slice(0, 2)
          .map((pastSession) => [join(modelIoDir, `model-io-${pastSession.id}.jsonl`), "{}\n"]),
      ),
      Object.fromEntries(
        pastSessions
          .slice(0, 2)
          .map((pastSession) => [join(modelIoDir, `model-io-${pastSession.id}.jsonl`), NOW]),
      ),
    );
    let dreamRequests = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("dream-gate"),
      {
        memory: { cliStorageRoot, enabled: true, use: true },
        mode: "yolo",
        workingDirectory: WORKSPACE_PATH,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            dreamRequests += 1;
            return textResult(observation.model, "unexpected");
          },
        }),
        modelIoDir,
        now: () => new Date(NOW),
        sessionStore: createMemorySessionStore(pastSessions),
        toolRegistry: createToolRegistry(),
      },
    );

    await runProjectMemoryDream(runtime as never, {
      traceContext: createRootTraceContext({
        sessionId: createSessionId("dream-gate"),
        turnId: createTurnId("dream-gate-check"),
      }),
    });

    expect(dreamRequests).toBe(0);
  });
});

describe("Manual /dream command", () => {
  it("runs the dream from a command turn and reports the agent summary", async () => {
    const cliStorageRoot = await temporaryDirectory();
    const modelIoDir = join(cliStorageRoot, "rollout");
    const memoryRoot = resolveProjectMemoryRoot({
      cliStorageRoot,
      workspacePath: WORKSPACE_PATH,
    });
    const factPath = join(memoryRoot, "release-tagging-policy.md");
    const pastSessions = Array.from({ length: 5 }, (_, index) =>
      session(`manual-${index + 1}`, NOW - index),
    );
    const fileSystemPort = new MemoryFileSystem(
      Object.fromEntries(
        pastSessions.map((pastSession) => [
          join(modelIoDir, `model-io-${pastSession.id}.jsonl`),
          "{}\n",
        ]),
      ),
      Object.fromEntries(
        pastSessions.map((pastSession) => [
          join(modelIoDir, `model-io-${pastSession.id}.jsonl`),
          NOW,
        ]),
      ),
    );
    let dreamTurn = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("manual-dream"),
      {
        memory: { cliStorageRoot, enabled: true, use: true },
        mode: "yolo",
        workingDirectory: WORKSPACE_PATH,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort,
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const text = providerMessagesToText(request.messages);
            if (!text.includes("# Dream: Memory Consolidation")) {
              throw new Error(`unexpected non-dream model request: ${text.slice(0, 80)}`);
            }
            dreamTurn += 1;
            if (dreamTurn === 1) {
              return {
                ...textResult(observation.model, ""),
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    id: "write-fact",
                    name: "Write",
                    input: { file_path: factPath, content: "fact" },
                  },
                ],
              };
            }
            return textResult(observation.model, "Dream complete");
          },
        }),
        modelIoDir,
        now: () => new Date(NOW),
        sessionStore: createMemorySessionStore(pastSessions),
        toolRegistry: createToolRegistry(),
      },
    );

    const result = await runtime.executeTurn("/dream");

    expect(dreamTurn).toBe(2);
    expect(result.response).toContain("Dream complete");
    expect(result.response).toContain(factPath);
    expect(fileSystemPort.files[factPath]).toBe("fact");
    const startedEvent = result.events.find((event) => event.type === "turn_started");
    expect(
      (startedEvent?.payload as { inputVisibility?: string } | undefined)?.inputVisibility,
    ).toBe("model-only");
    // V4 clients do not render TurnComplete.response; the result must also be a streaming sequence.
    const streamedText = result.events
      .filter((event) => event.type === "model_streaming")
      .map((event) => (event.payload as { delta?: string }).delta ?? "")
      .join("");
    expect(streamedText).toBe(result.response);
    const modelComplete = result.events.find((event) => event.type === "model_complete");
    expect(
      (modelComplete?.payload as { querySource?: string; content?: string } | undefined),
    ).toMatchObject({ content: result.response, querySource: "dream" });
    // A completed run stamps the success marker; the lock alone only marks the run start.
    await expect(stat(join(memoryRoot, ".consolidated-at"))).resolves.toBeTruthy();
  });

  it("bypasses the 24 hour gate and runs with a single fresh transcript", async () => {
    const cliStorageRoot = await temporaryDirectory();
    const modelIoDir = join(cliStorageRoot, "rollout");
    const memoryRoot = resolveProjectMemoryRoot({
      cliStorageRoot,
      workspacePath: WORKSPACE_PATH,
    });
    // A recent lock (mtime just before NOW) would make the auto gate skip for the next 24 hours;
    // its dead PID lets the manual run take the lock over.
    await mkdir(memoryRoot, { recursive: true });
    const lockPath = join(memoryRoot, ".consolidate-lock");
    await writeRealFile(lockPath, "99999999", "utf8");
    await utimes(lockPath, (NOW - 1000) / 1000, (NOW - 1000) / 1000);
    const pastSessions = [session("manual-single", NOW)];
    const fileSystemPort = new MemoryFileSystem(
      { [join(modelIoDir, `model-io-${pastSessions[0]!.id}.jsonl`)]: "{}\n" },
      { [join(modelIoDir, `model-io-${pastSessions[0]!.id}.jsonl`)]: NOW },
    );
    let dreamTurn = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("manual-dream-single"),
      {
        memory: { cliStorageRoot, enabled: true, use: true },
        mode: "yolo",
        workingDirectory: WORKSPACE_PATH,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort,
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const text = providerMessagesToText(request.messages);
            if (!text.includes("# Dream: Memory Consolidation")) {
              throw new Error(`unexpected non-dream model request: ${text.slice(0, 80)}`);
            }
            dreamTurn += 1;
            return textResult(observation.model, "Nothing worth keeping");
          },
        }),
        modelIoDir,
        now: () => new Date(NOW),
        sessionStore: createMemorySessionStore(pastSessions),
        toolRegistry: createToolRegistry(),
      },
    );

    const result = await runtime.executeTurn("/dream");

    expect(dreamTurn).toBe(1);
    expect(result.response).toContain("Nothing worth keeping");
  });

  it("answers a usage error without model requests", async () => {
    const { runtime, modelRequests } = await createSkipSetup({
    });

    const result = await runtime.executeTurn("/dream now");

    expect(modelRequests()).toBe(0);
    expect(result.response).toBe(
      "Usage: /dream — takes no arguments. Run /dream to consolidate project memory now.",
    );
  });

  it("answers visibly when memory is disabled", async () => {
    const { runtime, modelRequests } = await createSkipSetup({
      memoryEnabled: false,
    });

    const result = await runtime.executeTurn("/dream");

    expect(modelRequests()).toBe(0);
    expect(result.response).toBe(
      "Dream skipped: project memory is not enabled for this workspace.",
    );
  });

  it("answers visibly when the lock is held by a live pid", async () => {
    const { runtime, modelRequests } = await createSkipSetup({
      seedLock: { pid: process.pid, mtimeMs: NOW },
      transcriptMtime: NOW + 1000,
    });

    const result = await runtime.executeTurn("/dream");

    expect(modelRequests()).toBe(0);
    expect(result.response).toBe(
      "Dream skipped: another dream is already running for this workspace. Try again once it finishes.",
    );
  });

  it("answers visibly when no transcript is newer than the last consolidation", async () => {
    const { runtime, modelRequests } = await createSkipSetup({
      transcriptMtime: 0,
      seedLock: { pid: 99999999, mtimeMs: NOW - 2000 },
    });

    const result = await runtime.executeTurn("/dream");

    expect(modelRequests()).toBe(0);
    expect(result.response).toBe(
      "Dream skipped: no new session activity since the last dream — nothing to consolidate yet.",
    );
  });

  async function createSkipSetup(options: {
    memoryEnabled?: boolean;
    seedLock?: { pid: number; mtimeMs: number };
    transcriptMtime?: number;
  }): Promise<{ runtime: ReturnType<typeof createTestAgentRuntime>; modelRequests: () => number }> {
    const cliStorageRoot = await temporaryDirectory();
    const modelIoDir = join(cliStorageRoot, "rollout");
    const memoryRoot = resolveProjectMemoryRoot({
      cliStorageRoot,
      workspacePath: WORKSPACE_PATH,
    });
    if (options.seedLock) {
      await mkdir(memoryRoot, { recursive: true });
      const lockPath = join(memoryRoot, ".consolidate-lock");
      await writeRealFile(lockPath, String(options.seedLock.pid), "utf8");
      await utimes(lockPath, options.seedLock.mtimeMs / 1000, options.seedLock.mtimeMs / 1000);
    }
    const pastSessions = [session("skip", NOW)];
    const transcriptPath = join(modelIoDir, `model-io-${pastSessions[0]!.id}.jsonl`);
    const fileSystemPort = new MemoryFileSystem(
      { [transcriptPath]: "{}\n" },
      { [transcriptPath]: options.transcriptMtime ?? NOW },
    );
    let requests = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("manual-dream-skip"),
      {
        memory: {
          cliStorageRoot,
          enabled: options.memoryEnabled ?? true,
          use: true,
        },
        mode: "yolo",
        workingDirectory: WORKSPACE_PATH,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            requests += 1;
            return textResult(observation.model, "unexpected");
          },
        }),
        modelIoDir,
        now: () => new Date(NOW),
        sessionStore: createMemorySessionStore(pastSessions),
        toolRegistry: createToolRegistry(),
      },
    );
    return { runtime, modelRequests: () => requests };
  }
});

function session(
  id: string,
  updated: number,
  options: Partial<Pick<SessionInfo, "directory" | "taskType" | "workspaceID">> = {},
): SessionInfo {
  return {
    id: id.startsWith("sess_") ? createSessionId(id) : createSessionId(id),
    directory: options.directory ?? WORKSPACE_PATH,
    projectID: createProjectId("project"),
    slug: id,
    taskType: options.taskType ?? "interactive",
    time: { created: updated, updated },
    title: id,
    version: "test",
    workspaceID: options.workspaceID,
  };
}

function createMemorySessionStore(seedSessions: SessionInfo[]): SessionStorePort {
  const messages = new Map<string, MessageInfo>();
  const parts = new Map<string, MessagePart>();
  let currentSession: SessionInfo | null = null;
  return {
    async createSession(input) {
      currentSession = {
        ...input,
        taskType: input.taskType ?? "interactive",
        time: { created: NOW, updated: NOW },
      };
      return currentSession;
    },
    async getProjectPermission() {
      return null;
    },
    async getSession() {
      return currentSession;
    },
    async listSessions() {
      return currentSession ? [currentSession, ...seedSessions] : [...seedSessions];
    },
    async messages(input): Promise<MessageWithParts[]> {
      return [...messages.values()]
        .filter((message) => message.sessionID === input.sessionID)
        .map((info) => ({
          info,
          parts: [...parts.values()].filter((part) => part.messageID === info.id),
        }));
    },
    async readTarget() {
      return null;
    },
    async readTodos() {
      return [];
    },
    async saveMessage(input) {
      messages.set(input.id, input);
    },
    async savePart(input) {
      parts.set(input.id, input);
    },
  } as SessionStorePort;
}

function textResult(model: ModelSelection, text: string): ModelResult {
  return {
    finishReason: "stop",
    model,
    text,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function providerMessagesToText(messages: readonly unknown[]): string {
  return messages
    .map((message) => {
      if (!message || typeof message !== "object" || !("content" in message)) return "";
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((block) =>
          block && typeof block === "object" && "text" in block
            ? String((block as { text?: unknown }).text ?? "")
            : "",
        )
        .join("\n");
    })
    .join("\n");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for auto Dream state");
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "zcode-runtime-memory-dream-"));
  temporaryDirectories.push(path);
  return path;
}
