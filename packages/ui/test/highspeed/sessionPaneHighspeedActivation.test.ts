import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentRef,
  CommandAck,
  CommandEnvelope,
  ConversationRowTarget,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import type { HighspeedCardSnapshot } from "@zcode/shared";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// spec §9.2: the activation animation belongs only to a fresh draw hit on the local send path; switching back, restoring, and reusing the same card are all presented as restore.

const { composerProps, layerMock, sendCommandMock, timelineProps } = vi.hoisted(() => ({
  composerProps: [] as Array<{
    highspeedCard?: HighspeedCardSnapshot | null;
    highspeedActivationCardId?: string | null;
    onHighspeedActivationApplied?: (cardId: string) => void;
    onSendText?: (text: string, options?: Record<string, unknown>) => Promise<unknown>;
  }>,
  layerMock: {
    acquire: vi.fn(() => ({
      store: {
        markCommandPending: vi.fn(),
        expectAcceptedInputProjection: vi.fn(),
        recoverFromStaleAuthority: vi.fn(),
        onOnlineModelTransition: vi.fn(() => () => {}),
        refreshPlans: vi.fn(async () => {}),
        settleCommand: vi.fn(),
      },
      release: vi.fn(),
    })),
  },
  sendCommandMock: vi.fn(
    async (envelope: CommandEnvelope): Promise<CommandAck> => ({
      commandId: envelope.commandId,
      revisionAtDecision: envelope.baseRevision ?? 0,
      status: "accepted",
    }),
  ),
  timelineProps: [] as Array<{
    bottomDock?: ReactNode;
    onEdit?: (
      target: ConversationRowTarget,
      newText: string,
      attachments?: readonly AttachmentRef[],
    ) => Promise<boolean | void> | boolean | void;
  }>,
}));

// Never resolves: this case does not test the run discovery query; resolving would trigger setState after the environment is torn down (unhandled exception).
const workflowRunsQueryMock = vi.hoisted(() =>
  vi.fn(() => new Promise<{ runs: unknown[] }>(() => {})),
);
const projectionState = vi.hoisted(() => ({
  current: null as {
    status: "live";
    snapshot: ConversationSnapshot;
    subscriptionId: string;
    lastError: string | null;
    optimisticCommands: readonly [];
    loadingOlder: boolean;
  } | null,
}));

const servicesMock = vi.hoisted(() => ({
  // Normal tasks also read bot bindings and subscribe to broadcasts; stub these dependencies to keep the activation test's original scope.
  botsService: {
    getBotStates: vi.fn(async () => []),
  },
  broadcastService: {
    onMessage: vi.fn(() => ({ dispose: vi.fn() })),
  },
  highspeedCardService: {
    getSnapshot: vi.fn(
      async (): Promise<{
        card: HighspeedCardSnapshot | null;
        nextDrawAt: number | null;
        drawing: boolean;
      }> => ({ card: null, nextDrawAt: null, drawing: false }),
    ),
    prepareTurn: vi.fn(),
    healthy: vi.fn(async () => ({
      cardId: "card",
      promptTokens: 0,
      completionTokens: 0,
      durationSeconds: 0,
    })),
    share: vi.fn(),
  },
  // The readiness hook uses the service as an effect dependency; rebuilding it on every render would cause infinite re-rendering.
  zcodeSessionService: {
    updateProviderRegistry: vi.fn(),
  },
  zcodeTaskService: {
    restartWorkspaceProcess: vi.fn(),
  },
}));

// The Start plan recommendation is a real await in sendText before prepare; the test uses it to
// hold sending before prepare, simulating the user switching tasks during the config barrier /
// recommendation / session creation. The stub must be a stable reference (the send callback
// depends on it).
const startPlanRecommendation = vi.hoisted(() => {
  const state = { hold: null as Promise<void> | null };
  return {
    state,
    recommend: vi.fn(async <T>(selection: T): Promise<T> => {
      await state.hold;
      return selection;
    }),
  };
});

vi.mock("@/hooks/useStartPlanRecommendation.js", () => ({
  useStartPlanRecommendation: () => startPlanRecommendation.recommend,
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    error: null,
    loading: false,
    refresh: vi.fn(async () => {}),
    settings: { zcodeInteractionBehavior: "queue" },
    update: vi.fn(async () => {}),
  }),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => null,
  useServices: () => servicesMock,
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    attachmentPut: vi.fn(),
    fileChanges: vi.fn(),
    fileRewindPreview: vi.fn(),
    layer: layerMock,
    sendCommand: sendCommandMock,
    // The stub must be a stable reference: the effect depends on workflowRuns, and a new function on every render would loop forever.
    workflowRuns: workflowRunsQueryMock,
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", () => ({
  buildDraftCreateConfigPayload: () => ({}),
  useDraftConfigControl: () => ({
    modelSelectionRead: { state: { status: "loading" }, reload: vi.fn() },
    captureAcceptedModelSelection: () => vi.fn(),
    draftConfigRef: { current: {} },
    draftConfigSeedSignal: 0,
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
    resolveInitialDraftConfig: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/useDraftSessionPrewarm.js", () => ({
  useDraftSessionPrewarm: () => ({
    binding: null,
  }),
}));

vi.mock("@/v4/ConversationComposer.js", async () => {
  const React = await import("react");
  return {
    ConversationComposer: (props: Record<string, unknown>) => {
      composerProps.push(props as (typeof composerProps)[number]);
      return React.createElement("div", { "data-testid": "mock-composer" });
    },
  };
});

vi.mock("@/v4/ConversationHeader.js", async () => {
  const React = await import("react");
  return { ConversationHeader: () => React.createElement("div", { "data-testid": "mock-header" }) };
});

vi.mock("@/v4/ConversationTimeline.js", async () => {
  const React = await import("react");
  return {
    ConversationTimeline: (props: Record<string, unknown>) => {
      timelineProps.push(props as (typeof timelineProps)[number]);
      return React.createElement(
        Fragment,
        null,
        React.createElement("div", { "data-testid": "mock-timeline" }),
        props.bottomDock as ReactNode,
      );
    },
  };
});

vi.mock("@/v4/ConversationStatusPanel.js", async () => {
  const React = await import("react");
  return {
    ConversationStatusPanel: () => React.createElement("div", { "data-testid": "mock-status" }),
  };
});

vi.mock("@/v4/ConversationQueuePanel.js", async () => {
  const React = await import("react");
  return {
    ConversationQueuePanel: () => React.createElement("div", { "data-testid": "mock-queue" }),
  };
});

vi.mock("@/v4/V4InteractionDialogs.js", async () => {
  const React = await import("react");
  return {
    V4InteractionDialogs: () => React.createElement("div", { "data-testid": "mock-interactions" }),
  };
});

vi.mock("@/request-security-edition/V4ProviderRuntimeHeadersController.js", async () => {
  const React = await import("react");
  return {
    V4ProviderRuntimeHeadersController: () =>
      React.createElement("div", { "data-testid": "mock-runtime-headers" }),
  };
});

vi.mock("@/v4/ConversationDraftEmptyState.js", async () => {
  const React = await import("react");
  return {
    ConversationDraftEmptyState: () =>
      React.createElement("div", { "data-testid": "mock-draft-empty" }),
  };
});

// Capture document/window event listeners so wake-compensation cases can fire them manually (simulating returning to the window after screen off).
const domEventListeners: Array<{
  target: "document" | "window";
  type: string;
  handler: () => void;
}> = [];

function triggerDomEvent(target: "document" | "window", type: string): void {
  for (const listener of [...domEventListeners]) {
    if (listener.target === target && listener.type === type) listener.handler();
  }
}

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  domEventListeners.length = 0;
  const documentMock = {
    addEventListener: (type: string, handler: () => void) => {
      domEventListeners.push({ target: "document", type, handler });
    },
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
    visibilityState: "visible",
  } as unknown as Document;
  const windowMock = {
    addEventListener: (type: string, handler: () => void) => {
      domEventListeners.push({ target: "window", type, handler });
    },
    clearTimeout,
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    setTimeout,
  } as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    document: documentMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: windowMock.Node,
    window: windowMock,
  });
  return createMinimalElement(documentMock, "div");
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function makeSnapshot(sessionId: string): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId,
    logEpoch: "epoch-1",
    seq: 1,
    revision: 7,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: {
        allowed: false,
        reasonCode: "sendQueuedNowRequiresRunning",
      },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Session", titleSource: "generated" },
    config: {
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
      thought: "",
      followupMode: "queue",
      mode: "build",
    },
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

function makeCard(cardId: string, taskId = "session-a"): HighspeedCardSnapshot {
  return {
    cardId,
    taskId,
    provider: "builtin:bigmodel-coding-plan",
    model: "GLM-5.3",
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
  };
}

function mockDrawHit(card: HighspeedCardSnapshot): void {
  servicesMock.highspeedCardService.prepareTurn.mockResolvedValueOnce({
    kind: "accelerated",
    card,
    nextDrawAt: card.expiresAt,
  });
}

function latestComposer() {
  const props = composerProps.at(-1);
  if (!props) throw new Error("composer 尚未渲染");
  return props;
}

async function renderPane(root: Root, sessionId: string): Promise<void> {
  projectionState.current = {
    status: "live",
    snapshot: makeSnapshot(sessionId),
    subscriptionId: `sub-${sessionId}`,
    lastError: null,
    optimisticCommands: [],
    loadingOlder: false,
  };
  await act(async () => {
    root.render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(SessionPane, {
          paneId: "workspace-main",
          sessionId,
          workspacePath: "/workspace",
        }),
      ),
    );
    await flushMicrotasks();
  });
}

/** Goes through the inline-edit resend path: it shares sendText's pre-send draw via prepareHighspeedTurnForSend. */
async function sendThroughEdit(): Promise<void> {
  await act(async () => {
    await timelineProps
      .at(-1)
      ?.onEdit?.({ rowId: 42, entityId: "message-user-42" }, "再加速一轮", []);
    await flushMicrotasks();
  });
}

/**
 * Goes through the Composer sendText path and holds sending at the Start plan recommendation
 * await before prepare; Highspeed prepare only starts after the returned release is invoked.
 */
async function sendTextHeldBeforePrepare(): Promise<{
  release: () => void;
  sending: Promise<unknown>;
}> {
  let release: () => void = () => {};
  startPlanRecommendation.state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sending: Promise<unknown> = Promise.resolve();
  await act(async () => {
    sending =
      latestComposer().onSendText?.("加速一轮", {
        submission: {
          mode: "build",
          planEnabled: false,
          modelSelection: { providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5.3" },
        },
      }) ?? Promise.reject(new Error("composer 未提供 onSendText"));
    await flushMicrotasks();
  });
  expect(startPlanRecommendation.recommend).toHaveBeenCalledTimes(1);
  expect(servicesMock.highspeedCardService.prepareTurn).not.toHaveBeenCalled();
  return { release, sending };
}

/**
 * Intercepts the expiry-clearing timer (the one whose mount time + delay is exactly expiresAt)
 * so the case can fire it manually; other timers run as usual. Requires a fixed Date.now so the
 * timer can be identified precisely by its scheduling moment.
 */
function captureExpiryTimers(expiresAt: number) {
  const realSetTimeout = window.setTimeout;
  const realClearTimeout = window.clearTimeout;
  const pending = new Map<number, () => void>();
  let nextId = 0;
  window.setTimeout = ((handler: () => void, delay = 0) => {
    if (Date.now() + delay !== expiresAt) return realSetTimeout(handler, delay);
    nextId -= 1;
    pending.set(nextId, handler);
    return nextId;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => {
    if (id !== undefined && pending.delete(id)) return;
    realClearTimeout(id);
  }) as typeof window.clearTimeout;
  return {
    get pendingCount() {
      return pending.size;
    },
    fireNext: () => {
      const next = pending.entries().next().value;
      if (!next) return;
      pending.delete(next[0]);
      next[1]();
    },
  };
}

afterEach(() => {
  sendCommandMock.mockClear();
  composerProps.length = 0;
  timelineProps.length = 0;
  servicesMock.highspeedCardService.getSnapshot.mockReset();
  servicesMock.highspeedCardService.getSnapshot.mockResolvedValue({
    card: null,
    nextDrawAt: null,
    drawing: false,
  });
  servicesMock.highspeedCardService.prepareTurn.mockReset();
  startPlanRecommendation.state.hold = null;
  startPlanRecommendation.recommend.mockClear();
  projectionState.current = null;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("SessionPane Highspeed 激活动效请求", () => {
  it("draw 新命中只登记一次激活；切走再切回与同卡再次发送都不重播", async () => {
    const card = makeCard("card-1");
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      expect(latestComposer().highspeedCard).toBeNull();
      expect(latestComposer().highspeedActivationCardId).toBeNull();

      mockDrawHit(card);
      await sendThroughEdit();
      expect(latestComposer().highspeedCard?.cardId).toBe("card-1");
      expect(latestComposer().highspeedActivationCardId).toBe("card-1");

      // The callback consumes the request after the composer locks in the entry mode: the request clears, but the card stays valid.
      await act(async () => {
        latestComposer().onHighspeedActivationApplied?.("card-1");
      });
      expect(latestComposer().highspeedActivationCardId).toBeNull();
      expect(latestComposer().highspeedCard?.cardId).toBe("card-1");

      // The service still holds the card; when switching to another task the card does not belong to it, so the input box returns to normal.
      servicesMock.highspeedCardService.getSnapshot.mockResolvedValue({
        card,
        nextDrawAt: card.expiresAt,
        drawing: false,
      });
      await renderPane(root, "session-b");
      expect(latestComposer().highspeedCard).toBeNull();

      // Switch back: the restore path shares the same card snapshot with the draw hit, but must not register the activation again.
      await renderPane(root, "session-a");
      expect(latestComposer().highspeedCard?.cardId).toBe("card-1");
      expect(latestComposer().highspeedActivationCardId).toBeNull();

      // The same card keeps accelerating the next round: prepare still returns accelerated, but it is not a fresh hit.
      mockDrawHit(card);
      await sendThroughEdit();
      expect(servicesMock.highspeedCardService.prepareTurn).toHaveBeenCalledTimes(2);
      expect(latestComposer().highspeedCard?.cardId).toBe("card-1");
      expect(latestComposer().highspeedActivationCardId).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("Renderer 重载后经 getSnapshot 恢复的卡，再次发送也不补播激活", async () => {
    const card = makeCard("card-restored");
    servicesMock.highspeedCardService.getSnapshot.mockResolvedValue({
      card,
      nextDrawAt: card.expiresAt,
      drawing: false,
    });
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      expect(latestComposer().highspeedCard?.cardId).toBe("card-restored");
      expect(latestComposer().highspeedActivationCardId).toBeNull();

      mockDrawHit(card);
      await sendThroughEdit();
      expect(latestComposer().highspeedCard?.cardId).toBe("card-restored");
      expect(latestComposer().highspeedActivationCardId).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("换到新卡时重新登记激活；迟到的旧卡消费回调不清掉新请求", async () => {
    const restoredCard = makeCard("card-old");
    servicesMock.highspeedCardService.getSnapshot.mockResolvedValue({
      card: restoredCard,
      nextDrawAt: restoredCard.expiresAt,
      drawing: false,
    });
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      expect(latestComposer().highspeedCard?.cardId).toBe("card-old");

      mockDrawHit(makeCard("card-new"));
      await sendThroughEdit();
      expect(latestComposer().highspeedCard?.cardId).toBe("card-new");
      expect(latestComposer().highspeedActivationCardId).toBe("card-new");

      await act(async () => {
        latestComposer().onHighspeedActivationApplied?.("card-old");
      });
      expect(latestComposer().highspeedActivationCardId).toBe("card-new");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("息屏期间到期的卡在窗口唤醒时立即清退，不残留 00:00:00 僵尸加速态", async () => {
    // Regression (spec §9.2/§9.3 expiry clock compensation): the card-clearing setTimeout stalls
    // while the page is frozen; if the expiry is not re-evaluated against the real clock after
    // waking, the input box stays in the accelerated state while the countdown already shows 00:00:00.
    const card = makeCard("card-wake");
    const root = createRoot(installMinimalDom());
    const nowSpy = vi.spyOn(Date, "now");
    try {
      await renderPane(root, "session-a");
      mockDrawHit(card);
      await sendThroughEdit();
      expect(latestComposer().highspeedCard?.cardId).toBe("card-wake");

      // Simulate screen off: the card-clearing timer stalls, and the card has expired by wall clock.
      nowSpy.mockReturnValue(card.expiresAt + 1_000);
      // Returning to the window (focus + becoming visible) triggers compensation, clearing the card immediately.
      await act(async () => {
        triggerDomEvent("window", "focus");
        triggerDomEvent("document", "visibilitychange");
        await flushMicrotasks();
      });
      expect(latestComposer().highspeedCard).toBeNull();
    } finally {
      // The wall clock must be restored even when an assertion fails, otherwise the fixed Date.now leaks into later cases.
      nowSpy.mockRestore();
      await act(async () => root.unmount());
    }
  });

  it("清退 timer 早于墙钟到期触发时按剩余时长重挂，到期后清卡", async () => {
    // Regression: setTimeout runs on the monotonic clock while expiry checks read the wall clock
    // Date.now(); millisecond drift or NTP rollback between the two can make the timer fire before
    // wall-clock expiry. If that only evaluated without re-arming, the accelerated state would
    // never exit while the window stays in the foreground.
    const startedAt = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const card = makeCard("card-early-timer");
    const root = createRoot(installMinimalDom());
    const expiryTimers = captureExpiryTimers(card.expiresAt);
    try {
      await renderPane(root, "session-a");
      mockDrawHit(card);
      await sendThroughEdit();
      expect(latestComposer().highspeedCard?.cardId).toBe("card-early-timer");
      expect(expiryTimers.pendingCount).toBe(1);

      // The timer fires 1ms early: wall-clock expiry has not arrived, so the card is kept and the timer is re-armed for the remaining duration.
      nowSpy.mockReturnValue(card.expiresAt - 1);
      await act(async () => {
        expiryTimers.fireNext();
        await flushMicrotasks();
      });
      expect(latestComposer().highspeedCard?.cardId).toBe("card-early-timer");
      expect(expiryTimers.pendingCount).toBe(1);

      // The re-armed timer fires after wall-clock expiry: clear the card and do not re-arm.
      nowSpy.mockReturnValue(card.expiresAt);
      await act(async () => {
        expiryTimers.fireNext();
        await flushMicrotasks();
      });
      expect(latestComposer().highspeedCard).toBeNull();
      expect(expiryTimers.pendingCount).toBe(0);
    } finally {
      nowSpy.mockRestore();
      await act(async () => root.unmount());
    }
  });

  it("抽卡返回前已切到其他 Task 时，旧 Task 的卡不呈现到当前 Task、也不登记激活", async () => {
    // Regression (spec §9.2 "restore the normal state when the card does not belong to the current
    // task"): SessionPane reuses one instance across tasks; the user switches away while prepare is
    // awaiting, and if the card state were written directly on return, A's card would appear in
    // B's input box and play the activation.
    const card = makeCard("card-late", "session-a");
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      let resolvePrepare: (value: unknown) => void = () => {};
      servicesMock.highspeedCardService.prepareTurn.mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePrepare = resolve;
        }),
      );
      let sending: Promise<unknown> = Promise.resolve();
      await act(async () => {
        sending = Promise.resolve(
          timelineProps
            .at(-1)
            ?.onEdit?.({ rowId: 42, entityId: "message-user-42" }, "再加速一轮", []),
        );
        await flushMicrotasks();
      });
      expect(servicesMock.highspeedCardService.prepareTurn).toHaveBeenCalledTimes(1);

      await renderPane(root, "session-b");
      await act(async () => {
        resolvePrepare({ kind: "accelerated", card, nextDrawAt: card.expiresAt });
        await sending;
        await flushMicrotasks();
      });
      expect(latestComposer().highspeedCard).toBeNull();
      expect(latestComposer().highspeedActivationCardId).toBeNull();

      // Switch back to the owning task: presented via snapshot restore, entering as restore, with no activation replay.
      servicesMock.highspeedCardService.getSnapshot.mockResolvedValue({
        card,
        nextDrawAt: card.expiresAt,
        drawing: false,
      });
      await renderPane(root, "session-a");
      expect(latestComposer().highspeedCard?.cardId).toBe("card-late");
      expect(latestComposer().highspeedActivationCardId).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("prepare 开始前已切到其他 Task 时，旧 Task 的卡同样不呈现到当前 Task", async () => {
    // Regression (CR-01): the send target used to be read only at the prepare entry; after switching
    // to B during the pre-awaits (config barrier, plan recommendation, session creation), the target
    // had already been read as B, so A's card would appear in B's input box and play the activation.
    const card = makeCard("card-pre-prepare", "session-a");
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      const { release, sending } = await sendTextHeldBeforePrepare();

      await renderPane(root, "session-b");
      mockDrawHit(card);
      await act(async () => {
        release();
        await sending;
        await flushMicrotasks();
      });
      // The card is still used for A's current send.
      expect(servicesMock.highspeedCardService.prepareTurn).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "session-a" }),
      );
      expect(sendCommandMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "sendText", sessionId: "session-a" }),
      );
      expect(latestComposer().highspeedCard).toBeNull();
      expect(latestComposer().highspeedActivationCardId).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("A → B → A 后结果才返回时，按本端发送路径的首次呈现播放激活", async () => {
    const card = makeCard("card-round-trip", "session-a");
    const root = createRoot(installMinimalDom());
    try {
      await renderPane(root, "session-a");
      const { release, sending } = await sendTextHeldBeforePrepare();

      await renderPane(root, "session-b");
      await renderPane(root, "session-a");
      mockDrawHit(card);
      await act(async () => {
        release();
        await sending;
        await flushMicrotasks();
      });
      expect(latestComposer().highspeedCard?.cardId).toBe("card-round-trip");
      expect(latestComposer().highspeedActivationCardId).toBe("card-round-trip");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("唤醒时未到期的卡保持加速态并重挂剩余时长的清退 timer", async () => {
    const startedAt = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const card = makeCard("card-early-wake");
    const root = createRoot(installMinimalDom());
    const expiryTimers = captureExpiryTimers(card.expiresAt);
    try {
      await renderPane(root, "session-a");
      mockDrawHit(card);
      await sendThroughEdit();
      expect(latestComposer().highspeedCard?.cardId).toBe("card-early-wake");

      // Wake after a brief screen off: the card is still valid, compensation must not clear it by mistake, and it replaces the original timer with the remaining duration.
      nowSpy.mockReturnValue(card.expiresAt - 10_000);
      await act(async () => {
        triggerDomEvent("window", "focus");
        triggerDomEvent("document", "visibilitychange");
        await flushMicrotasks();
      });
      expect(latestComposer().highspeedCard?.cardId).toBe("card-early-wake");
      expect(expiryTimers.pendingCount).toBe(1);

      // The re-armed timer fires at expiry and clears the card.
      nowSpy.mockReturnValue(card.expiresAt);
      await act(async () => {
        expiryTimers.fireNext();
        await flushMicrotasks();
      });
      expect(latestComposer().highspeedCard).toBeNull();
    } finally {
      nowSpy.mockRestore();
      await act(async () => root.unmount());
    }
  });
});
