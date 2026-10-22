import { useDraftIncognitoIntentStore } from "@/v4/composer/draftIncognitoIntent.js";
import { useDraftBranchIntentStore } from "@/v4/composer/draftBranchIntent.js";
import { isV4FirstSubmissionActive } from "@/v4/composer/composerDraftStore.js";
import { INCOGNITO_LOCKDOWN_PROFILE } from "@zcode/shared";
// Mounted regression for the late worktree reservation ACK: dispatch of the queued send, failed
// dispatch, and Retry of the frozen submission (specs/composer-worktree-setup-steps.md, acceptance 15
// and the retry scenarios). Split from v4ConversationComposerWorktreeLateAck.test.ts for file size.
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getV4ComposerDraftStorageKey,
  getV4WorktreeRecoveryScope,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  readV4WorktreeRecoveryDrafts,
  V4_WORKTREE_RECOVERY_PENDING_SCOPE,
} from "@/v4/composer/composerDraftStore.js";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";
import { useWorktreeFailureReturnStore } from "@/store/worktreeFailureReturnStore.js";
import {
  findReactPropsByTestId,
  flushAsyncWork,
  replaceComposerDraftSpy,
  renderLateAckComposer,
} from "./v4ConversationComposerLateAckHarness.js";

const { attachmentState, chatPromptEditorProps, editorApi } = vi.hoisted(() => ({
  attachmentState: {
    adoptSentAttachments: vi.fn(async () => {}),
    hasUnreadyAttachments: false,
    attachments: [] as Array<{
      id: string;
      uploadStatus: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
    }>,
    reuploadForSession: vi.fn(async () => []),
    prepareForSend: vi.fn(async () => []),
  },
  chatPromptEditorProps: [] as Array<Record<string, unknown>>,
  editorApi: {
    clear: vi.fn(),
    setEditorStateJson: vi.fn(),
    setText: vi.fn(),
  },
}));

// Draft branch intent wiring (checkout guard) and the unsettled-submission ledger: off by default,
// armed per test through these hoisted handles.
const branchIntentWiring = vi.hoisted(() => ({
  gitService: null as null | {
    getLocalBranches: () => Promise<{ currentBranchName: string | null }>;
    switchBranch: () => Promise<{ ok: true }>;
  },
  guard: null as null | (() => Promise<boolean>),
}));
vi.mock("@/hooks/useWorkspaceServices.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useWorkspaceServices.js")>()),
  useOptionalWorkspaceServicesResolution: () =>
    branchIntentWiring.gitService
      ? { services: { gitService: branchIntentWiring.gitService } }
      : null,
}));
vi.mock("@/v4/composer/branchSwitchGuard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/v4/composer/branchSwitchGuard.js")>()),
  useBranchSwitchGuard: () => branchIntentWiring.guard ?? undefined,
}));
const ledger = vi.hoisted(() => ({
  tracked: [] as Array<{ scopeKey: string; commandId: string }>,
}));
vi.mock("@/v4/composer/composerSubmissionSettlement.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/v4/composer/composerSubmissionSettlement.js")>();
  return {
    ...actual,
    trackUnsettledComposerSubmission: (
      scopeKey: string,
      submission: { commandId: string; text: string },
    ) => {
      ledger.tracked.push({ scopeKey, commandId: submission.commandId });
      actual.trackUnsettledComposerSubmission(scopeKey, submission);
    },
  };
});

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
    attachments: attachmentState.attachments,
    clearAttachments: vi.fn(),
    handleAttachmentInputChange: vi.fn(),
    handleDragLeaveComposer: vi.fn(),
    handleDragOverComposer: vi.fn(),
    handleDropComposer: vi.fn(),
    handlePaste: vi.fn(),
    handleWhiteboardMentionSelected: vi.fn(),
    hasAttachments: attachmentState.attachments.length > 0,
    hasUnreadyAttachments: attachmentState.hasUnreadyAttachments,
    isDraggingOverComposer: false,
    openAttachmentPicker: vi.fn(),
    prepareForSend: attachmentState.prepareForSend,
    reuploadForSession: attachmentState.reuploadForSession,
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
  branchIntentWiring.gitService = null;
  branchIntentWiring.guard = null;
  ledger.tracked.length = 0;
  useDraftBranchIntentStore.setState({ intentByWorkspaceKey: {} });
  chatPromptEditorProps.length = 0;
  attachmentState.prepareForSend.mockClear();
  attachmentState.attachments = [];
  attachmentState.hasUnreadyAttachments = false;
  attachmentState.reuploadForSession.mockClear();
  editorApi.clear.mockClear();
  editorApi.setText.mockClear();
  editorApi.setEditorStateJson.mockClear();
  useComposerWorktreePipelineStore.setState({ pipelineByWorkspaceKey: {} });
  window.localStorage.clear();
});

describe("late worktree reservation ACK: dispatch and retry", () => {
  it("marks the saved submission as not restored when the draft becomes occupied before restore", async () => {
    useWorktreeFailureReturnStore.setState({
      modalByWorkspaceKey: {},
      restoreRequestByWorkspaceKey: {},
      restoreScopeByWorkspaceKey: {},
    });
    replaceComposerDraftSpy.mockClear();
    const harness = renderLateAckComposer();
    const recoveryScope = `${V4_WORKTREE_RECOVERY_PENDING_SCOPE}:submission-late-occupancy`;
    persistV4ComposerDraft("/workspace", undefined, recoveryScope, {
      text: "frozen submission",
      worktreeIntent: { branchName: "feature-frozen" },
    });
    await act(async () => {
      useWorktreeFailureReturnStore.getState().openFailureModal("/workspace", {
        workspacePath: "/workspace",
        sessionId: "failed-session",
        submissionId: "submission-late-occupancy",
        issueCode: "git-unavailable",
        message: "Could not create the worktree",
        rawDetail: null,
        savedAt: Date.now(),
      });
      harness.rerender(null, "new draft text");
    });

    await act(async () => {
      useWorktreeFailureReturnStore.getState().requestDraftRestore("/workspace", recoveryScope);
      await flushAsyncWork();
    });

    expect(
      useWorktreeFailureReturnStore.getState().modalByWorkspaceKey["/workspace"]?.savedNotRestored,
    ).toBe(true);
    expect(readV4ComposerDraft("/workspace", undefined, recoveryScope)?.text).toBe(
      "frozen submission",
    );
    expect(replaceComposerDraftSpy).not.toHaveBeenCalled();
    harness.root.unmount();
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

  it("keeps the queued worktree submission armed through the editor's clear echo (revision noise)", async () => {
    const harness = renderLateAckComposer();
    // Emulate a slow Host preparation ACK: the queued draft is claimed, then the editor's
    // asynchronous clear echo (or next-draft typing) lands while creation is still pending.
    let releaseBegin!: () => void;
    const beginGate = new Promise<void>((resolve) => {
      releaseBegin = resolve;
    });
    harness.controls.beginGate = { promise: beginGate, resolve: releaseBegin };
    try {
      await act(async () => {
        chatPromptEditorProps.at(-1)!.onSubmit!("queued echo text");
        await flushAsyncWork();
      });
      await act(async () => {
        (chatPromptEditorProps.at(-1)!.onChange as (text: string) => void)("");
        await flushAsyncWork();
      });
      await act(async () => {
        releaseBegin();
        await flushAsyncWork();
      });
      expect(harness.onSendText).not.toHaveBeenCalled();

      useComposerWorktreePipelineStore.getState().startPipeline("/workspace", {
        status: "creating",
        sessionId: "prepared-session-a",
        params: {
          workspacePath: "/workspace",
          branchName: "feature-a",
          targetPath: "/worktrees/feature-a",
          attemptId: "attempt-1",
          baseFromHeadDefault: true,
        },
        queuedPromptPreview: "queued echo text",
        createdAt: Date.now(),
      });
      useComposerWorktreePipelineStore
        .getState()
        .markReady("/workspace", "/worktrees/feature-a", false, "prepared-session-a", "attempt-1");
      await act(async () => {
        await flushAsyncWork();
        await flushAsyncWork();
      });

      // The clear echo is revision noise on an already-claimed draft, not an ownership change
      // (specs/first-submission-lifecycle.md rule 7): the submission stays armed and dispatches
      // on ready instead of becoming a "Failed to send" recovery record.
      expect(harness.onSendText).toHaveBeenCalledTimes(1);
      expect(harness.onSendText.mock.calls[0]![0]).toBe("queued echo text");
    } finally {
      await act(async () => harness.root.unmount());
    }
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

  it("keeps the frozen send armed across failure so Retry dispatches it exactly once", async () => {
    const harness = renderLateAckComposer();
    const paramsFor = (attemptId: string) => ({
      workspacePath: "/workspace",
      branchName: "feature-a",
      targetPath: "/worktrees/feature-a",
      attemptId,
      baseFromHeadDefault: true,
    });
    // The pipeline exists when the send is queued, as in production.
    const store = useComposerWorktreePipelineStore.getState();
    store.startPipeline("/workspace", {
      status: "creating",
      sessionId: "prepared-session-a",
      params: paramsFor("attempt-1"),
      queuedPromptPreview: "frozen retry text",
      createdAt: Date.now(),
    });
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("frozen retry text");
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
    store.markFailed("/workspace", "EACCES", "prepared-session-a", "attempt-1");
    await act(async () => {
      await flushAsyncWork();
    });
    // Failure never dispatches; the frozen message stays recoverable for the user.
    expect(harness.onSendText).not.toHaveBeenCalled();
    expect(
      readV4WorktreeRecoveryDrafts("/workspace", undefined, "prepared-session-a").some(
        (entry) => entry.draft.text === "frozen retry text",
      ),
    ).toBe(true);

    // Retry restarts the same prepared session under a new attempt id and settles ready.
    harness.onSendText.mockImplementationOnce(async (_text, options) => {
      (options as { onCommandCreated?: (id: string) => void })?.onCommandCreated?.(
        "accepted-retry-input",
      );
    });
    useComposerWorktreePipelineStore.getState().startPipeline("/workspace", {
      status: "creating",
      sessionId: "prepared-session-a",
      params: paramsFor("attempt-2"),
      queuedPromptPreview: "frozen retry text",
      createdAt: Date.now(),
    });
    await act(async () => {
      await flushAsyncWork();
    });
    useComposerWorktreePipelineStore
      .getState()
      .markReady("/workspace", "/worktrees/feature-a", false, "prepared-session-a", "attempt-2");
    await act(async () => {
      await flushAsyncWork();
      await flushAsyncWork();
    });

    expect(harness.onSendText).toHaveBeenCalledTimes(1);
    const [text, options] = harness.onSendText.mock.calls[0] as [string, Record<string, unknown>];
    expect(text).toBe("frozen retry text");
    expect(options).toMatchObject({
      executionWorktree: { path: "/worktrees/feature-a", branchName: "feature-a" },
      preparedSessionId: "prepared-session-a",
      preparedAttemptId: "attempt-2",
    });
    // ACK alone cannot remove the preview before the authoritative user/queue projection arrives.
    expect(readV4WorktreeRecoveryDrafts("/workspace", undefined, "prepared-session-a")).toEqual([
      expect.objectContaining({
        draft: expect.objectContaining({
          text: "frozen retry text",
          firstSubmission: expect.objectContaining({
            commandId: "accepted-retry-input",
            status: "sending",
          }),
        }),
      }),
    ]);
  });
});

it.each(["waitingSession", "uploading", "committing", "failed"])(
  "incognito first send admits only waiting-session attachments: %s",
  async (uploadStatus) => {
    attachmentState.attachments = [
      {
        id: "frozen-image",
        uploadStatus,
        filename: "image.png",
        mimeType: "image/png",
        sizeBytes: 10,
      },
    ];
    attachmentState.hasUnreadyAttachments = true;
    useDraftIncognitoIntentStore.getState().activate("/workspace", INCOGNITO_LOCKDOWN_PROFILE);
    const harness = renderLateAckComposer({ worktree: false });
    try {
      await act(async () => {
        chatPromptEditorProps.at(-1)!.onSubmit!("image question");
        await flushAsyncWork();
      });
      if (uploadStatus === "waitingSession") {
        expect(harness.onSendText).toHaveBeenCalledOnce();
        const options = (harness.onSendText.mock.calls as unknown[][])[0]?.[1] as unknown as {
          incognito: unknown;
          reuploadAttachmentsForSession: (id: string) => Promise<unknown>;
        };
        expect(options.incognito).toEqual(INCOGNITO_LOCKDOWN_PROFILE);
        expect(attachmentState.prepareForSend).toHaveBeenCalledWith(undefined, {
          allowWaitingSession: true,
        });
        await options.reuploadAttachmentsForSession("created-incognito");
        expect(attachmentState.reuploadForSession).toHaveBeenCalledWith("created-incognito", [
          "frozen-image",
        ]);
      } else expect(harness.onSendText).not.toHaveBeenCalled();
    } finally {
      useDraftIncognitoIntentStore.getState().deactivate("/workspace");
      await act(async () => harness.root.unmount());
    }
  },
);

it("keeps the draft, files and incognito intent after deferred upload rejection", async () => {
  attachmentState.attachments = [
    {
      id: "failed-image",
      uploadStatus: "waitingSession",
      filename: "image.png",
      mimeType: "image/png",
      sizeBytes: 10,
    },
  ];
  attachmentState.hasUnreadyAttachments = true;
  useDraftIncognitoIntentStore.getState().activate("/workspace", INCOGNITO_LOCKDOWN_PROFILE);
  const harness = renderLateAckComposer({ worktree: false });
  harness.onSendText.mockRejectedValueOnce(new Error("attachment upload failed"));
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("keep this question");
      await flushAsyncWork();
    });
    expect(harness.onSendText).toHaveBeenCalledOnce();
    expect(attachmentState.attachments).toHaveLength(1);
    // Claim-at-freeze (IUX01): the editor clears in the submit commit itself; the rejection
    // below must still keep the frozen draft, files and intent recoverable.
    expect(editorApi.clear).toHaveBeenCalled();
    expect(
      useDraftIncognitoIntentStore.getState().captureForSubmission("/workspace")?.profile,
    ).toEqual(INCOGNITO_LOCKDOWN_PROFILE);
  } finally {
    useDraftIncognitoIntentStore.getState().deactivate("/workspace");
    await act(async () => harness.root.unmount());
  }
});

it("keeps one frozen first input while the real reservation is pending and binds it before dispatch", async () => {
  let resolve!: (id: string) => void;
  const prepare = vi.fn<
    NonNullable<
      import("@/v4/ConversationComposer.js").ConversationComposerProps["onPrepareFirstSubmission"]
    >
  >(async (params) => {
    params.onReservationCreated?.({
      sessionId: "generic-reserved",
      commandId: "original-reservation",
    });
    return new Promise<string>((done) => {
      resolve = done;
    });
  });
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("Original message");
      await flushAsyncWork();
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(harness.onSendText).not.toHaveBeenCalled();
    // The envelope moment moves the frozen record into the reserved session scope (P2 bind):
    // the draft scope no longer holds it while the Host reservation is still pending.
    const pending = readV4WorktreeRecoveryDrafts("/workspace", undefined, "generic-reserved")[0]!;
    expect(pending.draft.text).toBe("Original message");
    expect(pending.draft.firstSubmission?.reservation).toEqual({
      sessionId: "generic-reserved",
      commandId: "original-reservation",
    });
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("Original message");
      await flushAsyncWork();
    });
    expect(prepare).toHaveBeenCalledOnce();
    await act(async () => {
      resolve("generic-reserved");
      await flushAsyncWork();
    });
    expect(harness.onSendText).toHaveBeenCalledOnce();
    expect(harness.onSendText.mock.calls[0]?.[1]).toMatchObject({
      reservedSubmissionSessionId: "generic-reserved",
      firstSubmissionId: pending.draft.firstSubmission!.submissionId,
    });
    expect(
      readV4WorktreeRecoveryDrafts("/workspace", undefined, "generic-reserved")[0]?.draft.text,
    ).toBe("Original message");
  } finally {
    await act(async () => harness.root.unmount());
  }
});

it.each([false, true])(
  "freezes a recoverable first submission before awaiting the send route, incognito=%s (FSL01)",
  async (incognito) => {
    if (incognito) {
      useDraftIncognitoIntentStore.getState().activate("/workspace", INCOGNITO_LOCKDOWN_PROFILE);
    }
    const harness = renderLateAckComposer({ worktree: false });
    let settleSend!: () => void;
    harness.onSendText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settleSend = resolve;
        }),
    );
    const text = "First line\nSecond line\nThird line\nFourth line\nFifth line";
    try {
      await act(async () => {
        chatPromptEditorProps.at(-1)!.onSubmit!(text);
        await flushAsyncWork();
      });
      expect(harness.onSendText).toHaveBeenCalledOnce();
      const pending = readV4WorktreeRecoveryDrafts("/workspace", undefined, "__draft__").find(
        (record) => record.draft.firstSubmission,
      );
      expect(pending?.draft).toMatchObject({
        text,
        firstSubmission: {
          submissionId: expect.any(String),
          ownerKey: expect.any(String),
          status: "preparing",
          ...(incognito ? { incognito: INCOGNITO_LOCKDOWN_PROFILE } : {}),
        },
      });
    } finally {
      settleSend?.();
      await act(async () => {
        await flushAsyncWork();
        harness.root.unmount();
      });
      useDraftIncognitoIntentStore.getState().deactivate("/workspace");
    }
  },
);

it("binds the reserved session at the reservation identity, before the send resolves (FSL01 owner stability)", async () => {
  // The draft is claimed at freeze, so promoting when the reservation identity arrives can no
  // longer abort the send through the "Submission owner changed" guard. The bind happens at
  // the createSession envelope moment (single P2 write point, specs/first-submission-instant-
  // ux.md), moves the frozen record into the session scope, and is not repeated after the send.
  const onFirstSubmissionReserved = vi.fn();
  const harness = renderLateAckComposer({
    worktree: false,
    onPrepareFirstSubmission: async ({ onReservationCreated }) => {
      onReservationCreated?.({ sessionId: "session-reserved-bind", commandId: "envelope-command" });
      return "session-reserved-bind";
    },
    onFirstSubmissionReserved,
  });
  let settleSend!: () => void;
  harness.onSendText.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        settleSend = resolve;
      }),
  );
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("Promote at the reservation identity");
      await flushAsyncWork();
    });
    expect(harness.onSendText).toHaveBeenCalledOnce();
    expect(onFirstSubmissionReserved).toHaveBeenCalledWith("session-reserved-bind");
    expect(
      readV4WorktreeRecoveryDrafts("/workspace", undefined, "session-reserved-bind").filter(
        (record) => record.draft.firstSubmission,
      ),
    ).toHaveLength(1);

    // The pane promoting to the bound session must not abort the in-flight send: the draft
    // was claimed at freeze, before any owner/scope switch.
    harness.rerender("session-reserved-bind");
    await act(async () => {
      settleSend();
      await flushAsyncWork();
    });
    expect(onFirstSubmissionReserved).toHaveBeenCalledTimes(1);
    const record = readV4WorktreeRecoveryDrafts(
      "/workspace",
      undefined,
      "session-reserved-bind",
    ).find((entry) => entry.draft.firstSubmission);
    expect(record?.draft.firstSubmission).toMatchObject({ status: expect.any(String) });
    expect(record?.draft.firstSubmission?.status).not.toBe("failed");
  } finally {
    settleSend?.();
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("falls back to binding after the send resolves when no reservation identity callback fired", async () => {
  // Pane-level prepare implementations that never call onReservationCreated keep the old
  // contract: the returned session id binds after admission, exactly once.
  const onFirstSubmissionReserved = vi.fn();
  const harness = renderLateAckComposer({
    worktree: false,
    onPrepareFirstSubmission: async () => "session-reserved-bind",
    onFirstSubmissionReserved,
  });
  let settleSend!: () => void;
  harness.onSendText.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        settleSend = resolve;
      }),
  );
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("Fallback bind after admission");
      await flushAsyncWork();
    });
    expect(harness.onSendText).toHaveBeenCalledOnce();
    expect(onFirstSubmissionReserved).not.toHaveBeenCalled();
    await act(async () => {
      settleSend();
      await flushAsyncWork();
    });
    expect(onFirstSubmissionReserved).toHaveBeenCalledWith("session-reserved-bind");
    expect(
      readV4WorktreeRecoveryDrafts("/workspace", undefined, "session-reserved-bind").filter(
        (record) => record.draft.firstSubmission,
      ),
    ).toHaveLength(1);
  } finally {
    settleSend?.();
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("keeps the composer free and the frozen record stable while the send chain is in flight (IUX01/IUX03)", async () => {
  const harness = renderLateAckComposer({
    worktree: false,
    onPrepareFirstSubmission: async ({ onReservationCreated }) => {
      onReservationCreated?.({ sessionId: "session-in-flight", commandId: "cmd-in-flight" });
      return "session-in-flight";
    },
  });
  let settleSend!: () => void;
  harness.onSendText.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        settleSend = resolve;
      }),
  );
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("first frozen message");
      await flushAsyncWork();
    });
    expect(harness.onSendText).toHaveBeenCalledTimes(1);
    // Claim-at-freeze: the editable draft is empty in the submit commit itself, so the
    // composer is free for the next draft while reservation/uploads/send are in flight.
    expect(readV4ComposerDraft("/workspace", undefined, "__draft__")?.text ?? "").toBe("");
    const record = readV4WorktreeRecoveryDrafts("/workspace", undefined, "session-in-flight")[0];
    expect(record?.draft.text).toBe("first frozen message");
    expect(record?.draft.firstSubmission?.status).not.toBe("failed");

    await act(async () => {
      settleSend();
      await flushAsyncWork();
    });
    // Settlement cannot erase or restore over the frozen submission (FSL rule 7): the
    // record stays admitted-side and the editable draft stays free.
    expect(readV4ComposerDraft("/workspace", undefined, "__draft__")?.text ?? "").toBe("");
    const settled = readV4WorktreeRecoveryDrafts("/workspace", undefined, "session-in-flight")[0];
    expect(settled?.draft.text).toBe("first frozen message");
    expect(settled?.draft.firstSubmission?.status).not.toBe("failed");
  } finally {
    settleSend?.();
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a repeat of the same submission dispatches nothing new; a new draft after the bind dispatches (IUX02)", async () => {
  const prepare = vi.fn<
    NonNullable<
      import("@/v4/ConversationComposer.js").ConversationComposerProps["onPrepareFirstSubmission"]
    >
  >(async ({ onReservationCreated }) => {
    onReservationCreated?.({ sessionId: "session-double-click", commandId: "cmd-double" });
    return "session-double-click";
  });
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  let settleSend!: () => void;
  harness.onSendText.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        settleSend = resolve;
      }),
  );
  try {
    // Leg 1 — double click: the second submit carries the same text and no editor change
    // happened since the claim, so it is the same submission even though the bind already
    // released the repeat-submit ref.
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("double click me");
      chatPromptEditorProps.at(-1)!.onSubmit!("double click me");
      await flushAsyncWork();
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(harness.onSendText).toHaveBeenCalledTimes(1);
    expect(
      readV4WorktreeRecoveryDrafts("/workspace", undefined, "session-double-click").filter(
        (entry) => entry.draft.firstSubmission,
      ),
    ).toHaveLength(1);

    // Leg 2 — the pane bound to the reserved session and the user typed a genuinely new draft
    // while the first sendText is still in flight: it takes the ordinary send path.
    harness.rerender("session-double-click");
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("second message");
      chatPromptEditorProps.at(-1)!.onSubmit!("second message");
      await flushAsyncWork();
    });
    expect(harness.onSendText).toHaveBeenCalledTimes(2);
    expect(harness.onSendText.mock.calls[1]?.[0]).toBe("second message");
    expect(harness.onSendText.mock.calls[1]?.[1]).not.toHaveProperty("firstSubmissionId");
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally {
    settleSend?.();
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a second Send waits visibly while the bound session still prepares the frozen submission", async () => {
  const harness = renderLateAckComposer({ worktree: false });
  harness.controls.snapshot = {
    protocolVersion: 1,
    sessionId: "session-preparing",
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
    meta: {
      title: "",
      titleSource: "firstInput",
      submissionPreparation: {
        submissionId: "sub-preparing",
        status: "preparing",
        createdAt: 1,
        updatedAt: 1,
      },
    },
    config: { provider: "p", model: "m", thought: "medium", followupMode: "queue", mode: "build" },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  } as unknown as NonNullable<typeof harness.controls.snapshot>;
  try {
    harness.rerender("session-preparing");
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("too early");
      await flushAsyncWork();
    });
    // The ordering barrier stays (a foreign input admitted first would make activation report
    // input-admitted for the frozen submission), but it is visible, not a silent drop.
    expect(chatPromptEditorProps.at(-1)!.submitDisabled).toBe(true);
    expect(
      findReactPropsByTestId(harness.container, "composer-send-blocked-reason"),
    ).not.toBeNull();
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("too early");
      await flushAsyncWork();
    });
    expect(harness.onSendText).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("Retry on a failed bound first submission reuses the same submission and reservation, once (IUX07)", async () => {
  // specs/first-submission-instant-ux.md, Retry surface: the recovery card restores the frozen
  // record and runs the ordinary submit — no second send path, no new reservation.
  const prepare = vi.fn<
    NonNullable<
      import("@/v4/ConversationComposer.js").ConversationComposerProps["onPrepareFirstSubmission"]
    >
  >(async ({ reservation, onReservationCreated }) => {
    if (!reservation)
      onReservationCreated?.({ sessionId: "session-retry", commandId: "reserve-cmd" });
    return "session-retry";
  });
  const onFirstSubmissionReserved = vi.fn();
  const harness = renderLateAckComposer({
    worktree: false,
    onPrepareFirstSubmission: prepare,
    onFirstSubmissionReserved,
  });
  const recordsFor = (submissionId: string) => {
    const raw = window.localStorage.getItem(getV4ComposerDraftStorageKey("/workspace", undefined));
    const scopes = (raw ? JSON.parse(raw).scopes : {}) as Record<
      string,
      { firstSubmission?: { submissionId: string; status: string } }
    >;
    return Object.values(scopes).filter(
      (draft) => draft.firstSubmission?.submissionId === submissionId,
    );
  };
  try {
    harness.controls.rejectSend = true;
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("Retry me");
      await flushAsyncWork();
    });
    expect(onFirstSubmissionReserved).toHaveBeenCalledWith("session-retry");
    const failed = readV4WorktreeRecoveryDrafts("/workspace", undefined, "session-retry").find(
      (entry) => entry.draft.firstSubmission,
    )!;
    expect(failed.draft.firstSubmission?.status).toBe("failed");
    const submissionId = failed.draft.firstSubmission!.submissionId;

    // The pane bound to the reserved session; the composer there offers Retry.
    harness.controls.rejectSend = false;
    harness.rerender("session-retry");
    const retry = findReactPropsByTestId(harness.container, "composer-first-submission-retry");
    expect(retry?.disabled).toBe(false);
    await act(async () => {
      // Two clicks before React re-renders: the request counter collapses them into one submit.
      (retry!.onClick as () => void)();
      (retry!.onClick as () => void)();
      await flushAsyncWork();
    });

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1]?.[0]).toMatchObject({
      submissionId,
      reservation: { sessionId: "session-retry", commandId: "reserve-cmd" },
    });
    expect(harness.onSendText).toHaveBeenCalledTimes(2);
    expect(harness.onSendText.mock.calls[1]?.[0]).toBe("Retry me");
    expect(harness.onSendText.mock.calls[1]?.[1]).toMatchObject({
      reservedSubmissionSessionId: "session-retry",
      firstSubmissionId: submissionId,
    });
    // One record per submission, overwritten in place (never failed again, never duplicated).
    const records = recordsFor(submissionId);
    expect(records).toHaveLength(1);
    expect(records[0]?.firstSubmission?.status).not.toBe("failed");
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("Retry moves a record found under another scope into its own, leaving one record (IUX07)", async () => {
  // A record can reach the session's card through its reservation while still stored under the
  // draft owner (e.g. the bind could not move it). The retry freeze writes the composer's own
  // scope, so Retry must move the record first or two records would exist for one submission.
  const prepare = vi.fn<
    NonNullable<
      import("@/v4/ConversationComposer.js").ConversationComposerProps["onPrepareFirstSubmission"]
    >
  >(async () => "session-foreign");
  // Seed after mounting: the harness installs a fresh window.localStorage.
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  const foreignScope = getV4WorktreeRecoveryScope("__draft__", "sub-foreign");
  persistV4ComposerDraft("/workspace", undefined, foreignScope, {
    text: "Stored under the draft owner",
    firstSubmission: {
      submissionId: "sub-foreign",
      ownerKey: "__draft__",
      status: "failed",
      reservation: { sessionId: "session-foreign", commandId: "reserve-foreign" },
    },
  });
  try {
    harness.rerender("session-foreign");
    const retry = findReactPropsByTestId(harness.container, "composer-first-submission-retry");
    await act(async () => {
      (retry!.onClick as () => void)();
      await flushAsyncWork();
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      submissionId: "sub-foreign",
      reservation: { sessionId: "session-foreign", commandId: "reserve-foreign" },
    });
    expect(harness.onSendText).toHaveBeenCalledOnce();
    expect(readV4ComposerDraft("/workspace", undefined, foreignScope)).toBeNull();
    const records = readV4WorktreeRecoveryDrafts("/workspace", undefined, "session-foreign").filter(
      (entry) => entry.draft.firstSubmission?.submissionId === "sub-foreign",
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.scope).toBe(getV4WorktreeRecoveryScope("session-foreign", "sub-foreign"));
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

// ── Review fixes for the first-submission stack (specs/first-submission-instant-ux.md,
// Retry surface / Reconciliation; specs/first-submission-lifecycle.md owners). ──

type PrepareFirstSubmission = NonNullable<
  import("@/v4/ConversationComposer.js").ConversationComposerProps["onPrepareFirstSubmission"]
>;

function allFirstSubmissionRecords() {
  const raw = window.localStorage.getItem(getV4ComposerDraftStorageKey("/workspace", undefined));
  const scopes = (raw ? JSON.parse(raw).scopes : {}) as Record<
    string,
    {
      text?: string;
      firstSubmission?: {
        submissionId: string;
        status: string;
        commandId?: string;
        reservation?: { sessionId: string; commandId: string };
      };
    }
  >;
  return Object.entries(scopes)
    .filter(([, draft]) => draft.firstSubmission)
    .map(([scope, draft]) => ({ scope, draft }));
}

function seedBoundFailedRecord(
  sessionId: string,
  submissionId: string,
  overrides: { status?: "failed" | "unknown"; commandId?: string } = {},
) {
  persistV4ComposerDraft(
    "/workspace",
    undefined,
    getV4WorktreeRecoveryScope(sessionId, submissionId),
    {
      text: `frozen ${submissionId}`,
      firstSubmission: {
        submissionId,
        ownerKey: sessionId,
        status: overrides.status ?? "failed",
        ...(overrides.commandId ? { commandId: overrides.commandId } : {}),
        reservation: { sessionId, commandId: `reserve-${submissionId}` },
      },
    },
  );
}

it("a blocked Retry names the reason, restores nothing, and works once readiness returns (E)", async () => {
  const prepare = vi.fn<PrepareFirstSubmission>(async () => "session-blocked");
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  seedBoundFailedRecord("session-blocked", "sub-blocked");
  try {
    harness.controls.submissionReady = false;
    harness.rerender("session-blocked");
    const blocked = findReactPropsByTestId(harness.container, "composer-first-submission-retry");
    expect(blocked?.disabled).toBe(true);
    const reason = findReactPropsByTestId(
      harness.container,
      "composer-first-submission-retry-blocked",
    );
    expect(reason?.id).toBeTruthy();
    expect(blocked?.["aria-describedby"]).toBe(reason?.id);
    // Even a forced click on the disabled control neither restores into the editor nor sends.
    await act(async () => {
      (blocked!.onClick as () => void)();
      await flushAsyncWork();
    });
    expect(editorApi.setText).not.toHaveBeenCalledWith("frozen sub-blocked");
    expect(harness.onSendText).not.toHaveBeenCalled();

    // No lock: once the session is ready, the same record retries.
    harness.controls.submissionReady = true;
    harness.refresh();
    const ready = findReactPropsByTestId(harness.container, "composer-first-submission-retry");
    expect(ready?.disabled).toBe(false);
    await act(async () => {
      (ready!.onClick as () => void)();
      await flushAsyncWork();
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(harness.onSendText).toHaveBeenCalledOnce();
    expect(harness.onSendText.mock.calls[0]?.[1]).toMatchObject({
      firstSubmissionId: "sub-blocked",
    });
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("Remove returns the text to the editor, deletes the record, keeps the reservation and never calls the Host (F)", async () => {
  const prepare = vi.fn<PrepareFirstSubmission>(async () => "session-remove");
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  seedBoundFailedRecord("session-remove", "sub-remove", {
    status: "unknown",
    commandId: "cmd-remove",
  });
  try {
    harness.rerender("session-remove");
    const remove = findReactPropsByTestId(harness.container, "composer-first-submission-remove");
    expect(remove).not.toBeNull();
    await act(async () => {
      (remove!.onClick as () => void)();
      await flushAsyncWork();
    });
    expect(editorApi.setText).toHaveBeenCalledWith("frozen sub-remove");
    expect(
      allFirstSubmissionRecords().filter(({ scope }) => scope !== "session-remove"),
    ).toHaveLength(0);
    // The session's own draft keeps the reservation, so the next Send activates the prepared
    // session instead of stranding it; the unresolved command is in the unsettled ledger.
    expect(
      readV4ComposerDraft("/workspace", undefined, "session-remove")?.firstSubmission,
    ).toMatchObject({
      submissionId: "sub-remove",
      reservation: { sessionId: "session-remove", commandId: "reserve-sub-remove" },
    });
    expect(ledger.tracked).toContainEqual({
      scopeKey: "/workspace\0session-remove",
      commandId: "cmd-remove",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(harness.onSendText).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("an unknown outcome of a reserved send is recorded in the unsettled ledger (A)", async () => {
  const harness = renderLateAckComposer({
    worktree: false,
    onPrepareFirstSubmission: async ({ onReservationCreated }) => {
      onReservationCreated?.({ sessionId: "session-unknown", commandId: "reserve-unknown" });
      return "session-unknown";
    },
  });
  harness.onSendText.mockImplementationOnce(async (_text: string, options?: unknown) => {
    (options as { onCommandCreated?: (commandId: string) => void }).onCommandCreated?.(
      "cmd-unknown",
    );
    throw new Error("ack lost");
  });
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("lost ack");
      await flushAsyncWork();
    });
    const records = readV4WorktreeRecoveryDrafts("/workspace", undefined, "session-unknown");
    expect(records[0]?.draft.firstSubmission).toMatchObject({
      status: "unknown",
      commandId: "cmd-unknown",
    });
    expect(ledger.tracked.map((entry) => entry.commandId)).toContain("cmd-unknown");
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a failure whose bind could not move the record stays in the draft view with its reservation (A)", async () => {
  const onFirstSubmissionReserved = vi.fn();
  const harness = renderLateAckComposer({
    worktree: false,
    onFirstSubmissionReserved,
    onPrepareFirstSubmission: async ({ onReservationCreated }) => {
      // The reservation write lands; the bind's move of the record fails (quota).
      const storage = window.localStorage;
      const setItem = storage.setItem;
      let writes = 0;
      storage.setItem = (key: string, value: string) => {
        writes += 1;
        if (writes > 1) throw new Error("quota");
        setItem.call(storage, key, value);
      };
      try {
        onReservationCreated?.({ sessionId: "session-unmoved", commandId: "reserve-unmoved" });
      } finally {
        storage.setItem = setItem;
      }
      return "session-unmoved";
    },
  });
  harness.controls.rejectSend = true;
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("stay visible");
      await flushAsyncWork();
    });
    // The pane never bound, so the record must stay where the user is looking: the draft.
    expect(onFirstSubmissionReserved).not.toHaveBeenCalled();
    expect(allFirstSubmissionRecords()).toHaveLength(1);
    const records = readV4WorktreeRecoveryDrafts("/workspace", undefined, "__draft__");
    expect(records).toHaveLength(1);
    expect(records[0]?.draft.firstSubmission).toMatchObject({
      status: "failed",
      reservation: { sessionId: "session-unmoved", commandId: "reserve-unmoved" },
    });
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a cancelled checkout guard withdraws the frozen submission even after the editor-clear echo (C)", async () => {
  const prepare = vi.fn<PrepareFirstSubmission>(async () => "never");
  branchIntentWiring.gitService = {
    getLocalBranches: async () => ({ currentBranchName: "main" }),
    switchBranch: async () => ({ ok: true }),
  };
  branchIntentWiring.guard = async () => {
    // Lexical reports the claim's clear as a change event before the guard dialog resolves.
    chatPromptEditorProps.at(-1)!.onChange!("");
    return false;
  };
  useDraftBranchIntentStore.getState().setDraftBranchIntent("/workspace", "feature-guarded");
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("guarded text");
      await flushAsyncWork();
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(harness.onSendText).not.toHaveBeenCalled();
    expect(allFirstSubmissionRecords()).toHaveLength(0);
    expect(editorApi.setText).toHaveBeenCalledWith("guarded text");
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a worktree begin that fails before any reservation withdraws the frozen submission after the echo (C)", async () => {
  const harness = renderLateAckComposer({
    onPrepareFirstSubmission: vi.fn<PrepareFirstSubmission>(async () => "never"),
  });
  harness.controls.beginOutcome = { ok: false };
  let releaseBegin!: () => void;
  harness.controls.beginGate = {
    promise: new Promise<void>((resolve) => {
      releaseBegin = resolve;
    }),
    resolve: () => releaseBegin(),
  };
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("worktree text");
      await flushAsyncWork();
    });
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("");
      harness.controls.beginGate!.resolve();
      await flushAsyncWork();
    });
    expect(allFirstSubmissionRecords()).toHaveLength(0);
    expect(editorApi.setText).toHaveBeenCalledWith("worktree text");
    expect(harness.onSendText).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});
