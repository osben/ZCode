/**
 * Pre-session worktree setup rows (specs/composer-worktree-setup-steps.md). Rendered from the
 * Host preparation state in the timeline header while the session is preparing, plus pipeline
 * details for creating → ready/existing/failed steps. After activation, the session-index
 * worktree fact keeps a compact created-worktree notice in the same first-in-history position.
 *
 * Reconcile: on mount, a `creating` entry with no live runner in this process (remote reconnect /
 * stale state) is settled via listWorktrees + branch lookup (ready with the found path, else failed).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, GitBranch, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { resolveWorkspaceKey } from "@zcode/shared";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
  type ComposerWorktreePipelineEntry,
} from "@/store/composerWorktreePipelineStore.js";
import {
  isComposerWorktreePipelineInFlight,
  isComposerWorktreeRetryPending,
  markComposerWorktreeRetryPending,
  reconcileCreatingComposerWorktreePipeline,
  retryComposerWorktreePipeline,
  restoreComposerWorktreePipelineFromPreparation,
} from "@/v4/composer/composerWorktreePipeline.js";
import type { ComposerWorktreePreparationSync } from "@/v4/composer/composerDraftWorktreeIntent.js";

/** Whether the workspace has a pipeline whose rows should replace the draft greeting. */
export function useHasActiveWorktreeSetupPipeline(workspaceKey: string): boolean {
  return useComposerWorktreePipelineStore((state) => {
    const entry = selectComposerWorktreePipeline(state, workspaceKey);
    return (
      entry !== null &&
      (entry.status === "creating" || entry.status === "ready" || entry.status === "failed")
    );
  });
}

function stepGlyphClassName(entry: ComposerWorktreePipelineEntry): string {
  if (entry.status === "failed") return "text-destructive";
  if (entry.status === "ready") return "text-success";
  return "text-foreground-subtle";
}

const setupCardClassName =
  "mx-4 my-3 flex w-auto max-w-2xl flex-col items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-ui-sm text-foreground";

/** Persistent first-in-history summary after Host activation clears the preparation marker. */
export function ConversationWorktreeCreatedNotice({
  branchName,
  currentBranchName,
  path,
}: {
  branchName?: string;
  /** Undefined until Git status loads; null when the current worktree has no branch. */
  currentBranchName?: string | null;
  path: string;
}) {
  const { intl } = useZCodeIntl();
  const displayBranchName = currentBranchName === undefined ? branchName : currentBranchName;

  return (
    <div
      data-worktree-created="true"
      className="mx-4 my-3 flex w-auto max-w-2xl items-start gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-ui-sm text-foreground"
      role="status"
    >
      <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{intl.formatMessage({ id: "worktreeSetup.created" })}</span>
        {displayBranchName ? (
          <span className="text-ui-caption text-foreground-subtle">{displayBranchName}</span>
        ) : null}
        <span className="break-all text-ui-caption text-foreground-subtle">{path}</span>
      </div>
    </div>
  );
}

export function ConversationWorktreeSetupSteps({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  sessionId,
  preparation,
  onRetryPreparation,
  onCancelPreparation,
  onPreparationFailed,
  onSyncPreparation,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  preparation: {
    branchName: string;
    targetPath: string;
    baseBranch?: string;
    status: "preparing" | "failed" | "cancelled";
    failureMessage?: string;
    attemptId?: string;
  };
  onRetryPreparation: (expectedAttemptId?: string) => Promise<string | void>;
  onCancelPreparation?: (expectedAttemptId?: string) => Promise<void>;
  onPreparationFailed: (
    sessionId: string,
    failureMessage: string,
    attemptId?: string,
  ) => Promise<void>;
  /** Realign the Host preparation marker when reconciliation finds the worktree at another path. */
  onSyncPreparation?: ComposerWorktreePreparationSync;
}) {
  const { intl } = useZCodeIntl();
  const actionInFlight = useRef(false);
  const [actionPending, setActionPending] = useState(false);
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const baseServices = resolution.services;
  const workspaceKey = resolveWorkspaceKey({
    workspacePath,
    workspaceIdentity,
  });
  const pipelineEntry = useComposerWorktreePipelineStore((state) =>
    selectComposerWorktreePipeline(state, workspaceKey, sessionId),
  );
  const entry = pipelineEntry?.sessionId === sessionId ? pipelineEntry : null;

  const settleStaleCreating = useCallback(() => {
    if (!resolution.rpcReady || !entry || entry.status !== "creating" || !entry.params) return;
    if (isComposerWorktreePipelineInFlight(workspaceKey, sessionId)) return;
    if (isComposerWorktreeRetryPending(workspaceKey, sessionId)) return;
    void reconcileCreatingComposerWorktreePipeline({
      gitService: baseServices.gitService,
      workspaceKey,
      sessionId,
      branchName: entry.params.branchName,
      formatMessage: (id, values) => intl.formatMessage({ id }, values),
      ...(onSyncPreparation ? { syncPreparedWorktree: onSyncPreparation } : {}),
    })
      .then(async () => {
        const settled = selectComposerWorktreePipeline(
          useComposerWorktreePipelineStore.getState(),
          workspaceKey,
          sessionId,
        );
        if (
          settled?.sessionId === sessionId &&
          settled.attemptId === entry.attemptId &&
          settled.status === "failed"
        ) {
          await onPreparationFailed(
            sessionId,
            settled.failureMessage ?? "Worktree creation failed",
            settled.params?.attemptId,
          );
        }
      })
      .catch((error: unknown) => {
        logger.warn("[WorktreePipeline] Could not persist reconciliation failure", error);
        toast(getErrorMessage(error));
      });
  }, [
    resolution.rpcReady,
    baseServices.gitService,
    entry,
    intl,
    onPreparationFailed,
    onSyncPreparation,
    sessionId,
    workspaceKey,
  ]);

  useEffect(() => {
    // Authoritative Host preparation reconciliation: creates the missing renderer entry and also
    // replaces a stale local attempt, fails it for the same attempt, or discards it on Host
    // cancellation. Never resurrects consumed/discarded entries and never starts Git itself.
    restoreComposerWorktreePipelineFromPreparation({
      workspaceKey,
      workspacePath,
      sessionId,
      preparation,
    });
    settleStaleCreating();
    // actionPending: a Retry that ends without starting a runner hands an adopted `creating` entry
    // back to this reconcile, which it skipped while the Host acknowledgement was pending.
  }, [
    actionPending,
    baseServices.gitService,
    entry,
    intl,
    preparation,
    sessionId,
    settleStaleCreating,
    workspaceKey,
    workspacePath,
  ]);

  if (!entry) {
    // First paint during reload; the effect below restores renderer state from the Host seed.
    return preparation.status === "preparing" ? (
      <div
        data-worktree-setup-steps="true"
        data-worktree-session-id={sessionId}
        className={cn(setupCardClassName, "flex-row")}
        role="status"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
        <span data-worktree-setup-step="creating">
          {intl.formatMessage(
            { id: "worktreeSetup.stepCreating" },
            { branch: preparation.branchName },
          )}
        </span>
      </div>
    ) : preparation.status === "failed" ? (
      <div
        data-worktree-setup-steps="true"
        data-worktree-session-id={sessionId}
        className={cn(setupCardClassName, "text-destructive")}
        role="alert"
      >
        {intl.formatMessage(
          { id: "worktreeSetup.stepFailed" },
          { reason: preparation.failureMessage ?? "Worktree creation failed" },
        )}
      </div>
    ) : null;
  }
  if (entry.status === "consumed" || entry.status === "discarded") {
    // Rows disappear when the pipeline settles. The Host seed cannot reach live subscribers
    // (preparation metadata produces no delta), so its stale "preparing" value must never
    // resurrect the spinner after the local lifecycle already finished.
    return null;
  }
  if (entry.status === "failed" && entry.returningToDraft) {
    // The return-to-draft hand-off owns this failure and is about to settle the session and
    // navigate back to the restored draft (spec §Return to draft on failure); the transient row
    // must not offer Retry/Discard actions that would race the hand-off.
    return null;
  }

  return (
    <div data-worktree-setup-steps="true" className={setupCardClassName}>
      {!resolution.rpcReady ? (
        <p role="status">{intl.formatMessage({ id: "worktreeSetup.connectionUnavailable" })}</p>
      ) : null}
      {entry.status === "creating" ? (
        <div className="flex items-center gap-2" role="status">
          <Loader2 className={cn("size-3.5 shrink-0 animate-spin", stepGlyphClassName(entry))} />
          <span data-worktree-setup-step="creating">
            {intl.formatMessage(
              { id: "worktreeSetup.stepCreating" },
              { branch: entry.params?.branchName ?? "" },
            )}
          </span>
        </div>
      ) : null}
      {entry.status === "ready" && entry.worktreePath ? (
        <div className="flex items-center gap-2">
          <Check className={cn("size-3.5 shrink-0", stepGlyphClassName(entry))} />
          <span data-worktree-setup-step="ready" className="break-all">
            {entry.existing
              ? intl.formatMessage(
                  { id: "worktreeSetup.stepExisting" },
                  { path: entry.worktreePath },
                )
              : intl.formatMessage({ id: "worktreeSetup.stepReady" }, { path: entry.worktreePath })}
          </span>
        </div>
      ) : null}
      {entry.status === "failed" ? (
        <div className="flex items-start gap-2" role="alert">
          <X className={cn("mt-0.5 size-3.5 shrink-0", stepGlyphClassName(entry))} />
          <div className="flex min-w-0 flex-col items-start gap-2">
            <span data-worktree-setup-step="failed" className="break-all text-destructive">
              {intl.formatMessage(
                { id: "worktreeSetup.stepFailed" },
                { reason: entry.failureMessage ?? "" },
              )}
            </span>
            {entry.params ? (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!resolution.rpcReady || actionPending}
                  onClick={() => {
                    if (actionInFlight.current) return;
                    actionInFlight.current = true;
                    setActionPending(true);
                    void (async () => {
                      let ownerAttemptId = entry.attemptId;
                      // The Host snapshot for the retried attempt may be restored as `creating`
                      // before the acknowledgement resolves; this handler still owns starting Git
                      // for it, so the stale-creating reconcile must not settle it meanwhile.
                      const releaseRetryPending = markComposerWorktreeRetryPending(
                        workspaceKey,
                        sessionId,
                      );
                      try {
                        const attemptId = await onRetryPreparation(entry.params?.attemptId);
                        const outcome = await retryComposerWorktreePipeline({
                          ...(attemptId ? { attemptId } : {}),
                          retriedAttemptId: ownerAttemptId,
                          gitService: baseServices.gitService,
                          workspaceKey,
                          sessionId,
                          formatMessage: (id, values) => intl.formatMessage({ id }, values),
                          ...(onSyncPreparation ? { syncPreparedWorktree: onSyncPreparation } : {}),
                        });
                        if (outcome === "skipped") return;
                        ownerAttemptId = attemptId || ownerAttemptId;
                        if (outcome === "failed") {
                          const failed = selectComposerWorktreePipeline(
                            useComposerWorktreePipelineStore.getState(),
                            workspaceKey,
                            sessionId,
                          );
                          if (failed?.attemptId !== ownerAttemptId || failed.status !== "failed")
                            return;
                          await onPreparationFailed(
                            sessionId,
                            failed.failureMessage ?? "Worktree creation failed",
                            failed.params?.attemptId,
                          );
                        }
                      } catch (error) {
                        useComposerWorktreePipelineStore
                          .getState()
                          .markFailed(
                            workspaceKey,
                            getErrorMessage(error),
                            sessionId,
                            ownerAttemptId,
                          );
                        toast(getErrorMessage(error));
                      } finally {
                        releaseRetryPending();
                        actionInFlight.current = false;
                        setActionPending(false);
                      }
                    })();
                  }}
                >
                  {intl.formatMessage({ id: "worktreeSetup.retry" })}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!resolution.rpcReady || actionPending}
                  onClick={() => {
                    if (actionInFlight.current) return;
                    actionInFlight.current = true;
                    setActionPending(true);
                    void (async () => {
                      try {
                        if (!onCancelPreparation)
                          throw new Error("Preparation cancellation is unavailable");
                        await onCancelPreparation(entry.params?.attemptId);
                        useComposerWorktreePipelineStore
                          .getState()
                          .discard(workspaceKey, sessionId, entry.attemptId);
                      } catch (error) {
                        useComposerWorktreePipelineStore
                          .getState()
                          .markFailed(
                            workspaceKey,
                            getErrorMessage(error),
                            sessionId,
                            entry.attemptId,
                          );
                        toast(getErrorMessage(error));
                      } finally {
                        actionInFlight.current = false;
                        setActionPending(false);
                      }
                    })();
                  }}
                >
                  {intl.formatMessage({ id: "worktreeSetup.discard" })}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {entry.params?.baseFromHeadDefault && entry.status === "creating" ? (
        <span className="pl-5 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "worktreeSetup.stepCreating.baseHead" })}
        </span>
      ) : null}
      {entry.queuedPromptPreview ? (
        <div
          data-worktree-setup-queued-message="true"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2"
        >
          <div className="flex items-center gap-1.5 pb-1 text-ui-xs text-foreground-subtle">
            <GitBranch className="size-3 shrink-0" aria-hidden="true" />
            {intl.formatMessage({ id: "worktreeSetup.queuedMessageLabel" })}
          </div>
          <p className="line-clamp-4 whitespace-pre-wrap break-words text-foreground">
            {entry.queuedPromptPreview}
          </p>
        </div>
      ) : null}
      {entry.orphaned ? (
        <span className="pl-5 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "worktreeSetup.orphanedNote" })}
        </span>
      ) : null}
    </div>
  );
}
