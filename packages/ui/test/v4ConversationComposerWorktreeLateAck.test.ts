// Mounted regression for the late worktree reservation ACK (specs/composer-worktree-setup-steps.md,
// acceptance 15): navigating from draft A to chat B before the reservation ACK resolves must keep
// B active and untouched, while prepared session A and its recovery record survive. The composer
// must hand both preparation branches a callback whose shouldActivate() reads the live submission
// owner (workspace/scope/epoch) at ACK time, so SessionPane never activates a departed draft.
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  readV4WorktreeRecoveryDrafts,
  V4_DRAFT_SCOPE_ROOT,
  V4_WORKTREE_RECOVERY_PENDING_SCOPE,
} from "@/v4/composer/composerDraftStore.js";
import { useWorktreeFailureReturnStore } from "@/store/worktreeFailureReturnStore.js";
import { useDraftBranchIntentStore } from "@/v4/composer/draftBranchIntent.js";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";
import { dispatchConversationSelectionAdd } from "@/lib/conversationSelectionReference.js";
import { dispatchCodeCommentAddToChat } from "@/lib/codeCommentContext.js";
import {
  flushAsyncWork,
  replaceComposerDraftSpy,
  renderLateAckComposer,
  ROOT_DRAFT_SCOPE,
} from "./v4ConversationComposerLateAckHarness.js";

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

// The draft owner (useDraftConfigControl) reads the session service and settings hooks; this suite
// has no ServiceProvider, so both are stubbed. The owner's write paths are exercised unchanged.
vi.mock("@/hooks/useZCodeSessionService.js", () => ({
  useZCodeSessionService: () => ({}),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: {} }),
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

afterEach(() => {
  vi.useRealTimers();
  chatPromptEditorProps.length = 0;
  attachmentState.prepareForSend.mockClear();
  editorApi.clear.mockClear();
  editorApi.setText.mockClear();
  editorApi.setEditorStateJson.mockClear();
  useComposerWorktreePipelineStore.setState({ pipelineByWorkspaceKey: {} });
  window.localStorage.clear();
});

describe("late worktree reservation ACK after navigation", () => {
  it("restores the plan state and only the record named by the failure return (Butb, But1)", async () => {
    useWorktreeFailureReturnStore.setState({
      restoreRequestByWorkspaceKey: {},
      restoreScopeByWorkspaceKey: {},
    });
    // Storage is reachable only once the composer harness has installed its DOM, so mount first.
    renderLateAckComposer();
    const olderScope = `${V4_WORKTREE_RECOVERY_PENDING_SCOPE}:submission-older`;
    const failedScope = `${V4_WORKTREE_RECOVERY_PENDING_SCOPE}:submission-failed`;
    persistV4ComposerDraft("/workspace", undefined, olderScope, {
      text: "older failed text",
      mode: "build",
      planEnabled: false,
    });
    persistV4ComposerDraft("/workspace", undefined, failedScope, {
      text: "latest failed text",
      mode: "build",
      planEnabled: false,
      worktreeIntent: {
        branchName: "feature-frozen",
        baseBranch: "main",
        customLocationPath: "/custom/frozen",
      },
    });
    // The current draft is in Plan mode; the frozen submission was not.
    persistV4ComposerDraft(
      "/workspace",
      undefined,
      V4_DRAFT_SCOPE_ROOT,
      {
        text: "",
        mode: "build",
        planEnabled: true,
      },
      ROOT_DRAFT_SCOPE,
    );
    replaceComposerDraftSpy.mockClear();
    await act(async () => {
      useWorktreeFailureReturnStore.getState().requestDraftRestore("/workspace", failedScope);
      await flushAsyncWork();
    });
    // The restore runs in a later animation frame, after the scope-switch restore.
    await vi.waitFor(() => {
      // The frozen plan state replaces the live one (updateComposerContent would keep Plan mode on).
      expect(replaceComposerDraftSpy).toHaveBeenCalledWith(
        expect.objectContaining({ text: "latest failed text", planEnabled: false, mode: "build" }),
      );
    });
    // Retry re-creates the frozen branch at the frozen location, not a newly generated name.
    expect(
      useDraftBranchIntentStore.getState().frozenWorktreeIntentByWorkspaceKey["/workspace"],
    ).toEqual({
      branchName: "feature-frozen",
      customLocationPath: "/custom/frozen",
    });
    expect(useDraftBranchIntentStore.getState().intentByWorkspaceKey["/workspace"]).toBe("main");
    expect(readV4ComposerDraft("/workspace", undefined, failedScope)).toBeNull();
    expect(readV4ComposerDraft("/workspace", undefined, olderScope)?.text).toBe(
      "older failed text",
    );
  });

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

  it("restores the frozen submission inline after a failed reservation when the editor is empty", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = renderLateAckComposer();
    harness.controls.beginOutcome = { ok: false };
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("frozen failed text");
      await vi.advanceTimersByTimeAsync(0);
    });
    // Validation failures before a session exists keep the draft in the editor, not on a card.
    const recoveries = [
      ...readV4WorktreeRecoveryDrafts("/workspace", undefined, "prepared-session-a"),
      ...readV4WorktreeRecoveryDrafts("/workspace", undefined, V4_DRAFT_SCOPE_ROOT),
    ];
    expect(recoveries.some((entry) => entry.draft.text === "frozen failed text")).toBe(false);
    // Text typed after the restore is ordinary draft input.
    await act(async () => {
      (chatPromptEditorProps.at(-1)!.onChange as (value: string) => void)("newer text after claim");
      await vi.advanceTimersByTimeAsync(0);
    });
    // Typed text is staged until the 350ms silence window closes (docs/ui/task-scoped-composer-drafts.md).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    const draftScope = readV4ComposerDraft(
      "/workspace",
      undefined,
      V4_DRAFT_SCOPE_ROOT,
      ROOT_DRAFT_SCOPE,
    );
    expect(draftScope?.text).toBe("newer text after claim");
    expect(harness.onSendText).not.toHaveBeenCalled();
  });

  it("keeps the frozen submission on the recovery card when text was typed during the reservation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = renderLateAckComposer();
    harness.controls.beginOutcome = { ok: false };
    // Let the mount-time scope restore land before typing; otherwise its pending window drops the change.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("frozen failed text");
      // Typed while the reservation is still pending: the failure must not overwrite it.
      (chatPromptEditorProps.at(-1)!.onChange as (value: string) => void)("typed during wait");
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    const draftScope = readV4ComposerDraft(
      "/workspace",
      undefined,
      V4_DRAFT_SCOPE_ROOT,
      ROOT_DRAFT_SCOPE,
    );
    expect(draftScope?.text).toBe("typed during wait");
    const recoveries = [
      ...readV4WorktreeRecoveryDrafts("/workspace", undefined, "prepared-session-a"),
      ...readV4WorktreeRecoveryDrafts("/workspace", undefined, V4_DRAFT_SCOPE_ROOT),
    ];
    expect(recoveries.some((entry) => entry.draft.text === "frozen failed text")).toBe(true);
    expect(harness.onSendText).not.toHaveBeenCalled();
  });
});
