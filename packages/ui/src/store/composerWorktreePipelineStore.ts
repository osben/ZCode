import { create } from "zustand";
import type { ComposerExecutionWorktree } from "@/v4/composer/composerDraftWorktreeIntent.js";

/**
 * Composer worktree setup pipeline (spec: specs/composer-worktree-setup-steps.md).
 *
 * The store holds one serializable pipeline per prepared session within a workspace, plus the
 * active-session pointer used by the draft composer. The Git runner in
 * v4/composer/composerWorktreePipeline.ts owns in-flight attempts. UI surfaces read this store, so
 * workspace tab switches observe live state without prop threading.
 */

export type ComposerWorktreePipelineStatus =
  | "creating"
  | "ready"
  | "failed"
  | "consumed"
  | "discarded";

/** Creation facts frozen at queue time; Retry re-runs with exactly these. */
export interface ComposerWorktreeCreationParams {
  submissionId?: string;
  attemptId?: string;
  workspacePath: string;
  branchName: string;
  targetPath: string;
  /** Resolved base branch; absent when the branch list had not loaded (server defaults to HEAD). */
  baseBranch?: string;
  /** True when the branch list was absent/failed and the base defaulted to HEAD (row note). */
  baseFromHeadDefault: boolean;
}

export interface ComposerWorktreePipelineEntry {
  status: ComposerWorktreePipelineStatus;
  /** Identity for this run; async results may only settle the attempt that started them. */
  attemptId: string;
  /** Real Host-created session that owns this preparation and later receives the first input. */
  sessionId?: string;
  /**
   * Creation facts frozen at queue time; Retry re-runs with exactly these. Absent only on
   * queue-time validation failures (invalid location etc.), which offer no Retry.
   */
  params?: ComposerWorktreeCreationParams;
  createdAt: number;
  /** Present on ready: the created (or already-existing, WT-04) worktree directory. */
  worktreePath?: string;
  /** True when ready points at a pre-existing worktree for the branch (WT-04 recovery). */
  existing?: boolean;
  /** Present on failed. */
  failureMessage?: string;
  /**
   * The user explicitly withdrew (unchecked the box) while the git call was in flight.
   * The call is not cancellable: it runs to completion, the directory is left on disk (orphan note),
   * and the queued send was dropped. An orphaned ready entry is reusable by a later intent.
   */
  orphaned?: boolean;
  /** Whether a queued send is still attached (cleared by withdrawal or navigation detach). */
  queuedPromptPreview?: string;
  /**
   * Attempts this session's entry already replaced (local Retry or a newer Host attempt). A Host
   * preparation seed carrying one of them is stale and must not roll the entry back.
   */
  supersededAttemptIds?: string[];
}

interface ComposerWorktreePipelineState {
  pipelineByWorkspaceKey: Record<string, ComposerWorktreeWorkspacePipelines>;
  startPipeline: (
    workspaceKey: string,
    entry: Omit<ComposerWorktreePipelineEntry, "attemptId">,
    options?: { activate?: boolean },
  ) => string;
  markReady: (
    workspaceKey: string,
    worktreePath: string,
    existing: boolean,
    sessionId?: string,
    attemptId?: string,
  ) => void;
  markFailed: (
    workspaceKey: string,
    failureMessage: string,
    sessionId?: string,
    attemptId?: string,
  ) => void;
  /** Terminal success: the queued/re-committed send was accepted into a session. */
  consume: (workspaceKey: string, sessionId?: string, attemptId?: string) => void;
  discard: (workspaceKey: string, sessionId?: string, attemptId?: string) => void;
  /** Queue-time validation failure: no creation params, no Retry — fix the cause (settings/location) and send again. */
  markValidationFailed: (workspaceKey: string, failureMessage: string) => void;
  /** Withdraw the queued send; the in-flight result lands with an orphan note. */
  withdraw: (workspaceKey: string, sessionId?: string) => void;
  /** Detach a renderer-local queued callback during navigation while Host preparation continues. */
  detachQueuedSend: (workspaceKey: string, sessionId?: string) => void;
  dropWorkspace: (workspaceKey: string) => void;
}

interface ComposerWorktreeWorkspacePipelines {
  /** Pipeline currently surfaced in the draft composer; older sessions remain addressable below. */
  activeSessionKey: string | null;
  entriesBySessionKey: Record<string, ComposerWorktreePipelineEntry>;
}

const UNSCOPED_SESSION_KEY = "\0unscoped";
let nextAttemptId = 0;

function sessionKey(sessionId?: string): string {
  return sessionId ?? UNSCOPED_SESSION_KEY;
}

const armedWorktreeSends = new Map<string, ArmedWorktreeSendContinuation>();

function armedContinuationKey(workspaceKey: string, preparedSessionId: string): string {
  return `${workspaceKey}\u0000${preparedSessionId}`;
}

/**
 * Release the armed continuation matching an entry address. `sessionId === undefined` resolves
 * against the workspace's active entry the same way patchEntry does. Terminal store actions call
 * this so an armed continuation cannot outlive its pipeline entry when no composer instance for
 * that prepared session is mounted to abandon it locally.
 */
function releaseArmedContinuation(workspaceKey: string, sessionId: string | undefined): void {
  let targetSessionId = sessionId;
  if (!targetSessionId) {
    const workspace =
      useComposerWorktreePipelineStore.getState().pipelineByWorkspaceKey[workspaceKey];
    const activeKey = workspace?.activeSessionKey;
    targetSessionId = activeKey && activeKey !== UNSCOPED_SESSION_KEY ? activeKey : undefined;
  }
  if (targetSessionId) {
    armedWorktreeSends.delete(armedContinuationKey(workspaceKey, targetSessionId));
  }
}

/**
 * patchEntry plus continuation release, gated on the patch applying. patchEntry returns the same
 * state object when its guards reject (missing, already terminal, or addressed to a different
 * session/attempt); a stale terminal call must not drop the continuation of a newer attempt.
 */
function patchEntryReleasingContinuation(
  state: ComposerWorktreePipelineState,
  workspaceKey: string,
  sessionId: string | undefined,
  attemptId: string | undefined,
  patch: Partial<ComposerWorktreePipelineEntry>,
): Partial<ComposerWorktreePipelineState> {
  const next = patchEntry(state, workspaceKey, sessionId, attemptId, patch);
  if (next !== state) releaseArmedContinuation(workspaceKey, sessionId);
  return next;
}

function patchEntry(
  state: ComposerWorktreePipelineState,
  workspaceKey: string,
  sessionId: string | undefined,
  attemptId: string | undefined,
  patch: Partial<ComposerWorktreePipelineEntry>,
): Partial<ComposerWorktreePipelineState> {
  const workspace = state.pipelineByWorkspaceKey[workspaceKey];
  if (!workspace) return state;
  const key = sessionKey(
    sessionId ??
      (workspace.activeSessionKey === UNSCOPED_SESSION_KEY
        ? undefined
        : (workspace.activeSessionKey ?? undefined)),
  );
  const current = workspace.entriesBySessionKey[key];
  if (
    !current ||
    current.status === "discarded" ||
    current.status === "consumed" ||
    (sessionId && current.sessionId !== sessionId) ||
    (attemptId && current.attemptId !== attemptId)
  ) {
    return state;
  }
  return {
    pipelineByWorkspaceKey: {
      ...state.pipelineByWorkspaceKey,
      [workspaceKey]: {
        ...workspace,
        entriesBySessionKey: {
          ...workspace.entriesBySessionKey,
          [key]: { ...current, ...patch },
        },
      },
    },
  };
}

export const useComposerWorktreePipelineStore = create<ComposerWorktreePipelineState>((set) => ({
  pipelineByWorkspaceKey: {},
  startPipeline: (workspaceKey, entry, { activate = true } = {}) => {
    const attemptId = entry.params?.attemptId ?? `worktree-attempt-${++nextAttemptId}`;
    set((state) => {
      const workspace = state.pipelineByWorkspaceKey[workspaceKey] ?? {
        activeSessionKey: null,
        entriesBySessionKey: {},
      };
      const key = sessionKey(entry.sessionId);
      const activeEntry = workspace.activeSessionKey
        ? workspace.entriesBySessionKey[workspace.activeSessionKey]
        : undefined;
      const canActivate =
        activate || !activeEntry || ["consumed", "discarded"].includes(activeEntry.status);
      // Single owner of supersession (BUG-GWT-005): replacing this session's entry with another
      // attempt (Retry, prepared-session restart, newer Host attempt) records the replaced one, so
      // a still-live Host seed for it is recognised as stale instead of a newer generation.
      const previous = workspace.entriesBySessionKey[key];
      const previousAttemptId = previous
        ? (previous.params?.attemptId ?? previous.attemptId)
        : null;
      const supersededAttemptIds =
        previousAttemptId && previousAttemptId !== attemptId
          ? [...(previous?.supersededAttemptIds ?? []), previousAttemptId]
          : previous?.supersededAttemptIds;
      return {
        pipelineByWorkspaceKey: {
          ...state.pipelineByWorkspaceKey,
          [workspaceKey]: {
            activeSessionKey: canActivate ? key : workspace.activeSessionKey,
            entriesBySessionKey: {
              ...workspace.entriesBySessionKey,
              [key]: {
                ...entry,
                attemptId,
                ...(supersededAttemptIds ? { supersededAttemptIds } : {}),
              },
            },
          },
        },
      };
    });
    return attemptId;
  },
  markReady: (workspaceKey, worktreePath, existing, sessionId, attemptId) =>
    set((state) =>
      patchEntry(state, workspaceKey, sessionId, attemptId, {
        status: "ready",
        worktreePath,
        existing,
        failureMessage: undefined,
      }),
    ),
  markFailed: (workspaceKey, failureMessage, sessionId, attemptId) =>
    set((state) =>
      patchEntry(state, workspaceKey, sessionId, attemptId, { status: "failed", failureMessage }),
    ),
  markValidationFailed: (workspaceKey, failureMessage) =>
    set((state) => {
      const workspace = state.pipelineByWorkspaceKey[workspaceKey] ?? {
        activeSessionKey: null,
        entriesBySessionKey: {},
      };
      const key = UNSCOPED_SESSION_KEY;
      const entry = {
        status: "failed" as const,
        attemptId: `worktree-attempt-${++nextAttemptId}`,
        createdAt: Date.now(),
        failureMessage,
      };
      return {
        pipelineByWorkspaceKey: {
          ...state.pipelineByWorkspaceKey,
          [workspaceKey]: {
            ...workspace,
            activeSessionKey: workspace.activeSessionKey ?? key,
            entriesBySessionKey: { ...workspace.entriesBySessionKey, [key]: entry },
          },
        },
      };
    }),
  consume: (workspaceKey, sessionId, attemptId) =>
    set((state) =>
      patchEntryReleasingContinuation(state, workspaceKey, sessionId, attemptId, {
        status: "consumed",
        queuedPromptPreview: undefined,
        orphaned: undefined,
      }),
    ),
  discard: (workspaceKey, sessionId, attemptId) =>
    set((state) =>
      patchEntryReleasingContinuation(state, workspaceKey, sessionId, attemptId, {
        status: "discarded",
        queuedPromptPreview: undefined,
      }),
    ),
  withdraw: (workspaceKey, sessionId) =>
    set((state) =>
      patchEntryReleasingContinuation(state, workspaceKey, sessionId, undefined, {
        queuedPromptPreview: undefined,
        orphaned: true,
      }),
    ),
  detachQueuedSend: (workspaceKey, sessionId) =>
    set((state) =>
      patchEntryReleasingContinuation(state, workspaceKey, sessionId, undefined, {
        queuedPromptPreview: undefined,
      }),
    ),
  dropWorkspace: (workspaceKey) => {
    // Map iteration tolerates deleting the visited entry; no snapshot copy is needed.
    for (const continuation of armedWorktreeSends.values()) {
      if (continuation.workspaceKey === workspaceKey) {
        armedWorktreeSends.delete(
          armedContinuationKey(continuation.workspaceKey, continuation.preparedSessionId),
        );
      }
    }
    set((state) => {
      const { [workspaceKey]: _removed, ...rest } = state.pipelineByWorkspaceKey;
      return { pipelineByWorkspaceKey: rest };
    });
  },
}));

/** Current pipeline for a workspaceKey, or null. */
export function selectComposerWorktreePipeline(
  state: ComposerWorktreePipelineState,
  workspaceKey: string,
  sessionId?: string | null,
): ComposerWorktreePipelineEntry | null {
  const workspace = state.pipelineByWorkspaceKey[workspaceKey];
  if (!workspace) return null;
  const key = sessionId ? sessionKey(sessionId) : workspace.activeSessionKey;
  return key ? (workspace.entriesBySessionKey[key] ?? null) : null;
}

/**
 * Armed continuation of a queued worktree first send (BUG-GWT-005 live path; spec
 * specs/composer-worktree-setup-steps.md §Contract "Retry-admission is a renderer obligation").
 *
 * The continuation holds the submit-time dispatch closure of the frozen submission. It must
 * survive the first-send view promotion (the draft composer unmounts and the prepared session's
 * composer mounts as a different instance), so it lives in this module-scope registry keyed by
 * workspace + prepared session instead of a component ref; the composer keeps the ref only as a
 * local cache. The closures write recovery drafts through the composer draft store and guard
 * editor access with optional chaining, so dispatching from another mounted instance is
 * equivalent to the same-instance late dispatch.
 */
export interface ArmedWorktreeSendContinuation {
  workspaceKey: string;
  preparedSessionId: string;
  attemptId?: string;
  hasBoundPreparedSession: boolean;
  dispatch: (
    executionWorktree: ComposerExecutionWorktree,
    preparedSessionId: string,
    preparedAttemptId?: string,
  ) => Promise<void>;
  /** Unclaims the submission and writes the recovery record for an abandoned pipeline. */
  restore: () => void;
  /**
   * Writes the recovery record for a retryable failure but keeps the submission claimed, so the
   * armed dispatch skips a second claim that would wipe or reject edits typed meanwhile.
   */
  restoreForRetry: () => void;
  restoredFailureKey?: string;
}

/** Arm (or rebind) the continuation of a queued worktree send for a prepared session. */
export function armWorktreeSendContinuation(continuation: ArmedWorktreeSendContinuation): void {
  armedWorktreeSends.set(
    armedContinuationKey(continuation.workspaceKey, continuation.preparedSessionId),
    continuation,
  );
}

/** The armed continuation for a prepared session, or null when none is armed. */
export function peekWorktreeSendContinuation(
  workspaceKey: string,
  preparedSessionId: string,
): ArmedWorktreeSendContinuation | null {
  return armedWorktreeSends.get(armedContinuationKey(workspaceKey, preparedSessionId)) ?? null;
}

/** Release the armed continuation (dispatched, withdrawn, or no longer recoverable). */
export function releaseWorktreeSendContinuation(
  workspaceKey: string,
  preparedSessionId: string,
): void {
  armedWorktreeSends.delete(armedContinuationKey(workspaceKey, preparedSessionId));
}
