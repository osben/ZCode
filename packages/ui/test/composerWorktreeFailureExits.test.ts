// @vitest-environment jsdom
/**
 * Regression coverage for the failed preparation exits that run the return-to-draft hand-off
 * (spec: specs/composer-worktree-setup-steps.md §Return to draft on failure). The marker-sync
 * failure must hand off like the final rejection branch, not strand the user on the failed row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerWorktreePipelineStore } from "@/store/composerWorktreePipelineStore.js";
import {
  registerBaseWorkspaceServices,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useWorktreeFailureReturnStore } from "@/store/worktreeFailureReturnStore.js";
import { startComposerWorktreePipeline } from "@/v4/composer/composerWorktreePipeline.js";
import { createMockServices, seedFailure } from "./composerWorktreeFailureReturnTestUtils.js";

describe("failed preparation exits share the return-to-draft hand-off", () => {
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

  it("hands off when Git settles the branch at another path and no marker sync is available", async () => {
    const { services, deleteTask } = createMockServices();
    registerBaseWorkspaceServices(services);
    const workspacePath = "/proj/return-marker-sync";
    const sessionId = "session-return-marker-sync";
    const { params } = seedFailure({
      workspacePath,
      sessionId,
      submissionId: "submission-return-marker-sync",
      attemptId: "attempt-marker-sync",
    });
    // Reopen the same attempt as an in-flight creation so the runner's own failure exit runs.
    const pipeline =
      useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspacePath];
    const entry = pipeline?.entriesBySessionKey[sessionId];
    useComposerWorktreePipelineStore.setState({
      pipelineByWorkspaceKey: {
        [workspacePath]: {
          ...pipeline,
          entriesBySessionKey: {
            ...pipeline?.entriesBySessionKey,
            [sessionId]: { ...entry, status: "creating" },
          },
        },
      },
    } as never);

    const gitService = {
      createWorktree: vi.fn(async () => ({
        ok: false,
        worktreePath: null,
        branchName: null,
        issues: [{ code: "target-path-exists", message: "target exists" }],
      })),
      listWorktrees: vi.fn(async () => ({
        isGitAvailable: true,
        isRepository: true,
        worktrees: [
          {
            path: "/tmp/worktrees/elsewhere",
            headCommitHash: "c",
            branchName: params.branchName,
            isMain: false,
            isBare: false,
            isDetached: false,
            isCurrent: false,
          },
        ],
      })),
      verifyWorktreeUsable: vi.fn(async () => ({ ok: true })),
      ensureWorktreeExclusion: vi.fn(async () => ({ ok: true })),
    };

    const outcome = await startComposerWorktreePipeline({
      gitService: gitService as never,
      workspaceKey: workspacePath,
      sessionId,
      params,
      formatMessage: (id: string) => id,
    });
    expect(outcome).toBe("failed");

    await vi.waitFor(() =>
      expect(deleteTask).toHaveBeenCalledWith({ taskId: sessionId, workspacePath }),
    );
    expect(
      useWorktreeFailureReturnStore.getState().modalByWorkspaceKey[workspacePath],
    ).toMatchObject({
      sessionId,
      message: "worktreeSetup.reconcile.markerSyncUnavailable",
    });
  });
});
