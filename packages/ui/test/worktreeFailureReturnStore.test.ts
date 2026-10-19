import { afterEach, describe, expect, it } from "vitest";
import { useWorktreeFailureReturnStore } from "@/store/worktreeFailureReturnStore.js";

describe("markFailureSavedNotRestored", () => {
  const workspaceKey = "/workspace/saved-late";

  afterEach(() => {
    useWorktreeFailureReturnStore.getState().dropWorkspace(workspaceKey);
  });

  it("marks an open modal as saved-not-restored and preserves its other fields", () => {
    const store = useWorktreeFailureReturnStore.getState();
    store.openFailureModal(workspaceKey, {
      workspacePath: workspaceKey,
      sessionId: "session-late",
      issueCode: null,
      message: "failed",
      rawDetail: null,
      savedAt: 1,
    });

    store.markFailureSavedNotRestored(workspaceKey);
    const modal = useWorktreeFailureReturnStore.getState().modalByWorkspaceKey[workspaceKey];
    expect(modal?.savedNotRestored).toBe(true);
    expect(modal?.sessionId).toBe("session-late");

    const modalByWorkspaceKey = useWorktreeFailureReturnStore.getState().modalByWorkspaceKey;
    useWorktreeFailureReturnStore.getState().markFailureSavedNotRestored(workspaceKey);
    expect(useWorktreeFailureReturnStore.getState().modalByWorkspaceKey).toBe(modalByWorkspaceKey);
  });

  it("does nothing when no modal is open", () => {
    useWorktreeFailureReturnStore.getState().markFailureSavedNotRestored(workspaceKey);
    expect(
      useWorktreeFailureReturnStore.getState().modalByWorkspaceKey[workspaceKey],
    ).toBeUndefined();
  });
});
