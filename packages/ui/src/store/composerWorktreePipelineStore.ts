import { create } from "zustand";

/**
 * Composer worktree setup pipeline (spec: specs/composer-worktree-setup-steps.md).
 *
 * One pipeline per workspaceKey (`workspaceIdentity?.trim() || workspacePath`). The store holds the
 * serializable state machine + the queued prompt preview; the git call is orchestrated by the runner
 * in v4/composer/composerWorktreePipeline.ts (in-flight promise map, same key). UI surfaces
 * (destination control, queued-send dispatch effect) all read this store, so workspace tab
 * switches observe live state without prop threading.
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
  pipelineByWorkspaceKey: Record<string, ComposerWorktreePipelineEntry>;
  startPipeline: (workspaceKey: string, entry: ComposerWorktreePipelineEntry) => void;
  markReady: (workspaceKey: string, worktreePath: string, existing: boolean) => void;
  markFailed: (workspaceKey: string, failureMessage: string) => void;
  /** Terminal success: the queued/re-committed send was accepted into a session. */
  consume: (workspaceKey: string) => void;
  discard: (workspaceKey: string) => void;
  /** Queue-time validation failure: no creation params, no Retry — fix the cause (settings/location) and send again. */
  markValidationFailed: (workspaceKey: string, failureMessage: string) => void;
  /** Withdraw the queued send; the in-flight result lands with an orphan note. */
  withdraw: (workspaceKey: string) => void;
  /** Detach a renderer-local queued callback during navigation while Host preparation continues. */
  detachQueuedSend: (workspaceKey: string) => void;
  dropWorkspace: (workspaceKey: string) => void;
}

function patchEntry(
  state: ComposerWorktreePipelineState,
  workspaceKey: string,
  patch:
    | Partial<ComposerWorktreePipelineEntry>
    | ((entry: ComposerWorktreePipelineEntry) => Partial<ComposerWorktreePipelineEntry>),
): Partial<ComposerWorktreePipelineState> {
  const current = state.pipelineByWorkspaceKey[workspaceKey];
  if (!current) return state;
  return {
    pipelineByWorkspaceKey: {
      ...state.pipelineByWorkspaceKey,
      [workspaceKey]: { ...current, ...(typeof patch === "function" ? patch(current) : patch) },
    },
  };
}

export const useComposerWorktreePipelineStore = create<ComposerWorktreePipelineState>((set) => ({
  pipelineByWorkspaceKey: {},
  startPipeline: (workspaceKey, entry) =>
    set((state) => ({
      pipelineByWorkspaceKey: { ...state.pipelineByWorkspaceKey, [workspaceKey]: entry },
    })),
  markReady: (workspaceKey, worktreePath, existing) =>
    set((state) =>
      patchEntry(state, workspaceKey, {
        status: "ready",
        worktreePath,
        existing,
        failureMessage: undefined,
      }),
    ),
  markFailed: (workspaceKey, failureMessage) =>
    set((state) => patchEntry(state, workspaceKey, { status: "failed", failureMessage })),
  markValidationFailed: (workspaceKey, failureMessage) =>
    set((state) => ({
      pipelineByWorkspaceKey: {
        ...state.pipelineByWorkspaceKey,
        [workspaceKey]: { status: "failed", createdAt: Date.now(), failureMessage },
      },
    })),
  consume: (workspaceKey) =>
    set((state) =>
      patchEntry(state, workspaceKey, {
        status: "consumed",
        queuedPromptPreview: undefined,
        orphaned: undefined,
      }),
    ),
  discard: (workspaceKey) =>
    set((state) =>
      patchEntry(state, workspaceKey, {
        status: "discarded",
        queuedPromptPreview: undefined,
      }),
    ),
  withdraw: (workspaceKey) =>
    set((state) =>
      patchEntry(state, workspaceKey, {
        queuedPromptPreview: undefined,
        orphaned: true,
      }),
    ),
  detachQueuedSend: (workspaceKey) =>
    set((state) => patchEntry(state, workspaceKey, { queuedPromptPreview: undefined })),
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
): ComposerWorktreePipelineEntry | null {
  return state.pipelineByWorkspaceKey[workspaceKey] ?? null;
}
