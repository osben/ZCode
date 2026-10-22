import { act, createElement, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRow, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { pendingCommandRegistry, type PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import {
  composerScopeKey,
  getV4WorktreeRecoveryScope,
  isV4FirstSubmissionActive,
  moveV4ComposerDraft,
  persistV4ComposerDraft,
  readV4WorktreeRecoveryDrafts,
  resolveComposerScope,
  setV4FirstSubmissionActive,
} from "@/v4/composer/composerDraftStore.js";

type ProjectionState = {
  status: "connecting" | "live";
  snapshot: ConversationSnapshot | null;
  subscriptionId: string | null;
  lastError: string | null;
  optimisticCommands: readonly [];
  loadingOlder: boolean;
};

const recoveryCapture = vi.hoisted(() => ({
  entries: [] as PendingCommandEntry[],
  onResend: null as null | (() => void),
}));
vi.mock("@/v4/usePendingCommandRecovery.js", () => ({
  usePendingCommandRecovery: () => recoveryCapture.entries,
}));
vi.mock("@/v4/PendingCommandRecoveryBanner.js", () => ({
  PendingCommandRecoveryBanner: (props: { onResend?: () => void }) => {
    recoveryCapture.onResend = props.onResend ?? null;
    return null;
  },
}));

const sessionCreateCapture = vi.hoisted(() => ({
  report: vi.fn(async () => {}),
}));
vi.mock("@/lib/sessionCreateTelemetry.js", () => ({
  reportSessionCreate: sessionCreateCapture.report,
}));

// First-submission instant UX (specs/first-submission-instant-ux.md): the sidebar
// source is controllable so a test can hold it empty while the pane binds.
const sessionsIndexItems = vi.hoisted(() => ({
  current: [] as Array<{ taskId: string }>,
}));
vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => ({ items: sessionsIndexItems.current, hydrating: [] }),
}));

const agentHandshakeMock = vi.hoisted(() => ({
  hello: { capabilities: { durableFirstSubmission: true } },
}));
vi.mock("@/v4/agentV4ConnectionHandshake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/v4/agentV4ConnectionHandshake.js")>()),
  ensureAgentV4ConnectionHandshake: async () => agentHandshakeMock.hello,
}));

// Project tree staging (commitCreatedTask): null by default, a never-settling stager per test.
const projectDirectoryMock = vi.hoisted(() => ({
  current: null as null | {
    commitCreatedTask: ReturnType<typeof import("vitest").vi.fn>;
    groups: { refresh: () => Promise<void> };
  },
}));
vi.mock("@/project-sidebar/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/project-sidebar/index.js")>()),
  useOptionalProjectDirectory: () => projectDirectoryMock.current,
}));

const projectionState = vi.hoisted(() => ({
  current: null as ProjectionState | null,
}));

const composerLifecycle = vi.hoisted(() => ({
  disabledStates: [] as boolean[],
  mounts: 0,
  nextInstanceId: 1,
  renders: [] as number[],
  unmounts: 0,
}));

const scrollFocus = vi.hoisted(() => ({
  composerProps: null as null | {
    onOpenRunningBackgroundWorks?: () => void;
    onPrepareFirstSubmission?: (params: {
      submissionId: string;
      incognito?: unknown;
      reservation?: { sessionId: string; commandId: string };
      onReservationCreated?: (reservation: { sessionId: string; commandId: string }) => void;
    }) => Promise<string | undefined>;
    onFirstSubmissionReserved?: (sessionId: string) => void;
    firstSubmissionActive?: boolean;
    onSendText: (
      text: string,
      options?: {
        heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
        expectedHeldQueueItemIds?: readonly string[];
        requestedDelivery?: "startNow" | "queue" | "guide";
        sharedContextRefs?: Array<{
          kind: "shared_context_import";
          context_id: string;
        }>;
        submission?: {
          mode: "build";
          modelSelection: {
            providerId: string;
            modelId: string;
            options: { reasoningLevel: string };
          };
        };
      },
    ) => Promise<"sent" | "blocked" | "confirmationRequired">;
  },
  queueProps: null as null | {
    onResume?: () => Promise<void>;
    onSendNow?: (queueItemId: string) => void;
  },
  statusPanelProps: null as null | {
    onTerminalSectionOpenChange?: (open: boolean) => void;
    terminalSectionOpen?: boolean;
    onAgentSectionOpenChange?: (open: boolean) => void;
    agentSectionOpen?: boolean;
    summaryPanelVariantOverride?: "panel" | "mini" | null;
  },
  scrollToBottom: vi.fn(),
}));

// SessionPane builds the optimistic first-input row from the persisted record; the
// timeline mock mirrors its shape to assert per-render reconciliation behavior.
type OptimisticFirstInputRow = {
  rowId: number;
  turnId: string;
  productTurnId: string;
  entityId: string;
  kind: "userInput";
  text: string;
  origin: "realUser";
  sourceCommandId?: string;
  createdAt: number;
  createdAtSeq: number;
};

const timelineFocus = vi.hoisted(() => ({
  props: null as null | {
    optimisticFirstInputRow: OptimisticFirstInputRow | null;
    afterFirstUserInputSlot: unknown;
    emptyState: unknown;
    centerEmptyStateWithDock: boolean | undefined;
    rows: readonly ConversationRow[];
  },
  optimisticRowHistory: [] as Array<OptimisticFirstInputRow | null>,
}));

// Never resolves: these files do not test discovery queries; resolving would
// trigger setState after environment teardown (unhandled exception).
const workflowRunsQueryMock = vi.hoisted(() =>
  vi.fn(() => new Promise<{ runs: unknown[] }>(() => {})),
);
const conversationMock = vi.hoisted(() => {
  const lease = {
    release: vi.fn(),
    store: {
      expectAcceptedInputProjection: vi.fn(),
      markCommandPending: vi.fn(),
      // PluginUiSessionProvider attaches a live-delta feed whenever the lease store
      // becomes non-null (IUX06 binds a session-scoped lease).
      onLiveDeltas: vi.fn(() => () => {}),
      recoverFromStaleAuthority: vi.fn(),
      onOnlineModelTransition: vi.fn(() => () => {}),
      refreshPlans: vi.fn(async () => {}),
      settleCommand: vi.fn(),
    },
  };
  const sendCommand = vi.fn(async (envelope: { commandId: string }) => ({
    commandId: envelope.commandId,
    revisionAtDecision: 1,
    status: "accepted" as const,
  }));
  const layer = {
    acquire: vi.fn(() => lease),
    queryCommands: vi.fn(async () => ({ results: [] })),
  };
  return {
    layer,
    lease,
    currentLayer: null as typeof layer | null,
    currentSendCommand: null as typeof sendCommand | null,
    sendCommand,
  };
});

const prewarmHookInputs = vi.hoisted(() => ({
  binding: null as null | {
    sessionId: string;
    beginPromotion: () => boolean;
    promote: () => void;
  },
  current: [] as Array<{
    workspaceKey: string;
    transportIdentity: unknown;
    dispatchCommand: (
      type: string,
      payload: Record<string, unknown>,
      sessionId: string | null,
    ) => Promise<unknown>;
  }>,
}));

const servicesMock = vi.hoisted(() => ({
  projectService: {
    resolveSessionDirectories: vi.fn(async (task) => ({
      ...task,
      projectId: null,
      additionalDirectories: [],
    })),
  },
  highspeedCardService: {
    // This file uses a minimal DOM that is destroyed when the case ends; keep
    // unrelated Highspeed queries pending so their Promise callbacks cannot wake
    // the React scheduler again after window cleanup.
    getSnapshot: vi.fn(() => new Promise(() => {})),
    prepareTurn: vi.fn(async () => ({
      kind: "fallback" as const,
      reason: "draw-miss" as const,
      nextDrawAt: null,
    })),
    healthy: vi.fn(),
    share: vi.fn(),
  },
  // Fix rationale: the readiness hook depends on the service as an effect
  // dependency; rebuilding it every render caused infinite re-renders until OOM.
  modelSelectionService: {
    getView: vi.fn(async () => ({
      revision: 1,
      providers: [
        {
          providerId: "provider-deepseek",
          config: { kind: "api" as const },
          models: [{ modelId: "deepseek-v4-flash", config: {} }],
        },
      ],
    })),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    validate: vi.fn(),
  },
  zcodeSessionService: {
    updateProviderRegistry: vi.fn(),
  },
  zcodeTaskService: {
    restartWorkspaceProcess: vi.fn(),
  },
  // Only prepareFirstSubmission reads this presence flag; per-test assignment.
  zcodeAgentService: undefined as object | undefined,
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

// This group only verifies composer continuity; group-sync services are covered
// by dedicated component tests and real Host/CLI E2E.
vi.mock("@/v4/BotGroupDeliveryAction.js", () => ({
  BotGroupDeliveryProvider: ({ children }: { children: unknown }) => children,
  ConnectedBotGroupDeliveryAction: () => null,
}));

// Bugfix: this file only verifies SessionPane composer continuity, so isolate the
// off-peak entry from the real TabStore dependency.
vi.mock("@/v4/OffPeakNewTaskEntry.js", () => ({
  OffPeakNewTaskEntry: () => null,
}));

// Likewise isolate the suggested-prompts placeholder: this file uses a minimal
// DOM that only implements createElement; rendering lucide icons would go through
// createElementNS and crash, which is unrelated to composer continuity.
vi.mock("@/v4/ConversationDraftSuggestedPromptsContainer.js", () => ({
  ConversationDraftSuggestedPromptsContainer: () => null,
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    layer: conversationMock.currentLayer ?? conversationMock.layer,
    sendCommand: conversationMock.currentSendCommand ?? conversationMock.sendCommand,
    attachmentPut: vi.fn(),
    // SessionPane pulls the journal-fallback run discovery query on mount: a
    // missing stub throws TypeError in an effect; the stub must be a stable
    // reference — the effect depends on workflowRuns, and a fresh function per
    // render would loop forever.
    workflowRuns: workflowRunsQueryMock,
    fileChanges: vi.fn(),
    fileRewindPreview: vi.fn(),
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

vi.mock("@/hooks/useServices.js", () => ({
  useComposerClientNamespace: () => "desktop",
  useOptionalServices: () => null,
  useServices: () => servicesMock,
}));

// This file only verifies the composer lifecycle; the target Host View async
// subscription has its own hook tests. Running the real hook in the minimal DOM
// would leave React scheduling behind window cleanup via Promise callbacks.
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionServiceView: () => ({
    state: {
      status: "ready",
      view: {
        revision: 1,
        preferredSelection: {
          providerId: "provider-deepseek",
          modelId: "deepseek-v4-flash",
        },
        providers: [
          {
            providerId: "provider-deepseek",
            config: { kind: "api" as const },
            models: [
              {
                modelId: "deepseek-v4-flash",
                config: {
                  optionSpecs: {
                    reasoningLevel: { values: ["low", "high"], map: "{}" },
                  },
                },
              },
            ],
          },
        ],
      },
    },
    reload: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", () => ({
  buildDraftCreateConfigPayload: () => ({}),
  useDraftConfigControl: () => ({
    modelSelectionRead: useModelSelectionServiceView(null),
    captureAcceptedModelSelection: () => vi.fn(),
    composerDraft: { text: "", updatedAt: 0 },
    draftConfig: {},
    draftConfigRef: {
      current: {
        mode: "build",
        modelSelection: {
          providerId: "provider-deepseek",
          modelId: "deepseek-v4-flash",
          options: { reasoningLevel: "high" },
        },
      },
    },
    resolveInitialDraftConfig: vi.fn(async () => ({})),
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
    promoteComposerDraft: vi.fn(),
    replaceComposerDraft: vi.fn(),
    updateComposerContent: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/useDraftSessionPrewarm.js", () => ({
  useDraftSessionPrewarm: (params: (typeof prewarmHookInputs.current)[number]) => {
    prewarmHookInputs.current.push(params);
    return {
      binding: prewarmHookInputs.binding,
      waitForSession: async () => {
        if (prewarmHookInputs.binding) return prewarmHookInputs.binding;
        const ack = (await params.dispatchCommand("createSession", {}, null)) as {
          result: { sessionId: string };
        };
        return {
          sessionId: ack.result.sessionId,
          beginPromotion: () => true,
          promote: vi.fn(),
        };
      },
    };
  },
}));

vi.mock("@/v4/ConversationComposer.js", () => ({
  ConversationComposer: (props: {
    disabled?: boolean;
    firstSubmissionActive?: boolean;
    onOpenRunningBackgroundWorks?: () => void;
    onPrepareFirstSubmission?: (params: {
      submissionId: string;
      incognito?: unknown;
      reservation?: { sessionId: string; commandId: string };
      onReservationCreated?: (reservation: { sessionId: string; commandId: string }) => void;
    }) => Promise<string | undefined>;
    onFirstSubmissionReserved?: (sessionId: string) => void;
    onSendText: (
      text: string,
      options?: {
        heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
        expectedHeldQueueItemIds?: readonly string[];
        requestedDelivery?: "startNow" | "queue" | "guide";
        sharedContextRefs?: Array<{
          kind: "shared_context_import";
          context_id: string;
        }>;
      },
    ) => Promise<"sent" | "blocked" | "confirmationRequired">;
  }) => {
    const { disabled = false } = props;
    scrollFocus.composerProps = props;
    const instanceIdRef = useRef<number | null>(null);
    if (instanceIdRef.current === null) {
      instanceIdRef.current = composerLifecycle.nextInstanceId;
      composerLifecycle.nextInstanceId += 1;
    }
    composerLifecycle.renders.push(instanceIdRef.current);
    composerLifecycle.disabledStates.push(disabled);
    useEffect(() => {
      composerLifecycle.mounts += 1;
      return () => {
        composerLifecycle.unmounts += 1;
      };
    }, []);
    return createElement("div", { "data-testid": "mock-composer" });
  },
}));

vi.mock("@/v4/ConversationHeader.js", () => ({
  ConversationHeader: () => createElement("div", null),
}));

vi.mock("@/v4/ConversationStatusPanel.js", () => ({
  ConversationStatusPanel: (props: {
    onTerminalSectionOpenChange?: (open: boolean) => void;
    terminalSectionOpen?: boolean;
    onAgentSectionOpenChange?: (open: boolean) => void;
    agentSectionOpen?: boolean;
    summaryPanelVariantOverride?: "panel" | "mini" | null;
  }) => {
    scrollFocus.statusPanelProps = props;
    return createElement("div", null);
  },
}));

vi.mock("@/v4/ConversationTimeline.js", () => ({
  ConversationTimeline: ({
    bottomDock,
    emptyState,
    scrollToBottomActionRef,
    optimisticFirstInputRow,
    afterFirstUserInputSlot,
    centerEmptyStateWithDock,
    rows,
  }: {
    bottomDock?: ReactNode;
    emptyState?: ReactNode;
    scrollToBottomActionRef?: { current: (() => void) | null };
    optimisticFirstInputRow?: OptimisticFirstInputRow | null;
    afterFirstUserInputSlot?: ReactNode;
    centerEmptyStateWithDock?: boolean;
    rows?: readonly ConversationRow[];
  }) => {
    timelineFocus.props = {
      optimisticFirstInputRow: optimisticFirstInputRow ?? null,
      afterFirstUserInputSlot: afterFirstUserInputSlot ?? null,
      emptyState: emptyState ?? null,
      centerEmptyStateWithDock,
      rows: rows ?? [],
    };
    timelineFocus.optimisticRowHistory.push(optimisticFirstInputRow ?? null);
    useLayoutEffect(() => {
      if (scrollToBottomActionRef) {
        scrollToBottomActionRef.current = scrollFocus.scrollToBottom;
      }
    }, [scrollToBottomActionRef]);
    return createElement("div", null, emptyState, bottomDock);
  },
}));

vi.mock("@/v4/ConversationQueuePanel.js", () => ({
  ConversationQueuePanel: (props: {
    onResume?: () => Promise<void>;
    onSendNow?: (queueItemId: string) => void;
  }) => {
    scrollFocus.queueProps = props;
    return createElement("div", null);
  },
}));

vi.mock("@/v4/V4InteractionDialogs.js", () => ({
  V4InteractionDialogs: () => createElement("div", null),
}));

vi.mock("@/request-security-edition/V4ProviderRuntimeHeadersController.js", () => ({
  V4ProviderRuntimeHeadersController: () => createElement("div", null),
}));

vi.mock("@/v4/ConversationDraftEmptyState.js", () => ({
  ConversationDraftEmptyState: () => createElement("div", null),
}));

function makeDraftSnapshot(): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "prewarm-1",
    logEpoch: "epoch-1",
    seq: 0,
    revision: 0,
    control: {
      phase: "draft",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: false, reasonCode: "noHistory" },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "emptyQueue" },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "", titleSource: "firstInput" },
    config: {
      provider: "provider-deepseek",
      model: "deepseek-v4-flash",
      thought: "medium",
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
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

const mountedRoots: Root[] = [];

// The v4 composer draft store persists through window.localStorage; the minimal
// DOM needs an in-memory implementation so seeded first-submission records are
// readable by the real SessionPane code paths.
function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => (entries.has(key) ? entries.get(key)! : null),
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, String(value));
    },
  };
}

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    clientWidth: 1024,
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
    style: {
      removeProperty: () => {},
      setProperty: () => {},
    },
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    // Draft-store writes broadcast a change event; no listeners exist in this DOM.
    dispatchEvent: () => true,
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    innerWidth: 1024,
    localStorage: createMemoryStorage(),
    Node: function Node() {},
    removeEventListener: () => {},
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock, "div");
}

function renderPane(
  root: Root,
  sessionId: string | null,
  extraProps?: { onSessionCreated?: (sessionId: string) => void },
): void {
  act(() => {
    root.render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(SessionPane, {
          paneId: "workspace-main",
          sessionId,
          workspacePath: "/workspace",
          ...(extraProps?.onSessionCreated
            ? { onSessionCreated: extraProps.onSessionCreated }
            : {}),
        }),
      ),
    );
  });
}

beforeEach(() => {
  projectDirectoryMock.current = null;
  conversationMock.layer.queryCommands.mockReset();
  conversationMock.layer.queryCommands.mockImplementation(async () => ({ results: [] }));
  sessionCreateCapture.report.mockClear();
  recoveryCapture.entries = [];
  recoveryCapture.onResend = null;
  sessionsIndexItems.current = [];
  servicesMock.zcodeAgentService = undefined;
  timelineFocus.props = null;
  timelineFocus.optimisticRowHistory = [];
  prewarmHookInputs.binding = null;
  composerLifecycle.disabledStates = [];
  composerLifecycle.mounts = 0;
  composerLifecycle.nextInstanceId = 1;
  composerLifecycle.renders = [];
  composerLifecycle.unmounts = 0;
  conversationMock.layer.acquire.mockClear();
  conversationMock.layer.acquire.mockImplementation(() => conversationMock.lease);
  conversationMock.lease.release.mockClear();
  conversationMock.lease.store.expectAcceptedInputProjection.mockClear();
  conversationMock.currentLayer = null;
  conversationMock.currentSendCommand = null;
  conversationMock.sendCommand.mockReset();
  conversationMock.sendCommand.mockImplementation(async (envelope) => ({
    commandId: envelope.commandId,
    revisionAtDecision: 1,
    status: "accepted" as const,
  }));
  prewarmHookInputs.current = [];
  scrollFocus.composerProps = null;
  scrollFocus.queueProps = null;
  scrollFocus.statusPanelProps = null;
  scrollFocus.scrollToBottom.mockClear();
  projectionState.current = {
    status: "live",
    snapshot: makeDraftSnapshot(),
    subscriptionId: "sub-draft",
    lastError: null,
    optimisticCommands: [],
    loadingOlder: false,
  };
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("SessionPane composer continuity", () => {
  it.each(["group", "project", "session"] as const)(
    "%s first send reports only after accepted; opening and follow-up sends do not report",
    async (source) => {
      const store = useZCodeSessionStore.getState();
      store.startDraft("/workspace", undefined, undefined, {
        createSource: source,
      });
      const root = createRoot(installMinimalDom());
      mountedRoots.push(root);
      renderPane(root, null);
      expect(sessionCreateCapture.report).not.toHaveBeenCalled();
      conversationMock.sendCommand.mockImplementationOnce(async (envelope) => ({
        commandId: envelope.commandId,
        revisionAtDecision: 1,
        status: "accepted" as const,
        result: { type: "createSession", sessionId: `created-${source}` },
      }));
      await act(async () => {
        await scrollFocus.composerProps?.onSendText("create session");
      });
      // Highspeed unified the first-send chain: an attachment-free first send also
      // takes the two-phase "empty createSession + sendText" path so the draw
      // admission gets a real sessionId; the first-send message_id is therefore the
      // sendText commandId (calls[1]), not the empty-create commandId (calls[0]).
      // The telemetry invariant still holds: report exactly once after accepted.
      const firstSendCalls = conversationMock.sendCommand.mock.calls;
      expect(firstSendCalls).toHaveLength(2);
      expect(sessionCreateCapture.report).toHaveBeenCalledExactlyOnceWith(
        null,
        expect.objectContaining({
          sessionId: `created-${source}`,
          messageId: firstSendCalls[1]![0].commandId,
          source,
        }),
      );
      renderPane(root, `created-${source}`);
      await act(async () => {
        await scrollFocus.composerProps?.onSendText("follow up");
      });
      expect(sessionCreateCapture.report).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["accepted", "rejected"] as const)(
    "a Goal first send with %s counts by ACK only",
    async (status) => {
      const root = createRoot(installMinimalDom());
      mountedRoots.push(root);
      renderPane(root, null);
      conversationMock.sendCommand.mockImplementationOnce(async (envelope) => ({
        commandId: envelope.commandId,
        revisionAtDecision: 1,
        status: "accepted" as const,
        result: { type: "createSession", sessionId: "goal-created" },
      }));
      conversationMock.sendCommand.mockResolvedValueOnce({
        commandId: "goal-command",
        revisionAtDecision: 1,
        status,
      } as never);
      await act(async () => {
        await scrollFocus.composerProps?.onSendText("/goal explain the test");
      });
      expect(sessionCreateCapture.report).toHaveBeenCalledTimes(status === "accepted" ? 1 : 0);
      if (status === "accepted")
        expect(sessionCreateCapture.report).toHaveBeenCalledWith(
          null,
          expect.objectContaining({ messageId: "goal-command" }),
        );
    },
  );

  it.each(["hello", "/goal explain"])(
    "a prewarmed first send of %s carries the actual input commandId",
    async (text) => {
      prewarmHookInputs.binding = {
        sessionId: "prewarmed",
        beginPromotion: () => true,
        promote: vi.fn(),
      };
      const root = createRoot(installMinimalDom());
      mountedRoots.push(root);
      renderPane(root, null);
      await act(async () => {
        await scrollFocus.composerProps?.onSendText(text);
      });
      const commandId = conversationMock.sendCommand.mock.calls[0]![0].commandId;
      expect(sessionCreateCapture.report).toHaveBeenCalledExactlyOnceWith(
        null,
        expect.objectContaining({
          sessionId: "prewarmed",
          messageId: commandId,
        }),
      );
    },
  );

  it("empty-create-then-first-send uses the sendText ID, not the empty-create ID", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    renderPane(root, null);
    conversationMock.sendCommand.mockImplementationOnce(async (envelope) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 1,
      status: "accepted" as const,
      result: { type: "createSession", sessionId: "two-phase" },
    }));
    await act(async () => {
      await scrollFocus.composerProps?.onSendText("context", {
        sharedContextRefs: [{ kind: "shared_context_import", context_id: "context-1" }],
      });
    });
    const calls = conversationMock.sendCommand.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0].commandId).not.toBe(calls[1]![0].commandId);
    expect(sessionCreateCapture.report).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ messageId: calls[1]![0].commandId }),
    );
  });

  it("a user-confirmed recovery resend uses the new accepted ID, not the old command ID", async () => {
    recoveryCapture.entries = [
      {
        commandId: "old-command",
        sessionId: null,
        replay: { kind: "input" },
      } as PendingCommandEntry,
    ];
    const replay = vi.spyOn(pendingCommandRegistry, "consumeReplay").mockReturnValueOnce({
      type: "createSession",
      sessionId: null,
      payload: { workspaceId: "/workspace", firstInput: { text: "retry" } },
      clientContext: {
        workspace: { workspacePath: "/workspace" },
        sessionCreateSource: "project",
      },
    });
    try {
      const root = createRoot(installMinimalDom());
      mountedRoots.push(root);
      renderPane(root, null);
      conversationMock.sendCommand.mockImplementationOnce(async (envelope) => ({
        commandId: envelope.commandId,
        revisionAtDecision: 1,
        status: "accepted" as const,
        result: { type: "createSession", sessionId: "recovered" },
      }));
      await act(async () => {
        recoveryCapture.onResend?.();
      });
      const newId = conversationMock.sendCommand.mock.calls[0]![0].commandId;
      expect(newId).not.toBe("old-command");
      expect(sessionCreateCapture.report).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ sessionId: "recovered", messageId: newId }),
      );
    } finally {
      replay.mockRestore();
    }
  });

  it("a first-send transport failure produces no session_create", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    renderPane(root, null);
    conversationMock.sendCommand.mockRejectedValueOnce(new Error("transport offline"));
    await act(async () => {
      await expect(scrollFocus.composerProps?.onSendText("create session")).rejects.toThrow(
        "transport offline",
      );
    });
    expect(sessionCreateCapture.report).not.toHaveBeenCalled();
  });

  it("/goal reuses the Submission frozen at click time and does not re-read the draft after async preparation", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    renderPane(root, "session-1");
    const submission = {
      mode: "build" as const,
      modelSelection: {
        providerId: "provider-deepseek",
        modelId: "deepseek-v4-flash",
        options: { reasoningLevel: "low" },
      },
    };
    await act(async () => {
      await scrollFocus.composerProps?.onSendText("/goal freeze this selection", { submission });
    });
    expect(conversationMock.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sendGoalCommand",
        payload: expect.objectContaining(submission),
      }),
    );
  });

  it("after a workspace switch, the old prewarm dispatcher still sends to the original local transport", async () => {
    const sendCommandA = vi.fn(async (envelope: { commandId: string }) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 1,
      status: "accepted" as const,
    }));
    const sendCommandB = vi.fn(async (envelope: { commandId: string }) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 1,
      status: "accepted" as const,
    }));
    const layerA = { ...conversationMock.layer };
    const layerB = { ...conversationMock.layer };
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    conversationMock.currentLayer = layerA;
    conversationMock.currentSendCommand = sendCommandA;
    act(() => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: null,
            workspacePath: "/local/a",
          }),
        ),
      );
    });
    const bindingA = prewarmHookInputs.current.findLast(
      (input) => input.workspaceKey === "/local/a",
    );
    // Bug root cause: the single-flight coordinator now identifies the transport
    // by the stable SessionDataLayer; the old assertion still treated the
    // provider-rebuilt sendCommand wrapper as the identity.
    expect(bindingA?.transportIdentity).toBe(layerA);

    conversationMock.currentLayer = layerB;
    conversationMock.currentSendCommand = sendCommandB;
    act(() => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: null,
            workspacePath: "/local/b",
          }),
        ),
      );
    });
    await act(async () => {
      await bindingA?.dispatchCommand("deleteSession", {}, "draft-a");
    });

    expect(sendCommandA).toHaveBeenCalledTimes(1);
    expect(sendCommandB).not.toHaveBeenCalled();
  });

  it("keeps one composer instance while draft promotion waits for the first snapshot", () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    renderPane(root, null);
    projectionState.current = {
      status: "connecting",
      snapshot: null,
      subscriptionId: null,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    renderPane(root, "session-1");
    projectionState.current = {
      status: "live",
      snapshot: { ...makeDraftSnapshot(), sessionId: "session-1" },
      subscriptionId: "sub-session",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    renderPane(root, "session-1");

    expect(composerLifecycle.mounts).toBe(1);
    expect(composerLifecycle.unmounts).toBe(0);
    expect(new Set(composerLifecycle.renders)).toEqual(new Set([1]));
    expect(composerLifecycle.disabledStates).toContain(true);
    expect(composerLifecycle.disabledStates.at(-1)).toBe(false);
  });

  it("focuses after start-now, preserves position on enqueue, and focuses on queue send-now", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    projectionState.current = {
      status: "live",
      snapshot: { ...makeDraftSnapshot(), sessionId: "session-1" },
      subscriptionId: "sub-session",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    renderPane(root, "session-1");

    await act(async () => {
      await scrollFocus.composerProps?.onSendText("direct prompt");
    });
    expect(scrollFocus.scrollToBottom).toHaveBeenCalledTimes(1);

    scrollFocus.scrollToBottom.mockClear();
    projectionState.current = {
      ...projectionState.current,
      snapshot: {
        ...projectionState.current.snapshot,
        inputRouting: { mode: "enqueue" },
      },
    };
    renderPane(root, "session-1");

    await act(async () => {
      await scrollFocus.composerProps?.onSendText("queued prompt");
    });
    expect(scrollFocus.scrollToBottom).not.toHaveBeenCalled();

    act(() => scrollFocus.queueProps?.onSendNow?.("queue-1"));
    expect(scrollFocus.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("running startNow dispatches one atomic sendText and never creates or promotes a queue item", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    projectionState.current = {
      status: "live",
      snapshot: {
        ...makeDraftSnapshot(),
        sessionId: "session-1",
        inputRouting: { mode: "enqueue" },
      },
      subscriptionId: "sub-session",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    renderPane(root, "session-1");
    conversationMock.sendCommand.mockReset();
    conversationMock.sendCommand.mockImplementation(async (envelope) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 1,
      status: "accepted" as const,
    }));

    await act(async () => {
      await scrollFocus.composerProps?.onSendText("Run now", {
        requestedDelivery: "startNow",
      });
    });

    expect(conversationMock.sendCommand).toHaveBeenCalledTimes(1);
    expect(conversationMock.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sendText",
        payload: expect.objectContaining({
          text: "Run now",
          requestedDelivery: "startNow",
        }),
      }),
    );
    expect(conversationMock.lease.store.expectAcceptedInputProjection).toHaveBeenCalledWith(
      conversationMock.sendCommand.mock.calls[0]?.[0].commandId,
    );
  });

  it("routes paused queue input to modal, while /compact queues directly", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const queuedItem = {
      queueItemId: "q-1",
      kind: "sendText" as const,
      text: "old message",
      sourceCommandId: "old-command",
      clientId: "desktop",
      attachments: [],
      delivery: { requested: "queue" as const, admitted: "queue" as const },
      order: { admissionSeq: 1, queuePosition: 0 },
      steer: { state: "notRequested" as const },
      dispatch: { state: "queued" as const },
      admittedAt: 1,
    };
    projectionState.current = {
      status: "live",
      snapshot: {
        ...makeDraftSnapshot(),
        sessionId: "session-1",
        revision: 7,
        inputRouting: { mode: "choice" },
        queue: {
          autoDrain: false,
          pauseReason: "stopped",
          items: [queuedItem],
        },
      },
      subscriptionId: "sub-session",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    renderPane(root, "session-1");

    await act(async () => {
      await expect(scrollFocus.composerProps?.onSendText("new message")).resolves.toBe(
        "confirmationRequired",
      );
      await expect(scrollFocus.composerProps?.onSendText("/goal new goal")).resolves.toBe(
        "confirmationRequired",
      );
    });
    expect(conversationMock.sendCommand).not.toHaveBeenCalled();

    await act(async () => {
      await scrollFocus.composerProps?.onSendText("/compact");
    });
    expect(conversationMock.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "compact", sessionId: "session-1" }),
    );

    conversationMock.sendCommand.mockReset();
    conversationMock.sendCommand.mockImplementation(async (envelope) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 1,
      status: "accepted" as const,
    }));
    await act(async () => {
      await scrollFocus.composerProps?.onSendText("new message", {
        heldQueueDisposition: "clearQueueAndSend",
        expectedHeldQueueItemIds: ["q-1"],
      });
    });
    expect(conversationMock.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sendText",
        payload: expect.objectContaining({
          heldQueueDisposition: "clearQueueAndSend",
          expectedHeldQueueItemIds: ["q-1"],
        }),
      }),
    );
  });

  it("paused queue continue dispatches CAS setAutoDrain without preempting in UI", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const snapshot = makeDraftSnapshot();
    projectionState.current = {
      status: "live",
      snapshot: {
        ...snapshot,
        sessionId: "session-1",
        revision: 9,
        queue: {
          autoDrain: false,
          items: [
            {
              queueItemId: "q-1",
              kind: "sendText",
              text: "old message",
              sourceCommandId: "old-command",
              clientId: "desktop",
              attachments: [],
              delivery: { requested: "queue", admitted: "queue" },
              order: { admissionSeq: 1, queuePosition: 0 },
              steer: { state: "notRequested" },
              dispatch: { state: "queued" },
              admittedAt: 1,
            },
          ],
        },
      },
      subscriptionId: "sub-session",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    renderPane(root, "session-1");

    await scrollFocus.queueProps?.onResume?.();
    expect(conversationMock.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRevision: 9,
        payload: { autoDrain: true },
        sessionId: "session-1",
        type: "setAutoDrain",
      }),
    );
  });

  // The expanded view must show no less than the capsule (docs/dynamic-workflow/
  // presentation.md "Other places a run appears"): when a live run appears (count
  // going 0 to >=1, including entering a session that already has live runs) the
  // Workflows section opens; it folds when the last one ends. A manual fold stays
  // folded until all runs end or the session changes.
  it("opens the Workflows section while a run is live and respects a manual fold", () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const liveRun = {
      runId: "dwfrun-1",
      toolCallId: "tool-wf-1",
      status: "running" as const,
      usage: { spentTokens: 0, nodesUsed: 0 },
      actors: [],
      nodes: [],
      lastEventSequence: 1,
    };
    const withRuns = (sessionId: string, runs: (typeof liveRun)[]) => ({
      status: "live" as const,
      snapshot: {
        ...makeDraftSnapshot(),
        sessionId,
        workflowRuns: { revision: runs.length, runs },
      },
      subscriptionId: `sub-${sessionId}`,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    });

    projectionState.current = withRuns("session-1", []);
    renderPane(root, "session-1");
    expect(scrollFocus.statusPanelProps?.workflowSectionOpen).toBe(false);

    // 0 -> 1: open.
    projectionState.current = withRuns("session-1", [liveRun]);
    renderPane(root, "session-1");
    expect(scrollFocus.statusPanelProps?.workflowSectionOpen).toBe(true);

    // After a manual fold, runs still going (another one arriving included) keep it folded.
    act(() => scrollFocus.statusPanelProps?.onWorkflowSectionOpenChange?.(false));
    projectionState.current = withRuns("session-1", [liveRun, { ...liveRun, runId: "dwfrun-2" }]);
    renderPane(root, "session-1");
    expect(scrollFocus.statusPanelProps?.workflowSectionOpen).toBe(false);

    // All ended: fold; the next run appearing: reopen.
    projectionState.current = withRuns("session-1", [{ ...liveRun, status: "completed" as never }]);
    renderPane(root, "session-1");
    expect(scrollFocus.statusPanelProps?.workflowSectionOpen).toBe(false);
    projectionState.current = withRuns("session-1", [{ ...liveRun, runId: "dwfrun-3" }]);
    renderPane(root, "session-1");
    expect(scrollFocus.statusPanelProps?.workflowSectionOpen).toBe(true);

    // Fold inside a session with live runs, then enter another session with live
    // runs: the new session shows it open.
    act(() => scrollFocus.statusPanelProps?.onWorkflowSectionOpenChange?.(false));
    projectionState.current = withRuns("session-2", [liveRun]);
    renderPane(root, "session-2");
    expect(scrollFocus.statusPanelProps?.workflowSectionOpen).toBe(true);
  });

  it("opens typed background sections and resets them independently", () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const runningWork = {
      workId: "work-bash",
      kind: "bash" as const,
      title: "Run checks",
      status: "running" as const,
      startedAt: 1_700_000_000_000,
      anchorRowId: null,
    };
    const runningAgent = {
      ...runningWork,
      workId: "work-agent",
      kind: "subagent" as const,
      title: "Review changes",
    };
    const runningSubagents = [
      {
        childSessionId: "child-agent",
        subagentType: "Explore",
        title: "Review changes",
        status: "running",
        startedAt: 1_700_000_000_000,
      },
    ];
    projectionState.current = {
      status: "live",
      snapshot: {
        ...makeDraftSnapshot(),
        sessionId: "session-1",
        backgroundWorks: [runningWork, runningAgent],
        subagents: {
          revision: 1,
          childSessionIds: ["child-agent"],
          running: runningSubagents,
          endedTotal: 0,
        },
      },
      subscriptionId: "sub-session-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    renderPane(root, "session-1");

    expect(scrollFocus.statusPanelProps?.terminalSectionOpen).toBe(false);
    expect(scrollFocus.statusPanelProps?.agentSectionOpen).toBe(false);
    act(() => scrollFocus.composerProps?.onOpenRunningBackgroundWorks?.());
    expect(scrollFocus.statusPanelProps?.summaryPanelVariantOverride).toBe("panel");
    expect(scrollFocus.statusPanelProps?.terminalSectionOpen).toBe(true);
    expect(scrollFocus.statusPanelProps?.agentSectionOpen).toBe(true);

    act(() => scrollFocus.statusPanelProps?.onTerminalSectionOpenChange?.(false));
    expect(scrollFocus.statusPanelProps?.terminalSectionOpen).toBe(false);
    expect(scrollFocus.statusPanelProps?.agentSectionOpen).toBe(true);
    act(() => scrollFocus.composerProps?.onOpenRunningBackgroundWorks?.());
    expect(scrollFocus.statusPanelProps?.terminalSectionOpen).toBe(true);
    expect(scrollFocus.statusPanelProps?.agentSectionOpen).toBe(true);

    projectionState.current = {
      ...projectionState.current,
      snapshot: {
        ...projectionState.current.snapshot,
        sessionId: "session-2",
        backgroundWorks: [runningWork, runningAgent],
      },
      subscriptionId: "sub-session-2",
    };
    renderPane(root, "session-2");
    expect(scrollFocus.statusPanelProps?.terminalSectionOpen).toBe(false);
    expect(scrollFocus.statusPanelProps?.agentSectionOpen).toBe(false);

    act(() => scrollFocus.composerProps?.onOpenRunningBackgroundWorks?.());
    projectionState.current = {
      ...projectionState.current,
      snapshot: {
        ...projectionState.current.snapshot,
        backgroundWorks: [runningAgent],
      },
    };
    renderPane(root, "session-2");
    expect(scrollFocus.statusPanelProps?.terminalSectionOpen).toBe(false);
    expect(scrollFocus.statusPanelProps?.agentSectionOpen).toBe(true);

    projectionState.current = {
      ...projectionState.current,
      snapshot: {
        ...projectionState.current.snapshot,
        backgroundWorks: [],
        subagents: {
          revision: 2,
          childSessionIds: [],
          running: [],
          endedTotal: 0,
        },
      },
    };
    renderPane(root, "session-2");
    expect(scrollFocus.statusPanelProps?.agentSectionOpen).toBe(false);
    expect(scrollFocus.composerProps?.onOpenRunningBackgroundWorks).toBeUndefined();
  });
});

describe("SessionPane first-submission instant UX (IUX04/05/06/08)", () => {
  const WORKSPACE = "/workspace";

  // SessionPane derives the draft scope as `__draft__:${composerScopeKey(scope)}`
  // with the workspace's draft project and the mocked "desktop" client namespace.
  function paneDraftScope(): string {
    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(WORKSPACE, undefined);
    return `__draft__:${composerScopeKey(
      resolveComposerScope(workspaceState.draftProjectId, undefined, "desktop"),
    )}`;
  }

  function paneDraftGeneration(): number {
    return useZCodeSessionStore.getState().getWorkspaceState(WORKSPACE, undefined)
      .draftFocusVersion;
  }

  // Seed the record the way the composer does at freeze: persist at the scope the
  // pane reads for this session, then arm the active-first-submission flag.
  function seedFirstSubmissionRecord(
    scopeSessionId: string,
    submissionId: string,
    overrides?: {
      commandId?: string;
      status?: "preparing" | "sending" | "failed" | "unknown";
      text?: string;
      reservation?: { sessionId: string; commandId: string };
    },
  ): void {
    persistV4ComposerDraft(
      WORKSPACE,
      undefined,
      getV4WorktreeRecoveryScope(scopeSessionId, submissionId),
      {
        text: overrides?.text ?? "hello",
        firstSubmission: {
          submissionId,
          ownerKey: "test-owner",
          generation: paneDraftGeneration(),
          status: overrides?.status ?? "preparing",
          ...(overrides?.commandId ? { commandId: overrides.commandId } : {}),
          ...(overrides?.reservation ? { reservation: overrides.reservation } : {}),
        },
      },
    );
    setV4FirstSubmissionActive(WORKSPACE, undefined, submissionId, true);
  }

  function realUserInputRow(sourceCommandId?: string): ConversationRow {
    return {
      rowId: 101,
      turnId: "turn-1",
      entityId: "entity-1",
      productTurnId: "turn-1",
      kind: "userInput",
      text: "hello",
      origin: "realUser",
      createdAt: 1_700_000_000_000,
      createdAtSeq: 1,
      ...(sourceCommandId ? { sourceCommandId } : {}),
    };
  }

  function boundProjectionState(
    sessionId: string,
    options?: {
      rows?: ConversationSnapshot["rows"]["window"];
      queueItems?: ConversationSnapshot["queue"]["items"];
      submissionPreparation?: { submissionId: string };
    },
  ): ProjectionState {
    const base = makeDraftSnapshot();
    return {
      status: "live",
      snapshot: {
        ...base,
        ...(options?.submissionPreparation
          ? {
              meta: {
                ...base.meta,
                submissionPreparation: {
                  submissionId: options.submissionPreparation.submissionId,
                  status: "preparing" as const,
                  createdAt: 1,
                  updatedAt: 1,
                },
              },
            }
          : {}),
        sessionId,
        queue: { autoDrain: true, items: options?.queueItems ?? [] },
        rows: {
          window: options?.rows ?? [],
          totalCount: (options?.rows ?? []).length,
          firstRowId: null,
        },
      },
      subscriptionId: `sub-${sessionId}`,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
  }

  it("IUX05: a held reservation ACK keeps the user in chat with the optimistic row and no progress label", async () => {
    servicesMock.zcodeAgentService = {};
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const submissionId = "a1b2c3d4-1111-4222-8333-444444444444";
    seedFirstSubmissionRecord(paneDraftScope(), submissionId, { text: "hello" });

    renderPane(root, null);

    const optimistic = timelineFocus.props?.optimisticFirstInputRow ?? null;
    expect(optimistic).not.toBeNull();
    expect(optimistic).toMatchObject({ kind: "userInput", text: "hello", origin: "realUser" });
    // The turn itself is the feedback: nothing renders under the message while the
    // submission is active (specs/first-submission-instant-ux.md, Status under the message).
    expect(
      renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          timelineFocus.props?.afterFirstUserInputSlot as ReactNode,
        ),
      ),
    ).toBe("");
    expect(timelineFocus.props?.emptyState).toBeNull();
    expect(timelineFocus.props?.centerEmptyStateWithDock).toBe(false);
    expect(scrollFocus.composerProps?.firstSubmissionActive).toBe(true);

    // Hold the createSession reservation ACK like a slow Host.
    let resolveReservation!: (ack: unknown) => void;
    conversationMock.sendCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReservation = resolve;
        }),
    );
    const onReservationCreated = vi.fn();
    let prepared: Promise<string | undefined> | undefined;
    await act(async () => {
      prepared = scrollFocus.composerProps?.onPrepareFirstSubmission?.({
        submissionId,
        onReservationCreated,
      });
    });
    expect(conversationMock.sendCommand).toHaveBeenCalledTimes(1);
    const [reservationEnvelope] = conversationMock.sendCommand.mock.calls[0]!;
    expect(reservationEnvelope).toMatchObject({
      type: "createSession",
      payload: {
        submissionPreparation: { submissionId },
        sessionId: submissionId,
      },
    });
    // The P2 bind material exists at the dispatch envelope, before the ACK.
    expect(onReservationCreated).toHaveBeenCalledExactlyOnceWith({
      sessionId: submissionId,
      commandId: expect.any(String),
    });

    await act(async () => {
      resolveReservation({
        commandId: onReservationCreated.mock.calls[0]?.[0].commandId,
        revisionAtDecision: 1,
        status: "accepted",
        result: { type: "createSession", sessionId: submissionId },
      });
      await expect(prepared).resolves.toBe(submissionId);
    });
    // Resolving the held ACK must not make the pane dispatch a second createSession
    // or a duplicate sendText for the same submission.
    const calls = conversationMock.sendCommand.mock.calls;
    expect(calls).toHaveLength(1);
  });

  it("IUX08: the reserved-session bind never waits for the sessions-index row", async () => {
    const onSessionCreated = vi.fn();
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    renderPane(root, null, { onSessionCreated });
    expect(sessionsIndexItems.current).toHaveLength(0);

    // Async act: the immediate bind bumps the task-list version on the real session
    // store; the nested re-render must flush inside the act scope, not on the
    // scheduler after this minimal DOM (and window) is torn down.
    await act(async () => {
      scrollFocus.composerProps?.onFirstSubmissionReserved?.("reserved-1");
    });

    // The pane binds from the Host reservation identity in the same act; the
    // sidebar source never produced a row for the reserved session.
    expect(onSessionCreated).toHaveBeenCalledExactlyOnceWith("reserved-1");
    expect(sessionsIndexItems.current).toHaveLength(0);
  });

  it("IUX06: an admitted queue item keeps exactly one optimistic user turn until the real projection lands", () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const submissionId = "b2c3d4e5-2222-4332-9444-555555555555";
    seedFirstSubmissionRecord("reserved-1", submissionId, {
      commandId: "cmd-1",
      status: "sending",
    });
    const admittedQueueItem = {
      queueItemId: "q-first",
      kind: "sendText" as const,
      text: "hello",
      sourceCommandId: "cmd-1",
      clientId: "desktop",
      attachments: [],
      delivery: { requested: "queue" as const, admitted: "queue" as const },
      order: { admissionSeq: 1, queuePosition: 0 },
      steer: { state: "notRequested" as const },
      dispatch: { state: "queued" as const },
      admittedAt: 1,
    };
    // The lease must report the bound session id for the timeline snapshot to flow.
    conversationMock.layer.acquire.mockImplementationOnce(
      () =>
        ({ ...conversationMock.lease, sessionId: "reserved-1" }) as typeof conversationMock.lease,
    );

    projectionState.current = boundProjectionState("reserved-1", {
      queueItems: [admittedQueueItem],
    });
    renderPane(root, "reserved-1");

    const queuePhase = timelineFocus.props;
    expect(queuePhase?.optimisticFirstInputRow).toMatchObject({
      kind: "userInput",
      text: "hello",
      origin: "realUser",
      sourceCommandId: "cmd-1",
    });
    // Queue-item visibility alone must never hide the row: every render so far
    // (mount, lease settle, store version bumps) kept the optimistic row alive.
    expect(timelineFocus.optimisticRowHistory.length).toBeGreaterThan(0);
    for (const captured of timelineFocus.optimisticRowHistory) {
      expect(captured).not.toBeNull();
    }
    // Exactly one user turn: the optimistic row only, no projected user row yet.
    expect((queuePhase?.rows ?? []).filter((row) => row.kind === "userInput")).toHaveLength(0);

    projectionState.current = boundProjectionState("reserved-1", {
      queueItems: [admittedQueueItem],
      rows: [realUserInputRow("cmd-1")],
    });
    renderPane(root, "reserved-1");

    expect(timelineFocus.props?.optimisticFirstInputRow).toBeNull();
    expect(readV4WorktreeRecoveryDrafts(WORKSPACE, undefined, "reserved-1")).toHaveLength(0);
    expect(isV4FirstSubmissionActive(WORKSPACE, undefined, submissionId)).toBe(false);

    // Fresh-session fallback: a realUser row without sourceCommandId also reconciles.
    const fallbackSubmissionId = "c3d4e5f6-3333-5443-a555-666666666666";
    seedFirstSubmissionRecord("reserved-2", fallbackSubmissionId, { status: "sending" });
    conversationMock.layer.acquire.mockImplementationOnce(
      () =>
        ({ ...conversationMock.lease, sessionId: "reserved-2" }) as typeof conversationMock.lease,
    );
    projectionState.current = boundProjectionState("reserved-2", {
      rows: [realUserInputRow()],
    });
    renderPane(root, "reserved-2");
    expect(timelineFocus.props?.optimisticFirstInputRow).toBeNull();
    expect(readV4WorktreeRecoveryDrafts(WORKSPACE, undefined, "reserved-2")).toHaveLength(0);
    expect(isV4FirstSubmissionActive(WORKSPACE, undefined, fallbackSubmissionId)).toBe(false);
  });

  it("IUX04: navigating away before the ACK never renders or re-dispatches the submission; returning reconciles", () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const submissionId = "d4e5f6a7-4444-6553-b666-777777777777";
    const draftScope = paneDraftScope();
    seedFirstSubmissionRecord(draftScope, submissionId, { text: "navigate away" });
    const onSessionCreated = vi.fn();

    renderPane(root, null, { onSessionCreated });
    expect(timelineFocus.props?.optimisticFirstInputRow).toMatchObject({
      text: "navigate away",
      origin: "realUser",
    });

    // Navigate to another existing session before the reservation identity exists.
    projectionState.current = boundProjectionState("other-session");
    renderPane(root, "other-session");
    expect(timelineFocus.props?.optimisticFirstInputRow).toBeNull();

    // The late reservation bind lands while the pane is elsewhere (the composer's
    // bindReservedSessionRecord moves the persisted record to the reserved scope).
    expect(
      moveV4ComposerDraft(
        WORKSPACE,
        undefined,
        getV4WorktreeRecoveryScope(draftScope, submissionId),
        getV4WorktreeRecoveryScope("reserved-1", submissionId),
      ),
    ).toBe(true);
    renderPane(root, "other-session");
    // A pane not on the reserved session never renders it and never steals focus.
    expect(timelineFocus.props?.optimisticFirstInputRow).toBeNull();
    expect(onSessionCreated).not.toHaveBeenCalledWith("reserved-1");

    projectionState.current = boundProjectionState("reserved-1");
    renderPane(root, "reserved-1");
    // Returning reconciles from the persisted record: same text and identity, and
    // the pane never re-dispatched the submission.
    expect(timelineFocus.props?.optimisticFirstInputRow).toMatchObject({
      text: "navigate away",
      origin: "realUser",
      entityId: submissionId,
    });
    expect(conversationMock.sendCommand).not.toHaveBeenCalled();
  });
  // Unresolved outcomes (specs/first-submission-instant-ux.md, Reconciliation): the pane holding
  // an inactive sending/unknown record decides from durable Host facts, then the original command.
  async function mountBoundRecord(
    sessionId: string,
    submissionId: string,
    options: { preparing: boolean; status?: "sending" | "unknown"; worktree?: boolean },
  ) {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    seedFirstSubmissionRecord(sessionId, submissionId, {
      commandId: `cmd-${submissionId}`,
      status: options.status ?? "unknown",
      // Plain first submissions carry their Host reservation; worktree ones never do.
      ...(options.worktree
        ? {}
        : { reservation: { sessionId, commandId: `reserve-${submissionId}` } }),
    });
    // The chain ended (lost ACK) or the app restarted: nothing in this renderer owns it.
    setV4FirstSubmissionActive(WORKSPACE, undefined, submissionId, false);
    conversationMock.layer.acquire.mockImplementation(
      () => ({ ...conversationMock.lease, sessionId }) as typeof conversationMock.lease,
    );
    projectionState.current = boundProjectionState(
      sessionId,
      options.preparing ? { submissionPreparation: { submissionId } } : undefined,
    );
    renderPane(root, sessionId);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  const recordStatus = (sessionId: string) =>
    readV4WorktreeRecoveryDrafts(WORKSPACE, undefined, sessionId)[0]?.draft.firstSubmission?.status;

  it("F: a still-preparing session whose command the Host does not know turns failed with Retry", async () => {
    conversationMock.layer.queryCommands.mockImplementation(async () => ({
      results: [{ key: { sessionId: "reserved-f1", commandId: "cmd-f1" }, result: "unknown" }],
    }));
    await mountBoundRecord("reserved-f1", "f1", { preparing: true });
    expect(conversationMock.layer.queryCommands).toHaveBeenCalledWith({
      commands: [{ sessionId: "reserved-f1", commandId: "cmd-f1" }],
    });
    expect(recordStatus("reserved-f1")).toBe("failed");
    expect(conversationMock.sendCommand).not.toHaveBeenCalled();
  });

  it("F: an accepted command settles to synchronizing until the real row projects", async () => {
    conversationMock.layer.queryCommands.mockImplementation(async () => ({
      results: [
        {
          key: { sessionId: "reserved-f2", commandId: "cmd-f2" },
          result: { commandId: "cmd-f2", status: "accepted", revisionAtDecision: 1 },
        },
      ],
    }));
    await mountBoundRecord("reserved-f2", "f2", { preparing: true });
    expect(recordStatus("reserved-f2")).toBe("sending");
  });

  it("F: a Host that already admitted the frozen input is trusted over a lost command ledger", async () => {
    conversationMock.layer.queryCommands.mockImplementation(async () => ({
      results: [{ key: { sessionId: "reserved-f3", commandId: "cmd-f3" }, result: "unknown" }],
    }));
    await mountBoundRecord("reserved-f3", "f3", { preparing: false });
    // No submissionPreparation: the Host marked the frozen input admitted, so no Retry (it
    // would resend the same input under a new command id).
    expect(recordStatus("reserved-f3")).toBe("sending");
    expect(conversationMock.layer.queryCommands).not.toHaveBeenCalled();
  });

  it("F: a worktree record never trusts a missing marker (it completes at activation) and queries", async () => {
    conversationMock.layer.queryCommands.mockImplementation(async () => ({
      results: [{ key: { sessionId: "worktree-f5", commandId: "cmd-f5" }, result: "unknown" }],
    }));
    await mountBoundRecord("worktree-f5", "f5", { preparing: false, worktree: true });
    expect(conversationMock.layer.queryCommands).toHaveBeenCalledWith({
      commands: [{ sessionId: "worktree-f5", commandId: "cmd-f5" }],
    });
    expect(recordStatus("worktree-f5")).toBe("failed");
  });

  it("F: an unavailable command query leaves the record unchanged", async () => {
    conversationMock.layer.queryCommands.mockImplementation(async () => {
      throw new Error("transport down");
    });
    await mountBoundRecord("reserved-f4", "f4", { preparing: true, status: "sending" });
    expect(recordStatus("reserved-f4")).toBe("sending");
  });

  it("B: a worktree reservation binds from the Host identity at the ACK, never on the project tree", async () => {
    const commitCreatedTask = vi.fn(() => new Promise<void>(() => {}));
    projectDirectoryMock.current = { commitCreatedTask, groups: { refresh: async () => {} } };
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const submissionId = "f6a7b8c9-6666-4775-8888-999999999999";
    seedFirstSubmissionRecord(paneDraftScope(), submissionId, { text: "worktree first" });
    const onSessionCreated = vi.fn();
    renderPane(root, null, { onSessionCreated });
    conversationMock.sendCommand.mockImplementationOnce(async (envelope) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 1,
      status: "accepted" as const,
      result: { type: "createSession", sessionId: "wt-session-1" },
    }));
    const prepare = (
      scrollFocus.composerProps as unknown as {
        onPrepareWorktreeSession: (
          params: { branchName: string; targetPath: string; attemptId: string },
          options: { shouldActivate: () => boolean },
        ) => Promise<string>;
      }
    ).onPrepareWorktreeSession;
    await act(async () => {
      await expect(
        prepare(
          { branchName: "feature-b", targetPath: "/worktrees/feature-b", attemptId: "attempt-b" },
          { shouldActivate: () => true },
        ),
      ).resolves.toBe("wt-session-1");
    });
    // The message moved with the bind, which never waited on the (never-settling) tree staging.
    expect(onSessionCreated).toHaveBeenCalledWith("wt-session-1");
    expect(commitCreatedTask).not.toHaveBeenCalled();
    expect(readV4WorktreeRecoveryDrafts(WORKSPACE, undefined, "wt-session-1")).toHaveLength(1);
    expect(readV4WorktreeRecoveryDrafts(WORKSPACE, undefined, paneDraftScope())).toHaveLength(0);
  });
});
