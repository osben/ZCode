// ============================================================
// Workflow Escalate Port - boundary for an actor escalating a blocking question to the main agent
// ============================================================
// Structurally similar to {@link WorkflowSubmitPort}, but intentionally separate:
// submit settles **the result of this ask** (decided by the engine), while escalate settles
// **one question and answer** (answered by the main agent). Their counterparts, lifecycles,
// and failure shapes differ; combining them would make the two sequences hard to distinguish.

import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

export interface EscalateQuestionRequest {
  /** Tool call id in the actor child session that initiated `escalate`. */
  toolCallId: ToolCallId | string;
  /** The blocking issue itself: a focused question answerable in one sentence. */
  question: string;
  /** Optional context (what the actor has tried and where it is stuck). */
  context?: string;
  trace: TraceContext;
}

/**
 * Outcome of one escalation. **Both variants are ordinary tool results**, not errors: when the
 * budget is exhausted, return a normal result instructing the actor to proceed on its own,
 * rather than throwing (an error would look retryable to the model, which would hit the same
 * wall repeatedly).
 *
 * Use a discriminant rather than plain text because the caller (core's tool handler) decides
 * how to render the tool_result based on it (house rule: use error codes, not error text, for
 * control flow).
 */
export type WorkflowEscalateOutcome =
  | {
      kind: "answered";
      /** Answer from the main agent through `ResolveWorkflowQuestion`, passed through as the tool result. */
      answer: string;
      /** Globally unique id for this question and answer (for logs and human traceability; the model need not read it). */
      qid: string;
    }
  | {
      kind: "refused";
      /**
       * `budget_exhausted`: this ask has used all allowed escalations (a per-ask limit, like
       * the nudge budget).
       * `no_active_ask`: this session has no ask in flight, so there is nowhere to park the
       * question (should not happen, but must never hang).
       */
      reason: "budget_exhausted" | "no_active_ask";
      /** Model-facing text describing the current state and next step. */
      message: string;
    };

export interface WorkflowEscalatePort {
  /**
   * Escalate a blocking question and **block** until the main agent answers.
   *
   * Same rule as {@link WorkflowSubmitPort.respond}: resolve may take arbitrarily long, with
   * no timeout by design. "Decide on your own after timeout" would reintroduce the speculative
   * bypass this feature is meant to remove. The existing escape hatch is cancellation:
   * driver's `cancelAsk` rejects the parked escalation deferred as well, so run cancellation
   * and process death behave as they do today.
   *
   * Routing identity (run/actor/session/instance) is bound by the port closure and cannot be overridden by the model.
   */
  escalate(request: EscalateQuestionRequest): Promise<WorkflowEscalateOutcome>;
}
