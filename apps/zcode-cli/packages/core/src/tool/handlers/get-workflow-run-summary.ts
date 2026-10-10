// ============================================================
// GetWorkflowRun's `<summary>`: a one-line status
// ============================================================
//
// Build this sentence **deterministically** from structured fields, without model involvement: the same snapshot always produces the
// same sentence, so tests can assert it exactly and it cannot change its answer between reads. It answers the three questions readers
// actually ask—where the run is, whether it is active, and whether anything needs action—while the blocks below expand on those answers.
//
// One rule applies throughout: **omit what is unknown**. Without a timestamp, omit age; without a phase, omit phase position;
// when the parked-question table cannot be read, say “unknown.” Never use 0 or “unknown” to impersonate a fact.

import type { GetWorkflowRunOutput } from "@zcode/contracts";
import { GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS } from "@zcode/contracts";
import {
  formatRelativeAge,
  formatWorkflowRunCount,
  formatWorkflowRunDuration,
} from "./workflow-run-introspection.js";

/** Facts used by the summary = the full output minus the summary itself (the handler builds the output first, then this sentence). */
type WorkflowRunSummaryFacts = Omit<GetWorkflowRunOutput, "summary">;

/** Three terminal states: the run has no next action (same set as the port's terminal-state predicate). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "errored", "stopped"]);

/** When over the character budget, remove whole clauses first and hard-truncate only as a last resort, reserving one character for the ellipsis. */
const SUMMARY_ELLIPSIS = "…";

export function buildWorkflowRunSummary(run: WorkflowRunSummaryFacts): string {
  const now = run.generatedAt;
  const terminal = TERMINAL_STATUSES.has(run.status);

  // The first two clauses are the skeleton (where the run is and which step it reached); never remove them under any budget.
  const required = [
    `${statusClause(run, now, terminal)}${phaseClause(run)}.`,
    `${stepsClause(run, terminal)}.`,
  ];
  const optional = [
    failureClause(run),
    questionsClause(run),
    progressClause(run, now, terminal),
    deliverableClause(run),
    ownershipClause(run),
  ].filter((clause): clause is string => clause !== undefined);

  const sentences = [...required, ...optional];
  while (
    sentences.length > required.length &&
    sentences.join(" ").length > GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS
  ) {
    sentences.pop();
  }
  const text = sentences.join(" ");
  if (text.length <= GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS) return text;
  return `${text.slice(0, GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS - SUMMARY_ELLIPSIS.length)}${SUMMARY_ELLIPSIS}`;
}

/** Status plus how long it has run or how long ago it ended. */
function statusClause(run: WorkflowRunSummaryFacts, now: number, terminal: boolean): string {
  const elapsed = formatWorkflowRunDuration(run.updatedAt - run.createdAt);
  if (!terminal) {
    return run.status === "pending"
      ? "Pending, not dispatched yet"
      : `Running for ${formatWorkflowRunDuration(now - run.createdAt)}`;
  }
  if (run.status === "completed") return `Completed in ${elapsed}`;
  if (run.status === "errored") return `Errored after ${elapsed}`;
  // For stopped runs, say how long ago it stopped first (the reader wants to know whether this is still recent), then total run time.
  const reason = run.stopReason === undefined ? "stopped" : run.stopReason;
  const endedAge = formatRelativeAge(now, run.updatedAt);
  const ended = endedAge === undefined ? "" : ` ${endedAge}`;
  return `Stopped (${reason})${ended} after ${elapsed}`;
}

/**
 * Phase position. A live run (or terminal run with unfinished phases) reports “current / total.” A fully completed run reports only
 * the total; “at phase 4” adds no information after the run has finished. Omit the sentence when the script has no phases.
 */
function phaseClause(run: WorkflowRunSummaryFacts): string {
  const phases = run.phases;
  if (phases === undefined || phases.length === 0) return "";
  const index = phases.findIndex(
    (phase) => phase.state === "current" || phase.state === "unfinished",
  );
  if (index < 0) return `, across ${phases.length} phase${phases.length === 1 ? "" : "s"}`;
  return `, in phase ${index + 1} of ${phases.length} (${phases[index]!.name})`;
}

/** Step count. `nodesObserved` is the number of persisted node rows; never present it as a total because dynamic workflows have no static total. */
function stepsClause(run: WorkflowRunSummaryFacts, terminal: boolean): string {
  const settled = run.usage.nodesCompleted + run.usage.nodesFailed;
  const leftover = run.health.leftoverRunning;
  if (terminal && leftover !== undefined && leftover > 0) {
    // The process died while these steps were active: they are remnants, not active work. Readers can see that resuming will redispatch them.
    return `${settled} of ${run.usage.nodesObserved} dispatched steps settled; ${leftover} ${
      leftover === 1 ? "was" : "were"
    } still running when the owning process exited and will be re-dispatched on resume`;
  }
  if (terminal) {
    const failed = run.usage.nodesFailed > 0 ? `, ${run.usage.nodesFailed} failed` : "";
    return `${settled} step${settled === 1 ? "" : "s"} settled${failed}, ${formatWorkflowRunCount(
      run.usage.spentTokens,
    )} tokens`;
  }
  const running =
    run.usage.nodesRunning > 0 ? `, ${run.usage.nodesRunning} running${runningBreakdown(run)}` : "";
  return `${settled} of ${run.usage.nodesObserved} dispatched steps settled${running}`;
}

/**
 * What each in-flight step is doing (phase counts from the roster). Omit the entire parenthetical when the roster is unavailable.
 *
 * **Invariant**: a subagent in an active phase (`executing` / `waiting` / `parked`) has exactly one ask row still marked `running`.
 * `waiting` means that ask is waiting for a slot or backing off; `parked` means it is waiting for a question. Neither row has settled.
 * These three counts therefore **partition** `usage.nodesRunning` and must add up to it. If the parenthetical total differs from the
 * count outside it, the journal was manually constructed with an impossible state.
 */
function runningBreakdown(run: WorkflowRunSummaryFacts): string {
  const counts = { executing: 0, waiting: 0, parked: 0 };
  for (const subagent of run.subagents) {
    if (subagent.state === "executing") counts.executing += 1;
    else if (subagent.state === "waiting") counts.waiting += 1;
    else if (subagent.state === "parked") counts.parked += 1;
  }
  const parts = (Object.keys(counts) as (keyof typeof counts)[])
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/**
 * Pending questions. **“Unknown” must be stated explicitly**: when reading a run owned by another process, “nobody is waiting” and
 * “cannot look it up” look identical, but imply completely different next steps for the model.
 */
function questionsClause(run: WorkflowRunSummaryFacts): string | undefined {
  if (!run.health.pendingQuestionsKnown) return "Pending questions are unknown from this session.";
  const count = run.pendingQuestions?.length ?? 0;
  if (count === 0) return undefined;
  return `${count} question${count === 1 ? "" : "s"} awaiting your answer.`;
}

/** When the run was last observed active; explicitly say when it is stalled. */
function progressClause(
  run: WorkflowRunSummaryFacts,
  now: number,
  terminal: boolean,
): string | undefined {
  if (terminal) return undefined;
  const age = formatRelativeAge(now, run.health.lastProgressAt);
  if (age === undefined) return undefined;
  return run.health.stalledSince === undefined
    ? `Last progress ${age}.`
    : `Stalled, last progress ${age}.`;
}

/** Include the failure code so the model can distinguish a dead process from a genuine script failure, which determines the next route. */
function failureClause(run: WorkflowRunSummaryFacts): string | undefined {
  if (run.error === undefined) return undefined;
  if (run.status !== "errored" && run.stopReason !== "provider") return undefined;
  return `Failure: ${run.error.code}.`;
}

/**
 * Deliverable (present only for completed runs): point the reader to that item rather than a list of artifacts.
 *
 * Do **not** quote the title: this sentence is XML-ish escaped into `<summary>`, and the escape table replaces `"` with `&quot;`.
 * Quotes added for readability would appear as entities to the model. The kind in parentheses already brackets the title.
 */
function deliverableClause(run: WorkflowRunSummaryFacts): string | undefined {
  if (run.status !== "completed") return undefined;
  const primary = run.artifacts?.find((artifact) => artifact.primary === true);
  if (primary === undefined) return undefined;
  return `Deliverable: ${primary.title ?? primary.id} (${primary.kind}, primary).`;
}

/** A run not owned by this session receives no notifications and is invisible to TaskOutput, so the summary's first sentence must state its owner. */
function ownershipClause(run: WorkflowRunSummaryFacts): string | undefined {
  return run.ownedByThisSession ? undefined : "Owned by another session.";
}
