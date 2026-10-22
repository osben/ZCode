// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useWorktreeFailureReturnStore } from "@/store/worktreeFailureReturnStore.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import {
  applyPersistedWorktreeIntent,
  selectPersistableWorktreeIntent,
  useDraftBranchIntentStore,
} from "@/v4/composer/draftBranchIntent.js";

const workspacePath = "/proj/return-ownership";
const sessionId = "session-return-ownership";

describe("composer worktree follow-ups", () => {
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
