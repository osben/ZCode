/**
 * Adaptive concurrency controller: a pure AIMD state machine for one provider key.
 *
 * Pure-package rule: no clock reads or I/O—callers always pass `now` (ms since epoch). This class
 * only answers “what is the cap now, can a request be admitted, and did this signal change the
 * cap?” Signal delivery and queueing (the process-level bootstrap controller) happen outside this
 * package.
 *
 * The unit is a **model request** (each attempt): `inFlight` is the number of admitted requests not
 * yet released. There is no ask-level count—a subagent has only one request in flight at a time, so
 * “≤ N requests” is equivalent to “≤ N running subagents.”
 *
 * **Epochs** dampen batches: each admission records the current epoch, and each throttle decision
 * increments the epoch. A 429 evaluates the current cap only when its request was sent under the
 * **current** cap (same epoch); a 429 from an old epoch evaluates a cap that has already been
 * reduced, so it only clears the streak and refreshes cooldown. Successes follow the same rule:
 * only successes in the current epoch count toward the streak.
 *
 * Signal methods return the list of cap changes caused by that signal (usually zero or one; two
 * when an idle reset is immediately followed by a throttle). Callers fan them out unchanged as
 * `concurrency-changed` events.
 */

import type { ConcurrencyChange, ConcurrencyChangeReason } from "./types.js";

/**
 * Throttling uses `cap = max(FLOOR, floor(cap × 0.75))` (the factor changed from 0.5 to 0.75):
 * halving overreacts when the cap is only one or two over the limit—a single 429 at the request
 * gate means the cap is too high, but rarely that it is twice as high.
 */
export const CONCURRENCY_DECREASE_FACTOR = 0.75;
/** Additive increase step. */
export const CONCURRENCY_INCREASE_STEP = 1;
/**
 * Number K of consecutive successful model requests required for each +1 increase. There is one
 * tier. This changed from 40 to 4: a failed probe costs only one request hitting 429 and a rollback
 * to `lastGood` (a proven working level), so one probe is not worth trading for 40 successes.
 */
export const CONCURRENCY_INCREASE_AFTER_SUCCESSES = 4;
/** Always keep at least one probe running. */
export const CONCURRENCY_FLOOR = 1;
/** After a key is idle this long with nothing in flight, forget its learned cap and return to the ceiling. */
export const CONCURRENCY_IDLE_RESET_MS = 300_000;

/** Throttle reasons that reduce the cap. */
export type ConcurrencyThrottleReason = Extract<
  ConcurrencyChangeReason,
  "rate_limited" | "provider_overloaded" | "offpeak_queued"
>;

/** Read-only controller snapshot (for test assertions and the governor's `concurrency` projection in the run header). */
export interface ConcurrencyControllerSnapshot {
  readonly key: string;
  readonly ceiling: number;
  readonly cap: number;
  /** Throttle-decision counter, attached to a request on admission and returned for comparison when it ends. */
  readonly epoch: number;
  readonly inFlight: number;
  readonly waiters: number;
  readonly successStreak: number;
  readonly cooldownUntil?: number;
  readonly lastRequestAt?: number;
  readonly lastGood?: number;
  readonly lastBad?: number;
}

export class ConcurrencyController {
  private cap: number;
  private epoch = 0;
  private inFlight = 0;
  private waiters_ = 0;
  private successStreak = 0;
  private cooldownUntil?: number;
  private lastRequestAt?: number;
  private lastGood?: number;
  private lastBad?: number;

  /**
   * @param key Provider key (`${providerId}/${modelId}`), used only in change events—the controller
   *   itself does not inspect it. It is an identity, not a per-signal parameter, so it is passed at
   *   construction; one controller serves exactly one key.
   * @param ceiling CPU-derived ceiling, used as both the initial value and upper bound.
   */
  constructor(
    readonly key: string,
    readonly ceiling: number,
  ) {
    this.cap = ceiling;
  }

  snapshot(): ConcurrencyControllerSnapshot {
    return {
      key: this.key,
      ceiling: this.ceiling,
      cap: this.cap,
      epoch: this.epoch,
      inFlight: this.inFlight,
      waiters: this.waiters_,
      successStreak: this.successStreak,
      ...(this.cooldownUntil === undefined ? {} : { cooldownUntil: this.cooldownUntil }),
      ...(this.lastRequestAt === undefined ? {} : { lastRequestAt: this.lastRequestAt }),
      ...(this.lastGood === undefined ? {} : { lastGood: this.lastGood }),
      ...(this.lastBad === undefined ? {} : { lastBad: this.lastBad }),
    };
  }

  /**
   * Gate (admission condition): in-flight request count is below cap and Retry-After cooldown is
   * inactive. This is a pure query and does not reset idle state; callers (the governor) invoke
   * {@link observe} first on the admission path. Admission is also a signal, so the first run after
   * an hour of idleness must start at the ceiling immediately.
   */
  canAdmit(now: number): boolean {
    return (
      this.inFlight < this.cap && (this.cooldownUntil === undefined || now >= this.cooldownUntil)
    );
  }

  /** “Empty signal” that checks only for an idle reset (used before admission, before the observer allows it). */
  observe(now: number): ConcurrencyChange[] {
    return this.idleReset(now);
  }

  /**
   * A request was admitted: increment `inFlight`, refresh `lastRequestAt`, and return its epoch (to
   * be returned when the request ends). Do not reset idle state here—the caller already did so in
   * {@link observe}; a request just observed as non-idle cannot become idle before admission.
   */
  admitted(now: number): number {
    this.lastRequestAt = now;
    this.inFlight += 1;
    return this.epoch;
  }

  /**
   * A request succeeded: decrement `inFlight`; only success in the **current epoch** increments
   * `successStreak`. Success in an old epoch proves the load under the old, backed-off cap, not that
   * the new cap can be higher.
   * `successStreak ≥ K` **proves** the current cap works: `lastGood = max(lastGood, cap)` (only a
   * completed streak can set lastGood; reducing the cap cannot). If there are waiters **and**
   * `cap < ceiling`, increase by 1. Without waiters, the streak accumulates but is not applied.
   */
  succeeded(now: number, epoch: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (epoch !== this.epoch) return changes;
    this.successStreak += 1;
    if (this.successStreak < CONCURRENCY_INCREASE_AFTER_SUCCESSES) return changes;
    // A full streak has proved this level works, regardless of whether anyone is waiting to scale up.
    if (this.lastGood === undefined || this.cap > this.lastGood) this.lastGood = this.cap;
    if (this.waiters_ <= 0 || this.cap >= this.ceiling) return changes;
    const previous = this.cap;
    this.cap = Math.min(this.ceiling, previous + CONCURRENCY_INCREASE_STEP);
    this.successStreak = 0;
    changes.push(this.change(previous, "recovered"));
    return changes;
  }

  /**
   * Throttled/overloaded. Always decrement `inFlight` and clear the streak; if Retry-After is
   * present, extend cooldown to the later time.
   *
   * Only a 429 where `epoch === current epoch` changes the cap: that request was sent under the
   * current cap and evaluates it. Ignore old-epoch 429s (emit no event). For current-epoch 429s,
   * there are two cases: if throttled while probing **above** `lastGood`, revert to `lastGood` (set
   * `lastBad`, without applying the factor); otherwise (`lastGood` is absent or `cap ≤ lastGood`, so
   * the baseline has shifted), use `cap = max(FLOOR, floor(cap × 0.75))`, set `lastBad` to the old
   * cap, and **clear** `lastGood` because it was just disproved and no streak has proved the new cap
   * yet (a cap reduction does not set lastGood). In both cases increment `epoch`—even if the cap is
   * already at the floor and does not change—so the same batch of requests can trigger only one
   * decision.
   */
  throttled(
    now: number,
    epoch: number,
    reason: ConcurrencyThrottleReason,
    retryAfterMs?: number,
  ): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.successStreak = 0;
    const cooldownMs = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : undefined;
    if (cooldownMs !== undefined) {
      this.cooldownUntil = Math.max(this.cooldownUntil ?? 0, now + cooldownMs);
    }
    if (epoch !== this.epoch) return changes;

    const previous = this.cap;
    if (this.lastGood !== undefined && this.cap > this.lastGood) {
      this.lastBad = this.cap;
      this.cap = this.lastGood;
    } else {
      this.cap = Math.max(CONCURRENCY_FLOOR, Math.floor(this.cap * CONCURRENCY_DECREASE_FACTOR));
      this.lastBad = previous;
      this.lastGood = undefined;
    }
    this.epoch += 1;
    // If the cap is already at the floor and there is no Retry-After, nothing changed, so emit no
    // event. A Retry-After throttle must still tell the run header when cooldown ends even if the
    // cap is unchanged, so always emit when cooldownMs is set.
    if (previous === this.cap && cooldownMs === undefined) return changes;
    changes.push(this.change(previous, reason, cooldownMs));
    return changes;
  }

  /** Transient non-throttle failure (timeout / 5xx / network): decrement `inFlight`, clear the streak, and leave cap unchanged. */
  failedTransient(now: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.successStreak = 0;
    return changes;
  }

  /** A request ended in permanent failure/cancellation, or a ticket saw release without a terminal event: only decrement `inFlight`. */
  ended(now: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.inFlight = Math.max(0, this.inFlight - 1);
    return changes;
  }

  /** Number of waiters supplied by the governor when the queue changes (increase cap only when there is demand). */
  waiters(now: number, count: number): ConcurrencyChange[] {
    const changes = this.idleReset(now);
    this.waiters_ = Math.max(0, count);
    return changes;
  }

  // ——————————————————————————————— Internal ———————————————————————————————

  /**
   * Idle reset: when `now − lastRequestAt ≥ IDLE_RESET_MS` and nothing is in flight, restore cap to
   * the ceiling, clear streak / cooldown / lastGood / lastBad, and increment epoch. Reset lazily
   * when any signal arrives (no timer).
   */
  private idleReset(now: number): ConcurrencyChange[] {
    if (
      this.lastRequestAt === undefined ||
      this.inFlight !== 0 ||
      now - this.lastRequestAt < CONCURRENCY_IDLE_RESET_MS
    ) {
      return [];
    }
    const previous = this.cap;
    // Idempotent: do nothing when already at the ceiling with clean state (otherwise every idle
    // signal would increment epoch again).
    if (
      previous === this.ceiling &&
      this.successStreak === 0 &&
      this.cooldownUntil === undefined &&
      this.lastGood === undefined &&
      this.lastBad === undefined
    ) {
      return [];
    }
    this.cap = this.ceiling;
    this.successStreak = 0;
    this.cooldownUntil = undefined;
    this.lastGood = undefined;
    this.lastBad = undefined;
    this.epoch += 1;
    // Keep lastRequestAt: another idle signal should not reset again; state is already at the ceiling.
    return previous === this.cap ? [] : [this.change(previous, "idle_reset")];
  }

  private change(
    previous: number,
    reason: ConcurrencyChangeReason,
    cooldownMs?: number,
  ): ConcurrencyChange {
    return {
      key: this.key,
      previous,
      next: this.cap,
      reason,
      ...(this.lastGood === undefined ? {} : { lastGood: this.lastGood }),
      ...(this.lastBad === undefined ? {} : { lastBad: this.lastBad }),
      ...(cooldownMs === undefined ? {} : { cooldownMs }),
    };
  }
}
