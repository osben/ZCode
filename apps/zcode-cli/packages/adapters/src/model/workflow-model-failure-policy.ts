/**
 * Policy table for model-side errors within workflows.
 *
 * The classifier (failure-classifier.ts) answers "should the main conversation retry automatically"; this table answers
 * "should the workflow stop and wait for a human". The two tables give opposite answers on 3008/3009/3010 (concurrency
 * limits), and that is exactly why this module exists: workflow subagents and tool-side requests hold an unbounded
 * retry budget (`modelRetryBudget`), so only **deterministic, human-required** errors are worth stopping the run; everything
 * else (TLS, 5xx, rate limits, network errors) retries in-budget with the stall notification as the escape hatch. The
 * exception is business codes the classifier does not recognize: once they appear **consecutively**
 * {@link WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE} times within one request, stop.
 *
 * The runner (the retry gate of the attempt loop) and the bootstrap driver (which folds rejects into stopRun / askFailed)
 * share **the same** function: a failure the runner rules retry never reaches the driver as a stop; a failure the runner
 * rules stop is always ruled stop by the policy table when it reaches the driver (same function, same input — the
 * consecutive count travels with the adapter error's `unrecognizedCodeStreak`).
 */

import { ModelErrorCode, ModelFailureReason } from "@zcode/contracts";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { isRetryableFailure } from "./failure-classifier.js";
import type { ModelRetryBudget } from "@zcode/contracts";
import { isUnboundedRetryBudget } from "./retry-budget.js";

/** Classification key for `ProviderStop`; the notification copy table selects text by this key, not reason. */
export type WorkflowProviderStopKind =
  | "auth"
  | "not_configured"
  | "model_unavailable"
  | "invalid_request"
  | "quota"
  | "other";

/**
 * Quota-related business codes (one row in the Stop set). Intentionally maintained **separately**
 * from TERMINAL_RATE_LIMIT_MAPPING in failure-provider-business-codes.ts: that table decides whether
 * the main conversation retries automatically; this table decides whether a workflow stops and waits
 * for a quota reset/top-up. The classifier labels 1005 as invalid_request, so this table must check
 * the code before the reason.
 */
export const WORKFLOW_QUOTA_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "1005",
  "1308",
  "1310",
  "1313",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "2056",
  "20097",
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
]);

/**
 * Cap on how many times an unrecognized business code (reason = unknown with a business code) may appear
 * **consecutively** within one request, counting the first occurrence.
 *
 * Root cause (2026-10-16 incident): the server deterministically returned 1113 for a batch of accounts; the
 * classifier did not know it, so the workflow's unbounded budget kept retrying and the run hung forever with only
 * stall notifications. An unrecognized code may be transient, so it does not stop on first sight; 10 consecutive
 * unrecognized codes within one request (about 6 minutes with backoff when it is the only failure) are treated as
 * deterministic and the run stops with kind `other` (resumable). What is counted is **consecutive** occurrence, not
 * attempts: any other failure in between (network error, 5xx, rate limit) resets the count — "9 network errors then
 * one unknown code" counts as 1 and must not stop (MR !3072 review).
 * Same order of magnitude as the main conversation's `DEFAULT_MAX_RETRIES = 10`.
 */
export const WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE = 10;

/** Whether this failure is a "business code the classifier does not recognize": reason = unknown with a provider business code. */
export function isUnrecognizedProviderCodeFailure(
  failure: Pick<ClassifiedModelFailure, "reason">,
  providerCode: string | undefined,
): boolean {
  return failure.reason === ModelFailureReason.Unknown && providerCode !== undefined;
}

/**
 * The runner updates the consecutive count after each failure: +1 if this failure is again an unrecognized business
 * code, otherwise reset to zero. The count lives only inside one request's attempt loop (success ends the loop); the
 * runner passes it to the policy table and carries it to the driver on the adapter error.
 */
export function nextUnrecognizedCodeStreak(
  previous: number,
  failure: Pick<ClassifiedModelFailure, "reason">,
  providerCode: string | undefined,
): number {
  return isUnrecognizedProviderCodeFailure(failure, providerCode) ? previous + 1 : 0;
}

/** ModelErrorCode values for "provider misconfigured / invalid selection" (reason is not always provider_not_configured). */
const NOT_CONFIGURED_ERROR_CODES: ReadonlySet<string> = new Set([
  ModelErrorCode.ProviderNotFound,
  ModelErrorCode.ProviderNotConfigured,
  ModelErrorCode.ModelConfigMissing,
  ModelErrorCode.InvalidModelSelection,
  ModelErrorCode.ModelRequestAuthMissing,
]);

export type WorkflowModelFailurePolicy =
  | { decision: "retry" }
  | { decision: "stop"; kind: WorkflowProviderStopKind }
  /** Reached only after core compression failed: the node fails with `ContextLimit`, which a script can catch; otherwise it is errored. */
  | { decision: "context_exceeded" }
  | { decision: "cancelled" };

/**
 * The policy table itself. Inputs are the classifier's result (reads only code / reason / retryable), the provider
 * business code, and how many times the unrecognized business code has appeared consecutively within this request,
 * counting this one (default 1; only unrecognized business codes read it, see
 * {@link nextUnrecognizedCodeStreak}).
 * Order matters: cancellation first (it is not an error); quota is decided by **code** before reason (1005's reason
 * is invalid_request); the rest by reason / code; everything outside the table = retry.
 */
export function resolveWorkflowModelFailurePolicy(
  failure: Pick<ClassifiedModelFailure, "code" | "reason" | "retryable">,
  providerCode: string | undefined,
  unrecognizedCodeStreak = 1,
): WorkflowModelFailurePolicy {
  if (failure.reason === ModelFailureReason.Cancelled) return { decision: "cancelled" };
  if (providerCode !== undefined && WORKFLOW_QUOTA_PROVIDER_CODES.has(providerCode)) {
    return { decision: "stop", kind: "quota" };
  }
  if (failure.reason === ModelFailureReason.AuthFailed) return { decision: "stop", kind: "auth" };
  if (
    failure.reason === ModelFailureReason.ProviderNotConfigured ||
    NOT_CONFIGURED_ERROR_CODES.has(failure.code)
  ) {
    return { decision: "stop", kind: "not_configured" };
  }
  if (failure.code === ModelErrorCode.ModelNotFound) {
    return { decision: "stop", kind: "model_unavailable" };
  }
  if (failure.reason === ModelFailureReason.ContextExceeded)
    return { decision: "context_exceeded" };
  // "Invalid request" means only a provider rejection of the **request** (3001, HTTP 400/422).
  // `invalid_model_response` is also classified as invalid_request, but it is a **response** parsing
  // failure that may succeed on retry, so classify it as retry.
  if (
    failure.reason === ModelFailureReason.InvalidRequest &&
    failure.code !== ModelErrorCode.InvalidModelResponse
  ) {
    return { decision: "stop", kind: "invalid_request" };
  }
  if (
    isUnrecognizedProviderCodeFailure(failure, providerCode) &&
    unrecognizedCodeStreak >= WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE
  ) {
    return { decision: "stop", kind: "other" };
  }
  return { decision: "retry" };
}

/**
 * Replacement point for the runner retry gate: bounded budgets continue to use the classifier's
 * `retryable` (main conversation behavior remains unchanged); unbounded budgets (workflow traffic)
 * use this policy table — `retry` retries, while `stop` / `context_exceeded` do not. Callers handle
 * cancellation separately beforehand (both runners already do so).
 */
export function retryAllowedByFailurePolicy(
  failure: ClassifiedModelFailure,
  retryBudget: ModelRetryBudget | undefined,
  providerCode: string | undefined,
  unrecognizedCodeStreak?: number,
): boolean {
  if (!isUnboundedRetryBudget(retryBudget)) return isRetryableFailure(failure);
  return (
    resolveWorkflowModelFailurePolicy(failure, providerCode, unrecognizedCodeStreak).decision ===
    "retry"
  );
}

/** Facts read from an adapter error on the driver side: policy decision and fields needed to construct `ProviderStopDetails`. */
export interface WorkflowModelFailureInspection {
  policy: WorkflowModelFailurePolicy;
  /** Value from contracts `ModelFailureReason`. */
  reason: string;
  providerCode?: string;
  providerId?: string;
  modelId?: string;
  /** Adapter error message (for mapped business codes, this is the original provider text). */
  rawMessage?: string;
  /**
   * Reset time for quota stops (epoch ms): Retry-After wins, otherwise parsed from the provider's raw text ({@link parseQuotaResetAt}).
   * Both sources must fall inside the {@link isPlausibleQuotaResetAt} window.
   */
  resetAt?: number;
}

/** Plausible window for a quota reset time: one day in the past (clock skew) to 35 days ahead (weekly/monthly quotas). Values outside the window are untrusted. */
const QUOTA_RESET_PAST_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const QUOTA_RESET_MAX_AHEAD_MS = 35 * 24 * 60 * 60 * 1000;

/**
 * Whether the reset time falls inside the plausible window. One shared criterion for both Retry-After and raw-text
 * sources: an abnormal or malicious header (e.g. seconds spanning years) must not write an absurd time into the stop
 * record any more easily than the raw text could (MR !3072 review SG-01).
 */
export function isPlausibleQuotaResetAt(at: number, now: number): boolean {
  return (
    Number.isFinite(at) &&
    at >= now - QUOTA_RESET_PAST_TOLERANCE_MS &&
    at <= now + QUOTA_RESET_MAX_AHEAD_MS
  );
}
/** Reset time in the raw text, e.g. "您的限额将在 2026-10-15 18:50:42 重置" (codes 1308 / 1310 / 1316 etc.). */
const QUOTA_RESET_TIME_PATTERN = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/u;
/** Read the time only when the raw text is actually about a "reset" (重置), so other timestamps are not mistaken for the reset time. */
const QUOTA_RESET_WORD_PATTERN = /重置|reset/iu;
/**
 * The copy comes from the bigmodel server; its times carry no timezone and are interpreted as Beijing time. Evidence
 * (2026-10-15 production sample):
 * `[1308][…您的限额将在 2026-10-15 18:50:42 重置。][20261015175300…]` — the request id's time prefix in the same
 * raw text is 17:53:00, matching the user's Beijing time, and the reset time falls within the following hour.
 */
const QUOTA_RESET_TIME_UTC_OFFSET = "+08:00";

/**
 * Read the reset time (epoch ms) from a quota error's provider raw text. Returns undefined when it cannot be parsed
 * or falls outside the plausible window — better left unset than letting a workflow auto-resume at an absurd time.
 */
export function parseQuotaResetAt(message: string, now: number): number | undefined {
  if (!QUOTA_RESET_WORD_PATTERN.test(message)) return undefined;
  const match = QUOTA_RESET_TIME_PATTERN.exec(message);
  if (match === null) return undefined;
  const at = Date.parse(`${match[1]}T${match[2]}${QUOTA_RESET_TIME_UTC_OFFSET}`);
  return isPlausibleQuotaResetAt(at, now) ? at : undefined;
}

/**
 * Read an adapter error by **shape** (`AiSdkModelAdapterError`: `name` + `context.reason` …), either
 * directly or one `cause` deep. bootstrap and adapters may have separate class definitions across
 * the dist boundary, but the shape remains stable. Return undefined for non-model errors (the driver
 * continues to classify them as DriverError).
 */
export function inspectWorkflowModelFailure(
  error: unknown,
): WorkflowModelFailureInspection | undefined {
  const direct = readAdapterError(error);
  const found =
    direct ?? readAdapterError((error as { cause?: unknown } | undefined)?.cause ?? undefined);
  if (found === undefined) return undefined;
  const { context, code, message } = found;
  const reason = stringValue(context.reason);
  if (reason === undefined) return undefined;
  const providerCode = codeValue(context.providerCode);
  // How many consecutive unrecognized business codes had appeared when the runner gave up (the runner writes it into
  // context via toAdapterError): the same number the runner's gate reads.
  const unrecognizedCodeStreak =
    typeof context.unrecognizedCodeStreak === "number" ? context.unrecognizedCodeStreak : undefined;
  const policy = resolveWorkflowModelFailurePolicy(
    {
      code: code as ClassifiedModelFailure["code"],
      reason: reason as ClassifiedModelFailure["reason"],
      retryable: context.retryable === true,
    },
    providerCode,
    unrecognizedCodeStreak,
  );
  const retryAfterMs = context.retryAfterMs;
  const inspection: WorkflowModelFailureInspection = { policy, reason };
  if (providerCode !== undefined) inspection.providerCode = providerCode;
  const providerId = stringValue(context.providerId);
  if (providerId !== undefined) inspection.providerId = providerId;
  const modelId = stringValue(context.modelId);
  if (modelId !== undefined) inspection.modelId = modelId;
  if (message.length > 0) inspection.rawMessage = message;
  if (policy.decision === "stop" && policy.kind === "quota") {
    // Retry-After is a relative duration from the provider and the most accurate; when absent, or when the computed
    // time falls outside the plausible window, fall back to the absolute time in the raw text. The reset time is the
    // sole basis for auto-resume (dynamic-workflow-quota-resume.ts in bootstrap); with neither source, do not resume,
    // just notify.
    const now = Date.now();
    const fromHeader =
      typeof retryAfterMs === "number" &&
      retryAfterMs > 0 &&
      isPlausibleQuotaResetAt(now + retryAfterMs, now)
        ? now + retryAfterMs
        : undefined;
    const resetAt = fromHeader ?? parseQuotaResetAt(message, now);
    if (resetAt !== undefined) inspection.resetAt = resetAt;
  }
  return inspection;
}

function readAdapterError(
  error: unknown,
): { context: Record<string, unknown>; code: string; message: string } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    context?: unknown;
    message?: unknown;
  };
  if (candidate.name !== "AiSdkModelAdapterError") return undefined;
  const context =
    typeof candidate.context === "object" && candidate.context !== null
      ? (candidate.context as Record<string, unknown>)
      : {};
  return {
    context,
    code: typeof candidate.code === "string" ? candidate.code : "",
    message: typeof candidate.message === "string" ? candidate.message : "",
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Provider business codes may be numbers (as preserved from the response body) or strings; normalize them to string keys. */
function codeValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return stringValue(value);
}
