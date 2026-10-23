/* eslint-disable max-lines */
import { nanoid } from "nanoid";
/**
 * Runner for the composer worktree setup pipeline (spec: specs/composer-worktree-setup-steps.md).
 *
 * Wraps the shared executeWorktreeCreation orchestration (request shape, issue→message mapping,
 * WT-04 recovery) and writes the outcome into composerWorktreePipelineStore. Reservation is
 * idempotent per workspace/submission, and starts/retries for a prepared session reuse the same promise. The
 * store is the UI-facing state machine; this module owns the async side effects.
 */
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import type { GitLocalBranchListResult } from "@zcode/shared";
import {
  ensureWorktreeExclusionSafely,
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
const beginInFlightBySubmissionKey = new Map<string, Promise<ComposerWorktreeBeginResult>>();
/** Sessions whose Retry is waiting on the Host acknowledgement (count per session key). */
const pendingRetryBySessionKey = new Map<string, number>();
/** Bound for the advisory queue-time branch probe; a slower RPC degrades to HEAD, never blocks Send. */
const WORKTREE_PREFLIGHT_PROBE_TIMEOUT_MS = 1500;
/**
 * Branch names and target paths claimed by an admission before its store entry exists. Admission
 * claims them synchronously in beginWorktreePipelineCreation (before its first await), so a name
 * generator running later in the same tick already sees them; the claim is released once
 * startPipeline owns the names, or when admission fails.
 */
const admissionClaimByNameKey = new Map<string, string>();
/**
 * Store entries whose frozen params still reserve their names. Retry re-runs those params, so a
 * failed entry keeps its names reserved as well.
 */
const NAME_RESERVING_STATUSES: ReadonlySet<string> = new Set(["creating", "ready", "failed"]);

function nameClaimKeys(
  workspaceKey: string,
  branchName: string,
  targetPath: string | null,
): string[] {
  return [
    `${workspaceKey}\0branch\0${branchName}`,
    ...(targetPath === null ? [] : [`${workspaceKey}\0path\0${targetPath}`]),
  ];
}

function claimNameKeys(keys: string[], attemptId: string): () => void {
  for (const key of keys) admissionClaimByNameKey.set(key, attemptId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      if (admissionClaimByNameKey.get(key) === attemptId) admissionClaimByNameKey.delete(key);
    }
  };
}

/**
 * Whether a generated branch name or its target path is already reserved in this workspace, by an
 * admission still in progress or by a live store entry. Name generators check this together with
 * the Git branch list, so two same-tick or overlapping submissions never choose the same name.
 */
export function isComposerWorktreeNameReserved({
  workspaceKey,
  workspacePath,
  branchName,
  effectiveLocation,
}: {
  workspaceKey: string;
  workspacePath: string;
  branchName: string;
  effectiveLocation: EffectiveWorktreeLocation;
}): boolean {
  const targetPath = computeWorktreeTargetPath(workspacePath, branchName, effectiveLocation);
  if (
    nameClaimKeys(workspaceKey, branchName, targetPath).some((key) =>
      admissionClaimByNameKey.has(key),
    )
  )
    return true;
  const workspace =
    useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspaceKey];
  return Object.values(workspace?.entriesBySessionKey ?? {}).some(
    (entry) =>
      entry.params !== undefined &&
      NAME_RESERVING_STATUSES.has(entry.status) &&
      (entry.params.branchName === branchName ||
        (targetPath !== null && entry.params.targetPath === targetPath)),
  );
}

/**
 * Whether another session's live entry already owns this branch or worktree directory. An
 * existing-worktree outcome for such a path is another pipeline's directory, not a reusable one.
 */
function isWorktreeOwnedByOtherEntry(
  workspaceKey: string,
  sessionId: string | undefined,
  branchName: string,
  worktreePath: string,
): boolean {
  const workspace =
    useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspaceKey];
  return Object.values(workspace?.entriesBySessionKey ?? {}).some(
    (entry) =>
      (entry.sessionId ?? undefined) !== (sessionId ?? undefined) &&
      entry.params !== undefined &&
      (entry.status === "creating" || entry.status === "ready" || entry.status === "failed") &&
      (entry.params.branchName === branchName ||
        entry.params.targetPath === worktreePath ||
        entry.worktreePath === worktreePath),
  );
}

function retrySessionKey(workspaceKey: string, sessionId?: string): string {
  return `${workspaceKey}\0${sessionId ?? "unscoped"}`;
}

function pipelineRunKey(workspaceKey: string, sessionId?: string, attemptId?: string): string {
  return `${workspaceKey}\0${sessionId ?? "unscoped"}\0${attemptId ?? "legacy"}`;
}

/** Whether a creation attempt is currently running for the workspace (used by the stale reconcile). */
export function isComposerWorktreePipelineInFlight(
  workspaceKey: string,
  sessionId?: string,
): boolean {
  return sessionId
    ? [...inFlightByPipelineKey.keys()].some((key) =>
        key.startsWith(`${workspaceKey}\0${sessionId}\0`),
      )
    : [...inFlightByPipelineKey.keys()].some((key) => key.startsWith(`${workspaceKey}\0`));
}

/**
 * Mark a session's Retry as waiting on the Host acknowledgement. Until the returned release runs,
 * the stale-creating reconcile neither starts nor settles that session: the Retry owner starts Git
 * for the acknowledged attempt even when its Host snapshot was adopted as `creating` first.
 * The release is idempotent.
 */
export function markComposerWorktreeRetryPending(
  workspaceKey: string,
  sessionId?: string,
): () => void {
  const key = retrySessionKey(workspaceKey, sessionId);
  pendingRetryBySessionKey.set(key, (pendingRetryBySessionKey.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (pendingRetryBySessionKey.get(key) ?? 1) - 1;
    if (remaining > 0) pendingRetryBySessionKey.set(key, remaining);
    else pendingRetryBySessionKey.delete(key);
  };
}

/** Whether a Retry for the session is still waiting on the Host acknowledgement. */
export function isComposerWorktreeRetryPending(workspaceKey: string, sessionId?: string): boolean {
  return pendingRetryBySessionKey.has(retrySessionKey(workspaceKey, sessionId));
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
  const attemptId =
    params.attemptId ??
    selectComposerWorktreePipeline(
      useComposerWorktreePipelineStore.getState(),
      workspaceKey,
      sessionId,
    )?.attemptId;
  const runKey = pipelineRunKey(workspaceKey, sessionId, attemptId);
  const inFlight = inFlightByPipelineKey.get(runKey);
  if (inFlight) return inFlight;

  const attempt = (async (): Promise<"ready" | "failed"> => {
    // Host activation strictly requires executionWorktree.path === prepared.targetPath. Git may
    // settle the branch worktree elsewhere (WT-04 reuse or a recovered worktree), so align the Host
    // marker before the entry turns ready; a missing or rejected sync fails the attempt instead of
    // publishing an unactivatable ready state.
    const settleReady = async (
      worktreePath: string,
      existing: boolean,
    ): Promise<"ready" | "failed"> => {
      const current = selectComposerWorktreePipeline(
        useComposerWorktreePipelineStore.getState(),
        workspaceKey,
        sessionId,
      );
      if (!current || current.attemptId !== attemptId || current.status !== "creating")
        return "failed";
      if (worktreePath !== params.targetPath) {
        if (sessionId && syncPreparedWorktree) {
          await syncPreparedWorktree({
            workspaceKey,
            sessionId,
            ...(params.attemptId ? { attemptId: params.attemptId } : {}),
            branchName: params.branchName,
            targetPath: worktreePath,
            ...(params.baseBranch ? { baseBranch: params.baseBranch } : {}),
          });
        } else {
          logger.warn("[WorktreePipeline] no marker sync; path differs");
          return failPreparation({
            message: formatMessage("worktreeSetup.reconcile.markerSyncUnavailable"),
          });
        }
      }
      useComposerWorktreePipelineStore
        .getState()
        .markReady(workspaceKey, worktreePath, existing, sessionId, attemptId);
      return "ready";
    };
    // Failed preparation retains the same session and frozen input for explicit recovery.
    const failPreparation = (failure: {
      message: string;
      issueCode?: string | null;
      rawDetail?: string | null;
    }): "failed" => {
      useComposerWorktreePipelineStore
        .getState()
        .markFailed(workspaceKey, failure.message, sessionId, attemptId, {
          issueCode: failure.issueCode ?? null,
          rawDetail: failure.rawDetail ?? null,
        });
      // A submitted session remains visible after preparation fails; Retry owns the next attempt.
      return "failed";
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
        // A directory owned by another live pipeline is not WT-04 reuse: two sessions must never
        // execute in one worktree, so this attempt fails instead of settling ready.
        if (
          isWorktreeOwnedByOtherEntry(
            workspaceKey,
            sessionId,
            params.branchName,
            outcome.worktreePath,
          )
        ) {
          logger.warn("[WorktreePipeline] existing worktree belongs to another pipeline", {
            workspaceKey,
            branchName: params.branchName,
            targetPath: outcome.worktreePath,
          });
          return failPreparation({
            message: formatMessage("worktreeSetup.reservation.conflict"),
          });
        }
        // WT-04 unified: consume the existing directory in place (no draft transfer, no second one).
        logger.info("[WorktreePipeline] reusing existing worktree", {
          workspaceKey,
          branchName: params.branchName,
          targetPath: outcome.worktreePath,
        });
        return await settleReady(outcome.worktreePath, true);
      }
      // Logs carry issue codes or a classification only. The raw Git/RPC text (rawDetail) lives in
      // the failure modal's memory state and must not reach production logs.
      logger.warn("[WorktreePipeline] worktree creation failed", {
        workspaceKey,
        branchName: params.branchName,
        issues: outcome.issueCodes,
      });
      // Return-to-draft hand-off (live renderer only) runs inside failPreparation for every failure.
      return failPreparation({
        message: outcome.message,
        issueCode: outcome.issueCode,
        rawDetail: outcome.rawDetail,
      });
    } catch (error) {
      // Only the error class is logged: the message can carry filesystem or transport detail.
      logger.warn("[WorktreePipeline] creation orchestration threw", {
        workspaceKey,
        branchName: params.branchName,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      // The primary message is the generic worktree summary; the raw error text is kept only as
      // memory-only detail for the failure modal (never logged, never shown inline).
      return failPreparation({
        message: formatMessage("commandCenter.worktree.error.unknown"),
        rawDetail: getErrorMessage(error),
      });
    } finally {
      inFlightByPipelineKey.delete(runKey);
    }
  })();
  inFlightByPipelineKey.set(runKey, attempt);
  return attempt;
}

/**
 * Queue-time base-branch preflight with positive evidence only (spec §Preflight): a successfully
 * loaded branch list proves an unborn HEAD or a missing explicit base. A failed, absent, or hung
 * probe never blocks Send; the base degrades to HEAD (acceptance scenario 24). The probe is
 * advisory and bounded, and its raw error is neither logged nor returned.
 *
 * Tri-state: `failed` blocks Send, `confirmed` keeps the explicit base, and `unconfirmed` (absent,
 * rejected, or timed out) drops the explicit base so the creation falls back to HEAD.
 */
type PreflightFailure = { messageId: string; values: Record<string, string> };
type PreflightOutcome =
  | { kind: "failed"; failure: PreflightFailure }
  | { kind: "confirmed" }
  | { kind: "unconfirmed" };

/**
 * Returns null synchronously when the Git service has no branch probe, so the admission keeps its
 * synchronous path to prepareSession; otherwise the bounded probe is awaited.
 */
function queueTimeBaseBranchPreflight({
  gitService,
  workspacePath,
  baseBranch,
}: {
  gitService: WorktreeCreationGitService;
  workspacePath: string;
  baseBranch?: string;
}): Promise<PreflightOutcome> | null {
  if (!gitService.getLocalBranches) return null;
  return probeBaseBranchPreflight(
    gitService.getLocalBranches.bind(gitService),
    workspacePath,
    baseBranch,
  );
}

async function probeBaseBranchPreflight(
  getLocalBranches: NonNullable<WorktreeCreationGitService["getLocalBranches"]>,
  workspacePath: string,
  baseBranch: string | undefined,
): Promise<PreflightOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let branches: GitLocalBranchListResult | null = null;
  try {
    branches = await Promise.race([
      getLocalBranches({ workspacePath }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), WORKTREE_PREFLIGHT_PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    branches = null;
  } finally {
    clearTimeout(timer);
  }
  if (!branches) return { kind: "unconfirmed" };
  if (branches.branches.length === 0 && branches.currentBranchName !== null) {
    // Unborn HEAD: no base (explicit or defaulted) can be forked from. The message already carries
    // the "repository without commits" hint.
    return {
      kind: "failed",
      failure: {
        messageId: "commandCenter.worktree.error.target-branch-not-found",
        values: { branchName: baseBranch ?? branches.currentBranchName },
      },
    };
  }
  if (
    baseBranch &&
    branches.branches.length > 0 &&
    !branches.branches.some((branch) => branch.name === baseBranch)
  ) {
    return {
      kind: "failed",
      failure: {
        messageId: "commandCenter.worktree.error.target-branch-not-found",
        values: { branchName: baseBranch },
      },
    };
  }
  return { kind: "confirmed" };
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
  workspaceIdentity,
  effectiveLocation,
  branchName,
  baseBranch,
  baseFromHeadDefault,
  queuedPromptPreview,
  prepareSession,
  syncPreparedWorktree,
  submissionId,
  formatMessage,
}: {
  gitService: WorktreeCreationGitService;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  effectiveLocation: EffectiveWorktreeLocation;
  branchName: string;
  baseBranch?: string;
  baseFromHeadDefault: boolean;
  queuedPromptPreview: string;
  prepareSession: (params: ComposerWorktreePreparationParams) => Promise<string>;
  syncPreparedWorktree?: ComposerWorktreePreparationSync;
  submissionId?: string;
  formatMessage: (id: string, values?: Record<string, string>) => string;
}): Promise<ComposerWorktreeBeginResult> {
  const reservationKey = submissionId ? `${workspaceKey}\0${submissionId}` : null;
  const inFlight = reservationKey ? beginInFlightBySubmissionKey.get(reservationKey) : undefined;
  if (inFlight) return inFlight;
  // A workspace can contain several new chats. Only the same frozen submission may reuse a reservation.
  const existing = submissionId
    ? Object.values(
        useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspaceKey]
          ?.entriesBySessionKey ?? {},
      ).find(
        (entry) =>
          entry.params?.submissionId === submissionId &&
          (entry.status === "creating" || entry.status === "ready"),
      )
    : undefined;
  if (existing?.sessionId) {
    return Promise.resolve({ ok: true, sessionId: existing.sessionId });
  }

  const attempt = (async (): Promise<ComposerWorktreeBeginResult> => {
    const failWith = (id: string, values?: Record<string, string>) => {
      useComposerWorktreePipelineStore
        .getState()
        .markValidationFailed(workspaceKey, formatMessage(id, values));
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
    // Claim the names before the first await: the generator for the next submission runs in a
    // later task and must see them even while the preflight or prepareSession is still pending.
    const nameKeys = nameClaimKeys(workspaceKey, branchName, targetPath);
    if (nameKeys.some((key) => admissionClaimByNameKey.has(key))) {
      return failWith("worktreeSetup.reservation.conflict");
    }
    const attemptId = nanoid();
    const releaseNames = claimNameKeys(nameKeys, attemptId);
    const preflightProbe = queueTimeBaseBranchPreflight({ gitService, workspacePath, baseBranch });
    const preflight: PreflightOutcome | null = preflightProbe ? await preflightProbe : null;
    if (preflight?.kind === "failed") {
      releaseNames();
      return failWith(preflight.failure.messageId, preflight.failure.values);
    }
    // Only a confirmed probe keeps the explicit base; an absent, rejected, or timed-out probe
    // degrades to HEAD, so a stale or unverified base is never sent to the Host.
    const keepExplicitBase = Boolean(baseBranch) && preflight?.kind === "confirmed";
    const confirmedBaseBranch = keepExplicitBase ? baseBranch : undefined;
    const effectiveBaseFromHeadDefault =
      baseBranch && !keepExplicitBase ? true : baseFromHeadDefault;
    const params = {
      ...(submissionId ? { submissionId } : {}),
      attemptId,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      branchName,
      targetPath,
      ...(effectiveLocation.mode === "custom" && effectiveLocation.customPath
        ? { customLocationPath: effectiveLocation.customPath }
        : {}),
      ...(confirmedBaseBranch ? { baseBranch: confirmedBaseBranch } : {}),
      baseFromHeadDefault: effectiveBaseFromHeadDefault,
    };
    let sessionId: string;
    try {
      sessionId = await prepareSession({
        attemptId,
        workspaceKey,
        branchName,
        targetPath,
        ...(confirmedBaseBranch ? { baseBranch: confirmedBaseBranch } : {}),
      });
    } catch (error) {
      releaseNames();
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
    // The store entry now holds the names (NAME_RESERVING_STATUSES); the claim is no longer needed.
    releaseNames();
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
  // Reason: without a submission id there is no frozen submission to dedupe against, so a shared
  // "legacy" key would hand one new chat another chat's in-flight admission and sessionId.
  if (reservationKey === null) return attempt;
  beginInFlightBySubmissionKey.set(reservationKey, attempt);
  const clearInFlight = () => {
    if (beginInFlightBySubmissionKey.get(reservationKey) === attempt) {
      beginInFlightBySubmissionKey.delete(reservationKey);
    }
  };
  void attempt.then(clearInFlight, clearInFlight);
  return attempt;
}

/** Rebuild renderer-only setup state from the durable Host preparation marker after a reload. */
export { restoreComposerWorktreePipelineFromPreparation } from "./composerWorktreePreparationRestore.js";

/**
 * Frozen parameters for retrying a prepared session's creation (ISSUE-051): the entry's frozen
 * params win per field (Retry re-runs exactly what this session froze), the Host preparation
 * marker fills the gaps when the pane snapshot carries one, and the marker alone is used when no
 * entry exists. The durable Host marker stays the compare-and-set authority; this only names the
 * attempt and destination the retry dispatches with.
 */
export function resolveComposerWorktreeRetryPreparation({
  preparation,
  pipelineEntry,
}: {
  preparation: {
    branchName: string;
    targetPath: string;
    baseBranch?: string;
    attemptId?: string;
  } | null;
  pipelineEntry?: {
    params?: {
      branchName: string;
      targetPath: string;
      baseBranch?: string;
      attemptId?: string;
    };
  } | null;
}): {
  branchName: string;
  targetPath: string;
  baseBranch?: string;
  attemptId?: string;
} | null {
  const params = pipelineEntry?.params;
  // Entry wins per field only because Host CAS rejects attempt mismatches.
  const branchName = params?.branchName ?? preparation?.branchName;
  const targetPath = params?.targetPath ?? preparation?.targetPath;
  if (!branchName || !targetPath) return null;
  const baseBranch = params?.baseBranch ?? preparation?.baseBranch;
  const attemptId = params?.attemptId ?? preparation?.attemptId;
  return {
    branchName,
    targetPath,
    ...(baseBranch ? { baseBranch } : {}),
    ...(attemptId ? { attemptId } : {}),
  };
}

/**
 * Retry a pipeline with its frozen params; the caller that obtained the Host acknowledgement for
 * `attemptId` is the single owner of starting Git for it. Proceeds from:
 * - `failed` (for `retriedAttemptId` when given): re-marks the entry `creating` for the new attempt;
 * - `creating` for exactly the acknowledged `attemptId` with no runner in flight: the Host snapshot
 *   for the retried attempt was restored before the acknowledgement (restore never starts Git).
 * Any other entry state means the session already moved on, and resolves `skipped`.
 */
export function retryComposerWorktreePipeline({
  gitService,
  workspaceKey,
  sessionId,
  attemptId,
  retriedAttemptId,
  formatMessage,
  syncPreparedWorktree,
}: {
  gitService: WorktreeCreationGitService;
  workspaceKey: string;
  sessionId?: string;
  attemptId?: string;
  /** Entry attempt the caller retried; a `failed` entry for another attempt is not retried. */
  retriedAttemptId?: string;
  formatMessage: (id: string, values?: Record<string, string>) => string;
  syncPreparedWorktree?: ComposerWorktreePreparationSync;
}): Promise<"ready" | "failed" | "skipped"> {
  const store = useComposerWorktreePipelineStore.getState();
  const entry = selectComposerWorktreePipeline(store, workspaceKey, sessionId);
  if (!entry?.params) return Promise.resolve("skipped");
  if (
    entry.status === "creating" &&
    attemptId &&
    entry.params.attemptId === attemptId &&
    !isComposerWorktreePipelineInFlight(workspaceKey, sessionId)
  ) {
    return startComposerWorktreePipeline({
      gitService,
      workspaceKey,
      sessionId: entry.sessionId,
      params: entry.params,
      formatMessage,
      ...(syncPreparedWorktree ? { syncPreparedWorktree } : {}),
    });
  }
  if (
    entry.status !== "failed" ||
    (retriedAttemptId !== undefined && entry.attemptId !== retriedAttemptId)
  ) {
    return Promise.resolve("skipped");
  }
  const params = { ...entry.params, ...(attemptId ? { attemptId } : {}) };
  store.startPipeline(workspaceKey, {
    status: "creating",
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    params,
    createdAt: Date.now(),
    ...(entry.queuedPromptPreview ? { queuedPromptPreview: entry.queuedPromptPreview } : {}),
    ...(entry.orphaned ? { orphaned: true } : {}),
  });
  return startComposerWorktreePipeline({
    gitService,
    workspaceKey,
    sessionId: entry.sessionId,
    params,
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
  // A Retry awaiting its Host acknowledgement owns starting Git for the session; settling the
  // adopted attempt now would report it failed before its runner starts (BUG-GWT-005 Wave 4).
  const isOwnedElsewhere = () =>
    isComposerWorktreePipelineInFlight(workspaceKey, sessionId) ||
    isComposerWorktreeRetryPending(workspaceKey, sessionId);
  if (isOwnedElsewhere()) return;
  const store = useComposerWorktreePipelineStore.getState();
  const entry = selectComposerWorktreePipeline(store, workspaceKey, sessionId);
  if (!entry || entry.status !== "creating" || !entry.params) return;
  const attemptId = entry.attemptId;
  const isCurrent = () => {
    if (isOwnedElsewhere()) return false;
    const current = selectComposerWorktreePipeline(
      useComposerWorktreePipelineStore.getState(),
      workspaceKey,
      sessionId,
    );
    return current?.attemptId === attemptId && current.status === "creating";
  };
  const ownerSessionId = entry.sessionId;
  try {
    const list = await gitService.listWorktrees({
      workspacePath: entry.params.workspacePath,
    });
    if (!isCurrent()) return;
    const existing = findWorktreeForBranch(list.worktrees, branchName);
    if (existing) {
      // The registration may be stale (directory removed by hand): verify the real directory and
      // its Git link on the target Host before the entry can turn ready.
      const verification = await gitService.verifyWorktreeUsable({
        workspacePath: entry.params.workspacePath,
        targetPath: existing.path,
      });
      if (!isCurrent()) return;
      if (!verification.ok) {
        logger.warn("[WorktreePipeline] reconcile: registered worktree is not usable", {
          workspaceKey,
          branchName,
          path: existing.path,
          reason: verification.reason,
        });
        store.markFailed(
          workspaceKey,
          formatMessage("worktreeSetup.reconcile.worktreeMissing", {
            branchName,
            path: existing.path,
          }),
          ownerSessionId,
          attemptId,
        );
        return;
      }
      // A crash between creation and the exclusion step leaves an inside-placement worktree
      // unexcluded; reconcile is the recovery point that settles it, same as the created outcome.
      await ensureWorktreeExclusionSafely(gitService, entry.params.workspacePath, existing.path);
      // The recovered worktree may sit elsewhere than the frozen target; realign the Host marker
      // before the strict activation check, and fail the entry when there is no way to realign.
      if (existing.path !== entry.params.targetPath) {
        if (ownerSessionId && syncPreparedWorktree) {
          await syncPreparedWorktree({
            workspaceKey,
            sessionId: ownerSessionId,
            ...(entry.params.attemptId ? { attemptId: entry.params.attemptId } : {}),
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
      if (!isCurrent()) return;
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
    if (!isCurrent()) return;
    store.markFailed(
      workspaceKey,
      formatMessage("worktreeSetup.reconcile.staleCreating"),
      ownerSessionId,
      attemptId,
    );
  }
}
