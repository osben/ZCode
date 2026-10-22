import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";

// One predicate for "why can't this submit run now", shared by submit() and by the surfaces
// that must explain a disabled action (Retry on the recovery card, the bound-session send
// barrier) so they can never disagree (specs/first-submission-instant-ux.md, Retry surface).
export type ComposerSubmitBlockReason =
  | "remoteUnavailable"
  | "modelUnavailable"
  | "sessionNotReady"
  | "sendInProgress"
  | "firstSubmissionDelivering"
  | "outcomeUnresolved"
  | "attachmentsNotReady";

// Only these issues mean the stored selection names a model that cannot run now. A missing
// selection and reasoning-level problems keep the generic "not ready" reason.
const UNAVAILABLE_MODEL_SELECTION_ISSUES: ReadonlySet<
  NonNullable<EffectiveModelSelectionResult["selectionIssue"]>
> = new Set(["provider-not-found", "account-connection-unavailable", "model-not-found"]);

export function resolveComposerSubmitBlockReason(input: {
  remoteAvailable: boolean;
  runtimeBlocked: boolean;
  /** Ordinary session readiness (model configuration and runtime). */
  submissionReady: boolean;
  /** The frozen submission config could be built (model selection resolved). */
  submissionConfigured: boolean;
  /**
   * Host verdict for the stored model selection (ModelSelectionView.selectionIssue). The stored
   * intent is kept; the composer never falls back to another model, so the user must choose one.
   */
  modelSelectionIssue?: EffectiveModelSelectionResult["selectionIssue"];
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
  // Before the generic readiness check: "try again in a moment" would hide that the user has to
  // pick a different model.
  if (
    input.modelSelectionIssue !== undefined &&
    UNAVAILABLE_MODEL_SELECTION_ISSUES.has(input.modelSelectionIssue)
  )
    return "modelUnavailable";
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
