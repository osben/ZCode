import { nanoid } from "nanoid";
import type { WorktreePreparationState } from "@zcode/shared/zcode-protocol-v4";
import type { WorktreeCreationGitService } from "@/command-center/worktreeCreation.js";
import { useComposerWorktreePipelineStore } from "@/store/composerWorktreePipelineStore.js";
import { startComposerWorktreePipeline } from "./composerWorktreePipeline.js";
import type {
  ComposerWorktreePreparationParams,
  ComposerWorktreePreparationSync,
  ComposerWorktreeBeginResult,
} from "./composerDraftWorktreeIntent.js";

/** Reopening a prepared chat does not depend on the empty-state intent control staying mounted. */
export async function restartPreparedWorktreeCreation(input: {
  workspaceKey: string;
  workspacePath: string;
  sessionId: string;
  preparation: WorktreePreparationState;
  gitService: WorktreeCreationGitService;
  prepareSession: (params: ComposerWorktreePreparationParams) => Promise<string>;
  syncPreparedWorktree?: ComposerWorktreePreparationSync;
  formatMessage: (id: string, values?: Record<string, string>) => string;
}): Promise<ComposerWorktreeBeginResult> {
  const attemptId = nanoid();
  const { branchName, targetPath, baseBranch } = input.preparation;
  const reserved = await input.prepareSession({
    workspaceKey: input.workspaceKey,
    branchName,
    targetPath,
    baseBranch,
    attemptId,
  });
  if (reserved !== input.sessionId)
    throw new Error("Retry must retain the prepared session identity");
  const params = {
    workspacePath: input.workspacePath,
    branchName,
    targetPath,
    baseBranch,
    attemptId,
    baseFromHeadDefault: !baseBranch,
  };
  useComposerWorktreePipelineStore
    .getState()
    .startPipeline(
      input.workspaceKey,
      { status: "creating", sessionId: reserved, params, createdAt: Date.now() },
      { activate: false },
    );
  void startComposerWorktreePipeline({ ...input, params });
  return { ok: true, sessionId: reserved };
}
