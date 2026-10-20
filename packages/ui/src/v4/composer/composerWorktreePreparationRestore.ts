import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";

/**
 * Reconcile the renderer pipeline entry with an authoritative Host preparation update
 * (specs/composer-worktree-setup-steps.md, "Host preparation updates are authoritative even when
 * a renderer pipeline entry already exists"):
 * - Host `cancelled` stops local delivery: the entry is discarded (consumed/discarded stay put)
 *   so the queued send is restored rather than dispatched, unless its live failure hand-off is
 *   still awaiting the Hide tombstone or that tombstone failed.
 * - A newer Host attempt replaces the renderer's stale attempt for this session only, keeping the
 *   queued prompt preview; a late Git result for the replaced attempt cannot restore `ready`
 *   (the runner's attempt drift check drops it).
 * - For the same attempt, a Host terminal `failed` wins over optimistic local state, while a
 *   locally settled `ready` stays visible until the Host reports a terminal state.
 * - A consumed or discarded entry is never resurrected from stale metadata, and a snapshot alone
 *   never starts Git creation.
 */
export function restoreComposerWorktreePipelineFromPreparation({
  workspaceKey,
  workspacePath,
  sessionId,
  preparation,
}: {
  workspaceKey: string;
  workspacePath: string;
  sessionId: string;
  preparation: {
    branchName: string;
    targetPath: string;
    baseBranch?: string;
    attemptId?: string;
    status: "preparing" | "failed" | "cancelled";
    failureMessage?: string;
  };
}): void {
  const store = useComposerWorktreePipelineStore.getState();
  const current = selectComposerWorktreePipeline(store, workspaceKey, sessionId);

  if (preparation.status === "cancelled") {
    if (current?.returningToDraft || current?.tombstoneFailed) return;
    if (current && current.status !== "consumed" && current.status !== "discarded") {
      store.discard(workspaceKey, sessionId);
    }
    return;
  }

  const hostEntry = {
    status: preparation.status === "preparing" ? ("creating" as const) : ("failed" as const),
    sessionId,
    params: {
      workspacePath,
      ...(preparation.attemptId ? { attemptId: preparation.attemptId } : {}),
      branchName: preparation.branchName,
      targetPath: preparation.targetPath,
      ...(preparation.baseBranch ? { baseBranch: preparation.baseBranch } : {}),
      baseFromHeadDefault: !preparation.baseBranch,
    },
    createdAt: Date.now(),
    ...(preparation.status === "failed"
      ? { failureMessage: preparation.failureMessage ?? "Worktree creation failed" }
      : {}),
  };

  if (!current) {
    store.startPipeline(workspaceKey, hostEntry, { activate: false });
    return;
  }
  if (current.status === "consumed" || current.status === "discarded") return;

  const hostAttempt = preparation.attemptId;
  const entryAttempt = current.params?.attemptId ?? current.attemptId;
  // Attempt ids are opaque: a differing Host attempt the entry already replaced is a stale seed,
  // not a newer generation. Rolling back to it detached the armed first submission (BUG-GWT-005).
  if (hostAttempt && current.supersededAttemptIds?.includes(hostAttempt)) return;
  // The marker's attempt id is optional: once this entry replaced an attempt, a seed without one
  // cannot be matched to the live attempt, so it must not fail it either.
  if (!hostAttempt && current.supersededAttemptIds?.length) return;
  if (hostAttempt && hostAttempt !== entryAttempt) {
    // Newer Host generation replaces the renderer's stale attempt for this session only.
    const queuedPromptPreview = current.queuedPromptPreview;
    store.startPipeline(
      workspaceKey,
      {
        ...hostEntry,
        ...(queuedPromptPreview ? { queuedPromptPreview } : {}),
        ...(current.orphaned ? { orphaned: true } : {}),
      },
      { activate: false },
    );
    return;
  }
  if (preparation.status === "failed" && current.status !== "failed") {
    store.markFailed(
      workspaceKey,
      preparation.failureMessage ?? "Worktree creation failed",
      sessionId,
      current.attemptId,
    );
  }
  // Same attempt with the Host still preparing: keep the local state, including a locally
  // settled `ready`, until the Host reports a terminal state for this attempt.
}
