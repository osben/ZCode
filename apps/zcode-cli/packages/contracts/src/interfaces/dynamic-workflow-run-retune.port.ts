// Dynamic Workflow Run Port: adjust the concurrency limit of a running workflow.
// Defines the request, result, and capability boundary; re-exported from
// dynamic-workflow-run.port.ts for consumers through `@zcode/contracts`.

/**
 * Request for {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort.retuneConcurrency}.
 */
export interface DynamicWorkflowRunRetuneRequest {
  runId: string;
  /**
   * New concurrency limit. `null` = ceiling = remove this run's own limit (equivalent to
   * `max_concurrency: null` in `AmendWorkflow`). A supplied number is clamped to
   * `[1, ceiling]` by the port's implementation; the tool layer need not and must not clamp it
   * again and produce a second answer.
   */
  maxConcurrency: number | null;
}

/**
 * Structured reason why retune was refused. These imply **different next steps** for the
 * caller and must therefore remain distinguishable:
 *
 *   - `not_live`: this service does not have this run in flight (it never belonged to this
 *     process or has already settled), or it settled between the liveness check and this call.
 *     The caller falls back to an actual amendment (the existing `AmendWorkflow` path).
 *   - `unchanged`: the value matches the limit currently in effect. Nothing was written or
 *     stopped; `current` is that value, which lets the caller report "already at n."
 */
export type DynamicWorkflowRunRetuneRefusalReason = "not_live" | "unchanged";

/**
 * Structured result of retune. Failures use `reason` rather than throwing, for the same
 * reason as {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunAmendResult}:
 * both outcomes are expected business branches for the caller.
 *
 * `ceiling` and `previous` are required: the model response must say "up to n subagents run
 * concurrently," or "the limit is removed" when n equals the ceiling (the same rule used by
 * `CreateWorkflow`). The event log must also report "8 → 2"; the previous value cannot be
 * inferred from the new value alone. Only this side of the port knows both values; having the
 * caller recompute them would create a second ceiling implementation.
 */
export type DynamicWorkflowRunRetuneResult =
  | { ok: true; maxConcurrency: number; previous: number; ceiling: number }
  | {
      ok: false;
      reason: DynamicWorkflowRunRetuneRefusalReason;
      /** Limit currently in effect; always present for `unchanged`, and present for `not_live` only when still available. */
      current?: number;
    };
