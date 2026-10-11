import { ModelRetryBudget } from "@zcode/contracts";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";

/**
 * Determine the retry budget tier.
 *
 * "Unbounded" **only** relaxes when to give up on transient failures: the runner attempt loop and
 * the post-failure "can retry?" gate. The backoff curve (2s→60s, jitter, Retry-After precedence),
 * `isRetryableFailure` classification, no-retry behavior after `emittedRetryBoundaryEvent`, empty
 * completion retries, and compact path are all unchanged.
 *
 * A "single attempt" only reduces this request's `maxAttempts` to 1: both runner gates and the empty-completion retry
 * read the same `retry.maxAttempts`, so transient failures are thrown immediately; additional auth-refresh or signature-fix attempts do not consume this budget, preserving their semantics.
 */

/** Sentinel for "unbounded" in the status event's `maxAttempts` (Infinity is not serializable; 0 is not a valid count). */
export const UNBOUNDED_RETRY_MAX_ATTEMPTS = 0;
/** Total attempts allowed for this request under a `single-attempt` budget, including the initial attempt. */
export const SINGLE_ATTEMPT_MAX_ATTEMPTS = 1;

export function isUnboundedRetryBudget(budget: ModelRetryBudget | undefined): boolean {
  return budget === ModelRetryBudget.Unbounded;
}

export function isSingleAttemptRetryBudget(budget: ModelRetryBudget | undefined): boolean {
  return budget === ModelRetryBudget.SingleAttempt;
}

/**
 * Resolve the retry options that apply to this request for its budget tier. Runner entry points use this function
 * so the attempt loop, failure gate, empty-completion handling, and status events do not each special-case the tier.
 */
export function resolveRetryOptionsForBudget(
  retry: ResolvedAiSdkModelRetryOptions,
  budget: ModelRetryBudget | undefined,
): ResolvedAiSdkModelRetryOptions {
  return isSingleAttemptRetryBudget(budget)
    ? { ...retry, maxAttempts: SINGLE_ATTEMPT_MAX_ATTEMPTS }
    : retry;
}

/** Whether another attempt is allowed after failure (equivalent to the existing `retryBudgetAttempt < maxAttempts`; always true when unbounded). */
export function retryBudgetAllows(
  budget: ModelRetryBudget | undefined,
  retryBudgetAttempt: number,
  maxAttempts: number,
): boolean {
  return isUnboundedRetryBudget(budget) || retryBudgetAttempt < maxAttempts;
}

/** Continue condition for the attempt loop (equivalent to the existing `attempt <= loopMaxAttempts`; always true when unbounded). */
export function retryAttemptLoopContinues(
  budget: ModelRetryBudget | undefined,
  attempt: number,
  loopMaxAttempts: number,
): boolean {
  return isUnboundedRetryBudget(budget) || attempt <= loopMaxAttempts;
}

/** `maxAttempts` value written to status events / logs; the unbounded sentinel is 0. */
export function retryBudgetMaxAttempts(
  budget: ModelRetryBudget | undefined,
  maxAttempts: number,
): number {
  return isUnboundedRetryBudget(budget) ? UNBOUNDED_RETRY_MAX_ATTEMPTS : maxAttempts;
}
