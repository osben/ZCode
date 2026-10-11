// ============================================================
// Workflow concurrency governor (process-level, bucketed by provider key, admission for **each model request**).
// ============================================================
// All runs and the main agent in one CLI process share a provider quota, so the governor is **process-level**: one bucket per `${providerId}/${modelId}`,
// with a pure AIMD state machine (`ConcurrencyController`, @zcode/dynamic-workflow) and an admission queue that rotates across runs.
//
// Admission is **per model-request attempt**: the runner calls `acquire` before each attempt and `release` when it ends;
// backoff sleep does not hold a slot. The ticket collects status events for that attempt: the runner sends its
// `ModelNetworkStatus` events to the ticket, and the governor reads the result from it. Do **not** also use the adapter-level `addStatusSink`—
// the same event must not be fed once through the ticket and again through the adapter sink.
//
// This is the governor's **only** code that touches clocks and timers: the controller receives `now`; cooldown expiry must wake waiters,
// so use setTimeout (injectable and unref'd).

import type {
  ModelNetworkStatusEvent,
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "@zcode/contracts";
import {
  ConcurrencyController,
  type ConcurrencyChange,
  type ConcurrencyControllerSnapshot,
  type ConcurrencyThrottleReason,
} from "@zcode/dynamic-workflow";
import {
  resolveWorkflowDefaultConcurrency,
  WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR,
} from "./workflow-default-concurrency.js";

/** Provider key: the most specific quota key. */
export function workflowConcurrencyKey(model: ModelRequestTarget): string {
  return `${String(model.providerId)}/${String(model.modelId)}`;
}

/**
 * Narrow port exposed to the driver (not the full governor).
 *
 * - `tryAdmit`: synchronous fast path—grant a ticket only when the gate is open **and nobody is queued**; otherwise return undefined so the caller uses
 *   `admit` and reports "waiting for a slot." Skipping this path when waiters exist is a fairness rule; otherwise a request-heavy run could use
 *   the fast path to jump ahead of other runs.
 * - `admit`: queue (rotating across runs) until `inFlight < cap` and Retry-After cooldown has expired; aborting `signal` removes the request
 *   from the queue and rejects it with `signal.reason`.
 * - `subscribe`: cap changes for any key touched by this run. Fan out only to runs that **currently have an in-flight or queued request** on that key
 *   (decision 8).
 * - `setRunBound` / `clearRunBound`: this run's own concurrency bound (registered at launch, overwritten on each retune, cleared when the launch
 *   settles). It raises the growth limit of the keys this run **has used**: `max(2D, the largest bound registered by those runs)`
 *   (docs/dynamic-workflow/concurrency.md "The governor")—only if the user tunes a run to 40 can the bucket's cap climb
 *   to 40; otherwise most of the 40 subagents would sit in "waiting for a slot."
 */
export interface WorkflowConcurrencyPort {
  tryAdmit(runId: string, key: string): ModelRequestAdmissionTicket | undefined;
  admit(runId: string, key: string, signal: AbortSignal): Promise<ModelRequestAdmissionTicket>;
  subscribe(runId: string, listener: (change: ConcurrencyChange) => void): () => void;
  setRunBound(runId: string, bound: number): void;
  clearRunBound(runId: string): void;
}

interface WorkflowConcurrencyGovernor extends WorkflowConcurrencyPort {
  /**
   * Admission for the main agent: acquire immediately—no queue or cooldown check—but **count it in inFlight**
   * and feed its signals (its provider requests are visible too). Workflow traffic must never block the main agent's turn.
   */
  observer(): ModelRequestAdmission;
  /** Read-only controller snapshot; undefined if there is no bucket for this key. */
  snapshot(key: string): ConcurrencyControllerSnapshot | undefined;
}

interface WorkflowConcurrencyGovernorOptions {
  /** Default concurrency D: initial value when a bucket is created and the idle reset point; auto-grows to `2 × D`. Computed once at process startup. */
  defaultConcurrency: number;
  /** Clock (injectable). */
  now?: () => number;
  /** Timer (injectable): wake waiters when cooldown expires. Returns a cancel function. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** Map rate-limit retry reasons to the controller's throttled signal. */
const THROTTLE_REASONS: ReadonlySet<string> = new Set<ConcurrencyThrottleReason>([
  "rate_limited",
  "provider_overloaded",
  "offpeak_queued",
]);
/** Retry reasons that are not provider failures: neither reduce cap nor clear the streak; only end the attempt. */
const NON_FAILURE_RETRY_REASONS: ReadonlySet<string> = new Set([
  "reasoning_signature_repair",
  "auth_refresh",
]);

interface Waiter {
  runId: string;
  resolve: (ticket: ModelRequestAdmissionTicket) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

interface Bucket {
  readonly key: string;
  readonly controller: ConcurrencyController;
  /** Number of admitted but unsettled requests per run (fanout sends cap changes only to runs with in-flight or queued requests). */
  readonly inFlightByRun: Map<string, number>;
  /** Waiters queued by run (rotate across runs so a large fan-out cannot starve a later small run). */
  readonly queues: Map<string, Waiter[]>;
  /** Rotation cursor: the last run granted a slot; the next search starts after it. */
  lastGrantedRun?: string;
  /**
   * Runs that have requested admission on this key (except the observer). The growth limit considers only bounds they registered:
   * a large run on a different model must not raise this key. A run is removed from this set when it clears its bound.
   */
  readonly runs: Set<string>;
  cancelCooldownWake?: () => void;
}

/** Run identity for the observer (main agent): never queued or subscribed, and treated as "not a run" only during fanout filtering. */
const OBSERVER_RUN_ID = "\0observer";

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // Do not let a cooldown timer keep the process alive; when runs finish and the process exits, it should not hold up shutdown.
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

export function createWorkflowConcurrencyGovernor(
  options: WorkflowConcurrencyGovernorOptions,
): WorkflowConcurrencyGovernor {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const buckets = new Map<string, Bucket>();
  /** Run-level subscription (not per key); fanout filters it by each bucket's engaged set. */
  const listeners = new Map<string, Set<(change: ConcurrencyChange) => void>>();
  const baseGrowthLimit = WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR * options.defaultConcurrency;
  /** Own bounds registered by in-flight runs (setRunBound / clearRunBound). */
  const runBounds = new Map<string, number>();

  const bucketFor = (key: string): Bucket => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      // Create buckets lazily with the default concurrency as the initial value; runs starting/ending do not reset them (only five idle minutes do, decisions 19/20).
      bucket = {
        key,
        controller: new ConcurrencyController(key, options.defaultConcurrency, baseGrowthLimit),
        inFlightByRun: new Map(),
        queues: new Map(),
        runs: new Set(),
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const waiterCount = (bucket: Bucket): number => {
    let total = 0;
    for (const queue of bucket.queues.values()) total += queue.length;
    return total;
  };

  /**
   * Fan out only to runs that currently have an in-flight or queued request on this key (decision 8); `alsoTo` adds another set of
   * recipients (bound-driven changes must also reach runs registered on this key; see refreshGrowthLimit).
   */
  const fanOut = (
    bucket: Bucket,
    changes: ConcurrencyChange[],
    alsoTo?: ReadonlySet<string>,
  ): void => {
    if (changes.length === 0) return;
    for (const [runId, set] of listeners) {
      const engaged =
        (bucket.inFlightByRun.get(runId) ?? 0) > 0 ||
        (bucket.queues.get(runId)?.length ?? 0) > 0 ||
        alsoTo?.has(runId) === true;
      if (!engaged) continue;
      for (const change of changes) {
        for (const listener of set) listener(change);
      }
    }
  };

  /**
   * Recompute a bucket's growth limit: `max(2D, the largest bound registered by runs that used it)`, and at the same moment try to **seed** up to that
   * largest bound (docs/dynamic-workflow/concurrency.md "Seeding"): if the user tunes a run to 32, the cap becomes 32 on the spot
   * rather than climbing one step every four successes. When the bound drops below the cap, the controller lowers the cap at once (`limit_lowered`);
   * if seeding was rejected within the last five minutes, the controller refuses it (`seeded` is not emitted) and the cap climbs as usual.
   *
   * Both kinds of changes originate from a run's bound rather than a request, so fanout must reach not only currently engaged runs but also
   * every run registered on this key—at the moment of a retune, the newly raised run likely has no requests in flight.
   */
  const refreshGrowthLimit = (bucket: Bucket): void => {
    let largestBound: number | undefined;
    for (const runId of bucket.runs) {
      const bound = runBounds.get(runId);
      if (bound !== undefined && (largestBound === undefined || bound > largestBound)) {
        largestBound = bound;
      }
    }
    const limit = Math.max(baseGrowthLimit, largestBound ?? 0);
    const changes =
      limit === bucket.controller.snapshot().growthLimit
        ? []
        : bucket.controller.setGrowthLimit(now(), limit);
    if (largestBound !== undefined) changes.push(...bucket.controller.seed(now(), largestBound));
    fanOut(bucket, changes, bucket.runs);
  };

  /** A run's first admission request on this key: record it so its registered bound counts toward this bucket from then on. */
  const noteRunUsed = (bucket: Bucket, runId: string): void => {
    if (bucket.runs.has(runId)) return;
    bucket.runs.add(runId);
    if (runBounds.has(runId)) refreshGrowthLimit(bucket);
  };

  const bumpInFlight = (bucket: Bucket, runId: string, delta: number): void => {
    const next = (bucket.inFlightByRun.get(runId) ?? 0) + delta;
    if (next <= 0) bucket.inFlightByRun.delete(runId);
    else bucket.inFlightByRun.set(runId, next);
  };

  /**
   * Ticket for one admitted attempt; event mapping stays consistent. Settle on any terminal mapping (idempotently); if `release()`
   * sees no terminal event, treat it as `ended`. Publish / release after settlement are no-ops because the runner may still send
   * a fallback event in rare paths after the attempt has ended.
   */
  const mintTicket = (bucket: Bucket, runId: string, epoch: number): ModelRequestAdmissionTicket => {
    let settled = false;
    const settle = (signal: (at: number) => ConcurrencyChange[]): void => {
      if (settled) return;
      settled = true;
      const changes = signal(now());
      // Fan out before decrementing in-flight: the request that caused this change belongs to this run, which is still engaged now.
      // Otherwise a halving caused by a run's only in-flight request could miss that run because it is "no longer in flight."
      fanOut(bucket, changes);
      bumpInFlight(bucket, runId, -1);
      // Settlement freed a slot (or changed the cap), so queued requests may now be admitted.
      drain(bucket);
    };
    return {
      publish(event: ModelNetworkStatusEvent) {
        if (settled) return;
        switch (event.type) {
          case "model_request_started":
            // Already counted in inFlight at admission; no new information here.
            return;
          case "model_request_completed":
            settle((at) => bucket.controller.succeeded(at, epoch));
            return;
          case "model_retry_scheduled": {
            const reason: string = event.reason;
            if (NON_FAILURE_RETRY_REASONS.has(reason)) {
              settle((at) => bucket.controller.ended(at));
              return;
            }
            if (THROTTLE_REASONS.has(reason)) {
              settle((at) =>
                bucket.controller.throttled(
                  at,
                  epoch,
                  reason as ConcurrencyThrottleReason,
                  event.retryAfterMs,
                ),
              );
              return;
            }
            settle((at) => bucket.controller.failedTransient(at));
            return;
          }
          case "model_request_failed":
            // A retryable:true failure is followed by retry_scheduled; that event carries the signal.
            if (event.retryable) return;
            // Non-retryable throttling:
            // a main conversation / tool-side request can hit a terminal 429 such as 3008, which is still a literal concurrency signal.
            // Treating it only as "chain ended" would mean the cap was never reduced. Quota codes also use this path: halving one extra time is harmless because the run stops immediately.
            if (event.reason === "rate_limited") {
              settle((at) =>
                bucket.controller.throttled(at, epoch, "rate_limited", event.retryAfterMs),
              );
              return;
            }
            settle((at) => bucket.controller.ended(at));
            return;
          default:
            return;
        }
      },
      release() {
        settle((at) => bucket.controller.ended(at));
      },
    };
  };

  /** Grant a request: call `observe` first (admission is also a "signal"), then call `admitted` to get the epoch. */
  const grant = (bucket: Bucket, runId: string): ModelRequestAdmissionTicket => {
    fanOut(bucket, bucket.controller.observe(now()));
    const epoch = bucket.controller.admitted(now());
    bumpInFlight(bucket, runId, 1);
    bucket.lastGrantedRun = runId;
    return mintTicket(bucket, runId, epoch);
  };

  /** Select the next run with waiters using round-robin order. */
  const nextRunWithWaiters = (bucket: Bucket): string | undefined => {
    const runs = [...bucket.queues.keys()].filter((runId) => (bucket.queues.get(runId)?.length ?? 0) > 0);
    if (runs.length === 0) return undefined;
    const last = bucket.lastGrantedRun;
    const lastIndex = last === undefined ? -1 : runs.indexOf(last);
    return runs[(lastIndex + 1) % runs.length];
  };

  const armCooldownWake = (bucket: Bucket): void => {
    bucket.cancelCooldownWake?.();
    bucket.cancelCooldownWake = undefined;
    if (waiterCount(bucket) === 0) return;
    const until = bucket.controller.snapshot().cooldownUntil;
    if (until === undefined) return;
    const delay = Math.max(0, until - now());
    bucket.cancelCooldownWake = schedule(() => {
      bucket.cancelCooldownWake = undefined;
      drain(bucket);
    }, delay);
  };

  /** Admit as many waiters as possible (gate: inFlight < cap and no cooldown), resolve waiters, and schedule a cooldown timer if needed. */
  const drain = (bucket: Bucket): void => {
    fanOut(bucket, bucket.controller.observe(now()));
    for (;;) {
      fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
      if (!bucket.controller.canAdmit(now())) break;
      const runId = nextRunWithWaiters(bucket);
      if (runId === undefined) break;
      const queue = bucket.queues.get(runId)!;
      const waiter = queue.shift()!;
      if (queue.length === 0) bucket.queues.delete(runId);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(grant(bucket, runId));
    }
    fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
    armCooldownWake(bucket);
  };

  const tryAdmit: WorkflowConcurrencyPort["tryAdmit"] = (runId, key) => {
    const bucket = bucketFor(key);
    noteRunUsed(bucket, runId);
    fanOut(bucket, bucket.controller.observe(now()));
    if (waiterCount(bucket) > 0 || !bucket.controller.canAdmit(now())) return undefined;
    return grant(bucket, runId);
  };

  const admit: WorkflowConcurrencyPort["admit"] = (runId, key, signal) => {
    const bucket = bucketFor(key);
    if (signal.aborted) return Promise.reject(abortedError(signal));
    noteRunUsed(bucket, runId);
    return new Promise<ModelRequestAdmissionTicket>((resolve, reject) => {
      const waiter: Waiter = { runId, resolve, reject, signal, onAbort: () => {} };
      waiter.onAbort = () => {
        const queue = bucket.queues.get(runId);
        if (queue !== undefined) {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          if (queue.length === 0) bucket.queues.delete(runId);
        }
        reject(abortedError(signal));
        fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
        armCooldownWake(bucket);
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      const queue = bucket.queues.get(runId) ?? [];
      queue.push(waiter);
      bucket.queues.set(runId, queue);
      drain(bucket);
    });
  };

  const subscribe: WorkflowConcurrencyPort["subscribe"] = (runId, listener) => {
    const set = listeners.get(runId) ?? new Set();
    set.add(listener);
    listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(runId);
    };
  };

  const setRunBound: WorkflowConcurrencyPort["setRunBound"] = (runId, bound) => {
    runBounds.set(runId, bound);
    for (const bucket of buckets.values()) {
      if (bucket.runs.has(runId)) refreshGrowthLimit(bucket);
    }
  };

  const clearRunBound: WorkflowConcurrencyPort["clearRunBound"] = (runId) => {
    runBounds.delete(runId);
    for (const bucket of buckets.values()) {
      if (bucket.runs.delete(runId)) refreshGrowthLimit(bucket);
    }
  };

  // No queue or cooldown check (decisions 37/47); observe happens in grant. The fast path always succeeds, so the runner never emits queued / admitted
  // for main-agent requests (decision 44).
  const observerAdmission: ModelRequestAdmission = {
    tryAcquire: ({ model }) => grant(bucketFor(workflowConcurrencyKey(model)), OBSERVER_RUN_ID),
    acquire: ({ model }) =>
      Promise.resolve(grant(bucketFor(workflowConcurrencyKey(model)), OBSERVER_RUN_ID)),
  };

  return {
    tryAdmit,
    admit,
    subscribe,
    setRunBound,
    clearRunBound,
    observer: () => observerAdmission,
    snapshot(key) {
      return buckets.get(key)?.controller.snapshot();
    },
  };
}

function abortedError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error("workflow request admission aborted");
}

let processGovernor: WorkflowConcurrencyGovernor | undefined;

/**
 * Process-level singleton (decision 5): compute the default concurrency on first access. Each app (session) then attaches its main runtime observer,
 * and the run service passes the same port to its driver.
 */
export function getWorkflowConcurrencyGovernor(): WorkflowConcurrencyGovernor {
  processGovernor ??= createWorkflowConcurrencyGovernor({
    defaultConcurrency: resolveWorkflowDefaultConcurrency(),
  });
  return processGovernor;
}
