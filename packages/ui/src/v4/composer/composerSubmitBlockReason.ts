// One predicate for "why can't this submit run now", shared by submit() and by the surfaces
// that must explain a disabled action (Retry on the recovery card, the bound-session send
// barrier) so they can never disagree (specs/first-submission-instant-ux.md, Retry surface).
export type ComposerSubmitBlockReason =
  | "remoteUnavailable"
  | "sessionNotReady"
  | "sendInProgress"
  | "firstSubmissionDelivering"
  | "attachmentsNotReady";

export function resolveComposerSubmitBlockReason(input: {
  remoteAvailable: boolean;
  runtimeBlocked: boolean;
  /** Ordinary session readiness (model configuration and runtime). */
  submissionReady: boolean;
  /** The frozen submission config could be built (model selection resolved). */
  submissionConfigured: boolean;
  sendInProgress: boolean;
  /** The bound session is still a prepared reservation waiting for its frozen first input. */
  preparedSessionAwaitingFirstInput: boolean;
  /** This submit continues the frozen first submission itself (Retry / restored record). */
  retrying: boolean;
  attachmentsReady: boolean;
}): ComposerSubmitBlockReason | null {
  if (!input.remoteAvailable) return "remoteUnavailable";
  if (input.runtimeBlocked || !input.submissionReady || !input.submissionConfigured)
    return "sessionNotReady";
  if (input.sendInProgress) return "sendInProgress";
  // Ordering barrier: a foreign input admitted before the frozen one would make activation
  // report `input-admitted` for the frozen submission, which would then never be sent.
  if (input.preparedSessionAwaitingFirstInput && !input.retrying)
    return "firstSubmissionDelivering";
  if (!input.attachmentsReady) return "attachmentsNotReady";
  return null;
}
