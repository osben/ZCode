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
import { Check, ChevronRight, GitBranch, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
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
import { formatWorktreeAddCommand } from "@/v4/worktreeCommandText.js";
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

const setupCardClassName = "flex w-full flex-col items-start gap-2 text-ui-sm text-foreground";

const setupDetailsClassName =
  "min-w-0 space-y-2 pt-3 ml-2 border-border border-l pl-3.5 text-ui-sm text-foreground-subtlest";

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

  // Reasoning-style collapsible (specs/composer-worktree-setup-steps.md): open while creating,
  // auto-open on failure and auto-collapse when the worktree turns ready; a manual toggle wins.
  const [setupOpen, setSetupOpen] = useState(() => entry?.status !== "ready");
  const setupUserToggledRef = useRef(false);
  const setupStatusRef = useRef(entry?.status);
  useEffect(() => {
    const previous = setupStatusRef.current;
    setupStatusRef.current = entry?.status;
    if (previous === entry?.status || setupUserToggledRef.current) return;
    if (entry?.status === "ready") setSetupOpen(false);
    if (entry?.status === "failed") setSetupOpen(true);
  }, [entry?.status]);

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

  const stepBranch = entry?.params?.branchName ?? "";
  const summaryText =
    entry?.status === "creating"
      ? intl.formatMessage({ id: "worktreeSetup.stepCreating" }, { branch: stepBranch })
      : entry?.status === "ready" && entry.worktreePath
        ? intl.formatMessage(
            { id: entry.existing ? "worktreeSetup.summaryExisting" : "worktreeSetup.summaryReady" },
            { branch: stepBranch },
          )
        : entry?.status === "failed"
          ? intl.formatMessage({ id: "worktreeSetup.summaryFailed" })
          : "";
  const stepMarker =
    entry?.status === "creating" ? "creating" : entry?.status === "failed" ? "failed" : "ready";

  return (
    <div data-worktree-setup-steps="true" className={setupCardClassName}>
      <Collapsible
        data-worktree-setup-collapsible="true"
        data-worktree-session-id={sessionId}
        open={setupOpen}
        onOpenChange={(next) => {
          setupUserToggledRef.current = true;
          setSetupOpen(next);
        }}
        className="flex w-full flex-col"
      >
        <CollapsibleTrigger className="group/worktree-setup inline-flex max-w-full min-w-0 items-center gap-2 self-start text-ui-base transition-colors">
          <GitBranch className="size-4 shrink-0 text-foreground-subtlest" aria-hidden="true" />
          <span className="shrink-0 whitespace-nowrap">
            <span className="inline-flex items-center gap-2">
              <span className="font-medium text-foreground-subtlest">
                {intl.formatMessage({ id: "worktreeSetup.collapsibleLabel" })}
              </span>
              <span className="font-normal text-foreground-subtlest">·</span>
              <span
                data-worktree-setup-step={stepMarker}
                role={entry?.status === "failed" ? "alert" : "status"}
                className={cn(
                  "font-normal",
                  entry?.status === "creating" && "animated-gradient-text font-medium",
                  entry?.status === "failed" && "text-destructive",
                  entry?.status !== "creating" &&
                    entry?.status !== "failed" &&
                    "text-foreground-subtlest",
                )}
              >
                {summaryText}
              </span>
            </span>
          </span>
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-foreground-subtlest transition-opacity transition-transform",
              setupOpen
                ? "rotate-90 opacity-100"
                : "rotate-0 opacity-0 group-hover/worktree-setup:opacity-100",
            )}
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="w-full">
          <div className={setupDetailsClassName}>
            {!resolution.rpcReady ? (
              <p role="status">
                {intl.formatMessage({ id: "worktreeSetup.connectionUnavailable" })}
              </p>
            ) : null}
            {entry.status === "creating" ? (
              <div className="flex items-center gap-2" role="status">
                <Loader2
                  className={cn("size-3.5 shrink-0 animate-spin", stepGlyphClassName(entry))}
                />
                <span className="break-all">
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
                <span className="break-all">
                  {entry.existing
                    ? intl.formatMessage(
                        { id: "worktreeSetup.stepExisting" },
                        { path: entry.worktreePath },
                      )
                    : intl.formatMessage(
                        { id: "worktreeSetup.stepReady" },
                        { path: entry.worktreePath },
                      )}
                </span>
              </div>
            ) : null}
            {entry.status === "failed" ? (
              <div className="flex items-start gap-2" role="alert">
                <X className={cn("mt-0.5 size-3.5 shrink-0", stepGlyphClassName(entry))} />
                <div className="flex min-w-0 flex-col items-start gap-2">
                  <span className="break-all text-destructive">
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
                                ...(onSyncPreparation
                                  ? { syncPreparedWorktree: onSyncPreparation }
                                  : {}),
                              });
                              if (outcome === "skipped") return;
                              ownerAttemptId = attemptId || ownerAttemptId;
                              if (outcome === "failed") {
                                const failed = selectComposerWorktreePipeline(
                                  useComposerWorktreePipelineStore.getState(),
                                  workspaceKey,
                                  sessionId,
                                );
                                if (
                                  failed?.attemptId !== ownerAttemptId ||
                                  failed.status !== "failed"
                                )
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
              <span className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "worktreeSetup.stepCreating.baseHead" })}
              </span>
            ) : null}
            {entry.params ? (
              <div className="flex w-full flex-col gap-1">
                <span className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "worktreeSetup.commandLabel" })}
                </span>
                <code
                  data-worktree-setup-command="true"
                  className="block w-full break-all rounded-md border border-border bg-surface px-2 py-1 font-mono text-ui-xs text-foreground-subtle"
                >
                  {formatWorktreeAddCommand(entry.params)}
                </code>
              </div>
            ) : null}
            {entry.orphaned ? (
              <span className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "worktreeSetup.orphanedNote" })}
              </span>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
