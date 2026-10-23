import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";

// One predicate for "why can't this submit run now", shared by submit() and by the surfaces
// that must explain a disabled action (Retry on the recovery card, the bound-session send
// barrier, the inline status line under the composer) so they can never disagree
// (specs/first-submission-instant-ux.md, Retry surface; specs/composer-unresolved-model-selection.md).
export type ComposerSubmitBlockReason =
  | "remoteUnavailable"
  | "modelUnavailable"
  | "modelAccountUnavailable"
  | "sessionNotReady"
  | "sendInProgress"
  | "firstSubmissionDelivering"
  | "outcomeUnresolved"
  | "attachmentsNotReady";

export type ComposerModelBlockReason = "modelUnavailable" | "modelAccountUnavailable";

export function isComposerModelBlockReason(
  reason: ComposerSubmitBlockReason | null,
): reason is ComposerModelBlockReason {
  return reason === "modelUnavailable" || reason === "modelAccountUnavailable";
}

// The stored selection names a model the Host cannot run now. A missing selection and
// reasoning-level problems keep the generic "not ready" reason. An account connection problem
// needs a sign-in, not only a different model, so it has its own copy.
function resolveUnavailableModelReason(
  issue: EffectiveModelSelectionResult["selectionIssue"],
): ComposerModelBlockReason | null {
  if (issue === "account-connection-unavailable") return "modelAccountUnavailable";
  if (issue === "provider-not-found" || issue === "model-not-found") return "modelUnavailable";
  return null;
}

export function resolveComposerSubmitBlockReason(input: {
  remoteAvailable: boolean;
  runtimeBlocked: boolean;
  /** Ordinary session readiness (model configuration and runtime). */
  submissionReady: boolean;
  /** The frozen submission config could be built (model selection resolved). */
  submissionConfigured: boolean;
  /**
   * Host verdict for the stored model selection (ModelSelectionView.selectionIssue). The stored
   * intent is kept. Session-bound drafts never fall back to another model; the user chooses one.
   */
  modelSelectionIssue?: EffectiveModelSelectionResult["selectionIssue"];
  /**
   * The verdict is only trusted once startup has settled (provider registry and account overlay
   * both loaded). Before that a "not found" verdict can be transient, so the generic reason stays.
   */
  modelSelectionSettled: boolean;
  sendInProgress: boolean;
  /** The bound session is still a prepared reservation waiting for its frozen first input. */
  preparedSessionAwaitingFirstInput: boolean;
  /** This submit continues the frozen first submission itself (Retry / restored record). */
  retrying: boolean;
  /**
   * The restored first submission still has an undecided sendText outcome (Remove on a
   * sending/unknown record): sending it now could admit the same input twice.
   */
  outcomeUnresolved: boolean;
  attachmentsReady: boolean;
}): ComposerSubmitBlockReason | null {
  if (!input.remoteAvailable) return "remoteUnavailable";
  const modelReason = input.modelSelectionSettled
    ? resolveUnavailableModelReason(input.modelSelectionIssue)
    : null;
  if (modelReason) {
    // The model verdict replaces the generic "not ready" reason, but a send that is already in
    // flight keeps its own copy: those barriers describe a message that is still being delivered.
    if (input.sendInProgress) return "sendInProgress";
    if (input.outcomeUnresolved) return "outcomeUnresolved";
    if (input.preparedSessionAwaitingFirstInput && !input.retrying)
      return "firstSubmissionDelivering";
    return modelReason;
  }
  if (input.runtimeBlocked || !input.submissionReady || !input.submissionConfigured)
    return "sessionNotReady";
  if (input.sendInProgress) return "sendInProgress";
  if (input.outcomeUnresolved) return "outcomeUnresolved";
  // Ordering barrier: a foreign input admitted first would reorder the frozen message behind it,
  // and the bridge marks the preparation active on any sendText, so reconciliation would then
  // take a never-run frozen record as admitted (spec: Second Send after bind).
  if (input.preparedSessionAwaitingFirstInput && !input.retrying)
    return "firstSubmissionDelivering";
  if (!input.attachmentsReady) return "attachmentsNotReady";
  return null;
}
