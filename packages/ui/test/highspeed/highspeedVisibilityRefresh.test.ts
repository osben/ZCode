import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ConversationComposer } from "@/v4/ConversationComposer.js";
import { TEST_LOCALE } from "../helpers/uiCopy.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type ComposerProps = ComponentProps<typeof ConversationComposer>;

const T0 = 1_788_200_000_000;

const captured = vi.hoisted(() => ({
  composerProps: null as ComposerProps | null,
}));

const mocks = vi.hoisted(() => ({
  // SessionPane reads bot bindings and subscribes to broadcast; keep a plain
  // task so missing dependencies do not block the expiry assertions.
  botsService: {
    getBotStates: vi.fn(async () => []),
  },
  broadcastService: {
    onMessage: vi.fn(() => ({ dispose: vi.fn() })),
  },
  highspeedCardService: {
    getSnapshot: vi.fn(async () => ({ card: null, nextDrawAt: null, drawing: false })),
    prepareTurn: vi.fn(async () => ({
      kind: "fallback" as const,
      reason: "draw-miss" as const,
      nextDrawAt: null,
    })),
    healthy: vi.fn(async (cardId: string) => ({
      cardId,
      promptTokens: 1_000,
      completionTokens: 900,
      durationSeconds: 10,
    })),
    share: vi.fn(),
  },
  layer: {
    acquire: vi.fn((sessionId: string) => ({
      sessionId,
      openKind: "cold" as const,
      startedAt: 0,
      store: {
        getState: vi.fn(() => ({ snapshot: projectionState.current?.snapshot ?? null })),
        markCommandPending: vi.fn(),
        expectAcceptedInputProjection: vi.fn(),
        onOnlineModelTransition: vi.fn(() => () => {}),
        onLiveDeltas: vi.fn(() => () => {}),
        refreshPlans: vi.fn(async () => {}),
        settleCommand: vi.fn(),
      },
      release: vi.fn(),
    })),
  },
  sendCommand: vi.fn(async () => ({
    commandId: "cmd",
    status: "accepted" as const,
    revisionAtDecision: 0,
  })),
  attachmentPut: vi.fn(),
  // This case does not test the dwf run discovery query; return a never-resolving
  // Promise so no .then callback re-triggers setState after teardown. The stable
  // reference keeps effect dependencies from flapping.
  workflowRuns: vi.fn(() => new Promise<never>(() => {})),
  modelProviderService: {
    getProviderRegistrySnapshot: vi.fn(async () => ({
      generatedAt: 10,
      providers: [],
      revision: "sha256:empty",
    })),
    onDidChangeProviderRegistry: vi.fn(() => ({ dispose: vi.fn() })),
  },
  zcodeSessionService: {
    readWorkspaceState: vi.fn(),
  },
  zcodeTaskService: {
    restartWorkspaceProcess: vi.fn(async () => {}),
  },
  toast: vi.fn(),
}));

const projectionState = vi.hoisted(() => ({
  current: null as {
    status: "live";
    snapshot: ConversationSnapshot | null;
    subscriptionId: string;
    lastError: null;
    optimisticCommands: readonly [];
    loadingOlder: boolean;
  } | null,
}));

vi.mock("@/v4/OffPeakNewTaskEntry.js", () => ({
  OffPeakNewTaskEntry: () => null,
}));

vi.mock("@/v4/ConversationDraftSuggestedPromptsContainer.js", () => ({
  ConversationDraftSuggestedPromptsContainer: () => null,
}));

vi.mock("@/hooks/useServices.js", () => ({
  useComposerClientNamespace: () => "desktop",
  useServices: () => ({
    botsService: mocks.botsService,
    broadcastService: mocks.broadcastService,
    highspeedCardService: mocks.highspeedCardService,
    modelProviderService: mocks.modelProviderService,
    zcodeSessionService: mocks.zcodeSessionService,
    zcodeTaskService: mocks.zcodeTaskService,
  }),
  // useStartPlanRecommendation in the SessionPane render chain degrades without
  // the optional service; this case only verifies expiry sampling, so a null
  // service context is fine (consistent with other SessionPane cases).
  useOptionalServices: () => null,
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    layer: mocks.layer,
    sendCommand: mocks.sendCommand,
    attachmentPut: mocks.attachmentPut,
    workflowRuns: mocks.workflowRuns,
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: { zcodeInteractionBehavior: "queue" },
    loading: false,
    error: null,
    update: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/v4/composer/useDraftConfigControl.js")>();
  return {
    ...actual,
    // This case only verifies expiry sampling and needs no real draft; but the
    // SessionPane render path reads modelSelectionRead.state.status directly, and
    // a stub missing that field would read undefined and crash.
    useDraftConfigControl: () => ({
      modelSelectionRead: { state: { status: "loading" as const }, reload: vi.fn() },
      draftConfigRef: { current: {} },
      resolveInitialDraftConfig: () => undefined,
      captureAcceptedModelSelection: () => vi.fn(),
      handleDraftSelectModel: () => {},
      handleDraftSelectThought: () => {},
      handleDraftSwitchMode: () => {},
      promoteComposerDraft: () => {},
      replaceComposerDraft: () => {},
      updateComposerContent: () => {},
    }),
  };
});

vi.mock("@/components/ui/toast.js", () => ({
  toast: mocks.toast,
}));

vi.mock("@/v4/ConversationComposer.js", async () => {
  const React = await import("react");
  return {
    ConversationComposer: (props: ComposerProps) => {
      captured.composerProps = props;
      return React.createElement("div", { "data-testid": "mock-composer" });
    },
  };
});

vi.mock("@/v4/ConversationHeader.js", async () => {
  const React = await import("react");
  return { ConversationHeader: () => React.createElement("div") };
});

vi.mock("@/v4/ConversationStatusPanel.js", async () => {
  const React = await import("react");
  return { ConversationStatusPanel: () => React.createElement("div") };
});

vi.mock("@/v4/ConversationQueuePanel.js", async () => {
  const React = await import("react");
  return { ConversationQueuePanel: () => React.createElement("div") };
});

vi.mock("@/request-security-edition/V4ProviderRuntimeHeadersController.js", async () => {
  const React = await import("react");
  return { V4ProviderRuntimeHeadersController: () => React.createElement("div") };
});

vi.mock("@/v4/ConversationDraftEmptyState.js", async () => {
  const React = await import("react");
  return { ConversationDraftEmptyState: () => React.createElement("div") };
});

vi.mock("@/v4/ConversationTimeline.js", async () => {
  const React = await import("react");
  return {
    ConversationTimeline: ({ bottomDock }: { bottomDock?: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "mock-timeline" }, bottomDock),
  };
});

// Minimal DOM: record document/window event listeners and let cases dispatch
// them directly, simulating "page frozen past the expiry timer → back to window".
const domListeners = {
  document: new Map<string, Set<() => void>>(),
  window: new Map<string, Set<() => void>>(),
  visibilityState: "visible" as "visible" | "hidden",
};

function recordListener(
  target: Map<string, Set<() => void>>,
  type: string,
  listener: () => void,
): void {
  const bucket = target.get(type) ?? new Set<() => void>();
  bucket.add(listener);
  target.set(type, bucket);
}

function dropListener(
  target: Map<string, Set<() => void>>,
  type: string,
  listener: () => void,
): void {
  target.get(type)?.delete(listener);
}

function dispatchRecorded(target: Map<string, Set<() => void>>, type: string): void {
  for (const listener of target.get(type) ?? []) listener();
}

function installMinimalDom(): HTMLElement {
  const documentMock = {
    addEventListener: (type: string, listener: () => void) =>
      recordListener(domListeners.document, type, listener),
    removeEventListener: (type: string, listener: () => void) =>
      dropListener(domListeners.document, type, listener),
    createElement: () => ({
      addEventListener: () => {},
      appendChild: (child: unknown) => child,
      childNodes: [] as unknown[],
      nodeType: 1,
      nodeName: "DIV",
      ownerDocument: documentMock,
      parentNode: null as unknown,
      removeChild: () => {},
      setAttribute: () => {},
      style: {},
      tagName: "DIV",
    }),
    nodeType: 9,
    get visibilityState() {
      return domListeners.visibilityState;
    },
  } as unknown as Document;
  const windowMock = {
    addEventListener: (type: string, listener: () => void) =>
      recordListener(domListeners.window, type, listener),
    removeEventListener: (type: string, listener: () => void) =>
      dropListener(domListeners.window, type, listener),
    clearTimeout,
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    setTimeout,
  } as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    document: documentMock,
    window: windowMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    Node: windowMock.Node,
  });
  return documentMock.createElement("div") as unknown as HTMLElement;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function makeSnapshot(
  cardId: string,
  sourceCommandId: string,
  expiresAt: number,
): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-vis",
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
      sendQueuedNow: { allowed: false, reasonCode: "sendQueuedNowRequiresRunning" },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Session", titleSource: "generated" },
    config: {
      provider: "zai",
      model: "glm-5",
      thought: "high",
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
    rows: {
      window: [
        {
          rowId: 1,
          turnId: "turn-1",
          entityId: "user-entity-1",
          createdAt: T0 - 120_000,
          createdAtSeq: 1,
          kind: "userInput",
          text: "Accelerate this turn",
          origin: "realUser",
          sourceCommandId,
          highspeed: {
            schemaVersion: 1,
            cardId,
            taskId: "task-1",
            provider: "zai",
            model: "glm-5",
            issuedAt: T0 - 180_000,
            expiresAt,
            regularTps: 30,
            outputTokens: 900,
            durationMs: 19_000,
            modelDurationMs: 9_000,
            toolDurationMs: 8_000,
          },
        },
        {
          rowId: 2,
          turnId: "turn-1",
          entityId: "turn-entity-1",
          createdAt: T0 - 119_000,
          createdAtSeq: 2,
          kind: "turnHeader",
          origin: "userInput",
          sourceCommandId,
          state: "completedSuccess",
          startedAt: T0 - 119_000,
          endedAt: T0 - 100_000,
          activeMs: 19_000,
          outputTokens: 900,
          modelDurationMs: 9_000,
          toolDurationMs: 8_000,
        },
      ],
      totalCount: 2,
      firstRowId: 1,
    },
  } as unknown as ConversationSnapshot;
}

async function renderExpiredCardPane(cardId: string, sourceCommandId: string): Promise<Root> {
  projectionState.current = {
    status: "live",
    snapshot: makeSnapshot(cardId, sourceCommandId, T0 + 60_000),
    subscriptionId: "sub-1",
    lastError: null,
    optimisticCommands: [],
    loadingOlder: false,
  };
  const root = createRoot(installMinimalDom());
  await act(async () => {
    root.render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: TEST_LOCALE },
        createElement(SessionPane, {
          paneId: "workspace-main",
          sessionId: "session-vis",
          workspacePath: "/workspace",
        }),
      ),
    );
    await flushMicrotasks();
  });
  return root;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  captured.composerProps = null;
  projectionState.current = null;
  domListeners.document.clear();
  domListeners.window.clear();
  domListeners.visibilityState = "visible";
});

describe("highspeed expiry clock visibility refresh", () => {
  it("re-runs card sampling immediately when visibilitychange restores visibility after the page froze past the expiry timer", async () => {
    vi.useFakeTimers({ now: T0 });
    const root = await renderExpiredCardPane("hsc-vis-1", "cmd-vis-1");
    try {
      // The card has not expired at mount; healthy must not fire.
      expect(mocks.highspeedCardService.healthy).not.toHaveBeenCalled();

      // Simulate a frozen page: the wall clock passes the expiry point while the
      // pending expiry-wakeup setTimeout never runs.
      vi.setSystemTime(T0 + 61_000);
      expect(mocks.highspeedCardService.healthy).not.toHaveBeenCalled();

      // Back at the window: visibilitychange(visible) must re-run the aggregation
      // path (the card is already expired by the current wall clock).
      domListeners.visibilityState = "visible";
      await act(async () => {
        dispatchRecorded(domListeners.document, "visibilitychange");
        await flushMicrotasks();
      });

      expect(mocks.highspeedCardService.healthy).toHaveBeenCalledWith("hsc-vis-1");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("window focus also triggers the expiry path re-run", async () => {
    vi.useFakeTimers({ now: T0 });
    const root = await renderExpiredCardPane("hsc-vis-2", "cmd-vis-2");
    try {
      vi.setSystemTime(T0 + 61_000);
      domListeners.visibilityState = "visible";
      await act(async () => {
        dispatchRecorded(domListeners.window, "focus");
        await flushMicrotasks();
      });

      expect(mocks.highspeedCardService.healthy).toHaveBeenCalledWith("hsc-vis-2");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("a visibilitychange to hidden does not trigger the re-run", async () => {
    vi.useFakeTimers({ now: T0 });
    const root = await renderExpiredCardPane("hsc-vis-3", "cmd-vis-3");
    try {
      vi.setSystemTime(T0 + 61_000);
      domListeners.visibilityState = "hidden";
      await act(async () => {
        dispatchRecorded(domListeners.document, "visibilitychange");
        await flushMicrotasks();
      });

      expect(mocks.highspeedCardService.healthy).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
