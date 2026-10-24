import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentRef,
  CommandAck,
  CommandEnvelope,
  ConversationRowTarget,
  ConversationSnapshot,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const {
  composerProps,
  fileChangesMock,
  fileRewindPreviewMock,
  headerProps,
  layerMock,
  queueProps,
  sendCommandMock,
  timelineProps,
} = vi.hoisted(() => ({
  composerProps: [] as Array<{ composerRestoreRequest?: { text?: string } | null }>,
  fileChangesMock: vi.fn(),
  fileRewindPreviewMock: vi.fn(),
  headerProps: [] as Array<{
    onDelete?: () => void;
    onRename?: (title: string) => void;
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
  queueProps: [] as Array<{
    onSendNow?: (queueItemId: string) => void;
    onEditItem?: (queueItemId: string) => Promise<void> | void;
    onDeleteItem?: (queueItemId: string) => void;
  }>,
  sendCommandMock: vi.fn(
    async (envelope: CommandEnvelope): Promise<CommandAck> => ({
      commandId: envelope.commandId,
      revisionAtDecision: envelope.baseRevision ?? 0,
      status: "accepted",
    }),
  ),
  timelineProps: [] as Array<{
    bottomDock?: ReactNode;
    scrollMemoryKey?: string | null;
    rowContext?: {
      fetchFileChanges?: (
        target: ConversationRowTarget,
        options: {
          cachePolicy: "in-flight" | "terminal";
          fileChangesState?: "active" | "reverted";
        },
      ) => Promise<V4ConversationFileChangesResult>;
      previewFileRewind?: (target: ConversationRowTarget) => Promise<unknown>;
    };
    onFork?: (target: ConversationRowTarget) => void;
    onRetry?: (target: ConversationRowTarget) => void;
    onEdit?: (
      target: ConversationRowTarget,
      newText: string,
      attachments?: readonly AttachmentRef[],
    ) => Promise<boolean | void> | boolean | void;
  }>,
}));

// Never resolves: these files do not test the discovery query; resolving would trigger setState after environment teardown (unhandled exception).
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
  highspeedCardService: {
    getSnapshot: vi.fn(async () => ({ card: null, nextDrawAt: null, drawing: false })),
    prepareTurn: vi.fn(async () => ({
      kind: "fallback" as const,
      reason: "draw-miss" as const,
      nextDrawAt: null,
    })),
    healthy: vi.fn(),
    share: vi.fn(),
  },
  // Fix reason: the readiness hook takes the service as an effect dependency; rebuilding it every render causes infinite re-renders up to OOM.
  zcodeSessionService: {
    updateProviderRegistry: vi.fn(),
  },
  zcodeTaskService: {
    restartWorkspaceProcess: vi.fn(),
  },
}));

// This suite isolates edit/settings behavior; group delivery is covered by dedicated unit tests and Host/CLI E2E.
vi.mock("@/v4/BotGroupDeliveryAction.js", () => ({
  BotGroupDeliveryProvider: ({ children }: { children: unknown }) => children,
  ConnectedBotGroupDeliveryAction: () => null,
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
  useComposerClientNamespace: () => "desktop",
  useOptionalServices: () => null,
  useServices: () => servicesMock,
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    attachmentPut: vi.fn(),
    fileChanges: fileChangesMock,
    fileRewindPreview: fileRewindPreviewMock,
    layer: layerMock,
    sendCommand: sendCommandMock,
    // SessionPane pulls the journal-fallback run discovery query on mount; a missing stub throws TypeError in an effect.
    // The stub must be a stable reference — the effect depends on workflowRuns, and a fresh function per render would loop forever.
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

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/toast.js")>()),
  toast: toastMock,
}));

vi.mock("@/v4/ConversationHeader.js", async () => {
  const React = await import("react");
  return {
    ConversationHeader: (props: Record<string, unknown>) => {
      headerProps.push(props as (typeof headerProps)[number]);
      return React.createElement("div", { "data-testid": "mock-header" });
    },
  };
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
    ConversationQueuePanel: (props: Record<string, unknown>) => {
      queueProps.push(props as (typeof queueProps)[number]);
      return React.createElement("div", { "data-testid": "mock-queue" });
    },
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
  const documentMock = {
    addEventListener: () => {},
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
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
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
  await Promise.resolve();
  await Promise.resolve();
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
      provider: "",
      model: "",
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

function makeEmptyFileChanges(): V4ConversationFileChangesResult {
  return {
    files: 0,
    additions: 0,
    deletions: 0,
    items: [],
  };
}

afterEach(() => {
  fileChangesMock.mockReset();
  fileRewindPreviewMock.mockReset();
  sendCommandMock.mockClear();
  layerMock.acquire.mockImplementation(() => ({
    store: {
      markCommandPending: vi.fn(),
      expectAcceptedInputProjection: vi.fn(),
      recoverFromStaleAuthority: vi.fn(),
      onOnlineModelTransition: vi.fn(() => () => {}),
      refreshPlans: vi.fn(async () => {}),
      settleCommand: vi.fn(),
    },
    release: vi.fn(),
  }));
  headerProps.length = 0;
  queueProps.length = 0;
  composerProps.length = 0;
  toastMock.mockReset();
  timelineProps.length = 0;
  servicesMock.highspeedCardService.prepareTurn.mockReset();
  servicesMock.highspeedCardService.prepareTurn.mockResolvedValue({
    kind: "fallback",
    reason: "draw-miss",
    nextDrawAt: null,
  });
  projectionState.current = null;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("SessionPane user query editing", () => {
  it("builds pane-isolated timeline scroll memory keys for bound sessions", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "pane-2",
            sessionId: "session-1",
            workspaceIdentity: "ssh://demo",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    expect(timelineProps.at(-1)?.scrollMemoryKey).toBe(
      "ssh://demo::pane:pane-2::session:session-1",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("remounted virtual rows share one fileChanges request until the target or logEpoch changes", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    let resolveFirstRequest: ((value: V4ConversationFileChangesResult) => void) | undefined;
    const firstRequest = new Promise<V4ConversationFileChangesResult>((resolve) => {
      resolveFirstRequest = resolve;
    });
    fileChangesMock.mockReturnValueOnce(firstRequest).mockResolvedValue(makeEmptyFileChanges());
    const root: Root = createRoot(installMinimalDom());
    const renderPane = () =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(SessionPane, {
          paneId: "workspace-main",
          sessionId: "session-1",
          workspacePath: "/workspace",
        }),
      );

    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    const target = { rowId: 42, entityId: "entity-42" };
    const fetchBeforeRemount = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    const pendingFromFirstMount = fetchBeforeRemount?.(target, {
      cachePolicy: "terminal",
    });
    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });
    const fetchAfterRemount = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    const pendingFromRemount = fetchAfterRemount?.({ ...target }, { cachePolicy: "terminal" });

    expect(fileChangesMock).toHaveBeenCalledTimes(1);
    expect(pendingFromRemount).toBe(pendingFromFirstMount);
    resolveFirstRequest?.(makeEmptyFileChanges());
    await Promise.all([pendingFromFirstMount, pendingFromRemount]);

    await fetchAfterRemount?.({ ...target }, { cachePolicy: "terminal" });
    expect(fileChangesMock).toHaveBeenCalledTimes(1);

    await fetchAfterRemount?.({ rowId: 43, entityId: "entity-43" }, { cachePolicy: "terminal" });
    expect(fileChangesMock).toHaveBeenCalledTimes(2);

    const nextSnapshot = makeSnapshot();
    nextSnapshot.logEpoch = "epoch-2";
    nextSnapshot.revision = 8;
    projectionState.current = {
      ...projectionState.current,
      snapshot: nextSnapshot,
    } as NonNullable<typeof projectionState.current>;
    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    await timelineProps
      .at(-1)
      ?.rowContext?.fetchFileChanges?.({ ...target }, { cachePolicy: "terminal" });
    expect(fileChangesMock).toHaveBeenCalledTimes(3);
    expect(fileChangesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseLogEpoch: "epoch-2",
        target,
      }),
    );

    await act(async () => root.unmount());
  });

  it("terminal fileChanges cache isolates active/reverted states", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const activeResult = {
      ...makeEmptyFileChanges(),
      state: "active" as const,
      files: 1,
      items: [{ path: "/workspace/README.md", patches: [] }],
    };
    const revertedResult = {
      ...makeEmptyFileChanges(),
      state: "reverted" as const,
    };
    fileChangesMock.mockResolvedValueOnce(activeResult).mockResolvedValueOnce(revertedResult);
    const root: Root = createRoot(installMinimalDom());
    const renderPane = () =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(SessionPane, {
          paneId: "workspace-main",
          sessionId: "session-1",
          workspacePath: "/workspace",
        }),
      );

    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    const target = { rowId: 42, entityId: "entity-42" };
    const fetchActive = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    await expect(
      fetchActive?.(target, {
        cachePolicy: "terminal",
        fileChangesState: "active",
      }),
    ).resolves.toEqual(activeResult);
    await expect(
      fetchActive?.(
        { ...target },
        {
          cachePolicy: "terminal",
          fileChangesState: "active",
        },
      ),
    ).resolves.toEqual(activeResult);
    expect(fileChangesMock).toHaveBeenCalledTimes(1);

    const revertedSnapshot = makeSnapshot();
    revertedSnapshot.revision = 8;
    projectionState.current = {
      ...projectionState.current,
      snapshot: revertedSnapshot,
    } as NonNullable<typeof projectionState.current>;
    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    const fetchReverted = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    await expect(
      fetchReverted?.(target, {
        cachePolicy: "terminal",
        fileChangesState: "reverted",
      }),
    ).resolves.toEqual(revertedResult);
    await expect(
      fetchReverted?.(
        { ...target },
        {
          cachePolicy: "terminal",
          fileChangesState: "reverted",
        },
      ),
    ).resolves.toEqual(revertedResult);
    expect(fileChangesMock).toHaveBeenCalledTimes(2);
    expect(fileChangesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ baseRevision: 8, target }),
    );

    await act(async () => root.unmount());
  });

  it("fileChanges full-result cache keeps at most 20 turns", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    fileChangesMock.mockResolvedValue(makeEmptyFileChanges());
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    const fetchFileChanges = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    for (let rowId = 1; rowId <= 21; rowId += 1) {
      await fetchFileChanges?.({ rowId, entityId: `entity-${rowId}` }, { cachePolicy: "terminal" });
    }
    await fetchFileChanges?.({ rowId: 1, entityId: "entity-1" }, { cachePolicy: "terminal" });

    expect(fileChangesMock).toHaveBeenCalledTimes(22);
    await act(async () => root.unmount());
  });

  it("re-queries fileChanges after a running revision advance; only terminal results survive remount caching", async () => {
    const runningSnapshot = makeSnapshot();
    runningSnapshot.revision = 7;
    projectionState.current = {
      status: "live",
      snapshot: runningSnapshot,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const partialResult = {
      ...makeEmptyFileChanges(),
      files: 1,
      items: [{ path: "/workspace/README.md", patches: [] }],
    };
    const finalResult = {
      ...makeEmptyFileChanges(),
      files: 2,
      items: [
        { path: "/workspace/README.md", patches: [] },
        { path: "/workspace/index.html", patches: [] },
      ],
    };
    let resolveRunningRequest: ((value: V4ConversationFileChangesResult) => void) | undefined;
    const runningRequest = new Promise<V4ConversationFileChangesResult>((resolve) => {
      resolveRunningRequest = resolve;
    });
    fileChangesMock.mockReturnValueOnce(runningRequest).mockResolvedValueOnce(finalResult);
    const root: Root = createRoot(installMinimalDom());
    const renderPane = () =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(SessionPane, {
          paneId: "workspace-main",
          sessionId: "session-1",
          workspacePath: "/workspace",
        }),
      );

    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });
    const target = { rowId: 42, entityId: "entity-42" };
    const fetchWhileRunning = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    const firstRunningResult = fetchWhileRunning?.(target, {
      cachePolicy: "in-flight",
    });
    const duplicateRunningResult = fetchWhileRunning?.({ ...target }, { cachePolicy: "in-flight" });
    expect(duplicateRunningResult).toBe(firstRunningResult);
    expect(fileChangesMock).toHaveBeenCalledTimes(1);
    resolveRunningRequest?.(partialResult);
    await expect(firstRunningResult).resolves.toEqual(partialResult);
    await expect(duplicateRunningResult).resolves.toEqual(partialResult);

    const terminalSnapshot = makeSnapshot();
    terminalSnapshot.revision = 8;
    projectionState.current = {
      ...projectionState.current,
      snapshot: terminalSnapshot,
    } as NonNullable<typeof projectionState.current>;
    await act(async () => {
      root.render(renderPane());
      await flushMicrotasks();
    });

    const fetchAfterTerminal = timelineProps.at(-1)?.rowContext?.fetchFileChanges;
    await expect(fetchAfterTerminal?.(target, { cachePolicy: "terminal" })).resolves.toEqual(
      finalResult,
    );
    await expect(fetchAfterTerminal?.({ ...target }, { cachePolicy: "terminal" })).resolves.toEqual(
      finalResult,
    );

    expect(fileChangesMock).toHaveBeenCalledTimes(2);
    expect(fileChangesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ baseRevision: 7, target }),
    );
    expect(fileChangesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ baseRevision: 8, target }),
    );
    await act(async () => root.unmount());
  });

  it("a row command stale log epoch ACK triggers projection resync", async () => {
    const recoverFromStaleLogEpoch = vi.fn();
    layerMock.acquire.mockReturnValue({
      store: {
        markCommandPending: vi.fn(),
        expectAcceptedInputProjection: vi.fn(),
        onOnlineModelTransition: vi.fn(() => () => {}),
        refreshPlans: vi.fn(async () => {}),
        recoverFromStaleAuthority: recoverFromStaleLogEpoch,
        settleCommand: vi.fn(),
      },
      release: vi.fn(),
    } as never);
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    sendCommandMock.mockImplementationOnce(async (command: CommandEnvelope) => ({
      commandId: command.commandId,
      revisionAtDecision: 8,
      status: "stale",
      reasonCode: "proto.staleLogEpoch",
    }));
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    await act(async () => {
      timelineProps.at(-1)?.onRetry?.({ rowId: 42, entityId: "message-assistant-42" });
      await flushMicrotasks();
    });

    expect(recoverFromStaleLogEpoch).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it.each(["proto.staleTarget", "proto.staleRevision"])(
    "a row command %s ACK also triggers projection resync",
    async (reasonCode) => {
      const recoverFromStaleAuthority = vi.fn();
      layerMock.acquire.mockReturnValue({
        store: {
          markCommandPending: vi.fn(),
          expectAcceptedInputProjection: vi.fn(),
          onOnlineModelTransition: vi.fn(() => () => {}),
          refreshPlans: vi.fn(async () => {}),
          recoverFromStaleAuthority,
          settleCommand: vi.fn(),
        },
        release: vi.fn(),
      } as never);
      projectionState.current = {
        status: "live",
        snapshot: makeSnapshot(),
        subscriptionId: "sub-1",
        lastError: null,
        optimisticCommands: [],
        loadingOlder: false,
      };
      sendCommandMock.mockResolvedValueOnce({
        commandId: "cmd-stale-target",
        revisionAtDecision: 8,
        status: "stale",
        reasonCode,
      });
      const root: Root = createRoot(installMinimalDom());
      await act(async () => {
        root.render(
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "en-US" },
            createElement(SessionPane, {
              paneId: "workspace-main",
              sessionId: "session-1",
              workspacePath: "/workspace",
            }),
          ),
        );
        await flushMicrotasks();
      });
      await act(async () => {
        timelineProps.at(-1)?.onRetry?.({ rowId: 42, entityId: "stale-entity" });
        await flushMicrotasks();
      });
      expect(recoverFromStaleAuthority).toHaveBeenCalledTimes(1);
      await act(async () => root.unmount());
    },
  );

  it("file changes/preview stale authority faults trigger the same projection recovery", async () => {
    const recoverFromStaleAuthority = vi.fn();
    layerMock.acquire.mockReturnValue({
      store: {
        markCommandPending: vi.fn(),
        expectAcceptedInputProjection: vi.fn(),
        onOnlineModelTransition: vi.fn(() => () => {}),
        refreshPlans: vi.fn(async () => {}),
        recoverFromStaleAuthority,
        settleCommand: vi.fn(),
      },
      release: vi.fn(),
    } as never);
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    fileChangesMock.mockRejectedValueOnce(new Error("proto.staleLogEpoch"));
    fileRewindPreviewMock.mockRejectedValueOnce(new Error("proto.staleTarget"));
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });
    const target = { rowId: 42, entityId: "entity-42" };
    await expect(
      timelineProps.at(-1)?.rowContext?.fetchFileChanges?.(target, { cachePolicy: "terminal" }),
    ).rejects.toThrow("proto.staleLogEpoch");
    fileChangesMock.mockResolvedValueOnce(makeEmptyFileChanges());
    await expect(
      timelineProps.at(-1)?.rowContext?.fetchFileChanges?.(target, { cachePolicy: "terminal" }),
    ).resolves.toEqual(makeEmptyFileChanges());
    expect(fileChangesMock).toHaveBeenCalledTimes(2);
    await expect(timelineProps.at(-1)?.rowContext?.previewFileRewind?.(target)).rejects.toThrow(
      "proto.staleTarget",
    );
    expect(recoverFromStaleAuthority).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("while running, provides edit, fork and retry callbacks to the Timeline; row.actions decides display", async () => {
    const snapshot = makeSnapshot();
    snapshot.control = {
      ...snapshot.control,
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      activeWorks: [{ kind: "primaryTurn", startedAt: 1_700_000_000_000 }],
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    const props = timelineProps.at(-1);
    expect(typeof props?.onEdit).toBe("function");
    expect(props?.onFork).toBeTypeOf("function");
    // row.actions is the sole action authority; the Timeline receives a stable resolver and decides per row whether to show retry.
    expect(props?.onRetry).toBeTypeOf("function");

    await act(async () => {
      root.unmount();
    });
  });

  it("dispatches editUserQuery with edited text and original attachments", async () => {
    const attachments: AttachmentRef[] = [
      {
        bytes: 12,
        fileName: "note.txt",
        mime: "text/plain",
        ref: "/workspace/note.txt",
      },
    ];
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    await act(async () => {
      await timelineProps
        .at(-1)
        ?.onEdit?.({ rowId: 42, entityId: "message-user-42" }, "改过的问题", attachments);
    });

    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({
      baseRevision: 7,
      baseLogEpoch: "epoch-1",
      payload: {
        attachments,
        newText: "改过的问题",
        target: { rowId: 42, entityId: "message-user-42" },
      },
      sessionId: "session-1",
      type: "editUserQuery",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("a re-edit re-prepares Highspeed and submits this turn card and runtime with editUserQuery", async () => {
    const snapshot = makeSnapshot();
    snapshot.config = {
      ...snapshot.config,
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const highspeedMeta = {
      schemaVersion: 1 as const,
      cardId: "card-edit",
      taskId: "session-1",
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
    };
    const execution = {
      modelSelection: { providerId: "account:bigmodel-highspeed-card", modelId: "GLM-5.3" },
      requestAuth: {
        apiKey: "card-jwt",
        headers: { Authorization: "Bearer card-jwt", "X-Highspeed-Card-ID": "card-edit" },
      },
      selectionFallback: {
        providerId: "account:bigmodel-highspeed-card",
        rules: [
          { reason: "highspeed_card_expired" as const, providerErrorCode: "3402" },
          { reason: "highspeed_request_failed" as const },
        ],
      },
    };
    servicesMock.highspeedCardService.prepareTurn.mockResolvedValueOnce({
      kind: "accelerated",
      card: highspeedMeta,
      nextDrawAt: highspeedMeta.expiresAt,
      execution,
    });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      await timelineProps
        .at(-1)
        ?.onEdit?.({ rowId: 42, entityId: "message-user-42" }, "重新加速的问题", []);
    });

    expect(servicesMock.highspeedCardService.prepareTurn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "session-1" }),
    );
    expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({
      type: "editUserQuery",
      payload: {
        highspeedMeta,
        // An explicit re-edit draws a new card: the Selection and execution material must be refreshed wholesale and
        // always stay execution-scoped; the session-resident Selection must never switch to the highspeed-card provider.
        modelSelection: execution.modelSelection,
        modelExecution: {
          selectionScope: "execution",
          requestAuth: execution.requestAuth,
          selectionFallback: execution.selectionFallback,
        },
      },
    });
    expect(
      layerMock.acquire.mock.results.at(-1)?.value.store.expectAcceptedInputProjection,
    ).toHaveBeenCalledWith(sendCommandMock.mock.calls[0]?.[0].commandId);

    await act(async () => root.unmount());
  });

  it("sending a Highspeed queue item manually refreshes the same-card runtime before promoting", async () => {
    const snapshot = makeSnapshot();
    const highspeedMeta = {
      schemaVersion: 1 as const,
      cardId: "card-queue",
      taskId: "session-1",
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
    };
    snapshot.queue = {
      autoDrain: false,
      items: [
        {
          sourceCommandId: "source-queue",
          queueItemId: "queue-1",
          clientId: "client-1",
          kind: "sendText",
          text: "排队消息",
          attachments: [],
          delivery: { requested: "queue", admitted: "queue" },
          order: { admissionSeq: 1, queuePosition: 0 },
          steer: { state: "notRequested" },
          dispatch: { state: "queued" },
          admittedAt: 1,
          highspeed: highspeedMeta,
        },
      ],
    };
    snapshot.availability = {
      ...snapshot.availability,
      sendQueuedNow: { allowed: true },
    };
    snapshot.config = {
      ...snapshot.config,
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
    };
    projectionState.current = {
      status: "live",
      snapshot,
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const execution = {
      modelSelection: { providerId: "account:bigmodel-highspeed-card", modelId: "GLM-5.3" },
      requestAuth: {
        apiKey: "card-jwt",
        headers: { Authorization: "Bearer card-jwt", "X-Highspeed-Card-ID": "card-queue" },
      },
      selectionFallback: {
        providerId: "account:bigmodel-highspeed-card",
        rules: [
          { reason: "highspeed_card_expired" as const, providerErrorCode: "3402" },
          { reason: "highspeed_request_failed" as const },
        ],
      },
    };
    servicesMock.highspeedCardService.prepareTurn.mockResolvedValueOnce({
      kind: "accelerated",
      card: highspeedMeta,
      nextDrawAt: highspeedMeta.expiresAt,
      execution,
    });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      queueProps.at(-1)?.onSendNow?.("queue-1");
      await flushMicrotasks();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({
      type: "sendQueuedNow",
      payload: {
        queueItemId: "queue-1",
        highspeedMeta,
        modelSelection: execution.modelSelection,
        modelExecution: {
          selectionScope: "execution",
          requestAuth: execution.requestAuth,
          selectionFallback: execution.selectionFallback,
        },
      },
    });

    await act(async () => root.unmount());
  });

  it("serializes an explicit empty attachment list when edit removes every ref", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    await act(async () => {
      await timelineProps
        .at(-1)
        ?.onEdit?.({ rowId: 42, entityId: "message-user-42" }, "保留正文", []);
    });

    expect(sendCommandMock.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        attachments: [],
        newText: "保留正文",
        target: { rowId: 42, entityId: "message-user-42" },
      },
      type: "editUserQuery",
    });

    await act(async () => root.unmount());
  });

  it("keeps accepted legacy fork-disposition edit ACK on the current session", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    sendCommandMock.mockImplementationOnce(async (envelope: CommandEnvelope) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 7,
      status: "accepted",
      result: {
        type: "editUserQuery",
        disposition: "fork",
        sessionId: "session-child",
      },
    }));
    const onSessionCreated = vi.fn();
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
            onSessionCreated,
          }),
        ),
      );
      await flushMicrotasks();
    });

    await act(async () => {
      await timelineProps
        .at(-1)
        ?.onEdit?.({ rowId: 42, entityId: "message-user-42" }, "edited child text");
    });

    expect(onSessionCreated).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("a duplicate fork ACK navigates to the existing child; edit and failed ACKs never navigate even with a result", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const ack = (
      status: CommandAck["status"],
      type: "forkAssistant" | "editUserQuery",
      sessionId: string,
    ): CommandAck => ({
      commandId: `cmd-${status}-${type}`,
      revisionAtDecision: 7,
      status,
      result:
        type === "forkAssistant" ? { type, sessionId } : { type, disposition: "fork", sessionId },
    });
    sendCommandMock
      .mockResolvedValueOnce(ack("duplicate", "editUserQuery", "session-edit-existing"))
      .mockResolvedValueOnce(ack("duplicate", "forkAssistant", "session-fork-existing"))
      .mockResolvedValueOnce(ack("failed", "editUserQuery", "session-failed"))
      .mockResolvedValueOnce(ack("rejected", "editUserQuery", "session-rejected"))
      .mockResolvedValueOnce(ack("stale", "editUserQuery", "session-stale"));
    const onSessionCreated = vi.fn();
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
            onSessionCreated,
          }),
        ),
      );
      await flushMicrotasks();
    });
    const target = { rowId: 42, entityId: "message-target-42" };
    await act(async () => {
      await timelineProps.at(-1)?.onEdit?.(target, "duplicate edit");
      timelineProps.at(-1)?.onFork?.(target);
      await flushMicrotasks();
      await timelineProps.at(-1)?.onEdit?.(target, "failed edit");
      await timelineProps.at(-1)?.onEdit?.(target, "rejected edit");
      await timelineProps.at(-1)?.onEdit?.(target, "stale edit");
      await flushMicrotasks();
    });

    expect(onSessionCreated.mock.calls).toEqual([["session-fork-existing"]]);
    await act(async () => root.unmount());
  });

  it("does not expose task rename or delete actions in conversation pane chrome", async () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });

    expect(headerProps.at(-1)?.onRename).toBeUndefined();
    expect(headerProps.at(-1)?.onDelete).toBeUndefined();

    await act(async () => {
      root.unmount();
    });
  });
});

describe("SessionPane queue commands after proto.staleRevision (ISSUE-072)", () => {
  function snapshotWithQueue(): ConversationSnapshot {
    const snapshot = makeSnapshot();
    snapshot.queue = {
      autoDrain: true,
      items: [
        {
          sourceCommandId: "source-queue",
          queueItemId: "queue-1",
          clientId: "client-1",
          kind: "sendText",
          text: "qa queue item A",
          attachments: [],
          delivery: { requested: "queue", admitted: "queue" },
          order: { admissionSeq: 1, queuePosition: 0 },
          steer: { state: "notRequested" },
          dispatch: { state: "queued" },
          admittedAt: 1,
        },
      ],
    };
    snapshot.availability = { ...snapshot.availability, sendQueuedNow: { allowed: true } };
    return snapshot;
  }

  function staleAck(envelope: CommandEnvelope, revisionAtDecision: number): CommandAck {
    return {
      commandId: envelope.commandId,
      revisionAtDecision,
      status: "stale",
      reasonCode: "proto.staleRevision",
    };
  }

  async function renderPane(): Promise<Root> {
    projectionState.current = {
      status: "live",
      snapshot: snapshotWithQueue(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(SessionPane, {
            paneId: "workspace-main",
            sessionId: "session-1",
            workspacePath: "/workspace",
          }),
        ),
      );
      await flushMicrotasks();
    });
    return root;
  }

  function queueCalls(type: string): CommandEnvelope[] {
    return sendCommandMock.mock.calls
      .map((call) => call[0] as CommandEnvelope)
      .filter((envelope) => envelope.type === type);
  }

  it("Steer re-sends once at revisionAtDecision and shows no error", async () => {
    sendCommandMock.mockImplementationOnce(async (envelope) => staleAck(envelope, 9));
    const root = await renderPane();
    await act(async () => {
      queueProps.at(-1)?.onSendNow?.("queue-1");
      await flushMicrotasks();
    });

    const calls = queueCalls("sendQueuedNow");
    expect(calls.map((envelope) => envelope.baseRevision)).toEqual([7, 9]);
    expect(calls[1]?.commandId).not.toBe(calls[0]?.commandId);
    expect(toastMock).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("Steer stale twice stops after one retry and tells the user", async () => {
    sendCommandMock
      .mockImplementationOnce(async (envelope) => staleAck(envelope, 9))
      .mockImplementationOnce(async (envelope) => staleAck(envelope, 10));
    const root = await renderPane();
    await act(async () => {
      queueProps.at(-1)?.onSendNow?.("queue-1");
      await flushMicrotasks();
    });

    expect(queueCalls("sendQueuedNow")).toHaveLength(2);
    expect(toastMock).toHaveBeenCalledWith("Couldn't send the queued message now. Try again.");
    await act(async () => root.unmount());
  });

  it("Steer that lost the race to the auto-drain shows no failure toast", async () => {
    sendCommandMock.mockImplementationOnce(async (envelope) => ({
      commandId: envelope.commandId,
      revisionAtDecision: 7,
      status: "failed",
      reasonCode: "guard.queueItemReserved",
    }));
    const root = await renderPane();
    await act(async () => {
      queueProps.at(-1)?.onSendNow?.("queue-1");
      await flushMicrotasks();
    });

    expect(queueCalls("sendQueuedNow")).toHaveLength(1);
    expect(toastMock).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("Edit re-sends the delete once and restores the queued text", async () => {
    sendCommandMock.mockImplementationOnce(async (envelope) => staleAck(envelope, 9));
    const root = await renderPane();
    await act(async () => {
      await queueProps.at(-1)?.onEditItem?.("queue-1");
      await flushMicrotasks();
    });

    expect(queueCalls("deleteQueueItem").map((envelope) => envelope.baseRevision)).toEqual([7, 9]);
    expect(composerProps.at(-1)?.composerRestoreRequest?.text).toBe("qa queue item A");
    expect(toastMock).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("Edit stale twice keeps the item queued, restores nothing and shows the retry toast", async () => {
    sendCommandMock
      .mockImplementationOnce(async (envelope) => staleAck(envelope, 9))
      .mockImplementationOnce(async (envelope) => staleAck(envelope, 10));
    const root = await renderPane();
    await act(async () => {
      await queueProps.at(-1)?.onEditItem?.("queue-1");
      await flushMicrotasks();
    });

    expect(queueCalls("deleteQueueItem")).toHaveLength(2);
    expect(composerProps.at(-1)?.composerRestoreRequest ?? null).toBeNull();
    expect(toastMock).toHaveBeenCalledWith(
      "Couldn't return the queued message to the composer. Try again.",
    );
    await act(async () => root.unmount());
  });

  it("Delete re-sends once at revisionAtDecision", async () => {
    sendCommandMock.mockImplementationOnce(async (envelope) => staleAck(envelope, 9));
    const root = await renderPane();
    await act(async () => {
      queueProps.at(-1)?.onDeleteItem?.("queue-1");
      await flushMicrotasks();
    });

    expect(queueCalls("deleteQueueItem").map((envelope) => envelope.baseRevision)).toEqual([7, 9]);
    await act(async () => root.unmount());
  });
});
