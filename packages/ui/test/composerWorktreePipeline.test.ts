// Worktree setup pipeline store + runner tests (specs/composer-worktree-setup-steps.md):
// state machine transitions (consume-once, withdraw/orphan), runner idempotency and outcome
// mapping, and stale-creating reconcile.
// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitWorktreeCreateResult } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";
import {
  isComposerWorktreePipelineInFlight,
  beginWorktreePipelineCreation,
  reconcileCreatingComposerWorktreePipeline,
  retryComposerWorktreePipeline,
  restoreComposerWorktreePipelineFromPreparation,
  startComposerWorktreePipeline,
} from "@/v4/composer/composerWorktreePipeline.js";

import { restartPreparedWorktreeCreation } from "@/v4/composer/restartPreparedWorktreeCreation.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import {
  ComposerDraftWorktreeIntentContext,
  type ComposerDraftWorktreeIntent,
} from "@/v4/composer/composerDraftWorktreeIntent.js";
import { readV4WorktreeRecoveryDrafts } from "@/v4/composer/composerDraftStore.js";

// BUG-GWT-005 (docs/testing/git-worktree-qa/bugs/BUG-GWT-005.md) is a composer-level admission
// bug, so its regression mounts ConversationComposer. The heavy editor/toolbar subtrees are
// stubbed at their module boundary; the pipeline, store, and queued-send effects stay real.
const composerMount = vi.hoisted(() => ({
  editorProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/prompt-editor/ChatPromptEditor.js", async () => {
  const React = await import("react");
  return {
    ChatPromptEditor: (props: Record<string, unknown>) => {
      composerMount.editorProps.push(props);
      const inputApiRef = props.inputApiRef as
        | { current: Record<string, unknown> | null }
        | undefined;
      if (inputApiRef) {
        inputApiRef.current = {
          clear: vi.fn(),
          focus: vi.fn(),
          getEditorState: () => null,
          getMarkdown: () => "",
          setEditorStateJson: vi.fn(),
          setText: vi.fn(),
        };
      }
      return React.createElement(
        "form",
        { "data-testid": "bug005-chat-prompt-editor" },
        props.submitControl as ReactNode,
      );
    },
  };
});

vi.mock("@/v4/composer/useComposerAttachments.js", () => ({
  useComposerAttachments: () => ({
    adoptSentAttachments: vi.fn(async () => {}),
    attachmentError: null,
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
    hasUnreadyAttachments: false,
    isDraggingOverComposer: false,
    openAttachmentPicker: vi.fn(),
    prepareForSend: vi.fn(async () => []),
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

vi.mock("@/ControlHintTooltip.js", async () => {
  const React = await import("react");
  return {
    ControlHintTooltip: ({ children }: { children?: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

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

vi.mock("@/components/ai-elements/attachments.js", async () => {
  const React = await import("react");
  const Passthrough = ({
    children,
    ...props
  }: { children?: ReactNode } & Record<string, unknown>) =>
    React.createElement("div", props, children);
  const Trigger = ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  const Span = (props: Record<string, unknown>) => React.createElement("span", props);
  return {
    Attachment: Passthrough,
    AttachmentHoverCard: Passthrough,
    AttachmentHoverCardContent: Trigger,
    AttachmentHoverCardTrigger: Trigger,
    AttachmentInfo: Span,
    AttachmentPreview: Span,
    AttachmentRemove: (props: Record<string, unknown>) => React.createElement("button", props),
    Attachments: Passthrough,
  };
});

const createWorktree = vi.fn();
const listWorktrees = vi.fn();
const verifyWorktreeUsable = vi.fn(async () => ({ ok: true }));
const ensureWorktreeExclusion = vi.fn(async () => ({ ok: true }));
const gitService = {
  createWorktree,
  listWorktrees,
  verifyWorktreeUsable,
  ensureWorktreeExclusion,
};

const WORKSPACE_KEY = "/dev/alpha";
const PARAMS = {
  workspacePath: WORKSPACE_KEY,
  branchName: "zcode/sleepy-capybara",
  targetPath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
  baseBranch: "main",
  baseFromHeadDefault: false,
};

function seedCreating(overrides: Record<string, unknown> = {}) {
  useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
    status: "creating",
    params: PARAMS,
    createdAt: 1,
    ...overrides,
  });
}

function currentPipeline(sessionId?: string) {
  return selectComposerWorktreePipeline(
    useComposerWorktreePipelineStore.getState(),
    WORKSPACE_KEY,
    sessionId,
  );
}

function worktreeEntry(path: string, branchName = PARAMS.branchName) {
  return {
    path,
    headCommitHash: "c",
    branchName,
    isMain: false,
    isBare: false,
    isDetached: false,
    isCurrent: false,
  };
}

beforeEach(() => {
  useComposerWorktreePipelineStore.setState({ pipelineByWorkspaceKey: {} });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("composerWorktreePipelineStore state machine", () => {
  it("does not resurrect a discarded or consumed attempt", () => {
    for (const terminal of ["discard", "consume"] as const) {
      seedCreating({ sessionId: "terminal-session" });
      const attemptId = currentPipeline("terminal-session")!.attemptId;
      useComposerWorktreePipelineStore.getState()[terminal](WORKSPACE_KEY, "terminal-session");
      useComposerWorktreePipelineStore
        .getState()
        .markReady(WORKSPACE_KEY, PARAMS.targetPath, false, "terminal-session", attemptId);
      useComposerWorktreePipelineStore
        .getState()
        .markFailed(WORKSPACE_KEY, "late error", "terminal-session", attemptId);
      expect(currentPipeline("terminal-session")?.status).toBe(
        terminal === "discard" ? "discarded" : "consumed",
      );
    }
  });
  it("keeps the prepared session identity through setup and admission", () => {
    const store = useComposerWorktreePipelineStore.getState();
    seedCreating({ sessionId: "session-prepared-1" });
    expect(currentPipeline()?.sessionId).toBe("session-prepared-1");

    store.markReady(WORKSPACE_KEY, PARAMS.targetPath, false);
    expect(currentPipeline()?.sessionId).toBe("session-prepared-1");

    store.consume(WORKSPACE_KEY);
    expect(currentPipeline()).toMatchObject({
      status: "consumed",
      sessionId: "session-prepared-1",
    });
  });

  it("ignores a completion from an earlier retry attempt for the same session", () => {
    const store = useComposerWorktreePipelineStore.getState();
    const firstAttempt = store.startPipeline(WORKSPACE_KEY, {
      status: "creating",
      sessionId: "session-retry",
      params: PARAMS,
      createdAt: 1,
    });
    const currentAttempt = useComposerWorktreePipelineStore
      .getState()
      .startPipeline(WORKSPACE_KEY, {
        status: "creating",
        sessionId: "session-retry",
        params: PARAMS,
        createdAt: 2,
      });

    store.markReady(WORKSPACE_KEY, "/dev/stale-worktree", false, "session-retry", firstAttempt);
    expect(currentPipeline("session-retry")).toMatchObject({
      status: "creating",
      attemptId: currentAttempt,
    });
  });

  it("walks creating → ready → consumed with consume-once semantics", () => {
    const store = useComposerWorktreePipelineStore.getState();
    seedCreating({ queuedPromptPreview: "hello" });
    store.markReady(WORKSPACE_KEY, "/dev/alpha-worktrees/zcode-sleepy-capybara", false);
    expect(currentPipeline()).toMatchObject({
      status: "ready",
      queuedPromptPreview: "hello",
    });

    store.consume(WORKSPACE_KEY);
    expect(currentPipeline()).toMatchObject({
      status: "consumed",
      queuedPromptPreview: undefined,
    });
  });

  it("creating → failed → retry marks creating again with the frozen params", () => {
    const store = useComposerWorktreePipelineStore.getState();
    seedCreating({
      sessionId: "session-prepared-1",
      queuedPromptPreview: "frozen input",
    });
    store.markFailed(WORKSPACE_KEY, "boom");
    expect(currentPipeline()).toMatchObject({
      status: "failed",
      failureMessage: "boom",
    });

    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    } satisfies GitWorktreeCreateResult);
    return retryComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      formatMessage: (id: string) => id,
    }).then((outcome) => {
      expect(outcome).toBe("ready");
      expect(currentPipeline()).toMatchObject({
        status: "ready",
        sessionId: "session-prepared-1",
        queuedPromptPreview: "frozen input",
      });
      expect(createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: PARAMS.branchName,
          targetPath: PARAMS.targetPath,
        }),
      );
    });
  });

  it("withdraw marks the queued send dropped; the landing result keeps the orphan note", () => {
    const store = useComposerWorktreePipelineStore.getState();
    seedCreating({ queuedPromptPreview: "hello" });
    store.withdraw(WORKSPACE_KEY);
    expect(currentPipeline()).toMatchObject({
      orphaned: true,
      queuedPromptPreview: undefined,
    });

    store.markReady(WORKSPACE_KEY, "/dev/alpha-worktrees/zcode-sleepy-capybara", false);
    expect(currentPipeline()).toMatchObject({
      status: "ready",
      orphaned: true,
    });
  });

  it("markValidationFailed writes a params-less failed entry (no Retry surface)", () => {
    useComposerWorktreePipelineStore.getState().markValidationFailed(WORKSPACE_KEY, "bad path");
    expect(currentPipeline()).toMatchObject({
      status: "failed",
      failureMessage: "bad path",
    });
    expect(currentPipeline()?.params).toBeUndefined();
  });
});

describe("startComposerWorktreePipeline runner", () => {
  it("restores a Host preparation marker as a retryable session-scoped pipeline", () => {
    restoreComposerWorktreePipelineFromPreparation({
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      preparation: {
        status: "failed",
        branchName: PARAMS.branchName,
        targetPath: PARAMS.targetPath,
        baseBranch: "main",
        failureMessage: "Git interrupted",
      },
    });

    expect(currentPipeline()).toMatchObject({
      status: "failed",
      sessionId: "session-prepared-1",
      params: { ...PARAMS, baseFromHeadDefault: false },
      failureMessage: "Git interrupted",
    });
  });

  it("keeps concurrent session results isolated when an older preparation is restored", async () => {
    let resolveCreate: (value: GitWorktreeCreateResult) => void = () => {};
    createWorktree.mockReturnValue(
      new Promise<GitWorktreeCreateResult>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "creating",
      sessionId: "session-b",
      params: PARAMS,
      createdAt: 2,
    });
    const runningB = startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-b",
      params: PARAMS,
      formatMessage: (id: string) => id,
    });

    restoreComposerWorktreePipelineFromPreparation({
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      sessionId: "session-a",
      preparation: {
        status: "failed",
        branchName: "zcode/older-session",
        targetPath: "/dev/alpha-worktrees/zcode-older-session",
        failureMessage: "previous attempt failed",
      },
    });
    resolveCreate({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    });
    await expect(runningB).resolves.toBe("ready");

    expect(currentPipeline("session-a")).toMatchObject({
      status: "failed",
      params: { branchName: "zcode/older-session" },
    });
    expect(currentPipeline("session-b")).toMatchObject({
      status: "ready",
      worktreePath: PARAMS.targetPath,
      params: { branchName: PARAMS.branchName },
    });
    expect(currentPipeline()).toMatchObject({ sessionId: "session-b", status: "ready" });
  });

  it("replaces a stale renderer attempt when the Host reports a newer attempt for the same session", () => {
    seedCreating({
      sessionId: "session-prepared-1",
      status: "failed",
      params: { ...PARAMS, attemptId: "attempt-old" },
      failureMessage: "stale local failure",
      queuedPromptPreview: "queued prompt",
    });

    restoreComposerWorktreePipelineFromPreparation({
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      preparation: {
        status: "preparing",
        branchName: PARAMS.branchName,
        targetPath: PARAMS.targetPath,
        baseBranch: "main",
        attemptId: "attempt-new",
      },
    });

    expect(currentPipeline("session-prepared-1")).toMatchObject({
      status: "creating",
      sessionId: "session-prepared-1",
      params: { ...PARAMS, attemptId: "attempt-new" },
      queuedPromptPreview: "queued prompt",
    });
    // Another session's entry is untouched by the attempt replacement.
    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "ready",
      sessionId: "session-other",
      params: { ...PARAMS, attemptId: "attempt-other" },
      worktreePath: PARAMS.targetPath,
      createdAt: 3,
    });
    restoreComposerWorktreePipelineFromPreparation({
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      preparation: {
        status: "preparing",
        branchName: PARAMS.branchName,
        targetPath: PARAMS.targetPath,
        attemptId: "attempt-newer",
      },
    });
    expect(currentPipeline("session-other")).toMatchObject({
      status: "ready",
      params: { attemptId: "attempt-other" },
    });
  });

  it("keeps a same-attempt local ready while the Host still reports preparing", () => {
    seedCreating({
      sessionId: "session-prepared-1",
      status: "ready",
      params: { ...PARAMS, attemptId: "attempt-1" },
      worktreePath: PARAMS.targetPath,
    });

    restoreComposerWorktreePipelineFromPreparation({
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      preparation: {
        status: "preparing",
        branchName: PARAMS.branchName,
        targetPath: PARAMS.targetPath,
        attemptId: "attempt-1",
      },
    });

    expect(currentPipeline("session-prepared-1")).toMatchObject({
      status: "ready",
      worktreePath: PARAMS.targetPath,
    });

    // A terminal Host failure for the same attempt wins over the optimistic local ready.
    restoreComposerWorktreePipelineFromPreparation({
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      preparation: {
        status: "failed",
        branchName: PARAMS.branchName,
        targetPath: PARAMS.targetPath,
        attemptId: "attempt-1",
        failureMessage: "Host reported failure",
      },
    });
    expect(currentPipeline("session-prepared-1")).toMatchObject({
      status: "failed",
      failureMessage: "Host reported failure",
    });
  });

  it("discards a live entry on Host cancellation and a late Git success cannot restore ready", async () => {
    let resolveCreate: (value: GitWorktreeCreateResult) => void = () => {};
    createWorktree.mockReturnValue(
      new Promise<GitWorktreeCreateResult>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const store = useComposerWorktreePipelineStore.getState();
    store.startPipeline(WORKSPACE_KEY, {
      status: "creating",
      sessionId: "session-cancelled",
      params: { ...PARAMS, attemptId: "attempt-1" },
      queuedPromptPreview: "queued prompt",
      createdAt: 1,
    });
    const attemptId = currentPipeline("session-cancelled")!.attemptId;
    const running = startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-cancelled",
      params: { ...PARAMS, attemptId },
      formatMessage: (id: string) => id,
    });

    restoreComposerWorktreePipelineFromPreparation({
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      sessionId: "session-cancelled",
      preparation: {
        status: "cancelled",
        branchName: PARAMS.branchName,
        targetPath: PARAMS.targetPath,
        attemptId: "attempt-1",
      },
    });
    expect(currentPipeline("session-cancelled")).toMatchObject({
      status: "discarded",
      queuedPromptPreview: undefined,
    });

    resolveCreate({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    });
    await running;
    expect(currentPipeline("session-cancelled")?.status).toBe("discarded");
  });

  it("never resurrects a consumed or discarded entry from a stale Host preparation", () => {
    for (const terminal of ["consumed", "discarded"] as const) {
      useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
        status: terminal,
        sessionId: "session-terminal",
        params: { ...PARAMS, attemptId: "attempt-1" },
        createdAt: 1,
      });
      for (const status of ["preparing", "failed", "cancelled"] as const) {
        restoreComposerWorktreePipelineFromPreparation({
          workspaceKey: WORKSPACE_KEY,
          workspacePath: WORKSPACE_KEY,
          sessionId: "session-terminal",
          preparation: {
            status,
            branchName: PARAMS.branchName,
            targetPath: PARAMS.targetPath,
            attemptId: "attempt-1",
          },
        });
      }
      expect(currentPipeline("session-terminal")?.status).toBe(terminal);
    }
  });

  it("waits for Host identity before starting Git and retains that ID in the pipeline", async () => {
    let resolvePreparation: (sessionId: string) => void = () => {};
    let resolveCreate: (value: GitWorktreeCreateResult) => void = () => {};
    createWorktree.mockReturnValue(
      new Promise<GitWorktreeCreateResult>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const begin = beginWorktreePipelineCreation({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      effectiveLocation: {
        mode: "sibling",
        customPath: null,
        appWorktreesDir: null,
        prefix: "zcode/",
        baseBranchDefault: null,
        hasProjectOverride: false,
      },
      branchName: PARAMS.branchName,
      baseBranch: PARAMS.baseBranch,
      baseFromHeadDefault: false,
      queuedPromptPreview: "frozen input",
      prepareSession: () => new Promise((resolve) => (resolvePreparation = resolve)),
      formatMessage: (id: string) => id,
    });

    await Promise.resolve();
    expect(createWorktree).not.toHaveBeenCalled();
    resolvePreparation("session-prepared-1");
    await expect(begin).resolves.toEqual({
      ok: true,
      sessionId: "session-prepared-1",
    });
    await expect(
      beginWorktreePipelineCreation({
        gitService,
        workspaceKey: WORKSPACE_KEY,
        workspacePath: WORKSPACE_KEY,
        effectiveLocation: {
          mode: "sibling",
          customPath: null,
          appWorktreesDir: null,
          prefix: "zcode/",
          baseBranchDefault: null,
          hasProjectOverride: false,
        },
        branchName: "zcode/another-branch",
        baseFromHeadDefault: true,
        queuedPromptPreview: "second input",
        prepareSession: vi.fn(),
        formatMessage: (id: string) => id,
      }),
    ).resolves.toEqual({ ok: true, sessionId: "session-prepared-1" });
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(currentPipeline()).toMatchObject({
      status: "creating",
      sessionId: "session-prepared-1",
      queuedPromptPreview: "frozen input",
    });
    expect(createWorktree).toHaveBeenCalledTimes(1);
    resolveCreate({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    });
    await vi.waitFor(() => expect(currentPipeline()?.status).toBe("ready"));
  });

  it("joins concurrent reservations by workspace and keeps submission IDs in recovery metadata", async () => {
    let resolvePreparation: (sessionId: string) => void = () => {};
    const prepareSession = vi.fn(
      () => new Promise<string>((resolve) => (resolvePreparation = resolve)),
    );
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    } satisfies GitWorktreeCreateResult);
    const input = {
      gitService,
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      effectiveLocation: {
        mode: "sibling" as const,
        customPath: null,
        appWorktreesDir: null,
        prefix: "zcode/",
        baseBranchDefault: null,
        hasProjectOverride: false,
      },
      branchName: PARAMS.branchName,
      baseBranch: PARAMS.baseBranch,
      baseFromHeadDefault: false,
      queuedPromptPreview: "frozen input",
      submissionId: "submission-1",
      prepareSession,
      formatMessage: (id: string) => id,
    };
    const first = beginWorktreePipelineCreation(input);
    const secondPrepareSession = vi.fn();
    const second = beginWorktreePipelineCreation({
      ...input,
      queuedPromptPreview: "a concurrent submission",
      submissionId: "submission-2",
      prepareSession: secondPrepareSession,
    });

    expect(second).toBe(first);
    expect(prepareSession).toHaveBeenCalledTimes(1);
    resolvePreparation("session-prepared-1");
    await expect(second).resolves.toEqual({
      ok: true,
      sessionId: "session-prepared-1",
    });
    await vi.waitFor(() => expect(currentPipeline()?.status).toBe("ready"));
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(currentPipeline()?.params?.submissionId).toBe("submission-1");

    const laterPrepareSession = vi.fn();
    await expect(
      beginWorktreePipelineCreation({
        ...input,
        submissionId: "submission-3",
        prepareSession: laterPrepareSession,
      }),
    ).resolves.toEqual({ ok: true, sessionId: "session-prepared-1" });
    expect(laterPrepareSession).not.toHaveBeenCalled();
    expect(secondPrepareSession).not.toHaveBeenCalled();
    expect(createWorktree).toHaveBeenCalledTimes(1);
  });

  it("reuses the in-flight promise for the same workspace (idempotent double-send)", async () => {
    let resolveCreate: (value: GitWorktreeCreateResult) => void = () => {};
    createWorktree.mockReturnValue(
      new Promise<GitWorktreeCreateResult>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    seedCreating();
    const first = startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      params: PARAMS,
      formatMessage: (id: string) => id,
    });
    const second = startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      params: PARAMS,
      formatMessage: (id: string) => id,
    });
    expect(second).toBe(first);
    expect(isComposerWorktreePipelineInFlight(WORKSPACE_KEY)).toBe(true);
    resolveCreate({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    });
    await expect(first).resolves.toBe("ready");
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(isComposerWorktreePipelineInFlight(WORKSPACE_KEY)).toBe(false);
  });

  it("maps a thrown request to failed without rejecting", async () => {
    createWorktree.mockRejectedValue(new Error("rpc down"));
    seedCreating();
    const outcome = await startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      params: PARAMS,
      formatMessage: (id: string) => id,
    });
    expect(outcome).toBe("failed");
    expect(currentPipeline()?.status).toBe("failed");
  });
});

describe("reconcileCreatingComposerWorktreePipeline", () => {
  it("settles a stale creating entry via the worktree list", async () => {
    seedCreating();
    listWorktrees.mockResolvedValue({
      isGitAvailable: true,
      isRepository: true,
      worktrees: [
        {
          path: "/dev/alpha-worktrees/zcode-sleepy-capybara",
          headCommitHash: "c",
          branchName: "zcode/sleepy-capybara",
          isMain: false,
          isBare: false,
          isDetached: false,
          isCurrent: false,
        },
      ],
    });
    await reconcileCreatingComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      branchName: PARAMS.branchName,
      formatMessage: (id: string) => id,
    });
    expect(currentPipeline()).toMatchObject({
      status: "ready",
      existing: true,
      worktreePath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
    });
    expect(ensureWorktreeExclusion).toHaveBeenCalledWith({
      workspacePath: PARAMS.workspacePath,
      targetPath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
    });
  });

  it("marks failed when no worktree exists for the branch", async () => {
    seedCreating();
    listWorktrees.mockResolvedValue({
      isGitAvailable: true,
      isRepository: true,
      worktrees: [],
    });
    await reconcileCreatingComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      branchName: PARAMS.branchName,
      formatMessage: (id: string) => id,
    });
    expect(currentPipeline()).toMatchObject({
      status: "failed",
      failureMessage: "worktreeSetup.reconcile.staleCreating",
    });
  });

  it("marks failed when Git worktree state cannot be read", async () => {
    seedCreating({ sessionId: "session-prepared-1" });
    listWorktrees.mockRejectedValue(new Error("Git unavailable"));

    await reconcileCreatingComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      branchName: PARAMS.branchName,
      formatMessage: (id: string) => id,
    });

    expect(currentPipeline()).toMatchObject({
      status: "failed",
      sessionId: "session-prepared-1",
      failureMessage: "worktreeSetup.reconcile.staleCreating",
    });
  });

  it("does not touch a live in-flight entry", async () => {
    seedCreating();
    // The runner must settle before the test ends, or its in-flight promise leaks into the next
    // test through the module-level map (same workspace key).
    let resolveCreate: (value: GitWorktreeCreateResult) => void = () => {};
    createWorktree.mockReturnValue(
      new Promise<GitWorktreeCreateResult>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const runner = startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      params: PARAMS,
      formatMessage: (id: string) => id,
    });
    await reconcileCreatingComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      branchName: PARAMS.branchName,
      formatMessage: (id: string) => id,
    });
    expect(currentPipeline()?.status).toBe("creating");
    expect(listWorktrees).not.toHaveBeenCalled();
    resolveCreate({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    });
    await runner;
  });
});

describe("Host preparation sync before ready (strict activation stays intact)", () => {
  const OTHER_PATH = "/dev/other-worktrees/zcode-sleepy-capybara";

  function mockExistingWorktreeElsewhere() {
    createWorktree.mockResolvedValue({
      ok: false,
      worktreePath: null,
      branchName: null,
      issues: [{ code: "target-path-exists", message: "target exists" }],
    } satisfies GitWorktreeCreateResult);
    listWorktrees.mockResolvedValue({
      isGitAvailable: true,
      isRepository: true,
      worktrees: [worktreeEntry(OTHER_PATH)],
    });
  }

  it("realigns the Host marker before ready when an existing worktree is reused at another path", async () => {
    const syncPreparedWorktree = vi.fn().mockResolvedValue(undefined);
    mockExistingWorktreeElsewhere();
    seedCreating({ sessionId: "session-prepared-1" });

    const outcome = await startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      params: PARAMS,
      formatMessage: (id: string) => id,
      syncPreparedWorktree,
    });

    expect(outcome).toBe("ready");
    expect(syncPreparedWorktree).toHaveBeenCalledWith({
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      branchName: PARAMS.branchName,
      targetPath: OTHER_PATH,
      baseBranch: "main",
    });
    expect(currentPipeline()).toMatchObject({
      status: "ready",
      existing: true,
      worktreePath: OTHER_PATH,
    });
  });

  it("leaves the Host marker untouched when Git settles on the prepared target", async () => {
    const syncPreparedWorktree = vi.fn().mockResolvedValue(undefined);
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    } satisfies GitWorktreeCreateResult);
    seedCreating({ sessionId: "session-prepared-1" });

    const outcome = await startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      params: PARAMS,
      formatMessage: (id: string) => id,
      syncPreparedWorktree,
    });

    expect(outcome).toBe("ready");
    expect(syncPreparedWorktree).not.toHaveBeenCalled();
  });

  it("fails the attempt when the Host rejects the realigned path (no unactivatable ready)", async () => {
    const syncPreparedWorktree = vi.fn().mockRejectedValue(new Error("host rejected"));
    mockExistingWorktreeElsewhere();
    seedCreating({ sessionId: "session-prepared-1" });

    const outcome = await startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      params: PARAMS,
      formatMessage: (id: string) => id,
      syncPreparedWorktree,
    });

    expect(outcome).toBe("failed");
    expect(currentPipeline()).toMatchObject({ status: "failed", sessionId: "session-prepared-1" });
  });

  it("fails the attempt when Git settles elsewhere and marker sync is unavailable", async () => {
    mockExistingWorktreeElsewhere();
    seedCreating({ sessionId: "session-prepared-1" });

    // No syncPreparedWorktree: the Host marker keeps the frozen target, so a differing Git path
    // must fail the attempt instead of publishing a ready entry activation would reject.
    const outcome = await startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      params: PARAMS,
      formatMessage: (id: string) => id,
    });

    expect(outcome).toBe("failed");
    expect(currentPipeline()).toMatchObject({
      status: "failed",
      sessionId: "session-prepared-1",
      failureMessage: "worktreeSetup.reconcile.markerSyncUnavailable",
    });
  });

  it("reuses an occupied branch's registered worktree when the requested target is absent", async () => {
    const syncPreparedWorktree = vi.fn().mockResolvedValue(undefined);
    createWorktree.mockResolvedValue({
      ok: false,
      worktreePath: null,
      branchName: null,
      issues: [{ code: "branch-in-other-worktree", message: "branch checked out elsewhere" }],
    } satisfies GitWorktreeCreateResult);
    listWorktrees.mockResolvedValue({
      isGitAvailable: true,
      isRepository: true,
      worktrees: [worktreeEntry(OTHER_PATH)],
    });
    seedCreating({ sessionId: "session-prepared-1" });

    const outcome = await startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      params: PARAMS,
      formatMessage: (id: string) => id,
      syncPreparedWorktree,
    });

    expect(verifyWorktreeUsable).toHaveBeenCalledWith({
      workspacePath: WORKSPACE_KEY,
      targetPath: OTHER_PATH,
    });
    expect(syncPreparedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: OTHER_PATH }),
    );
    expect(outcome).toBe("ready");
    expect(currentPipeline("session-prepared-1")).toMatchObject({
      status: "ready",
      existing: true,
      worktreePath: OTHER_PATH,
    });
  });

  it("fails recoverably when the registered worktree's directory is gone (stale registration)", async () => {
    mockExistingWorktreeElsewhere();
    verifyWorktreeUsable.mockResolvedValueOnce({ ok: false, reason: "missing-directory" });
    seedCreating({ sessionId: "session-prepared-1" });

    const outcome = await startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      params: PARAMS,
      formatMessage: (id: string) => id,
    });

    expect(outcome).toBe("failed");
    expect(currentPipeline("session-prepared-1")).toMatchObject({
      status: "failed",
      failureMessage: "commandCenter.worktree.error.worktreeMissing",
    });
    // Never a second directory and never an automatic prune.
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(listWorktrees).toHaveBeenCalledTimes(1);
  });

  it("fails stale-creating reconcile when the registered directory is gone instead of turning ready", async () => {
    seedCreating({ sessionId: "session-prepared-1" });
    listWorktrees.mockResolvedValue({
      isGitAvailable: true,
      isRepository: true,
      worktrees: [worktreeEntry(OTHER_PATH)],
    });
    verifyWorktreeUsable.mockResolvedValueOnce({ ok: false, reason: "missing-git-link" });

    await reconcileCreatingComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      branchName: PARAMS.branchName,
      formatMessage: (id: string) => id,
    });

    expect(currentPipeline("session-prepared-1")).toMatchObject({
      status: "failed",
      failureMessage: "worktreeSetup.reconcile.worktreeMissing",
    });
  });

  it("isolates identical paths across different workspace hosts", async () => {
    // Same branch/target paths, different workspace identities (e.g. local + remote Host): the
    // per-workspace pipeline entries and Git requests stay independent.
    const createA = vi.fn().mockResolvedValue({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    } satisfies GitWorktreeCreateResult);
    const createB = vi.fn().mockImplementation(async () => {
      throw new Error("remote host git unavailable");
    });
    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "creating",
      sessionId: "session-a",
      params: PARAMS,
      createdAt: 1,
    });
    useComposerWorktreePipelineStore.getState().startPipeline("remote\0/dev/alpha", {
      status: "creating",
      sessionId: "session-a",
      params: { ...PARAMS, workspacePath: "/dev/alpha" },
      createdAt: 2,
    });
    const outcomeA = await startComposerWorktreePipeline({
      gitService: { ...gitService, createWorktree: createA },
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-a",
      params: PARAMS,
      formatMessage: (id: string) => id,
    });
    const outcomeB = await startComposerWorktreePipeline({
      gitService: { ...gitService, createWorktree: createB },
      workspaceKey: "remote\0/dev/alpha",
      sessionId: "session-a",
      params: { ...PARAMS, workspacePath: "/dev/alpha" },
      formatMessage: (id: string) => id,
    });

    expect(outcomeA).toBe("ready");
    expect(outcomeB).toBe("failed");
    expect(createA).toHaveBeenCalledTimes(1);
    expect(createB).toHaveBeenCalledTimes(1);
    expect(
      selectComposerWorktreePipeline(
        useComposerWorktreePipelineStore.getState(),
        WORKSPACE_KEY,
        "session-a",
      ),
    ).toMatchObject({ status: "ready", worktreePath: PARAMS.targetPath });
    expect(
      selectComposerWorktreePipeline(
        useComposerWorktreePipelineStore.getState(),
        "remote\0/dev/alpha",
        "session-a",
      ),
    ).toMatchObject({ status: "failed" });
  });

  it("realigns the Host marker during stale-creating reconcile before ready", async () => {
    const syncPreparedWorktree = vi.fn().mockResolvedValue(undefined);
    seedCreating({ sessionId: "session-prepared-1" });
    listWorktrees.mockResolvedValue({
      isGitAvailable: true,
      isRepository: true,
      worktrees: [worktreeEntry(OTHER_PATH)],
    });

    await reconcileCreatingComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      branchName: PARAMS.branchName,
      formatMessage: (id: string) => id,
      syncPreparedWorktree,
    });

    expect(syncPreparedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-prepared-1", targetPath: OTHER_PATH }),
    );
    expect(currentPipeline()).toMatchObject({
      status: "ready",
      existing: true,
      worktreePath: OTHER_PATH,
    });
  });

  it("fails stale-creating reconcile when the path differs and marker sync is unavailable", async () => {
    seedCreating({ sessionId: "session-prepared-1" });
    listWorktrees.mockResolvedValue({
      isGitAvailable: true,
      isRepository: true,
      worktrees: [worktreeEntry(OTHER_PATH)],
    });

    await reconcileCreatingComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      branchName: PARAMS.branchName,
      formatMessage: (id: string) => id,
    });

    expect(currentPipeline()).toMatchObject({
      status: "failed",
      sessionId: "session-prepared-1",
      failureMessage: "worktreeSetup.reconcile.markerSyncUnavailable",
    });
  });

  it("keeps the entry creating until the Host marker sync settles, then marks ready", async () => {
    let releaseSync!: () => void;
    const syncPreparedWorktree = vi
      .fn()
      .mockImplementation(() => new Promise<void>((resolve) => (releaseSync = resolve)));
    mockExistingWorktreeElsewhere();
    seedCreating({ sessionId: "session-prepared-1" });

    let settled: "ready" | "failed" | undefined;
    const attempt = startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      params: PARAMS,
      formatMessage: (id: string) => id,
      syncPreparedWorktree,
    }).then((outcome) => {
      settled = outcome;
      return outcome;
    });

    // The queued send dispatches the moment the entry turns ready; publishing ready before the
    // Host marker settled would race the first send against a stale prepared targetPath.
    await vi.waitFor(() => expect(syncPreparedWorktree).toHaveBeenCalledTimes(1));
    expect(currentPipeline()).toMatchObject({ status: "creating" });
    expect(settled).toBeUndefined();

    releaseSync();
    await expect(attempt).resolves.toBe("ready");
    expect(currentPipeline()).toMatchObject({
      status: "ready",
      existing: true,
      worktreePath: OTHER_PATH,
    });
  });

  it("realigns the Host marker on retry when the reused worktree moved", async () => {
    const syncPreparedWorktree = vi.fn().mockResolvedValue(undefined);
    mockExistingWorktreeElsewhere();
    seedCreating({ sessionId: "session-prepared-1", queuedPromptPreview: "frozen input" });
    useComposerWorktreePipelineStore.getState().markFailed(WORKSPACE_KEY, "boom");
    expect(currentPipeline()).toMatchObject({ status: "failed" });

    const outcome = await retryComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      formatMessage: (id: string) => id,
      syncPreparedWorktree,
    });

    // Retry must carry the sync hook through: a WT-04 reuse at another path on the retried
    // attempt is the exact scenario the realignment exists for.
    expect(outcome).toBe("ready");
    expect(syncPreparedWorktree).toHaveBeenCalledWith({
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-prepared-1",
      branchName: PARAMS.branchName,
      targetPath: OTHER_PATH,
      baseBranch: "main",
    });
    expect(currentPipeline()).toMatchObject({
      status: "ready",
      existing: true,
      worktreePath: OTHER_PATH,
      queuedPromptPreview: "frozen input",
    });
  });
});

describe("reopened preparation attempts", () => {
  it("restores the selected base and creates a fresh attempt for the same session", async () => {
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    });
    const prepareSession = vi.fn(async (_params: { attemptId?: string }) => "reopened-session");
    await expect(
      restartPreparedWorktreeCreation({
        workspaceKey: WORKSPACE_KEY,
        workspacePath: WORKSPACE_KEY,
        sessionId: "reopened-session",
        preparation: { ...PARAMS, status: "cancelled", attemptId: "old-attempt" },
        gitService,
        prepareSession,
        formatMessage: (id) => id,
      }),
    ).resolves.toEqual({ ok: true, sessionId: "reopened-session" });
    expect(prepareSession).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: "main",
        targetPath: PARAMS.targetPath,
        attemptId: expect.any(String),
      }),
    );
    expect(prepareSession.mock.calls[0]?.[0].attemptId).not.toBe("old-attempt");
    await vi.waitFor(() => expect(currentPipeline("reopened-session")?.status).toBe("ready"));
    expect(createWorktree).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: "main" }));
  });

  it("does not join an old Git runner after an explicit Retry of the same session", async () => {
    let finishOld!: (value: GitWorktreeCreateResult) => void;
    createWorktree.mockReturnValueOnce(
      new Promise<GitWorktreeCreateResult>((resolve) => {
        finishOld = resolve;
      }),
    );
    seedCreating({ sessionId: "same-session", params: { ...PARAMS, attemptId: "old" } });
    const old = startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "same-session",
      params: { ...PARAMS, attemptId: "old" },
      formatMessage: (id) => id,
    });
    await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    });
    const store = useComposerWorktreePipelineStore.getState();
    store.startPipeline(WORKSPACE_KEY, {
      sessionId: "same-session",
      status: "creating",
      params: { ...PARAMS, attemptId: "new" },
      createdAt: Date.now(),
    });
    await startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "same-session",
      params: { ...PARAMS, attemptId: "new" },
      formatMessage: (id) => id,
    });
    expect(createWorktree).toHaveBeenCalledTimes(2);
    expect(currentPipeline("same-session")?.status).toBe("ready");
    finishOld({ ok: false, issues: [] });
    await old;
    expect(currentPipeline("same-session")).toMatchObject({
      status: "ready",
      params: { attemptId: "new" },
    });
  });
});

describe("BUG-GWT-005: frozen submission admission after failed creation → Retry → ready", () => {
  function flushAsyncWork() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // Fails while BUG-GWT-005 is present (no admission after retry→ready); turns green-proof
  // once the retry path re-admits the frozen submission, at which point remove `.fails`.
  it.fails("BUG-GWT-005: admits the frozen first submission exactly once after a retried creation turns ready", async () => {
    // C5 shape: creation fails at the Git boundary (EACCES on the worktrees parent), the user
    // restores permissions, clicks Retry (the Host mints a fresh attempt id), and the retried
    // creation succeeds. The frozen submission must then be admitted by the same prepared
    // session exactly once (specs/composer-worktree-setup-steps.md §Contract: "After Git
    // reports a ready path, activate the same session with the frozen submission … admits that
    // submission exactly once" / "one retry can admit it exactly once").
    const preparedSessionId = "session-prepared-c5";
    const onSendText = vi.fn(async () => "sent" as const);
    const onPrepareWorktreeSession = vi.fn(async () => preparedSessionId);
    const onWorktreePreparationFailed = vi.fn(async () => undefined);
    const intent: ComposerDraftWorktreeIntent = {
      workspaceKey: WORKSPACE_KEY,
      beginCreation: (queuedPromptPreview, prepareSession, syncPreparedWorktree, submissionId) =>
        beginWorktreePipelineCreation({
          gitService,
          workspaceKey: WORKSPACE_KEY,
          workspacePath: WORKSPACE_KEY,
          effectiveLocation: {
            mode: "sibling",
            customPath: null,
            appWorktreesDir: null,
            prefix: "zcode/",
            baseBranchDefault: null,
            hasProjectOverride: false,
          },
          branchName: PARAMS.branchName,
          baseBranch: PARAMS.baseBranch,
          baseFromHeadDefault: false,
          queuedPromptPreview,
          prepareSession,
          ...(syncPreparedWorktree ? { syncPreparedWorktree } : {}),
          ...(submissionId ? { submissionId } : {}),
          formatMessage: (id) => id,
        }),
    };
    try {
      // First attempt: the Git boundary rejects with EACCES, so the pipeline entry fails while
      // the submission is queued.
      createWorktree.mockRejectedValueOnce(
        new Error(`EACCES: permission denied, mkdir '${PARAMS.targetPath}'`),
      );
      render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(
            ComposerDraftWorktreeIntentContext.Provider,
            { value: { current: intent } },
            createElement(ConversationComposer, {
              composerDraft: { text: "", updatedAt: 0 },
              draftMode: true,
              onSelectModel: vi.fn(),
              onSelectThought: vi.fn(),
              onSendText,
              onPrepareWorktreeSession,
              onWorktreePreparationFailed,
              onStop: vi.fn(),
              onSwitchMode: vi.fn(),
              provider: undefined,
              sessionId: null,
              snapshot: null,
              submissionReady: true,
              updateComposerContent: vi.fn(),
              replaceComposerDraft: vi.fn(),
              workspacePath: WORKSPACE_KEY,
            }),
          ),
        ),
      );
      await act(async () => {
        composerMount.editorProps.at(-1)!.onSubmit!("C5 frozen input");
        await flushAsyncWork();
      });
      await act(async () => {
        await vi.waitFor(() => {
          expect(currentPipeline(preparedSessionId)?.status).toBe("failed");
        });
      });
      // The frozen submission was never admitted; it only lives in the session-scoped
      // recovery record (the "Unsent message saved" card of the C5 report).
      expect(onSendText).not.toHaveBeenCalled();
      expect(onPrepareWorktreeSession).toHaveBeenCalled();
      expect(
        readV4WorktreeRecoveryDrafts(WORKSPACE_KEY, undefined, preparedSessionId).some(
          (entry) => entry.draft.text === "C5 frozen input",
        ),
      ).toBe(true);

      // Retry after the permissions are restored: SessionPane.handleWorktreePreparationRetry
      // mints a fresh attempt id on the Host, then reruns creation with the frozen params.
      createWorktree.mockResolvedValue({
        ok: true,
        worktreePath: PARAMS.targetPath,
        branchName: PARAMS.branchName,
        issues: [],
      } satisfies GitWorktreeCreateResult);
      let retryOutcome: "ready" | "failed" = "failed";
      await act(async () => {
        retryOutcome = await retryComposerWorktreePipeline({
          gitService,
          workspaceKey: WORKSPACE_KEY,
          sessionId: preparedSessionId,
          attemptId: "attempt-c5-retry",
          formatMessage: (id) => id,
        });
      });
      expect(retryOutcome).toBe("ready");
      await act(async () => {
        await vi.waitFor(() => {
          expect(currentPipeline(preparedSessionId)).toMatchObject({
            status: "ready",
            worktreePath: PARAMS.targetPath,
            sessionId: preparedSessionId,
          });
        });
        await flushAsyncWork();
      });

      // The pipeline is ready with a validated path: the same prepared session must now admit
      // the frozen submission exactly once (BUG-GWT-005: nothing dispatches, the entry hangs in
      // ready and only a manual Restore → Send delivers the message).
      expect(onSendText).toHaveBeenCalledTimes(1);
      expect(onSendText).toHaveBeenCalledWith(
        "C5 frozen input",
        expect.objectContaining({
          executionWorktree: { path: PARAMS.targetPath, branchName: PARAMS.branchName },
          preparedSessionId,
        }),
      );
    } finally {
      window.localStorage.clear();
    }
  });
});
