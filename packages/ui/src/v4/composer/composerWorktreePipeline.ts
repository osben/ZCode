/**
 * Runner for the composer worktree setup pipeline (spec: specs/composer-worktree-setup-steps.md).
 *
 * Wraps the shared executeWorktreeCreation orchestration (request shape, issue→message mapping,
 * WT-04 recovery) and writes the outcome into composerWorktreePipelineStore. Idempotent per
 * workspace and prepared session: starts/retries for that session reuse the same promise. The store
 * is the UI-facing state machine; this module owns the async side effects.
 */
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import {
  executeWorktreeCreation,
  type WorktreeCreationGitService,
} from "@/command-center/worktreeCreation.js";
import {
  computeWorktreeTargetPath,
  findWorktreeForBranch,
  isValidCustomWorktreeLocationPath,
  type EffectiveWorktreeLocation,
} from "@/command-center/worktreeTaskFlow.js";
import type {
  ComposerWorktreeBeginResult,
  ComposerWorktreePreparationParams,
  ComposerWorktreePreparationSync,
} from "@/v4/composer/composerDraftWorktreeIntent.js";
import {
  useComposerWorktreePipelineStore,
  selectComposerWorktreePipeline,
  type ComposerWorktreeCreationParams,
} from "@/store/composerWorktreePipelineStore.js";

const inFlightByPipelineKey = new Map<string, Promise<"ready" | "failed">>();
const beginInFlightByWorkspaceKey = new Map<string, Promise<ComposerWorktreeBeginResult>>();

function pipelineRunKey(workspaceKey: string, sessionId?: string): string {
  return `${workspaceKey}\0${sessionId ?? "unscoped"}`;
}

/** Whether a creation attempt is currently running for the workspace (used by the stale reconcile). */
export function isComposerWorktreePipelineInFlight(
  workspaceKey: string,
  sessionId?: string,
): boolean {
  return sessionId
    ? inFlightByPipelineKey.has(pipelineRunKey(workspaceKey, sessionId))
    : [...inFlightByPipelineKey.keys()].some((key) => key.startsWith(`${workspaceKey}\0`));
}

/**
 * Start (or join) the creation pipeline for a workspace. The store entry must already be in
 * `creating` (startPipeline) so the setup rows appear before the first await resolves.
 * Resolves once the outcome is reflected in the store; never rejects.
 */
export function startComposerWorktreePipeline({
  gitService,
  workspaceKey,
  sessionId,
  params,
  formatMessage,
  syncPreparedWorktree,
}: {
  gitService: WorktreeCreationGitService;
  workspaceKey: string;
  sessionId?: string;
  params: ComposerWorktreeCreationParams;
  formatMessage: (id: string, values?: Record<string, string>) => string;
  syncPreparedWorktree?: ComposerWorktreePreparationSync;
}): Promise<"ready" | "failed"> {
  const runKey = pipelineRunKey(workspaceKey, sessionId);
  const inFlight = inFlightByPipelineKey.get(runKey);
  if (inFlight) return inFlight;
  const attemptId = selectComposerWorktreePipeline(
    useComposerWorktreePipelineStore.getState(),
    workspaceKey,
    sessionId,
  )?.attemptId;

  const attempt = (async (): Promise<"ready" | "failed"> => {
    // Host activation strictly requires executionWorktree.path === prepared.targetPath. Git may
    // settle the branch worktree elsewhere (WT-04 reuse or a recovered worktree), so align the Host
    // marker before the entry turns ready; a missing or rejected sync fails the attempt instead of
    // publishing an unactivatable ready state.
    const settleReady = async (
      worktreePath: string,
      existing: boolean,
    ): Promise<"ready" | "failed"> => {
      if (worktreePath !== params.targetPath) {
        if (sessionId && syncPreparedWorktree) {
          await syncPreparedWorktree({
            workspaceKey,
            sessionId,
            branchName: params.branchName,
            targetPath: worktreePath,
            ...(params.baseBranch ? { baseBranch: params.baseBranch } : {}),
          });
        } else {
          logger.warn("[WorktreePipeline] no marker sync; path differs");
          useComposerWorktreePipelineStore
            .getState()
            .markFailed(
              workspaceKey,
              formatMessage("worktreeSetup.reconcile.markerSyncUnavailable"),
              sessionId,
              attemptId,
            );
          return "failed";
        }
      }
      useComposerWorktreePipelineStore
        .getState()
        .markReady(workspaceKey, worktreePath, existing, sessionId, attemptId);
      return "ready";
    };
    try {
      const outcome = await executeWorktreeCreation({
        gitService,
        workspacePath: params.workspacePath,
        branchName: params.branchName,
        ...(params.baseBranch ? { baseBranch: params.baseBranch } : {}),
        targetPath: params.targetPath,
        formatMessage,
      });
      if (outcome.kind === "created") {
        logger.info("[WorktreePipeline] worktree created", {
          workspaceKey,
          branchName: params.branchName,
          targetPath: outcome.worktreePath,
        });
        return await settleReady(outcome.worktreePath, false);
      }
      if (outcome.kind === "existing-worktree") {
        // WT-04 unified: consume the existing directory in place (no draft transfer, no second one).
        logger.info("[WorktreePipeline] reusing existing worktree", {
          workspaceKey,
          branchName: params.branchName,
          targetPath: outcome.worktreePath,
        });
        return await settleReady(outcome.worktreePath, true);
      }
      if (outcome.errorDetail !== null) {
        logger.warn("[WorktreePipeline] worktree create request failed", {
          workspaceKey,
          branchName: params.branchName,
          error: outcome.errorDetail,
        });
      } else {
        logger.warn("[WorktreePipeline] worktree creation rejected", {
          workspaceKey,
          branchName: params.branchName,
          issues: outcome.issueCodes,
        });
      }
      useComposerWorktreePipelineStore
        .getState()
        .markFailed(workspaceKey, outcome.message, sessionId, attemptId);
      return "failed";
    } catch (error) {
      logger.warn("[WorktreePipeline] creation orchestration threw", {
        workspaceKey,
        branchName: params.branchName,
        error: getErrorMessage(error),
      });
      useComposerWorktreePipelineStore
        .getState()
        .markFailed(workspaceKey, getErrorMessage(error), sessionId, attemptId);
      return "failed";
    } finally {
      inFlightByPipelineKey.delete(runKey);
    }
  })();
  inFlightByPipelineKey.set(runKey, attempt);
  return attempt;
}

/**
 * Queue-time worktree creation kickoff shared by both destination entries (the legacy
 * "New worktree" checkbox and the unified destination control): location validation, target-path
 * resolution, the Host session reservation, and the runner start.
 * Callers keep their own branch-name generation and base resolution.
 */
export function beginWorktreePipelineCreation({
  gitService,
  workspaceKey,
  workspacePath,
  effectiveLocation,
  branchName,
  baseBranch,
  baseFromHeadDefault,
  queuedPromptPreview,
  prepareSession,
  syncPreparedWorktree,
  formatMessage,
}: {
  gitService: WorktreeCreationGitService;
  workspaceKey: string;
  workspacePath: string;
  effectiveLocation: EffectiveWorktreeLocation;
  branchName: string;
  baseBranch?: string;
  baseFromHeadDefault: boolean;
  queuedPromptPreview: string;
  prepareSession: (params: ComposerWorktreePreparationParams) => Promise<string>;
  syncPreparedWorktree?: ComposerWorktreePreparationSync;
  formatMessage: (id: string, values?: Record<string, string>) => string;
}): Promise<ComposerWorktreeBeginResult> {
  const inFlight = beginInFlightByWorkspaceKey.get(workspaceKey);
  if (inFlight) return inFlight;
  const existing = selectComposerWorktreePipeline(
    useComposerWorktreePipelineStore.getState(),
    workspaceKey,
  );
  if (existing?.sessionId && (existing.status === "creating" || existing.status === "ready")) {
    return Promise.resolve({ ok: true, sessionId: existing.sessionId });
  }

  const attempt = (async (): Promise<ComposerWorktreeBeginResult> => {
    const failWith = (id: string) => {
      useComposerWorktreePipelineStore
        .getState()
        .markValidationFailed(workspaceKey, formatMessage(id));
      return { ok: false } as const;
    };
    if (
      effectiveLocation.mode === "custom" &&
      !isValidCustomWorktreeLocationPath(effectiveLocation.customPath)
    ) {
      return failWith("commandCenter.worktree.error.custom-location-invalid");
    }
    if (effectiveLocation.mode === "global" && !effectiveLocation.appWorktreesDir) {
      return failWith("commandCenter.worktree.error.global-location-unavailable");
    }
    const targetPath = computeWorktreeTargetPath(workspacePath, branchName, effectiveLocation);
    if (!targetPath) {
      return failWith("commandCenter.worktree.error.target-path-invalid");
    }
    const params = {
      workspacePath,
      branchName,
      targetPath,
      ...(baseBranch ? { baseBranch } : {}),
      baseFromHeadDefault,
    };
    let sessionId: string;
    try {
      sessionId = await prepareSession({
        workspaceKey,
        branchName,
        targetPath,
        ...(baseBranch ? { baseBranch } : {}),
      });
    } catch (error) {
      useComposerWorktreePipelineStore
        .getState()
        .markValidationFailed(workspaceKey, getErrorMessage(error));
      return { ok: false };
    }
    useComposerWorktreePipelineStore.getState().startPipeline(workspaceKey, {
      status: "creating",
      sessionId,
      params,
      createdAt: Date.now(),
      queuedPromptPreview,
    });
    void startComposerWorktreePipeline({
      gitService,
      workspaceKey,
      sessionId,
      params,
      formatMessage,
      ...(syncPreparedWorktree ? { syncPreparedWorktree } : {}),
    });
    return { ok: true, sessionId } as const;
  })();
  beginInFlightByWorkspaceKey.set(workspaceKey, attempt);
  const clearInFlight = () => {
    if (beginInFlightByWorkspaceKey.get(workspaceKey) === attempt) {
      beginInFlightByWorkspaceKey.delete(workspaceKey);
    }
  };
  void attempt.then(clearInFlight, clearInFlight);
  return attempt;
}

/** Rebuild renderer-only setup state from the durable Host preparation marker after a reload. */
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
    status: "preparing" | "failed" | "cancelled";
    failureMessage?: string;
  };
}): void {
  if (preparation.status === "cancelled") return;
  const current = selectComposerWorktreePipeline(
    useComposerWorktreePipelineStore.getState(),
    workspaceKey,
    sessionId,
  );
  if (current) return;
  useComposerWorktreePipelineStore.getState().startPipeline(
    workspaceKey,
    {
      status: preparation.status === "preparing" ? "creating" : "failed",
      sessionId,
      params: {
        workspacePath,
        branchName: preparation.branchName,
        targetPath: preparation.targetPath,
        ...(preparation.baseBranch ? { baseBranch: preparation.baseBranch } : {}),
        baseFromHeadDefault: !preparation.baseBranch,
      },
      createdAt: Date.now(),
      ...(preparation.status === "failed"
        ? {
            failureMessage: preparation.failureMessage ?? "Worktree creation failed",
          }
        : {}),
    },
    { activate: false },
  );
}

/**
 * Retry a failed pipeline with its frozen params. No-op unless the entry is failed.
 * The caller re-marks the entry as creating first (setup rows show the spinner again).
 */
export function retryComposerWorktreePipeline({
  gitService,
  workspaceKey,
  sessionId,
  formatMessage,
  syncPreparedWorktree,
}: {
  gitService: WorktreeCreationGitService;
  workspaceKey: string;
  sessionId?: string;
  formatMessage: (id: string, values?: Record<string, string>) => string;
  syncPreparedWorktree?: ComposerWorktreePreparationSync;
}): Promise<"ready" | "failed"> {
  const store = useComposerWorktreePipelineStore.getState();
  const entry = selectComposerWorktreePipeline(store, workspaceKey, sessionId);
  if (!entry || entry.status !== "failed" || !entry.params) {
    return Promise.resolve("failed");
  }
  store.startPipeline(workspaceKey, {
    status: "creating",
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    params: entry.params,
    createdAt: Date.now(),
    ...(entry.queuedPromptPreview ? { queuedPromptPreview: entry.queuedPromptPreview } : {}),
    ...(entry.orphaned ? { orphaned: true } : {}),
  });
  return startComposerWorktreePipeline({
    gitService,
    workspaceKey,
    sessionId: entry.sessionId,
    params: entry.params,
    formatMessage,
    ...(syncPreparedWorktree ? { syncPreparedWorktree } : {}),
  });
}

/**
 * Stale-creating reconcile (remote reconnect / state drift): if the store says creating but no
 * runner is alive in this process, check whether the branch's worktree already exists and settle
 * the entry to ready (with the found path) or failed (Retry offered).
 */
export async function reconcileCreatingComposerWorktreePipeline({
  gitService,
  workspaceKey,
  sessionId,
  branchName,
  formatMessage,
  syncPreparedWorktree,
}: {
  gitService: WorktreeCreationGitService;
  workspaceKey: string;
  sessionId?: string;
  branchName: string;
  formatMessage: (id: string, values?: Record<string, string>) => string;
  syncPreparedWorktree?: ComposerWorktreePreparationSync;
}): Promise<void> {
  if (isComposerWorktreePipelineInFlight(workspaceKey, sessionId)) return;
  const store = useComposerWorktreePipelineStore.getState();
  const entry = selectComposerWorktreePipeline(store, workspaceKey, sessionId);
  if (!entry || entry.status !== "creating" || !entry.params) return;
  const attemptId = entry.attemptId;
  const ownerSessionId = entry.sessionId;
  try {
    const list = await gitService.listWorktrees({
      workspacePath: entry.params.workspacePath,
    });
    const existing = findWorktreeForBranch(list.worktrees, branchName);
    if (existing) {
      // The recovered worktree may sit elsewhere than the frozen target; realign the Host marker
      // before the strict activation check, and fail the entry when there is no way to realign.
      if (existing.path !== entry.params.targetPath) {
        if (ownerSessionId && syncPreparedWorktree) {
          await syncPreparedWorktree({
            workspaceKey,
            sessionId: ownerSessionId,
            branchName: entry.params.branchName,
            targetPath: existing.path,
            ...(entry.params.baseBranch ? { baseBranch: entry.params.baseBranch } : {}),
          });
        } else {
          logger.warn("[WorktreePipeline] reconcile: no marker sync; path differs");
          store.markFailed(
            workspaceKey,
            formatMessage("worktreeSetup.reconcile.markerSyncUnavailable"),
            ownerSessionId,
            attemptId,
          );
          return;
        }
      }
      store.markReady(workspaceKey, existing.path, true, ownerSessionId, attemptId);
    } else {
      store.markFailed(
        workspaceKey,
        formatMessage("worktreeSetup.reconcile.staleCreating"),
        ownerSessionId,
        attemptId,
      );
    }
  } catch (error) {
    logger.warn("[WorktreePipeline] stale-creating reconcile failed", {
      workspaceKey,
      error: getErrorMessage(error),
    });
    store.markFailed(
      workspaceKey,
      formatMessage("worktreeSetup.reconcile.staleCreating"),
      ownerSessionId,
      attemptId,
    );
  }
}
