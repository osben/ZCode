import { ModelRetryBudget } from "@zcode/contracts";

/**
 * Determine the retry budget tier.
 *
 * "Unbounded" **only** relaxes when to give up on transient failures: the runner attempt loop and
 * the post-failure "can retry?" gate. The backoff curve (2s→60s, jitter, Retry-After precedence),
 * `isRetryableFailure` classification, no-retry behavior after `emittedRetryBoundaryEvent`, empty
 * completion retries, and compact path are all unchanged.
 */

/** Sentinel for "unbounded" in the status event's `maxAttempts` (Infinity is not serializable; 0 is not a valid count). */
export const UNBOUNDED_RETRY_MAX_ATTEMPTS = 0;

export function isUnboundedRetryBudget(budget: ModelRetryBudget | undefined): boolean {
  return budget === ModelRetryBudget.Unbounded;
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
