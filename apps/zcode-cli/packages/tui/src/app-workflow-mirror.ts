// ============================================================
// TUI-side workflowRuns mirror.
// ============================================================
// Single clock: runtime state is maintained **only** by reducing events through the shared reducer
// (@zcode/shared's workflow-runs-reducer, the same implementation used by the v4 projection), plus one-time seeding on cold start/recovery.
// No polling or setInterval; the legacy workflow panel's full reload every second is a cautionary example.
//
// The mirror intentionally has two fields beyond the protocol state key:
//   1. `logTailByRunId`: log events are **not** in the workflowRuns schema (they go only to the journal event log),
//      but expanded details need to show recent logs, so the TUI keeps a bounded tail.
//   2. `seedByRunId`: **display metadata** (label / updatedAt) returned by listDynamicWorkflowRuns for cold seeding.
//      Runtime state (status, steps, usage, resumable) does **not** come from the summary: on cold start / `/resume`, journal events
//      are replayed through the same reducer by `replayWorkflowRuns`, making the mirrored run byte-for-byte consistent with its pre-restart state.
//      `resumable` is a status bit decided by the CLI in the run-settled payload; preserve the existing dynamic-workflow-run.port.ts rule to render the server boolean.

import {
  reduceWorkflowRunsState,
  workflowRunStepCounts as sharedWorkflowRunStepCounts,
  type WorkflowRunActor,
  type WorkflowRunUsage,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "@zcode/shared/zcode-protocol-v4";

/** Bound the log tail by entry count and individual length so a chatty run cannot make the mirror unbounded. */
const TUI_WORKFLOW_LOG_TAIL_LIMITS = {
  maxEntries: 10,
  maxEntryLength: 200,
} as const;

/**
 * **Display** fields from the cold-seed summary that the TUI renders (runtime state always comes from replay; see the file header).
 *
 * `label` / `updatedAt` are additive optional fields (see the `/dwf` boundary row's "implementation revision" in the spec):
 * they remain undefined until the server provides them, and rendering always falls back to runId rather than inventing a label here.
 */
export type TuiWorkflowRunSeed = {
  runId: string;
  label?: string;
  updatedAt?: number;
};

export type TuiWorkflowMirror = {
  /** Authoritative runtime state maintained by the shared reducer. */
  state: WorkflowRunsState;
  logTailByRunId: Readonly<Record<string, readonly string[]>>;
  seedByRunId: Readonly<Record<string, TuiWorkflowRunSeed>>;
};

export const EMPTY_TUI_WORKFLOW_MIRROR: TuiWorkflowMirror = {
  state: { revision: 0, runs: [] },
  logTailByRunId: {},
  seedByRunId: {},
};

/**
 * Reduce one DWF progress event into a new mirror.
 *
 * **Return the same reference when nothing changes**, so React setState skips a rerender:
 * this maps the shared reducer's "null = no semantic change" contract to "do not redraw" without another equality check.
 */
export function applyWorkflowProgressToMirror(
  mirror: TuiWorkflowMirror,
  envelope: WorkflowRunProgressEnvelope,
): TuiWorkflowMirror {
  const state = reduceWorkflowRunsState(mirror.state, envelope);
  const logTailByRunId = appendWorkflowLogTail(mirror.logTailByRunId, envelope);
  if (state === null && logTailByRunId === mirror.logTailByRunId) return mirror;
  return {
    ...mirror,
    ...(state === null ? {} : { state }),
    logTailByRunId,
  };
}

/**
 * Cold seed: merge **display names** from the session-level summary returned by `listDynamicWorkflowRuns` into the mirror.
 *
 * Fill metadata only; do **not** fabricate runtime entries. Cold replay (`replayWorkflowRuns` → shared reducer)
 * provides runtime state byte-for-byte as it was before restart. Do not invent any fields absent from the summary (other than label).
 */
export function seedWorkflowMirror(
  mirror: TuiWorkflowMirror,
  seeds: readonly TuiWorkflowRunSeed[],
): TuiWorkflowMirror {
  if (seeds.length === 0) return mirror;
  const seedByRunId = { ...mirror.seedByRunId };
  let changed = false;
  for (const seed of seeds) {
    if (!seed.runId) continue;
    const existing = seedByRunId[seed.runId];
    if (existing && sameSeed(existing, seed)) continue;
    seedByRunId[seed.runId] = seed;
    changed = true;
  }
  return changed ? { ...mirror, seedByRunId } : mirror;
}

/**
 * Step progress: **settled / scheduled** (settled / observed).
 *
 * Dynamic workflows have no static total, so the denominator is the number of scheduled nodes; never present it as overall completion percentage.
 *
 * There is one counting implementation: @zcode/shared's `workflowRunStepCounts` (shared by run cards, timeline summaries, and this code).
 * This code previously counted `nodes` itself, so a run that hit the node limit showed three different numbers across three views, all below
 * the true step count: reaching the limit **rejects new nodes**, so rejected instances are absent from `nodes` and appear only in the two usage counters.
 * This function only preserves the TUI field names (cards and i18n use nodesSettled / nodesTotal).
 */
export function workflowRunStepCounts(run: WorkflowRunState): {
  nodesSettled: number;
  nodesTotal: number;
} {
  const { total, settled } = sharedWorkflowRunStepCounts(run);
  return { nodesSettled: settled, nodesTotal: total };
}

/** All facts required to render a card, keeping the view a pure function of props (TUI tests call components as functions). */
export type TuiWorkflowCard = {
  runId: string;
  status: WorkflowRunState["status"];
  /** Reason for `stopped`; copied by the reducer from the run-settled payload. */
  stopReason?: WorkflowRunState["stopReason"];
  nodesSettled: number;
  nodesTotal: number;
  label?: string;
  resumable?: boolean;
  usage?: WorkflowRunUsage;
  actors: readonly WorkflowRunActor[];
  logTail: readonly string[];
  error?: string;
  resultPreview?: string;
  truncated?: boolean;
};

/**
 * Join a tool card to its workflow run by `toolCallId` (the schema comment defines it as the "tool card → detail page join key").
 * Follow the same rule as GUI `buildWorkflowRunByToolCallId`. Mirror state is the only source of runtime data (live events and
 * cold replay use the same reducer); seeding supplies display names only.
 */
export function buildTuiWorkflowCardIndex(
  mirror: TuiWorkflowMirror,
): ReadonlyMap<string, TuiWorkflowCard> {
  const byToolCallId = new Map<string, TuiWorkflowCard>();
  for (const run of mirror.state.runs) {
    // A run without toolCallId has no card to join, so omit it from the map.
    if (!run.toolCallId) continue;
    byToolCallId.set(run.toolCallId, cardFromRun(run, mirror));
  }
  return byToolCallId;
}

function cardFromRun(run: WorkflowRunState, mirror: TuiWorkflowMirror): TuiWorkflowCard {
  const { nodesSettled, nodesTotal } = workflowRunStepCounts(run);
  const seed = mirror.seedByRunId[run.runId];
  return {
    runId: run.runId,
    status: run.status,
    ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    nodesSettled,
    nodesTotal,
    // Only the server knows the label; projected entries do not include it, so use the seed when available.
    ...(seed?.label === undefined ? {} : { label: seed.label }),
    // resumable is a status bit decided by the CLI in the run-settled payload and carried by the reducer; the TUI does not derive it again.
    ...(run.resumable === undefined ? {} : { resumable: run.resumable }),
    usage: run.usage,
    actors: run.actors,
    logTail: mirror.logTailByRunId[run.runId] ?? [],
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.resultPreview === undefined ? {} : { resultPreview: run.resultPreview }),
    ...(run.truncated === undefined ? {} : { truncated: run.truncated }),
  };
}

function appendWorkflowLogTail(
  current: Readonly<Record<string, readonly string[]>>,
  envelope: WorkflowRunProgressEnvelope,
): Readonly<Record<string, readonly string[]>> {
  if (envelope.eventType !== "log" || !envelope.runId) return current;
  const message = logMessage(envelope.payload);
  if (message === undefined) return current;
  const previous = current[envelope.runId] ?? [];
  const appended = [...previous, message].slice(-TUI_WORKFLOW_LOG_TAIL_LIMITS.maxEntries);
  return { ...current, [envelope.runId]: appended };
}

function logMessage(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const raw = payload.message;
  if (typeof raw !== "string") return undefined;
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.slice(0, TUI_WORKFLOW_LOG_TAIL_LIMITS.maxEntryLength);
}

function sameSeed(left: TuiWorkflowRunSeed, right: TuiWorkflowRunSeed): boolean {
  return left.label === right.label && left.updatedAt === right.updatedAt;
}
