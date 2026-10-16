/**
 * Pre-session worktree setup rows (specs/composer-worktree-setup-steps.md). Rendered from the
 * pipeline store in the draft empty-state slot while a pipeline exists for the active workspace:
 * creating → ready/existing/failed steps, the queued prompt preview, the orphan note, and
 * Retry/Discard on failure. Rows disappear when the pipeline settles (consumed/discarded) and the
 * regular draft greeting takes the slot back.
 *
 * Reconcile: on mount, a `creating` entry with no live runner in this process (remote reconnect /
 * stale state) is settled via listWorktrees + branch lookup (ready with the found path, else failed).
 */
import { useCallback, useEffect } from "react";
import { Check, GitBranch, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveWorkspaceKey } from "@zcode/shared";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
  type ComposerWorktreePipelineEntry,
} from "@/store/composerWorktreePipelineStore.js";
import {
  isComposerWorktreePipelineInFlight,
  reconcileCreatingComposerWorktreePipeline,
  retryComposerWorktreePipeline,
  restoreComposerWorktreePipelineFromPreparation,
} from "@/v4/composer/composerWorktreePipeline.js";

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

export function ConversationWorktreeSetupSteps({
  workspacePath,
  workspaceIdentity,
  sessionId,
  preparation,
  onRetryPreparation,
  onPreparationFailed,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  preparation: {
    branchName: string;
    targetPath: string;
    status: "preparing" | "failed" | "cancelled";
    failureMessage?: string;
  };
  onRetryPreparation: () => Promise<void>;
  onPreparationFailed: (sessionId: string, failureMessage: string) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const baseServices = useBaseWorkspaceServices();
  const workspaceKey = resolveWorkspaceKey({
    workspacePath,
    workspaceIdentity,
  });
  const pipelineEntry = useComposerWorktreePipelineStore((state) =>
    selectComposerWorktreePipeline(state, workspaceKey, sessionId),
  );
  const entry = pipelineEntry?.sessionId === sessionId ? pipelineEntry : null;

  const settleStaleCreating = useCallback(() => {
    if (!entry || entry.status !== "creating" || !entry.params) return;
    if (isComposerWorktreePipelineInFlight(workspaceKey, sessionId)) return;
    void reconcileCreatingComposerWorktreePipeline({
      gitService: baseServices.gitService,
      workspaceKey,
      sessionId,
      branchName: entry.params.branchName,
      formatMessage: (id, values) => intl.formatMessage({ id }, values),
    }).then(async () => {
      const settled = selectComposerWorktreePipeline(
        useComposerWorktreePipelineStore.getState(),
        workspaceKey,
        sessionId,
      );
      if (settled?.sessionId === sessionId && settled.status === "failed") {
        await onPreparationFailed(sessionId, settled.failureMessage ?? "Worktree creation failed");
      }
    });
  }, [baseServices.gitService, entry, intl, onPreparationFailed, sessionId, workspaceKey]);

  useEffect(() => {
    if (!entry && preparation.status !== "cancelled") {
      restoreComposerWorktreePipelineFromPreparation({
        workspaceKey,
        workspacePath,
        sessionId,
        preparation,
      });
      return;
    }
    settleStaleCreating();
  }, [
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
        className="flex w-full max-w-2xl items-center gap-2 px-4 text-ui-sm text-foreground"
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
        className="w-full max-w-2xl px-4 text-ui-sm text-destructive"
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

  return (
    <div
      data-worktree-setup-steps="true"
      className="flex w-full max-w-2xl flex-col items-start gap-2 px-4 text-ui-sm text-foreground"
    >
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
                  onClick={() => {
                    void (async () => {
                      try {
                        await onRetryPreparation();
                        const outcome = await retryComposerWorktreePipeline({
                          gitService: baseServices.gitService,
                          workspaceKey,
                          sessionId,
                          formatMessage: (id, values) => intl.formatMessage({ id }, values),
                        });
                        if (outcome === "failed") {
                          const failureMessage =
                            selectComposerWorktreePipeline(
                              useComposerWorktreePipelineStore.getState(),
                              workspaceKey,
                              sessionId,
                            )?.failureMessage ?? "Worktree creation failed";
                          await onPreparationFailed(sessionId, failureMessage);
                        }
                      } catch (error) {
                        useComposerWorktreePipelineStore
                          .getState()
                          .markFailed(workspaceKey, getErrorMessage(error), sessionId);
                      }
                    })();
                  }}
                >
                  {intl.formatMessage({ id: "worktreeSetup.retry" })}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    useComposerWorktreePipelineStore.getState().discard(workspaceKey, sessionId);
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
