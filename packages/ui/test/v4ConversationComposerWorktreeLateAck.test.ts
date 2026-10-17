// Mounted regression for the late worktree reservation ACK (specs/composer-worktree-setup-steps.md,
// acceptance 15): navigating from draft A to chat B before the reservation ACK resolves must keep
// B active and untouched, while prepared session A and its recovery record survive. The composer
// must hand both preparation branches a callback whose shouldActivate() reads the live submission
// owner (workspace/scope/epoch) at ACK time, so SessionPane never activates a departed draft.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  ConversationComposer,
  type ConversationComposerSendResult,
} from "@/v4/ConversationComposer.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  readV4WorktreeRecoveryDrafts,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import {
  ComposerDraftWorktreeIntentContext,
  type ComposerDraftWorktreeIntent,
  type ComposerWorktreePreparationParams,
} from "@/v4/composer/composerDraftWorktreeIntent.js";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";
import { dispatchConversationSelectionAdd } from "@/lib/conversationSelectionReference.js";
import { dispatchCodeCommentAddToChat } from "@/lib/codeCommentContext.js";

const { attachmentState, chatPromptEditorProps, editorApi } = vi.hoisted(() => ({
  attachmentState: {
    adoptSentAttachments: vi.fn(async () => {}),
    hasUnreadyAttachments: false,
    prepareForSend: vi.fn(async () => []),
  },
  chatPromptEditorProps: [] as Array<Record<string, unknown>>,
  editorApi: {
    clear: vi.fn(),
    setEditorStateJson: vi.fn(),
    setText: vi.fn(),
  },
}));

vi.mock("@/components/ui/dialog.js", async () => {
  const React = await import("react");
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  return {
    Dialog: () => null,
    DialogClose: Passthrough,
    DialogContent: Passthrough,
    DialogDescription: Passthrough,
    DialogFooter: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
  };
});

vi.mock("@/ControlHintTooltip.js", async () => {
  const React = await import("react");
  return {
    ControlHintTooltip: ({ children }: { children?: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("@/components/ui/toast.js", () => ({
  toast: vi.fn(),
}));

vi.mock("@/prompt-editor/ChatPromptEditor.js", async () => {
  const React = await import("react");
  return {
    ChatPromptEditor: (props: Record<string, unknown>) => {
      chatPromptEditorProps.push(props);
      const inputApiRef = props.inputApiRef as
        | { current: Record<string, unknown> | null }
        | undefined;
      if (inputApiRef) {
        inputApiRef.current = {
          clear: editorApi.clear,
          focus: vi.fn(),
          getEditorState: () => null,
          getMarkdown: () => "",
          setEditorStateJson: editorApi.setEditorStateJson,
          setText: editorApi.setText,
        };
      }
      return React.createElement(
        "form",
        { "data-testid": "mock-chat-prompt-editor" },
        props.topContent as ReactNode,
        props.leadingActions as ReactNode,
        props.submitControl as ReactNode,
      );
    },
  };
});

vi.mock("@/components/ai-elements/attachments.js", async () => {
  const React = await import("react");
  const Passthrough = ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
  } & Record<string, unknown>) => React.createElement("div", props, children);
  const Trigger = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  const Span = (props: Record<string, unknown>) => React.createElement("span", props);
  return {
    Attachment: Passthrough,
    AttachmentHoverCard: Passthrough,
    AttachmentHoverCardContent: Passthrough,
    AttachmentHoverCardTrigger: Trigger,
    AttachmentInfo: Span,
    AttachmentPreview: Span,
    AttachmentRemove: (props: Record<string, unknown>) => React.createElement("button", props),
    Attachments: Passthrough,
  };
});

vi.mock("@/v4/composer/useComposerAttachments.js", () => ({
  useComposerAttachments: () => ({
    attachmentError: null,
    adoptSentAttachments: attachmentState.adoptSentAttachments,
    attachmentInputRef: { current: null },
    attachments: [] as unknown[],
    clearAttachments: vi.fn(),
    handleAttachmentInputChange: vi.fn(),
    handleDragLeaveComposer: vi.fn(),
    handleDragOverComposer: vi.fn(),
    handleDropComposer: vi.fn(),
    handlePaste: vi.fn(),
    handleWhiteboardMentionSelected: vi.fn(),
    hasAttachments: false,
    hasUnreadyAttachments: attachmentState.hasUnreadyAttachments,
    isDraggingOverComposer: false,
    openAttachmentPicker: vi.fn(),
    prepareForSend: attachmentState.prepareForSend,
    removeAttachment: vi.fn(),
    retryAttachment: vi.fn(),
    setAttachmentError: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/V4ComposerToolbar.js", async () => {
  const React = await import("react");
  return {
    V4ComposerModeSwitch: () => React.createElement("span", null, "mode"),
    V4ComposerModelControls: () => React.createElement("span", null, "model"),
  };
});

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: Node) => {
      Object.assign(child, { parentNode: element });
      element.childNodes.push(child);
      return child;
    },
    attributes: new Map<string, string>(),
    childNodes: [] as Node[],
    getAttribute: (name: string) => element.attributes.get(name) ?? null,
    insertBefore: (child: Node, beforeChild?: Node | null) => {
      Object.assign(child, { parentNode: element });
      const beforeIndex = beforeChild ? element.childNodes.indexOf(beforeChild) : -1;
      if (beforeIndex >= 0) {
        element.childNodes.splice(beforeIndex, 0, child);
      } else {
        element.childNodes.push(child);
      }
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as Node | null,
    removeAttribute: (name: string) => {
      element.attributes.delete(name);
    },
    removeChild: (child: Node) => {
      element.childNodes = element.childNodes.filter((item) => item !== child);
      Object.assign(child, { parentNode: null });
      return child;
    },
    removeEventListener: () => {},
    setAttribute: (name: string, value: string) => {
      element.attributes.set(name, String(value));
    },
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  } as Storage;
}

function installMinimalDom() {
  const target = new EventTarget();
  const documentMock = {
    addEventListener: () => {},
    createComment: (nodeValue: string) => ({
      nodeType: 8,
      nodeValue,
      parentNode: null,
    }),
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document & { defaultView?: unknown };
  const windowMock = {
    addEventListener: target.addEventListener.bind(target),
    cancelAnimationFrame: () => {},
    clearTimeout,
    dispatchEvent: (event: Event) => target.dispatchEvent(event),
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    localStorage: createStorageMock(),
    matchMedia: () => ({
      addEventListener: () => {},
      addListener: () => {},
      matches: false,
      removeEventListener: () => {},
      removeListener: () => {},
    }),
    Node: function Node() {},
    removeEventListener: target.removeEventListener.bind(target),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    setTimeout,
  };
  documentMock.defaultView = windowMock;
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

function flushAsyncWork() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface LateAckHarness {
  capturedPrepareSession: () =>
    | ((params: ComposerWorktreePreparationParams) => Promise<string>)
    | null;
  onPrepareWorktreeSession: ReturnType<typeof vi.fn>;
  sessionActivated: ReturnType<typeof vi.fn>;
  onSendText: ReturnType<typeof vi.fn>;
  rerender: (sessionId: string | null, draftText?: string) => void;
  resolveReservation: (sessionId: string) => void;
  root: Root;
}

function renderLateAckComposer(): LateAckHarness {
  const container = installMinimalDom();
  const root: Root = createRoot(container);
  const sessionActivated = vi.fn();
  let resolveReservation!: (sessionId: string) => void;
  const reservationAck = new Promise<string>((resolve) => {
    resolveReservation = resolve;
  });
  const captured: {
    prepareSession: ((params: ComposerWorktreePreparationParams) => Promise<string>) | null;
  } = { prepareSession: null };
  // Emulates SessionPane.prepareWorktreeSession: activation of the prepared session is decided
  // when the Host ACK lands, through the composer-provided shouldActivate owner check.
  const onPrepareWorktreeSession = vi.fn(
    async (
      _params: ComposerWorktreePreparationParams,
      options?: { shouldActivate: () => boolean },
    ) => {
      const sessionId = await reservationAck;
      if (!options || options.shouldActivate()) sessionActivated(sessionId);
      return sessionId;
    },
  );
  const intent: ComposerDraftWorktreeIntent = {
    workspaceKey: "/workspace",
    beginCreation: (async (_preview, prepareSession) => {
      captured.prepareSession = prepareSession;
      return controls.beginOutcome;
    }) as ComposerDraftWorktreeIntent["beginCreation"],
  } as ComposerDraftWorktreeIntent;
  const slot = { current: intent };
  const controls = {
    beginOutcome: { ok: true, sessionId: "prepared-session-a" } as
      | {
          ok: true;
          sessionId: string;
        }
      | { ok: false },
    rejectSend: false,
  };
  const onSendText = vi.fn(async () => {
    if (controls.rejectSend) throw new Error("send dispatch failed");
    return {} as ConversationComposerSendResult | void;
  });
  const render = (sessionId: string | null, draftText?: string) => {
    const scopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
    const composerDraft: V4ComposerDraft = draftText
      ? { text: draftText, updatedAt: Date.now() }
      : (readV4ComposerDraft("/workspace", undefined, scopeId) ?? { text: "", updatedAt: 0 });
    return createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        ComposerDraftWorktreeIntentContext.Provider,
        { value: slot },
        createElement(ConversationComposer, {
          draftMode: sessionId === null,
          onSelectModel: vi.fn(),
          onSelectThought: vi.fn(),
          onSendText,
          onPrepareWorktreeSession,
          onStop: vi.fn(),
          onSwitchMode: vi.fn(),
          provider: undefined,
          sessionId,
          snapshot: null,
          composerDraft,
          updateComposerContent: (content: { text: string }) => {
            persistV4ComposerDraft("/workspace", undefined, scopeId, {
              ...composerDraft,
              ...content,
            });
          },
          replaceComposerDraft: (next) => {
            persistV4ComposerDraft("/workspace", undefined, scopeId, {
              ...next,
              updatedAt: Date.now(),
            });
          },
          submissionReady: true,
          workspacePath: "/workspace",
        }),
      ),
    );
  };
  act(() => {
    root.render(render(null));
  });
  return {
    capturedPrepareSession: () => captured.prepareSession,
    controls,
    onPrepareWorktreeSession,
    sessionActivated,
    onSendText,
    rerender: (sessionId, draftText) => {
      // Simulate the user having typed in the target chat: its draft is already persisted.
      if (draftText !== undefined) {
        persistV4ComposerDraft("/workspace", undefined, sessionId ?? V4_DRAFT_SCOPE_ROOT, {
          text: draftText,
        });
      }
      act(() => {
        root.render(render(sessionId, draftText));
      });
    },
    resolveReservation,
    root,
  };
}

afterEach(() => {
  chatPromptEditorProps.length = 0;
  attachmentState.prepareForSend.mockClear();
  editorApi.clear.mockClear();
  editorApi.setText.mockClear();
  editorApi.setEditorStateJson.mockClear();
  useComposerWorktreePipelineStore.setState({ pipelineByWorkspaceKey: {} });
  window.localStorage.clear();
});

describe("late worktree reservation ACK after navigation", () => {
  it("keeps chat B active and untouched; prepared session A and its recovery survive", async () => {
    const harness = renderLateAckComposer();
    // Send from draft A with the worktree intent active.
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("draft A frozen text");
      await flushAsyncWork();
    });
    const prepareSession = harness.capturedPrepareSession();
    expect(prepareSession).toBeTypeOf("function");

    // The Host reservation is in flight; the user navigates from draft A to chat B.
    await act(async () => {
      void prepareSession!({
        workspaceKey: "/workspace",
        branchName: "feature-a",
        targetPath: "/worktrees/feature-a",
        attemptId: "attempt-1",
      });
      await flushAsyncWork();
    });
    harness.rerender("session-b", "text typed in B");

    // The reservation ACK now lands after the navigation.
    await act(async () => {
      harness.resolveReservation("prepared-session-a");
      await flushAsyncWork();
    });

    // B stays the active chat: no activation of the prepared session, no send, and B's draft
    // was not overwritten by the departed submission.
    expect(harness.sessionActivated).not.toHaveBeenCalled();
    expect(harness.onSendText).not.toHaveBeenCalled();
    expect(harness.onPrepareWorktreeSession).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: "feature-a", attemptId: "attempt-1" }),
      expect.objectContaining({ shouldActivate: expect.any(Function) }),
    );
    const draftB = readV4ComposerDraft("/workspace", undefined, "session-b");
    expect(draftB?.text).toBe("text typed in B");

    // Prepared session A remains recoverable with its frozen submission.
    const recoveries = [
      ...readV4WorktreeRecoveryDrafts("/workspace", undefined, "prepared-session-a"),
      ...readV4WorktreeRecoveryDrafts("/workspace", undefined, V4_DRAFT_SCOPE_ROOT),
    ];
    expect(recoveries.some((entry) => entry.draft.text === "draft A frozen text")).toBe(true);
  });

  it("still activates when the reservation ACK lands while the same draft is open", async () => {
    const harness = renderLateAckComposer();
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("draft A frozen text");
      await flushAsyncWork();
    });
    const prepareSession = harness.capturedPrepareSession();
    expect(prepareSession).toBeTypeOf("function");
    await act(async () => {
      void prepareSession!({
        workspaceKey: "/workspace",
        branchName: "feature-a",
        targetPath: "/worktrees/feature-a",
        attemptId: "attempt-1",
      });
      await flushAsyncWork();
    });
    // No navigation: the submission owner still matches, so activation is allowed.
    await act(async () => {
      harness.resolveReservation("prepared-session-a");
      await flushAsyncWork();
    });
    expect(harness.sessionActivated).toHaveBeenCalledWith("prepared-session-a");
  });

  it("stops local delivery when an authoritative Host cancellation discards the pipeline entry", async () => {
    const harness = renderLateAckComposer();
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("draft A frozen text");
      await flushAsyncWork();
    });
    const prepareSession = harness.capturedPrepareSession();
    await act(async () => {
      void prepareSession!({
        workspaceKey: "/workspace",
        branchName: "feature-a",
        targetPath: "/worktrees/feature-a",
        attemptId: "attempt-1",
      });
      await flushAsyncWork();
    });
    await act(async () => {
      harness.resolveReservation("prepared-session-a");
      await flushAsyncWork();
    });
    // The queue is attached; an authoritative Host cancellation discards the entry.
    const store = useComposerWorktreePipelineStore.getState();
    store.startPipeline("/workspace", {
      status: "creating",
      sessionId: "prepared-session-a",
      params: {
        workspacePath: "/workspace",
        branchName: "feature-a",
        targetPath: "/worktrees/feature-a",
        attemptId: "attempt-1",
        baseFromHeadDefault: true,
      },
      queuedPromptPreview: "draft A frozen text",
      createdAt: Date.now(),
    });
    store.discard("/workspace", "prepared-session-a");
    await act(async () => {
      await flushAsyncWork();
    });

    // Delivery stopped: no dispatch, and the frozen submission stays recoverable.
    expect(harness.onSendText).not.toHaveBeenCalled();
    const recoveries = [
      ...readV4WorktreeRecoveryDrafts("/workspace", undefined, "prepared-session-a"),
      ...readV4WorktreeRecoveryDrafts("/workspace", undefined, V4_DRAFT_SCOPE_ROOT),
    ];
    expect(recoveries.some((entry) => entry.draft.text === "draft A frozen text")).toBe(true);
    expect(
      selectComposerWorktreePipeline(
        useComposerWorktreePipelineStore.getState(),
        "/workspace",
        "prepared-session-a",
      )?.status,
    ).toBe("discarded");
  });

  it("captures the frozen submission's contexts in the recovery record", async () => {
    const harness = renderLateAckComposer();
    // Attach a conversation quote and a code comment through the ordinary add paths, then submit.
    await act(async () => {
      dispatchConversationSelectionAdd({
        targetSessionId: null,
        workspaceKey: "/workspace",
        reference: {
          id: "quote-1",
          contentType: "markdown",
          text: "quoted passage",
          path: "docs/readme.md",
          senderName: "dev",
          senderId: "dev",
          messageId: "msg-1",
          sentAt: 1,
          sourceKey: "docs/readme.md",
          sourceTitle: "readme",
        },
      });
      dispatchCodeCommentAddToChat({
        id: "comment-1",
        startLine: 3,
        endLine: 5,
        workspacePath: "/workspace",
        sourcePath: "src/a.ts",
        sourceTitle: "a.ts",
        selectedText: "const a = 1;",
        comment: "looks wrong",
      });
      await flushAsyncWork();
    });
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("frozen with contexts");
      await flushAsyncWork();
    });
    const prepareSession = harness.capturedPrepareSession();
    await act(async () => {
      void prepareSession!({
        workspaceKey: "/workspace",
        branchName: "feature-a",
        targetPath: "/worktrees/feature-a",
        attemptId: "attempt-1",
      });
      await flushAsyncWork();
    });
    await act(async () => {
      harness.resolveReservation("prepared-session-a");
      await flushAsyncWork();
    });

    const recoveries = readV4WorktreeRecoveryDrafts("/workspace", undefined, "prepared-session-a");
    const record = recoveries.find((entry) => entry.draft.text === "frozen with contexts");
    expect(record?.draft.recoveryContexts).toMatchObject({
      conversationQuotes: [expect.objectContaining({ id: "quote-1", text: "quoted passage" })],
      codeComments: [expect.objectContaining({ id: "comment-1", comment: "looks wrong" })],
    });
  });

  it("claims the draft at queue time while the Host reservation is still pending", async () => {
    const harness = renderLateAckComposer();
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("frozen claim text");
      await flushAsyncWork();
    });
    const prepareSession = harness.capturedPrepareSession();
    await act(async () => {
      void prepareSession!({
        workspaceKey: "/workspace",
        branchName: "feature-a",
        targetPath: "/worktrees/feature-a",
        attemptId: "attempt-1",
      });
      await flushAsyncWork();
    });
    // Reservation still pending: the editor is already claimed and the recovery record already
    // persisted; nothing was sent and the composer is not in a busy pending state.
    expect(editorApi.clear).toHaveBeenCalled();
    expect(harness.onSendText).not.toHaveBeenCalled();
    const recoveries = [
      ...readV4WorktreeRecoveryDrafts("/workspace", undefined, "prepared-session-a"),
      ...readV4WorktreeRecoveryDrafts("/workspace", undefined, V4_DRAFT_SCOPE_ROOT),
    ];
    expect(recoveries.some((entry) => entry.draft.text === "frozen claim text")).toBe(true);
  });

  it("restores the claimed submission after a failed reservation without touching newer edits", async () => {
    const harness = renderLateAckComposer();
    harness.controls.beginOutcome = { ok: false };
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("frozen failed text");
      await flushAsyncWork();
    });
    // A newer draft typed after the failed queue must survive the restore untouched.
    await act(async () => {
      (chatPromptEditorProps.at(-1)!.onChange as (value: string) => void)("newer text after claim");
      await flushAsyncWork();
    });
    const draftScope = readV4ComposerDraft("/workspace", undefined, V4_DRAFT_SCOPE_ROOT);
    expect(draftScope?.text).toBe("newer text after claim");
    const recoveries = [
      ...readV4WorktreeRecoveryDrafts("/workspace", undefined, "prepared-session-a"),
      ...readV4WorktreeRecoveryDrafts("/workspace", undefined, V4_DRAFT_SCOPE_ROOT),
    ];
    expect(recoveries.some((entry) => entry.draft.text === "frozen failed text")).toBe(true);
    expect(harness.onSendText).not.toHaveBeenCalled();
  });

  it("dispatches the queued send exactly once on ready with its telemetry seed, consuming only on success", async () => {
    const harness = renderLateAckComposer();
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("queued dispatch text");
      await flushAsyncWork();
    });
    const prepareSession = harness.capturedPrepareSession();
    await act(async () => {
      void prepareSession!({
        workspaceKey: "/workspace",
        branchName: "feature-a",
        targetPath: "/worktrees/feature-a",
        attemptId: "attempt-1",
      });
      await flushAsyncWork();
    });
    await act(async () => {
      harness.resolveReservation("prepared-session-a");
      await flushAsyncWork();
    });
    // Telemetry starts inside the dispatch (after the worktree wait), not at queue time.
    expect(harness.onSendText).not.toHaveBeenCalled();

    const store = useComposerWorktreePipelineStore.getState();
    store.startPipeline("/workspace", {
      status: "creating",
      sessionId: "prepared-session-a",
      params: {
        workspacePath: "/workspace",
        branchName: "feature-a",
        targetPath: "/worktrees/feature-a",
        attemptId: "attempt-1",
        baseFromHeadDefault: true,
      },
      queuedPromptPreview: "queued dispatch text",
      createdAt: Date.now(),
    });
    useComposerWorktreePipelineStore
      .getState()
      .markReady("/workspace", "/worktrees/feature-a", false, "prepared-session-a", "attempt-1");
    await act(async () => {
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(harness.onSendText).toHaveBeenCalledTimes(1);
    const [text, options] = harness.onSendText.mock.calls[0] as [string, Record<string, unknown>];
    expect(text).toBe("queued dispatch text");
    expect(options).toMatchObject({
      executionWorktree: { path: "/worktrees/feature-a", branchName: "feature-a" },
      preparedSessionId: "prepared-session-a",
      telemetrySeed: expect.objectContaining({ sendTime: expect.any(Number) }),
    });
    // Exactly-once success: the pipeline entry is consumed after the accepted dispatch.
    expect(
      selectComposerWorktreePipeline(
        useComposerWorktreePipelineStore.getState(),
        "/workspace",
        "prepared-session-a",
      )?.status,
    ).toBe("consumed");
  });

  it("keeps the pipeline entry ready when the queued dispatch fails, with the submission recoverable", async () => {
    const harness = renderLateAckComposer();
    harness.controls.rejectSend = true;
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("queued failing text");
      await flushAsyncWork();
    });
    const prepareSession = harness.capturedPrepareSession();
    await act(async () => {
      void prepareSession!({
        workspaceKey: "/workspace",
        branchName: "feature-a",
        targetPath: "/worktrees/feature-a",
        attemptId: "attempt-1",
      });
      await flushAsyncWork();
    });
    await act(async () => {
      harness.resolveReservation("prepared-session-a");
      await flushAsyncWork();
    });
    const store = useComposerWorktreePipelineStore.getState();
    store.startPipeline("/workspace", {
      status: "ready",
      sessionId: "prepared-session-a",
      worktreePath: "/worktrees/feature-a",
      params: {
        workspacePath: "/workspace",
        branchName: "feature-a",
        targetPath: "/worktrees/feature-a",
        attemptId: "attempt-1",
        baseFromHeadDefault: true,
      },
      queuedPromptPreview: "queued failing text",
      createdAt: Date.now(),
    });
    await act(async () => {
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(harness.onSendText).toHaveBeenCalledTimes(1);
    expect(
      selectComposerWorktreePipeline(
        useComposerWorktreePipelineStore.getState(),
        "/workspace",
        "prepared-session-a",
      )?.status,
    ).toBe("ready");
    const recoveries = readV4WorktreeRecoveryDrafts("/workspace", undefined, "prepared-session-a");
    expect(recoveries.some((entry) => entry.draft.text === "queued failing text")).toBe(true);
  });
});
