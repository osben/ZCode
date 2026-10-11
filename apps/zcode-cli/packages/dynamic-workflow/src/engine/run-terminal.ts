// ============================================================
// Structured details for terminal run states
// ============================================================
// Split from types.ts (that file reached the 400-line lint limit): details for the `ProviderStop`
// error code and payload for the run-level stall-observation event. Vocabulary (RunStatus /
// RunStopReason / WorkflowErrorCode) remains in types.ts; this file contains only details, which
// are not part of a union, so moving them does not affect exhaustive consumers.

/**
 * Structured details for `ProviderStop`: notifications and GetWorkflowRun use them to choose
 * display text; never parse the message in reverse. `reason` is a contracts `ModelFailureReason`
 * value (`auth_failed` / `invalid_request` / `rate_limited` …), represented as string because the
 * pure package does not import contracts. `kind` is the policy-table key (auth / not configured /
 * model unavailable / invalid request / quota / other), used instead of reason to select display
 * text.
 */
export interface ProviderStopDetails {
  kind: "auth" | "not_configured" | "model_unavailable" | "invalid_request" | "quota" | "other";
  reason: string;
  providerId?: string;
  providerLabel?: string;
  modelId?: string;
  providerCode?: string;
  /** Subagent that triggered the stop (`refToString(instance)`) and its name / creation phase, if available. */
  subagent?: string;
  subagentName?: string;
  phase?: string;
  /** Provider's raw message, verbatim and bounded (truncated by the driver). */
  rawMessage?: string;
  /** For quota errors: provider-supplied reset time (epoch ms), present only when parseable. */
  resetAt?: number;
}

/**
 * Run-level stall: the driver observed no successful model request for `sinceMs` milliseconds,
 * with at least one retry scheduled in that time. This is a pure observation event; the engine only
 * calls `record()`, and core uses it to send one in-run notification. `reason` is the most common
 * retry reason in that interval (an open-string `ModelRetryReason` value), and `cap` is the current
 * cap for that provider bucket.
 */
export interface RunStallInfo {
  sinceMs: number;
  reason?: string;
  cap?: number;
}
