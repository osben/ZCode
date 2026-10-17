/**
 * Draft setup intent for the empty-state "New worktree" checkbox
 * (specs/composer-worktree-setup-steps.md; supersedes the review-6c first-send interception).
 *
 * Mechanism: while the checkbox (inside the draft empty-state header) is active it writes the
 * intent into the slot. On Send, ConversationComposer resolves and validates creation params,
 * reserves the durable Host session, then starts the renderer Git pipeline and queues the send.
 * Setup rows render from the store; the queued send dispatches when the pipeline turns ready. The
 * slot is a stable object (created via useMemo): value changes do not re-render consumers;
 * volatile inputs (branch list, settings) are read inside buildCreationParams at queue time.
 */
import { createContext, useContext } from "react";

/** Wire shape of the v4 createSession executionWorktree field (shared schema keeps the authority). */
export interface ComposerExecutionWorktree {
  path: string;
  branchName: string;
}

/** Queue-time begin result: ok means the pipeline entry exists (creating); not-ok means it failed validation (reason in the store). */
export type ComposerWorktreeBeginResult = { ok: true; sessionId: string } | { ok: false };

export interface ComposerWorktreePreparationParams {
  workspaceKey: string;
  branchName: string;
  targetPath: string;
  baseBranch?: string;
}

/**
 * Reconcile the Host preparation marker with the directory Git actually used. Host activation keeps
 * its strict check (`executionWorktree.path === prepared.targetPath`); a reused or recovered
 * worktree may live at a path other than the frozen target, so the renderer must align the prepared
 * target before activation instead of sending a path the Host will reject.
 */
export interface ComposerWorktreePreparationSyncParams {
  workspaceKey: string;
  sessionId: string;
  branchName: string;
  targetPath: string;
  baseBranch?: string;
}

export type ComposerWorktreePreparationSync = (
  params: ComposerWorktreePreparationSyncParams,
) => Promise<void>;

/**
 * Setup intent registered into the slot. `workspaceKey` follows the existing identity rule
 * (`workspaceIdentity?.trim() || workspacePath`) to pin the owning draft composer, so split panes /
 * other workspaces never trigger it by mistake.
 */
export interface ComposerDraftWorktreeIntent {
  workspaceKey: string;
  /**
   * Start the setup pipeline for this send: compute and validate creation params, reserve the Host
   * session, write its session-scoped pipeline entry, and kick off Git creation. Returns before Git
   * creation resolves; the composer queues its send and dispatches when the store turns ready.
   * `syncPreparedWorktree` realigns the Host preparation marker when Git settles on a directory other
   * than the frozen target (existing/recovered worktree), so activation stays strict.
   */
  beginCreation: (
    queuedPromptPreview: string,
    prepareSession: (params: ComposerWorktreePreparationParams) => Promise<string>,
    syncPreparedWorktree?: ComposerWorktreePreparationSync,
  ) => Promise<ComposerWorktreeBeginResult>;
}

/** 稳定的可变槽位：provider 创建一次，写入方（checkbox）与读取方（composer）共享。 */
export type ComposerDraftWorktreeIntentSlot = {
  current: ComposerDraftWorktreeIntent | null;
};

export function createComposerDraftWorktreeIntentSlot(): ComposerDraftWorktreeIntentSlot {
  return { current: null };
}

export const ComposerDraftWorktreeIntentContext = createContext<
  ComposerDraftWorktreeIntentSlot | undefined
>(undefined);

export function useComposerDraftWorktreeIntentSlot(): ComposerDraftWorktreeIntentSlot | undefined {
  return useContext(ComposerDraftWorktreeIntentContext);
}
