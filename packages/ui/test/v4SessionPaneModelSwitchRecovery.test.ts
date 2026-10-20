import { act, createElement, type ComponentProps, Suspense, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSelectionView } from "@zcode/services";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import {
  type ModelSelection,
  ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
  type ZCodeWorkspaceStateSnapshot,
} from "@zcode/shared";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationSnapshot,
  SessionModelTransition,
  SessionConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ConversationComposer } from "@/v4/ConversationComposer.js";
import type { V4InteractionDialogsProps } from "@/v4/V4InteractionDialogs.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import { logger } from "@/logger.js";
import { expectedCopy } from "./helpers/uiCopy.js";

const recommendation = vi.hoisted(() =>
  vi.fn(async (selection: ModelSelection): Promise<ModelSelection | null> => selection),
);
vi.mock("@/hooks/useStartPlanRecommendation.js", () => ({
  useStartPlanRecommendation: () => recommendation,
}));
const modelSelectionMock = vi.hoisted(() => ({ view: null as ModelSelectionView | null }));
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionView: () => ({
    state: modelSelectionMock.view
      ? { status: "ready", view: modelSelectionMock.view }
      : { status: "loading" },
    reload: vi.fn(),
  }),
  useModelSelectionServiceView: () => ({
    state: modelSelectionMock.view
      ? { status: "ready", view: modelSelectionMock.view }
      : { status: "loading" },
    reload: vi.fn(),
  }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// This suite only verifies model recovery; group sync services are covered by dedicated component tests and real Host/CLI E2E.
vi.mock("@/v4/BotGroupDeliveryAction.js", () => ({
  BotGroupDeliveryProvider: ({ children }: { children: unknown }) => children,
  ConnectedBotGroupDeliveryAction: () => null,
}));

type ComposerProps = ComponentProps<typeof ConversationComposer>;

function seedModelProviderNames(): void {
  modelSelectionMock.view = {
    revision: 1,
    providers: [
      {
        providerId: "primary-provider",
        providerName: "Primary Coding Plan",
        config: {},
        models: [],
      },
      {
        providerId: "alternate-provider",
        providerName: "Alternate API",
        config: {},
        models: [],
      },
    ],
  };
}

// Never resolves: these files do not test discovery queries; resolving would trigger setState after environment teardown (unhandled exception).
const workflowRunsQueryMock = vi.hoisted(() =>
  vi.fn(() => new Promise<{ runs: unknown[] }>(() => {})),
);
const captured = vi.hoisted(() => ({
  composerProps: null as ComposerProps | null,
  interactionProps: null as V4InteractionDialogsProps | null,
}));

const draftConfigMock = vi.hoisted(() => ({
  draftConfigRef: { current: {} as Partial<SessionConfigState> },
  resolveInitialDraftConfig: vi.fn<() => Partial<SessionConfigState> | undefined>(),
  handleDraftSelectModel: vi.fn((provider: string, model: string) => {
    draftConfigMock.draftConfigRef.current = {
      ...draftConfigMock.draftConfigRef.current,
      provider,
      model,
      modelSelection: { providerId: provider, modelId: model, options: { reasoningLevel: "high" } },
    };
  }),
  handleDraftSelectThought: vi.fn((thought: string) => {
    draftConfigMock.draftConfigRef.current = {
      ...draftConfigMock.draftConfigRef.current,
      thought,
      modelSelection: draftConfigMock.draftConfigRef.current.modelSelection
        ? {
            ...draftConfigMock.draftConfigRef.current.modelSelection,
            options: { reasoningLevel: thought },
          }
        : undefined,
    };
  }),
  handleDraftSwitchMode: vi.fn((mode: SessionConfigState["mode"]) => {
    draftConfigMock.draftConfigRef.current = {
      ...draftConfigMock.draftConfigRef.current,
      mode,
    };
  }),
}));

const composerRecentMocks = vi.hoisted(() => ({
  acceptSubmission: vi.fn(),
}));

const prewarmHookMock = vi.hoisted(() => ({
  lastEnabled: null as boolean | null,
  binding: undefined as
    | {
        workspaceKey: string;
        sessionId: string;
        promote: () => void;
        discard: () => void;
      }
    | null
    | undefined,
}));

const modelTransitionMock = vi.hoisted(() => ({
  listener: null as ((transition: SessionModelTransition) => void) | null,
  onAcquire: null as (() => void) | null,
}));

const sessionOpenTelemetryMock = vi.hoisted(() => ({
  lastParams: null as null | { sessionId: string | null; enabled?: boolean },
}));

const mocks = vi.hoisted(() => ({
  highspeedCardService: {
    getSnapshot: vi.fn(async () => ({ card: null, nextDrawAt: null, drawing: false })),
    prepareTurn: vi.fn(async () => ({
      kind: "fallback" as const,
      reason: "draw-miss" as const,
      nextDrawAt: null,
    })),
    healthy: vi.fn(),
    invalidateCard: vi.fn(async () => true),
    share: vi.fn(),
  },
  recoverFromStaleAuthority: vi.fn(),
  layer: {
    acquire: vi.fn((sessionId: string) => {
      const lease = {
        sessionId,
        openKind: "cold" as const,
        startedAt: 0,
        store: {
          getState: vi.fn(() => ({
            snapshot: projectionState.current?.snapshot ?? null,
          })),
          markCommandPending: vi.fn(),
          expectAcceptedInputProjection: vi.fn(),
          recoverFromStaleAuthority: mocks.recoverFromStaleAuthority,
          onOnlineModelTransition: vi.fn(
            (listener: (transition: SessionModelTransition) => void) => {
              modelTransitionMock.listener = listener;
              return () => {
                if (modelTransitionMock.listener === listener) {
                  modelTransitionMock.listener = null;
                }
              };
            },
          ),
          onLiveDeltas: vi.fn(() => () => {}),
          refreshPlans: vi.fn(async () => {}),
          settleCommand: vi.fn(),
        },
        release: vi.fn(),
      };
      modelTransitionMock.onAcquire?.();
      return lease;
    }),
  },
  sendCommand: vi.fn(),
  attachmentPut: vi.fn(),
  modelSelectionService: {
    getView: vi.fn(async () => ({
      revision: 1,
      providers: [
        {
          providerId: "alternate-provider",
          config: { kind: "api" as const },
          models: [{ modelId: "deepseek-v4-pro", config: {} }],
        },
      ],
    })),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    validate: vi.fn(),
  },
  zcodeSessionService: {
    getWorkspaceRuntimeIdentity: vi.fn(async () => ({
      identity: "runtime-1",
      workspaceKey: "remote:ssh:dev:/workspace",
    })),
    updateProviderRegistry: vi.fn(async () => ({
      providerCount: 1,
      status: "applied" as const,
    })),
    readWorkspacePresentation: vi.fn(async () => ({
      workspace: makeWorkspaceStateSnapshot().workspace,
      mode: "build" as const,
      slashCommands: [],
    })),
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
    lastError: string | null;
    optimisticCommands: readonly [];
    loadingOlder: boolean;
  } | null,
}));

// Bugfix: this file only verifies SessionPane model recovery, isolating the idle-time entry from the real TabStore.
vi.mock("@/v4/OffPeakNewTaskEntry.js", () => ({
  OffPeakNewTaskEntry: () => null,
}));

// Likewise isolate the recommended-prompt container: it depends on TabStoreProvider through
// useWorkspaceServicesResolution, while this file only verifies draft provider/model recovery and provides no Tab store.
vi.mock("@/v4/ConversationDraftSuggestedPromptsContainer.js", () => ({
  ConversationDraftSuggestedPromptsContainer: () => null,
}));

vi.mock("@/hooks/useServices.js", () => ({
  useComposerClientNamespace: () => "desktop",
  useOptionalServices: () => null,
  useServices: () => ({
    projectService: {
      resolveSessionDirectories: vi.fn(async (task) => ({
        ...task,
        projectId: null,
        additionalDirectories: [],
      })),
    },
    highspeedCardService: mocks.highspeedCardService,
    modelSelectionService: mocks.modelSelectionService,
    zcodeSessionService: mocks.zcodeSessionService,
    zcodeTaskService: mocks.zcodeTaskService,
  }),
}));

vi.mock("@/lib/composerRecent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/composerRecent.js")>()),
  acceptComposerRecentReceipt: (
    receipt: import("@/lib/composerRecent.js").ComposerRecentReceipt,
  ) => {
    composerRecentMocks.acceptSubmission(receipt);
    return true;
  },
}));

vi.mock("@/v4/composer/useDraftSessionPrewarm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/v4/composer/useDraftSessionPrewarm.js")>();
  return {
    ...actual,
    useDraftSessionPrewarm: (params: Parameters<typeof actual.useDraftSessionPrewarm>[0]) => {
      prewarmHookMock.lastEnabled = params.enabled;
      // Freeze the mock/real branch per mounted instance: mutating the global binding during
      // rerender would change the hook count; the production hook has no such test-double problem.
      const useActual = useRef(prewarmHookMock.binding === undefined).current;
      return useActual
        ? actual.useDraftSessionPrewarm(params)
        : {
            binding: prewarmHookMock.binding
              ? { beginPromotion: () => true, ...prewarmHookMock.binding }
              : null,
            waitForSession: async () => {
              if (!prewarmHookMock.binding)
                throw new Error("Draft session creation failed, please retry");
              return { beginPromotion: () => true, ...prewarmHookMock.binding };
            },
          };
    },
  };
});

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: {
      modelProviderFamilySelectedKeys: { bigmodel: "team-plan-key" },
      zcodeInteractionBehavior: "queue",
    },
    loading: false,
    error: null,
    update: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/telemetry/useSessionOpenArmsTelemetry.js", () => ({
  useSessionOpenArmsTelemetry: (params: { sessionId: string | null; enabled?: boolean }) => {
    sessionOpenTelemetryMock.lastParams = params;
  },
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    layer: mocks.layer,
    sendCommand: mocks.sendCommand,
    attachmentPut: mocks.attachmentPut,
    // SessionPane pulls the journal-fallback run discovery query on mount: a missing stub throws a TypeError in an effect;
    // the stub must be a stable reference — the effect depends on workflowRuns, and a fresh function per render would loop forever.
    workflowRuns: workflowRunsQueryMock,
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/v4/composer/useDraftConfigControl.js")>();
  return {
    ...actual,
    useDraftConfigControl: () => ({
      modelSelectionRead: useModelSelectionServiceView(null),
      captureAcceptedModelSelection: () => vi.fn(),
      composerDraft: { text: "", updatedAt: 0 },
      draftConfig: draftConfigMock.draftConfigRef.current,
      draftConfigRef: draftConfigMock.draftConfigRef,
      draftConfigSeedSignal: 0,
      resolveInitialDraftConfig: draftConfigMock.resolveInitialDraftConfig,
      handleDraftSelectModel: draftConfigMock.handleDraftSelectModel,
      handleDraftSelectThought: draftConfigMock.handleDraftSelectThought,
      handleDraftSwitchMode: draftConfigMock.handleDraftSwitchMode,
      promoteComposerDraft: vi.fn(),
      replaceComposerDraft: vi.fn(),
      updateComposerContent: vi.fn(),
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
  return {
    ConversationHeader: () => React.createElement("div", { "data-testid": "mock-header" }),
  };
});

vi.mock("@/v4/ConversationTimeline.js", async () => {
  const React = await import("react");
  return {
    ConversationTimeline: ({ bottomDock }: { bottomDock?: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "mock-timeline" }, bottomDock),
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
    V4InteractionDialogs: (props: V4InteractionDialogsProps) => {
      captured.interactionProps = props;
      return React.createElement("div", { "data-testid": "mock-interactions" });
    },
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

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const attributes = new Map<string, string>();
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: (name: string) => attributes.get(name) ?? null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: (name: string) => attributes.delete(name),
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: vi.fn((tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    ),
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
  } as unknown as Document;
  const windowMock = {
    addEventListener: vi.fn(),
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
    window: windowMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    Node: windowMock.Node,
  });
  return createMinimalElement(documentMock, "div");
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function ackFor(envelope: CommandEnvelope, patch: Partial<CommandAck>): CommandAck {
  return {
    commandId: envelope.commandId,
    status: "accepted",
    revisionAtDecision: envelope.baseRevision ?? 0,
    ...patch,
  };
}

function makeSnapshot(): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-1",
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
      provider: "primary-provider",
      model: "deepseek-v4-flash",
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
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

function makePlanPendingSnapshot(): ConversationSnapshot {
  const snapshot = makeSnapshot();
  return {
    ...snapshot,
    control: {
      ...snapshot.control,
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "tool",
    },
    pendingInteractions: [
      {
        interactionId: "plan-request-1",
        kind: "userInput",
        anchorRowId: 5,
        createdAt: 300,
        payload: {
          kind: "userInput",
          prompt: "Review this implementation plan.",
          freeText: true,
          toolName: "ExitPlanMode",
          toolCallId: "exit-plan-1",
          questions: [
            {
              question: "Review this implementation plan.",
              header: "Plan",
              options: [{ value: "approve", label: "Approve" }],
            },
          ],
        },
      },
    ],
  };
}

function makeWorkspaceStateSnapshot(): ZCodeWorkspaceStateSnapshot {
  return {
    workspace: {
      workspacePath: "/workspace",
      workspaceIdentity: undefined,
      workspaceKey: "/workspace",
    },
    settings: {
      model: {
        current: { providerId: "alternate-provider", modelId: "deepseek-v4-pro" },
        available: [
          {
            ref: { providerId: "alternate-provider", modelId: "deepseek-v4-pro" },
            label: "DeepSeek V4 Pro",
          },
        ],
      },
      thoughtLevel: {
        enabled: true,
        current: "high",
        available: [{ value: "high", label: "High" }],
      },
      mode: { current: "build" },
    },
    slashCommands: [{ name: "compact", description: "Compact" }],
  };
}

function createPaneElement(props: Partial<ComponentProps<typeof SessionPane>> = {}) {
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "en-US" },
    createElement(SessionPane, {
      paneId: "workspace-main",
      sessionId: "session-1",
      workspacePath: "/workspace",
      ...props,
    }),
  );
}

async function rerenderPane(root: Root, props: Partial<ComponentProps<typeof SessionPane>> = {}) {
  await act(async () => {
    root.render(createPaneElement(props));
    await flushMicrotasks();
  });
}

async function renderPane(props: Partial<ComponentProps<typeof SessionPane>> = {}) {
  // This file mocks the Composer owner. Build the full draft only on the fixture's initial mount;
  // the production Submission helper must not revive a missing fixture from Snapshot/flat aliases.
  const seed = {
    ...projectionState.current?.snapshot?.config,
    ...draftConfigMock.resolveInitialDraftConfig(),
    ...draftConfigMock.draftConfigRef.current,
  };
  draftConfigMock.draftConfigRef.current = {
    ...seed,
    mode: seed.mode ?? "build",
    modelSelection: seed.modelSelection ?? {
      providerId: seed.provider ?? "primary-provider",
      modelId: seed.model ?? "deepseek-v4-flash",
      options: { reasoningLevel: seed.thought || "high" },
    },
  };
  if (!modelSelectionMock.view) {
    modelSelectionMock.view = {
      revision: 1,
      providers: ["primary-provider", "alternate-provider", "e2e-deepseek"].map((providerId) => ({
        providerId,
        config: {},
        models: ["deepseek-v4-flash", "deepseek-v4-pro", "GLM-5.2"].map((modelId) => ({
          modelId,
          config: {
            optionSpecs: {
              reasoningLevel: { values: ["off", "low", "high", "max"], map: "{}" },
            },
          },
        })),
      })),
    } as ModelSelectionView;
  }
  const root: Root = createRoot(installMinimalDom());
  await rerenderPane(root, props);
  return root;
}

afterEach(() => {
  recommendation.mockReset().mockImplementation(async (selection) => selection);
  modelSelectionMock.view = null;
  captured.composerProps = null;
  captured.interactionProps = null;
  draftConfigMock.draftConfigRef.current = {};
  draftConfigMock.resolveInitialDraftConfig.mockReset();
  draftConfigMock.handleDraftSelectModel.mockClear();
  draftConfigMock.handleDraftSelectThought.mockClear();
  draftConfigMock.handleDraftSwitchMode.mockClear();
  prewarmHookMock.binding = undefined;
  prewarmHookMock.lastEnabled = null;
  modelTransitionMock.listener = null;
  modelTransitionMock.onAcquire = null;
  sessionOpenTelemetryMock.lastParams = null;
  projectionState.current = null;
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.modelSelectionService.getView.mockImplementation(async () => ({
    revision: 1,
    providers: [
      {
        providerId: "alternate-provider",
        config: { kind: "api" as const },
        models: [{ modelId: "deepseek-v4-pro", config: {} }],
      },
    ],
  }));
});

describe("SessionPane draft provider readiness", () => {
  it("blocks first send before command dispatch when no model is available", async () => {
    projectionState.current = {
      status: "live",
      snapshot: null,
      subscriptionId: "draft-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    prewarmHookMock.binding = null;
    mocks.modelSelectionService.getView.mockResolvedValue({
      revision: 2,
      providers: [],
    });

    const root = await renderPane({ sessionId: null });
    try {
      expect(prewarmHookMock.lastEnabled).toBe(false);
      expect(captured.composerProps?.error).toMatchObject({
        code: "model_config_missing",
      });

      let result: Awaited<ReturnType<ComposerProps["onSendText"]>>;
      await act(async () => {
        result = await captured.composerProps?.onSendText("keep this draft");
        await flushMicrotasks();
      });

      expect(result!).toBe("blocked");
      expect(mocks.sendCommand).not.toHaveBeenCalled();
      expect(captured.composerProps?.error).toMatchObject({
        code: "model_config_missing",
      });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("settles the recovery ledger when Host wins the readiness race", async () => {
    const prewarmSnapshot = makeSnapshot();
    prewarmSnapshot.sessionId = "draft-prewarm-provider-race";
    projectionState.current = {
      status: "live",
      snapshot: prewarmSnapshot,
      subscriptionId: "draft-race-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: "draft-prewarm-provider-race",
      promote: vi.fn(),
      discard: vi.fn(),
    };
    const providerNotReady = Object.assign(
      new Error("No model provider and model are currently available"),
      {
        code: ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
      },
    );
    mocks.sendCommand.mockRejectedValue(providerNotReady);

    const root = await renderPane({ sessionId: null });
    try {
      let result: Awaited<ReturnType<ComposerProps["onSendText"]>>;
      await act(async () => {
        result = await captured.composerProps?.onSendText("race-safe draft");
        await flushMicrotasks();
      });

      expect(result!).toBe("blocked");
      expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
      expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
        sessionId: "draft-prewarm-provider-race",
        type: "sendText",
      });
      expect(pendingCommandRegistry.list("draft-prewarm-provider-race")).toHaveLength(0);
      expect(captured.composerProps?.error).toMatchObject({
        code: "model_config_missing",
      });
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("SessionPane send failure feedback", () => {
  it("surfaces provider.notInRegistry as a visible composer error", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "session-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockRejectedValue(
      new Error(
        "switchModelConfig did not settle before first send: failed provider.notInRegistry",
      ),
    );

    const root = await renderPane();
    try {
      await expect(
        act(async () => captured.composerProps?.onSendText("keep visible draft")),
      ).rejects.toThrow("provider.notInRegistry");
      await act(async () => flushMicrotasks());

      expect(captured.composerProps?.error).toMatchObject({
        code: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
        detail: expect.stringContaining("provider.notInRegistry"),
      });
      await act(async () => {
        captured.composerProps?.onDismissError?.();
        await flushMicrotasks();
      });
      expect(captured.composerProps?.error).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("SessionPane draft prewarm admission lifecycle", () => {
  it("only records session-open telemetry for existing sessions, not the first prewarm promotion binding", async () => {
    const prewarmSessionId = "draft-prewarm-session-open-excluded";
    const existingSessionId = "existing-session-open-included";
    const prewarmSnapshot = makeSnapshot();
    prewarmSnapshot.sessionId = prewarmSessionId;
    projectionState.current = {
      status: "live",
      snapshot: prewarmSnapshot,
      subscriptionId: "draft-prewarm-session-open-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: prewarmSessionId,
      promote: vi.fn(),
      discard: vi.fn(),
    };
    const onSessionCreated = vi.fn();
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane({ sessionId: null, onSessionCreated });
    try {
      await act(async () => {
        await captured.composerProps?.onSendText("promote prewarm without session-open telemetry");
        await flushMicrotasks();
      });
      expect(onSessionCreated).toHaveBeenCalledWith(prewarmSessionId);

      await rerenderPane(root, { sessionId: prewarmSessionId, onSessionCreated });
      expect(sessionOpenTelemetryMock.lastParams).toMatchObject({
        sessionId: prewarmSessionId,
        enabled: false,
      });

      const existingSnapshot = makeSnapshot();
      existingSnapshot.sessionId = existingSessionId;
      projectionState.current = {
        ...projectionState.current,
        snapshot: existingSnapshot,
        subscriptionId: "existing-session-open-subscription",
      };
      prewarmHookMock.binding = null;
      await rerenderPane(root, { sessionId: existingSessionId, onSessionCreated });
      expect(sessionOpenTelemetryMock.lastParams).toMatchObject({
        sessionId: existingSessionId,
        enabled: true,
      });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each(["existing", "prewarm", "no-prewarm"] as const)(
    "keeps shared context and the complete submission together for %s",
    async (entry) => {
      const targetSessionId = entry === "existing" ? "session-1" : "share-created";
      const snapshot = makeSnapshot();
      snapshot.sessionId = targetSessionId;
      projectionState.current = {
        status: "live",
        snapshot: entry === "no-prewarm" ? null : snapshot,
        subscriptionId: "share-submission",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      prewarmHookMock.binding =
        entry === "prewarm"
          ? {
              workspaceKey: "/workspace",
              sessionId: targetSessionId,
              promote: vi.fn(),
              discard: vi.fn(),
            }
          : entry === "no-prewarm"
            ? undefined
            : null;
      const modelSelection = {
        providerId: "alternate-provider",
        modelId: "deepseek-v4-pro",
        options: { reasoningLevel: "high" },
      };
      draftConfigMock.draftConfigRef.current = { modelSelection, mode: "build" };
      mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
        ackFor(envelope, {
          status: "accepted",
          ...(envelope.type === "createSession"
            ? { result: { type: "createSession" as const, sessionId: targetSessionId } }
            : {}),
        }),
      );
      const root = await renderPane({ sessionId: entry === "existing" ? targetSessionId : null });
      try {
        await act(async () => {
          await captured.composerProps?.onSendText("continue sharing context", {
            sharedContextRefs: [{ kind: "shared_context_import", context_id: "shared-1" }],
          });
          await flushMicrotasks();
        });
        const sends = mocks.sendCommand.mock.calls.filter(
          ([command]) => command.type === "sendText",
        );
        expect(sends).toHaveLength(1);
        expect(sends[0]?.[0]).toMatchObject({
          sessionId: targetSessionId,
          payload: {
            text: "continue sharing context",
            modelSelection,
            mode: "build",
            context_refs: [{ kind: "shared_context_import", context_id: "shared-1" }],
          },
        });
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it("does not record the first binding for a first send while prewarm has no projection yet", async () => {
    const createdSessionId = "fallback-created-session-open-excluded";
    projectionState.current = {
      status: "live",
      snapshot: null,
      subscriptionId: "draft-without-prewarm-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    prewarmHookMock.binding = undefined;
    // The first send always reuses the prewarm-created session; without a projection it still must not be recorded as an existing-task open.
    draftConfigMock.resolveInitialDraftConfig.mockReturnValue({
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
      mode: "build",
    });
    const onSessionCreated = vi.fn();
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, {
        status: "accepted",
        ...(envelope.type === "createSession"
          ? { result: { type: "createSession" as const, sessionId: createdSessionId } }
          : {}),
      }),
    );

    const root = await renderPane({ sessionId: null, onSessionCreated });
    try {
      await act(async () => {
        await captured.composerProps?.onSendText("create without prewarm telemetry");
        await flushMicrotasks();
      });
      expect(onSessionCreated).toHaveBeenCalledWith(createdSessionId);

      const createdSnapshot = makeSnapshot();
      createdSnapshot.sessionId = createdSessionId;
      projectionState.current = {
        ...projectionState.current,
        snapshot: createdSnapshot,
        subscriptionId: "fallback-created-session-open-subscription",
      };
      await rerenderPane(root, { sessionId: createdSessionId, onSessionCreated });
      expect(sessionOpenTelemetryMock.lastParams).toMatchObject({
        sessionId: createdSessionId,
        enabled: false,
      });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([
    {
      caseName: "transport outcome is unknown",
      expectedError: "connection closed after command write",
      sendResult: "transport-error" as const,
    },
    {
      caseName: "projection commit timed out after runtime admission",
      expectedError: "fault.projectionEventCommit.timeout",
      sendResult: "failed-ack" as const,
    },
  ])(
    "does not resubmit first input when the prewarm sendText $caseName",
    async ({ expectedError, sendResult }) => {
      const prewarmSessionId = "draft-prewarm-unknown-send";
      const fallbackSessionId = "draft-prewarm-unknown-send-fallback";
      const prewarmSnapshot = makeSnapshot();
      prewarmSnapshot.sessionId = prewarmSessionId;
      projectionState.current = {
        status: "live",
        snapshot: prewarmSnapshot,
        subscriptionId: "draft-prewarm-unknown-send-subscription",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      const onSessionCreated = vi.fn();
      const discard = vi.fn();
      let unknownSendEnvelope: CommandEnvelope | null = null;
      prewarmHookMock.binding = {
        workspaceKey: "/workspace",
        sessionId: prewarmSessionId,
        promote: vi.fn(),
        discard,
      };
      mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => {
        if (envelope.type === "sendText") {
          unknownSendEnvelope = envelope;
          if (sendResult === "failed-ack") {
            return ackFor(envelope, {
              status: "failed",
              reasonCode: "fault.projectionEventCommit.timeout",
            });
          }
          // Bug reproduction: whether the write reached the Agent is unknown; a transport error does not prove the command was not admitted.
          throw new Error("connection closed after command write");
        }
        if (envelope.type === "createSession") {
          return ackFor(envelope, {
            result: { type: "createSession", sessionId: fallbackSessionId },
          });
        }
        return ackFor(envelope, { status: "accepted" });
      });

      const root = await renderPane({ sessionId: null, onSessionCreated });
      try {
        let sendError: unknown;
        await act(async () => {
          try {
            await captured.composerProps?.onSendText("must execute exactly once");
          } catch (error) {
            sendError = error;
          }
          await flushMicrotasks();
        });

        expect(sendError).toMatchObject({
          message: expectedError,
        });
        expect(unknownSendEnvelope).toMatchObject({
          sessionId: prewarmSessionId,
          type: "sendText",
        });
        expect(
          mocks.sendCommand.mock.calls.filter(
            ([envelope]) => (envelope as CommandEnvelope).type === "createSession",
          ),
        ).toHaveLength(0);
        expect(discard).not.toHaveBeenCalled();
        expect(onSessionCreated).not.toHaveBeenCalled();
      } finally {
        if (unknownSendEnvelope) {
          await act(async () => {
            pendingCommandRegistry.settle(
              prewarmSessionId,
              (unknownSendEnvelope as CommandEnvelope).commandId,
            );
            await flushMicrotasks();
          });
        }
        await act(async () => root.unmount());
      }
    },
  );

  it("does not resubmit a draft slash command when its transport outcome is unknown", async () => {
    const prewarmSessionId = "draft-prewarm-unknown-slash";
    const fallbackSessionId = "draft-prewarm-unknown-slash-fallback";
    const prewarmSnapshot = makeSnapshot();
    prewarmSnapshot.sessionId = prewarmSessionId;
    projectionState.current = {
      status: "live",
      snapshot: prewarmSnapshot,
      subscriptionId: "draft-prewarm-unknown-slash-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const onSessionCreated = vi.fn();
    const discard = vi.fn();
    let unknownSlashEnvelope: CommandEnvelope | null = null;
    let slashAttempts = 0;
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: prewarmSessionId,
      promote: vi.fn(),
      discard,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => {
      if (envelope.type === "sendGoalCommand") {
        slashAttempts += 1;
        if (slashAttempts === 1) {
          unknownSlashEnvelope = envelope;
          throw new Error("connection closed after slash command write");
        }
        return ackFor(envelope, { status: "accepted" });
      }
      if (envelope.type === "createSession") {
        return ackFor(envelope, {
          result: { type: "createSession", sessionId: fallbackSessionId },
        });
      }
      return ackFor(envelope, { status: "accepted" });
    });

    const root = await renderPane({ sessionId: null, onSessionCreated });
    try {
      let sendError: unknown;
      await act(async () => {
        try {
          await captured.composerProps?.onSendText("/goal ship once");
        } catch (error) {
          sendError = error;
        }
        await flushMicrotasks();
      });

      expect(sendError).toMatchObject({
        message: "connection closed after slash command write",
      });
      expect(slashAttempts).toBe(1);
      expect(
        mocks.sendCommand.mock.calls.filter(
          ([envelope]) => (envelope as CommandEnvelope).type === "createSession",
        ),
      ).toHaveLength(0);
      expect(discard).not.toHaveBeenCalled();
      expect(onSessionCreated).not.toHaveBeenCalled();
    } finally {
      if (unknownSlashEnvelope) {
        await act(async () => {
          pendingCommandRegistry.settle(
            prewarmSessionId,
            (unknownSlashEnvelope as CommandEnvelope).commandId,
          );
          await flushMicrotasks();
        });
      }
      await act(async () => root.unmount());
    }
  });

  it("keeps an admitted prewarm session alive while the sendText ACK is pending", async () => {
    const prewarmSessionId = "draft-prewarm-send-pending";
    const prewarmSnapshot = makeSnapshot();
    prewarmSnapshot.sessionId = prewarmSessionId;
    projectionState.current = {
      status: "live",
      snapshot: prewarmSnapshot,
      subscriptionId: "draft-prewarm-send-pending-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    let resolveSendText!: (ack: CommandAck) => void;
    let pendingSendEnvelope: CommandEnvelope | null = null;
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => {
      if (envelope.type === "createSession") {
        return ackFor(envelope, {
          result: { type: "createSession", sessionId: prewarmSessionId },
        });
      }
      if (envelope.type === "sendText") {
        pendingSendEnvelope = envelope;
        return await new Promise<CommandAck>((resolve) => {
          resolveSendText = resolve;
        });
      }
      return ackFor(envelope, { status: "accepted" });
    });

    const root = await renderPane({ sessionId: null });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(
      mocks.sendCommand.mock.calls.some(
        ([envelope]) => (envelope as CommandEnvelope).type === "createSession",
      ),
    ).toBe(true);

    let sendPromise!: ReturnType<ComposerProps["onSendText"]>;
    act(() => {
      sendPromise = captured.composerProps!.onSendText("first input while MCP is starting");
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(pendingSendEnvelope).toMatchObject({
      sessionId: prewarmSessionId,
      type: "sendText",
    });

    // Bug reproduction: the Agent already admitted the first input, but MCP initialization keeps the renderer ACK in flight.
    // Pane/owner cleanup must not delete the running prewarm session as an unused draft at this point.
    await act(async () => {
      root.unmount();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await flushMicrotasks();
    });

    resolveSendText(ackFor(pendingSendEnvelope!, { status: "accepted" }));
    await act(async () => {
      await sendPromise;
      await flushMicrotasks();
    });

    expect(
      mocks.sendCommand.mock.calls.filter(
        ([envelope]) => (envelope as CommandEnvelope).type === "deleteSession",
      ),
    ).toHaveLength(0);
  });
});

describe("SessionPane stop foreground execution", () => {
  it.each([
    "button",
    "escape",
    "escape-outside",
    "escape-dialog",
    "escape-consumed",
    "fallback-outside",
    "fallback-dialog",
    "fallback-consumed",
  ] as const)(
    "routes %s by keyboard ownership and preserves the goal verifier execution id",
    async (source) => {
      const infoSpy = vi.spyOn(logger.lifecycle, "info");
      const running = makeSnapshot();
      running.control = {
        ...running.control,
        phase: "running",
        sessionEnded: false,
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: "goalVerifier",
        activeWorks: [
          {
            kind: "goalVerifier",
            foregroundExecutionId: "foreground-1",
            startedAt: 10,
          },
        ],
      };
      projectionState.current = {
        status: "live",
        snapshot: running,
        subscriptionId: "sub-1",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
        ackFor(envelope, { status: "accepted" }),
      );

      const root = await renderPane({ allowEscapeStopOutsidePane: source.startsWith("fallback-") });
      await act(async () => {
        if (source === "button") {
          captured.composerProps?.onStop?.();
        } else {
          const listener = vi
            .mocked(window.addEventListener)
            .mock.calls.find(([type]) => type === "keydown")?.[1] as (event: KeyboardEvent) => void;
          const paneElement = vi
            .mocked(document.createElement)
            .mock.results.map((result) => result.value as Element)
            .find(
              (element) => element.getAttribute("data-testid") === "v4-session-pane-workspace-main",
            );
          expect(paneElement).toBeDefined();
          listener({
            key: "Escape",
            defaultPrevented: source.endsWith("consumed"),
            composedPath: () =>
              source.endsWith("outside")
                ? [document]
                : [
                    paneElement,
                    ...(source.endsWith("dialog") ? [{ dataset: { slot: "dialog-content" } }] : []),
                  ],
            preventDefault: vi.fn(),
          } as unknown as KeyboardEvent);
        }
        await flushMicrotasks();
      });

      if (source !== "button" && source !== "escape" && source !== "fallback-outside") {
        expect(mocks.sendCommand).not.toHaveBeenCalled();
        await act(async () => root.unmount());
        return;
      }
      expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
      expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
        type: "stop",
        payload: { expectedForegroundExecutionId: "foreground-1" },
      });
      // Plain info is disabled in production; stop attribution must go through the lifecycle channel and keep the execution id to avoid stopping the wrong run.
      expect(infoSpy).toHaveBeenCalledWith("[v4-pane] stop 命令发出", {
        source: source === "button" ? "button" : "escape",
        sessionId: "session-1",
        foregroundExecutionId: "foreground-1",
      });
      await act(async () => {
        root.unmount();
      });
    },
  );

  it("records a skipped button stop without dispatching for an idle session", async () => {
    const infoSpy = vi.spyOn(logger.lifecycle, "info");
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-idle",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root = await renderPane();
    try {
      await act(async () => {
        captured.composerProps?.onStop?.();
        await flushMicrotasks();
      });
      expect(mocks.sendCommand).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith("[v4-pane] stop 命令被跳过（无可停执行）", {
        source: "button",
        sessionId: "session-1",
      });
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("SessionPane remote provider admission", () => {
  it("sends the model command directly after a desktop remote runtime rebuild; the remote registry recovers itself", async () => {
    const workspaceIdentity = "remote:ssh:dev:/workspace";
    const remoteSessionId = "remote-session-stable";
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "remote-provider-recovery-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );
    mocks.zcodeSessionService.updateProviderRegistry.mockClear();
    mocks.sendCommand.mockClear();

    const root = await renderPane({ workspaceIdentity, remoteSessionId });
    try {
      await act(async () => {
        await captured.composerProps?.onSendText("recover remote runtime");
        await flushMicrotasks();
      });

      expect(mocks.zcodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
      expect(mocks.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "sendText" }));
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("local desktop workspace does not trigger remote provider registry sync", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "local-provider-admission-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );
    mocks.zcodeSessionService.updateProviderRegistry.mockClear();

    const root = await renderPane();
    try {
      await act(async () => {
        await captured.composerProps?.onSendText("local project remains local");
        await flushMicrotasks();
      });

      expect(mocks.zcodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
      expect(mocks.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "sendText" }));
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("mobile web remote replayable pane does not reuse the desktop provider preflight", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "mobile-provider-admission-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );
    mocks.zcodeSessionService.updateProviderRegistry.mockClear();

    const root = await renderPane({
      workspaceIdentity: "remote:ssh:dev:/workspace",
      remoteSessionId: "remote-session-mobile",
      compactForRemoteControl: true,
    });
    try {
      await act(async () => {
        await captured.composerProps?.onSendText("mobile remote command");
        await flushMicrotasks();
      });

      expect(mocks.zcodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
      expect(mocks.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "sendText" }));
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("SessionPane mobile plan approval recovery", () => {
  it("recovers authoritative state when an accepted mobile plan interaction stays pending", async () => {
    vi.useFakeTimers();
    projectionState.current = {
      status: "live",
      snapshot: makePlanPendingSnapshot(),
      subscriptionId: "mobile-plan-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    const root = await renderPane({ compactForRemoteControl: true });
    try {
      act(() => {
        captured.interactionProps?.onPlanInteractionAccepted?.("plan-request-1");
        captured.interactionProps?.onPlanInteractionAccepted?.("plan-request-1");
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(mocks.recoverFromStaleAuthority).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.recoverFromStaleAuthority).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("skips recovery when the mobile plan interaction clears during the grace window", async () => {
    vi.useFakeTimers();
    projectionState.current = {
      status: "live",
      snapshot: makePlanPendingSnapshot(),
      subscriptionId: "mobile-plan-natural-clear-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    const root = await renderPane({ compactForRemoteControl: true });
    try {
      act(() => {
        captured.interactionProps?.onPlanInteractionAccepted?.("plan-request-1");
      });
      projectionState.current = {
        ...projectionState.current,
        snapshot: {
          ...projectionState.current.snapshot!,
          pendingInteractions: [],
        },
      };

      await vi.advanceTimersByTimeAsync(500);
      expect(mocks.recoverFromStaleAuthority).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("does not register plan reconciliation for desktop continuous panes", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makePlanPendingSnapshot(),
      subscriptionId: "desktop-plan-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    const root = await renderPane({ compactForRemoteControl: false });
    try {
      expect(captured.interactionProps?.onPlanInteractionAccepted).toBeUndefined();
      expect(mocks.recoverFromStaleAuthority).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("SessionPane model switch recovery", () => {
  it("does not lose an online fallback between lease acquisition and listener registration", async () => {
    seedModelProviderNames();
    const fallbackSnapshot = makeSnapshot();
    fallbackSnapshot.config = {
      ...fallbackSnapshot.config,
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
      thought: "high",
    };
    projectionState.current = {
      status: "live",
      snapshot: fallbackSnapshot,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const transition: SessionModelTransition = {
      eventId: "fallback-before-next-effect",
      origin: "registryFallback",
      from: {
        provider: "primary-provider",
        model: "deepseek-v4-flash",
      },
      to: {
        provider: "alternate-provider",
        model: "deepseek-v4-pro",
      },
    };
    modelTransitionMock.onAcquire = () => {
      queueMicrotask(() => modelTransitionMock.listener?.(transition));
    };

    // act would flush the next effect round before that microtask, hiding the listener gap in production scheduling.
    const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    const root = createRoot(installMinimalDom());
    try {
      root.render(createPaneElement());
      // React scheduling can exceed 20ms under parallel tests; wait for the observable result instead of flushing effects with act.
      await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
      // An automatic fallback only corrects the current execution fact; App Recent may only be written by an accepted ordinary Submission.
      expect(composerRecentMocks.acceptSubmission).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  it("I56: a focused pane automatic fallback reuses the manual switch toast; background panes stay silent", async () => {
    seedModelProviderNames();
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    const transition: SessionModelTransition = {
      eventId: "event-fallback",
      origin: "registryFallback",
      from: { provider: "primary-provider", model: "deepseek-v4-flash" },
      to: { provider: "alternate-provider", model: "deepseek-v4-pro" },
    };
    const root = await renderPane();
    try {
      await act(async () => {
        modelTransitionMock.listener?.(transition);
        await flushMicrotasks();
      });
      expect(mocks.toast).toHaveBeenCalledWith(
        expectedCopy("chat.modelChangeNotice.changed", {
          fromModel: "Primary Coding Plan/deepseek-v4-flash",
          toModel: "Alternate API/deepseek-v4-pro",
        }),
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
    }

    mocks.toast.mockClear();
    modelTransitionMock.listener = null;
    const backgroundRoot = await renderPane({ focused: false });
    try {
      await act(async () => {
        modelTransitionMock.listener?.(transition);
        await flushMicrotasks();
      });
      expect(mocks.toast).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        backgroundRoot.unmount();
      });
    }
  });

  it("Highspeed turn still invalidates the card and unlocks the Composer when the fallback model is also unavailable", async () => {
    const now = Date.now();
    const snapshot = makeSnapshot();
    snapshot.control = {
      ...snapshot.control,
      phase: "error",
      sessionEnded: false,
      lastError: {
        code: "provider_not_found",
        message: "original model is currently unavailable",
        recoverable: true,
        at: now,
        source: "provider",
        traceId: "trace-fallback-unavailable",
        attribution: {
          source: "provider",
          highspeedCardId: "hsc-fallback-unavailable",
          highspeedFallbackUnavailable: true,
        },
      },
    };
    // There is no userInput row yet during model creation; the cardId in the error fact must still unlock the Composer.
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-highspeed-fallback-unavailable",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.highspeedCardService.getSnapshot.mockResolvedValueOnce({
      card: {
        cardId: "hsc-fallback-unavailable",
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: now - 60_000,
        expiresAt: now + 60_000,
      },
      nextDrawAt: now + 3_600_000,
      drawing: false,
    });

    const root = await renderPane();
    try {
      await act(async () => {
        await flushMicrotasks();
      });
      expect(mocks.highspeedCardService.invalidateCard).toHaveBeenCalledWith(
        "hsc-fallback-unavailable",
      );
      expect(captured.composerProps?.highspeedCard).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("Highspeed invalidates the card by Core attribution and unlocks the model picker when the request fails with nowhere to fall back", async () => {
    // Root cause: request-phase 3402/network failures emit no fallback event and the TurnError code is the provider error code "3402";
    // the old implementation only trusted a catalog-error allowlist, so the card kept the picker locked and the failed card was reused next turn.
    // Invalidation follows only the Core-published highspeedFallbackUnavailable fact (spec §2.2); the original error stays in the banner.
    const now = Date.now();
    const snapshot = makeSnapshot();
    snapshot.control = {
      ...snapshot.control,
      phase: "error",
      sessionEnded: false,
      lastError: {
        code: "3402",
        message: "highspeed card is invalid",
        recoverable: true,
        at: now,
        source: "provider",
        traceId: "trace-request-fallback-unavailable",
        attribution: {
          source: "provider",
          providerId: "account:bigmodel-highspeed-card",
          providerErrorCode: "3402",
          statusCode: 400,
          highspeedCardId: "hsc-request-unavailable",
          highspeedFallbackUnavailable: true,
        },
      },
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-highspeed-request-unavailable",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.highspeedCardService.getSnapshot.mockResolvedValueOnce({
      card: {
        cardId: "hsc-request-unavailable",
        taskId: "session-1",
        provider: "builtin:bigmodel-coding-plan",
        model: "GLM-5.3",
        issuedAt: now - 60_000,
        expiresAt: now + 60_000,
      },
      nextDrawAt: now + 3_600_000,
      drawing: false,
    });

    const root = await renderPane();
    try {
      await act(async () => {
        await flushMicrotasks();
      });
      expect(mocks.highspeedCardService.invalidateCard).toHaveBeenCalledWith(
        "hsc-request-unavailable",
      );
      expect(captured.composerProps?.highspeedCard).toBeNull();
      // After the card is invalidated the picker is usable: model switching is no longer blocked by "Model is locked while Highspeed is active".
      await act(async () => {
        captured.composerProps?.onSelectModel?.("alternate-provider", "deepseek-v4-pro", null);
        await flushMicrotasks();
      });
      expect(mocks.toast).not.toHaveBeenCalledWith(expectedCopy("chat.highspeed.modelLocked"));
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("does not clear the card when the error is attributed to the current card but Core has not judged there is nowhere to fall back", async () => {
    // Context overflow and local runtime failures do not participate in fallback; Core does not publish highspeedFallbackUnavailable.
    // The renderer must not infer from error codes on its own, or it would invalidate cards that should be kept.
    const now = Date.now();
    const snapshot = makeSnapshot();
    snapshot.control = {
      ...snapshot.control,
      phase: "error",
      sessionEnded: false,
      lastError: {
        code: "context_exceeded",
        message: "Model request exceeded the provider context window.",
        recoverable: true,
        at: now,
        source: "provider",
        traceId: "trace-context-exceeded-with-card",
        attribution: {
          source: "provider",
          providerId: "account:bigmodel-highspeed-card",
          highspeedCardId: "hsc-context-exceeded",
        },
      },
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-highspeed-context-exceeded",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.highspeedCardService.getSnapshot.mockResolvedValueOnce({
      card: {
        cardId: "hsc-context-exceeded",
        taskId: "session-1",
        provider: "builtin:bigmodel-coding-plan",
        model: "GLM-5.3",
        issuedAt: now - 60_000,
        expiresAt: now + 60_000,
      },
      nextDrawAt: now + 3_600_000,
      drawing: false,
    });

    const root = await renderPane();
    try {
      await act(async () => {
        await flushMicrotasks();
      });
      expect(mocks.highspeedCardService.invalidateCard).not.toHaveBeenCalled();
      expect(captured.composerProps?.highspeedCard?.cardId).toBe("hsc-context-exceeded");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("an ordinary turn catalog error while a Highspeed card is held does not clear the unrelated valid card", async () => {
    // spec §2.2 error attribution: an ordinary turn explicitly publishes null (registry changed after queueing, before execution);
    // its catalog error must not consume unrelated acceleration credit.
    const now = Date.now();
    const snapshot = makeSnapshot();
    snapshot.control = {
      ...snapshot.control,
      phase: "error",
      sessionEnded: false,
      lastError: {
        code: "provider_not_found",
        message: "queued ordinary turn model unavailable",
        recoverable: true,
        at: now,
        source: "provider",
        traceId: "trace-ordinary-catalog-error",
        attribution: { source: "provider", highspeedCardId: null },
      },
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-highspeed-ordinary-error",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.highspeedCardService.getSnapshot.mockResolvedValueOnce({
      card: {
        cardId: "hsc-unrelated-valid",
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: now - 60_000,
        expiresAt: now + 60_000,
      },
      nextDrawAt: now + 3_600_000,
      drawing: false,
    });

    const root = await renderPane();
    try {
      await act(async () => {
        await flushMicrotasks();
      });
      expect(mocks.highspeedCardService.invalidateCard).not.toHaveBeenCalled();
      expect(captured.composerProps?.highspeedCard?.cardId).toBe("hsc-unrelated-valid");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("a catalog error attributed to an old card does not clear the current card", async () => {
    // The failed input used the previous card; a lingering error must not clear the newly drawn card even if the error timestamp is later than the new card issue time.
    const now = Date.now();
    const snapshot = makeSnapshot();
    snapshot.control = {
      ...snapshot.control,
      phase: "error",
      sessionEnded: false,
      lastError: {
        code: "model_not_found",
        message: "previous card accelerated model unavailable",
        recoverable: true,
        at: now,
        source: "provider",
        traceId: "trace-old-card-error",
        attribution: { source: "provider", highspeedCardId: "hsc-previous-card" },
      },
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-highspeed-old-card-error",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.highspeedCardService.getSnapshot.mockResolvedValueOnce({
      card: {
        cardId: "hsc-current-card",
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: now - 1_000,
        expiresAt: now + 60_000,
      },
      nextDrawAt: now + 3_600_000,
      drawing: false,
    });

    const root = await renderPane();
    try {
      await act(async () => {
        await flushMicrotasks();
      });
      expect(mocks.highspeedCardService.invalidateCard).not.toHaveBeenCalled();
      expect(captured.composerProps?.highspeedCard?.cardId).toBe("hsc-current-card");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("falls back to the time-lower-bound compat path when the Highspeed lastError has no highspeedCardId", async () => {
    // Old-Agent compat: when the error terminal state lacks card attribution fields, fall back to conservative behavior — a catalog error after card issuance still clears and unlocks.
    const now = Date.now();
    const snapshot = makeSnapshot();
    snapshot.control = {
      ...snapshot.control,
      phase: "error",
      sessionEnded: false,
      lastError: {
        code: "provider_not_found",
        message: "original model is currently unavailable",
        recoverable: true,
        at: now,
        source: "provider",
        traceId: "trace-legacy-no-input-id",
      },
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-highspeed-legacy-error",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.highspeedCardService.getSnapshot.mockResolvedValueOnce({
      card: {
        cardId: "hsc-legacy-compat",
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: now - 60_000,
        expiresAt: now + 60_000,
      },
      nextDrawAt: now + 3_600_000,
      drawing: false,
    });

    const root = await renderPane();
    try {
      await act(async () => {
        await flushMicrotasks();
      });
      expect(mocks.highspeedCardService.invalidateCard).toHaveBeenCalledWith("hsc-legacy-compat");
      expect(captured.composerProps?.highspeedCard).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("does not clear a freshly drawn card when an old catalog error predates the card issuance time", async () => {
    // Time lower bound of the spec §2.2 compat path (no highspeedCardId): the error terminal state stays in the projection until the next turn starts,
    // while the card draw happens before the send; the previous turn catalog error must not clear the freshly drawn card (the claim key contains the new cardId, so dedupe does not help).
    const now = Date.now();
    const snapshot = makeSnapshot();
    snapshot.control = {
      ...snapshot.control,
      phase: "error",
      sessionEnded: false,
      lastError: {
        code: "provider_not_found",
        message: "previous turn original model unavailable",
        recoverable: true,
        at: now - 120_000,
        source: "provider",
        traceId: "trace-stale-catalog-error",
      },
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-highspeed-stale-error",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.highspeedCardService.getSnapshot.mockResolvedValueOnce({
      card: {
        cardId: "hsc-fresh-after-stale-error",
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: now - 1_000,
        expiresAt: now + 60_000,
      },
      nextDrawAt: now + 3_600_000,
      drawing: false,
    });

    const root = await renderPane();
    try {
      await act(async () => {
        await flushMicrotasks();
      });
      expect(mocks.highspeedCardService.invalidateCard).not.toHaveBeenCalled();
      expect(captured.composerProps?.highspeedCard?.cardId).toBe("hsc-fresh-after-stale-error");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("non-model errors while a Highspeed card is held do not wrongly invalidate the card", async () => {
    const snapshot = makeSnapshot();
    snapshot.control = {
      ...snapshot.control,
      phase: "error",
      sessionEnded: false,
      lastError: {
        code: "fault.runtime.toolFailed",
        message: "tool execution failed",
        recoverable: true,
        at: Date.now(),
        source: "tool",
        traceId: "trace-unrelated-tool-error",
      },
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-highspeed-unrelated-error",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.highspeedCardService.getSnapshot.mockResolvedValueOnce({
      card: {
        cardId: "hsc-unrelated-error",
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: Date.now() - 60_000,
        expiresAt: Date.now() + 60_000,
      },
      nextDrawAt: Date.now() + 3_600_000,
      drawing: false,
    });

    const root = await renderPane();
    try {
      await act(async () => {
        await flushMicrotasks();
      });
      expect(mocks.highspeedCardService.invalidateCard).not.toHaveBeenCalled();
      expect(captured.composerProps?.highspeedCard?.cardId).toBe("hsc-unrelated-error");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("Highspeed fallback rows pick toast copy by fallbackReason; legacy data without a reason is treated as card expiry", async () => {
    // docs/highspeed/highspeed-card-spec.md §2.2: card expiry and Highspeed unavailability are announced separately, at most once per turn.
    const fallbackAt = Date.now();
    const highspeedRow = (
      sourceCommandId: string,
      fallbackReason:
        | "highspeed_card_expired"
        | "highspeed_request_failed"
        | "highspeed_selection_unavailable"
        | undefined,
    ): ConversationSnapshot["rows"]["window"][number] => ({
      rowId: 1,
      turnId: "turn-1",
      createdAt: fallbackAt - 1_000,
      createdAtSeq: 1,
      kind: "userInput",
      text: "accelerated prompt",
      origin: "realUser",
      sourceCommandId,
      highspeed: {
        schemaVersion: 1,
        cardId: "hsc-1",
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: fallbackAt - 60_000,
        expiresAt: fallbackAt + 60_000,
        fallbackAt,
        ...(fallbackReason ? { fallbackReason } : {}),
      },
    });
    const renderWithRow = async (
      row: ConversationSnapshot["rows"]["window"][number],
    ): Promise<Root> => {
      const snapshot = makeSnapshot();
      projectionState.current = {
        status: "live",
        snapshot: { ...snapshot, rows: { window: [row], totalCount: 1, firstRowId: 1 } },
        subscriptionId: "sub-1",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      return renderPane();
    };

    mocks.highspeedCardService.getSnapshot.mockResolvedValueOnce({
      card: {
        cardId: "hsc-1",
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: fallbackAt - 60_000,
        expiresAt: fallbackAt + 60_000,
      },
      nextDrawAt: fallbackAt + 3_600_000,
      drawing: false,
    });
    const failedRoot = await renderWithRow(
      highspeedRow("command-hs-request-failed", "highspeed_request_failed"),
    );
    try {
      await act(async () => {
        await flushMicrotasks();
      });
      expect(mocks.highspeedCardService.invalidateCard).toHaveBeenCalledWith("hsc-1");
      expect(captured.composerProps?.highspeedCard).toBeNull();
      expect(mocks.toast).toHaveBeenCalledTimes(1);
      expect(mocks.toast).toHaveBeenCalledWith(
        expectedCopy("chat.highspeed.requestFailedFallback"),
      );
    } finally {
      await act(async () => {
        failedRoot.unmount();
      });
    }

    mocks.toast.mockClear();
    mocks.highspeedCardService.invalidateCard.mockClear();
    mocks.highspeedCardService.getSnapshot.mockResolvedValueOnce({
      card: {
        cardId: "hsc-1",
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: fallbackAt - 60_000,
        expiresAt: fallbackAt + 60_000,
      },
      nextDrawAt: fallbackAt + 3_600_000,
      drawing: false,
    });
    const unavailableRoot = await renderWithRow(
      highspeedRow("command-hs-selection-unavailable", "highspeed_selection_unavailable"),
    );
    try {
      await act(async () => {
        await flushMicrotasks();
      });
      expect(mocks.highspeedCardService.invalidateCard).toHaveBeenCalledWith("hsc-1");
      expect(captured.composerProps?.highspeedCard).toBeNull();
      expect(mocks.toast).toHaveBeenCalledWith(
        expectedCopy("chat.highspeed.requestFailedFallback"),
      );
    } finally {
      await act(async () => {
        unavailableRoot.unmount();
      });
    }

    mocks.toast.mockClear();
    mocks.highspeedCardService.invalidateCard.mockClear();
    mocks.highspeedCardService.getSnapshot.mockResolvedValueOnce({
      card: {
        cardId: "hsc-1",
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: fallbackAt - 60_000,
        expiresAt: fallbackAt + 60_000,
      },
      nextDrawAt: fallbackAt + 3_600_000,
      drawing: false,
    });
    const expiredRoot = await renderWithRow(
      highspeedRow("command-hs-card-expired", "highspeed_card_expired"),
    );
    try {
      await act(async () => {
        await flushMicrotasks();
      });
      expect(mocks.highspeedCardService.invalidateCard).toHaveBeenCalledWith("hsc-1");
      expect(captured.composerProps?.highspeedCard).toBeNull();
      expect(mocks.toast).toHaveBeenCalledWith(expectedCopy("chat.highspeed.cardExpiredFallback"));
    } finally {
      await act(async () => {
        expiredRoot.unmount();
      });
    }

    mocks.toast.mockClear();
    const legacyRoot = await renderWithRow(highspeedRow("command-hs-legacy", undefined));
    try {
      expect(mocks.toast).toHaveBeenCalledWith(expectedCopy("chat.highspeed.cardExpiredFallback"));
    } finally {
      await act(async () => {
        legacyRoot.unmount();
      });
    }

    // Remounting with the same sourceCommandId does not toast again (module-level claim).
    mocks.toast.mockClear();
    const remountRoot = await renderWithRow(highspeedRow("command-hs-legacy", undefined));
    try {
      expect(mocks.toast).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        remountRoot.unmount();
      });
    }
  });

  it.each([
    {
      name: "history row belongs to an old card",
      compactForRemoteControl: false,
      rowCardId: "hsc-history-old",
      activeCardId: "hsc-current",
    },
    {
      name: "mobile has no Highspeed write capability",
      compactForRemoteControl: true,
      rowCardId: "hsc-mobile-current",
      activeCardId: "hsc-mobile-current",
    },
  ])("$name only shows the fallback toast without calling the invalidate RPC", async (fixture) => {
    const fallbackAt = Date.now();
    const snapshot = makeSnapshot();
    snapshot.rows = {
      window: [
        {
          rowId: 1,
          turnId: "turn-fallback-history",
          createdAt: fallbackAt - 1_000,
          createdAtSeq: 1,
          kind: "userInput",
          text: "fallback history",
          origin: "realUser",
          sourceCommandId: `command-${fixture.name}`,
          highspeed: {
            schemaVersion: 1,
            cardId: fixture.rowCardId,
            taskId: "session-1",
            provider: "builtin:zai-coding-plan",
            model: "GLM-5.3",
            issuedAt: fallbackAt - 60_000,
            expiresAt: fallbackAt + 60_000,
            fallbackAt,
            fallbackReason: "highspeed_selection_unavailable",
          },
        },
      ],
      totalCount: 1,
      firstRowId: 1,
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: `sub-${fixture.name}`,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.highspeedCardService.getSnapshot.mockResolvedValueOnce({
      card: {
        cardId: fixture.activeCardId,
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: fallbackAt - 30_000,
        expiresAt: fallbackAt + 60_000,
      },
      nextDrawAt: fallbackAt + 3_600_000,
      drawing: false,
    });

    const root = await renderPane({
      compactForRemoteControl: fixture.compactForRemoteControl,
    });
    try {
      await act(async () => {
        await flushMicrotasks();
      });
      expect(mocks.highspeedCardService.invalidateCard).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalledWith(
        expectedCopy("chat.highspeed.requestFailedFallback"),
      );
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("does not show an automatic fallback toast for a draft prewarm session", async () => {
    seedModelProviderNames();
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: "session-1",
      promote: vi.fn(),
      discard: vi.fn(),
    };
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "draft-fallback-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const transition: SessionModelTransition = {
      eventId: "draft-fallback",
      origin: "registryFallback",
      from: { provider: "primary-provider", model: "deepseek-v4-flash" },
      to: { provider: "alternate-provider", model: "deepseek-v4-pro" },
    };

    const root = await renderPane({ sessionId: null });
    await act(async () => {
      modelTransitionMock.listener?.(transition);
      await flushMicrotasks();
    });

    expect(mocks.toast).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not show a model-change toast for a draft before prewarm projection", async () => {
    seedModelProviderNames();
    projectionState.current = {
      status: "live",
      snapshot: null,
      subscriptionId: "draft-catalog-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    const root = await renderPane({ sessionId: null });
    await act(async () => {
      captured.composerProps?.onSelectModel("alternate-provider", "deepseek-v4-pro", {
        provider: "primary-provider",
        model: "deepseek-v4-flash",
      });
      await flushMicrotasks();
    });

    expect(mocks.toast).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not show a model-change toast for a draft with stale prewarm projection", async () => {
    seedModelProviderNames();
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: "session-1",
      promote: vi.fn(),
      discard: vi.fn(),
    };
    draftConfigMock.draftConfigRef.current = {
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
    };
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "stale-prewarm-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane({ sessionId: null });
    await act(async () => {
      captured.composerProps?.onSelectModel("primary-provider", "GLM-5.2", {
        provider: "alternate-provider",
        model: "deepseek-v4-pro",
      });
      await flushMicrotasks();
    });

    expect(mocks.toast).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps an existing-session model choice in the Composer until submit", async () => {
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: "session-1",
      promote: vi.fn(),
      discard: vi.fn(),
    };
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane();
    await act(async () => {
      captured.composerProps?.onSelectModel("alternate-provider", "deepseek-v4-pro", {
        provider: "primary-provider",
        model: "deepseek-v4-flash",
      });
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();

    await act(async () => {
      await captured.composerProps?.onSendText("use the selected model");
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "sendText",
      payload: {
        text: "use the selected model",
        modelSelection: {
          providerId: "alternate-provider",
          modelId: "deepseek-v4-pro",
        },
        mode: "build",
      },
    });
    expect(composerRecentMocks.acceptSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: {
          modelSelection: {
            providerId: "alternate-provider",
            modelId: "deepseek-v4-pro",
            options: { reasoningLevel: "high" },
          },
          mode: "build",
          planEnabled: false,
        },
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("records the Composer original selection in Recent after an accelerated turn is accepted, not the hidden accelerated provider (spec §5.1)", async () => {
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: "session-1",
      promote: vi.fn(),
      discard: vi.fn(),
    };
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );
    // Card drawn: execution carries the hidden accelerated provider execution selection, which overrides payload.modelSelection.
    mocks.highspeedCardService.prepareTurn.mockResolvedValueOnce({
      kind: "accelerated",
      card: {
        cardId: "card-1",
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: 1,
        expiresAt: Date.now() + 60_000,
      },
      nextDrawAt: Date.now() + 60_000,
      execution: {
        modelSelection: { providerId: "account:zai-highspeed-card", modelId: "GLM-5.3" },
        requestAuth: { apiKey: "jwt", headers: {} },
        selectionFallback: {
          providerId: "account:zai-highspeed-card",
          rules: [
            { reason: "highspeed_card_expired", providerErrorCode: "3402" },
            { reason: "highspeed_request_failed" },
          ],
        },
      },
    });

    const root = await renderPane();
    await act(async () => {
      captured.composerProps?.onSelectModel("alternate-provider", "deepseek-v4-pro", {
        provider: "primary-provider",
        model: "deepseek-v4-flash",
      });
      await flushMicrotasks();
    });

    await act(async () => {
      await captured.composerProps?.onSendText("accelerated turn keeps recent on the original");
      await flushMicrotasks();
    });

    // The payload selection has indeed been overridden by execution material to the hidden accelerated provider (proving the turn was accelerated).
    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "sendText",
      payload: {
        modelSelection: { providerId: "account:zai-highspeed-card", modelId: "GLM-5.3" },
        mode: "build",
      },
    });
    // Recent records only the original selection frozen by the Composer before sending; otherwise new-task draft seeding resolves to an empty picker.
    expect(composerRecentMocks.acceptSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: {
          modelSelection: {
            providerId: "alternate-provider",
            modelId: "deepseek-v4-pro",
            options: { reasoningLevel: "high" },
          },
          mode: "build",
          planEnabled: false,
        },
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("invalidates the card and keeps the Composer submission when the Highspeed fallback target is unavailable before ACK", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-highspeed-admission-rejected",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.highspeedCardService.prepareTurn.mockResolvedValueOnce({
      kind: "accelerated",
      card: {
        cardId: "hsc-admission-rejected",
        taskId: "session-1",
        provider: "builtin:zai-coding-plan",
        model: "GLM-5.3",
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      nextDrawAt: Date.now() + 60_000,
      execution: {
        modelSelection: { providerId: "account:zai-highspeed-card", modelId: "GLM-5.3" },
        requestAuth: { apiKey: "jwt", headers: {} },
        selectionFallback: {
          providerId: "account:zai-highspeed-card",
          rules: [
            { reason: "highspeed_card_expired", providerErrorCode: "3402" },
            { reason: "highspeed_request_failed" },
          ],
          target: { providerId: "primary-provider", modelId: "deepseek-v4-flash" },
        },
      },
    });
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "failed", reasonCode: "modelUnavailable" }),
    );

    const root = await renderPane();
    try {
      let result: Awaited<ReturnType<ComposerProps["onSendText"]>>;
      await act(async () => {
        result = await captured.composerProps!.onSendText(
          "keep this input when both models are unavailable",
        );
        await flushMicrotasks();
      });

      // "blocked" lets the Composer's existing submission transaction restore text and attachments; it must not throw and trigger the generic send-error banner.
      expect(result!).toBe("blocked");
      expect(mocks.highspeedCardService.invalidateCard).toHaveBeenCalledWith(
        "hsc-admission-rejected",
      );
      expect(captured.composerProps?.highspeedCard).toBeNull();
      expect(captured.composerProps?.error).toBeNull();
      expect(composerRecentMocks.acceptSubmission).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each(["accepted", "rejected", "failed", "duplicate"] as const)(
    "the %s ACK of a running submission records the permission snapshot from the submission moment only when admitted",
    async (status) => {
      const running = makeSnapshot();
      running.control = { ...running.control, phase: "running", canStop: true };
      running.inputRouting = { mode: "enqueue" };
      projectionState.current = {
        status: "live",
        snapshot: running,
        subscriptionId: "recent-mode",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      let settle!: () => void;
      mocks.sendCommand.mockImplementationOnce(
        (envelope: CommandEnvelope) =>
          new Promise((resolve) => {
            settle = () =>
              resolve(
                ackFor(envelope, {
                  status,
                  ...(status === "rejected" || status === "failed"
                    ? { reasonCode: "test_failure" }
                    : {}),
                }),
              );
          }),
      );
      const root = await renderPane();
      act(() => draftConfigMock.handleDraftSwitchMode("yolo"));
      let pending: unknown;
      await act(async () => {
        pending = captured.composerProps?.onSendText("queued permission preference");
        await flushMicrotasks();
      });
      expect(composerRecentMocks.acceptSubmission).not.toHaveBeenCalled();
      act(() => draftConfigMock.handleDraftSwitchMode("plan"));
      await act(async () => {
        settle();
        if (status === "accepted") await pending;
        else await expect(pending).rejects.toThrow();
      });
      if (status === "accepted" || status === "duplicate") {
        expect(composerRecentMocks.acceptSubmission).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ selection: expect.objectContaining({ mode: "yolo" }) }),
        );
      } else {
        expect(composerRecentMocks.acceptSubmission).not.toHaveBeenCalled();
      }
      expect(draftConfigMock.draftConfigRef.current.mode).toBe("plan");
      act(() => root.unmount());
      const envelope = mocks.sendCommand.mock.calls[0]![0];
      pendingCommandRegistry.settle(envelope.sessionId, envelope.commandId);
    },
  );

  it.each<{
    text: string;
    type: "sendText" | "sendGoalCommand";
    options: Parameters<ComposerProps["onSendText"]>[1];
    mobile?: boolean;
  }>([
    { text: "immediate first input", type: "sendText", options: undefined },
    { text: "/goal finish task", type: "sendGoalCommand", options: undefined },
    { text: "mobile remote first input", type: "sendText", options: undefined, mobile: true },
    {
      text: "attached first input",
      type: "sendText",
      options: {
        attachments: [
          { ref: "zcode-artifact://image", fileName: "image.png", mime: "image/png", bytes: 128 },
        ],
      },
    },
    {
      text: "shared first input",
      type: "sendText",
      options: {
        sharedContextRefs: [{ kind: "shared_context_import", context_id: "shared-1" }],
      },
    },
  ])("waits for the same pending prewarm: $text", async ({ text, type, options, mobile }) => {
    const initialConfig: Partial<SessionConfigState> = {
      modelSelection: {
        providerId: "e2e-deepseek",
        modelId: "deepseek-v4-flash",
        options: { reasoningLevel: "high" },
      },
      provider: "e2e-deepseek",
      model: "deepseek-v4-flash",
      thought: "high",
      mode: "build",
      followupMode: "queue",
    };
    draftConfigMock.draftConfigRef.current = {};
    draftConfigMock.resolveInitialDraftConfig.mockReturnValue(initialConfig);
    projectionState.current = {
      status: "connecting",
      snapshot: null,
      subscriptionId: null,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    let resolvePrewarm!: (ack: CommandAck) => void;
    const pendingPrewarm = new Promise<CommandAck>((resolve) => {
      resolvePrewarm = resolve;
    });
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => {
      if (mocks.sendCommand.mock.calls.length === 1) {
        return pendingPrewarm;
      }
      return ackFor(envelope);
    });

    const workspaceIdentity = mobile ? "remote:ssh:dev:/workspace" : undefined;
    const root = await renderPane({
      sessionId: null,
      workspaceIdentity,
      compactForRemoteControl: mobile,
      remoteSessionId: mobile ? "remote-session-mobile" : undefined,
    });
    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "createSession",
      payload: { workspaceId: workspaceIdentity ?? "/workspace", config: initialConfig },
    });

    let send!: ReturnType<ComposerProps["onSendText"]>;
    await act(async () => {
      send = captured.composerProps!.onSendText(text, options);
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvePrewarm(
        ackFor(mocks.sendCommand.mock.calls[0]?.[0] as CommandEnvelope, {
          result: { type: "createSession", sessionId: "prewarm-session" },
        }),
      );
      await send;
      await flushMicrotasks();
    });
    expect(
      mocks.sendCommand.mock.calls.filter(([command]) => command.type === "createSession"),
    ).toHaveLength(1);
    const submissions = mocks.sendCommand.mock.calls.filter(([command]) => command.type === type);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.[0]).toMatchObject({
      type,
      sessionId: "prewarm-session",
      payload: {
        ...(type === "sendText" ? { text } : {}),
        ...(options?.attachments ? { attachments: options.attachments } : {}),
        ...(options?.sharedContextRefs ? { context_refs: options.sharedContextRefs } : {}),
        modelSelection: {
          providerId: "e2e-deepseek",
          modelId: "deepseek-v4-flash",
          options: { reasoningLevel: "high" },
        },
        mode: "build",
      },
    });
    await act(async () => {
      await flushMicrotasks();
      root.unmount();
    });
  });

  it("a late prewarm model event does not overwrite the Composer; this send keeps the user selection", async () => {
    const promote = vi.fn();
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: "session-1",
      promote,
      discard: vi.fn(),
    };
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const selection = {
      providerId: "primary-provider",
      modelId: "deepseek-v4-flash",
      options: { reasoningLevel: "high" },
    };
    draftConfigMock.draftConfigRef.current = { mode: "build", modelSelection: selection };
    // Todo71: prewarm only consumes config and no longer owns the Composer selection; real invalidation empties the Ready View.
    draftConfigMock.resolveInitialDraftConfig.mockReturnValue({
      provider: "primary-provider",
      model: "deepseek-v4-flash",
      thought: "max",
      mode: "build",
    });
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane({ sessionId: null });
    const fallbackSnapshot = makeSnapshot();
    fallbackSnapshot.config = {
      ...fallbackSnapshot.config,
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
      thought: "high",
    };
    projectionState.current = {
      ...projectionState.current,
      snapshot: fallbackSnapshot,
    };
    // A plain snapshot difference has no delivery provenance and must not be inferred as an automatic fallback.
    await rerenderPane(root, { sessionId: null });

    await act(async () => {
      modelTransitionMock.listener?.({
        eventId: "fallback-prewarm-1",
        origin: "registryFallback",
        from: {
          provider: "primary-provider",
          model: "deepseek-v4-flash",
        },
        to: {
          provider: "alternate-provider",
          model: "deepseek-v4-pro",
        },
      });
      await flushMicrotasks();
    });

    expect(draftConfigMock.draftConfigRef.current.modelSelection).toEqual(selection);
    expect(composerRecentMocks.acceptSubmission).not.toHaveBeenCalled();
    await act(async () => {
      await captured.composerProps?.onSendText("first input after fallback");
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "sendText",
      sessionId: "session-1",
      payload: { text: "first input after fallback", modelSelection: selection, mode: "build" },
    });
    expect(promote).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("does not update Composer Recent for online fallback or snapshot navigation", async () => {
    const initial = makeSnapshot();
    projectionState.current = {
      status: "live",
      snapshot: initial,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root = await renderPane();

    const fallback = makeSnapshot();
    fallback.revision = 8;
    fallback.config = {
      ...fallback.config,
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
      thought: "high",
    };
    projectionState.current = {
      ...projectionState.current,
      snapshot: fallback,
    };
    await rerenderPane(root);

    await act(async () => {
      modelTransitionMock.listener?.({
        eventId: "fallback-session-1",
        origin: "registryFallback",
        from: {
          provider: "primary-provider",
          model: "deepseek-v4-flash",
        },
        to: {
          provider: "alternate-provider",
          model: "deepseek-v4-pro",
        },
      });
      await flushMicrotasks();
    });
    expect(composerRecentMocks.acceptSubmission).not.toHaveBeenCalled();

    const historical = makeSnapshot();
    historical.sessionId = "session-2";
    historical.revision = 9;
    historical.config = {
      ...historical.config,
      provider: "third-provider",
      model: "historical-model",
      thought: "max",
    };
    projectionState.current = {
      ...projectionState.current,
      snapshot: historical,
    };
    await rerenderPane(root, { sessionId: "session-2" });
    expect(composerRecentMocks.acceptSubmission).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("submits an explicit draft intent atomically on first send", async () => {
    const promote = vi.fn();
    prewarmHookMock.binding = {
      workspaceKey: "/workspace",
      sessionId: "session-1",
      promote,
      discard: vi.fn(),
    };
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    draftConfigMock.draftConfigRef.current = {
      provider: "alternate-provider",
      model: "deepseek-v4-pro",
      thought: "high",
      mode: "yolo",
    };
    draftConfigMock.resolveInitialDraftConfig.mockReturnValue({
      provider: "stale-provider",
      model: "stale-model",
      thought: "max",
    });
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane({ sessionId: null });
    await act(async () => {
      await captured.composerProps?.onSendText("first input with explicit intent");
      await flushMicrotasks();
    });

    const envelopes = mocks.sendCommand.mock.calls.map(([envelope]) => envelope);
    expect(envelopes.at(-1)).toMatchObject({
      type: "sendText",
      payload: {
        text: "first input with explicit intent",
        modelSelection: {
          providerId: "alternate-provider",
          modelId: "deepseek-v4-pro",
          options: { reasoningLevel: "high" },
        },
        mode: "yolo",
      },
    });
    expect(envelopes.some((envelope) => envelope.type === "switchModelConfig")).toBe(false);
    expect(envelopes.some((envelope) => envelope.type === "switchCollaborationMode")).toBe(false);
    expect(promote).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("does not dispatch or recover provider state when only the Composer selection changes", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root = await renderPane({ remoteSessionId: "remote-session-1" });

    await act(async () => {
      captured.composerProps?.onSelectModel("alternate-provider", "deepseek-v4-pro", {
        provider: "primary-provider",
        model: "deepseek-v4-flash",
      });
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).not.toHaveBeenCalled();
    expect(mocks.zcodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it("does not recover with a stale provider snapshot when the local registry rejects the model", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "local-registry-rejection-subscription",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, {
        status: "failed",
        reasonCode: "provider.notInRegistry",
        revisionAtDecision: 7,
      }),
    );

    const root = await renderPane();

    await act(async () => {
      captured.composerProps?.onSelectModel("alternate-provider", "deepseek-v4-pro", {
        provider: "primary-provider",
        model: "deepseek-v4-flash",
      });
      await expect(captured.composerProps?.onSendText("local registry rejection")).rejects.toThrow(
        "provider.notInRegistry",
      );
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.zcodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it("does not inject the desktop runtimeModel retry when the remote registry rejects the model", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) => {
      const callIndex = mocks.sendCommand.mock.calls.length;
      if (callIndex === 1) {
        return ackFor(envelope, {
          status: "failed",
          reasonCode: "provider.notInRegistry",
          revisionAtDecision: 7,
        });
      }
      return ackFor(envelope, {
        status: "failed",
        reasonCode: "provider.notInRegistry",
        revisionAtDecision: 7,
      });
    });

    const root = await renderPane({ remoteSessionId: "remote-session-1" });

    await act(async () => {
      captured.composerProps?.onSelectModel("alternate-provider", "deepseek-v4-pro", {
        provider: "primary-provider",
        model: "deepseek-v4-flash",
      });
      await expect(captured.composerProps?.onSendText("remote registry rejection")).rejects.toThrow(
        "provider.notInRegistry",
      );
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.zcodeSessionService.updateProviderRegistry).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it("recovers configOptions after a custom provider selection from prepare error", async () => {
    seedModelProviderNames();
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockResolvedValue(undefined);

    const root = await renderPane();

    await act(async () => {
      await captured.composerProps?.onRecoverCustomModelSelection?.(
        "custom:alternate-provider:deepseek-v4-pro",
        {
          provider: "primary-provider",
          model: "deepseek-v4-flash",
        },
      );
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expectedCopy("chat.modelChangeNotice.changed", {
        fromModel: "Primary Coding Plan/deepseek-v4-flash",
        toModel: "Alternate API/deepseek-v4-pro",
      }),
    );
    expect(draftConfigMock.handleDraftSelectModel).toHaveBeenCalledWith(
      "alternate-provider",
      "deepseek-v4-pro",
    );
    expect(mocks.zcodeTaskService.restartWorkspaceProcess).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      workspaceIdentity: undefined,
      provider: "glm",
      bumpRuntimeEpoch: true,
    });
    expect(mocks.zcodeTaskService.restartWorkspaceProcess.mock.invocationCallOrder[0]).toBeLessThan(
      draftConfigMock.handleDraftSelectModel.mock.invocationCallOrder[0] ?? 0,
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("does not show a custom provider recovery toast for a draft", async () => {
    seedModelProviderNames();
    prewarmHookMock.binding = null;
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "draft-custom-recovery",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockResolvedValue(undefined);

    const root = await renderPane({ sessionId: null });
    await act(async () => {
      await captured.composerProps?.onRecoverCustomModelSelection?.(
        "custom:alternate-provider:deepseek-v4-pro",
        {
          provider: "primary-provider",
          model: "deepseek-v4-flash",
        },
      );
      await flushMicrotasks();
    });

    expect(mocks.toast).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });
});

describe("SessionPane compact blocked feedback", () => {
  it.each([
    ["activeTurn", expectedCopy("chat.compact.runningBlocked")],
    ["compactOperationLock", expectedCopy("chat.compact.duplicateBlocked")],
  ])("shows a toast when /compact is rejected with %s", async (reasonCode, expectedToast) => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementationOnce(async (envelope: CommandEnvelope) =>
      ackFor(envelope, {
        status: "failed",
        reasonCode,
      }),
    );

    const root = await renderPane();

    await act(async () => {
      await captured.composerProps?.onSendText("/compact");
      await flushMicrotasks();
    });

    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "compact",
    });
    expect(Object.hasOwn(mocks.sendCommand.mock.calls[0]?.[0] ?? {}, "baseRevision")).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(expectedToast);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows an accepted toast when running /compact enters the FIFO", async () => {
    const running = makeSnapshot();
    running.control = {
      ...running.control,
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
    };
    running.inputRouting = { mode: "enqueue" };
    projectionState.current = {
      status: "live",
      snapshot: running,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementationOnce(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane();
    await act(async () => {
      await captured.composerProps?.onSendText("/compact");
      await flushMicrotasks();
    });

    expect(mocks.toast).toHaveBeenCalledWith(expectedCopy("chat.compact.queued"));
    await act(async () => {
      root.unmount();
    });
  });
});

describe("SessionPane Plan picker action", () => {
  it.each([
    { sessionId: "session-1" },
    { sessionId: null },
    {
      sessionId: "session-1",
      compactForRemoteControl: true,
      workspaceIdentity: "remote:ssh:example:/repo",
      remoteSessionId: "remote-1",
    },
  ])("selection uses the standard Plan control without sending: %j", async (props) => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root = await renderPane(props);
    const callsBefore = mocks.sendCommand.mock.calls.length;
    const action = captured.composerProps?.appSlashCommands?.find((item) => item.value === "plan");
    expect(action).toMatchObject({
      label: expectedCopy("chat.slash.app.plan.label"),
      description: expectedCopy("chat.slash.app.plan.description"),
    });
    await act(async () => {
      action?.run();
      action?.run();
      await flushMicrotasks();
    });
    expect(draftConfigMock.handleDraftSwitchMode.mock.calls).toEqual([["plan"], ["plan"]]);
    expect(mocks.sendCommand.mock.calls.length).toBe(callsBefore);
    await act(async () => root.unmount());
  });

  it("does not offer the Plan action in a read-only pane", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root = await renderPane({ readOnly: true });
    expect(
      captured.composerProps?.appSlashCommands?.some((item) => item.value === "plan"),
    ).not.toBe(true);
    await act(async () => root.unmount());
  });

  it.each(["/plan", "/PLAN do X for me"])(
    "sends literal %s without changing Plan or stripping text",
    async (text) => {
      projectionState.current = {
        status: "live",
        snapshot: makeSnapshot(),
        subscriptionId: "sub-1",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
        ackFor(envelope, { status: "accepted" }),
      );
      const attachments = [
        { ref: "zcode-artifact://a", fileName: "a.txt", mime: "text/plain", bytes: 1 },
      ];
      const root = await renderPane();
      await act(async () => {
        expect(
          await captured.composerProps?.onSendText(text, {
            attachments,
            contextAttachmentCount: 1,
          }),
        ).toBe("sent");
        await flushMicrotasks();
      });
      expect(mocks.sendCommand.mock.calls.map(([envelope]) => envelope.type)).toEqual(["sendText"]);
      expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
        payload: { text, mode: "build", planEnabled: false, attachments },
      });
      expect(draftConfigMock.handleDraftSwitchMode).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    },
  );
});

describe("SessionPane Plan mode goal guard", () => {
  it.each(["/goal", "/goal keep this input", "/target keep alias input", "/goal resume"])(
    "blocks %s before any conversation command is dispatched",
    async (command) => {
      const planSnapshot = makeSnapshot();
      planSnapshot.config.mode = "plan";
      projectionState.current = {
        status: "live",
        snapshot: planSnapshot,
        subscriptionId: "sub-1",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };

      const root = await renderPane();
      let sendResult: unknown;
      await act(async () => {
        sendResult = await captured.composerProps?.onSendText(command);
        await flushMicrotasks();
      });

      expect(sendResult).toBe("blocked");
      expect(mocks.sendCommand).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalledWith(expectedCopy("chat.goal.planModeBlocked"));

      await act(async () => {
        root.unmount();
      });
    },
  );

  it("keeps the existing goal command path outside Plan mode", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementationOnce(async (envelope: CommandEnvelope) =>
      ackFor(envelope, { status: "accepted" }),
    );

    const root = await renderPane();
    let sendResult: unknown;
    await act(async () => {
      sendResult = await captured.composerProps?.onSendText("/goal normal objective");
      await flushMicrotasks();
    });

    expect(sendResult).toBe("sent");
    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "sendGoalCommand",
      payload: {
        text: "normal objective",
        displayText: "/goal normal objective",
      },
    });
    expect(mocks.toast).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not promote a Plan-mode draft when /goal is blocked", async () => {
    draftConfigMock.draftConfigRef.current = { mode: "plan" };
    draftConfigMock.resolveInitialDraftConfig.mockReturnValue({ mode: "plan" });
    projectionState.current = {
      status: "connecting",
      snapshot: null,
      subscriptionId: null,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
      ackFor(envelope, {
        result: { type: "createSession", sessionId: "prewarm-plan-session" },
      }),
    );
    const onSessionCreated = vi.fn();
    const root = await renderPane({ sessionId: null, onSessionCreated });
    const callsBeforeSubmit = mocks.sendCommand.mock.calls.length;

    let result: unknown;
    await act(async () => {
      result = await captured.composerProps?.onSendText("/goal draft objective");
      await flushMicrotasks();
    });

    expect(result).toBe("blocked");
    expect(mocks.sendCommand).toHaveBeenCalledTimes(callsBeforeSubmit);
    expect(onSessionCreated).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expectedCopy("chat.goal.planModeBlocked"));

    await act(async () => {
      root.unmount();
    });
  });
});

describe("Start submission recommendation only modifies this submission", () => {
  it.each([false, true])(
    "desktop/mobile (%s) confirm-switch keeps the reasoning level and sends only once",
    async (mobile) => {
      projectionState.current = {
        status: "live",
        snapshot: makeSnapshot(),
        subscriptionId: "start154",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      recommendation.mockImplementation(async (selection) => ({
        ...selection,
        providerId: "account:bigmodel-start-plan",
      }));
      mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
        ackFor(envelope, { status: "accepted" }),
      );
      const root = await renderPane({ compactForRemoteControl: mobile });
      try {
        await act(async () => {
          await captured.composerProps?.onSendText("start154-submit");
        });
        expect(recommendation).toHaveBeenCalledOnce();
        const original = recommendation.mock.calls[0]![0];
        const commands = mocks.sendCommand.mock.calls
          .map(([envelope]) => envelope)
          .filter((envelope) => envelope.type === "sendText");
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({
          payload: { modelSelection: { ...original, providerId: "account:bigmodel-start-plan" } },
        });
      } finally {
        await act(async () => root.unmount());
      }
    },
  );
  it("closing the recommendation dialog does not submit a new message and keeps the original prewarm rules", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "start154",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    recommendation.mockResolvedValue(null);
    const root = await renderPane({ sessionId: null });
    try {
      let result: unknown;
      await act(async () => {
        result = await captured.composerProps?.onSendText("keep-draft");
      });
      expect(result).toBe("blocked");
      expect(
        mocks.sendCommand.mock.calls
          .map(([envelope]) => envelope)
          .filter((envelope) => envelope.type !== "createSession"),
      ).toEqual([]);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("desktop and mobile submission boundaries for the side-pane first recommendation", () => {
  for (const mobile of [false, true]) {
    it.each(["confirm", "decline", "close"] as const)(
      `mobile=${mobile}: %s only decides the child first input and never touches the parent draft`,
      async (choice) => {
        projectionState.current = {
          status: "live",
          snapshot: makeSnapshot(),
          subscriptionId: "start156-side",
          lastError: null,
          optimisticCommands: [],
          loadingOlder: false,
        };
        draftConfigMock.draftConfigRef.current = {
          modelSelection: {
            providerId: "alternate-provider",
            modelId: "deepseek-v4-pro",
            options: { reasoningLevel: "low" },
          },
        };
        recommendation.mockImplementation(async (selection) =>
          choice === "close"
            ? null
            : choice === "confirm"
              ? { ...selection, providerId: "account:bigmodel-start-plan" }
              : selection,
        );
        mocks.sendCommand.mockImplementation(async (envelope: CommandEnvelope) =>
          ackFor(envelope, {
            result: { type: "createSelectionSideSession", childSessionId: "start156-child" },
          }),
        );
        const onOpenSelectionSideChat = vi.fn();
        const root = await renderPane({ compactForRemoteControl: mobile, onOpenSelectionSideChat });
        try {
          const before = structuredClone(draftConfigMock.draftConfigRef.current);
          let result: unknown;
          await act(async () => {
            result = await captured.composerProps?.onSendText("/side explain this");
          });
          expect(recommendation).toHaveBeenCalledExactlyOnceWith({
            providerId: "primary-provider",
            modelId: "deepseek-v4-flash",
            options: { reasoningLevel: "high" },
          });
          expect(draftConfigMock.draftConfigRef.current).toEqual(before);
          expect(result).toBe(choice === "close" ? "blocked" : "sent");
          if (choice === "close") {
            expect(mocks.sendCommand).not.toHaveBeenCalled();
            expect(onOpenSelectionSideChat).not.toHaveBeenCalled();
          } else {
            expect(mocks.sendCommand).toHaveBeenCalledOnce();
            expect(mocks.sendCommand.mock.calls[0]![0]).toMatchObject({
              type: "createSelectionSideSession",
              payload: {
                firstInput: {
                  text: "explain this",
                  ...(choice === "confirm"
                    ? {
                        modelSelection: {
                          providerId: "account:bigmodel-start-plan",
                          modelId: "deepseek-v4-flash",
                          options: { reasoningLevel: "high" },
                        },
                      }
                    : {}),
                },
              },
            });
            if (choice === "decline")
              expect(mocks.sendCommand.mock.calls[0]![0].payload).toEqual({
                firstInput: { text: "explain this" },
              });
            expect(onOpenSelectionSideChat).toHaveBeenCalledOnce();
          }
        } finally {
          await act(async () => root.unmount());
        }
      },
    );
  }
});

describe("SessionPane lease ownership", () => {
  it("never exposes the previous session lease to a new render identity", async () => {
    const { useSessionPaneLease } = await import("@/v4/SessionPane.js");
    const layer = {};
    const leaseA = { sessionId: "A" } as import("@/v4/sessionDataLayer.js").SessionLease;
    const leaseB = { sessionId: "B" } as import("@/v4/sessionDataLayer.js").SessionLease;
    let current!: ReturnType<typeof useSessionPaneLease>;
    const seen: Array<{ sessionId: string | null; lease: unknown }> = [];
    function Probe({ sessionId, layer }: { sessionId: string | null; layer: object }) {
      current = useSessionPaneLease(sessionId, layer);
      seen.push({ sessionId, lease: current[0] });
      return null;
    }
    const root = createRoot(installMinimalDom());
    const render = async (sessionId: string | null, owner = layer) => {
      await act(async () => root.render(createElement(Probe, { sessionId, layer: owner })));
    };
    const bind = async (sessionId: string | null, lease: typeof leaseA) => {
      await act(async () => current[1]({ sessionId, layer, lease }));
    };
    try {
      await render("A");
      await bind("A", leaseA);
      expect(current[0]).toBe(leaseA);
      await render("B");
      expect(
        seen.filter((item) => item.sessionId === "B").every((item) => item.lease === null),
      ).toBe(true);
      await bind("B", leaseB);
      expect(current[0]).toBe(leaseB);
      await render("B", {});
      expect(current[0]).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps the committed owner when a different session render suspends", async () => {
    const { useSessionPaneLease } = await import("@/v4/SessionPane.js");
    const layer = {};
    const lease = { sessionId: "A" } as import("@/v4/sessionDataLayer.js").SessionLease;
    const pending = new Promise<never>(() => {});
    let current!: ReturnType<typeof useSessionPaneLease>;
    function Probe({ sessionId, suspend }: { sessionId: string; suspend: boolean }) {
      current = useSessionPaneLease(sessionId, layer);
      if (suspend) throw pending;
      return null;
    }
    const root = createRoot(installMinimalDom());
    const render = async (sessionId: string, suspend: boolean) => {
      await act(async () =>
        root.render(
          createElement(Suspense, { fallback: null }, createElement(Probe, { sessionId, suspend })),
        ),
      );
    };
    try {
      await render("A", false);
      await act(async () => current[1]({ sessionId: "A", layer, lease }));
      await render("B", true);
      await render("A", false);
      expect(current[0]).toBe(lease);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps a promoted draft lease but releases its binding when returning to draft", async () => {
    const { useSessionPaneLease } = await import("@/v4/SessionPane.js");
    const layer = {};
    const lease = { sessionId: "promoted" } as import("@/v4/sessionDataLayer.js").SessionLease;
    let current!: ReturnType<typeof useSessionPaneLease>;
    function Probe({ sessionId }: { sessionId: string | null }) {
      current = useSessionPaneLease(sessionId, layer);
      return null;
    }
    const root = createRoot(installMinimalDom());
    const render = async (sessionId: string | null) => {
      await act(async () => root.render(createElement(Probe, { sessionId })));
    };
    try {
      await render(null);
      await act(async () => current[1]({ sessionId: null, layer, lease }));
      await render("promoted");
      expect(current[0]).toBe(lease);
      await render(null);
      expect(current[0]).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
