// ============================================================
// **Run roster view** for dynamic workflows: phases / subagents / health
// ============================================================
// Split from dynamic-workflow-run.port.ts for the same reason as dwf-journal-introspection.ts: that
// contract had reached oxlint's max-lines limit. The public surface is unchanged—the main port file
// re-exports every name from here, keeping `@zcode/contracts` import paths exactly the same.
//
// These three groups of fields are attached to `DynamicWorkflowRunDetail` and derived at read time by
// `getRunDetail`; see the comments on each type below for the contract and invariants.

// One rule applies to all three groups: **time has a single source**, `dwf_event.time_created` (when
// the event was written to the journal). Falling back to `Date.now()` at read time is wrong—it would
// label a week of history as "just now" during a cold read, defeating the purpose of these fields:
// making "how long ago" trustworthy. Older journals without this column omit time fields; never use 0
// or NaN.

/**
 * A phase's state in the roster view.
 *
 * - `ahead`: declared by the script, but control flow has not reached it—the **only** state with `rounds: 0`;
 * - `current`: the run is live and this is the phase it entered most recently;
 * - `unfinished`: the run is terminal, but an ask in this phase has not settled (the process died during it);
 * - `done`: all other cases.
 */
export type DynamicWorkflowRunPhaseState = "done" | "current" | "ahead" | "unfinished";

/** One phase in the roster view (a `phase("…")` marker). */
export interface DynamicWorkflowRunPhaseView {
  /** Original author-provided name, from the same vocabulary as `run-launched.phaseNames` / `phase-entered.name`. */
  name: string;
  state: DynamicWorkflowRunPhaseState;
  /** Number of entries (re-entering the same phase increments it). `ahead` is always 0; all others are ≥ 1. */
  rounds: number;
  /** Settled / unsettled counts among nodes created in this phase. */
  nodesSettled: number;
  nodesRunning: number;
  /**
   * Time of the **most recent** entry and its exit time (the next `phase-entered` event with a different
   * name). Use the most recent entry rather than the first: when a loop revisits a phase three times,
   * readers want to know "how long has this round been active?" The current phase has no exit time;
   * both fields are omitted if events lack timestamps.
   */
  enteredAt?: number;
  exitedAt?: number;
}

/**
 * A subagent's current state. **Evaluate in this order**; the first matching condition determines the result:
 *
 * Non-terminal run: `parked` (its own question is waiting for an answer) → `waiting` (the current ask's
 * last lifecycle event is `node-waiting`: waiting for a slot or in backoff) → `executing` (an ask row
 * is still running) → `failed` (the most recently settled ask failed) → `idle`.
 *
 * Terminal run: all three live states disappear—`unfinished` (an ask row is still marked running, so
 * the process died during it) → `failed` → `done`.
 */
export type DynamicWorkflowRunSubagentState =
  | "idle"
  | "executing"
  | "waiting"
  | "parked"
  | "done"
  | "failed"
  | "unfinished";

/**
 * Most recently observed tool call in an ask. `target` is a human-readable **hint** (file path,
 * command prefix), not the input itself—each stage from the engine to here applies the same bound, and
 * full tool inputs are never included.
 */
export interface DynamicWorkflowRunSubagentLastTool {
  name: string;
  target?: string;
  /** Persistence time of the `node-progress` event that observed it; omitted if the event has no timestamp. */
  at?: number;
}

/** Ask currently running for a subagent (present while an ask row is still `running`). */
export interface DynamicWorkflowRunSubagentAsk {
  siteId: string;
  ordinal: number;
  /** This subagent's ask number (journal `actorSeq`); omitted for older rows without this column. */
  actorSeq?: number;
  /**
   * First 240 characters of the instructions written for this ask. The read surface uses this to
   * answer "what was this subagent assigned to do?"—the state only says "running." Omitted for older
   * journals without `instructionsHead`; **never read the full instructions as a fallback**.
   */
  instructionsHead?: string;
  /** `node-dispatched` time for this ask; omitted if the event has no timestamp. */
  startedAt?: number;
  /**
   * Number of turns completed and tool calls so far (updated by `node-progress`). Always omitted for
   * older journals without `node-progress`: omission means "unknown," while `0` means "no tools have
   * been called"—these are different facts.
   */
  turn?: number;
  toolCalls?: number;
  lastTool?: DynamicWorkflowRunSubagentLastTool;
}

/** What the current ask is waiting for (observation from the latest `node-waiting` event). */
export interface DynamicWorkflowRunSubagentWait {
  /** `slot` = waiting for the process-level admission gate; `backoff` = runner is retrying after a delay. */
  cause: "slot" | "backoff";
  reason?: string;
  retryAfterMs?: number;
  /**
   * Time when it **entered this wait** (the first `node-waiting` after the most recent non-waiting
   * lifecycle event), not the latest event's time: a backoff sequence can emit several events, and
   * readers want to know "how long has it been stuck?" Omitted if events have no timestamps.
   */
  since?: number;
}

/** One subagent in the roster view (= one actor instance). */
export interface DynamicWorkflowRunSubagentView {
  siteId: string;
  ordinal: number;
  /** Effective name from `agent("poet")`; omitted for anonymous actors, with no fallback label synthesized here (as with pendingQuestions). */
  name?: string;
  state: DynamicWorkflowRunSubagentState;
  /** Phase where its current (or most recent) ask began; falls back to its creation phase if neither can be read. */
  phaseName?: string;
  currentAsk?: DynamicWorkflowRunSubagentAsk;
  wait?: DynamicWorkflowRunSubagentWait;
  /**
   * Question it is parked on (`pendingQuestions[].qid`). **Present only when the parked-question table
   * could be queried**: when `health.pendingQuestionsKnown` is false, the read cannot know whether any
   * question is waiting; see that field.
   */
  parkedOn?: string;
  /** Settled / failed ask counts and total tokens for those asks (from node-row `stats`). */
  stepsSettled: number;
  stepsFailed: number;
  tokens: number;
  /** Last observed activity time (latest progress event for any node belonging to this actor). */
  lastProgressAt?: number;
}

/**
 * Run-level concurrency state: current limit, expected limit, reason, and when it began.
 *
 * **The whole object is present only when `effective < cap`** (same omission rule as detail's
 * `maxConcurrency`): a run at its own limit has nothing to report, and presence here means "it is being
 * constrained."
 */
export interface DynamicWorkflowRunConcurrencyHealth {
  /** Number currently allowed by the governor = min(shared gate, {@link cap}). */
  effective: number;
  /**
   * **This run's own** limit: the user-set value if present, otherwise the machine ceiling.
   *
   * Intentionally does not report the machine ceiling: a run started with `max_concurrency: 3` on a
   * six-core machine would always show "3/6," which looks throttled even though it is running at the
   * limit the user chose—that limit is a setting, not a fault.
   */
  cap: number;
  /** Reason from the latest `concurrency-changed` event (`rate_limited` / `recovered`, etc.). */
  reason?: string;
  /** Persistence time of that event; omitted if it has no timestamp. */
  since?: number;
}

/** Whether the run as a whole is still active. */
export interface DynamicWorkflowRunHealth {
  /** Time of the latest progress event across the entire run. */
  lastProgressAt?: number;
  /**
   * Time of the latest `run-stalled` event, with **no** progress event after it. Waiting for a slot is
   * not progress—that wait is the stall itself, and counting it as progress would hide every stall.
   */
  stalledSince?: number;
  concurrency?: DynamicWorkflowRunConcurrencyHealth;
  /** Number of asks that **failed consecutively at the end** of settlement order: three consecutive failures differ from three scattered failures. */
  consecutiveFailures: number;
  /** Settlements served from the completion cache (`node-settled { cached: true }`). */
  cachedSteps: number;
  /** **Terminal runs only**: node rows still marked `running`, meaning the process died during them. Omitted when 0. */
  leftoverRunning?: number;
  /**
   * Whether this read **can answer** "is any question waiting for an answer?"
   *
   * Parked questions exist only in the memory of the process that asked them (see
   * {@link DynamicWorkflowRunDetail.pendingQuestions}), so when reading an in-flight run belonging
   * to another process, "no unanswered questions" and "unknown" look identical—even though they
   * imply different next steps for the model. This is true when this session holds a registry entry
   * for the run or the run is terminal (by definition, terminal runs have nobody waiting). When false,
   * the whole `pendingQuestions` field is omitted and no subagent is reported as `parked`.
   */
  pendingQuestionsKnown: boolean;
}
