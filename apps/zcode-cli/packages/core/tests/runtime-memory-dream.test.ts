import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile as writeRealFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INCOGNITO_LOCKDOWN_PROFILE } from "@zcode/shared";

import { afterEach, describe, expect, it, vi } from "vitest";
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
  type SessionEvent,
} from "@zcode/contracts";

import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { resolveProjectMemoryRoot } from "../src/memory/project-root.js";
import { listDreamJournalRuns } from "../src/memory/dream-journal/index.js";
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
  it("skips incognito sessions without memory and keeps those that opted memory back in", () => {
    const workspaceIdentity = createWorkspaceId("remote:opaque");
    const sessions = [
      session("plain", NOW, { workspaceID: workspaceIdentity }),
      session("incognito", NOW, {
        workspaceID: workspaceIdentity,
        incognito: INCOGNITO_LOCKDOWN_PROFILE,
      }),
      session("incognito-memory", NOW, {
        workspaceID: workspaceIdentity,
        incognito: { ...INCOGNITO_LOCKDOWN_PROFILE, memory: true },
      }),
    ];

    expect(
      selectProjectDreamSessions({
        currentSessionId: createSessionId("current"),
        sessions,
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity,
      }).map((item) => item.id),
    ).toEqual([createSessionId("plain"), createSessionId("incognito-memory")]);
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
        metadata: { querySource: "project_memory_dream", skipTranscript: false },
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
  it("acknowledges launch and reports the agent summary through background completion", async () => {
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

    expect(result.response).toContain("Dream started in background");
    await runtime.drainBackgroundDreams();
    expect(dreamTurn).toBe(2);
    expect(runtime.hasRunningBackgroundTasks()).toBe(false);
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
      modelComplete?.payload as { querySource?: string; content?: string } | undefined,
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

    expect(result.response).toContain("Dream started in background");
    await runtime.drainBackgroundDreams();
    expect(dreamTurn).toBe(1);
  });

  it("sends the memory-dream override body followed by the runtime tail", async () => {
    const cliStorageRoot = await temporaryDirectory();
    const modelIoDir = join(cliStorageRoot, "rollout");
    const memoryRoot = resolveProjectMemoryRoot({
      cliStorageRoot,
      workspacePath: WORKSPACE_PATH,
    });
    const pastSessions = [session("manual-override", NOW)];
    const fileSystemPort = new MemoryFileSystem(
      { [join(modelIoDir, `model-io-${pastSessions[0]!.id}.jsonl`)]: "{}\n" },
      { [join(modelIoDir, `model-io-${pastSessions[0]!.id}.jsonl`)]: NOW },
    );
    const dreamTexts: string[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("manual-dream-override"),
      {
        memory: { cliStorageRoot, enabled: true, use: true },
        mode: "yolo",
        systemPromptOverrides: {
          "memory-dream": "# Dream: Memory Consolidation\nTidy {{memoryRoot}} using {{transcriptRoot}}.",
        },
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
            dreamTexts.push(text);
            return textResult(observation.model, "Nothing worth keeping");
          },
        }),
        modelIoDir,
        now: () => new Date(NOW),
        sessionStore: createMemorySessionStore(pastSessions),
        toolRegistry: createToolRegistry(),
      },
    );

    await runtime.executeTurn("/dream");
    await runtime.drainBackgroundDreams();

    expect(dreamTexts[0]).toContain(`Tidy ${memoryRoot} using ${modelIoDir}.\n\n## Additional context`);
    expect(dreamTexts[0]).toContain("Sessions since last consolidation (1):");
    expect(dreamTexts[0]).not.toContain("## Phase 1 — Orient");
  });

  it("skips an immediate re-run after a successful dream while the consolidation lock is fresh", async () => {
    const cliStorageRoot = await temporaryDirectory();
    const modelIoDir = join(cliStorageRoot, "rollout");
    const memoryRoot = resolveProjectMemoryRoot({
      cliStorageRoot,
      workspacePath: WORKSPACE_PATH,
    });
    const pastSessions = [session("manual-rerun", NOW)];
    const transcriptPath = join(modelIoDir, `model-io-${pastSessions[0]!.id}.jsonl`);
    const fileSystemPort = new MemoryFileSystem(
      { [transcriptPath]: "{}\n" },
      { [transcriptPath]: NOW + 1000 },
    );
    let dreamTurn = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("manual-dream-rerun"),
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

    const first = await runtime.executeTurn("/dream");
    expect(first.response).toContain("Dream started in background");
    await runtime.drainBackgroundDreams();
    expect(dreamTurn).toBe(1);

    // Stamp the successful run's lock onto the test clock so the transcript gate sees the
    // session as fresh again; in production the same state arises for any transcript written
    // right after a dream finished (lock mtime == last run start, always fresh for 1 h).
    const lockPath = join(memoryRoot, ".consolidate-lock");
    await utimes(lockPath, NOW / 1000, NOW / 1000);

    const second = await runtime.executeTurn("/dream");

    // Current cooldown design: a successful run deliberately keeps the lock for its freshness
    // window, so an immediate manual re-run is skipped even though no dream is running anymore.
    // Known wart, pinned here on purpose: the visible message claims a dream is still running.
    expect(second.response).toBe(
      "Dream skipped: another dream is already running for this workspace. Try again once it finishes.",
    );
    expect(dreamTurn).toBe(1);
    expect(runtime.hasRunningBackgroundTasks()).toBe(false);
  });

  it("answers a usage error without model requests", async () => {
    const { runtime, modelRequests } = await createSkipSetup({});

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

  it("answers visibly for a remote workspace without starting a model request", async () => {
    const { runtime, modelRequests } = await createSkipSetup({ remote: true });
    const result = await runtime.executeTurn("/dream");
    expect(result.response).toContain("Dream skipped:");
    expect(result.response).toContain("unavailable for remote workspaces");
    expect(modelRequests()).toBe(0);
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
    remote?: boolean;
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
        isRemoteWorkspace: () => options.remote ?? false,
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

describe("background Dream lifecycle", () => {
  async function setup(options: { failSecond?: boolean; eventFailure?: string } = {}) {
    const cliStorageRoot = await temporaryDirectory();
    const modelIoDir = join(cliStorageRoot, "rollout");
    const memoryRoot = resolveProjectMemoryRoot({ cliStorageRoot, workspacePath: WORKSPACE_PATH });
    const transcript = join(modelIoDir, `model-io-${createSessionId("history")}.jsonl`);
    const events: SessionEvent[] = [];
    const facts: Record<string, unknown>[] = [];
    const pending = deferred<void>();
    const entered = deferred<void>();
    let dreamCalls = 0;
    const sessionStore = Object.assign(createMemorySessionStore([session("history", NOW)]), {
      recordModelUsage: async (fact: Record<string, unknown>) => {
        facts.push(fact);
      },
      upsertTurnUsage: async () => {},
      upsertToolUsage: async () => {},
      pruneUsage: async () => {},
    });
    const runtime = createTestAgentRuntime(
      createSessionId("background-dream"),
      {
        workingDirectory: WORKSPACE_PATH,
        mode: "yolo",
        memory: { cliStorageRoot, enabled: true, use: true, extractionEnabled: false },
      },
      {
        eventStore: createTestSessionEventStore(),
        eventSink: {
          onSessionEvent: async (event: SessionEvent) => {
            events.push(event);
          },
        },
        fileSystemPort: new MemoryFileSystem({ [transcript]: "{}\n" }, { [transcript]: NOW }),
        modelIoDir,
        sessionStore,
        now: () => new Date(NOW),
        toolRegistry: createToolRegistry(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            if (
              !providerMessagesToText(request.messages).includes("# Dream: Memory Consolidation")
            ) {
              return textResult(observation.model, "foreground answer");
            }
            dreamCalls += 1;
            if (options.failSecond && dreamCalls === 1) {
              return {
                ...textResult(observation.model, ""),
                finishReason: "tool_calls",
                toolCalls: [
                  { id: "read", name: "Read", input: { file_path: join(memoryRoot, "MEMORY.md") } },
                ],
              };
            }
            entered.resolve();
            await Promise.race([
              pending.promise,
              new Promise<void>((_, reject) => {
                if (request.abortSignal?.aborted) reject(request.abortSignal.reason);
                else
                  request.abortSignal?.addEventListener(
                    "abort",
                    () => reject(request.abortSignal?.reason),
                    { once: true },
                  );
              }),
            ]);
            if (options.failSecond) throw new Error("later request failed");
            return textResult(observation.model, "Dream summary");
          },
        }),
      },
    );
    const internal = runtime as unknown as AgentRuntimeInternal;
    if (options.eventFailure) {
      const append = internal.appendEvent.bind(internal);
      vi.spyOn(internal, "appendEvent").mockImplementation(async (event, trace) => {
        if (event.type === options.eventFailure) throw new Error("event store unavailable");
        return append(event, trace);
      });
    }
    return { runtime, internal, memoryRoot, events, facts, pending, entered };
  }

  it("acks before the model completes, accepts another turn and retains ordered completion", async () => {
    const test = await setup();
    try {
      expect((await test.runtime.executeTurn("/dream")).response).toContain(
        "started in background",
      );
      await test.entered.promise;
      expect(test.runtime.hasRunningBackgroundTasks()).toBe(true);
      expect((await test.runtime.executeTurn("/dream")).response).toContain("another dream");
      expect((await test.runtime.executeTurn("foreground question")).response).toContain(
        "foreground answer",
      );
      expect(test.facts.filter((fact) => fact.querySource === "dream")).toHaveLength(0);
      test.pending.resolve();
      await test.runtime.drainBackgroundDreams();
      const lifecycle = test.events.filter((event) => event.type.startsWith("background_task_"));
      expect(lifecycle.map((event) => event.type)).toEqual([
        "background_task_started",
        "background_task_updated",
        "background_task_completed",
      ]);
      expect(lifecycle.every((event) => event.turnId === undefined)).toBe(true);
      expect(lifecycle.at(-1)?.payload).toMatchObject({
        status: "completed",
        description: "Dream summary",
      });
      expect(test.runtime.hasRunningBackgroundTasks()).toBe(false);
      expect(test.internal.backgroundDreamRuns.size).toBe(0);
      expect(test.facts.filter((fact) => fact.querySource === "dream")).toMatchObject([
        { status: "completed", inputTokens: 1, outputTokens: 1, finishReason: "stop" },
      ]);
      await expect(stat(join(test.memoryRoot, ".consolidated-at"))).resolves.toBeTruthy();
    } finally {
      test.runtime.beginShutdown();
      test.pending.resolve();
      await test.runtime.drainBackgroundDreams();
    }
  });

  it.each(["cancel", "shutdown"])(
    "%s aborts and drains without stamping success",
    async (action) => {
      const test = await setup();
      await test.runtime.executeTurn("/dream");
      await test.entered.promise;
      const taskId = [...test.internal.backgroundDreamRuns.keys()][0]!;
      if (action === "cancel")
        expect((await test.runtime.cancelBackgroundTask(taskId)).cancelled).toBe(true);
      else test.runtime.beginShutdown();
      await test.runtime.drainBackgroundDreams();
      expect(test.runtime.hasRunningBackgroundTasks()).toBe(false);
      expect(test.internal.backgroundDreamRuns.size).toBe(0);
      await expect(stat(join(test.memoryRoot, ".consolidate-lock"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(join(test.memoryRoot, ".consolidated-at"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(test.events.at(-1)?.payload).toMatchObject({ status: "cancelled" });
      expect(test.facts.filter((fact) => fact.querySource === "dream")).toMatchObject([
        { status: "cancelled" },
      ]);
      if (action === "shutdown")
        await expect(test.runtime.executeTurn("/dream")).rejects.toThrow("Dream failed");
    },
  );

  it("preserves paid usage and restores the previous lock when a later request is cancelled", async () => {
    const test = await setup({ failSecond: true });
    const notify = vi.spyOn(test.runtime, "enqueueBackgroundTaskNotification");
    const lock = join(test.memoryRoot, ".consolidate-lock");
    await mkdir(test.memoryRoot, { recursive: true });
    await writeRealFile(lock, "99999999");
    await utimes(lock, (NOW - 1000) / 1000, (NOW - 1000) / 1000);
    await test.runtime.executeTurn("/dream");
    await test.entered.promise;
    await test.runtime.cancelBackgroundTask([...test.internal.backgroundDreamRuns.keys()][0]!);
    await test.runtime.drainBackgroundDreams();
    expect(test.facts.filter((fact) => fact.querySource === "dream")).toMatchObject([
      { status: "completed", inputTokens: 1 },
      { status: "cancelled" },
    ]);
    expect((await stat(lock)).mtimeMs).toBeCloseTo(NOW - 1000, -1);
    // The restored lock must read as abandoned (dead PID), not "owner mid-acquire": the very
    // next /dream has to take the lock over instead of skipping with "already running".
    expect(readFileSync(lock, "utf8")).toBe("0");
    const secondLaunch = await test.runtime.executeTurn("/dream");
    expect(secondLaunch.response).toContain("started in background");
    await expect(stat(join(test.memoryRoot, ".consolidated-at"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    test.runtime.beginShutdown();
    await test.runtime.drainBackgroundDreams();
    expect(test.runtime.hasRunningBackgroundTasks()).toBe(false);
    // A user-initiated stop must not wake the model with a completion turn.
    expect(notify).not.toHaveBeenCalled();
  });

  it("preserves successful usage when a later request fails", async () => {
    const test = await setup({ failSecond: true });
    const notify = vi.spyOn(test.runtime, "enqueueBackgroundTaskNotification");
    await test.runtime.executeTurn("/dream");
    await test.entered.promise;
    expect(test.facts.filter((fact) => fact.querySource === "dream")).toMatchObject([
      { status: "completed", inputTokens: 1 },
    ]);
    test.pending.resolve();
    await test.runtime.drainBackgroundDreams();
    expect(test.facts.filter((fact) => fact.querySource === "dream")).toMatchObject([
      { status: "completed", toolCallCount: 1 },
      { status: "error", inputTokens: undefined },
    ]);
    expect(test.events.at(-1)?.payload).toMatchObject({ status: "failed" });
    // Failed runs still notify: the failure turn is the durable, user-visible outcome record.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]?.originMeta).toMatchObject({ backgroundSource: "dream" });
    expect(notify.mock.calls[0]?.[0]?.originMeta?.title).toBe("Dream failed");
    expect(notify.mock.calls[0]?.[0]?.text).toContain("failed");
  });

  it("enqueues a completion notification for the durable transcript turn", async () => {
    const test = await setup();
    const notify = vi.spyOn(test.runtime, "enqueueBackgroundTaskNotification");
    await test.runtime.executeTurn("/dream");
    await test.entered.promise;
    test.pending.resolve();
    await test.runtime.drainBackgroundDreams();
    expect(notify).toHaveBeenCalledTimes(1);
    const notification = notify.mock.calls[0]?.[0];
    expect(notification?.originMeta).toMatchObject({
      backgroundSource: "dream",
      workId: expect.stringMatching(/^dream-/),
    });
    expect(notification?.originMeta?.title).toBe("Dream: Dream summary");
    expect(notification?.text).toContain("Dream summary");
    // The notification inherits the registry task's branchGeneration fencing via taskId.
    expect(notification?.taskId).toBe(notification?.originMeta?.workId);
  });

  it.each(["background_task_started", "background_task_updated", "background_task_completed"])(
    "cleans up when %s cannot be persisted",
    async (eventFailure) => {
      const test = await setup({ eventFailure });
      if (eventFailure === "background_task_started")
        await expect(test.runtime.executeTurn("/dream")).rejects.toThrow("Dream failed");
      else await test.runtime.executeTurn("/dream");
      if (eventFailure !== "background_task_started") {
        await test.entered.promise;
        test.pending.resolve();
      }
      await test.runtime.drainBackgroundDreams();
      expect(test.runtime.hasRunningBackgroundTasks()).toBe(false);
      expect(test.internal.backgroundDreamRuns.size).toBe(0);
      if (eventFailure === "background_task_started") {
        await expect(stat(join(test.memoryRoot, ".consolidate-lock"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
  );

  it("restores the lock after registry registration fails", async () => {
    const test = await setup();
    vi.spyOn(test.internal.runtimeTaskRegistry, "register").mockImplementation(() => {
      throw new Error("registration failed");
    });
    await expect(test.runtime.executeTurn("/dream")).rejects.toThrow("Dream failed");
    expect(test.internal.backgroundDreamRuns.size).toBe(0);
    expect(test.runtime.hasRunningBackgroundTasks()).toBe(false);
    await expect(stat(join(test.memoryRoot, ".consolidate-lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("Dream run journal and lifecycle logs", () => {
  type LoggerSpy = { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  function createLoggerSpy(): LoggerSpy {
    return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  }

  function loggedFields(logger: LoggerSpy, level: "info" | "warn", event: string) {
    return logger[level].mock.calls
      .map(([, fields]) => fields as Record<string, unknown>)
      .filter((fields) => fields.event === event);
  }

  async function setup(
    options: {
      transcriptMtime?: number;
      failSecondRequest?: boolean;
      blockJournal?: boolean;
      breakCommit?: boolean;
      failFinalize?: boolean;
      seedLock?: { pid: number; mtimeMs: number; status: "running" | "succeeded" };
    } = {},
  ) {
    const cliStorageRoot = await temporaryDirectory();
    const modelIoDir = join(cliStorageRoot, "rollout");
    const memoryRoot = resolveProjectMemoryRoot({ cliStorageRoot, workspacePath: WORKSPACE_PATH });
    const factPath = join(memoryRoot, "fact.md");
    const transcript = join(modelIoDir, `model-io-${createSessionId("history")}.jsonl`);
    const fileSystemPort = new MemoryFileSystem(
      { [transcript]: "{}\n" },
      { [transcript]: options.transcriptMtime ?? NOW },
    );
    let dreamRequests = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("journal-dream"),
      {
        memory: { cliStorageRoot, enabled: true, use: true, extractionEnabled: false },
        mode: "yolo",
        workingDirectory: WORKSPACE_PATH,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort,
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            if (!providerMessagesToText(request.messages).includes("# Dream: Memory Consolidation")) {
              return textResult(observation.model, "foreground answer");
            }
            dreamRequests += 1;
            if (dreamRequests === 1) {
              return {
                ...textResult(observation.model, ""),
                finishReason: "tool_calls",
                toolCalls: [
                  { id: "write-fact", name: "Write", input: { file_path: factPath, content: "fact" } },
                ],
              };
            }
            if (options.breakCommit) {
              // Another owner takes the lock before the commit, so writeDreamConsolidatedAt throws.
              await writeRealFile(
                join(memoryRoot, ".consolidate-lock"),
                JSON.stringify({ pid: process.pid, token: "foreign", status: "running" }),
                "utf8",
              );
            }
            if (options.failSecondRequest) throw new Error("later request failed");
            return textResult(observation.model, "Dream summary");
          },
        }),
        modelIoDir,
        now: () => new Date(NOW),
        sessionStore: createMemorySessionStore([session("history", NOW)]),
        toolRegistry: createToolRegistry(),
      },
    );
    const logger = createLoggerSpy();
    (runtime as unknown as AgentRuntimeInternal).logger = logger as never;
    if (options.seedLock) {
      await mkdir(memoryRoot, { recursive: true });
      const lockPath = join(memoryRoot, ".consolidate-lock");
      await writeRealFile(
        lockPath,
        JSON.stringify({ pid: options.seedLock.pid, status: options.seedLock.status }),
        "utf8",
      );
      await utimes(lockPath, options.seedLock.mtimeMs / 1000, options.seedLock.mtimeMs / 1000);
    }
    if (options.failFinalize) {
      // Reading the applied file fails only after the write, so the snapshot still succeeds.
      const readTextFile = fileSystemPort.readTextFile.bind(fileSystemPort);
      vi.spyOn(fileSystemPort, "readTextFile").mockImplementation(async (request) => {
        if (request.path === factPath && fileSystemPort.files[factPath] !== undefined) {
          throw new Error("port read failed");
        }
        return readTextFile(request);
      });
    }
    if (options.blockJournal) {
      // A plain file where the journal directory must go makes every journal write fail, while
      // the Dream tools keep using the in-memory port.
      await mkdir(memoryRoot, { recursive: true });
      await writeRealFile(join(memoryRoot, ".fork_dream-journal"), "not a directory", "utf8");
    }
    return { dreamRequests: () => dreamRequests, fileSystemPort, factPath, logger, memoryRoot, runtime };
  }

  it("journals a skip with its reason code and logs it without calling the model", async () => {
    const { dreamRequests, logger, memoryRoot, runtime } = await setup({ transcriptMtime: 0 });

    const result = await runtime.executeTurn("/dream");

    expect(result.response).toContain("no new session activity");
    expect(dreamRequests()).toBe(0);
    const runs = await listDreamJournalRuns({ memoryRoot });
    expect(runs).toEqual([
      expect.objectContaining({
        items: [],
        outcome: "skipped",
        reasonCode: "no_new_turns",
        trigger: "manual",
      }),
    ]);
    expect(loggedFields(logger, "info", "memory.dream.run.skipped")).toEqual([
      expect.objectContaining({ module: "core.runtime", reasonCode: "no_new_turns", trigger: "manual" }),
    ]);
  });

  it("journals a learned run with before and after bodies and logs start and completion", async () => {
    const { logger, memoryRoot, runtime } = await setup();

    await runtime.executeTurn("/dream");
    await waitFor(() => loggedFields(logger, "info", "memory.dream.run.completed").length === 1);

    const [run] = await listDreamJournalRuns({ memoryRoot });
    expect(run).toMatchObject({
      outcome: "learned",
      trigger: "manual",
      items: [
        expect.objectContaining({
          action: "created",
          after: { content: "fact" },
          before: null,
          file: "fact.md",
        }),
      ],
    });
    expect(loggedFields(logger, "info", "memory.dream.run.started")).toEqual([
      expect.objectContaining({ runId: run!.id, sessionCount: 1, trigger: "manual" }),
    ]);
    expect(loggedFields(logger, "info", "memory.dream.run.completed")).toEqual([
      expect.objectContaining({
        created: 1,
        deleted: 0,
        outcome: "learned",
        runId: run!.id,
        updated: 0,
      }),
    ]);
  });

  it("keeps the applied change recorded when the run fails after an earlier write", async () => {
    const { logger, memoryRoot, runtime } = await setup({ failSecondRequest: true });

    await runtime.executeTurn("/dream");
    await waitFor(() => loggedFields(logger, "warn", "memory.dream.failed").length === 1);

    const [run] = await listDreamJournalRuns({ memoryRoot });
    expect(run).toMatchObject({
      outcome: "failed",
      reasonCode: "error",
      items: [expect.objectContaining({ action: "created", file: "fact.md", after: { content: "fact" } })],
    });
    expect(loggedFields(logger, "warn", "memory.dream.failed")).toEqual([
      expect.objectContaining({ phase: "agent_loop", runId: run!.id }),
    ]);
  });

  it("does not fail the Dream run when the journal cannot be written", async () => {
    const { factPath, fileSystemPort, logger, runtime } = await setup({ blockJournal: true });

    await runtime.executeTurn("/dream");
    await waitFor(() => loggedFields(logger, "info", "memory.dream.run.completed").length === 1);

    expect(loggedFields(logger, "warn", "memory.dream.journal.failed")).toEqual([
      expect.objectContaining({ module: "core.runtime", operation: "begin" }),
    ]);
    expect(loggedFields(logger, "warn", "memory.dream.failed")).toEqual([]);
    expect(fileSystemPort.files[factPath]).toBe("fact");
  });
  it("journals a lock_held skip for a manual run while another run holds the lock", async () => {
    const { dreamRequests, logger, memoryRoot, runtime } = await setup({
      seedLock: { pid: process.pid, mtimeMs: NOW, status: "running" },
      transcriptMtime: NOW + 1000,
    });

    const result = await runtime.executeTurn("/dream");

    expect(result.response).toContain("another dream is already running");
    expect(dreamRequests()).toBe(0);
    expect(await listDreamJournalRuns({ memoryRoot })).toEqual([
      expect.objectContaining({ outcome: "skipped", reasonCode: "lock_held", trigger: "manual" }),
    ]);
    expect(loggedFields(logger, "info", "memory.dream.run.skipped")).toEqual([
      expect.objectContaining({ reasonCode: "lock_held", trigger: "manual" }),
    ]);
  });

  it("journals a min_interval skip for an automatic run inside the 24 hour window", async () => {
    const { dreamRequests, logger, memoryRoot, runtime } = await setup({
      seedLock: { pid: 99999999, mtimeMs: NOW - 1000, status: "succeeded" },
      transcriptMtime: NOW + 1000,
    });

    await runProjectMemoryDream(runtime as never, {
      traceContext: createRootTraceContext({
        sessionId: createSessionId("journal-dream"),
        turnId: createTurnId("auto-min-interval"),
      }),
    });

    expect(dreamRequests()).toBe(0);
    expect(await listDreamJournalRuns({ memoryRoot })).toEqual([
      expect.objectContaining({ outcome: "skipped", reasonCode: "min_interval", trigger: "scheduled" }),
    ]);
    expect(loggedFields(logger, "info", "memory.dream.run.skipped")).toEqual([
      expect.objectContaining({ reasonCode: "min_interval", trigger: "scheduled" }),
    ]);
  });

  it("does not fail the Dream run when finalize cannot read the applied file", async () => {
    const { logger, memoryRoot, runtime } = await setup({ failFinalize: true });

    await runtime.executeTurn("/dream");
    await waitFor(() => loggedFields(logger, "info", "memory.dream.run.completed").length === 1);

    expect(loggedFields(logger, "warn", "memory.dream.journal.failed")).toEqual([
      expect.objectContaining({ operation: "finalize" }),
    ]);
    expect(loggedFields(logger, "warn", "memory.dream.failed")).toEqual([]);
    expect(JSON.parse(readFileSync(join(memoryRoot, ".consolidate-lock"), "utf8"))).toMatchObject({
      status: "succeeded",
    });
  });

  it("records commit_failed in the journal and the failure log when the lock changes before commit", async () => {
    const { logger, memoryRoot, runtime } = await setup({ breakCommit: true });

    await runtime.executeTurn("/dream");
    await waitFor(() => loggedFields(logger, "warn", "memory.dream.failed").length === 1);

    const [run] = await listDreamJournalRuns({ memoryRoot });
    expect(run).toMatchObject({
      outcome: "failed",
      reasonCode: "commit_failed",
      items: [expect.objectContaining({ action: "created", file: "fact.md", after: { content: "fact" } })],
    });
    expect(loggedFields(logger, "warn", "memory.dream.failed")).toEqual([
      expect.objectContaining({ phase: "commit", runId: run!.id }),
    ]);
    expect(loggedFields(logger, "info", "memory.dream.run.completed")).toEqual([]);
  });
});

function session(
  id: string,

  updated: number,
  options: Partial<Pick<SessionInfo, "directory" | "incognito" | "taskType" | "workspaceID">> = {},
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
    incognito: options.incognito,
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
    // 终态结果由 CLI 存储维护；夹具也须更新同一条会话记录。
    async updateSession(input) {
      if (!currentSession || currentSession.id !== input.id) throw new Error("Session not found");
      currentSession = {
        ...currentSession,
        ...input,
        time: { ...currentSession.time, ...input.time },
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
