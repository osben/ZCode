import type {
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "@zcode/contracts";

/**
 * Admission for one attempt.
 *
 * Before **sending** each attempt, the runner calls `admitAttempt` and sends the request only after
 * receiving a ticket. `release` the ticket when the attempt ends (success, failure, throw, or early
 * consumer cancellation of the stream). No ticket is held during backoff, so the process-level cap
 * limits the number of requests actually in flight at the provider. The ticket also collects status
 * events for the attempt: `publishModelStatus` sends them to it (see `statusPublishOptions`) so the
 * governor can determine the result. `release` is an idempotent fallback.
 *
 * Return a no-op implementation when the request has no `modelRequestAdmission`; callers do not need
 * a separate branch and runner behavior remains unchanged.
 */
export interface AttemptAdmission {
  /** Admission ticket; absent when the request has no admission port (publish is not forwarded then). */
  readonly ticket?: ModelRequestAdmissionTicket;
  /** Release the slot; idempotent (called from both finally and before backoff sleep). */
  release(): void;
}

const NO_ADMISSION: AttemptAdmission = { release() {} };

/**
 * Wait for admission. Try the synchronous fast path `tryAcquire` first; queue through `acquire` only
 * if it misses, and invoke `onQueued` / `onAdmitted` at the two transitions (the runner emits
 * `model_request_queued` / `model_request_admitted` from these). A port without a fast path cannot
 * distinguish "queued" from "admitted immediately", so it does not invoke the callbacks. Reject
 * when `signal` is aborted, using `signal.reason` (the same shape as the abort error from `sleep`),
 * which the caller classifies as cancelled.
 */
export async function admitAttempt(input: {
  admission?: ModelRequestAdmission;
  model: ModelRequestTarget;
  signal?: AbortSignal;
  onQueued?: () => Promise<void>;
  onAdmitted?: (queuedMs: number) => Promise<void>;
}): Promise<AttemptAdmission> {
  if (input.admission === undefined) return NO_ADMISSION;
  const hasFastPath = typeof input.admission.tryAcquire === "function";
  let ticket = hasFastPath ? input.admission.tryAcquire!({ model: input.model }) : undefined;
  if (ticket === undefined) {
    const queuedAt = Date.now();
    if (hasFastPath) await input.onQueued?.();
    ticket = await input.admission.acquire({
      model: input.model,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (hasFastPath) await input.onAdmitted?.(Date.now() - queuedAt);
  }
  let released = false;
  return {
    ticket,
    release() {
      if (released) return;
      released = true;
      ticket.release();
    },
  };
}
