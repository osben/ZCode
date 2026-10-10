/**
 * Policy table for model-side errors within workflows.
 *
 * The classifier (failure-classifier.ts) answers "should the main conversation retry automatically?";
 * this table answers "should the workflow stop and ask for human help?" The two tables deliberately
 * disagree on 3008/3009/3010 (concurrency limits), which is why this module exists: workflow
 * subagent and tool requests have an unbounded retry budget (`modelRetryBudget`). For those requests,
 * only **deterministic errors that require human intervention** should stop the run. Retry everything
 * else internally (including unknown business codes classified as non-retryable, TLS, and 5xx), with
 * stall notifications as the escape hatch.
 *
 * The runner (retry gate for the attempt loop) and bootstrap driver (maps rejects to stopRun / askFailed)
 * share **the same** function. A failure classified as retry by the runner never reaches the driver
 * as a stop; when a stop-classified failure reaches the driver, the policy table also returns stop
 * (same function, same input).
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
 * Policy table implementation. Inputs are the classifier result (code / reason / retryable, read-only)
 * and provider business code. Order matters: cancellation first (it is not an error); quota by **code**
 * before reason (1005 has reason invalid_request); everything else by reason / code; anything not in
 * the table is retry.
 */
export function resolveWorkflowModelFailurePolicy(
  failure: Pick<ClassifiedModelFailure, "code" | "reason" | "retryable">,
  providerCode: string | undefined,
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
): boolean {
  if (!isUnboundedRetryBudget(retryBudget)) return isRetryableFailure(failure);
  return resolveWorkflowModelFailurePolicy(failure, providerCode).decision === "retry";
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
  /** Reset time (epoch ms) for quota errors when the provider returned Retry-After. */
  resetAt?: number;
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
  const policy = resolveWorkflowModelFailurePolicy(
    {
      code: code as ClassifiedModelFailure["code"],
      reason: reason as ClassifiedModelFailure["reason"],
      retryable: context.retryable === true,
    },
    providerCode,
  );
  const retryAfterMs = context.retryAfterMs;
  const inspection: WorkflowModelFailureInspection = { policy, reason };
  if (providerCode !== undefined) inspection.providerCode = providerCode;
  const providerId = stringValue(context.providerId);
  if (providerId !== undefined) inspection.providerId = providerId;
  const modelId = stringValue(context.modelId);
  if (modelId !== undefined) inspection.modelId = modelId;
  if (message.length > 0) inspection.rawMessage = message;
  if (
    policy.decision === "stop" &&
    policy.kind === "quota" &&
    typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
  ) {
    inspection.resetAt = Date.now() + retryAfterMs;
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
