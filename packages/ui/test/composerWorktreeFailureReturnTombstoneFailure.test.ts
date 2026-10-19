// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  peekWorktreeSendContinuation,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";
import {
  registerBaseWorkspaceServices,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useWorktreeFailureReturnStore } from "@/store/worktreeFailureReturnStore.js";
import {
  getV4WorktreeRecoveryScope,
  readV4ComposerDraft,
  V4_WORKTREE_RECOVERY_PENDING_SCOPE,
} from "@/v4/composer/composerDraftStore.js";
import { initiateComposerWorktreeFailureReturn } from "@/v4/composer/composerWorktreeFailureReturn.js";
import { restoreComposerWorktreePipelineFromPreparation } from "@/v4/composer/composerWorktreePipeline.js";
import { createMockServices, seedFailure } from "./composerWorktreeFailureReturnTestUtils.js";

describe("composerWorktreeFailureReturn tombstone failure", () => {
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

  it("keeps the failed-row fallback when the preparing-session tombstone fails", async () => {
    const { services, deleteTask } = createMockServices({ deleteRejected: true });
    registerBaseWorkspaceServices(services);
    const workspacePath = "/proj/return-delete-rejected";
    const sessionId = "session-return-delete-rejected";
    const submissionId = "submission-return-delete-rejected";
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

    restoreComposerWorktreePipelineFromPreparation({
      workspaceKey: workspacePath,
      workspacePath,
      sessionId,
      preparation: {
        status: "cancelled",
        branchName: params.branchName,
        targetPath: params.targetPath,
        attemptId: "attempt-1",
      },
    });
    expect(
      useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspacePath]
        ?.entriesBySessionKey[sessionId]?.status,
    ).toBe("failed");

    await vi.waitFor(() => expect(deleteTask).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspacePath]
          ?.entriesBySessionKey[sessionId]?.tombstoneFailed,
      ).toBe(true),
    );
    const entry =
      useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspacePath]
        ?.entriesBySessionKey[sessionId];
    expect(entry).toMatchObject({ status: "failed", tombstoneFailed: true });
    expect(entry?.returningToDraft).toBeUndefined();
    expect(peekWorktreeSendContinuation(workspacePath, sessionId)).not.toBeNull();
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
    expect(
      useWorktreeFailureReturnStore.getState().modalByWorkspaceKey[workspacePath],
    ).toBeUndefined();

    restoreComposerWorktreePipelineFromPreparation({
      workspaceKey: workspacePath,
      workspacePath,
      sessionId,
      preparation: {
        status: "cancelled",
        branchName: params.branchName,
        targetPath: params.targetPath,
        attemptId: "attempt-1",
      },
    });
    expect(
      useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspacePath]
        ?.entriesBySessionKey[sessionId]?.status,
    ).toBe("failed");
  });
});
