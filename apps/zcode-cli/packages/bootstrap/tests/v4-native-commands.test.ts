// L2: the v4 native command executor (sendText / stop) — verifies the decision semantics
// carried over from the old server-operations stay faithful at the native layer: steer
// routing, draft promotion, ready boundaries, goal-pause barrier.
// The L2 layer of 08-phasing M4's definition of done (command → core call → state advance, no legacy protocol code).
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { createInputFacade } from "../src/app/input-facade.js";
import type { SendInputOptions } from "../src/app/types.js";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import { V4PromptRejectedError } from "../src/zcode-protocol-v4/commands/prompt-turn.js";
import { V4InputAdmissionRejectedError } from "../src/zcode-protocol-v4/commands/input-admission.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

const ORDINARY_MODEL_SELECTION = {
  providerId: "builtin:bigmodel-coding-plan",
  modelId: "GLM-5.3",
};

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    sendInput: vi.fn().mockImplementation(async (_input, options) => {
      if (options?.requireQueue) {
        return {
          kind: "queued",
          pendingInputId: "queue_cmd-1",
          queueLength: 1,
          turnId: "turn-1",
        };
      }
      options?.onTurnStartedObserved?.({
        id: "event-started",
        type: SessionEventType.TurnStarted,
        payload: { messageId: "msg-event-started" },
      });
      return {
        completion: Promise.resolve({}),
        kind: "started_turn",
        turnId: "turn-1",
      };
    }),
    steerTurn: vi.fn().mockResolvedValue({
      kind: "queued",
      pendingInputId: "queue_cmd-1",
      queueLength: 1,
      turnId: "turn-1",
    }),
    getModel: vi.fn().mockReturnValue("account:bigmodel-start-plan/glm-5"),
    readTarget: vi.fn().mockResolvedValue(null),
    updateTargetStatus: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<V4SessionRecordView> & { app?: ReturnType<typeof makeApp> } = {},
): V4SessionRecordView {
  return {
    app: (overrides.app ?? makeApp()) as unknown as V4SessionRecordView["app"],
    workspace: { workspacePath: "/w" },
    persistence: "immediate",
    ...overrides,
  } as V4SessionRecordView;
}

function makeHost(
  record: V4SessionRecordView,
  overrides: Partial<V4CommandCoreHost> = {},
): V4CommandCoreHost & {
  legacyMutations: string[];
} {
  const legacyMutations: string[] = [];
  return {
    getRecord: (id) => (id === "s1" ? record : undefined),
    afterLegacyStateMutation: async (_r, reason) => {
      legacyMutations.push(reason);
    },
    waitForProjectionEventCommit: async () => {},
    legacyMutations,
    ...overrides,
  };
}

function envelope(type: string, payload: unknown): CommandEnvelope {
  return {
    type,
    payload,
    sessionId: "s1",
    commandId: "cmd-1",
    clientId: "client-test",
    issuedAt: 1,
    baseRevision: 0,
  } as unknown as CommandEnvelope;
}

async function settle() {
  // A background turn is a void-started microtask chain; flush two rounds to guarantee finally completes.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

async function flushMicrotasks(turns = 8) {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

type PromptSendInputOptions = {
  abortSignal: AbortSignal;
  onEvent?: (event: SessionEvent) => void;
  onTurnStartedObserved?: (event: SessionEvent) => void;
};

function workspaceHookReviewRequest(input: {
  interactionId: string;
  deadlineAt: number;
  createdAt?: number;
  generation?: number;
  reviewFlowId?: string;
}) {
  return {
    kind: "workspaceHookReview",
    reviewFlowId: input.reviewFlowId ?? "review-flow-1",
    generation: input.generation ?? 1,
    interactionId: input.interactionId,
    sessionId: "s1",
    taskId: "task-1",
    runId: "run-1",
    workspaceIdentity: "/w",
    workspaceLabel: "w",
    bundleDigest: "a".repeat(64),
    createdAt: input.createdAt ?? Date.now(),
    deadlineAt: input.deadlineAt,
    sourceFiles: [
      {
        path: "/w/.zcode/config.json",
        displayPath: ".zcode/config.json",
        editable: true,
      },
    ],
    summary: { eventCount: 1, hookCount: 1, pendingCount: 1 },
    items: [
      {
        reviewItemId: "review-item-1",
        event: "PreToolUse",
        matcher: "*",
        type: "process",
        displayName: "echo hello",
        displayCommand: "echo hello",
        sourcePath: "/w/.zcode/config.json",
        resolvedTimeoutMs: 1_000,
        resolvedMaxOutputBytes: 1_024,
        executionMode: "foreground",
        configuredEnabled: true,
        editable: true,
        trustState: "pending_trust",
      },
    ],
    warningCode: "workspace_hooks_execute_code",
  };
}

function workspaceHookReviewRequestedEvent(input: {
  id: string;
  interactionId: string;
  deadlineAt: number;
  createdAt?: number;
  generation?: number;
  reviewFlowId?: string;
  sequenceNumber?: number;
}): SessionEvent {
  return {
    id: input.id,
    sequenceNumber: input.sequenceNumber ?? 1,
    timestamp: new Date("2026-08-07T00:00:00.000Z"),
    type: SessionEventType.WorkspaceHookReviewRequested,
    payload: {
      request: workspaceHookReviewRequest(input),
    },
  } as unknown as SessionEvent;
}

function workspaceHookReviewSettledEvent(input: {
  id: string;
  interactionId: string;
  sequenceNumber?: number;
}): SessionEvent {
  return {
    id: input.id,
    sequenceNumber: input.sequenceNumber ?? 2,
    timestamp: new Date("2026-08-07T00:00:01.000Z"),
    type: SessionEventType.WorkspaceHookReviewSettled,
    payload: {
      interactionId: input.interactionId,
      state: "resolved",
    },
  } as unknown as SessionEvent;
}

function turnStartedEvent(id = "event-turn-started"): SessionEvent {
  return {
    id,
    type: SessionEventType.TurnStarted,
    payload: { inputId: "cmd-1", messageId: `msg-${id}` },
  } as unknown as SessionEvent;
}

function makeAbortablePendingPromptApp() {
  let options: PromptSendInputOptions | undefined;
  const app = makeApp({
    sendInput: vi.fn().mockImplementation(
      (_input: unknown, nextOptions: PromptSendInputOptions) =>
        new Promise<Record<string, never>>((_resolve, reject) => {
          options = nextOptions;
          const rejectOnAbort = () => reject(nextOptions.abortSignal.reason);
          if (nextOptions.abortSignal.aborted) rejectOnAbort();
          else nextOptions.abortSignal.addEventListener("abort", rejectOnAbort, { once: true });
        }),
    ),
  });
  return {
    app,
    getOptions: () => {
      if (!options) throw new Error("sendInput options have not been captured");
      return options;
    },
  };
}

describe("v4 原生 sendText", () => {
  it("旧发送端 admission 保留 runtime 的稀疏 Session Selection，不回填 effective thought", async () => {
    let capturedOptions: SendInputOptions | undefined;
    const app = makeApp({
      getThoughtLevel: vi.fn(() => "high"),
      runtime: {
        getSessionModelSelection: vi.fn(() => ({ providerId: "provider-a", modelId: "model-a" })),
      },
      sendInput: vi.fn().mockImplementation(async (_input, options) => {
        capturedOptions = options;
        return {
          completion: Promise.resolve({}),
          kind: "started_turn",
          turnId: "turn-sparse-selection",
        };
      }),
    });

    await new V4CommandExecutor(makeHost(makeRecord({ app }))).execute(
      envelope("sendText", { text: "keep sparse selection" }),
    );

    expect(capturedOptions?.intent?.modelSelection).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
    });
  });

  it("app input facade 把 start/queue 决策交给 Core admission，不查询 activeTurn", async () => {
    const runtime = {
      getActiveTurnInfo: vi.fn().mockReturnValue(undefined),
      admitPrompt: vi.fn().mockResolvedValue({
        completion: Promise.resolve({}),
        kind: "started",
        turnId: "turn-1",
      }),
    };
    const facade = createInputFacade({
      logger: { warn: vi.fn() } as never,
      prepareUserExecutionBoundary: async () => {},
      runtime: runtime as never,
      sessionId: "s1" as never,
      traceContext: { traceId: "trace-1" } as never,
    });
    const modelExecution = {
      selectionScope: "execution",
      requestDependencies: {
        requestAuth: { source: { resolve: vi.fn().mockResolvedValue({ apiKey: "request-key" }) } },
      },
    } as const;

    await facade.sendInput("hi", {
      inputId: "cmd-1",
      offPeakTaskId: "off-peak-task-1",
      offPeakRunType: "init",
      modelExecution,
    });

    expect(runtime.getActiveTurnInfo).not.toHaveBeenCalled();
    expect(runtime.admitPrompt).toHaveBeenCalledWith(
      "hi",
      undefined,
      expect.objectContaining({
        offPeakTaskId: "off-peak-task-1",
        offPeakRunType: "init",
        modelExecution,
      }),
    );
  });

  it("cold resume boundary 的 Hook review 被 prompt observer 捕获，且 AbortSignal 贯穿 admission", async () => {
    let temporarySink: { onSessionEvent(event: SessionEvent): Promise<void> | void } | undefined;
    const onEvent = vi.fn();
    const abortController = new AbortController();
    const reviewEvent = workspaceHookReviewRequestedEvent({
      id: "review-during-resume",
      interactionId: "interaction-resume",
      deadlineAt: Date.now() + 60_000,
    });
    const runtime = {
      getActiveTurnInfo: vi.fn().mockReturnValue(undefined),
      subscribeEvents: vi.fn().mockImplementation((sink) => {
        temporarySink = sink;
        return () => {};
      }),
      admitPrompt: vi.fn().mockResolvedValue({
        completion: Promise.resolve({}),
        kind: "started",
        turnId: "turn-resume",
      }),
    };
    const prepareUserExecutionBoundary = vi.fn(async (options?: { abortSignal?: AbortSignal }) => {
      expect(options?.abortSignal).toBe(abortController.signal);
      expect(temporarySink).toBeDefined();
      await temporarySink?.onSessionEvent(reviewEvent);
    });
    const facade = createInputFacade({
      logger: { warn: vi.fn() } as never,
      prepareUserExecutionBoundary,
      runtime: runtime as never,
      sessionId: "s1" as never,
      traceContext: { traceId: "trace-1" } as never,
    });

    await facade.sendInput("resume me", {
      abortSignal: abortController.signal,
      inputId: "cmd-resume",
      onEvent,
    });

    expect(onEvent).toHaveBeenCalledWith(reviewEvent);
    expect(runtime.admitPrompt).toHaveBeenCalledTimes(1);
  });

  it("空闲会话：Core admission receipt 立即返回，完成后执行 ready 清理", async () => {
    let finishTurn!: () => void;
    const turnGate = new Promise<Record<string, never>>((resolve) => {
      finishTurn = () => resolve({});
    });
    const app = makeApp({
      sendInput: vi.fn().mockReturnValue({
        completion: turnGate,
        kind: "started_turn",
        turnId: "turn-1",
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record);
    const executing = new V4CommandExecutor(host)
      .execute(
        envelope("sendText", {
          text: "hi",
          browserAmbientContext: {
            tabCount: 1,
            currentUrl: "https://example.com/current",
          },
        }),
      )
      .then((result) => {
        expect(result).toEqual({
          type: "inputAccepted",
          delivery: "startNow",
          inputId: "cmd-1",
        });
      });
    await vi.waitFor(() => expect(app.sendInput).toHaveBeenCalledTimes(1));
    await executing;
    expect(record.activeAbortController).toBeUndefined();
    finishTurn();
    await settle();
    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "hi" },
      expect.objectContaining({
        inputId: "cmd-1",
        queryId: "cmd-1",
        browserAmbientContext: {
          tabCount: 1,
          currentUrl: "https://example.com/current",
        },
        intent: expect.objectContaining({
          sourceCommandId: "cmd-1",
          queueItemId: "queue_cmd-1",
          clientId: "client-test",
          requestedDelivery: "startNow",
        }),
      }),
    );
    // Legacy cleanup runs after Core completion; the Bootstrap controller never participates in busy decisions.
    expect(record.activeAbortController).toBeUndefined();
    expect(host.legacyMutations).toEqual(["prompt_completed"]);
  });

  it("TurnStarted 缺 messageId 时仍提交 Chat authority，仅省略 repo 归因结果", async () => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        completion: Promise.resolve({}),
        kind: "started_turn",
        turnId: "turn-without-message-id",
      }),
    });

    await expect(
      new V4CommandExecutor(makeHost(makeRecord({ app }))).execute(
        envelope("sendText", { text: "chat 必须继续" }),
      ),
    ).resolves.toEqual({
      type: "inputAccepted",
      delivery: "startNow",
      inputId: "cmd-1",
    });
  });

  it("Highspeed turn 运行中再次发送仍进入 queue，加速执行材料只暂存在 CLI 内存", async () => {
    const app = makeApp();
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const retainQueuedTurnExecution = vi.fn();
    const host = makeHost(record, {
      getInputRoutingMode: () => "enqueue",
      retainQueuedTurnExecution,
    });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("sendText", {
          text: "排队继续问",
          highspeedMeta: {
            schemaVersion: 1,
            cardId: "card-1",
            taskId: "s1",
            provider: "bigmodel",
            model: "GLM-5.3",
            issuedAt: 1,
            expiresAt: Date.now() + 60_000,
          },
          modelSelection: {
            providerId: "account:bigmodel-highspeed-card",
            modelId: "GLM-5.3",
          },
          modelExecution: {
            selectionScope: "execution",
            requestAuth: { apiKey: "card-jwt", headers: { "X-Highspeed-Card-ID": "card-1" } },
            selectionFallback: {
              providerId: "account:bigmodel-highspeed-card",
              target: ORDINARY_MODEL_SELECTION,
              rules: [
                { reason: "highspeed_card_expired", providerErrorCode: "3402" },
                { reason: "highspeed_request_failed" },
              ],
            },
          },
        }),
      ),
    ).resolves.toEqual({
      type: "inputAccepted",
      delivery: "queue",
      inputId: "cmd-1",
    });

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "排队继续问" },
      expect.objectContaining({
        requireQueue: true,
        intent: expect.objectContaining({
          highspeed: expect.objectContaining({ cardId: "card-1" }),
          // The queue persists only the ordinary model; the temporary Selection and credentials must stay resident in memory as one bundle.
          modelSelection: ORDINARY_MODEL_SELECTION,
        }),
      }),
    );
    // Credentials do not enter queue events; they are staged in the CLI process keyed by (sessionId, sourceCommandId) only.
    expect(retainQueuedTurnExecution).toHaveBeenCalledWith("s1", "cmd-1", {
      modelSelection: {
        providerId: "account:bigmodel-highspeed-card",
        modelId: "GLM-5.3",
      },
      modelExecution: expect.objectContaining({
        selectionScope: "execution",
        requestAuth: expect.objectContaining({ apiKey: "card-jwt" }),
      }),
    });
  });

  it("Highspeed 入队忽略被污染为加速 Provider 的退回目标", async () => {
    const app = makeApp({ getModel: () => "builtin:bigmodel-coding-plan/GLM-5.3" });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const host = makeHost(record, {
      getInputRoutingMode: () => "enqueue",
      retainQueuedTurnExecution: vi.fn(),
    });

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "退回目标被污染时仍保存普通模型",
        highspeedMeta: {
          schemaVersion: 1,
          cardId: "card-polluted-fallback",
          taskId: "s1",
          provider: "bigmodel",
          model: "GLM-5.3",
          issuedAt: 1,
          expiresAt: Date.now() + 60_000,
        },
        modelSelection: {
          providerId: "account:bigmodel-highspeed-card",
          modelId: "GLM-5.3",
        },
        modelExecution: {
          selectionScope: "execution",
          requestAuth: { apiKey: "card-jwt" },
          selectionFallback: {
            providerId: "account:bigmodel-highspeed-card",
            target: {
              providerId: "account:bigmodel-highspeed-card",
              modelId: "GLM-5.3",
            },
            rules: [{ reason: "highspeed_request_failed" }],
          },
        },
      }),
    );

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "退回目标被污染时仍保存普通模型" },
      expect.objectContaining({
        requireQueue: true,
        intent: expect.objectContaining({ modelSelection: ORDINARY_MODEL_SELECTION }),
      }),
    );
  });

  it("Highspeed 运行中输入在 guide 模式下仍进入 queue", async () => {
    const app = makeApp({
      runtime: { getActiveTurnInfo: vi.fn().mockReturnValue({ steerable: true }) },
    });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const retainQueuedTurnExecution = vi.fn();
    const host = makeHost(record, {
      getInputRoutingMode: () => "guide",
      hasQueuedDelivery: () => false,
      retainQueuedTurnExecution,
    });

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "加速输入不应内联当前轮",
        highspeedMeta: {
          schemaVersion: 1,
          cardId: "card-guide",
          taskId: "s1",
          provider: "bigmodel",
          model: "GLM-5.3",
          issuedAt: 1,
          expiresAt: Date.now() + 60_000,
        },
        modelSelection: {
          providerId: "account:bigmodel-highspeed-card",
          modelId: "GLM-5.3",
        },
        modelExecution: {
          selectionScope: "execution",
          requestAuth: { apiKey: "card-jwt", headers: { "X-Highspeed-Card-ID": "card-guide" } },
          selectionFallback: {
            providerId: "account:bigmodel-highspeed-card",
            target: ORDINARY_MODEL_SELECTION,
            rules: [
              { reason: "highspeed_card_expired", providerErrorCode: "3402" },
              { reason: "highspeed_request_failed" },
            ],
          },
        },
      }),
    );

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "加速输入不应内联当前轮" },
      expect.objectContaining({
        requireQueue: true,
        intent: expect.objectContaining({
          requestedDelivery: "guide",
          admittedDelivery: "queue",
          fallbackReasonCode: "highspeed.requiresQueue",
          highspeed: expect.objectContaining({ cardId: "card-guide" }),
          modelSelection: ORDINARY_MODEL_SELECTION,
        }),
      }),
    );
    expect(retainQueuedTurnExecution).toHaveBeenCalledWith("s1", "cmd-1", {
      modelSelection: {
        providerId: "account:bigmodel-highspeed-card",
        modelId: "GLM-5.3",
      },
      modelExecution: expect.objectContaining({ selectionScope: "execution" }),
    });
  });

  it("Core active turn 已存在但 controller 与投影尚未同步时，Highspeed 输入仍进入 queue", async () => {
    const app = makeApp({
      runtime: {
        getActiveTurnInfo: vi.fn().mockReturnValue({
          kind: "regular",
          steerable: true,
          turnId: "turn-highspeed",
        }),
      },
    });
    const record = makeRecord({ app });
    const retainQueuedTurnExecution = vi.fn();
    const host = makeHost(record, {
      ensureModelReady: vi.fn(),
      getInputRoutingMode: () => "startNow",
      retainQueuedTurnExecution,
    });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("sendText", {
          text: "controller 同步前也要排队",
          highspeedMeta: {
            schemaVersion: 1,
            cardId: "card-1",
            taskId: "s1",
            provider: "bigmodel",
            model: "GLM-5.3",
            issuedAt: 1,
            expiresAt: Date.now() + 60_000,
          },
          modelSelection: {
            providerId: "account:bigmodel-highspeed-card",
            modelId: "GLM-5.3",
          },
          modelExecution: {
            selectionScope: "execution",
            requestAuth: { apiKey: "card-jwt", headers: { "X-Highspeed-Card-ID": "card-1" } },
            selectionFallback: {
              providerId: "account:bigmodel-highspeed-card",
              target: ORDINARY_MODEL_SELECTION,
              rules: [
                { reason: "highspeed_card_expired", providerErrorCode: "3402" },
                { reason: "highspeed_request_failed" },
              ],
            },
          },
        }),
      ),
    ).resolves.toEqual({
      type: "inputAccepted",
      delivery: "queue",
      inputId: "cmd-1",
    });

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "controller 同步前也要排队" },
      expect.objectContaining({
        requireQueue: true,
        intent: expect.objectContaining({
          highspeed: expect.objectContaining({ cardId: "card-1" }),
          modelSelection: ORDINARY_MODEL_SELECTION,
        }),
      }),
    );
    // Enqueueing sends only the ordinary Selection and card metadata — no execution or
    // credentials — and still runs the Session model preflight like a normal round: after the
    // card expires, promotion uses the QueueItem's ordinary Selection, and an unavailable model
    // must surface at admission.
    expect(host.ensureModelReady).toHaveBeenCalledWith(record);
    expect(app.sendInput.mock.calls[0]?.[1]).not.toHaveProperty("modelExecution");
    expect(retainQueuedTurnExecution).toHaveBeenCalledWith("s1", "cmd-1", {
      modelSelection: {
        providerId: "account:bigmodel-highspeed-card",
        modelId: "GLM-5.3",
      },
      modelExecution: expect.objectContaining({ selectionScope: "execution" }),
    });
  });

  it("execution-scoped Selection 直接进入 Core，Session 模型从不临时切换", async () => {
    const order: string[] = [];
    const currentModel = "user-provider/user-model";
    let capturedOptions: SendInputOptions | undefined;
    let finishTurn!: () => void;
    const turnGate = new Promise<Record<string, never>>((resolve) => {
      finishTurn = () => resolve({});
    });
    const app = makeApp({
      getModel: vi.fn(() => currentModel),
      sendInput: vi.fn().mockImplementation(async (_input, options) => {
        capturedOptions = options;
        order.push(`send:${currentModel}`);
        return {
          completion: turnGate,
          kind: "started_turn",
          turnId: "turn-offpeak",
        };
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      ensureModelReady: vi.fn().mockImplementation(async () => {
        order.push(`preflight:${currentModel}`);
      }),
      afterLegacyStateMutation: vi.fn().mockImplementation(async () => {
        order.push(`ready:${currentModel}`);
      }),
    });

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "run in idle pool",
        modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
        modelExecution: {
          memoryExtraction: "skip",
          selectionScope: "execution",
          requestAuth: {
            apiKey: "request-key",
            headers: { "X-Off-Peak-Ticket-ID": "ticket-1" },
          },
          subagents: {
            foregroundModel: "submission",
            background: "deny",
          },
        },
      }),
    );
    expect(record.activeAbortController).toBeUndefined();

    finishTurn();
    await settle();

    expect(order).toEqual(["send:user-provider/user-model", "ready:user-provider/user-model"]);
    expect(host.ensureModelReady).not.toHaveBeenCalled();
    expect(capturedOptions?.intent?.modelSelection).toEqual({
      providerId: "account:zai-offpeak-idle-plan",
      modelId: "GLM-5.2",
    });
    expect(capturedOptions?.modelExecution).toMatchObject({
      memoryExtraction: "skip",
      selectionScope: "execution",
      subagents: { foregroundModel: "submission", background: "deny" },
    });
    await expect(
      capturedOptions?.modelExecution?.requestDependencies?.requestAuth?.source?.resolve({}),
    ).resolves.toEqual({
      apiKey: "request-key",
      headers: { "X-Off-Peak-Ticket-ID": "ticket-1" },
    });
    expect(record.activeAbortController).toBeUndefined();
  });

  it("execution-scoped Selection 不受 Session 模型恢复告警阻断", async () => {
    const app = makeApp();
    const record = makeRecord({
      app,
      restoreWarning: { message: "session model unavailable", type: "model_unavailable" },
    });
    const host = makeHost(record, {
      ensureModelReady: vi.fn(),
      hasUsableRuntimeModelTarget: vi.fn().mockReturnValue(false),
    });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("sendText", {
          text: "run in idle pool",
          modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
          modelExecution: {
            selectionScope: "execution",
            requestAuth: { apiKey: "request-key" },
          },
        }),
      ),
    ).resolves.toBeDefined();
    await settle();

    expect(host.ensureModelReady).not.toHaveBeenCalled();
    expect(record.restoreWarning).toEqual({
      message: "session model unavailable",
      type: "model_unavailable",
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "execution-scoped turn %s 后不污染下一条普通 prompt",
    async (outcome) => {
      const observedExecutionContexts: unknown[] = [];
      let sendCount = 0;
      const app = makeApp({
        sendInput: vi.fn().mockImplementation(async (_input, options) => {
          sendCount += 1;
          observedExecutionContexts.push(options?.modelExecution);
          if (sendCount === 1) {
            return {
              completion: Promise.reject(
                new DOMException(
                  outcome === "cancelled" ? "idle turn cancelled" : "idle turn failed",
                  outcome === "cancelled" ? "AbortError" : "Error",
                ),
              ),
              kind: "started_turn",
              turnId: `turn-${outcome}`,
            };
          }
          return {
            completion: Promise.resolve({}),
            kind: "started_turn",
            turnId: "turn-ordinary",
          };
        }),
      });
      const record = makeRecord({ app });
      const host = makeHost(record, {
        ensureModelReady: vi.fn(),
      });

      await new V4CommandExecutor(host).execute(
        envelope("sendText", {
          text: "idle prompt",
          modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
          modelExecution: {
            selectionScope: "execution",
            requestAuth: { apiKey: `ticket-${outcome}` },
          },
        }),
      );
      await settle();

      expect(record.activeAbortController).toBeUndefined();

      await new V4CommandExecutor(host).execute(envelope("sendText", { text: "ordinary prompt" }));
      await settle();

      expect(observedExecutionContexts[0]).toBeDefined();
      expect(observedExecutionContexts[1]).toBeUndefined();
    },
  );

  it("automation sendText 仅在当前 turn 隐藏全部 automation 写工具", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "automation prompt",
        automationId: "automation-1",
        highspeedMeta: {
          schemaVersion: 1,
          cardId: "card-1",
          taskId: "s1",
          provider: "bigmodel",
          model: "GLM-5.3",
          issuedAt: 1,
          expiresAt: Date.now() + 60_000,
        },
        modelSelection: {
          providerId: "account:bigmodel-highspeed-card",
          modelId: "GLM-5.3",
        },
        modelExecution: {
          selectionScope: "execution",
          requestAuth: { apiKey: "card-jwt" },
        },
      }),
    );
    await settle();
    await new V4CommandExecutor(host).execute(envelope("sendText", { text: "normal prompt" }));
    await settle();

    expect(app.sendInput.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        toolDisallowlist: ["CronCreate", "CronUpdate", "CronDelete"],
      }),
    );
    expect(app.sendInput.mock.calls[0]?.[1]?.intent).not.toHaveProperty("highspeed");
    // Scheduled-execution identity wins: the accelerated Selection and execution material must
    // be dropped wholesale before admission. The intent still freezes the session's resident
    // Selection (generic behavior of a normal round), but never the accelerated-card provider —
    // otherwise this round would send requests with accelerated-card credentials or persist
    // ordinary output as Highspeed messages.
    expect(app.sendInput.mock.calls[0]?.[1]?.intent?.modelSelection).toEqual({
      providerId: "account:bigmodel-start-plan",
      modelId: "glm-5",
    });
    expect(app.sendInput.mock.calls[0]?.[1]).not.toHaveProperty("modelExecution");
    expect(app.sendInput.mock.calls[1]?.[1]).not.toHaveProperty("toolDisallowlist");
    expect(record.activeAutomationId).toBeUndefined();
  });

  it("Highspeed 用户 turn 保留 CronCreate 工具可见性", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "加速期间创建一个定时任务",
        highspeedMeta: {
          schemaVersion: 1,
          cardId: "card-1",
          taskId: "s1",
          provider: "bigmodel",
          model: "GLM-5.3",
          issuedAt: 1,
          expiresAt: Date.now() + 60_000,
        },
        modelSelection: {
          providerId: "account:bigmodel-highspeed-card",
          modelId: "GLM-5.3",
        },
        modelExecution: {
          selectionScope: "execution",
          requestAuth: { apiKey: "card-jwt" },
        },
      }),
    );
    await settle();

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "加速期间创建一个定时任务" },
      expect.not.objectContaining({ toolDisallowlist: expect.anything() }),
    );
  });

  it("Bot delivery target 仅在当前 turn 可见，并在 turn 结束后恢复", async () => {
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        completion: turnGate,
        kind: "started_turn",
        turnId: "turn-bot",
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record);
    const botDeliveryTarget = {
      provider: "weixin" as const,
      botId: "bot-weixin",
      providerUserId: "chat-1",
      chatType: "private" as const,
    };

    await new V4CommandExecutor(host).execute(
      envelope("sendText", { text: "创建提醒", botDeliveryTarget }),
    );
    expect(record.activeBotDeliveryTarget).toEqual(botDeliveryTarget);
    releaseTurn();
    await settle();
    expect(record.activeBotDeliveryTarget).toBeUndefined();
  });

  it("off-peak sendText 保留本轮归因与独立创建限制，普通后续轮不继承", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "off-peak prompt",
        offPeakTaskId: "off-peak-task-1",
        offPeakRunType: "resume",
      }),
    );
    await settle();
    await new V4CommandExecutor(host).execute(envelope("sendText", { text: "manual follow-up" }));
    await settle();

    expect(app.sendInput.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        offPeakTaskId: "off-peak-task-1",
        offPeakRunType: "resume",
      }),
    );
    // Off-peak supports SendMessage; standalone workflows cannot inherit the ticket, so their
    // execution and modification entries stay restricted. The Host's extra denylist is merged separately.
    expect(app.sendInput.mock.calls[0]?.[1].toolDisallowlist).toEqual([
      "OffPeakCreate",
      "Workflow",
      "CreateWorkflow",
      "AmendWorkflow",
      "ResumeWorkflowRun",
      "EvalWorkflowSnippet",
    ]);
    expect(app.sendInput.mock.calls[1]?.[1]).not.toHaveProperty("offPeakTaskId");
    expect(app.sendInput.mock.calls[1]?.[1]).not.toHaveProperty("offPeakRunType");
    expect(app.sendInput.mock.calls[1]?.[1]).not.toHaveProperty("toolDisallowlist");
  });

  it("调用方伪造 automation inputId 时不恢复任务身份", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute({
      ...envelope("sendText", { text: "ordinary prompt" }),
      commandId: "automation-other-task:manual:forged-run",
    });
    await settle();

    expect(app.sendInput.mock.calls[0]?.[1]).not.toHaveProperty("automationId");
    expect(app.sendInput.mock.calls[0]?.[1]).not.toHaveProperty("toolDisallowlist");
    expect(record.activeAutomationId).toBeUndefined();
  });

  it("cron task 普通 sendText 隐藏 CronCreate 但不进入 automation 派发态", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "拒绝删除旧任务后继续设置新提醒",
        toolDisallowlist: ["CronCreate"],
      }),
    );
    await settle();

    expect(app.sendInput.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ toolDisallowlist: ["CronCreate"] }),
    );
    expect(record.activeAutomationId).toBeUndefined();
  });

  it("运行中会话：Bootstrap 仍走 Core admission，由 Core 返回 queue receipt", async () => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "queued",
        pendingInputId: "pending-followup",
        queueLength: 1,
        turnId: "turn-1",
      }),
    });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const host = makeHost(record);
    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "追加",
        modelSelection: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "high" },
        },
        mode: "plan",
      }),
    );
    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "追加" },
      expect.objectContaining({
        delivery: "start_turn",
        inputId: "cmd-1",
        intent: expect.objectContaining({
          sourceCommandId: "cmd-1",
          queueItemId: "queue_cmd-1",
          clientId: "client-test",
          modelSelection: {
            providerId: "provider-b",
            modelId: "model-b",
            options: { reasoningLevel: "high" },
          },
          mode: "build",
          planEnabled: true,
        }),
      }),
    );
    expect(app.steerTurn).not.toHaveBeenCalled();
  });

  // Send-now is the user's new instruction: after actually preempting the old execution, the input is still a normal user message, same as sending while idle.
  it.each([
    { stopKind: "stopped", attachmentMime: undefined },
    { stopKind: "idle", attachmentMime: undefined },
    { stopKind: "stopped", attachmentMime: "text/plain" },
  ])(
    "startNow 抢占后仍是普通用户输入：$stopKind / $attachmentMime",
    async ({ stopKind, attachmentMime }) => {
      const app = makeApp({
        runtime: {
          acquireForegroundPromotionLease: vi.fn().mockReturnValue({ kind: "acquired" }),
          getActiveForegroundExecutionId: vi.fn().mockReturnValue(undefined),
          releaseForegroundPromotionLease: vi.fn().mockReturnValue(true),
          stopActiveForegroundExecution: vi
            .fn()
            .mockReturnValue(
              stopKind === "stopped"
                ? { kind: "stopped", foregroundExecutionId: "foreground-1" }
                : { kind: "idle" },
            ),
        },
      });
      // Even if the UI still shows busy, Core's idle receipt must not be guessed as a preemption.
      const host = makeHost(makeRecord({ app }), { getInputRoutingMode: () => "enqueue" });
      await new V4CommandExecutor(host).execute(
        envelope("sendText", {
          text: "先处理这个短任务",
          requestedDelivery: "startNow",
          ...(attachmentMime
            ? {
                attachments: [
                  { ref: "/tmp/note", fileName: "note", mime: attachmentMime, bytes: 9 },
                ],
              }
            : {}),
        }),
      );
      expect(app.sendInput).toHaveBeenCalledTimes(1);
      const [input, options] = app.sendInput.mock.calls[0]!;
      expect(input.text).toBe("先处理这个短任务");
      expect(options).not.toHaveProperty("inputPresentation");
      expect(options).toMatchObject({
        inputId: "cmd-1",
        requireIdle: true,
        intent: { requestedDelivery: "startNow" },
      });
    },
  );

  it("抢占后的 startNow 经真实 input facade 以普通用户输入进入新轮 Core admission", async () => {
    const runtime = {
      acquireForegroundPromotionLease: vi.fn().mockReturnValue({ kind: "acquired" }),
      getActiveForegroundExecutionId: vi.fn().mockReturnValue(undefined),
      releaseForegroundPromotionLease: vi.fn().mockReturnValue(true),
      stopActiveForegroundExecution: vi
        .fn()
        .mockReturnValue({ kind: "stopped", foregroundExecutionId: "foreground-1" }),
      admitPrompt: vi
        .fn()
        .mockResolvedValue({ kind: "started", turnId: "turn-2", completion: Promise.resolve({}) }),
    };
    const facade = createInputFacade({
      logger: { warn: vi.fn() } as never,
      prepareUserExecutionBoundary: async () => {},
      runtime: runtime as never,
      sessionId: "s1" as never,
      traceContext: { traceId: "trace-1" } as never,
    });
    const app = makeApp({ runtime, sendInput: facade.sendInput });
    await new V4CommandExecutor(makeHost(makeRecord({ app }))).execute(
      envelope("sendText", { text: "短任务", requestedDelivery: "startNow" }),
    );
    expect(runtime.admitPrompt).toHaveBeenCalledWith(
      "短任务",
      undefined,
      expect.objectContaining({
        inputId: "cmd-1",
        requireIdle: true,
        delivery: "start_turn",
      }),
    );
    expect(runtime.admitPrompt.mock.calls[0]![2]).not.toHaveProperty("inputPresentation");
  });

  it("运行中 startNow：原子抢占后直接启动新 turn，不创建 queue item", async () => {
    const controller = new AbortController();
    const acquireForegroundPromotionLease = vi.fn().mockReturnValue({ kind: "acquired" });
    const releaseForegroundPromotionLease = vi.fn().mockReturnValue(true);
    const app = makeApp({
      runtime: {
        acquireForegroundPromotionLease,
        getActiveForegroundExecutionId: vi.fn().mockReturnValue(undefined),
        releaseForegroundPromotionLease,
        stopActiveForegroundExecution: vi.fn().mockReturnValue({ kind: "idle" }),
      },
    });
    const record = makeRecord({ app, activeAbortController: controller });
    controller.signal.addEventListener("abort", () => {
      record.activeAbortController = undefined;
    });

    await new V4CommandExecutor(makeHost(record)).execute(
      envelope("sendText", { text: "现在执行", requestedDelivery: "startNow" }),
    );

    expect(acquireForegroundPromotionLease).toHaveBeenCalledWith({
      leaseId: "send-now:cmd-1",
      mode: "after-current",
      promotedInputId: "cmd-1",
    });
    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "现在执行" },
      expect.objectContaining({
        requireIdle: true,
        intent: expect.objectContaining({
          admittedDelivery: "startNow",
          requestedDelivery: "startNow",
          sourceCommandId: "cmd-1",
        }),
      }),
    );
    expect(app.steerTurn).not.toHaveBeenCalled();
    expect(releaseForegroundPromotionLease).toHaveBeenCalledWith("send-now:cmd-1");
  });

  it("伪造 automation inputId 排队时仍保持普通用户轮", async () => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "queued",
        pendingInputId: "pending-ordinary-followup",
        queueLength: 1,
        turnId: "turn-1",
      }),
    });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute({
      ...envelope("sendText", { text: "ordinary followup" }),
      commandId: "automation-other-task:manual:forged-run",
    });

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "ordinary followup" },
      expect.objectContaining({
        delivery: "start_turn",
        inputId: "automation-other-task:manual:forged-run",
      }),
    );
    expect(app.sendInput.mock.calls[0]?.[1]).not.toHaveProperty("automationId");
    expect(app.sendInput.mock.calls[0]?.[1]).not.toHaveProperty("toolDisallowlist");
    expect(app.steerTurn).not.toHaveBeenCalled();
  });

  it.each([
    "account:bigmodel-start-plan/glm-5",
    "custom-openai/gpt-5",
    "anthropic/claude-sonnet-4-5",
  ])("guide eligible：running + 无普通 queue 时模型 %s 按 guide 投递", async (model) => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "queued",
        pendingInputId: "pending-guide",
        queueLength: 1,
        turnId: "turn-1",
      }),
      getModel: vi.fn().mockReturnValue(model),
      runtime: { getActiveTurnInfo: vi.fn().mockReturnValue({ steerable: true }) },
    });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const host = makeHost(record, {
      getInputRoutingMode: () => "guide",
      hasQueuedDelivery: () => false,
    });

    const [providerId, ...modelSegments] = model.split("/");
    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "引导当前工作",
        modelSelection: { providerId, modelId: modelSegments.join("/") },
        mode: "build",
      }),
    );

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "引导当前工作" },
      expect.objectContaining({
        delivery: "start_turn",
        queueDelivery: "guide",
        intent: expect.objectContaining({
          requestedDelivery: "guide",
          admittedDelivery: "guide",
          modelSelection: { providerId, modelId: modelSegments.join("/") },
          mode: "build",
        }),
      }),
    );
    expect(app.getModel).not.toHaveBeenCalled();
  });

  it.each([
    {
      routingMode: "enqueue" as const,
      requestedDelivery: "guide" as const,
      expectedQueueDelivery: "guide" as const,
    },
    {
      routingMode: "guide" as const,
      requestedDelivery: "queue" as const,
      expectedQueueDelivery: undefined,
    },
  ])(
    "one-message $requestedDelivery overrides session routing $routingMode",
    async ({ routingMode, requestedDelivery, expectedQueueDelivery }) => {
      const app = makeApp({
        sendInput: vi.fn().mockResolvedValue({
          kind: "queued",
          pendingInputId: "pending-delivery-override",
          queueLength: 1,
          turnId: "turn-1",
        }),
      });
      const record = makeRecord({ app, activeAbortController: new AbortController() });
      const host = makeHost(record, { getInputRoutingMode: () => routingMode });

      await new V4CommandExecutor(host).execute(
        envelope("sendText", { text: "只反转这一条", requestedDelivery }),
      );

      expect(app.sendInput).toHaveBeenCalledWith(
        { text: "只反转这一条" },
        expect.objectContaining({
          delivery: "start_turn",
          ...(expectedQueueDelivery ? { queueDelivery: expectedQueueDelivery } : {}),
          intent: expect.objectContaining({
            requestedDelivery,
            admittedDelivery: requestedDelivery,
          }),
        }),
      );
      if (!expectedQueueDelivery) {
        expect(app.sendInput.mock.calls[0]?.[1]).not.toHaveProperty("queueDelivery");
      }
    },
  );

  it("guide intent 交给 Core，由 Core 决定 guide 或 queue", async () => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "queued",
        pendingInputId: "pending-guide-fallback",
        queueLength: 2,
        turnId: "turn-1",
      }),
      runtime: { getActiveTurnInfo: vi.fn().mockReturnValue({ steerable: true }) },
    });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const host = makeHost(record, {
      getInputRoutingMode: () => "guide",
      hasQueuedDelivery: (_sessionId, delivery) => delivery === "queue",
    });

    await new V4CommandExecutor(host).execute(envelope("sendText", { text: "回退内容" }));

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "回退内容" },
      expect.objectContaining({
        delivery: "start_turn",
        queueDelivery: "guide",
        intent: expect.objectContaining({
          requestedDelivery: "guide",
          admittedDelivery: "guide",
        }),
      }),
    );
  });

  it("goal verifier busy routing 早于 controller：进入 deferred queue，不误起第二条 turn", async () => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "queued",
        pendingInputId: "pending-deferred-1",
        queueLength: 1,
        turnId: "turn-1",
      }),
      runtime: { getActiveTurnInfo: vi.fn().mockReturnValue(undefined) },
    });
    const record = makeRecord({ app });
    const host = makeHost(record, { getInputRoutingMode: () => "enqueue" });
    await new V4CommandExecutor(host).execute(envelope("sendText", { text: "验证期间追加" }));
    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "验证期间追加" },
      expect.objectContaining({
        delivery: "start_turn",
        inputId: "cmd-1",
        queryId: "cmd-1",
        intent: expect.objectContaining({
          sourceCommandId: "cmd-1",
          queueItemId: "queue_cmd-1",
          requestedDelivery: "queue",
        }),
      }),
    );
    expect(app.steerTurn).not.toHaveBeenCalled();
  });

  it("automation 在 busy routing 入队时保留全部写工具 denylist", async () => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "queued",
        pendingInputId: "pending-automation-1",
        queueLength: 1,
        turnId: "turn-1",
      }),
      runtime: { getActiveTurnInfo: vi.fn().mockReturnValue(undefined) },
    });
    const record = makeRecord({ app });
    const host = makeHost(record, { getInputRoutingMode: () => "enqueue" });

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "automation busy prompt",
        automationId: "automation-1",
      }),
    );

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "automation busy prompt" },
      expect.objectContaining({
        automationId: "automation-1",
        delivery: "start_turn",
        inputId: "cmd-1",
        queryId: "cmd-1",
        toolDisallowlist: ["CronCreate", "CronUpdate", "CronDelete"],
      }),
    );
    expect(app.steerTurn).not.toHaveBeenCalled();
  });

  it("empty/oversize admission 显式失败，不返回 accepted 后静默丢输入", async () => {
    const idle = makeRecord({ app: makeApp() });
    await expect(
      new V4CommandExecutor(makeHost(idle)).execute(envelope("sendText", { text: "   " })),
    ).rejects.toMatchObject({ reasonCode: "proto.invalidPayload" });

    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "rejected",
        reason: "input_too_large",
      }),
    });
    const busy = makeRecord({ app, activeAbortController: new AbortController() });
    await expect(
      new V4CommandExecutor(makeHost(busy)).execute(envelope("sendText", { text: "oversized" })),
    ).rejects.toBeInstanceOf(V4PromptRejectedError);
    expect(app.steerTurn).not.toHaveBeenCalled();
  });

  it("draft 会话：首条发送把 persistence 提升为 immediate", async () => {
    const record = makeRecord({ persistence: "deferred" });
    await new V4CommandExecutor(makeHost(record)).execute(envelope("sendText", { text: "首条" }));
    expect(record.persistence).toBe("immediate");
  });

  it("restoreWarning 会话：拒绝新 turn（历史损坏不静默续写）", async () => {
    const record = makeRecord({
      restoreWarning: { message: "restore failed", type: "corrupt" },
    });
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(envelope("sendText", { text: "x" })),
    ).rejects.toThrow(V4PromptRejectedError);
  });

  it("restoreWarning 时序自愈：进程 Registry 已有可用模型 → 清告警放行", async () => {
    // Scenario: after an app restart, cold recovery runs before the provider registry push and
    // the record carries a "model unresolvable" warning; the registry then arrives (host probe
    // says available), and sending must no longer be permanently rejected by this stale
    // one-shot flag.
    const app = makeApp();
    const record = makeRecord({
      app,
      restoreWarning: {
        message: "runtime model unavailable",
        type: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
      },
    });
    await new V4CommandExecutor(
      makeHost(record, { hasUsableRuntimeModelTarget: () => true }),
    ).execute(envelope("sendText", { text: "重启后第一条" }));
    await settle();
    expect(record.restoreWarning).toBeUndefined();
    expect(app.sendInput).toHaveBeenCalled();
  });

  it("restoreWarning 保真：catalog 仍无可用模型 → 继续拒绝（不误放行）", async () => {
    const record = makeRecord({
      restoreWarning: {
        message: "runtime model unavailable",
        type: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
      },
    });
    await expect(
      new V4CommandExecutor(makeHost(record, { hasUsableRuntimeModelTarget: () => false })).execute(
        envelope("sendText", { text: "x" }),
      ),
    ).rejects.toThrow(V4PromptRejectedError);
    expect(record.restoreWarning).toBeDefined();
  });

  it("普通 Selection 不在 Worker Registry 时在 ACK 前拒绝并保留输入", async () => {
    const app = makeApp({ listModels: () => [] });
    const record = makeRecord({ app });
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendText", {
          text: "使用新 Provider",
          modelSelection: { providerId: "new-provider", modelId: "new-model" },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("无退回声明的 execution Selection 不在 Registry 时仍在 ACK 前拒绝", async () => {
    const app = makeApp({ listModels: () => [] });
    const record = makeRecord({ app });
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendText", {
          text: "使用不可退回的执行模型",
          modelSelection: { providerId: "new-provider", modelId: "new-model" },
          modelExecution: { selectionScope: "execution" },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("带同 Provider 退回声明且退回目标可用时，execution Selection 延迟到 Core 解析", async () => {
    const app = makeApp({
      listModels: () => [
        {
          ref: { providerId: "account:bigmodel-start-plan", modelId: "glm-5" },
        },
      ],
    });
    const record = makeRecord({ app });
    const selectionFallback = {
      providerId: "account:bigmodel-highspeed-card",
      rules: [{ reason: "highspeed_selection_unavailable" as const }],
      target: { providerId: "account:bigmodel-start-plan", modelId: "glm-5" },
    };

    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendText", {
          text: "使用可退回的执行模型",
          modelSelection: {
            providerId: "account:bigmodel-highspeed-card",
            modelId: "missing-highspeed-model",
          },
          modelExecution: { selectionScope: "execution", selectionFallback },
        }),
      ),
    ).resolves.toBeDefined();
    await settle();

    expect(app.sendInput).toHaveBeenCalledWith(
      { text: "使用可退回的执行模型" },
      expect.objectContaining({
        intent: expect.objectContaining({
          modelSelection: {
            providerId: "account:bigmodel-highspeed-card",
            modelId: "missing-highspeed-model",
          },
        }),
        modelExecution: expect.objectContaining({
          selectionScope: "execution",
          selectionFallback,
        }),
      }),
    );
  });

  it("Highspeed execution Selection 可用时不因退回目标缺失而拒绝", async () => {
    const highspeedSelection = {
      providerId: "account:bigmodel-highspeed-card",
      modelId: "GLM-5.3",
    };
    const app = makeApp({
      listModels: () => [{ ref: highspeedSelection }],
    });
    const record = makeRecord({ app });

    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendText", {
          text: "执行模型可用时继续发送",
          modelSelection: highspeedSelection,
          modelExecution: {
            selectionScope: "execution",
            selectionFallback: {
              providerId: highspeedSelection.providerId,
              rules: [{ reason: "highspeed_selection_unavailable" }],
              target: { providerId: "missing-fallback", modelId: "missing-model" },
            },
          },
        }),
      ),
    ).resolves.toBeDefined();
    expect(app.sendInput).toHaveBeenCalledTimes(1);
  });

  it("Highspeed execution Selection 与退回目标都不在 Registry 时在 ACK 前拒绝", async () => {
    const app = makeApp({ listModels: () => [] });
    const record = makeRecord({ app });

    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendText", {
          text: "双模型都不可用时保留输入",
          modelSelection: {
            providerId: "account:bigmodel-highspeed-card",
            modelId: "missing-highspeed-model",
          },
          modelExecution: {
            selectionScope: "execution",
            selectionFallback: {
              providerId: "account:bigmodel-highspeed-card",
              rules: [{ reason: "highspeed_selection_unavailable" }],
              target: { providerId: "account:bigmodel-start-plan", modelId: "glm-5" },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("退回声明与 execution Provider 不一致时仍在 ACK 前拒绝", async () => {
    const app = makeApp({ listModels: () => [] });
    const record = makeRecord({ app });
    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendText", {
          text: "使用声明不一致的执行模型",
          modelSelection: {
            providerId: "account:bigmodel-highspeed-card",
            modelId: "missing-highspeed-model",
          },
          modelExecution: {
            selectionScope: "execution",
            selectionFallback: {
              providerId: "other-provider",
              rules: [{ reason: "highspeed_selection_unavailable" }],
              target: { providerId: "account:bigmodel-start-plan", modelId: "glm-5" },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("排队 execution Selection 仍按原模型目录做 admission 预检", async () => {
    const app = makeApp({ listModels: () => [] });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    await expect(
      new V4CommandExecutor(makeHost(record, { getInputRoutingMode: () => "enqueue" })).execute(
        envelope("sendText", {
          text: "排队执行模型",
          modelSelection: {
            providerId: "account:bigmodel-highspeed-card",
            modelId: "missing-highspeed-model",
          },
          modelExecution: {
            selectionScope: "execution",
            selectionFallback: {
              providerId: "account:bigmodel-highspeed-card",
              rules: [{ reason: "highspeed_selection_unavailable" }],
              target: { providerId: "account:bigmodel-start-plan", modelId: "glm-5" },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "modelUnavailable" });
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("turn 失败：finally 仍释放锁，legacy 广播 reason=prompt_failed", async () => {
    const app = makeApp({ sendInput: vi.fn().mockRejectedValue(new Error("boom")) });
    const record = makeRecord({ app });
    const host = makeHost(record);
    await expect(
      new V4CommandExecutor(host).execute(envelope("sendText", { text: "x" })),
    ).rejects.toThrow("boom");
    expect(record.activeAbortController).toBeUndefined();
    expect(host.legacyMutations).toEqual(["prompt_failed"]);
  });
});

describe("v4 原生 sendText：软门禁（soft gate）", () => {
  it("startPromptTurn 不再把 authority observer 传给 Core admission", async () => {
    let capturedOptions: PromptSendInputOptions | undefined;
    const app = makeApp({
      sendInput: vi.fn().mockImplementation(async (_input, options) => {
        capturedOptions = options as PromptSendInputOptions;
        return {
          completion: Promise.resolve({}),
          kind: "started_turn",
          turnId: "turn-1",
        };
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record);

    await new V4CommandExecutor(host).execute(envelope("sendText", { text: "test" }));
    await settle();

    // The projection observer was removed; Core admission ACK does not wait for TurnStarted.
    expect(capturedOptions!.onEvent).toBeUndefined();
    expect(capturedOptions!.onTurnStartedObserved).toBeUndefined();
  });

  it("projection commit 永不完成时，input ACK 仍立即返回", async () => {
    const turnGate = deferred<void>();
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        completion: turnGate.promise,
        kind: "started_turn",
        turnId: "turn-1",
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      waitForProjectionEventCommit: async () => {
        await new Promise<void>(() => {});
      },
    });

    const executing = new V4CommandExecutor(host).execute(
      envelope("sendText", { text: "等待 projection commit" }),
    );

    await vi.waitFor(() => expect(app.sendInput).toHaveBeenCalled());
    await flushMicrotasks();
    // The projection commit plays no part in admission; deliberately leave it unresolved.
    await executing;
    turnGate.resolve(undefined);
    await settle();
  });

  it("回归：TurnStarted 后 projection 延迟时，第二条只产生一个 Core queue item", async () => {
    const admissions: Array<"started" | "queued"> = [];
    const runtime = {
      // Bootstrap no longer queries activeTurn; Core admission holds the starting/active state itself.
      getActiveTurnInfo: vi.fn(),
    };
    const sendInput = vi.fn().mockImplementation(async () => {
      const admission = admissions.length === 0 ? "started" : "queued";
      admissions.push(admission);
      return admission === "started"
        ? { kind: "accepted", delivery: "startNow", inputId: `cmd-${admissions.length}` }
        : {
            kind: "queued",
            pendingInputId: "pending-stalled-followup",
            queueLength: 1,
            turnId: "turn-stalled-before-model",
          };
    });
    const app = makeApp({ sendInput, runtime });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      getInputRoutingMode: () => "startNow",
      waitForProjectionEventCommit: vi.fn(() => new Promise<void>(() => {})),
    });
    const executor = new V4CommandExecutor(host);

    const first = executor.execute(envelope("sendText", { text: "触发卡住的首条" }));
    await flushMicrotasks();
    const second = executor.execute(envelope("sendText", { text: "卡住期间的下一条" }));
    await Promise.all([first, second]);

    expect(admissions).toEqual(["started", "queued"]);
    expect(runtime.getActiveTurnInfo).not.toHaveBeenCalled();
  });
});

describe("v4 原生 sendText：held choice 裁决（catalog B06/B07）", () => {
  it("held（routing=choice）缺 disposition → 拒绝 heldQueueDispositionRequired", async () => {
    const app = makeApp({ clearQueueItems: vi.fn().mockResolvedValue(0) });
    const record = makeRecord({ app });
    const host = makeHost(record, { getInputRoutingMode: () => "choice" });
    await expect(
      new V4CommandExecutor(host).execute(envelope("sendText", { text: "x" })),
    ).rejects.toMatchObject({ reasonCode: "heldQueueDispositionRequired" });
    expect(app.sendInput).not.toHaveBeenCalled();
    expect(app.clearQueueItems).not.toHaveBeenCalled();
  });

  it("held + clearQueueAndSend → 先清空 queue 再起 turn", async () => {
    const calls: string[] = [];
    const app = makeApp({
      clearQueueItems: vi.fn().mockImplementation(async () => {
        calls.push("clear");
        return 2;
      }),
      sendInput: vi.fn().mockImplementation(async (_input, options) => {
        calls.push("send");
        return {
          completion: Promise.resolve({}),
          kind: "started_turn",
          turnId: "turn-held-clear",
        };
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, { getInputRoutingMode: () => "choice" });
    await new V4CommandExecutor(host).execute(
      envelope("sendText", { text: "新问题", heldQueueDisposition: "clearQueueAndSend" }),
    );
    await settle();
    expect(calls).toEqual(["clear", "send"]);
  });

  it("ISSUE-063: held + clearQueueAndSend releases the stop hold after clearing, before the turn starts", async () => {
    const calls: string[] = [];
    const app = makeApp({
      clearQueueItems: vi.fn().mockImplementation(async () => {
        calls.push("clear");
        return 1;
      }),
      setQueueAutoDrain: vi.fn().mockImplementation(async (autoDrain: boolean) => {
        calls.push(`autoDrain:${autoDrain}`);
      }),
      completeExternalQueueDrain: vi.fn().mockImplementation(() => {
        calls.push("completeDrain");
      }),
      sendInput: vi.fn().mockImplementation(async () => {
        calls.push("send");
        return { completion: Promise.resolve({}), kind: "started_turn", turnId: "turn-063" };
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      getInputRoutingMode: () => "choice",
      clearQueuedTurnExecutions: vi.fn(() => {
        calls.push("clearExecutions");
      }),
    });
    await new V4CommandExecutor(host).execute(
      envelope("sendText", { text: "新问题", heldQueueDisposition: "clearQueueAndSend" }),
    );
    await settle();
    expect(calls).toEqual(["clear", "clearExecutions", "autoDrain:true", "completeDrain", "send"]);
    // Nothing is left to promote: the release must not run the queue ready hook.
    expect(host.legacyMutations).not.toContain("queue_auto_drain_resumed");
  });

  it("ISSUE-063: a failed hold release is logged and the send still starts", async () => {
    const warn = vi.fn();
    const app = makeApp({
      clearQueueItems: vi.fn().mockResolvedValue(1),
      setQueueAutoDrain: vi.fn().mockRejectedValue(new Error("append failed")),
      completeExternalQueueDrain: vi.fn(),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      getInputRoutingMode: () => "choice",
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
    });
    await new V4CommandExecutor(host).execute(
      envelope("sendText", { text: "新问题", heldQueueDisposition: "clearQueueAndSend" }),
    );
    await settle();
    expect(warn).toHaveBeenCalledWith(
      "v4 clearQueueAndSend failed to release queue hold",
      expect.objectContaining({ sessionId: "s1" }),
    );
    expect(app.completeExternalQueueDrain).not.toHaveBeenCalled();
    expect(app.sendInput).toHaveBeenCalledTimes(1);
  });

  it("held + startNow + clearQueueAndSend → 仍先清空 queue 再起 turn", async () => {
    const calls: string[] = [];
    const app = makeApp({
      clearQueueItems: vi.fn().mockImplementation(async () => {
        calls.push("clear");
        return 2;
      }),
      runtime: {
        acquireForegroundPromotionLease: vi.fn().mockReturnValue({ kind: "acquired" }),
        getActiveForegroundExecutionId: vi.fn().mockReturnValue(undefined),
        releaseForegroundPromotionLease: vi.fn().mockReturnValue(true),
        stopActiveForegroundExecution: vi.fn().mockReturnValue({ kind: "idle" }),
      },
      sendInput: vi.fn().mockImplementation(async (_input, options) => {
        calls.push("send");
        return {
          completion: Promise.resolve({}),
          kind: "started_turn",
          turnId: "turn-held-start-now",
        };
      }),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      getInputRoutingMode: () => "choice",
      getQueueLength: () => 2,
      getQueueItem: (_sessionId, queueItemId) => ({ queueItemId }) as never,
    });

    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "新问题",
        requestedDelivery: "startNow",
        heldQueueDisposition: "clearQueueAndSend",
        expectedHeldQueueItemIds: ["q-1", "q-2"],
      }),
    );
    await settle();

    expect(calls).toEqual(["clear", "send"]);
  });

  it("held + startNow 的 queue ids 过期时拒绝清空和启动 turn", async () => {
    const app = makeApp({
      clearQueueItems: vi.fn().mockResolvedValue(0),
      runtime: {
        acquireForegroundPromotionLease: vi.fn().mockReturnValue({ kind: "acquired" }),
        releaseForegroundPromotionLease: vi.fn().mockReturnValue(true),
      },
    });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      getInputRoutingMode: () => "choice",
      getQueueLength: () => 2,
      getQueueItem: (_sessionId, queueItemId) =>
        queueItemId === "q-1" ? ({ queueItemId } as never) : null,
    });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("sendText", {
          text: "新问题",
          requestedDelivery: "startNow",
          heldQueueDisposition: "clearQueueAndSend",
          expectedHeldQueueItemIds: ["q-1"],
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "guard.heldQueueConfirmationStale" });
    expect(app.clearQueueItems).not.toHaveBeenCalled();
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("held + keepQueueAndSend → 不清 queue 直接起 turn", async () => {
    const app = makeApp({
      clearQueueItems: vi.fn().mockResolvedValue(0),
      setQueueAutoDrain: vi.fn().mockResolvedValue(undefined),
      completeExternalQueueDrain: vi.fn(),
    });
    const record = makeRecord({ app });
    const host = makeHost(record, { getInputRoutingMode: () => "choice" });
    await new V4CommandExecutor(host).execute(
      envelope("sendText", { text: "新问题", heldQueueDisposition: "keepQueueAndSend" }),
    );
    await settle();
    expect(app.clearQueueItems).not.toHaveBeenCalled();
    // ISSUE-063: keep means the queue stays paused, so the hold is kept.
    expect(app.setQueueAutoDrain).not.toHaveBeenCalled();
    expect(app.completeExternalQueueDrain).not.toHaveBeenCalled();
    expect(app.sendInput).toHaveBeenCalled();
  });

  it("held 确认绑定 queueItemId 集合：跨端增删后拒绝旧确认且不清空/发送", async () => {
    const app = makeApp({ clearQueueItems: vi.fn().mockResolvedValue(0) });
    const record = makeRecord({ app });
    const getQueueItem = vi.fn((_sessionId: string, queueItemId: string) =>
      queueItemId === "q-1" ? ({ queueItemId } as never) : null,
    );
    const host = makeHost(record, {
      getInputRoutingMode: () => "choice",
      getQueueLength: () => 2,
      getQueueItem,
    });
    await expect(
      new V4CommandExecutor(host).execute(
        envelope("sendText", {
          text: "新问题",
          heldQueueDisposition: "clearQueueAndSend",
          expectedHeldQueueItemIds: ["q-1"],
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "guard.heldQueueConfirmationStale" });
    expect(app.clearQueueItems).not.toHaveBeenCalled();
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it("held 确认的 ID 集合未变化时允许执行；重排不使确认失效", async () => {
    const app = makeApp({ clearQueueItems: vi.fn().mockResolvedValue(2) });
    const record = makeRecord({ app });
    const host = makeHost(record, {
      getInputRoutingMode: () => "choice",
      getQueueLength: () => 2,
      getQueueItem: (_sessionId, queueItemId) => ({ queueItemId }) as never,
    });
    await new V4CommandExecutor(host).execute(
      envelope("sendText", {
        text: "新问题",
        heldQueueDisposition: "clearQueueAndSend",
        expectedHeldQueueItemIds: ["q-2", "q-1"],
      }),
    );
    await settle();
    expect(app.clearQueueItems).toHaveBeenCalledTimes(1);
    expect(app.sendInput).toHaveBeenCalledTimes(1);
  });

  it("非 held（routing=startNow）缺 disposition → 正常起 turn（不误拒）", async () => {
    const app = makeApp({ clearQueueItems: vi.fn().mockResolvedValue(0) });
    const record = makeRecord({ app });
    const host = makeHost(record, { getInputRoutingMode: () => "startNow" });
    await new V4CommandExecutor(host).execute(envelope("sendText", { text: "x" }));
    await settle();
    expect(app.sendInput).toHaveBeenCalled();
    expect(app.clearQueueItems).not.toHaveBeenCalled();
  });
});

describe("v4 原生 stop", () => {
  it("active turn + active goal：先 pause goal 再 abort（barrier 顺序）", async () => {
    const calls: string[] = [];
    const app = makeApp({
      readTarget: vi.fn().mockResolvedValue({ targetID: "g1", status: "active" }),
      updateTargetStatus: vi.fn().mockImplementation(async () => {
        calls.push("pause");
        return { targetID: "g1", status: "paused" };
      }),
    });
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => calls.push("abort"));
    const record = makeRecord({ app, activeAbortController: controller });
    const host = makeHost(record);
    await new V4CommandExecutor(host).execute(envelope("stop", {}));
    expect(calls).toEqual(["pause", "abort"]);
    expect(host.legacyMutations).toEqual(["session_stop_goal_paused"]);
  });

  it("无 active turn：不触碰 goal，abort 为 noop", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    const host = makeHost(record);
    await new V4CommandExecutor(host).execute(envelope("stop", {}));
    expect(app.readTarget).not.toHaveBeenCalled();
    expect(host.legacyMutations).toEqual([]);
  });

  it("pause goal 抛错：不阻断 abort（stop 必须成功）", async () => {
    const app = makeApp({
      readTarget: vi.fn().mockResolvedValue({ targetID: "g1", status: "active" }),
      updateTargetStatus: vi.fn().mockRejectedValue(new Error("verifier busy")),
    });
    const controller = new AbortController();
    const record = makeRecord({ app, activeAbortController: controller });
    await new V4CommandExecutor(makeHost(record)).execute(envelope("stop", {}));
    expect(controller.signal.aborted).toBe(true);
  });

  it("goal verifier：先取消 runtime 前台执行，再暂停 goal 并关闭外层窗口", async () => {
    const calls: string[] = [];
    const setQueueAutoDrain = vi.fn().mockImplementation(async () => {
      calls.push("hold-queue");
    });
    const stopActiveForegroundExecution = vi.fn().mockImplementation(() => {
      calls.push("runtime-abort");
      return { kind: "stopped", foregroundExecutionId: "foreground-1" };
    });
    const app = makeApp({
      runtime: {
        stopActiveForegroundExecution,
        getActiveForegroundExecutionId: () => "foreground-1",
      },
      setQueueAutoDrain,
      readTarget: vi.fn().mockResolvedValue({ targetID: "g1", status: "active" }),
      updateTargetStatus: vi.fn().mockImplementation(async () => {
        calls.push("pause");
        return { targetID: "g1", status: "paused" };
      }),
    });
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => calls.push("outer-abort"));
    const record = makeRecord({ app, activeAbortController: controller });
    const info = vi.fn();

    await new V4CommandExecutor(
      makeHost(record, {
        getQueueLength: () => 1,
        logger: { info } as never,
      }),
    ).execute(envelope("stop", { expectedForegroundExecutionId: "foreground-1" }));

    expect(stopActiveForegroundExecution).toHaveBeenCalledWith({
      expectedForegroundExecutionId: "foreground-1",
      reason: "v4 session stopped",
    });
    expect(setQueueAutoDrain).toHaveBeenCalledWith(false);
    // The queue hold must land in the projection before any abort (ISSUE-010): the turn-end auto-drain check reads only the projection.
    expect(calls).toEqual(["hold-queue", "runtime-abort", "outer-abort", "pause"]);
    expect(info).toHaveBeenCalledWith("v4 stop foreground execution inspected", {
      activeForegroundExecutionId: "foreground-1",
      event: "v4.stop.foreground_execution_inspected",
      expectedForegroundExecutionId: "foreground-1",
      module: "bootstrap.zcode_protocol_v4.commands",
      runtimeStopKind: "stopped",
      sessionId: "s1",
    });
  });

  it("迟到 Stop 的 execution id 已变化：返回 noop，且不误杀新执行", async () => {
    const stopActiveForegroundExecution = vi.fn().mockReturnValue({
      kind: "mismatch",
      activeForegroundExecutionId: "foreground-2",
    });
    const app = makeApp({ runtime: { stopActiveForegroundExecution } });
    const controller = new AbortController();
    const record = makeRecord({ app, activeAbortController: controller });

    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("stop", { expectedForegroundExecutionId: "foreground-1" }),
      ),
    ).rejects.toMatchObject({ reasonCode: "guard.stopTargetChanged" });
    expect(controller.signal.aborted).toBe(false);
    expect(app.readTarget).not.toHaveBeenCalled();
  });

  // Projection learns the authorization bit asynchronously (event store persistence), so the
  // turn-end drain check sees the flag only after the hold is durable and projected.
  function projectionLatencyHold() {
    const state = { projectedAutoDrain: true, seenAtAbort: [] as boolean[] };
    const setQueueAutoDrain = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      state.projectedAutoDrain = false;
    });
    return { state, setQueueAutoDrain };
  }

  it("ISSUE-010: runtime stop writes the queue hold first; the turn-end check sees autoDrain=false at abort", async () => {
    const { state, setQueueAutoDrain } = projectionLatencyHold();
    const stopActiveForegroundExecution = vi.fn().mockReturnValue({
      kind: "stopped",
      foregroundExecutionId: "foreground-1",
    });
    const app = makeApp({
      runtime: {
        stopActiveForegroundExecution,
        getActiveForegroundExecutionId: () => "foreground-1",
      },
      setQueueAutoDrain,
    });
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => state.seenAtAbort.push(state.projectedAutoDrain));
    const record = makeRecord({ app, activeAbortController: controller });

    await new V4CommandExecutor(makeHost(record, { getQueueLength: () => 2 })).execute(
      envelope("stop", { expectedForegroundExecutionId: "foreground-1" }),
    );

    expect(setQueueAutoDrain).toHaveBeenCalledWith(false);
    expect(state.seenAtAbort).toEqual([false]);
  });

  it("ISSUE-010: a compat controller stop (no runtime execution token) also holds before aborting", async () => {
    const { state, setQueueAutoDrain } = projectionLatencyHold();
    const app = makeApp({ setQueueAutoDrain });
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => state.seenAtAbort.push(state.projectedAutoDrain));
    const record = makeRecord({ app, activeAbortController: controller });

    await new V4CommandExecutor(makeHost(record, { getQueueLength: () => 1 })).execute(
      envelope("stop", {}),
    );

    expect(setQueueAutoDrain).toHaveBeenCalledWith(false);
    expect(state.seenAtAbort).toEqual([false]);
  });

  it("ISSUE-010: a stop with a stale execution id does not write the queue hold", async () => {
    const setQueueAutoDrain = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      runtime: {
        stopActiveForegroundExecution: vi.fn().mockReturnValue({
          kind: "mismatch",
          activeForegroundExecutionId: "foreground-2",
        }),
        getActiveForegroundExecutionId: () => "foreground-2",
      },
      setQueueAutoDrain,
    });
    const record = makeRecord({ app, activeAbortController: new AbortController() });

    await expect(
      new V4CommandExecutor(makeHost(record, { getQueueLength: () => 1 })).execute(
        envelope("stop", { expectedForegroundExecutionId: "foreground-1" }),
      ),
    ).rejects.toMatchObject({ reasonCode: "guard.stopTargetChanged" });
    expect(setQueueAutoDrain).not.toHaveBeenCalled();
  });

  // The turn ends on its own while the hold write is in flight: nothing is cancelled, so the hold must not
  // outlive the stop, otherwise the queue stays paused after a natural completion.
  function turnEndsDuringHold() {
    const execution: { id: string | undefined } = { id: "foreground-1" };
    const setQueueAutoDrain = vi.fn().mockImplementation(async (autoDrain: boolean) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!autoDrain) execution.id = undefined;
    });
    const stopActiveForegroundExecution = vi.fn(
      ({ expectedForegroundExecutionId }: { expectedForegroundExecutionId?: string }) =>
        execution.id === undefined
          ? { kind: "idle" }
          : execution.id === expectedForegroundExecutionId
            ? { kind: "stopped", foregroundExecutionId: execution.id }
            : { kind: "mismatch", activeForegroundExecutionId: execution.id },
    );
    const app = makeApp({
      runtime: {
        stopActiveForegroundExecution,
        getActiveForegroundExecutionId: () => execution.id,
      },
      setQueueAutoDrain,
    });
    return { app, setQueueAutoDrain, stopActiveForegroundExecution };
  }

  it("ISSUE-010: a stop whose turn ended during the hold write releases the hold and noops", async () => {
    const { app, setQueueAutoDrain } = turnEndsDuringHold();
    const controller = new AbortController();
    const record = makeRecord({ app, activeAbortController: controller });
    const host = makeHost(record, { getQueueLength: () => 1, getQueueAutoDrain: () => true });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("stop", { expectedForegroundExecutionId: "foreground-1" }),
      ),
    ).rejects.toMatchObject({ reasonCode: "guard.stopTargetChanged" });
    expect(setQueueAutoDrain.mock.calls).toEqual([[false], [true]]);
    expect(host.legacyMutations).toEqual(["queue_auto_drain_resumed"]);
    expect(controller.signal.aborted).toBe(false);
  });

  it("ISSUE-010: a stop without an execution id is pinned to the execution seen before the hold", async () => {
    const { app, setQueueAutoDrain, stopActiveForegroundExecution } = turnEndsDuringHold();
    const controller = new AbortController();
    const record = makeRecord({ app, activeAbortController: controller });
    const host = makeHost(record, { getQueueLength: () => 1, getQueueAutoDrain: () => true });

    await expect(new V4CommandExecutor(host).execute(envelope("stop", {}))).rejects.toMatchObject({
      reasonCode: "guard.stopTargetChanged",
    });
    expect(stopActiveForegroundExecution).toHaveBeenCalledWith({
      expectedForegroundExecutionId: "foreground-1",
      reason: "v4 session stopped",
    });
    expect(setQueueAutoDrain.mock.calls).toEqual([[false], [true]]);
    expect(controller.signal.aborted).toBe(false);
  });

  it("ISSUE-010: a queue the user already paused is neither held again nor resumed by stop", async () => {
    const { app, setQueueAutoDrain } = turnEndsDuringHold();
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const host = makeHost(record, { getQueueLength: () => 1, getQueueAutoDrain: () => false });

    await new V4CommandExecutor(host).execute(
      envelope("stop", { expectedForegroundExecutionId: "foreground-1" }),
    );

    expect(setQueueAutoDrain).not.toHaveBeenCalled();
    expect(host.legacyMutations).not.toContain("queue_auto_drain_resumed");
  });

  it("ISSUE-010: a compat stop whose controller was replaced during the hold write does not abort the new turn", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const record = makeRecord({ activeAbortController: first });
    const setQueueAutoDrain = vi.fn().mockImplementation(async (autoDrain: boolean) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!autoDrain) record.activeAbortController = second;
    });
    record.app = makeApp({ setQueueAutoDrain }) as never;
    const host = makeHost(record, { getQueueLength: () => 1, getQueueAutoDrain: () => true });

    await expect(new V4CommandExecutor(host).execute(envelope("stop", {}))).rejects.toMatchObject({
      reasonCode: "guard.stopTargetChanged",
    });
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(setQueueAutoDrain.mock.calls).toEqual([[false], [true]]);
  });

  it("ISSUE-010: a compat stop whose turn registers its runtime token during the hold write still stops that turn", async () => {
    const execution: { id: string | undefined } = { id: undefined };
    const stopActiveForegroundExecution = vi.fn(() => ({
      kind: "stopped",
      foregroundExecutionId: "foreground-same",
    }));
    const setQueueAutoDrain = vi.fn().mockImplementation(async (autoDrain: boolean) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!autoDrain) execution.id = "foreground-same";
    });
    const app = makeApp({
      runtime: {
        stopActiveForegroundExecution,
        getActiveForegroundExecutionId: () => execution.id,
      },
      setQueueAutoDrain,
    });
    const controller = new AbortController();
    const record = makeRecord({ app, activeAbortController: controller });
    const host = makeHost(record, { getQueueLength: () => 1, getQueueAutoDrain: () => true });

    await new V4CommandExecutor(host).execute(envelope("stop", {}));

    expect(stopActiveForegroundExecution).toHaveBeenCalledWith({
      expectedForegroundExecutionId: undefined,
      reason: "v4 session stopped",
    });
    expect(controller.signal.aborted).toBe(true);
    expect(setQueueAutoDrain.mock.calls).toEqual([[false]]);
  });

  it("ISSUE-010: a compat stop whose turn ended during the hold write releases the hold and still pauses the goal", async () => {
    const record = makeRecord({ activeAbortController: new AbortController() });
    const setQueueAutoDrain = vi.fn().mockImplementation(async (autoDrain: boolean) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!autoDrain) record.activeAbortController = undefined;
    });
    const updateTargetStatus = vi.fn().mockResolvedValue({ status: "paused" });
    record.app = makeApp({
      setQueueAutoDrain,
      readTarget: vi.fn().mockResolvedValue({ status: "active" }),
      updateTargetStatus,
    }) as never;
    const host = makeHost(record, { getQueueLength: () => 1, getQueueAutoDrain: () => true });

    await new V4CommandExecutor(host).execute(envelope("stop", {}));

    expect(setQueueAutoDrain.mock.calls).toEqual([[false], [true]]);
    expect(updateTargetStatus).toHaveBeenCalledWith("paused");
    expect(host.legacyMutations).toEqual(["queue_auto_drain_resumed", "session_stop_goal_paused"]);
  });

  it("ISSUE-010: a failed hold write is never released", async () => {
    const { app, stopActiveForegroundExecution } = turnEndsDuringHold();
    const setQueueAutoDrain = vi.fn().mockRejectedValue(new Error("write failed"));
    (app as { setQueueAutoDrain: unknown }).setQueueAutoDrain = setQueueAutoDrain;
    stopActiveForegroundExecution.mockReturnValue({ kind: "idle" });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    const host = makeHost(record, { getQueueLength: () => 1, getQueueAutoDrain: () => true });

    await expect(
      new V4CommandExecutor(host).execute(
        envelope("stop", { expectedForegroundExecutionId: "foreground-1" }),
      ),
    ).rejects.toMatchObject({ reasonCode: "guard.stopTargetChanged" });
    expect(setQueueAutoDrain.mock.calls).toEqual([[false]]);
    expect(host.legacyMutations).toEqual([]);
  });

  it("a stop without an id and without a hold keeps the unpinned runtime stop and the compat fallthrough", async () => {
    const stopActiveForegroundExecution = vi.fn().mockReturnValue({ kind: "idle" });
    const app = makeApp({
      runtime: {
        stopActiveForegroundExecution,
        getActiveForegroundExecutionId: () => "foreground-unwinding",
      },
    });
    const controller = new AbortController();
    const record = makeRecord({ app, activeAbortController: controller });

    await new V4CommandExecutor(makeHost(record, { getQueueLength: () => 0 })).execute(
      envelope("stop", {}),
    );

    expect(stopActiveForegroundExecution).toHaveBeenCalledWith({
      expectedForegroundExecutionId: undefined,
      reason: "v4 session stopped",
    });
    expect(controller.signal.aborted).toBe(true);
  });
});

describe("supports 分流", () => {
  it("协议命令全部原生（回落面清零）；未知命令不 supports", () => {
    const executor = new V4CommandExecutor(makeHost(makeRecord()));
    // Keep in sync with the payload map in packages/shared/src/zcode-protocol-v4/command.ts.
    const allCommands = [
      "createSession",
      "sendText",
      "sendGoalCommand",
      "stop",
      "compact",
      "forkAssistant",
      "applyFileRewind",
      "editUserQuery",
      "retryTurn",
      "setAssistantFeedback",
      "setHighspeedMetrics",
      "sendQueuedNow",
      "editQueueItem",
      "reorderQueueItem",
      "deleteQueueItem",
      "setAutoDrain",
      "resolveInteraction",
      "snoozeInteractionAutoResolution",
      "switchModelConfig",
      "setFollowupMode",
      "resumeGoal",
      "cancelBackgroundWork",
      "renameSession",
      "deleteSession",
    ] as const;
    for (const command of allCommands) {
      expect(executor.supports(command), command).toBe(true);
    }
    expect(executor.supports("unknownCommand" as never)).toBe(false);
  });
});
