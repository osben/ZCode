/* Adapter-specific handling for the off-peak task queue protocol.
  Semantics apply only to requests whose Model Config explicitly declares the off-peak-queue protocol; business
  codes 3105/3102 may mean something else in other BigModel APIs, so do not add them to the global
  failure-provider-business-codes mapping.

   - 429 (including business code 3105) = queued response: wait once for min(Retry-After, 5min),
     then perform unlimited idempotent probes; the caller freezes the attempt budget (otherwise it
     is misclassified as an API failure after the default 11 attempts, D24 rule 2); abort propagates
     through sleep.
   - 400/3102 = unusable ticket (active ticket expired after 3h / ready ticket is invalid): fail
     immediately with a stable marker; Desktop recognizes it and retries with the same task_id
     before resuming (§4.6), rather than treating it as an ordinary failure.
   - D24 rule 1 (first-dispatch abandonment) is not implemented in the adapter: if the first dispatch
     is stuck at the gateway, the ready ticket's 5-minute TTL naturally triggers 3102 and requeues
     the resume. The wait is bounded by about TTL plus one clamped probe (≤ 10 minutes), meeting the
     intent with one fewer state (this simplification was written back into tech-design §4.3). */
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { isProviderBusinessError } from "./model-execution.js";

/**
 * ⚠ The same-named constants in desktop's @zcode/shared/src/off-peak-types.ts must have identical
 * values across packages (wire contract): providerId is injected through per-turn runtimeModel, and
 * the error marker is returned in the task's terminal error text. Changes must be synchronized on both sides.
 */
export const OFF_PEAK_TICKET_EXPIRED_MARKER = "off-peak-ticket-expired";

/** Clamp a single queued wait (D24 rule 2): min(Retry-After, 5min); probe conservatively after 60s when Retry-After is absent. */
export const OFF_PEAK_QUEUE_WAIT_CAP_MS = 5 * 60_000;
export const OFF_PEAK_QUEUE_WAIT_DEFAULT_MS = 60_000;

export type OffPeakFailureDecision =
  | { kind: "queued"; delayMs: number }
  | { kind: "ticketExpired" };

/**
 * Classify off-peak-specific failure semantics; always return null for providers outside the idle plan (no effect).
 * Pass the original error after unwrapRetryError so ProviderBusinessError codes remain available.
 */
export function resolveOffPeakFailureDecision(params: {
  offPeak: boolean;
  failure: ClassifiedModelFailure;
  error: unknown;
}): OffPeakFailureDecision | null {
  if (!params.offPeak) return null;
  const businessCode = isProviderBusinessError(params.error)
    ? params.error.providerCode
    : undefined;
  // The latest server contract uses 3102; keep 3001 for compatibility with old gateway responses during rolling deployment.
  if (businessCode === "3102" || businessCode === "3001") {
    return { kind: "ticketExpired" };
  }
  // The actual queue signal is HTTP 429 (3105 with Retry-After); a bare 429 without a business code also means queued.
  if (businessCode === "3105" || params.failure.statusCode === 429) {
    return {
      kind: "queued",
      delayMs: Math.min(
        params.failure.retryAfterMs ?? OFF_PEAK_QUEUE_WAIT_DEFAULT_MS,
        OFF_PEAK_QUEUE_WAIT_CAP_MS,
      ),
    };
  }
  return null;
}

export function offPeakTicketExpiredMessage(original: string): string {
  return `${OFF_PEAK_TICKET_EXPIRED_MARKER}: ${original}`;
}
