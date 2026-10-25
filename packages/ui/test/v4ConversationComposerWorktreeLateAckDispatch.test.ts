import { useDraftIncognitoIntentStore } from "@/v4/composer/draftIncognitoIntent.js";
import { useDraftBranchIntentStore } from "@/v4/composer/draftBranchIntent.js";
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

function preparingSnapshot(sessionId: string, submissionId: string) {
  return {
    protocolVersion: 1,
    sessionId,
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
        submissionId,
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
  } as unknown as NonNullable<
    import("@/v4/ConversationComposer.js").ConversationComposerProps["snapshot"]
  >;
}

it("a second Send waits visibly while the bound session still prepares the frozen submission", async () => {
  const harness = renderLateAckComposer({ worktree: false });
  harness.controls.snapshot = preparingSnapshot("session-preparing", "sub-preparing");
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

it("Retry after input-admitted issues no sendText, record becomes sending with the original command id, one record", async () => {
  // specs/first-submission-lifecycle.md rule 4: the Host already admitted the frozen input under
  // its original command id. The pane answers "alreadyAdmitted" instead of resending; the composer
  // records the outstanding original command and settles the copy without a new command id.
  const prepare = vi.fn<PrepareFirstSubmission>(async () => "session-admitted");
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  seedBoundFailedRecord("session-admitted", "sub-admitted", {
    status: "failed",
    commandId: "cmd-orig-admitted",
  });
  harness.onSendText.mockImplementationOnce(async (...args: unknown[]) => {
    expect(args[1]).toMatchObject({ reservedSubmissionSessionId: "session-admitted" });
    return "alreadyAdmitted" as const;
  });
  try {
    harness.rerender("session-admitted");
    await act(async () => {
      (
        findReactPropsByTestId(harness.container, "composer-first-submission-retry")!
          .onClick as () => void
      )();
      await flushAsyncWork();
    });

    expect(harness.onSendText).toHaveBeenCalledTimes(1);
    const records = readV4WorktreeRecoveryDrafts(
      "/workspace",
      undefined,
      "session-admitted",
    ).filter((entry) => entry.draft.firstSubmission?.submissionId === "sub-admitted");
    expect(records).toHaveLength(1);
    expect(records[0]?.draft.firstSubmission).toMatchObject({
      status: "sending",
      commandId: "cmd-orig-admitted",
    });
    // The original command was never re-tracked as a new unknown outcome by this retry.
    expect(ledger.tracked.filter((entry) => entry.commandId === "cmd-orig-admitted")).toHaveLength(
      0,
    );
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("Retry hands the pane its original command id so the activation can be checked by that identity", async () => {
  // The pane sends it as expectedFirstInputCommandId; an already-active answer is not an admission, so the
  // pane dispatches the frozen sendText and the composer takes its ordinary result ("sent").
  const prepare = vi.fn<PrepareFirstSubmission>(async () => "session-active-retry");
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  seedBoundFailedRecord("session-active-retry", "sub-active-retry", {
    status: "failed",
    commandId: "cmd-orig-active-retry",
  });
  harness.onSendText.mockImplementationOnce(async () => "sent" as const);
  try {
    harness.rerender("session-active-retry");
    await act(async () => {
      (
        findReactPropsByTestId(harness.container, "composer-first-submission-retry")!
          .onClick as () => void
      )();
      await flushAsyncWork();
    });

    expect(harness.onSendText).toHaveBeenCalledTimes(1);
    expect(harness.onSendText.mock.calls[0]?.[1]).toMatchObject({
      reservedSubmissionSessionId: "session-active-retry",
      originalCommandId: "cmd-orig-active-retry",
    });
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a retry that fails before its own command keeps the original command id for the next Retry", async () => {
  // Freezing a retry overwrites the stored record; a failure before any new sendText must not drop the
  // id of the earlier sendText, or a later admitted activation could only be settled without it.
  const prepare = vi.fn<PrepareFirstSubmission>(async () => "session-kept");
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  seedBoundFailedRecord("session-kept", "sub-kept", {
    status: "failed",
    commandId: "cmd-orig-kept",
  });
  harness.onSendText.mockImplementationOnce(async () => {
    throw new Error("create failed before the activation");
  });
  harness.onSendText.mockImplementationOnce(async (...args: unknown[]) => {
    expect(args[1]).toMatchObject({ originalCommandId: "cmd-orig-kept" });
    return "alreadyAdmitted" as const;
  });
  try {
    harness.rerender("session-kept");
    await act(async () => {
      (
        findReactPropsByTestId(harness.container, "composer-first-submission-retry")!
          .onClick as () => void
      )();
      await flushAsyncWork();
    });
    expect(
      readV4WorktreeRecoveryDrafts("/workspace", undefined, "session-kept").find(
        (entry) => entry.draft.firstSubmission?.submissionId === "sub-kept",
      )?.draft.firstSubmission,
    ).toMatchObject({ status: "failed", commandId: "cmd-orig-kept" });

    harness.rerender("session-kept");
    await act(async () => {
      (
        findReactPropsByTestId(harness.container, "composer-first-submission-retry")!
          .onClick as () => void
      )();
      await flushAsyncWork();
    });
    expect(harness.onSendText).toHaveBeenCalledTimes(2);
    const records = readV4WorktreeRecoveryDrafts("/workspace", undefined, "session-kept").filter(
      (entry) => entry.draft.firstSubmission?.submissionId === "sub-kept",
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.draft.firstSubmission).toMatchObject({
      status: "sending",
      commandId: "cmd-orig-kept",
    });
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

it("a send-time switch that fails at once keeps the draft branch intent and the text (ISSUE-037)", async () => {
  const prepare = vi.fn<PrepareFirstSubmission>(async () => "never");
  const switchBranch = vi.fn(async () => {
    throw new Error("switch rejected");
  });
  branchIntentWiring.gitService = {
    getLocalBranches: async () => ({ currentBranchName: "main" }),
    switchBranch,
  };
  branchIntentWiring.guard = null;
  useDraftBranchIntentStore.getState().setDraftBranchIntent("/workspace", "feature/qa-branch");
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("failing text");
      await flushAsyncWork();
    });
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("failing text");
      await flushAsyncWork();
    });
    expect(switchBranch).toHaveBeenCalledTimes(1);
    expect(harness.onSendText).not.toHaveBeenCalled();
    expect(useDraftBranchIntentStore.getState().intentByWorkspaceKey["/workspace"]).toBe(
      "feature/qa-branch",
    );

    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("failing text");
      await flushAsyncWork();
    });
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("failing text");
      await flushAsyncWork();
    });
    expect(switchBranch).toHaveBeenCalledTimes(2);
    expect(harness.onSendText).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("the user emptying a non-empty draft clears the draft branch intent (ISSUE-037)", async () => {
  useDraftBranchIntentStore.getState().setDraftBranchIntent("/workspace", "feature/qa-branch");
  const harness = renderLateAckComposer({ worktree: false });
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("typed text", { programmatic: false });
      await flushAsyncWork();
    });
    expect(useDraftBranchIntentStore.getState().intentByWorkspaceKey["/workspace"]).toBe(
      "feature/qa-branch",
    );
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("", { programmatic: false });
      await flushAsyncWork();
    });
    expect(useDraftBranchIntentStore.getState().intentByWorkspaceKey["/workspace"]).toBeUndefined();
    expect(harness.onSendText).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a programmatic empty update never clears the draft branch intent (ISSUE-037)", async () => {
  useDraftBranchIntentStore.getState().setDraftBranchIntent("/workspace", "feature/qa-branch");
  const harness = renderLateAckComposer({ worktree: false });
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("typed text", { programmatic: false });
      await flushAsyncWork();
    });
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("", { programmatic: true });
      await flushAsyncWork();
    });
    expect(useDraftBranchIntentStore.getState().intentByWorkspaceKey["/workspace"]).toBe(
      "feature/qa-branch",
    );
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("prompt-history recall that returns to an empty draft keeps the branch intent (ISSUE-037)", async () => {
  useDraftBranchIntentStore.getState().setDraftBranchIntent("/workspace", "feature/qa-branch");
  const harness = renderLateAckComposer({ worktree: false });
  try {
    // ArrowUp recalls the last prompt; the history write is an app write, not typing.
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("recalled prompt", { programmatic: true });
      await flushAsyncWork();
    });
    // ArrowDown past the newest entry restores an empty draft.
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("", { programmatic: true });
      await flushAsyncWork();
    });
    expect(useDraftBranchIntentStore.getState().intentByWorkspaceKey["/workspace"]).toBe(
      "feature/qa-branch",
    );
    expect(harness.onSendText).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("the editor's clear echo during a cancelled checkout guard keeps the intent (ISSUE-037)", async () => {
  const prepare = vi.fn<PrepareFirstSubmission>(async () => "never");
  branchIntentWiring.gitService = {
    getLocalBranches: async () => ({ currentBranchName: "main" }),
    switchBranch: async () => ({ ok: true }),
  };
  branchIntentWiring.guard = async () => {
    chatPromptEditorProps.at(-1)!.onChange!("", { programmatic: true });
    await flushAsyncWork();
    return false;
  };
  useDraftBranchIntentStore.getState().setDraftBranchIntent("/workspace", "feature/qa-branch");
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("guarded text", { programmatic: false });
      await flushAsyncWork();
    });
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("guarded text");
      await flushAsyncWork();
    });
    expect(useDraftBranchIntentStore.getState().intentByWorkspaceKey["/workspace"]).toBe(
      "feature/qa-branch",
    );
    expect(harness.onSendText).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("an accepted worktree send consumes the draft base intent (ISSUE-037)", async () => {
  useDraftBranchIntentStore.getState().setDraftBranchIntent("/workspace", "main");
  const harness = renderLateAckComposer();
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("worktree text", { programmatic: false });
      await flushAsyncWork();
    });
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("worktree text");
      await flushAsyncWork();
    });
    expect(harness.capturedPrepareSession()).toBeTypeOf("function");
    expect(useDraftBranchIntentStore.getState().intentByWorkspaceKey["/workspace"]).toBeUndefined();
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a cancelled checkout guard keeps the draft branch intent; the next send asks the guard again (ISSUE-037)", async () => {
  const prepare = vi.fn<PrepareFirstSubmission>(async () => "never");
  const switchBranch = vi.fn(async () => ({ ok: true as const }));
  branchIntentWiring.gitService = {
    getLocalBranches: async () => ({ currentBranchName: "main" }),
    switchBranch,
  };
  // The dialog stays open until the user answers: the editor's optimistic clear commits first.
  const guard = vi.fn(async () => {
    await flushAsyncWork();
    return false;
  });
  branchIntentWiring.guard = guard;
  useDraftBranchIntentStore.getState().setDraftBranchIntent("/workspace", "feature/qa-branch");
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("guarded text");
      await flushAsyncWork();
    });
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("guarded text");
      await flushAsyncWork();
    });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetBranchName: "feature/qa-branch", scope: "checkout" }),
    );
    expect(useDraftBranchIntentStore.getState().intentByWorkspaceKey["/workspace"]).toBe(
      "feature/qa-branch",
    );
    expect(harness.onSendText).not.toHaveBeenCalled();
    expect(switchBranch).not.toHaveBeenCalled();

    // The restored text reaches the editor again (its change event bumps the revision), then Send.
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("guarded text");
      await flushAsyncWork();
    });
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("guarded text");
      await flushAsyncWork();
    });
    expect(guard).toHaveBeenCalledTimes(2);
    expect(guard).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetBranchName: "feature/qa-branch" }),
    );
    expect(harness.onSendText).not.toHaveBeenCalled();
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

// ── #270 review: Remove on an unresolved outcome must not make a sendable copy; the owner token. ──

it.each(["sending", "unknown"] as const)(
  "Remove → Send on a %s record dispatches nothing until the outcome is decided",
  async (status) => {
    const { pendingCommandRegistry } = await import("@/v4/pendingCommandRegistry.js");
    const prepare = vi.fn<PrepareFirstSubmission>(async () => `session-held-${status}`);
    const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
    const sessionId = `session-held-${status}`;
    seedBoundFailedRecord(sessionId, `sub-held-${status}`, {
      status,
      commandId: `cmd-held-${status}`,
    });
    harness.controls.snapshot = preparingSnapshot(sessionId, `sub-held-${status}`);
    try {
      harness.rerender(sessionId);
      await act(async () => {
        (
          findReactPropsByTestId(harness.container, "composer-first-submission-remove")!
            .onClick as () => void
        )();
        await flushAsyncWork();
      });
      // The restored text is visible but not sendable: Send is disabled with the reason.
      harness.refresh();
      expect(chatPromptEditorProps.at(-1)!.submitDisabled).toBe(true);
      expect(
        findReactPropsByTestId(harness.container, "composer-send-blocked-reason"),
      ).not.toBeNull();
      await act(async () => {
        chatPromptEditorProps.at(-1)!.onSubmit!(`frozen sub-held-${status}`);
        await flushAsyncWork();
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(harness.onSendText).not.toHaveBeenCalled();

      // A decided "not accepted" outcome lifts the hold; the next Send continues the same
      // submission and reservation.
      await act(async () => {
        pendingCommandRegistry.reportReconciledResolution(`cmd-held-${status}`, "failed");
        await flushAsyncWork();
      });
      harness.refresh();
      expect(findReactPropsByTestId(harness.container, "composer-send-blocked-reason")).toBeNull();
      expect(chatPromptEditorProps.at(-1)!.submitDisabled).toBe(false);
      await act(async () => {
        chatPromptEditorProps.at(-1)!.onSubmit!(`frozen sub-held-${status}`);
        await flushAsyncWork();
      });
      expect(prepare).toHaveBeenCalledOnce();
      expect(harness.onSendText.mock.calls[0]?.[1]).toMatchObject({
        firstSubmissionId: `sub-held-${status}`,
      });
    } finally {
      await act(async () => {
        await flushAsyncWork();
        harness.root.unmount();
      });
    }
  },
);

it("an accepted outcome after Remove clears the unedited copy and sends nothing", async () => {
  const { pendingCommandRegistry } = await import("@/v4/pendingCommandRegistry.js");
  const harness = renderLateAckComposer({ worktree: false });
  seedBoundFailedRecord("session-held-accepted", "sub-held-accepted", {
    status: "unknown",
    commandId: "cmd-held-accepted",
  });
  try {
    harness.rerender("session-held-accepted");
    await act(async () => {
      (
        findReactPropsByTestId(harness.container, "composer-first-submission-remove")!
          .onClick as () => void
      )();
      await flushAsyncWork();
    });
    editorApi.clear.mockClear();
    await act(async () => {
      pendingCommandRegistry.reportReconciledResolution("cmd-held-accepted", "accepted");
      await flushAsyncWork();
    });
    expect(editorApi.clear).toHaveBeenCalled();
    expect(
      readV4ComposerDraft("/workspace", undefined, "session-held-accepted")?.firstSubmission,
    ).toBeUndefined();
    expect(harness.onSendText).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("an earlier first-submission chain never releases a later send's repeat-submit token", async () => {
  const harness = renderLateAckComposer({
    worktree: false,
    onPrepareFirstSubmission: async ({ onReservationCreated }) => {
      onReservationCreated?.({ sessionId: "session-token", commandId: "reserve-token" });
      return "session-token";
    },
  });
  let settleFirst!: () => void;
  harness.onSendText
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settleFirst = resolve;
        }),
    )
    .mockImplementationOnce(() => new Promise<void>(() => {}));
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("first");
      await flushAsyncWork();
    });
    harness.rerender("session-token");
    // Chain 2 (ordinary) takes the token after the bind released it and stays in flight.
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("second");
      chatPromptEditorProps.at(-1)!.onSubmit!("second");
      await flushAsyncWork();
    });
    expect(harness.onSendText).toHaveBeenCalledTimes(2);
    // Chain 1 ends: its `finally` must not clear chain 2's token.
    await act(async () => {
      settleFirst();
      await flushAsyncWork();
    });
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("third");
      chatPromptEditorProps.at(-1)!.onSubmit!("third");
      await flushAsyncWork();
    });
    expect(harness.onSendText).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a failed first submission is named as needing action, not as still being delivered", async () => {
  const harness = renderLateAckComposer({ worktree: false });
  seedBoundFailedRecord("session-needs-action", "sub-needs-action");
  harness.controls.snapshot = preparingSnapshot("session-needs-action", "sub-needs-action");
  try {
    harness.rerender("session-needs-action");
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("another message");
      await flushAsyncWork();
    });
    const reason = findReactPropsByTestId(harness.container, "composer-send-blocked-reason");
    expect(String(reason?.children)).toContain("needs attention");
    expect(String(reason?.children)).not.toContain("still being delivered");
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("Remove on an unresolved unreserved draft record holds the copy too", async () => {
  const prepare = vi.fn<PrepareFirstSubmission>(async () => undefined);
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  // Reachable: a CLI without durable reservation sends createSession+sendText directly, and a
  // lost ACK while the pane was elsewhere persists the record under the draft owner.
  persistV4ComposerDraft(
    "/workspace",
    undefined,
    getV4WorktreeRecoveryScope("__draft__", "sub-draft-held"),
    {
      text: "draft held",
      firstSubmission: {
        submissionId: "sub-draft-held",
        ownerKey: "__draft__",
        status: "unknown",
        commandId: "cmd-draft-held",
      },
    },
  );
  try {
    harness.refresh();
    await act(async () => {
      (
        findReactPropsByTestId(harness.container, "composer-first-submission-remove")!
          .onClick as () => void
      )();
      await flushAsyncWork();
    });
    harness.refresh();
    expect(chatPromptEditorProps.at(-1)!.submitDisabled).toBe(true);
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("draft held");
      await flushAsyncWork();
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

it("a reconnect query that answers unknown keeps the held copy; a later acceptance clears it, sending nothing", async () => {
  const { pendingCommandRegistry } = await import("@/v4/pendingCommandRegistry.js");
  const harness = renderLateAckComposer({ worktree: false });
  seedBoundFailedRecord("session-reconnect", "sub-reconnect", {
    status: "unknown",
    commandId: "cmd-reconnect",
  });
  const envelope = {
    commandId: "cmd-reconnect",
    clientId: "client-1",
    sessionId: "session-reconnect",
    type: "sendText",
    payload: { text: "frozen sub-reconnect" },
    issuedAt: Date.now(),
  } as unknown as import("@zcode/shared/zcode-protocol-v4").CommandEnvelope;
  try {
    harness.rerender("session-reconnect");
    await act(async () => {
      (
        findReactPropsByTestId(harness.container, "composer-first-submission-remove")!
          .onClick as () => void
      )();
      await flushAsyncWork();
    });
    editorApi.clear.mockClear();
    pendingCommandRegistry.record(envelope);
    await act(async () => {
      pendingCommandRegistry.applyQuery({
        results: [
          {
            key: { sessionId: "session-reconnect", commandId: "cmd-reconnect" },
            result: "unknown",
          },
        ],
      });
      await flushAsyncWork();
    });
    expect(editorApi.clear).not.toHaveBeenCalled();
    await act(async () => {
      pendingCommandRegistry.reconcileSnapshot({
        sessionId: "session-reconnect",
        queue: { items: [] },
        rows: {
          window: [{ kind: "userInput", rowId: 1, sourceCommandId: "cmd-reconnect", text: "x" }],
        },
      } as unknown as import("@zcode/shared/zcode-protocol-v4").ConversationSnapshot);
      await flushAsyncWork();
    });
    expect(editorApi.clear).toHaveBeenCalled();
    expect(harness.onSendText).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("Unlock is an explicit, confirmed override of a held copy and never sends by itself", async () => {
  const prepare = vi.fn<PrepareFirstSubmission>(async () => "session-unlock");
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  seedBoundFailedRecord("session-unlock", "sub-unlock", {
    status: "unknown",
    commandId: "cmd-unlock",
  });
  // A live snapshot (the session still prepares the frozen submission) so routing allows Send.
  harness.controls.snapshot = preparingSnapshot("session-unlock", "sub-unlock");
  try {
    harness.rerender("session-unlock");
    await act(async () => {
      (
        findReactPropsByTestId(harness.container, "composer-first-submission-remove")!
          .onClick as () => void
      )();
      await flushAsyncWork();
    });
    harness.refresh();
    expect(chatPromptEditorProps.at(-1)!.submitDisabled).toBe(true);
    // First click only reveals the duplicate warning and the confirmation.
    await act(async () => {
      (findReactPropsByTestId(harness.container, "composer-held-unlock")!.onClick as () => void)();
      await flushAsyncWork();
    });
    expect(
      findReactPropsByTestId(harness.container, "composer-held-unlock-warning"),
    ).not.toBeNull();
    expect(chatPromptEditorProps.at(-1)!.submitDisabled).toBe(true);
    await act(async () => {
      (
        findReactPropsByTestId(harness.container, "composer-held-unlock-confirm")!
          .onClick as () => void
      )();
      await flushAsyncWork();
    });
    harness.refresh();
    expect(chatPromptEditorProps.at(-1)!.submitDisabled).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(harness.onSendText).not.toHaveBeenCalled();
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("frozen sub-unlock");
      await flushAsyncWork();
    });
    expect(harness.onSendText).toHaveBeenCalledOnce();
    expect(harness.onSendText.mock.calls[0]?.[1]).toMatchObject({
      firstSubmissionId: "sub-unlock",
    });
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("after Unlock, an accepted original drops the submission so the next message is a new one", async () => {
  const { pendingCommandRegistry } = await import("@/v4/pendingCommandRegistry.js");
  const prepare = vi.fn<PrepareFirstSubmission>(async () => "session-unlock-accepted");
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission: prepare });
  seedBoundFailedRecord("session-unlock-accepted", "sub-unlock-accepted", {
    status: "unknown",
    commandId: "cmd-unlock-accepted",
  });
  harness.controls.snapshot = preparingSnapshot("session-unlock-accepted", "sub-unlock-accepted");
  try {
    harness.rerender("session-unlock-accepted");
    await act(async () => {
      (
        findReactPropsByTestId(harness.container, "composer-first-submission-remove")!
          .onClick as () => void
      )();
      await flushAsyncWork();
    });
    harness.refresh();
    await act(async () => {
      (findReactPropsByTestId(harness.container, "composer-held-unlock")!.onClick as () => void)();
      await flushAsyncWork();
    });
    await act(async () => {
      (
        findReactPropsByTestId(harness.container, "composer-held-unlock-confirm")!
          .onClick as () => void
      )();
      await flushAsyncWork();
    });
    // The unlocked status reaches the composer (the app re-renders on draft state changes).
    harness.refresh();
    // The original turns out accepted (projection) before the user sends anything.
    await act(async () => {
      pendingCommandRegistry.reconcileSnapshot({
        sessionId: "session-unlock-accepted",
        queue: { items: [] },
        rows: {
          window: [
            { kind: "userInput", rowId: 1, sourceCommandId: "cmd-unlock-accepted", text: "x" },
          ],
        },
      } as unknown as import("@zcode/shared/zcode-protocol-v4").ConversationSnapshot);
      await flushAsyncWork();
    });
    expect(
      readV4ComposerDraft("/workspace", undefined, "session-unlock-accepted")?.firstSubmission,
    ).toBeUndefined();
    // The admitted input cleared the preparation marker on the Host.
    const admitted = preparingSnapshot("session-unlock-accepted", "sub-unlock-accepted");
    harness.controls.snapshot = {
      ...admitted,
      meta: { title: "", titleSource: "firstInput" },
    } as typeof admitted;
    harness.refresh();
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onChange!("a new message");
      chatPromptEditorProps.at(-1)!.onSubmit!("a new message");
      await flushAsyncWork();
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(harness.onSendText).toHaveBeenCalledOnce();
    expect(harness.onSendText.mock.calls[0]?.[0]).toBe("a new message");
    expect(harness.onSendText.mock.calls[0]?.[1]).not.toHaveProperty("firstSubmissionId");
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("the Unlock warning is announced and described on the confirm button", async () => {
  const harness = renderLateAckComposer({ worktree: false });
  seedBoundFailedRecord("session-unlock-a11y", "sub-unlock-a11y", {
    status: "unknown",
    commandId: "cmd-unlock-a11y",
  });
  harness.controls.snapshot = preparingSnapshot("session-unlock-a11y", "sub-unlock-a11y");
  try {
    harness.rerender("session-unlock-a11y");
    await act(async () => {
      (
        findReactPropsByTestId(harness.container, "composer-first-submission-remove")!
          .onClick as () => void
      )();
      await flushAsyncWork();
    });
    harness.refresh();
    await act(async () => {
      (findReactPropsByTestId(harness.container, "composer-held-unlock")!.onClick as () => void)();
      await flushAsyncWork();
    });
    const warning = findReactPropsByTestId(harness.container, "composer-held-unlock-warning");
    const confirm = findReactPropsByTestId(harness.container, "composer-held-unlock-confirm");
    expect(warning?.role).toBe("alert");
    expect(warning?.id).toBeTruthy();
    expect(confirm?.["aria-describedby"]).toBe(warning?.id);
    const nodeByTestId = (testId: string) => {
      type MinimalNode = { attributes?: Map<string, string>; childNodes?: MinimalNode[] };
      const visit = (node: MinimalNode): MinimalNode | null => {
        if (node.attributes?.get("data-testid") === testId) return node;
        for (const child of node.childNodes ?? []) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      return visit(harness.container as unknown as MinimalNode);
    };
    const activeElement = () => (document as unknown as { activeElement?: unknown }).activeElement;
    // Focus moves onto the confirmation when it opens...
    expect(activeElement()).toBe(nodeByTestId("composer-held-unlock-confirm"));
    // ...and back to the trigger on Cancel.
    const cancel = findReactPropsByTestId(harness.container, "composer-held-unlock-cancel");
    await act(async () => {
      (cancel!.onClick as () => void)();
      await flushAsyncWork();
    });
    expect(activeElement()).toBe(nodeByTestId("composer-held-unlock"));
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a first submission whose Host reservation throws is reported, and the next Send is dispatched again (S1)", async () => {
  const { toast } = await import("@/components/ui/toast.js");
  const onPrepareFirstSubmission = vi.fn<PrepareFirstSubmission>(async () => {
    throw new Error("project.not-found");
  });
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission });
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("outside draft");
      await flushAsyncWork();
    });
    expect(onPrepareFirstSubmission).toHaveBeenCalledTimes(1);
    // The failure must be visible: no silent restore of the text into the editor.
    expect(toast).toHaveBeenCalledWith("Failed to send. Try again later.");
    expect(harness.onSendText).not.toHaveBeenCalled();

    // The restored draft is sendable again: the second Send is not dropped on the renderer side.
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("outside draft");
      await flushAsyncWork();
    });
    expect(onPrepareFirstSubmission).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a Send blocked by session readiness names the reason instead of returning silently (S2)", async () => {
  const { toast } = await import("@/components/ui/toast.js");
  const harness = renderLateAckComposer({ worktree: false });
  harness.controls.submissionReady = false;
  harness.refresh();
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("not yet");
      await flushAsyncWork();
    });
    expect(harness.onSendText).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("The session isn’t ready yet. Try again in a moment.", {
      dedupeKey: "composer.sendBlocked.sessionNotReady",
    });
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a failed outside-project first submission never reaches another session's composer (S3)", async () => {
  const onPrepareFirstSubmission = vi.fn<PrepareFirstSubmission>(async () => {
    throw new Error("project.not-found");
  });
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission });
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("outside draft");
      await flushAsyncWork();
    });
    expect(onPrepareFirstSubmission).toHaveBeenCalledTimes(1);
    // The failed text may only live in the global outside-project draft or the new-task view.
    editorApi.setText.mockClear();
    editorApi.setEditorStateJson.mockClear();
    harness.rerender("session-other");
    await act(async () => {
      await flushAsyncWork();
    });
    expect(editorApi.setText).not.toHaveBeenCalledWith("outside draft");
    expect(editorApi.setEditorStateJson).not.toHaveBeenCalledWith(
      expect.stringContaining("outside draft"),
    );
    expect(readV4ComposerDraft("/workspace", undefined, "session-other")?.text ?? "").toBe("");
    expect(allFirstSubmissionRecords()).toEqual([]);
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("repeated Sends blocked for one reason share one dedupe key, so Enter spam keeps one visible notice (S2b)", async () => {
  const { toast } = await import("@/components/ui/toast.js");
  vi.mocked(toast).mockClear();
  const harness = renderLateAckComposer({ worktree: false });
  harness.controls.submissionReady = false;
  harness.refresh();
  try {
    for (let press = 0; press < 3; press += 1) {
      await act(async () => {
        chatPromptEditorProps.at(-1)!.onSubmit!("not yet");
        await flushAsyncWork();
      });
    }
    expect(harness.onSendText).not.toHaveBeenCalled();
    const notices = vi
      .mocked(toast)
      .mock.calls.filter(
        ([message]) => message === "The session isn’t ready yet. Try again in a moment.",
      );
    expect(notices).toHaveLength(3);
    for (const [, options] of notices) {
      expect(options).toEqual({ dedupeKey: "composer.sendBlocked.sessionNotReady" });
    }
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a Send refused only because another send is in flight raises no notice (S2c)", async () => {
  const { toast } = await import("@/components/ui/toast.js");
  vi.mocked(toast).mockClear();
  const harness = renderLateAckComposer({ worktree: false });
  // The first dispatch never settles, so the second Send meets the in-flight guard.
  harness.onSendText.mockImplementationOnce(() => new Promise<never>(() => {}));
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("first");
      await flushAsyncWork();
    });
    expect(harness.onSendText).toHaveBeenCalledTimes(1);
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("second");
      await flushAsyncWork();
    });
    expect(harness.onSendText).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalledWith("Another message is still being sent.");
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a Send whose dispatch throws gets no composer toast, because the pane banner already reports it (S4)", async () => {
  const { toast } = await import("@/components/ui/toast.js");
  vi.mocked(toast).mockClear();
  const harness = renderLateAckComposer({ worktree: false });
  harness.controls.rejectSend = true;
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("will fail");
      await flushAsyncWork();
    });
    expect(harness.onSendText).toHaveBeenCalledTimes(1);
    // SessionPane.handleSendText sets the admission-failure banner for this error; a composer toast
    // with the same text would be a second notice for one failure.
    expect(toast).not.toHaveBeenCalledWith("Failed to send. Try again later.");
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a failure before dispatch, which has no pane banner, keeps its single composer notice (S4b)", async () => {
  const { toast } = await import("@/components/ui/toast.js");
  vi.mocked(toast).mockClear();
  const onPrepareFirstSubmission = vi.fn<PrepareFirstSubmission>(async () => {
    throw new Error("project.not-found");
  });
  const harness = renderLateAckComposer({ worktree: false, onPrepareFirstSubmission });
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("outside draft");
      await flushAsyncWork();
    });
    expect(onPrepareFirstSubmission).toHaveBeenCalledTimes(1);
    expect(harness.onSendText).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(toast)
        .mock.calls.filter(([message]) => message === "Failed to send. Try again later."),
    ).toHaveLength(1);
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});

it("a Send made after a failed worktree preparation names the failed first message instead of going silent (S2d)", async () => {
  const { toast } = await import("@/components/ui/toast.js");
  vi.mocked(toast).mockClear();
  const harness = renderLateAckComposer();
  try {
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("queued text");
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
    // The frozen send stays armed after a retryable failure, while worktreeQueued is already cleared.
    useComposerWorktreePipelineStore.getState().startPipeline("/workspace", {
      status: "failed",
      sessionId: "prepared-session-a",
      failureMessage: "git worktree add failed",
      params: {
        workspacePath: "/workspace",
        branchName: "feature-a",
        targetPath: "/worktrees/feature-a",
        attemptId: "attempt-1",
        baseFromHeadDefault: true,
      },
      queuedPromptPreview: "queued text",
      createdAt: Date.now(),
    });
    await act(async () => {
      await flushAsyncWork();
      await flushAsyncWork();
    });
    expect(harness.onSendText).not.toHaveBeenCalled();

    vi.mocked(toast).mockClear();
    await act(async () => {
      chatPromptEditorProps.at(-1)!.onSubmit!("second text");
      await flushAsyncWork();
    });
    expect(harness.onSendText).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      "Your first message needs attention: retry or remove it before sending another.",
      { dedupeKey: "composer.sendBlocked.firstSubmissionNeedsAction" },
    );
  } finally {
    await act(async () => {
      await flushAsyncWork();
      harness.root.unmount();
    });
  }
});
