// ============================================================
// Dynamic Workflow Run Port: retune the concurrency cap of a live run in place.
// ============================================================
// docs/dynamic-workflow/concurrency.md, “Retuning a live run”. Split for the same reason as the roster
// view (dynamic-workflow-run-roster.port.ts): dynamic-workflow-run.port.ts reached oxlint's 400-line
// limit, and these three types form a cohesive group. The public surface is unchanged: that module
// re-exports them, so `@zcode/contracts` import paths remain the same.

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
 * `defaultConcurrency` and `previous` are required context: the model-facing reply must say “up to n
 * subagents at once,” and label n as “(default)” when it equals the default concurrency (same rule as
 * the `CreateWorkflow` reply). The event log must show “8 → 2,” which cannot be derived from the new
 * value alone. Only the port knows both values; making callers recompute them would create a second
 * default-concurrency implementation.
 */
export type DynamicWorkflowRunRetuneResult =
  | { ok: true; maxConcurrency: number; previous: number; defaultConcurrency: number }
  | {
      ok: false;
      reason: DynamicWorkflowRunRetuneRefusalReason;
      /** Limit currently in effect; always present for `unchanged`, and present for `not_live` only when still available. */
      current?: number;
    };
