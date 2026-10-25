// @vitest-environment jsdom
/**
 * Failed preparation preserves the submitted session and its recovery record.
 * Spec: specs/first-submission-lifecycle.md, FSL04.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerWorktreePipelineStore } from "@/store/composerWorktreePipelineStore.js";
import {
  registerBaseWorkspaceServices,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useWorktreeFailureReturnStore } from "@/store/worktreeFailureReturnStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  getV4WorktreeRecoveryScope,
  readV4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { startComposerWorktreePipeline } from "@/v4/composer/composerWorktreePipeline.js";
import { createMockServices, seedFailure } from "./composerWorktreeFailureReturnTestUtils.js";

describe("failed preparation preserves its submitted session", () => {
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

  it("keeps the failed session when Git settles the branch elsewhere and marker sync is unavailable", async () => {
    const { services, commands, deleteTask } = createMockServices();
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

    expect(deleteTask).not.toHaveBeenCalled();
    expect(
      commands.map((command) => (command.payload as Record<string, unknown>).status),
    ).not.toContain("cancelled");
    expect(
      useWorktreeFailureReturnStore.getState().modalByWorkspaceKey[workspacePath],
    ).toBeUndefined();
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, undefined).activeTaskId,
    ).toBe(sessionId);
    expect(
      useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspacePath]
        ?.entriesBySessionKey[sessionId],
    ).toMatchObject({
      status: "failed",
      failureMessage: "worktreeSetup.reconcile.markerSyncUnavailable",
      params: { submissionId: params.submissionId },
    });
    expect(
      readV4ComposerDraft(
        workspacePath,
        undefined,
        getV4WorktreeRecoveryScope(sessionId, params.submissionId),
      ),
    ).toMatchObject({
      text: "frozen submission text",
      recoveryAttachments: [expect.objectContaining({ id: "att-1" })],
    });
  });
});
