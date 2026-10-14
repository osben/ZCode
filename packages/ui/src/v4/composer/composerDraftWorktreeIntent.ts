/**
 * Draft first-send interception intent for the empty-state "New worktree" checkbox
 * (review recommendation 6c; see
 * docs/superpowers/specs/2026-10-11-command-center-worktrees-themes-design.md).
 *
 * Mechanism: while the checkbox (inside the draft empty-state header) is active it writes the
 * interceptor into the slot; ConversationComposer reads the slot before the draft's first send
 * and calls it. On success the interceptor reports proceed and the first send goes out normally
 * in the current workspace carrying executionWorktree, so the session runs in the worktree while
 * staying listed in the current project; on failure it reports cancel and the composer keeps the
 * draft text without sending. The slot is a stable object (created via useMemo): value changes do
 * not re-render consumers; form state stays in the component/hook — no global store.
 */
import { createContext, useContext } from "react";

/** Wire shape of the v4 createSession executionWorktree field (shared schema keeps the authority). */
export interface ComposerExecutionWorktree {
  path: string;
  branchName: string;
}

export type ComposerDraftWorktreeInterceptResult =
  | { action: "cancel" }
  | { action: "proceed"; executionWorktree: ComposerExecutionWorktree };

/**
 * First-send interception intent registered into the slot. `workspaceKey` follows the existing
 * identity rule (`workspaceIdentity?.trim() || workspacePath`) to pin the owning draft composer,
 * so split panes / other workspaces never trigger it by mistake.
 */
export interface ComposerDraftWorktreeIntent {
  workspaceKey: string;
  /**
   * Intercept the first send: run validation and worktree creation. Returning cancel means the
   * send was handled (inline error or the recovery path) and the composer must not send while
   * keeping the draft text; returning proceed means the worktree was created and the composer
   * continues the normal send, attaching executionWorktree to it (session stays in this project).
   */
  interceptFirstSend: () => Promise<ComposerDraftWorktreeInterceptResult>;
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
