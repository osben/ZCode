// ============================================================
// Workflow Submit Port - actor terminal-result verdict boundary
// ============================================================

import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

/**
 * One validator violation, designed to go directly into a repair tool_result: one per line,
 * with the JSON path, expected value, and actual value (got).
 *
 * Matches the Violation shape from dynamic-workflow synthesis. The driver maps the engine's
 * Violation to this port unchanged; contracts does not depend on dynamic-workflow.
 */
export interface SubmitViolation {
  /** JSON path where the violation occurred, such as `$`, `$.foo`, or `$.items[0]`. */
  path: string;
  /** Short description of the expected shape/value. */
  expected: string;
  /** Short description of the actual value. */
  got: string;
}

export interface SubmitResultRequest {
  /** Tool call id in the actor child session that initiated submit_result. */
  toolCallId: ToolCallId | string;
  /** Raw structured result submitted by the model (arbitrary JSON, not validated by this port). */
  result: unknown;
  trace: TraceContext;
}

/** Engine accepted this submission: the actor turn should end after returning the result. */
export interface SubmitAccepted {
  accept: true;
}

/** Engine rejected this submission: return the violation list so the model can repair and retry in the same session. */
export interface SubmitRejected {
  accept: false;
  violations: readonly SubmitViolation[];
}

export type SubmitVerdict = SubmitAccepted | SubmitRejected;

export interface WorkflowSubmitPort {
  /**
   * Submit the actor's structured terminal result and wait for the engine's decision.
   *
   * Unlike CoordinatorResponsePort, this **blocks** until the engine finishes validation: it
   * may run multiple out-of-band repair/budget-check rounds, so resolution may take
   * arbitrarily long. Cancellation is not represented by this port; abort the tool call, and
   * the driver converts cancellation of the out-of-band ask into a turn abort.
   *
   * Routing identity (instance/actor/session) is bound by the port closure and cannot be overridden by the model.
   */
  respond(request: SubmitResultRequest): Promise<SubmitVerdict>;
}
