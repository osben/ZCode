// ============================================================
// **Event index** for the situation snapshot: scan journal events once to derive every "how long ago" value.
// ============================================================
// The phase map, subagent roster, and health read surfaces all use the same time source—`StoredEvent.timeCreated`, the time an event is written to the journal.
// Node rows (`NodeRecord`) have no time columns, so questions like "when did this ask start?" or "when did it last move?"
// must be answered from the event stream.
//
// This module performs exactly that scan: pure function, no I/O, and no port types. Its three consumers
// (-roster-phases / -roster-subagents / -roster) share the result, so one getRunDetail reads events only once—
// this read gets more expensive as a run grows, and scanning twice would double the cost.

import type { StoredEvent } from "@zcode/dynamic-workflow";

/**
 * Event types that **count** when determining whether something is still active: the script or an ask made progress.
 *
 * Include `phase-entered` and `log` because they are evidence that the **script** is active: a script may perform several
 * world reads between asks without emitting any ask events; excluding them would falsely report that interval as stalled.
 *
 * Deliberately exclude `node-waiting`: waiting for a slot or backoff is the stall itself. Counting it as progress would make
 * `stalledSince` disappear forever—the most typical stall would become unobservable. Likewise exclude `concurrency-changed` and
 * `run-stalled`: they are **observations about inactivity**, not activity.
 */
const PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  "node-queued",
  "node-dispatched",
  "node-executing",
  "node-settled",
  "node-progress",
  "phase-entered",
  "log",
  "report",
  "artifact-published",
  "usage-updated",
]);

/**
 * Node **lifecycle** events (phase transitions). `node-progress` is excluded: completing one model turn is not a lifecycle
 * transition, matching the reducer's rule exactly; progress events therefore do not interrupt a subagent's `waiting` status.
 */
const NODE_LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "node-queued",
  "node-dispatched",
  "node-executing",
  "node-waiting",
  "node-repairing",
  "node-nudged",
  "node-settled",
]);

/** Instance key: `siteId@ordinal`, matching the engine's `refToString` format. */
export function instanceKey(siteId: string, ordinal: number): string {
  return `${siteId}@${ordinal}`;
}

/** What the current ask is waiting for (latest `node-waiting` observation + when this wait began). */
export interface RosterWaitTrace {
  cause: "slot" | "backoff";
  reason?: string;
  retryAfterMs?: number;
  since?: number;
}

/** Trace left by a node instance in the event stream. */
export interface RosterNodeTrace {
  /** Most recent `node-dispatched` time in this lifecycle (`node-queued` clears it; requeueing starts a new lifecycle). */
  dispatchedAt?: number;
  /** Type of the last lifecycle event; the subagent's `waiting` criterion checks only whether this is `node-waiting`. */
  lastLifecycleType?: string;
  /** Present only while currently waiting (any other lifecycle event clears it). */
  wait?: RosterWaitTrace;
  /** Time of the last `node-progress` event **with lastTool**. */
  lastToolAt?: number;
  /** Time of the last progress event for this instance. */
  lastActivityAt?: number;
}

/** **Most recent** entry and exit times for one phase. */
export interface RosterPhaseTrace {
  enteredAt?: number;
  exitedAt?: number;
}

/** One node settlement in event order; the health surface derives consecutive failures and cache hits from this sequence. */
export interface RosterSettlement {
  key: string;
  outcome: string;
  cached: boolean;
}

/** All outputs from one scan. */
export interface RosterEventIndex {
  nodes: ReadonlyMap<string, RosterNodeTrace>;
  phases: ReadonlyMap<string, RosterPhaseTrace>;
  settlements: readonly RosterSettlement[];
  /** Time of the last progress event across the entire run. */
  lastProgressAt?: number;
  /** Time of the last `run-stalled` event, if no progress event followed it; otherwise absent. */
  stalledSince?: number;
  /** Reason and time of the last `concurrency-changed` event (the numeric limit comes from the reducer). */
  concurrencyReason?: string;
  concurrencySince?: number;
}

/**
 * Scan events once and collect every timestamp needed for the situation snapshot.
 *
 * `now` is the time of this read and is used only to **clamp upper bounds**: a journal may be read on another machine, and a timestamp later than "now"
 * would render as a negative age, making the tool look broken rather than revealing clock skew. If an event lacks a timestamp (as in older in-memory
 * journal doubles), omit the corresponding field instead of falling back to `now`; that would label a week of history as "just now."
 */
export function indexRosterEvents(events: readonly StoredEvent[], now: number): RosterEventIndex {
  const nodes = new Map<string, RosterNodeTrace>();
  const phases = new Map<string, RosterPhaseTrace>();
  const settlements: RosterSettlement[] = [];
  let lastProgressAt: number | undefined;
  let stalledAt: number | undefined;
  let stalledPending = false;
  let concurrencyReason: string | undefined;
  let concurrencySince: number | undefined;
  let lastPhaseName: string | undefined;

  for (const stored of events) {
    const { event } = stored;
    const at = timeOf(stored, now);

    if (PROGRESS_EVENT_TYPES.has(event.type)) {
      lastProgressAt = laterOf(lastProgressAt, at);
      // Any progress after a stall observation ends the stall—even if the progress has no timestamp:
      // "it moved again" and "when it moved" are separate questions, and the first does not need a clock.
      stalledPending = false;
    }

    if (event.type === "run-stalled") {
      stalledAt = at;
      stalledPending = true;
      continue;
    }
    if (event.type === "concurrency-changed") {
      concurrencyReason = event.reason;
      concurrencySince = at;
      continue;
    }
    if (event.type === "phase-entered") {
      lastPhaseName = trackPhase(phases, event.name, lastPhaseName, at);
      continue;
    }
    if (!("instance" in event)) continue;

    const key = instanceKey(event.instance.siteId, event.instance.ordinal);
    const trace = nodes.get(key) ?? {};
    if (PROGRESS_EVENT_TYPES.has(event.type)) {
      trace.lastActivityAt = laterOf(trace.lastActivityAt, at);
    }
    if (NODE_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      trackLifecycle(trace, event.type, at);
    }
    if (event.type === "node-waiting") {
      // If already waiting, preserve **when the wait began**: a backoff ladder emits several node-waiting events, but readers ask
      // "how long has it been stuck?", not "when was the latest observation emitted?" Use the latest reason and retry interval.
      const since = trace.wait?.since ?? at;
      trace.wait = {
        cause: event.cause,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.retryAfterMs === undefined ? {} : { retryAfterMs: event.retryAfterMs }),
        ...(since === undefined ? {} : { since }),
      };
    }
    if (event.type === "node-progress" && event.lastTool !== undefined && at !== undefined) {
      trace.lastToolAt = at;
    }
    if (event.type === "node-settled") {
      settlements.push({ key, outcome: event.outcome, cached: event.cached === true });
    }
    nodes.set(key, trace);
  }

  return {
    nodes,
    phases,
    settlements,
    ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
    ...(stalledPending && stalledAt !== undefined ? { stalledSince: stalledAt } : {}),
    ...(concurrencyReason === undefined ? {} : { concurrencyReason }),
    ...(concurrencySince === undefined ? {} : { concurrencySince }),
  };
}

/**
 * Record a `phase-entered` event: it starts this phase and ends the previous **different-named** phase.
 * Reentering the same phase (a back edge) only advances its entry time; it does not count as leaving. Return the new "last entered phase" name.
 */
function trackPhase(
  phases: Map<string, RosterPhaseTrace>,
  name: string,
  lastPhaseName: string | undefined,
  at: number | undefined,
): string {
  if (lastPhaseName !== undefined && lastPhaseName !== name && at !== undefined) {
    const previous = phases.get(lastPhaseName);
    if (previous !== undefined) previous.exitedAt = at;
  }
  // Use the most recent entry, not the first: after three back-edge loops, readers ask how long this visit has lasted.
  // Reentry clears the previous exit time because the phase is active again.
  phases.set(name, at === undefined ? {} : { enteredAt: at });
  return name;
}

/** Record one lifecycle event: requeueing clears the previous dispatch time, and any non-waiting event clears the wait state. */
function trackLifecycle(trace: RosterNodeTrace, type: string, at: number | undefined): void {
  trace.lastLifecycleType = type;
  if (type !== "node-waiting") trace.wait = undefined;
  if (type === "node-queued") trace.dispatchedAt = undefined;
  if (type === "node-dispatched" && at !== undefined) trace.dispatchedAt = at;
}

/**
 * Event persistence time. Treat missing, non-finite, and non-positive values as "no clock"—`0` is 1970,
 * so it can only indicate a missing value, not a real timestamp.
 */
function timeOf(stored: StoredEvent, now: number): number | undefined {
  const time = stored.timeCreated;
  if (typeof time !== "number" || !Number.isFinite(time) || time <= 0) return undefined;
  return Math.min(time, now);
}

/** Later of two optional timestamps. */
export function laterOf(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}
