/**
 * Whether review has just settled (transition from "review present" → "no review").
 *
 * A Trust mutation may come from another capable attachment. When review settles,
 * the store clears the binding, so this transition can trigger one refresh of the static Trust snapshot.
 *
 * Do not check only "there is no current review": that is also true on first mount and would trigger
 * an unnecessary load immediately after initialize, competing with it.
 */
export function didWorkspaceHookReviewSettle(input: {
  previousInteractionId: string | undefined;
  currentInteractionId: string | undefined;
}): boolean {
  return input.previousInteractionId !== undefined && input.currentInteractionId === undefined;
}

/**
 * reasonCode → i18n key mapping.
 *
 * When a command is rejected, inline Trust/revoke previously rendered the raw reasonCode
 * (such as workspace_hooks_review_superseded) to users, which is unreadable in any locale.
 * A missing key renders the raw id. Centralize mapping here; unknown codes fall back to
 * generic "Action was rejected" instead of the raw id, avoiding exposure of internal enum literals.
 */
const WORKSPACE_HOOK_REASON_CODE_MESSAGE_IDS: Record<string, string> = {
  workspace_hooks_review_superseded: "settings.hooks.review.reason.review_superseded",
  workspace_hooks_snapshot_mismatch: "settings.hooks.review.reason.snapshot_mismatch",
  workspace_hooks_bundle_changed: "settings.hooks.review.reason.bundle_changed",
  workspace_hooks_config_unreadable: "settings.hooks.review.reason.config_unreadable",
  workspace_hooks_config_write_failed: "settings.hooks.review.reason.config_write_failed",
  workspace_hooks_config_rebuild_failed: "settings.hooks.review.reason.config_rebuild_failed",
  workspace_hooks_trust_store_corrupt: "settings.hooks.review.reason.trust_store_corrupt",
  workspace_hooks_blocked_by_policy: "settings.hooks.review.reason.blocked_by_policy",
  workspace_hooks_policy_requires_pretrust: "settings.hooks.review.reason.policy_requires_pretrust",
  workspace_hooks_interaction_timeout: "settings.hooks.review.reason.interaction_timeout",
  workspace_hooks_require_trust_capable_host: "settings.hooks.review.reason.host_unavailable",
};

const WORKSPACE_HOOK_REASON_CODE_FALLBACK_ID = "settings.hooks.review.reason.rejected";

export function resolveWorkspaceHookReasonCodeMessageId(reasonCode: string | undefined): string {
  if (!reasonCode) return WORKSPACE_HOOK_REASON_CODE_FALLBACK_ID;
  return (
    WORKSPACE_HOOK_REASON_CODE_MESSAGE_IDS[reasonCode] ?? WORKSPACE_HOOK_REASON_CODE_FALLBACK_ID
  );
}

/**
 * Determines whether a rejected command should be silently reconciled (no error shown to the user).
 *
 * When an inline Trust button is clicked twice, each click gets a new commandId.
 * The first succeeds and settles the review flow (the store clears its binding); the second commandId
 * is validated against the settled flow and returns workspace_hooks_review_superseded. The panel must not show this as
 * a real error—the user's intent already succeeded, the message would be confusing, and it would reduce trust in actual superseded errors.
 *
 * Rule: silently reconcile only when the rejection is a superseded type **and** there is no live pending binding locally
 * (review has settled and the binding was cleared/advanced). A real superseded case (bundle changed during review, binding remains pending, and the user must review again)
 * must be shown; do not silence it when hasLivePendingBinding is true.
 *
 * This is a pure function and does not read the store; the caller extracts hasLivePendingBinding from
 * the current store snapshot after await (see useWorkspaceHookInlineTrust).
 */
export function shouldSilenceStaleRejection(input: {
  reasonCode: string | undefined;
  hasLivePendingBinding: boolean;
}): boolean {
  if (input.reasonCode !== "workspace_hooks_review_superseded") return false;
  return !input.hasLivePendingBinding;
}
