// ============================================================
// AgentRuntime-backed WorkflowDriver: escalation question bridge (escalate).
// ============================================================
// workflow-driver.ts reached oxlint's 400-line max-lines limit, so the four methods for the fourth sequence (escalation Q&A)—session-level escalate port, qid minting, answer settlement,
// and removing all questions for a session—were moved here as free functions; the driver class keeps only thin delegates. The public surface is unchanged and remains exported from workflow-driver.ts.
//
// All access to driver state by these four functions is passed explicitly through {@link EscalationHost} (session table, qid lookup table,
// dependencies, per-run sequence, dual-track record). This file owns no state; the original method bodies are preserved, with only
// `this.` changed to `host.`.

import type {
  EscalateQuestionRequest,
  SessionId,
  WorkflowEscalateOutcome,
  WorkflowEscalatePort,
} from "@zcode/contracts";
import {
  refToString,
  WorkflowError,
  type ActorRef,
  type PersonaSpec,
  type RunEvent,
} from "@zcode/dynamic-workflow";
import {
  ESCALATION_BUDGET_EXHAUSTED,
  MAX_ESCALATIONS_PER_ASK,
  defer,
  effectiveActorName,
  normalizeEscalationContext,
  questionIdFragments,
} from "./workflow-driver-helpers.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * Host surface the driver supplies to the escalation bridge. These are all **references** to private driver state, not copies: `sessions` /
 * `qidToSession` are the class's two tables, `nextEscalationSeq` increments its per-run sequence, and `record` writes on both tracks
 * (journal + emit; order must not change—see the driver's record comment).
 */
export interface EscalationHost {
  readonly deps: AgentRuntimeWorkflowDriverDeps;
  readonly sessions: ReadonlyMap<string, SessionState>;
  readonly qidToSession: Map<string, SessionState>;
  /** Get the next monotonically increasing per-run escalation sequence (the second qid segment). */
  nextEscalationSeq(): number;
  record(event: RunEvent): void;
}

/**
 * Settle a parked escalation question (called by run service through the registry). Like {@link AgentRuntimeWorkflowDriver.respondToSubmit}:
 * resolve the deferred so this answer becomes the `escalate` tool result, and the actor continues in the same turn.
 *
 * Return false if this driver does not have the qid (wrong run or it was just removed by cancelAsk). The registry retires the qid before calling
 * this method, so do not write to it again here—retiring in both places could overwrite the distinction between "answered" and "removed".
 */
export function respondToParkedEscalation(
  host: EscalationHost,
  qid: string,
  answer: string,
): boolean {
  const state = host.qidToSession.get(qid);
  if (state === undefined) return false;
  const deferred = state.pendingEscalations.get(qid);
  host.qidToSession.delete(qid);
  state.pendingEscalations.delete(qid);
  if (deferred === undefined) return false;
  try {
    host.record({ type: "escalation-resolved", qid, answer });
  } catch (error) {
    // The tradeoff is **opposite** to the raise path, for the opposite reason: if the question cannot be recorded there, nobody can see it and the actor would
    // block forever, so the registration is revoked and the error rethrown. Here the actor is already waiting for this answer; keeping it blocked over an observation
    // event would be worse. Log a warning and deliver the answer.
    host.deps.logger?.warn?.("Dynamic workflow escalation resolved event not journaled", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.escalation.resolved_journal_failed",
      module: "bootstrap.app",
      qid,
      runId: host.deps.runId ?? "run",
    });
  }
  deferred.resolve(answer);
  return true;
}

/**
 * Remove all parked escalation questions for a session: reject each deferred (so handlers do not hang) and retire each registry entry
 * (later answers for those qids receive `run_not_in_flight`).
 *
 * Three call sites cover all abnormal paths that end an ask: `cancelAsk` (engine cancellation), `onTurnRejected`
 * (the turn throws—nobody will read the tool result), and `startAsk` (starting the next ask in the same session).
 * The normal path does not need this: a parked escalate blocks the turn, so the ask cannot settle while an answer is outstanding.
 */
export function withdrawSessionEscalations(host: EscalationHost, state: SessionState): void {
  if (state.pendingEscalations.size === 0) return;
  const entries = [...state.pendingEscalations];
  state.pendingEscalations.clear();
  for (const [qid, deferred] of entries) {
    host.qidToSession.delete(qid);
    host.deps.escalationRegistry.withdraw(qid);
    deferred.reject(
      new WorkflowError("Cancelled", `Escalation ${qid} was cancelled along with its ask.`),
    );
  }
}

/**
 * Create a session-level escalation port: the `escalate` handler calls it mid-turn and blocks until the main agent answers.
 *
 * Symmetric with {@link AgentRuntimeWorkflowDriver.makeSubmitPort}; both differences come from the other side being the main agent rather than the engine:
 *   1. **Do not report to sink.** The engine core is unchanged—the whole escalation occurs within the driver's ask boundary (at the same level as
 *      repair / nudge turns), so the zero-I/O state machine is unaware of it. Events go through both journal + emit tracks.
 *   2. **Multiple parked entries are allowed** (key = qid), because the model may issue several escalate calls in parallel during one turn.
 *
 * Both early exits return **normal tool results** instead of throwing: when the budget is exhausted, an exception would look like a retryable failure
 * and make the model hit the same wall repeatedly—the exact spin this feature is meant to eliminate.
 */
export function makeSessionEscalatePort(
  host: EscalationHost,
  sessionId: SessionId,
  actor: ActorRef,
  persona: PersonaSpec,
): WorkflowEscalatePort {
  const actorName = effectiveActorName(persona);
  return {
    escalate: (request: EscalateQuestionRequest): Promise<WorkflowEscalateOutcome> => {
      const state = host.sessions.get(sessionId);
      if (state === undefined || state.currentInstance === undefined) {
        // No active ask: there is nowhere to park the question. Do not park or hang (same rationale as the identically named submit guard).
        return Promise.resolve({
          kind: "refused",
          reason: "no_active_ask",
          message:
            "No ask is in flight, so there is nowhere to park this question and nobody " +
            "would answer it. Escalate only while working on an ask.",
        });
      }
      if (state.escalationsUsed >= MAX_ESCALATIONS_PER_ASK) {
        // Per-ask limit (same family as the nudge budget): short-circuit from the fourth call onward; never park.
        return Promise.resolve({
          kind: "refused",
          reason: "budget_exhausted",
          message: ESCALATION_BUDGET_EXHAUSTED,
        });
      }
      state.escalationsUsed++;

      const qid = mintEscalationQuestionId(host);
      const deferred = defer<string>();
      state.pendingEscalations.set(qid, deferred);
      host.qidToSession.set(qid, state);
      const context = normalizeEscalationContext(request.context);
      // Read the clock **once** and share it between the event and parked record. Calling Date.now() separately would give the same question different ask times
      // in the event stream and snapshot by a few milliseconds, but downstream uses it to calculate how long it has been waiting.
      const askedAt = Date.now();
      host.deps.escalationRegistry.park(
        {
          qid,
          runId: host.deps.runId ?? "run",
          actor: refToString(actor),
          ...(actorName === undefined ? {} : { actorName }),
          question: request.question,
          ...(context === undefined ? {} : { context }),
          askedAt,
        },
        (answer) => {
          respondToParkedEscalation(host, qid, answer);
        },
      );
      try {
        host.record({
          type: "escalation-raised",
          qid,
          actor,
          ...(actorName === undefined ? {} : { actorName }),
          question: request.question,
          ...(context === undefined ? {} : { context }),
          askedAt,
        });
      } catch (error) {
        // If the journal write fails, there is no durable question record, and parking would block the actor indefinitely on a question nobody can see.
        // Revoke the registration and return the error to the handler; this is more honest than silently parking.
        state.pendingEscalations.delete(qid);
        host.qidToSession.delete(qid);
        host.deps.escalationRegistry.withdraw(qid);
        throw error;
      }
      return deferred.promise.then((answer) => ({ kind: "answered", answer, qid }) as const);
    },
  };
}

/**
 * Mint a globally unique question ID: `dwfq-<runId fragment>-<seq>`.
 *
 * The fragment helps humans recognize IDs while debugging (semantically opaque—the model only returns it as a token); seq increases monotonically per run.
 * Short fragments (8 characters) could collide with another run in extreme cases, so try candidates of increasing length and take the first unused in the registry.
 * The **last candidate is the full runId**; by construction, unique runId × per-run monotonic seq cannot collide, so the loop must end with an unused ID.
 * If every candidate is used, two drivers are sharing a runId (wiring error); fail loudly instead of issuing an ID that could mismatch answers.
 */
function mintEscalationQuestionId(host: EscalationHost): string {
  const seq = host.nextEscalationSeq();
  for (const fragment of questionIdFragments(host.deps.runId ?? "run")) {
    const candidate = `dwfq-${fragment}-${seq}`;
    if (!host.deps.escalationRegistry.isTaken(candidate)) return candidate;
  }
  throw new WorkflowError(
    "DriverError",
    `Cannot mint a free escalation question id for run ${host.deps.runId ?? "run"} ` +
      `(seq=${seq}): every candidate is already taken in the registry. Two drivers may be ` +
      `sharing one runId.`,
  );
}
