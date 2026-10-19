// @vitest-environment jsdom
/**
 * Return-to-draft hand-off for a failed worktree creation
 * (spec: specs/composer-worktree-setup-steps.md §Return to draft on failure, scenarios 19-26).
 *
 * These tests assert actions and outcomes of the orchestrator: the recovery transfer into the
 * draft pending scope (one move, plan state and worktree intent preserved), the Host settlement
 * sequence (failed then cancelled, both with the attempt CAS), the deleteTask tombstone, the
 * pipeline discard, navigation only from the failed session's view, the modal entry, and the
 * fallbacks (no armed continuation, stale attempt, rejected Host cancellation).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import {
  armWorktreeSendContinuation,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";
import {
  registerBaseWorkspaceServices,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useWorktreeFailureReturnStore } from "@/store/worktreeFailureReturnStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  V4_DRAFT_SCOPE_ROOT,
  getV4WorktreeRecoveryScope,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_WORKTREE_RECOVERY_PENDING_SCOPE,
} from "@/v4/composer/composerDraftStore.js";
import { initiateComposerWorktreeFailureReturn } from "@/v4/composer/composerWorktreeFailureReturn.js";

function createMockServices(options?: { cancelRejected?: boolean }) {
  const commands: Array<Record<string, unknown>> = [];
  const deleteTask = vi.fn(async () => undefined);
  const services = {
    zcodeAgentService: {
      helloConversationV4: vi.fn(async () => ({
        kind: "hello",
        protocolVersion: 3,
        connectionId: "test-connection",
        clientMode: "desktop-continuous",
        deliveryProfile: "continuous",
        serverTime: 1,
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none",
        },
        auth: {},
      })),
      initializeConversationV4: vi.fn(async () => undefined),
      sendConversationCommandV4: vi.fn(
        async ({ envelope }: { envelope: Record<string, unknown> }) => {
          commands.push(envelope as Record<string, unknown>);
          const payload = envelope.payload as Record<string, unknown> | undefined;
          if (options?.cancelRejected && payload?.status === "cancelled") {
            return { status: "rejected", reasonCode: "guard.worktreePreparationStale" };
          }
          return { status: "accepted" };
        },
      ),
    },
    zcodeTaskService: { deleteTask },
  };
  return { services: services as unknown as IServiceAccessor, commands, deleteTask };
}

interface SeedOptions {
  workspacePath: string;
  sessionId: string;
  submissionId: string;
  attemptId: string;
  recordText?: string;
  planEnabled?: boolean;
  withContinuation?: boolean;
  mainDraftText?: string;
  activeTaskOnSession?: boolean;
  failure?: { issueCode: string | null; rawDetail: string | null };
}

function seedFailure(options: SeedOptions) {
  const workspaceKey = options.workspacePath;
  const params = {
    submissionId: options.submissionId,
    attemptId: options.attemptId,
    workspacePath: options.workspacePath,
    branchName: "feature-branch",
    targetPath: "/tmp/worktrees/feature-branch",
    baseBranch: "main",
    baseFromHeadDefault: false,
  };
  useComposerWorktreePipelineStore.setState({
    pipelineByWorkspaceKey: {
      [workspaceKey]: {
        activeSessionKey: options.sessionId,
        entriesBySessionKey: {
          [options.sessionId]: {
            status: "failed",
            attemptId: options.attemptId,
            sessionId: options.sessionId,
            params,
            createdAt: Date.now(),
            failureMessage: "Could not create the worktree",
          },
        },
      },
    },
  });
  persistV4ComposerDraft(
    options.workspacePath,
    undefined,
    getV4WorktreeRecoveryScope(options.sessionId, options.submissionId),
    {
      text: options.recordText ?? "frozen submission text",
      ...(options.planEnabled === false ? {} : { mode: "build", planEnabled: true }),
      recoveryAttachments: [
        {
          id: "att-1",
          filename: "paste-1.txt",
          localPath: "/tmp/paste-attachments/paste-1.txt",
          mimeType: "text/plain",
          sizeBytes: 20480,
          sourceKind: "clipboard-text" as const,
        },
      ],
    },
  );
  if (options.mainDraftText !== undefined) {
    persistV4ComposerDraft(options.workspacePath, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: options.mainDraftText,
    });
  }
  if (options.withContinuation !== false) {
    armWorktreeSendContinuation({
      workspaceKey,
      preparedSessionId: options.sessionId,
      attemptId: options.attemptId,
      hasBoundPreparedSession: true,
      dispatch: vi.fn(),
      restore: vi.fn(),
      restoreForRetry: vi.fn(),
    });
  }
  if (options.activeTaskOnSession !== false) {
    useZCodeSessionStore.getState().setActiveTaskId(options.workspacePath, options.sessionId);
  }
  return { params };
}

describe("composerWorktreeFailureReturn", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useComposerWorktreePipelineStore.setState({ pipelineByWorkspaceKey: {} });
    useWorktreeFailureReturnStore.setState({
      modalByWorkspaceKey: {},
      restoreRequestByWorkspaceKey: {},
      submitRequestByWorkspaceKey: {},
      destinationOpenRequestByWorkspaceKey: {},
    });
  });

  afterEach(() => {
    useRemoteWorkspaceSessionStore.setState({ baseServices: null });
  });

  it("returns the frozen submission to the draft pending scope and settles the session (scenario 19)", async () => {
    const { services, commands, deleteTask } = createMockServices();
    registerBaseWorkspaceServices(services);
    const workspacePath = "/proj/return-main";
    const sessionId = "session-return-main";
    const submissionId = "submission-return-main";
    const { params } = seedFailure({
      workspacePath,
      sessionId,
      submissionId,
      attemptId: "attempt-1",
    });

    const tookOver = initiateComposerWorktreeFailureReturn({
      workspaceKey: workspacePath,
      sessionId,
      attemptId: "attempt-1",
      params,
      failureMessage: "Could not create the worktree",
      issueCode: "target-branch-not-found",
      rawDetail: "fatal: invalid base",
    });
    expect(tookOver).toBe(true);

    await vi.waitFor(() =>
      expect(
        useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspacePath]
          ?.entriesBySessionKey[sessionId]?.status,
      ).toBe("discarded"),
    );

    // Transfer: the record lives in the draft pending scope with the worktree intent and the plan
    // state preserved; the session scope is gone.
    const pendingScope = `${V4_WORKTREE_RECOVERY_PENDING_SCOPE}:${submissionId}`;
    const transferred = readV4ComposerDraft(workspacePath, undefined, pendingScope);
    expect(transferred).not.toBeNull();
    expect(transferred?.text).toBe("frozen submission text");
    expect(transferred?.planEnabled).toBe(true);
    expect(transferred?.worktreeIntent).toEqual({
      branchName: "feature-branch",
      baseBranch: "main",
    });
    // Clipboard-text path metadata survives the record round-trip (long-paste rehydration source).
    expect(transferred?.recoveryAttachments).toEqual([
      {
        id: "att-1",
        filename: "paste-1.txt",
        localPath: "/tmp/paste-attachments/paste-1.txt",
        mimeType: "text/plain",
        sizeBytes: 20480,
        sourceKind: "clipboard-text",
      },
    ]);
    expect(
      readV4ComposerDraft(
        workspacePath,
        undefined,
        getV4WorktreeRecoveryScope(sessionId, submissionId),
      ),
    ).toBeNull();
    // The main draft was empty, so it was not overwritten by the transfer itself.
    expect(readV4ComposerDraft(workspacePath, undefined, V4_DRAFT_SCOPE_ROOT)).toBeNull();

    // Host settlement: failed first, then cancelled, both carrying the attempt CAS.
    const statuses = commands.map(
      (envelope) => (envelope.payload as Record<string, unknown>).status,
    );
    expect(statuses).toEqual(["failed", "cancelled"]);
    for (const envelope of commands) {
      expect((envelope.payload as Record<string, unknown>).expectedAttemptId).toBe("attempt-1");
    }

    // Tombstone through the existing Hide path.
    expect(deleteTask).toHaveBeenCalledWith({
      taskId: sessionId,
      workspacePath,
    });

    // Modal entry and auto-restore request; navigation off the failed session's view.
    const modal = useWorktreeFailureReturnStore.getState().modalByWorkspaceKey[workspacePath];
    expect(modal).toMatchObject({
      sessionId,
      issueCode: "target-branch-not-found",
      message: "Could not create the worktree",
      rawDetail: "fatal: invalid base",
      worktreePath: "/tmp/worktrees/feature-branch",
      branchName: "feature-branch",
    });
    expect(modal?.savedNotRestored).toBeUndefined();
    expect(
      useWorktreeFailureReturnStore.getState().restoreRequestByWorkspaceKey[workspacePath],
    ).toBe(1);
    // The request names the exact recovery record, so the composer never restores another one.
    expect(useWorktreeFailureReturnStore.getState().restoreScopeByWorkspaceKey[workspacePath]).toBe(
      pendingScope,
    );
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, undefined).activeTaskId,
    ).toBeNull();
  });

  it("aborts the hand-off before any move or tombstone when the intent write is rejected (Buup)", () => {
    const { services, deleteTask } = createMockServices();
    registerBaseWorkspaceServices(services);
    const workspacePath = "/proj/return-write-rejected";
    const sessionId = "session-return-write-rejected";
    const submissionId = "submission-return-write-rejected";
    const { params } = seedFailure({
      workspacePath,
      sessionId,
      submissionId,
      attemptId: "attempt-1",
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    try {
      expect(
        initiateComposerWorktreeFailureReturn({
          workspaceKey: workspacePath,
          sessionId,
          attemptId: "attempt-1",
          params,
          failureMessage: "Could not create the worktree",
          issueCode: "unknown",
          rawDetail: null,
        }),
      ).toBe(false);
    } finally {
      setItem.mockRestore();
    }
    // The record stays on the session scope (nothing moved, nothing removed) and no tombstone runs.
    expect(
      readV4ComposerDraft(
        workspacePath,
        undefined,
        getV4WorktreeRecoveryScope(sessionId, submissionId),
      ),
    ).not.toBeNull();
    expect(
      readV4ComposerDraft(
        workspacePath,
        undefined,
        `${V4_WORKTREE_RECOVERY_PENDING_SCOPE}:${submissionId}`,
      ),
    ).toBeNull();
    expect(deleteTask).not.toHaveBeenCalled();
    expect(
      useWorktreeFailureReturnStore.getState().modalByWorkspaceKey[workspacePath],
    ).toBeUndefined();
  });

  it("does not hand off a remote workspace whose session is not registered (no local fallback)", () => {
    const { services, commands, deleteTask } = createMockServices();
    registerBaseWorkspaceServices(services);
    const workspacePath = "/proj/return-remote";
    const identity = "remote-identity-return";
    const sessionId = "session-return-remote";
    const submissionId = "submission-return-remote";
    const attemptId = "attempt-1";
    const params = {
      submissionId,
      attemptId,
      workspacePath,
      workspaceIdentity: identity,
      branchName: "feature-branch",
      targetPath: "/tmp/worktrees/feature-branch",
      baseBranch: "main",
      baseFromHeadDefault: false,
    };
    // The same failed submission keyed by the remote identity, with its continuation armed.
    useComposerWorktreePipelineStore.setState({
      pipelineByWorkspaceKey: {
        [identity]: {
          activeSessionKey: sessionId,
          entriesBySessionKey: {
            [sessionId]: {
              status: "failed",
              attemptId,
              sessionId,
              params,
              createdAt: Date.now(),
              failureMessage: "Could not create the worktree",
            },
          },
        },
      },
    });
    armWorktreeSendContinuation({
      workspaceKey: identity,
      preparedSessionId: sessionId,
      attemptId,
      hasBoundPreparedSession: true,
      dispatch: vi.fn(),
      restore: vi.fn(),
      restoreForRetry: vi.fn(),
    });
    persistV4ComposerDraft(
      workspacePath,
      identity,
      getV4WorktreeRecoveryScope(sessionId, submissionId),
      { text: "frozen remote text", mode: "build", planEnabled: true },
    );

    expect(
      initiateComposerWorktreeFailureReturn({
        workspaceKey: identity,
        sessionId,
        attemptId,
        params,
        failureMessage: "Could not create the worktree",
        issueCode: "unknown",
        rawDetail: null,
      }),
    ).toBe(false);
    // Nothing moved, no Host command went through the local base services, no tombstone.
    expect(
      readV4ComposerDraft(
        workspacePath,
        identity,
        getV4WorktreeRecoveryScope(sessionId, submissionId),
      ),
    ).not.toBeNull();
    expect(commands).toHaveLength(0);
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("keeps a non-empty main draft untouched and marks the modal saved-not-restored (scenario 20)", async () => {
    const { services } = createMockServices();
    registerBaseWorkspaceServices(services);
    const workspacePath = "/proj/return-occupied";
    const sessionId = "session-return-occupied";
    const submissionId = "submission-return-occupied";
    const { params } = seedFailure({
      workspacePath,
      sessionId,
      submissionId,
      attemptId: "attempt-1",
      mainDraftText: "newer draft text",
    });

    expect(
      initiateComposerWorktreeFailureReturn({
        workspaceKey: workspacePath,
        sessionId,
        attemptId: "attempt-1",
        params,
        failureMessage: "Could not create the worktree",
        issueCode: "unknown",
        rawDetail: null,
      }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(
        useWorktreeFailureReturnStore.getState().modalByWorkspaceKey[workspacePath]
          ?.savedNotRestored,
      ).toBe(true),
    );
    expect(readV4ComposerDraft(workspacePath, undefined, V4_DRAFT_SCOPE_ROOT)?.text).toBe(
      "newer draft text",
    );
    expect(
      useWorktreeFailureReturnStore.getState().restoreRequestByWorkspaceKey[workspacePath],
    ).toBeUndefined();
  });

  it("does not navigate away when the user is on another session of the workspace", async () => {
    const { services } = createMockServices();
    registerBaseWorkspaceServices(services);
    const workspacePath = "/proj/return-away";
    const sessionId = "session-return-away";
    const otherSessionId = "session-other-view";
    const { params } = seedFailure({
      workspacePath,
      sessionId,
      submissionId: "submission-return-away",
      attemptId: "attempt-1",
      activeTaskOnSession: false,
    });
    useZCodeSessionStore.getState().setActiveTaskId(workspacePath, otherSessionId);

    expect(
      initiateComposerWorktreeFailureReturn({
        workspaceKey: workspacePath,
        sessionId,
        attemptId: "attempt-1",
        params,
        failureMessage: "Could not create the worktree",
        issueCode: "unknown",
        rawDetail: null,
      }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(
        useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspacePath]
          ?.entriesBySessionKey[sessionId]?.status,
      ).toBe("discarded"),
    );
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, undefined).activeTaskId,
    ).toBe(otherSessionId);
  });

  it("keeps the failed-row fallback when no armed submission lives in this renderer (scenario 25)", () => {
    const workspacePath = "/proj/return-reloaded";
    const sessionId = "session-return-reloaded";
    const submissionId = "submission-return-reloaded";
    const { params } = seedFailure({
      workspacePath,
      sessionId,
      submissionId,
      attemptId: "attempt-1",
      withContinuation: false,
    });

    expect(
      initiateComposerWorktreeFailureReturn({
        workspaceKey: workspacePath,
        sessionId,
        attemptId: "attempt-1",
        params,
        failureMessage: "Could not create the worktree",
        issueCode: "unknown",
        rawDetail: null,
      }),
    ).toBe(false);
    const entry =
      useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspacePath]
        ?.entriesBySessionKey[sessionId];
    expect(entry?.status).toBe("failed");
    expect(entry?.returningToDraft).toBeUndefined();
    expect(
      readV4ComposerDraft(
        workspacePath,
        undefined,
        getV4WorktreeRecoveryScope(sessionId, submissionId),
      ),
    ).not.toBeNull();
  });

  it("ignores a stale attempt so it cannot remove a newer session state (scenario 26)", () => {
    const workspacePath = "/proj/return-stale";
    const sessionId = "session-return-stale";
    const { params } = seedFailure({
      workspacePath,
      sessionId,
      submissionId: "submission-return-stale",
      attemptId: "attempt-1",
    });

    expect(
      initiateComposerWorktreeFailureReturn({
        workspaceKey: workspacePath,
        sessionId,
        attemptId: "attempt-old",
        params,
        failureMessage: "Could not create the worktree",
        issueCode: "unknown",
        rawDetail: null,
      }),
    ).toBe(false);
    expect(
      useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspacePath]
        ?.entriesBySessionKey[sessionId]?.status,
    ).toBe("failed");
  });

  it("falls back to the failed row when the Host rejects the cancellation", async () => {
    const { services, deleteTask } = createMockServices({ cancelRejected: true });
    registerBaseWorkspaceServices(services);
    const workspacePath = "/proj/return-rejected";
    const sessionId = "session-return-rejected";
    const submissionId = "submission-return-rejected";
    const { params } = seedFailure({
      workspacePath,
      sessionId,
      submissionId,
      attemptId: "attempt-1",
    });

    expect(
      initiateComposerWorktreeFailureReturn({
        workspaceKey: workspacePath,
        sessionId,
        attemptId: "attempt-1",
        params,
        failureMessage: "Could not create the worktree",
        issueCode: "unknown",
        rawDetail: null,
      }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(
        useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspacePath]
          ?.entriesBySessionKey[sessionId]?.returningToDraft,
      ).toBeUndefined(),
    );
    const entry =
      useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspacePath]
        ?.entriesBySessionKey[sessionId];
    expect(entry?.status).toBe("failed");
    // No tombstone and no modal: the in-session failed row stays the recovery surface.
    expect(deleteTask).not.toHaveBeenCalled();
    expect(
      useWorktreeFailureReturnStore.getState().modalByWorkspaceKey[workspacePath],
    ).toBeUndefined();
  });
});
