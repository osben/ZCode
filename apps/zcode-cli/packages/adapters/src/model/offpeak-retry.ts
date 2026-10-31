/* The off-peak queueing protocol applies only to requests that explicitly declare off-peak-queue.
   429/3105 waits do not consume the normal retry budget; 3102 missed-slot and 3106 run timeout
   both carry the expiry marker — the Host ends this task and does not reissue a ticket
   automatically. Other providers do not use these business-code semantics. */
import { isOffPeakTicketExpiredCode } from "@zcode/shared";
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
  // 3102/3106 are distinguished by the new contract; 3001 stays only for old-gateway compatibility — the new 3104 invalid ticket is not treated as expired.
  if (isOffPeakTicketExpiredCode(businessCode) || businessCode === "3001") {
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
