import { OffPeakPermanentDispatchError } from "@zcode/services/node";

/**
 * Three off-peak dispatch branches:
 * - resume: conversation_id is set, so it has already run; resume the same session with the continuation prompt.
 * - bound-first-run: created in a session and bound to session_id, but has not run yet; resume the bound session and send the task's original prompt
 *   (matching dispatchCronRun's targetTaskId path).
 * - init: created from the form; create a dedicated session.
 */
export type OffPeakDispatchKind = "resume" | "bound-first-run" | "init";

export function resolveOffPeakDispatchKind(request: {
  conversationId?: string;
  sessionId?: string;
}): OffPeakDispatchKind {
  if (request.conversationId?.trim()) return "resume";
  if (request.sessionId?.trim()) return "bound-first-run";
  return "init";
}

/** The bound session was deleted by the user: retrying is pointless, so mark permanent (otherwise it will keep backing off until the lease expires and is reacquired). */
export class OffPeakBoundSessionDeletedError extends OffPeakPermanentDispatchError {
  constructor(readonly sessionId: string) {
    super(`off-peak bound session was deleted: ${sessionId}`);
    this.name = "OffPeakBoundSessionDeletedError";
  }
}

/**
 * The bound session is running a user turn: this is transient; let the scheduler retry with backoff.
 * Throw before writing the session mode: CLI session/send rejects with -32010,
 * but setMode does not check for an active turn, so writing the config first would silently switch the user's session to the task's permission mode before the busy rejection.
 */
export class OffPeakBoundSessionBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`off-peak bound session is busy: ${sessionId}`);
    this.name = "OffPeakBoundSessionBusyError";
  }
}

export function assertBoundSessionDispatchable(params: {
  sessionId: string;
  deleted: boolean;
  running: boolean;
}): void {
  if (params.deleted) throw new OffPeakBoundSessionDeletedError(params.sessionId);
  if (params.running) throw new OffPeakBoundSessionBusyError(params.sessionId);
}
