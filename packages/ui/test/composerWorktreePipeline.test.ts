// Worktree setup pipeline store + runner tests (specs/composer-worktree-setup-steps.md):
// state machine transitions (consume-once, withdraw/orphan), runner idempotency and outcome
// mapping, and stale-creating reconcile.
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitWorktreeCreateResult } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  armWorktreeSendContinuation,
  peekWorktreeSendContinuation,
  releaseWorktreeSendContinuation,
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";
import { generateWorktreeBranchName } from "@/command-center/worktreeNameGenerator.js";
import { composeBranchName } from "@/command-center/worktreeTaskFlow.js";
import {
  isComposerWorktreeNameReserved,
  isComposerWorktreePipelineInFlight,
  beginWorktreePipelineCreation,
  reconcileCreatingComposerWorktreePipeline,
  retryComposerWorktreePipeline,
  restoreComposerWorktreePipelineFromPreparation,
  startComposerWorktreePipeline,
} from "@/v4/composer/composerWorktreePipeline.js";

import { restartPreparedWorktreeCreation } from "@/v4/composer/restartPreparedWorktreeCreation.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import { ConversationWorktreeSetupSteps } from "@/v4/ConversationWorktreeSetupSteps.js";
import {
  ComposerDraftWorktreeIntentContext,
  type ComposerDraftWorktreeIntent,
} from "@/v4/composer/composerDraftWorktreeIntent.js";
import { useDraftBranchIntentStore } from "@/v4/composer/draftBranchIntent.js";
import { readV4WorktreeRecoveryDrafts } from "@/v4/composer/composerDraftStore.js";
import enUSCatalog from "@/i18n/locales/en-US.js";

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

// ConversationWorktreeSetupSteps requires resolved workspace services; the composer keeps the real
// optional resolution (null without a provider), so only the required variant is overridden.
const setupStepsServices = vi.hoisted(() => ({
  current: null as null | { rpcReady: boolean; services: { gitService: unknown } },
}));
vi.mock("@/hooks/useWorkspaceServices.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useWorkspaceServices.js")>();
  return {
    ...actual,
    useWorkspaceServicesResolution: (
      ...args: Parameters<typeof actual.useWorkspaceServicesResolution>
    ) => setupStepsServices.current ?? actual.useWorkspaceServicesResolution(...args),
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
  // dropWorkspace (not a raw setState) also clears the module-scope armed-continuation registry,
  // so a failed pipeline left armed by a previous test's composer unmount cannot leak in.
  for (const workspaceKey of Object.keys(
    useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey,
  )) {
    useComposerWorktreePipelineStore.getState().dropWorkspace(workspaceKey);
  }
  useComposerWorktreePipelineStore.setState({ pipelineByWorkspaceKey: {} });
  useDraftBranchIntentStore.setState({
    intentByWorkspaceKey: {},
    worktreeIntentActiveByWorkspaceKey: {},
  });
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

  it("keeps the armed continuation when a stale attempt's consume/discard is rejected by the store", () => {
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
    armWorktreeSendContinuation({
      workspaceKey: WORKSPACE_KEY,
      preparedSessionId: "session-retry",
      attemptId: currentAttempt,
      hasBoundPreparedSession: true,
      dispatch: async () => {},
      restore: () => {},
      restoreForRetry: () => {},
    });

    store.consume(WORKSPACE_KEY, "session-retry", firstAttempt);
    store.discard(WORKSPACE_KEY, "session-retry", firstAttempt);
    expect(peekWorktreeSendContinuation(WORKSPACE_KEY, "session-retry")).not.toBeNull();

    store.consume(WORKSPACE_KEY, "session-retry", currentAttempt);
    expect(peekWorktreeSendContinuation(WORKSPACE_KEY, "session-retry")).toBeNull();
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

  it("BUG-GWT-005: ignores a Host seed for an attempt the renderer already superseded, but still yields to a newer Host attempt", async () => {
    seedCreating({
      sessionId: "session-superseded",
      status: "failed",
      params: { ...PARAMS, attemptId: "attempt-a" },
      failureMessage: "EACCES",
    });
    let settleGit!: (result: GitWorktreeCreateResult) => void;
    createWorktree.mockReturnValueOnce(
      new Promise<GitWorktreeCreateResult>((resolve) => {
        settleGit = resolve;
      }),
    );
    const retried = retryComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-superseded",
      attemptId: "attempt-b",
      formatMessage: (id) => id,
    });
    try {
      const seed = {
        branchName: PARAMS.branchName,
        targetPath: PARAMS.targetPath,
        baseBranch: "main",
      };
      // Stale seed for the replaced attempt (the Host snapshot has not caught up yet).
      restoreComposerWorktreePipelineFromPreparation({
        workspaceKey: WORKSPACE_KEY,
        workspacePath: WORKSPACE_KEY,
        sessionId: "session-superseded",
        preparation: {
          ...seed,
          status: "failed",
          attemptId: "attempt-a",
          failureMessage: "EACCES",
        },
      });
      expect(currentPipeline("session-superseded")).toMatchObject({
        status: "creating",
        params: { attemptId: "attempt-b" },
        supersededAttemptIds: ["attempt-a"],
      });
      // An attempt the renderer never saw (another client's retry) is genuinely newer.
      restoreComposerWorktreePipelineFromPreparation({
        workspaceKey: WORKSPACE_KEY,
        workspacePath: WORKSPACE_KEY,
        sessionId: "session-superseded",
        preparation: { ...seed, status: "preparing", attemptId: "attempt-c" },
      });
      expect(currentPipeline("session-superseded")).toMatchObject({
        status: "creating",
        params: { attemptId: "attempt-c" },
        supersededAttemptIds: ["attempt-a", "attempt-b"],
      });
      settleGit({
        ok: true,
        worktreePath: PARAMS.targetPath,
        branchName: PARAMS.branchName,
        issues: [],
      });
      // The late Git result for the replaced attempt B cannot settle attempt C.
      await expect(retried).resolves.toBe("failed");
      expect(currentPipeline("session-superseded")?.status).toBe("creating");
    } finally {
      // Never leave the module-scope in-flight runner behind for later tests.
      settleGit({ ok: false, issues: [] } as unknown as GitWorktreeCreateResult);
      await retried;
    }
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
      submissionId: "same-submission",
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
        submissionId: "same-submission",
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

  it("isolates concurrent new-chat reservations while deduplicating the same submission", async () => {
    let resolvePreparation: (sessionId: string) => void = () => {};
    const prepareSession = vi.fn(
      () => new Promise<string>((resolve) => (resolvePreparation = resolve)),
    );
    createWorktree.mockImplementation(
      async ({ targetPath, branchName }) =>
        ({
          ok: true,
          worktreePath: targetPath,
          branchName,
          issues: [],
        }) satisfies GitWorktreeCreateResult,
    );
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
    expect(beginWorktreePipelineCreation(input)).toBe(first);
    const secondPrepareSession = vi.fn(async () => "session-prepared-2");
    const second = beginWorktreePipelineCreation({
      ...input,
      queuedPromptPreview: "another chat's input",
      submissionId: "submission-2",
      branchName: "zcode/second",
      prepareSession: secondPrepareSession,
    });
    expect(second).not.toBe(first);
    await expect(second).resolves.toEqual({ ok: true, sessionId: "session-prepared-2" });
    await vi.waitFor(() => expect(currentPipeline("session-prepared-2")?.status).toBe("ready"));
    expect(prepareSession).toHaveBeenCalledTimes(1);
    expect(secondPrepareSession).toHaveBeenCalledTimes(1);

    resolvePreparation("session-prepared-1");
    await expect(first).resolves.toEqual({ ok: true, sessionId: "session-prepared-1" });
    await vi.waitFor(() => expect(currentPipeline("session-prepared-1")?.status).toBe("ready"));
    expect(createWorktree).toHaveBeenCalledTimes(2);
    expect(currentPipeline("session-prepared-1")?.params?.submissionId).toBe("submission-1");
    expect(currentPipeline("session-prepared-2")?.params?.submissionId).toBe("submission-2");

    const repeatPrepareSession = vi.fn();
    await expect(
      beginWorktreePipelineCreation({
        ...input,
        submissionId: "submission-2",
        prepareSession: repeatPrepareSession,
      }),
    ).resolves.toEqual({ ok: true, sessionId: "session-prepared-2" });
    expect(repeatPrepareSession).not.toHaveBeenCalled();
    const laterPrepareSession = vi.fn(async () => "session-prepared-3");
    await expect(
      beginWorktreePipelineCreation({
        ...input,
        submissionId: "submission-3",
        branchName: "zcode/third",
        prepareSession: laterPrepareSession,
      }),
    ).resolves.toEqual({ ok: true, sessionId: "session-prepared-3" });
    await vi.waitFor(() => expect(currentPipeline("session-prepared-3")?.status).toBe("ready"));
    expect(createWorktree).toHaveBeenCalledTimes(3);
    expect(new Set(createWorktree.mock.calls.map(([params]) => params.targetPath)).size).toBe(3);
  });

  it("does not share an in-flight admission between calls that carry no submission id", async () => {
    createWorktree.mockImplementation(
      async ({ targetPath, branchName }) =>
        ({
          ok: true,
          worktreePath: targetPath,
          branchName,
          issues: [],
        }) satisfies GitWorktreeCreateResult,
    );
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
      baseBranch: PARAMS.baseBranch,
      baseFromHeadDefault: false,
      queuedPromptPreview: "legacy input",
      formatMessage: (id: string) => id,
    };
    const firstPrepareSession = vi.fn(async () => "session-legacy-1");
    const secondPrepareSession = vi.fn(async () => "session-legacy-2");
    const first = beginWorktreePipelineCreation({
      ...input,
      branchName: "zcode/legacy-first",
      prepareSession: firstPrepareSession,
    });
    const second = beginWorktreePipelineCreation({
      ...input,
      branchName: "zcode/legacy-second",
      prepareSession: secondPrepareSession,
    });

    expect(second).not.toBe(first);
    await expect(first).resolves.toEqual({ ok: true, sessionId: "session-legacy-1" });
    await expect(second).resolves.toEqual({ ok: true, sessionId: "session-legacy-2" });
    expect(firstPrepareSession).toHaveBeenCalledTimes(1);
    expect(secondPrepareSession).toHaveBeenCalledTimes(1);
  });

  it("gives concurrent admissions different generated names so neither reuses the other's worktree", async () => {
    const effectiveLocation = {
      mode: "sibling" as const,
      customPath: null,
      appWorktreesDir: null,
      prefix: "zcode/",
      baseBranchDefault: null,
      hasProjectOverride: false,
    };
    // The generator consumes rolls in groups of three (adjective, pattern, noun): the second
    // selection first meets the first name (reserved) and then rolls a different one.
    const rolls = (values: number[]) => {
      let index = 0;
      return () => values[index++] ?? 0.99;
    };
    const chooseName = (values: number[]) =>
      generateWorktreeBranchName({
        isTaken: (raw) =>
          isComposerWorktreeNameReserved({
            workspaceKey: WORKSPACE_KEY,
            workspacePath: WORKSPACE_KEY,
            branchName: composeBranchName(effectiveLocation.prefix, raw),
            effectiveLocation,
          }),
        random: rolls(values),
      });
    const firstRaw = chooseName([0, 0, 0]);
    const first = composeBranchName(effectiveLocation.prefix, firstRaw);
    const pendingPrepare: Array<(sessionId: string) => void> = [];
    const prepareSession = () => new Promise<string>((resolve) => pendingPrepare.push(resolve));
    const admit = (branchName: string) =>
      beginWorktreePipelineCreation({
        gitService,
        workspaceKey: WORKSPACE_KEY,
        workspacePath: WORKSPACE_KEY,
        effectiveLocation,
        branchName,
        baseBranch: PARAMS.baseBranch,
        baseFromHeadDefault: false,
        queuedPromptPreview: branchName,
        // Distinct submissions: a shared submission key would dedupe the second admission into the first.
        submissionId: `submission-${branchName}`,
        prepareSession,
        formatMessage: (id: string) => id,
      });
    createWorktree.mockImplementation(
      async ({ targetPath, branchName }) =>
        ({
          ok: true,
          worktreePath: targetPath,
          branchName,
          issues: [],
        }) satisfies GitWorktreeCreateResult,
    );
    // Both admissions are in flight before either Git call or store entry exists.
    const firstAdmission = admit(first);
    const secondRaw = chooseName([0, 0, 0, 0.99, 0.99, 0.99]);
    const second = composeBranchName(effectiveLocation.prefix, secondRaw);
    expect(second).not.toBe(first);
    const secondAdmission = admit(second);
    expect(
      isComposerWorktreeNameReserved({
        workspaceKey: WORKSPACE_KEY,
        workspacePath: WORKSPACE_KEY,
        branchName: first,
        effectiveLocation,
      }),
    ).toBe(true);

    pendingPrepare[0]!("session-first");
    pendingPrepare[1]!("session-second");
    await expect(firstAdmission).resolves.toEqual({ ok: true, sessionId: "session-first" });
    await expect(secondAdmission).resolves.toEqual({ ok: true, sessionId: "session-second" });
    await vi.waitFor(() => expect(currentPipeline("session-first")?.status).toBe("ready"));
    await vi.waitFor(() => expect(currentPipeline("session-second")?.status).toBe("ready"));

    const targets = createWorktree.mock.calls.map(([params]) => params.targetPath);
    expect(new Set(targets).size).toBe(2);
    expect(currentPipeline("session-first")).toMatchObject({ existing: false });
    expect(currentPipeline("session-second")).toMatchObject({ existing: false });
    expect(currentPipeline("session-first")?.params?.targetPath).not.toBe(
      currentPipeline("session-second")?.params?.targetPath,
    );
  });

  it("releases an admission's name claim when preparation fails before the store entry exists", async () => {
    const effectiveLocation = {
      mode: "sibling" as const,
      customPath: null,
      appWorktreesDir: null,
      prefix: "zcode/",
      baseBranchDefault: null,
      hasProjectOverride: false,
    };
    const reserved = () =>
      isComposerWorktreeNameReserved({
        workspaceKey: WORKSPACE_KEY,
        workspacePath: WORKSPACE_KEY,
        branchName: PARAMS.branchName,
        effectiveLocation,
      });
    const result = await beginWorktreePipelineCreation({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      effectiveLocation,
      branchName: PARAMS.branchName,
      baseBranch: PARAMS.baseBranch,
      baseFromHeadDefault: false,
      queuedPromptPreview: "frozen input",
      prepareSession: vi.fn(async () => {
        throw new Error("host unavailable");
      }),
      formatMessage: (id: string) => id,
    });
    expect(result).toEqual({ ok: false });
    expect(reserved()).toBe(false);
  });

  it("keeps a live pipeline's name reserved and fails an existing-worktree reuse of another session's directory", async () => {
    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "creating",
      sessionId: "session-owner",
      params: { ...PARAMS, attemptId: "attempt-owner" },
      createdAt: 1,
    });
    useComposerWorktreePipelineStore
      .getState()
      .markReady(WORKSPACE_KEY, PARAMS.targetPath, false, "session-owner", "attempt-owner");
    expect(
      isComposerWorktreeNameReserved({
        workspaceKey: WORKSPACE_KEY,
        workspacePath: WORKSPACE_KEY,
        branchName: PARAMS.branchName,
        effectiveLocation: {
          mode: "sibling",
          customPath: null,
          appWorktreesDir: null,
          prefix: "zcode/",
          baseBranchDefault: null,
          hasProjectOverride: false,
        },
      }),
    ).toBe(true);

    createWorktree.mockResolvedValue({
      ok: false,
      worktreePath: null,
      branchName: null,
      issues: [{ code: "branch-in-other-worktree", message: "branch checked out elsewhere" }],
    } satisfies GitWorktreeCreateResult);
    listWorktrees.mockResolvedValue({
      isGitAvailable: true,
      isRepository: true,
      worktrees: [worktreeEntry(PARAMS.targetPath)],
    });
    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "creating",
      sessionId: "session-intruder",
      params: { ...PARAMS, attemptId: "attempt-intruder" },
      createdAt: 2,
    });

    const outcome = await startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-intruder",
      params: { ...PARAMS, attemptId: "attempt-intruder" },
      formatMessage: (id: string) => id,
    });

    expect(outcome).toBe("failed");
    expect(currentPipeline("session-intruder")).toMatchObject({
      status: "failed",
      failureMessage: "worktreeSetup.reservation.conflict",
    });
    expect(currentPipeline("session-owner")).toMatchObject({ status: "ready" });
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

  it("BUG-GWT-005: a stale failed seed without an attempt id cannot fail the retried attempt", () => {
    seedCreating({
      sessionId: "session-legacy-seed",
      status: "failed",
      params: { ...PARAMS, attemptId: "attempt-a" },
      failureMessage: "EACCES",
    });
    useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
      status: "creating",
      sessionId: "session-legacy-seed",
      params: { ...PARAMS, attemptId: "attempt-b" },
      createdAt: 2,
    });
    // A marker written without the optional attempt id (older Host) still reports the old failure.
    restoreComposerWorktreePipelineFromPreparation({
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      sessionId: "session-legacy-seed",
      preparation: {
        status: "failed",
        branchName: PARAMS.branchName,
        targetPath: PARAMS.targetPath,
        failureMessage: "EACCES",
      },
    });
    expect(currentPipeline("session-legacy-seed")).toMatchObject({
      status: "creating",
      params: { attemptId: "attempt-b" },
    });
  });

  it("BUG-GWT-005: a prepared-session restart is not rolled back by the stale Host failed seed", async () => {
    // Same stale-seed race as Retry, through the composer's restart path (Send in a prepared
    // session whose entry failed): restart replaces failed(A) with creating(C) while the setup
    // steps still hold the Host seed for A.
    seedCreating({
      sessionId: "restarted-session",
      status: "failed",
      params: { ...PARAMS, attemptId: "attempt-a" },
      failureMessage: "EACCES",
    });
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    });
    await restartPreparedWorktreeCreation({
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      sessionId: "restarted-session",
      preparation: { ...PARAMS, status: "failed", attemptId: "attempt-a" },
      gitService,
      prepareSession: async () => "restarted-session",
      formatMessage: (id) => id,
    });
    const restartedAttempt = currentPipeline("restarted-session")!.params!.attemptId;
    restoreComposerWorktreePipelineFromPreparation({
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      sessionId: "restarted-session",
      preparation: {
        ...PARAMS,
        status: "failed",
        attemptId: "attempt-a",
        failureMessage: "EACCES",
      },
    });
    expect(currentPipeline("restarted-session")?.params?.attemptId).toBe(restartedAttempt);
    await vi.waitFor(() =>
      expect(currentPipeline("restarted-session")).toMatchObject({
        status: "ready",
        params: { attemptId: restartedAttempt },
      }),
    );
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

  // Regression for BUG-GWT-005 (docs/testing/git-worktree-qa/bugs/BUG-GWT-005.md): the live UI
  // path failed while the store-level path passed, so this test also reproduces the first-send
  // view promotion (draft composer becomes the prepared session's composer) and the empty-state
  // worktree toggle unmount clearing the intent mirror before Retry is clicked.
  it("BUG-GWT-005: admits the frozen first submission exactly once after a retried creation turns ready", async () => {
    // C5 shape: creation fails at the Git boundary (EACCES on the worktrees parent), the view
    // promotes to the prepared session, the user restores permissions, clicks Retry (the Host
    // mints a fresh attempt id), and the retried creation succeeds. The frozen submission must
    // then be admitted by the same prepared session exactly once
    // (specs/composer-worktree-setup-steps.md §Contract: "After Git reports a ready path,
    // activate the same session with the frozen submission … admits that submission exactly
    // once" / "one retry can admit it exactly once").
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
    const composerElement = (props: { draftMode: boolean; sessionId: string | null }) =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          ComposerDraftWorktreeIntentContext.Provider,
          { value: { current: intent } },
          createElement(ConversationComposer, {
            composerDraft: { text: "", updatedAt: 0 },
            draftMode: props.draftMode,
            onSelectModel: vi.fn(),
            onSelectThought: vi.fn(),
            onSendText,
            onPrepareWorktreeSession,
            onWorktreePreparationFailed,
            onStop: vi.fn(),
            onSwitchMode: vi.fn(),
            provider: undefined,
            sessionId: props.sessionId,
            snapshot: null,
            submissionReady: true,
            updateComposerContent: vi.fn(),
            replaceComposerDraft: vi.fn(),
            workspacePath: WORKSPACE_KEY,
          }),
        ),
      );
    try {
      // Live state before the first send: the worktree intent mirror is on.
      useDraftBranchIntentStore.getState().setWorktreeIntentActive(WORKSPACE_KEY, true);
      // First attempt: the Git boundary rejects with EACCES, so the pipeline entry fails while
      // the submission is queued.
      createWorktree.mockRejectedValueOnce(
        new Error(`EACCES: permission denied, mkdir '${PARAMS.targetPath}'`),
      );
      const view = render(composerElement({ draftMode: true, sessionId: null }));
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

      // First-send promotion: the composer is reused for the prepared session (stable key), and
      // the empty-state worktree toggle unmounts, clearing the draft-only intent mirror. The
      // armed frozen submission must survive both (BUG-GWT-005 live trigger).
      useDraftBranchIntentStore.getState().setWorktreeIntentActive(WORKSPACE_KEY, false);
      view.rerender(composerElement({ draftMode: false, sessionId: preparedSessionId }));
      await act(async () => {
        await flushAsyncWork();
      });
      expect(onSendText).not.toHaveBeenCalled();

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
          expect(onSendText).toHaveBeenCalledTimes(1);
        });
        await flushAsyncWork();
      });

      // The pipeline is ready with a validated path: the same prepared session admitted the
      // frozen submission exactly once and consumed the entry (terminal success).
      expect(onSendText).toHaveBeenCalledTimes(1);
      expect(onSendText).toHaveBeenCalledWith(
        "C5 frozen input",
        expect.objectContaining({
          executionWorktree: { path: PARAMS.targetPath, branchName: PARAMS.branchName },
          preparedSessionId,
        }),
      );
      expect(currentPipeline(preparedSessionId)).toMatchObject({
        status: "consumed",
        worktreePath: PARAMS.targetPath,
        sessionId: preparedSessionId,
      });
    } finally {
      window.localStorage.clear();
    }
  });

  it("BUG-GWT-005: admits the frozen submission after the draft composer unmounts and the prepared session's composer remounts (RT2-C5 live path)", async () => {
    // RT2-C5 wave-2 live evidence: the same-instance rerender above stayed green while the live
    // app never admitted after Retry→ready (0 admission RPC for 225 s). The live first-send view
    // promotion swaps the composer INSTANCE (the draft view unmounts; the prepared session's view
    // mounts its own composer), so a component-ref continuation died with the old instance and
    // the new instance's queued-send effect saw nothing. This regression unmounts the draft
    // composer and mounts a fresh composer bound to the prepared session before Retry, which is
    // the missing coverage: the armed continuation must live outside the component instance and
    // be adopted by the prepared session's composer
    // (specs/composer-worktree-setup-steps.md §Contract "Retry-admission is a renderer
    // obligation … survives the first-send view promotion").
    const preparedSessionId = "session-prepared-c5-remount";
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
    const composerElement = (props: { draftMode: boolean; sessionId: string | null }) =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          ComposerDraftWorktreeIntentContext.Provider,
          { value: { current: intent } },
          createElement(ConversationComposer, {
            composerDraft: { text: "", updatedAt: 0 },
            draftMode: props.draftMode,
            onSelectModel: vi.fn(),
            onSelectThought: vi.fn(),
            onSendText,
            onPrepareWorktreeSession,
            onWorktreePreparationFailed,
            onStop: vi.fn(),
            onSwitchMode: vi.fn(),
            provider: undefined,
            sessionId: props.sessionId,
            snapshot: null,
            submissionReady: true,
            updateComposerContent: vi.fn(),
            replaceComposerDraft: vi.fn(),
            workspacePath: WORKSPACE_KEY,
          }),
        ),
      );
    try {
      // Live state before the first send: the worktree intent mirror is on.
      useDraftBranchIntentStore.getState().setWorktreeIntentActive(WORKSPACE_KEY, true);
      createWorktree.mockRejectedValueOnce(
        new Error(`EACCES: permission denied, mkdir '${PARAMS.targetPath}'`),
      );
      const draftView = render(composerElement({ draftMode: true, sessionId: null }));
      await act(async () => {
        composerMount.editorProps.at(-1)!.onSubmit!("RT2-C5 frozen input");
        await flushAsyncWork();
      });
      await act(async () => {
        await vi.waitFor(() => {
          expect(currentPipeline(preparedSessionId)?.status).toBe("failed");
        });
      });
      expect(onSendText).not.toHaveBeenCalled();

      // The live view promotion: the draft composer instance UNMOUNTS (the draft view is replaced
      // by the prepared session's view), and a DIFFERENT composer instance mounts bound to the
      // prepared session. The empty-state worktree toggle unmounts with it (intent mirror off).
      draftView.unmount();
      useDraftBranchIntentStore.getState().setWorktreeIntentActive(WORKSPACE_KEY, false);
      render(composerElement({ draftMode: false, sessionId: preparedSessionId }));
      await act(async () => {
        await flushAsyncWork();
      });
      // The frozen submission is still claimed (editor empty, no restore) and recoverable.
      expect(onSendText).not.toHaveBeenCalled();
      expect(
        readV4WorktreeRecoveryDrafts(WORKSPACE_KEY, undefined, preparedSessionId).some(
          (entry) => entry.draft.text === "RT2-C5 frozen input",
        ),
      ).toBe(true);

      // Retry with a fresh attempt id (SessionPane.handleWorktreePreparationRetry mints one on
      // the Host): the remounted composer must adopt the armed continuation and admit exactly
      // once when the retried creation turns ready — with no further user action.
      createWorktree.mockResolvedValue({
        ok: true,
        worktreePath: PARAMS.targetPath,
        branchName: PARAMS.branchName,
        issues: [],
      } satisfies GitWorktreeCreateResult);
      const retryOutcome = await retryComposerWorktreePipeline({
        gitService,
        workspaceKey: WORKSPACE_KEY,
        sessionId: preparedSessionId,
        attemptId: "attempt-c5-retry-remount",
        formatMessage: (id) => id,
      });
      expect(retryOutcome).toBe("ready");
      await act(async () => {
        await vi.waitFor(() => {
          expect(onSendText).toHaveBeenCalledTimes(1);
        });
        await flushAsyncWork();
      });

      expect(onSendText).toHaveBeenCalledTimes(1);
      expect(onSendText).toHaveBeenCalledWith(
        "RT2-C5 frozen input",
        expect.objectContaining({
          executionWorktree: { path: PARAMS.targetPath, branchName: PARAMS.branchName },
          preparedSessionId,
        }),
      );
      expect(currentPipeline(preparedSessionId)).toMatchObject({
        status: "consumed",
        worktreePath: PARAMS.targetPath,
        sessionId: preparedSessionId,
      });
      // Admitted: the recovery record for the frozen submission is gone.
      expect(
        readV4WorktreeRecoveryDrafts(WORKSPACE_KEY, undefined, preparedSessionId).some(
          (entry) => entry.draft.text === "RT2-C5 frozen input",
        ),
      ).toBe(false);
    } finally {
      window.localStorage.clear();
    }
  });

  it.each(["creating", "ready"] as const)(
    "a new chat creates its own worktree when another pipeline is %s",
    async (previousStatus) => {
      const stuckSessionId = "session-stuck-ready";
      const onSendText = vi.fn(async () => "sent" as const);
      const onPrepareWorktreeSession = vi.fn(async () => "session-fresh-worktree");
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
        // A previous preparation is stuck ready: its frozen submission lives only in its
        // session-scoped recovery record, and the entry still owns a validated worktree path.
        useComposerWorktreePipelineStore.getState().startPipeline(WORKSPACE_KEY, {
          status: previousStatus,
          sessionId: stuckSessionId,
          params: {
            ...PARAMS,
            branchName: "zcode/old",
            targetPath: "/dev/alpha-worktrees/zcode-old",
            attemptId: "attempt-stuck",
          },
          worktreePath: "/dev/alpha-worktrees/zcode-old",
          createdAt: 1,
        });
        const previousPipeline = currentPipeline(stuckSessionId);
        createWorktree.mockResolvedValue({
          ok: true,
          worktreePath: PARAMS.targetPath,
          branchName: PARAMS.branchName,
          issues: [],
        });
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
                onWorktreePreparationFailed: vi.fn(async () => undefined),
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
          composerMount.editorProps.at(-1)!.onSubmit!("New task text");
          await flushAsyncWork();
        });
        await act(async () => {
          await vi.waitFor(() => {
            expect(onSendText).toHaveBeenCalledTimes(1);
          });
          await flushAsyncWork();
        });

        expect(onPrepareWorktreeSession).toHaveBeenCalledTimes(1);
        expect(createWorktree).toHaveBeenCalledTimes(1);
        expect(onSendText).toHaveBeenCalledTimes(1);
        expect(onSendText).toHaveBeenCalledWith(
          "New task text",
          expect.objectContaining({
            executionWorktree: { path: PARAMS.targetPath, branchName: PARAMS.branchName },
            preparedSessionId: "session-fresh-worktree",
          }),
        );
        expect(currentPipeline(stuckSessionId)).toEqual(previousPipeline);
        expect(currentPipeline("session-fresh-worktree")?.status).toBe("consumed");
        // The message was delivered, so it must not linger in any recovery record.
        expect(
          readV4WorktreeRecoveryDrafts(WORKSPACE_KEY, undefined, "session-fresh-worktree").some(
            (entry) => entry.draft.text === "New task text",
          ),
        ).toBe(false);
      } finally {
        window.localStorage.clear();
      }
    },
  );

  it("BUG-GWT-005: the stale Host failed seed for the retried attempt cannot roll back Retry and strand the frozen submission (RT4-C5 live path)", async () => {
    // RT4-C5 live CDP evidence: clicking the real Retry button started the new attempt
    // (creating, attempt B), but the setup-steps Host reconcile effect re-ran with the still-stale
    // preparation seed (failed, attempt A) — the Host accepts the retry before its snapshot reaches
    // the renderer — and treated A as a "newer Host generation". The entry rolled back to failed A
    // for one render, the queued-send effect detached and released the armed continuation, and the
    // later ready for B admitted nothing (specs/composer-worktree-setup-steps.md §Contract: "a
    // stale completion cannot mutate a newer retry"; "After a successful Retry settles ready, that
    // same prepared session must be activated and the frozen submission admitted exactly once").
    const preparedSessionId = "session-prepared-c5-stale-seed";
    const onSendText = vi.fn(async () => "sent" as const);
    const onPrepareWorktreeSession = vi.fn(async () => preparedSessionId);
    const onWorktreePreparationFailed = vi.fn(async () => undefined);
    const onRetryPreparation = vi.fn(async () => "attempt-c5-retry-host");
    setupStepsServices.current = { rpcReady: true, services: { gitService } };
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
    const sessionView = (props: {
      draftMode: boolean;
      sessionId: string | null;
      preparation?: { status: "preparing" | "failed"; attemptId: string; failureMessage?: string };
    }) =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          ComposerDraftWorktreeIntentContext.Provider,
          { value: { current: intent } },
          props.sessionId && props.preparation
            ? createElement(ConversationWorktreeSetupSteps, {
                workspacePath: WORKSPACE_KEY,
                sessionId: props.sessionId,
                preparation: {
                  branchName: PARAMS.branchName,
                  targetPath: PARAMS.targetPath,
                  baseBranch: PARAMS.baseBranch,
                  ...props.preparation,
                },
                onRetryPreparation,
                onPreparationFailed: onWorktreePreparationFailed,
              })
            : null,
          createElement(ConversationComposer, {
            composerDraft: { text: "", updatedAt: 0 },
            draftMode: props.draftMode,
            onSelectModel: vi.fn(),
            onSelectThought: vi.fn(),
            onSendText,
            onPrepareWorktreeSession,
            onWorktreePreparationFailed,
            onStop: vi.fn(),
            onSwitchMode: vi.fn(),
            provider: undefined,
            sessionId: props.sessionId,
            snapshot: null,
            submissionReady: true,
            updateComposerContent: vi.fn(),
            replaceComposerDraft: vi.fn(),
            workspacePath: WORKSPACE_KEY,
          }),
        ),
      );
    try {
      useDraftBranchIntentStore.getState().setWorktreeIntentActive(WORKSPACE_KEY, true);
      createWorktree.mockRejectedValueOnce(
        new Error(`EACCES: permission denied, mkdir '${PARAMS.targetPath}'`),
      );
      const view = render(sessionView({ draftMode: true, sessionId: null }));
      await act(async () => {
        composerMount.editorProps.at(-1)!.onSubmit!("RT4-C5 frozen input");
        await flushAsyncWork();
      });
      await act(async () => {
        await vi.waitFor(() => {
          expect(currentPipeline(preparedSessionId)?.status).toBe("failed");
        });
      });
      const failedAttemptId = currentPipeline(preparedSessionId)!.params!.attemptId!;

      // Live promotion (same composer instance, as the CDP trace showed) plus the setup steps fed
      // by the Host seed for the failed attempt.
      useDraftBranchIntentStore.getState().setWorktreeIntentActive(WORKSPACE_KEY, false);
      const failedSeed = {
        status: "failed" as const,
        attemptId: failedAttemptId,
        failureMessage: "EACCES",
      };
      view.rerender(
        sessionView({ draftMode: false, sessionId: preparedSessionId, preparation: failedSeed }),
      );
      await act(async () => {
        await flushAsyncWork();
      });
      expect(onSendText).not.toHaveBeenCalled();

      // Retry through the real button. The Host accepts the new attempt, but the preparation
      // seed stays the stale failed one until the Host snapshot arrives.
      createWorktree.mockResolvedValue({
        ok: true,
        worktreePath: PARAMS.targetPath,
        branchName: PARAMS.branchName,
        issues: [],
      } satisfies GitWorktreeCreateResult);
      await act(async () => {
        screen.getByRole("button", { name: "Retry" }).click();
        await flushAsyncWork();
      });
      // The Host snapshot for the retried attempt arrives afterwards.
      view.rerender(
        sessionView({
          draftMode: false,
          sessionId: preparedSessionId,
          preparation: { status: "preparing", attemptId: "attempt-c5-retry-host" },
        }),
      );
      await act(async () => {
        await vi.waitFor(() => {
          expect(onSendText).toHaveBeenCalledTimes(1);
        });
        await flushAsyncWork();
      });

      expect(onRetryPreparation).toHaveBeenCalledTimes(1);
      expect(onSendText).toHaveBeenCalledTimes(1);
      expect(onSendText).toHaveBeenCalledWith(
        "RT4-C5 frozen input",
        expect.objectContaining({
          executionWorktree: { path: PARAMS.targetPath, branchName: PARAMS.branchName },
          preparedSessionId,
          preparedAttemptId: "attempt-c5-retry-host",
        }),
      );
      expect(currentPipeline(preparedSessionId)).toMatchObject({
        status: "consumed",
        sessionId: preparedSessionId,
      });
      // Admitted, so the recovery card's record is gone (MINOR-1).
      expect(
        readV4WorktreeRecoveryDrafts(WORKSPACE_KEY, undefined, preparedSessionId).some(
          (entry) => entry.draft.text === "RT4-C5 frozen input",
        ),
      ).toBe(false);
    } finally {
      setupStepsServices.current = null;
      window.localStorage.clear();
    }
  });

  it("BUG-GWT-005: Retry still starts Git and admits the frozen submission once when the Host snapshot for the retried attempt arrives before the Retry acknowledgement", async () => {
    // Opposite ordering of the RT4-C5 race (BUG-GWT-005 Wave 4): the Host snapshot preparing(B)
    // reaches the renderer while onRetryPreparation is still pending. Restore adopts B as
    // `creating`; the Retry handler only proceeded from `failed`, so nobody started Git for B and
    // the stale-creating reconcile settled B as failed and reported it to the Host
    // (specs/composer-worktree-setup-steps.md acceptance scenario 18).
    const preparedSessionId = "session-prepared-c5-early-snapshot";
    const onSendText = vi.fn(async () => "sent" as const);
    const onPrepareWorktreeSession = vi.fn(async () => preparedSessionId);
    const onWorktreePreparationFailed = vi.fn(async () => undefined);
    let acknowledgeRetry!: (attemptId: string) => void;
    const onRetryPreparation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          acknowledgeRetry = resolve;
        }),
    );
    setupStepsServices.current = { rpcReady: true, services: { gitService } };
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
    const sessionView = (props: {
      draftMode: boolean;
      sessionId: string | null;
      preparation?: { status: "preparing" | "failed"; attemptId: string; failureMessage?: string };
    }) =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          ComposerDraftWorktreeIntentContext.Provider,
          { value: { current: intent } },
          props.sessionId && props.preparation
            ? createElement(ConversationWorktreeSetupSteps, {
                workspacePath: WORKSPACE_KEY,
                sessionId: props.sessionId,
                preparation: {
                  branchName: PARAMS.branchName,
                  targetPath: PARAMS.targetPath,
                  baseBranch: PARAMS.baseBranch,
                  ...props.preparation,
                },
                onRetryPreparation,
                onPreparationFailed: onWorktreePreparationFailed,
              })
            : null,
          createElement(ConversationComposer, {
            composerDraft: { text: "", updatedAt: 0 },
            draftMode: props.draftMode,
            onSelectModel: vi.fn(),
            onSelectThought: vi.fn(),
            onSendText,
            onPrepareWorktreeSession,
            onWorktreePreparationFailed,
            onStop: vi.fn(),
            onSwitchMode: vi.fn(),
            provider: undefined,
            sessionId: props.sessionId,
            snapshot: null,
            submissionReady: true,
            updateComposerContent: vi.fn(),
            replaceComposerDraft: vi.fn(),
            workspacePath: WORKSPACE_KEY,
          }),
        ),
      );
    try {
      useDraftBranchIntentStore.getState().setWorktreeIntentActive(WORKSPACE_KEY, true);
      createWorktree.mockRejectedValueOnce(
        new Error(`EACCES: permission denied, mkdir '${PARAMS.targetPath}'`),
      );
      const view = render(sessionView({ draftMode: true, sessionId: null }));
      await act(async () => {
        composerMount.editorProps.at(-1)!.onSubmit!("RT4-C5 early snapshot input");
        await flushAsyncWork();
      });
      await act(async () => {
        await vi.waitFor(() => {
          expect(currentPipeline(preparedSessionId)?.status).toBe("failed");
        });
      });
      const failedAttemptId = currentPipeline(preparedSessionId)!.params!.attemptId!;

      // Live promotion (same composer instance, as the CDP trace showed) plus the setup steps fed
      // by the Host seed for the failed attempt.
      useDraftBranchIntentStore.getState().setWorktreeIntentActive(WORKSPACE_KEY, false);
      const failedSeed = {
        status: "failed" as const,
        attemptId: failedAttemptId,
        failureMessage: "EACCES",
      };
      view.rerender(
        sessionView({ draftMode: false, sessionId: preparedSessionId, preparation: failedSeed }),
      );
      await act(async () => {
        await flushAsyncWork();
      });
      expect(onSendText).not.toHaveBeenCalled();

      // Retry through the real button; the Host acknowledgement stays pending.
      createWorktree.mockResolvedValue({
        ok: true,
        worktreePath: PARAMS.targetPath,
        branchName: PARAMS.branchName,
        issues: [],
      } satisfies GitWorktreeCreateResult);
      listWorktrees.mockResolvedValue({ worktrees: [] });
      await act(async () => {
        screen.getByRole("button", { name: "Retry" }).click();
        await flushAsyncWork();
      });
      // The Host snapshot for the retried attempt arrives before the acknowledgement. Flush so a
      // stale-creating reconcile, if allowed to run, would settle the adopted attempt first.
      view.rerender(
        sessionView({
          draftMode: false,
          sessionId: preparedSessionId,
          preparation: { status: "preparing", attemptId: "attempt-c5-retry-host" },
        }),
      );
      await act(async () => {
        await flushAsyncWork();
        await flushAsyncWork();
      });
      expect(currentPipeline(preparedSessionId)).toMatchObject({
        status: "creating",
        params: { attemptId: "attempt-c5-retry-host" },
      });

      await act(async () => {
        acknowledgeRetry("attempt-c5-retry-host");
        await vi.waitFor(() => {
          expect(onSendText).toHaveBeenCalledTimes(1);
        });
        await flushAsyncWork();
      });

      expect(createWorktree).toHaveBeenCalledTimes(2);
      expect(onWorktreePreparationFailed).not.toHaveBeenCalledWith(
        preparedSessionId,
        expect.anything(),
        "attempt-c5-retry-host",
      );
      expect(onRetryPreparation).toHaveBeenCalledTimes(1);
      expect(onSendText).toHaveBeenCalledTimes(1);
      expect(onSendText).toHaveBeenCalledWith(
        "RT4-C5 early snapshot input",
        expect.objectContaining({
          executionWorktree: { path: PARAMS.targetPath, branchName: PARAMS.branchName },
          preparedSessionId,
          preparedAttemptId: "attempt-c5-retry-host",
        }),
      );
      expect(currentPipeline(preparedSessionId)).toMatchObject({
        status: "consumed",
        sessionId: preparedSessionId,
      });
      // Admitted, so the recovery card's record is gone (MINOR-1).
      expect(
        readV4WorktreeRecoveryDrafts(WORKSPACE_KEY, undefined, preparedSessionId).some(
          (entry) => entry.draft.text === "RT4-C5 early snapshot input",
        ),
      ).toBe(false);
    } finally {
      setupStepsServices.current = null;
      window.localStorage.clear();
    }
  });
});

describe("worktree failure classification and queue-time preflight", () => {
  function formatWithEnUs(id: string, values?: Record<string, string>): string {
    const template = enUSCatalog[id] ?? id;
    return Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{${key}}`, value),
      template,
    );
  }

  it("carries the primary issue code and raw detail into the failed pipeline entry", async () => {
    seedCreating({ sessionId: "session-failure-detail" });
    createWorktree.mockResolvedValueOnce({
      ok: false,
      worktreePath: null,
      branchName: null,
      issues: [
        {
          code: "target-branch-not-found",
          message: "Base branch was not found.",
          detail: "fatal: invalid reference: main",
        },
      ],
    });
    const outcome = await startComposerWorktreePipeline({
      gitService,
      workspaceKey: WORKSPACE_KEY,
      sessionId: "session-failure-detail",
      params: { ...PARAMS, attemptId: currentPipeline("session-failure-detail")!.attemptId },
      formatMessage: formatWithEnUs,
    });
    expect(outcome).toBe("failed");
    expect(currentPipeline("session-failure-detail")).toMatchObject({
      status: "failed",
      failureIssueCode: "target-branch-not-found",
      failureDetail: "fatal: invalid reference: main",
    });
  });

  it("blocks Send before any session exists for an unborn HEAD repository", async () => {
    const getLocalBranches = vi.fn(async () => ({
      headRefType: "branch",
      currentBranchName: "main",
      branches: [],
    }));
    const prepareSession = vi.fn(async () => "session-should-not-exist");
    const result = await beginWorktreePipelineCreation({
      gitService: { ...gitService, getLocalBranches },
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      effectiveLocation: { mode: "project" },
      branchName: PARAMS.branchName,
      baseFromHeadDefault: true,
      queuedPromptPreview: "preview",
      prepareSession,
      formatMessage: formatWithEnUs,
    });
    expect(result).toEqual({ ok: false });
    expect(prepareSession).not.toHaveBeenCalled();
    expect(currentPipeline()?.failureMessage).toContain("“main” was not found");
    expect(currentPipeline()?.failureMessage).toContain(
      "A repository without commits has no branches yet",
    );
  });

  it("blocks Send when an explicitly chosen base branch is missing from a loaded list", async () => {
    const getLocalBranches = vi.fn(async () => ({
      headRefType: "branch",
      currentBranchName: "main",
      branches: [{ name: "main" }, { name: "feature-x" }],
    }));
    const prepareSession = vi.fn(async () => "session-should-not-exist");
    const result = await beginWorktreePipelineCreation({
      gitService: { ...gitService, getLocalBranches },
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      effectiveLocation: { mode: "project" },
      branchName: PARAMS.branchName,
      baseBranch: "develop",
      baseFromHeadDefault: false,
      queuedPromptPreview: "preview",
      prepareSession,
      formatMessage: formatWithEnUs,
    });
    expect(result).toEqual({ ok: false });
    expect(prepareSession).not.toHaveBeenCalled();
    expect(currentPipeline()?.failureMessage).toContain("“develop” was not found");
  });

  it("never blocks Send when the branch probe fails (degrade to HEAD)", async () => {
    const getLocalBranches = vi.fn(async () => {
      throw new Error("branch rpc failed");
    });
    const prepareSession = vi.fn(async () => {
      seedCreating({ sessionId: "session-preflight-degraded" });
      return "session-preflight-degraded";
    });
    createWorktree.mockResolvedValueOnce({
      ok: true,
      worktreePath: PARAMS.targetPath,
      branchName: PARAMS.branchName,
      issues: [],
    });
    const result = await beginWorktreePipelineCreation({
      gitService: { ...gitService, getLocalBranches },
      workspaceKey: WORKSPACE_KEY,
      workspacePath: WORKSPACE_KEY,
      effectiveLocation: { mode: "project" },
      branchName: PARAMS.branchName,
      baseFromHeadDefault: true,
      queuedPromptPreview: "preview",
      prepareSession,
      formatMessage: formatWithEnUs,
    });
    expect(result).toEqual({ ok: true, sessionId: "session-preflight-degraded" });
  });
});
describe("shared-context-only worktree submission recovery", () => {
  const SHARED_CONTEXT_ID = "context-shared-recovery";
  // Minimal pending share import on the composer snapshot; the other fields are the ones the
  // composer reads on render, and no session-level state is needed for the send path.
  const snapshotWithSharedContext = (pending: boolean) =>
    ({
      sessionId: null,
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
      inputRouting: { mode: "startNow" },
      meta: { title: "Session", titleSource: "generated" },
      config: { provider: "", model: "", thought: "", followupMode: "queue", mode: "build" },
      usage: {
        contextWindow: null,
        cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      queue: { items: [], autoDrain: true },
      rows: { totalCount: 0 },
      sharedContextImport: pending
        ? {
            contextId: SHARED_CONTEXT_ID,
            title: "Shared plan",
            shareUrl: "https://zcode.example/cn/share/shared1",
            status: "pending",
          }
        : undefined,
    }) as never;

  it("keeps the shared-context reference in the recovery record and restores it for the retry send", async () => {
    const preparedSessionId = "session-prepared-shared";
    const onSendText = vi.fn(async () => "sent" as const);
    const onPrepareWorktreeSession = vi.fn(async () => preparedSessionId);
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
    const composerElement = (props: {
      draftMode: boolean;
      sessionId: string | null;
      pending: boolean;
    }) =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          ComposerDraftWorktreeIntentContext.Provider,
          { value: { current: intent } },
          // A remount is a fresh composer instance, as on first-send view promotion or reload.
          createElement(ConversationComposer, {
            key: props.draftMode ? "draft" : "prepared",
            composerDraft: { text: "", updatedAt: 0 },
            draftMode: props.draftMode,
            onSelectModel: vi.fn(),
            onSelectThought: vi.fn(),
            onSendText,
            onPrepareWorktreeSession,
            onWorktreePreparationFailed: vi.fn(async () => undefined),
            onStop: vi.fn(),
            onSwitchMode: vi.fn(),
            provider: undefined,
            sessionId: props.sessionId,
            snapshot: snapshotWithSharedContext(props.pending),
            submissionReady: true,
            updateComposerContent: vi.fn(),
            replaceComposerDraft: vi.fn(),
            workspacePath: WORKSPACE_KEY,
          }),
        ),
      );
    try {
      useDraftBranchIntentStore.getState().setWorktreeIntentActive(WORKSPACE_KEY, true);
      // Git preparation fails for the shared-context-only submission (no typed text).
      createWorktree.mockRejectedValueOnce(
        new Error(`EACCES: permission denied, mkdir '${PARAMS.targetPath}'`),
      );
      const view = render(composerElement({ draftMode: true, sessionId: null, pending: true }));
      await act(async () => {
        composerMount.editorProps.at(-1)!.onSubmit!("");
        await flushSharedContextWork();
      });
      await act(async () => {
        await vi.waitFor(() => {
          expect(currentPipeline(preparedSessionId)?.status).toBe("failed");
        });
      });
      expect(onSendText).not.toHaveBeenCalled();
      // The recovery record keeps the reference; without it the draft is dropped on persist.
      const recovered = readV4WorktreeRecoveryDrafts(WORKSPACE_KEY, undefined, preparedSessionId);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.draft.recoveryContexts?.sharedContextRefs).toEqual([
        { kind: "shared_context_import", context_id: SHARED_CONTEXT_ID },
      ]);

      // App reload: the module-scope armed continuation is gone and the snapshot no longer offers
      // the pending import, so only the recovery record can re-attach the shared context.
      releaseWorktreeSendContinuation(WORKSPACE_KEY, preparedSessionId);
      view.rerender(
        composerElement({ draftMode: false, sessionId: preparedSessionId, pending: false }),
      );
      await act(async () => {
        await flushSharedContextWork();
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true }));
        await flushSharedContextWork();
      });
      await act(async () => {
        composerMount.editorProps.at(-1)!.onSubmit!("");
        await flushSharedContextWork();
      });
      expect(onSendText).toHaveBeenCalledWith(
        "",
        expect.objectContaining({
          sharedContextRefs: [{ kind: "shared_context_import", context_id: SHARED_CONTEXT_ID }],
        }),
      );
    } finally {
      window.localStorage.clear();
    }
  });
});

function flushSharedContextWork() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
