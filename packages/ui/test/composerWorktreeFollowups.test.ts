// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  peekWorktreeSendContinuation,
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";
import {
  registerBaseWorkspaceServices,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useWorktreeFailureReturnStore } from "@/store/worktreeFailureReturnStore.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  V4_WORKTREE_RECOVERY_PENDING_SCOPE,
} from "@/v4/composer/composerDraftStore.js";
import {
  applyPersistedWorktreeIntent,
  selectPersistableWorktreeIntent,
  useDraftBranchIntentStore,
} from "@/v4/composer/draftBranchIntent.js";
import { initiateComposerWorktreeFailureReturn } from "@/v4/composer/composerWorktreeFailureReturn.js";
import { restoreComposerWorktreePipelineFromPreparation } from "@/v4/composer/composerWorktreePipeline.js";
import { createMockServices, seedFailure } from "./composerWorktreeFailureReturnTestUtils.js";

const workspacePath = "/proj/return-ownership";
const sessionId = "session-return-ownership";
const submissionId = "submission-return-ownership";
const otherWorkspacePath = "/proj/return-ownership-2";
const otherSessionId = "session-return-ownership-2";
const otherSubmissionId = "submission-return-ownership-2";

function pipelineEntry() {
  return useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspacePath]
    ?.entriesBySessionKey[sessionId];
}

/** A newer Host attempt on the same prepared session (cancelled -> preparing with a new attempt id). */
function reportNewerPreparingAttempt(
  params: { branchName: string; targetPath: string },
  target: { workspacePath: string; sessionId: string } = { workspacePath, sessionId },
) {
  restoreComposerWorktreePipelineFromPreparation({
    workspaceKey: target.workspacePath,
    workspacePath: target.workspacePath,
    sessionId: target.sessionId,
    preparation: {
      status: "preparing",
      branchName: params.branchName,
      targetPath: params.targetPath,
      attemptId: "attempt-2",
    },
  });
}

describe("composerWorktreeFailureReturn ownership fences", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useComposerWorktreePipelineStore.setState({ pipelineByWorkspaceKey: {} });
    useWorktreeFailureReturnStore.setState({
      modalByWorkspaceKey: {},
      restoreRequestByWorkspaceKey: {},
      restoreScopeByWorkspaceKey: {},
      submitRequestByWorkspaceKey: {},
      destinationOpenRequestByWorkspaceKey: {},
    });
  });

  afterEach(() => {
    useRemoteWorkspaceSessionStore.setState({ baseServices: null });
  });

  it("does not tombstone the session when a newer attempt takes it over after the cancellation", async () => {
    let params: ReturnType<typeof seedFailure>["params"] | undefined;
    const { services, deleteTask } = createMockServices({
      onCancelAccepted: () => {
        if (params) reportNewerPreparingAttempt(params);
      },
    });
    registerBaseWorkspaceServices(services);
    ({ params } = seedFailure({
      workspacePath,
      sessionId,
      submissionId,
      attemptId: "attempt-1",
    }));

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

    await vi.waitFor(() => expect(pipelineEntry()?.attemptId).toBe("attempt-2"));
    // Let the hand-off reach its fence after the cancellation ack.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deleteTask).not.toHaveBeenCalled();
    expect(pipelineEntry()).toMatchObject({ attemptId: "attempt-2", status: "creating" });
    expect(peekWorktreeSendContinuation(workspacePath, sessionId)).not.toBeNull();
    expect(
      readV4ComposerDraft(
        workspacePath,
        undefined,
        `${V4_WORKTREE_RECOVERY_PENDING_SCOPE}:${submissionId}`,
      ),
    ).not.toBeNull();
    expect(
      useWorktreeFailureReturnStore.getState().modalByWorkspaceKey[workspacePath],
    ).toBeUndefined();
  });

  it("skips local cleanup when a newer attempt lands while the tombstone is in flight", async () => {
    let params: ReturnType<typeof seedFailure>["params"] | undefined;
    const { services, deleteTask } = createMockServices({
      onDeleteTaskStarted: () => {
        if (params) {
          reportNewerPreparingAttempt(params, {
            workspacePath: otherWorkspacePath,
            sessionId: otherSessionId,
          });
        }
      },
    });
    registerBaseWorkspaceServices(services);
    ({ params } = seedFailure({
      workspacePath: otherWorkspacePath,
      sessionId: otherSessionId,
      submissionId: otherSubmissionId,
      attemptId: "attempt-1",
    }));

    initiateComposerWorktreeFailureReturn({
      workspaceKey: otherWorkspacePath,
      sessionId: otherSessionId,
      attemptId: "attempt-1",
      params,
      failureMessage: "Could not create the worktree",
      issueCode: "unknown",
      rawDetail: null,
    });

    await vi.waitFor(() => expect(deleteTask).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      selectComposerWorktreePipeline(
        useComposerWorktreePipelineStore.getState(),
        otherWorkspacePath,
        otherSessionId,
      ),
    ).toMatchObject({ attemptId: "attempt-2", status: "creating" });
    expect(peekWorktreeSendContinuation(otherWorkspacePath, otherSessionId)).not.toBeNull();
    expect(
      useWorktreeFailureReturnStore.getState().modalByWorkspaceKey[otherWorkspacePath],
    ).toBeUndefined();
  });

  it("keeps the failure visible when a validation failure lands while another session is active", () => {
    useComposerWorktreePipelineStore.setState({
      pipelineByWorkspaceKey: {
        [workspacePath]: {
          activeSessionKey: sessionId,
          entriesBySessionKey: {
            [sessionId]: {
              status: "creating",
              attemptId: "attempt-other",
              sessionId,
              createdAt: Date.now(),
            },
          },
        },
      },
    });

    useComposerWorktreePipelineStore
      .getState()
      .markValidationFailed(workspacePath, "Base branch not found");

    expect(
      selectComposerWorktreePipeline(useComposerWorktreePipelineStore.getState(), workspacePath),
    ).toMatchObject({ status: "failed", failureMessage: "Base branch not found" });
  });

  it("hydrates the frozen destination, base, and HEAD-default flag from the persisted root draft", () => {
    const draftStore = useDraftBranchIntentStore.getState();
    draftStore.setWorktreeIntentActive(workspacePath, false);
    applyPersistedWorktreeIntent(workspacePath, {
      branchName: "feature-restored",
      customLocationPath: "/tmp/custom-worktrees",
      baseFromHeadDefault: true,
    });
    const persisted = selectPersistableWorktreeIntent(
      useDraftBranchIntentStore.getState(),
      workspacePath,
    );
    expect(persisted).toEqual({
      branchName: "feature-restored",
      customLocationPath: "/tmp/custom-worktrees",
      baseFromHeadDefault: true,
    });
    persistV4ComposerDraft(workspacePath, undefined, V4_DRAFT_SCOPE_ROOT, {
      text: "restored message",
      ...(persisted ? { worktreeIntent: persisted } : {}),
    });

    // Reload: the in-memory store is empty, only the persisted draft remains.
    useDraftBranchIntentStore.setState({
      intentByWorkspaceKey: {},
      worktreeIntentActiveByWorkspaceKey: {},
      frozenWorktreeIntentByWorkspaceKey: {},
    });
    const reloaded = readV4ComposerDraft(workspacePath, undefined, V4_DRAFT_SCOPE_ROOT);
    expect(reloaded?.worktreeIntent).toBeDefined();
    applyPersistedWorktreeIntent(workspacePath, reloaded!.worktreeIntent!);

    const after = useDraftBranchIntentStore.getState();
    expect(after.worktreeIntentActiveByWorkspaceKey[workspacePath]).toBe(true);
    expect(after.frozenWorktreeIntentByWorkspaceKey[workspacePath]).toEqual({
      branchName: "feature-restored",
      customLocationPath: "/tmp/custom-worktrees",
      baseFromHeadDefault: true,
    });
  });
});
