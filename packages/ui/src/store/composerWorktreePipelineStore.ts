import { create } from "zustand";

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
  consume: (workspaceKey: string, sessionId?: string) => void;
  discard: (workspaceKey: string, sessionId?: string) => void;
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
    const attemptId = `worktree-attempt-${++nextAttemptId}`;
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
      return {
        pipelineByWorkspaceKey: {
          ...state.pipelineByWorkspaceKey,
          [workspaceKey]: {
            activeSessionKey: canActivate ? key : workspace.activeSessionKey,
            entriesBySessionKey: {
              ...workspace.entriesBySessionKey,
              [key]: { ...entry, attemptId },
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
  consume: (workspaceKey, sessionId) =>
    set((state) =>
      patchEntry(state, workspaceKey, sessionId, undefined, {
        status: "consumed",
        queuedPromptPreview: undefined,
        orphaned: undefined,
      }),
    ),
  discard: (workspaceKey, sessionId) =>
    set((state) =>
      patchEntry(state, workspaceKey, sessionId, undefined, {
        status: "discarded",
        queuedPromptPreview: undefined,
      }),
    ),
  withdraw: (workspaceKey, sessionId) =>
    set((state) =>
      patchEntry(state, workspaceKey, sessionId, undefined, {
        queuedPromptPreview: undefined,
        orphaned: true,
      }),
    ),
  detachQueuedSend: (workspaceKey, sessionId) =>
    set((state) =>
      patchEntry(state, workspaceKey, sessionId, undefined, { queuedPromptPreview: undefined }),
    ),
  dropWorkspace: (workspaceKey) =>
    set((state) => {
      const { [workspaceKey]: _removed, ...rest } = state.pipelineByWorkspaceKey;
      return { pipelineByWorkspaceKey: rest };
    }),
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
