// Mounted regression for the late worktree reservation ACK: dispatch of the queued send, failed
// dispatch, and Retry of the frozen submission (specs/composer-worktree-setup-steps.md, acceptance 15
// and the retry scenarios). Split from v4ConversationComposerWorktreeLateAck.test.ts for file size.
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readV4WorktreeRecoveryDrafts } from "@/v4/composer/composerDraftStore.js";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";
import { flushAsyncWork, renderLateAckComposer } from "./v4ConversationComposerLateAckHarness.js";

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

afterEach(() => {
  chatPromptEditorProps.length = 0;
  attachmentState.prepareForSend.mockClear();
  editorApi.clear.mockClear();
  editorApi.setText.mockClear();
  editorApi.setEditorStateJson.mockClear();
  useComposerWorktreePipelineStore.setState({ pipelineByWorkspaceKey: {} });
  window.localStorage.clear();
});

describe("late worktree reservation ACK: dispatch and retry", () => {
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
    // The accepted dispatch consumes the recovery record, so Retry cannot leave a duplicate draft.
    expect(readV4WorktreeRecoveryDrafts("/workspace", undefined, "prepared-session-a")).toEqual([]);
  });
});
