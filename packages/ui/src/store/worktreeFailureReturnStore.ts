import { create } from "zustand";

/**
 * Return-to-draft failure surface for the composer worktree pipeline
 * (spec: specs/composer-worktree-setup-steps.md §Return to draft on failure).
 *
 * One workspace-scoped entry per workspace key (`workspaceIdentity?.trim() || workspacePath`):
 * the modal state plus one-shot request counters the draft composer and the destination control
 * consume. The store is renderer memory only — the raw Git detail must never be persisted or
 * logged; after a reload only the summarized message would be re-derived, and this state is gone
 * by design.
 */

export interface WorktreeFailureReturnModalState {
  /** Workspace the failed session belongs to; the away-user toast opens exactly this workspace. */
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  attemptId?: string;
  submissionId?: string;
  /** Primary Git mutation issue code; null when the request threw or Git classified nothing. */
  issueCode: string | null;
  message: string;
  /** Raw Git detail for the expandable block. Memory-only by contract; never logged or persisted. */
  rawDetail: string | null;
  /** Directory the failed attempt targeted (or settled on); shown in the details, never deleted. */
  worktreePath?: string;
  branchName?: string;
  /** True when the main draft was not empty and the submission stayed on the recovery card. */
  savedNotRestored?: boolean;
  savedAt: number;
}

interface WorktreeFailureReturnState {
  modalByWorkspaceKey: Record<string, WorktreeFailureReturnModalState>;
  restoreRequestByWorkspaceKey: Record<string, number>;
  /** Recovery scope of the submission the latest restore request is for (one per workspace). */
  restoreScopeByWorkspaceKey: Record<string, string>;
  submitRequestByWorkspaceKey: Record<string, number>;
  destinationOpenRequestByWorkspaceKey: Record<string, number>;
  openFailureModal: (workspaceKey: string, state: WorktreeFailureReturnModalState) => void;
  closeFailureModal: (workspaceKey: string) => void;
  /** Bump the auto-restore request for the workspace's draft composer, naming the record to restore. */
  requestDraftRestore: (workspaceKey: string, recoveryScope: string) => void;
  consumeDraftRestoreRequest: (workspaceKey: string) => void;
  /** Bump the submit request for the workspace's draft composer. */
  requestDraftSubmit: (workspaceKey: string) => void;
  consumeDraftSubmitRequest: (workspaceKey: string) => void;
  /** Bump the open request for the workspace's destination control. */
  requestDestinationOpen: (workspaceKey: string) => void;
  consumeDestinationOpenRequest: (workspaceKey: string) => void;
  dropWorkspace: (workspaceKey: string) => void;
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function bump(record: Record<string, number>, workspaceKey: string): number {
  return (record[workspaceKey] ?? 0) + 1;
}

/** Bump one request counter; consumers apply a request by comparing against their applied version. */
function request(record: Record<string, number>, workspaceKey: string): Record<string, number> {
  return { ...record, [workspaceKey]: bump(record, workspaceKey) };
}

export const useWorktreeFailureReturnStore = create<WorktreeFailureReturnState>((set) => ({
  modalByWorkspaceKey: {},
  restoreRequestByWorkspaceKey: {},
  restoreScopeByWorkspaceKey: {},
  submitRequestByWorkspaceKey: {},
  destinationOpenRequestByWorkspaceKey: {},
  openFailureModal: (workspaceKey, state) =>
    set((current) => ({
      modalByWorkspaceKey: { ...current.modalByWorkspaceKey, [workspaceKey]: state },
    })),
  closeFailureModal: (workspaceKey) =>
    set((current) => ({ modalByWorkspaceKey: omitKey(current.modalByWorkspaceKey, workspaceKey) })),
  requestDraftRestore: (workspaceKey, recoveryScope) =>
    set((current) => ({
      restoreRequestByWorkspaceKey: request(current.restoreRequestByWorkspaceKey, workspaceKey),
      restoreScopeByWorkspaceKey: {
        ...current.restoreScopeByWorkspaceKey,
        [workspaceKey]: recoveryScope,
      },
    })),
  consumeDraftRestoreRequest: (workspaceKey) =>
    set((current) => ({
      restoreRequestByWorkspaceKey: omitKey(current.restoreRequestByWorkspaceKey, workspaceKey),
      restoreScopeByWorkspaceKey: omitKey(current.restoreScopeByWorkspaceKey, workspaceKey),
    })),
  requestDraftSubmit: (workspaceKey) =>
    set((current) => ({
      submitRequestByWorkspaceKey: request(current.submitRequestByWorkspaceKey, workspaceKey),
    })),
  consumeDraftSubmitRequest: (workspaceKey) =>
    set((current) => ({
      submitRequestByWorkspaceKey: omitKey(current.submitRequestByWorkspaceKey, workspaceKey),
    })),
  requestDestinationOpen: (workspaceKey) =>
    set((current) => ({
      destinationOpenRequestByWorkspaceKey: request(
        current.destinationOpenRequestByWorkspaceKey,
        workspaceKey,
      ),
    })),
  consumeDestinationOpenRequest: (workspaceKey) =>
    set((current) => ({
      destinationOpenRequestByWorkspaceKey: omitKey(
        current.destinationOpenRequestByWorkspaceKey,
        workspaceKey,
      ),
    })),
  dropWorkspace: (workspaceKey) =>
    set((current) => ({
      modalByWorkspaceKey: omitKey(current.modalByWorkspaceKey, workspaceKey),
      restoreRequestByWorkspaceKey: omitKey(current.restoreRequestByWorkspaceKey, workspaceKey),
      restoreScopeByWorkspaceKey: omitKey(current.restoreScopeByWorkspaceKey, workspaceKey),
      submitRequestByWorkspaceKey: omitKey(current.submitRequestByWorkspaceKey, workspaceKey),
      destinationOpenRequestByWorkspaceKey: omitKey(
        current.destinationOpenRequestByWorkspaceKey,
        workspaceKey,
      ),
    })),
}));

/**
 * Issue codes whose failure is a deterministic misconfiguration: a retry with unchanged
 * parameters fails again, so the modal offers "Change branch/folder" as the primary action and
 * hides Retry (spec decision 5). Everything else (unknown, git-unavailable, worktree-locked,
 * permission failures, stale registrations) is transient and offers Retry.
 */
const WORKTREE_FAILURE_CONFIG_ISSUE_CODES = new Set([
  "target-branch-not-found",
  "target-path-invalid",
  "branch-already-exists",
  "invalid-branch-name",
]);

export function isWorktreeConfigurationFailure(issueCode: string | null | undefined): boolean {
  return (
    issueCode !== null &&
    issueCode !== undefined &&
    WORKTREE_FAILURE_CONFIG_ISSUE_CODES.has(issueCode)
  );
}
