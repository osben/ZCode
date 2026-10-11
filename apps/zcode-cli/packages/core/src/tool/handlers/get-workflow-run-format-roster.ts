// ============================================================
// GetWorkflowRun's **three situational blocks** for the model: `<health>` / `<phases>` / `<subagents>` (plus `<log_tail>`)
// ============================================================
// Split from get-workflow-run-format.ts: that file provides the “one fact per block” structure, while this file renders three **tables**;
// columns, alignment, and per-phase wording form a cohesive unit.
//
// Two rules:
//   1. Omit absent facts. Without a timestamp there is no age; without `node-progress` there are no turn/tool-call counts.
//      Never substitute 0 for “unknown”: `0 tool calls` is a fact, and absence is another.
//   2. Derive column widths from the current rows (with a cap), rather than hard-coding magic numbers. A roster with two subagents
//      should not reserve twenty columns for a long name that is not present.

import type {
  GetWorkflowRunOutput,
  GetWorkflowRunPhase,
  GetWorkflowRunSubagent,
} from "@zcode/contracts";
import {
  escapeWorkflowRunText,
  formatRelativeAge,
  formatWorkflowRunCount,
  formatWorkflowRunDuration,
} from "./workflow-run-introspection.js";

/** Spacing between columns: two spaces. One space makes “name address” read like a single token. */
const COLUMN_GAP = "  ";
/** Maximum width for aligned columns. Longer values are printed as-is and make that row longer instead of widening the whole table. */
const MAX_COLUMN_WIDTH = 24;
/** Indentation for the task summary row: it belongs to the previous row rather than introducing a new fact. */
const TASK_LINE_INDENT = "  ";

function padColumn(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function columnWidth(values: readonly string[]): number {
  return Math.min(
    MAX_COLUMN_WIDTH,
    values.reduce((widest, value) => Math.max(widest, value.length), 0),
  );
}

/** Join segments into one row; omit empty segments (unknown facts) without leaving doubled spacing. */
function joinCells(cells: readonly string[]): string {
  // Trim the end: padding in the last column would become trailing whitespace, invisible noise (all `ahead` rows have it).
  return cells
    .filter((cell) => cell.length > 0)
    .join(COLUMN_GAP)
    .trimEnd();
}

// ————————————————————————————————————————————————
// <health>
// ————————————————————————————————————————————————

/**
 * Whether the run as a whole is still active, on one `key=value` row.
 *
 * `stalled` is meaningful only for a live run (a terminal run is naturally inactive). A terminal run also gets a
 * **leftover explanation**: rows marked running below are remnants from where the process died, not active work.
 * This is one of only two places in the tool that explicitly says “unknown”; silence would be read as “they are still running.”
 */
export function formatWorkflowRunHealthBlock(run: GetWorkflowRunOutput, terminal: boolean): string {
  const now = run.generatedAt;
  const health = run.health;
  const cells: string[] = [];

  const lastProgress = formatRelativeAge(now, health.lastProgressAt);
  if (lastProgress !== undefined) cells.push(`last_progress=${lastProgress}`);

  if (health.concurrency !== undefined) {
    const { effective, cap, reason, since } = health.concurrency;
    const sinceAge = formatRelativeAge(now, since);
    const why = [
      reason === undefined ? "" : escapeWorkflowRunText(reason),
      sinceAge === undefined ? "" : `since ${sinceAge}`,
    ]
      .filter((part) => part.length > 0)
      .join(" ");
    cells.push(`concurrency=${effective}/${cap}${why.length === 0 ? "" : ` (${why})`}`);
  }

  if (!terminal) {
    const stalledAge = formatRelativeAge(now, health.stalledSince);
    cells.push(`stalled=${stalledAge === undefined ? "no" : `since ${stalledAge}`}`);
  }

  cells.push(`consecutive_failures=${health.consecutiveFailures}`);
  cells.push(`cached_steps=${health.cachedSteps}`);

  const leftover = terminal ? health.leftoverRunning : undefined;
  const note =
    leftover === undefined || leftover === 0
      ? ""
      : `\nThe ${leftover} "running" step${leftover === 1 ? "" : "s"} below ${
          leftover === 1 ? "is a leftover" : "are leftovers"
        } of the exited process, not live work.`;
  return `<health>${joinCells(cells)}${note}</health>`;
}

// ————————————————————————————————————————————————
// <phases>
// ————————————————————————————————————————————————

/** Phase table: one row per phase, in declaration order. An `ahead` row has only a name and status because it has not happened yet. */
export function formatWorkflowRunPhasesBlock(
  run: GetWorkflowRunOutput,
  terminal: boolean,
): string | undefined {
  const phases = run.phases;
  if (phases === undefined || phases.length === 0) return undefined;

  const names = phases.map((phase) => escapeWorkflowRunText(phase.name));
  const nameWidth = columnWidth(names);
  const stateWidth = columnWidth(phases.map((phase) => phase.state));

  const lines = phases.map((phase, index) =>
    joinCells([
      `${index + 1}. ${padColumn(names[index]!, nameWidth)}`,
      padColumn(phase.state, stateWidth),
      phaseRoundsCell(phase),
      phaseCountsCell(phase, terminal),
      phaseDurationCell(phase, run.generatedAt, terminal),
    ]),
  );
  return `<phases>\n${lines.join("\n")}\n</phases>`;
}

function phaseRoundsCell(phase: GetWorkflowRunPhase): string {
  // rounds can be 0 only for `ahead`: a phase that has not been entered cannot report how many times it was entered.
  if (phase.rounds === 0) return "";
  return `${phase.rounds} round${phase.rounds === 1 ? "" : "s"}`;
}

function phaseCountsCell(phase: GetWorkflowRunPhase, terminal: boolean): string {
  if (phase.nodesRunning > 0) {
    // “Still running” in a terminal run means unsettled, not active.
    return `${phase.nodesSettled} settled, ${phase.nodesRunning} ${terminal ? "unfinished" : "running"}`;
  }
  if (phase.nodesSettled === 0) return "";
  return `${phase.nodesSettled} step${phase.nodesSettled === 1 ? "" : "s"} settled`;
}

function phaseDurationCell(phase: GetWorkflowRunPhase, now: number, terminal: boolean): string {
  if (phase.enteredAt === undefined) return "";
  if (phase.exitedAt !== undefined)
    return formatWorkflowRunDuration(phase.exitedAt - phase.enteredAt);
  // Without an exit time, a live run says “so far”; a terminal run says nothing. Its exit time was not recorded, and subtracting
  // the current time would count the hours after the process died as time spent in the phase.
  return terminal ? "" : `${formatWorkflowRunDuration(now - phase.enteredAt)} so far`;
}

// ————————————————————————————————————————————————
// <subagents>
// ————————————————————————————————————————————————

/**
 * Roster: one row per subagent, plus an indented `task:` row when a task summary exists.
 *
 * Read each row as “who · where · which phase · which stage · current activity · tokens used.” Activity depends on phase: running
 * agents show their ask and tools, waiting agents say what they await, and parked agents show which question they await and for how long.
 * This is why the tool exists: the model should be able to see at a glance who is blocked.
 */
export function formatWorkflowRunSubagentsBlock(run: GetWorkflowRunOutput): string {
  if (run.subagents.length === 0) return "<subagents>No subagents created yet.</subagents>";

  const askedAtByQid = new Map<string, number>();
  for (const question of run.pendingQuestions ?? [])
    askedAtByQid.set(question.qid, question.askedAt);

  const names = run.subagents.map((subagent) =>
    subagent.name === undefined ? "" : escapeWorkflowRunText(subagent.name),
  );
  const addresses = run.subagents.map(
    (subagent) => `${escapeWorkflowRunText(subagent.siteId)}@${subagent.ordinal}`,
  );
  const nameWidth = columnWidth(names);
  const addressWidth = columnWidth(addresses);
  const stateWidth = columnWidth(run.subagents.map((subagent) => subagent.state));

  const lines: string[] = [];
  run.subagents.forEach((subagent, index) => {
    lines.push(
      joinCells([
        // Do not invent a fallback name for an anonymous actor (same as pendingQuestions); leave it blank while keeping the address column aligned.
        padColumn(names[index]!, nameWidth),
        padColumn(addresses[index]!, addressWidth),
        padColumn(subagent.state, stateWidth),
        subagent.phaseName === undefined
          ? ""
          : `phase ${escapeWorkflowRunText(subagent.phaseName)}`,
        subagentActivityCell(subagent, run.generatedAt, askedAtByQid),
        subagent.tokens > 0 ? `${formatWorkflowRunCount(subagent.tokens)} tokens` : "",
      ]),
    );
    const head = subagent.currentAsk?.instructionsHead;
    if (head !== undefined && head.length > 0) {
      lines.push(`${TASK_LINE_INDENT}task: ${escapeWorkflowRunText(head)}`);
    }
  });
  const truncated =
    run.subagentsTruncated === true
      ? `\nOnly the first ${run.subagents.length} subagents are listed; this run has more.`
      : "";
  return `<subagents>\n${lines.join("\n")}${truncated}\n</subagents>`;
}

function subagentActivityCell(
  subagent: GetWorkflowRunSubagent,
  now: number,
  askedAtByQid: ReadonlyMap<string, number>,
): string {
  if (subagent.state === "parked" && subagent.parkedOn !== undefined) {
    const waited = formatRelativeAge(now, askedAtByQid.get(subagent.parkedOn));
    const forHow = waited === undefined ? "" : ` for ${waited.replace(/ ago$/u, "")}`;
    return `on question ${escapeWorkflowRunText(subagent.parkedOn)}${forHow}`;
  }
  if (subagent.state === "waiting") return waitCell(subagent, now);
  if (subagent.state === "unfinished" && subagent.currentAsk !== undefined) {
    return `${askAddress(subagent.currentAsk)} was in flight at the stop`;
  }
  if (subagent.currentAsk !== undefined) return executingCell(subagent, now);
  return settledCell(subagent);
}

function askAddress(ask: NonNullable<GetWorkflowRunSubagent["currentAsk"]>): string {
  // actorSeq is zero-based in the journal; use a human-readable one-based “step number” for the model.
  const step = ask.actorSeq === undefined ? "" : ` (step ${ask.actorSeq + 1})`;
  return `${escapeWorkflowRunText(ask.siteId)}@${ask.ordinal}${step}`;
}

function executingCell(subagent: GetWorkflowRunSubagent, now: number): string {
  const ask = subagent.currentAsk!;
  const parts = [askAddress(ask)];
  const onStep = formatRelativeAge(now, ask.startedAt);
  if (onStep !== undefined) parts.push(`${onStep.replace(/ ago$/u, "")} on this step`);
  if (ask.turn !== undefined) parts.push(`turn ${ask.turn}`);
  if (ask.toolCalls !== undefined)
    parts.push(`${ask.toolCalls} tool call${ask.toolCalls === 1 ? "" : "s"}`);
  if (ask.lastTool !== undefined) {
    const target =
      ask.lastTool.target === undefined ? "" : ` ${escapeWorkflowRunText(ask.lastTool.target)}`;
    const age = formatRelativeAge(now, ask.lastTool.at);
    parts.push(
      `last ${escapeWorkflowRunText(ask.lastTool.name)}${target}${age === undefined ? "" : ` ${age}`}`,
    );
  }
  return parts.join(", ");
}

function waitCell(subagent: GetWorkflowRunSubagent, now: number): string {
  const wait = subagent.wait;
  if (wait === undefined) return "";
  const waited = formatRelativeAge(now, wait.since);
  const forHow = waited === undefined ? "" : ` for ${waited.replace(/ ago$/u, "")}`;
  if (wait.cause === "slot") return `waiting for a slot${forHow}`;
  const after = wait.reason === undefined ? "" : ` after ${escapeWorkflowRunText(wait.reason)}`;
  const retry =
    wait.retryAfterMs === undefined
      ? ""
      : `, retry in ${formatWorkflowRunDuration(wait.retryAfterMs)}`;
  // Put “waiting for” next to the reason and “waited for” at the end; adjacent durations would be hard to distinguish.
  return `backoff${after}${forHow}${retry}`;
}

function settledCell(subagent: GetWorkflowRunSubagent): string {
  if (subagent.stepsSettled === 0 && subagent.stepsFailed === 0) return "";
  const failed = subagent.stepsFailed > 0 ? `, ${subagent.stepsFailed} failed` : "";
  return `${subagent.stepsSettled} step${subagent.stepsSettled === 1 ? "" : "s"}${failed}`;
}

// ————————————————————————————————————————————————
// <log_tail>
// ————————————————————————————————————————————————

/** Narrative tail. Prefix event age when a persisted timestamp exists; older journals lack that field, so those rows show only sequence numbers. */
export function formatWorkflowRunLogTailBlock(run: GetWorkflowRunOutput): string {
  if (run.logTail.length === 0) return "<log_tail>No log() narration recorded yet.</log_tail>";
  const lines = run.logTail.map((entry) => {
    const age = formatRelativeAge(run.generatedAt, entry.at);
    return joinCells([`[${entry.sequence}]`, age ?? "", escapeWorkflowRunText(entry.message)]);
  });
  return `<log_tail>\n${lines.join("\n")}\n</log_tail>`;
}
