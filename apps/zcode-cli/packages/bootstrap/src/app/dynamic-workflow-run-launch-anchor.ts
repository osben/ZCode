// ============================================================
// Launch anchor for a dwf run.
// ============================================================
// A subagent's agent_step must be attributed to the turn that launched this run. The anchor is an inputId
// stored without SQL in the journal's `run-launched` event (written only once when creating the run):
//   - This file resolves it at submission time (active turn / value minted for direct launch / predecessor run's anchor / fallback value)
//     and passes it to the engine to persist.
//   - Resume and progress-event derivation read it back from the journal, so the same run retains one anchor across lifecycles.
//
// The same event also carries three related pieces of host metadata: the script-declared phase table (`phaseNames`), the run's subagent
// model selection (`subagentModel`), and the script file path (`scriptPath`). All four are written once when the run is created, never read by the engine, and require no SQL—`dwf_run`
// has no corresponding columns.

import type { TraceContext } from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { uuidv7 } from "@zcode/shared";

export interface RunLaunchAnchor {
  /** inputId of the turn that launched the run (a minted UUID v7 for direct hub launches). */
  inputId: string;
}

/**
 * All data passed to the engine for the `run-launched` event: anchor + script-declared phase table + this run's subagent selection (`subagentModel`, canonical picker string
 * `providerId/modelId[$reasoningLevel]`）。
 *
 * The latter two are **not** part of the anchor: an amended run reuses the predecessor's inputId but uses the new script's phase table, and never inherits
 * the predecessor's model ("omitted means inherit predecessor" is the tool surface's three-state value, normalized by AmendWorkflow's resolveInput).
 * Therefore these fields are combined with the anchor in submit rather than placed in {@link resolveLaunchAnchor}.
 */
export interface RunLaunch extends RunLaunchAnchor {
  phaseNames?: string[];
  subagentModel?: string;
  /**
   * Absolute path to this run's script file. Like the phase table and
   * subagent selection, it is not part of the anchor: an amendment records the script file for **this amendment**, never the predecessor's.
   */
  scriptPath?: string;
  /** "Run together" table aligned by index with `phaseNames`; also written to the journal only when the run is created. */
  phaseAlongside?: number[][];
}

/**
 * Read the run's anchor from the first `run-launched` event in the journal. Runs launched before the upgrade do not have this event, so return `undefined`;
 * the caller then omits `launchInputId` (the facts layer consequently emits no `workflow.lifecycle`; do not report subagents or synthesize one).
 *
 * The anchor immediately follows the first `run-started` (engine recording order), so read only the first few journal events instead of
 * loading the whole journal into memory. `RUN_LAUNCH_ANCHOR_SCAN_LIMIT` leaves room for future run-creation events inserted before it.
 */
const RUN_LAUNCH_ANCHOR_SCAN_LIMIT = 8;

export function readRunLaunchAnchor(
  journal: JournalStorePort,
  runId: string,
): RunLaunchAnchor | undefined {
  for (const stored of journal.listEvents(runId, { limit: RUN_LAUNCH_ANCHOR_SCAN_LIMIT })) {
    if (stored.event.type === "run-launched") return { inputId: stored.event.inputId };
  }
  return undefined;
}

/**
 * Read the run's subagent selection from `subagentModel` on the same `run-launched` event. Resume, both read surfaces, and cold replay use it to reconstruct the same canonical string—
 * zero SQL; `dwf_run` has no such column. If absent, the subagent uses the session model (the case for most runs, including those launched before the upgrade).
 *
 * Use the same scan and limit as the anchor, but **deliberately do not attach it** to {@link RunLaunchAnchor}:
 * {@link resolveLaunchAnchor} makes amended runs reuse the predecessor's anchor, but the model must never be inherited that way. Its three-state tool value
 * (omitted = inherit predecessor, null = return to session model, string = set explicitly) is normalized by `AmendWorkflow`'s resolveInput, following the same rationale as `max_concurrency`.
 */
export function readRunSubagentModel(journal: JournalStorePort, runId: string): string | undefined {
  for (const stored of journal.listEvents(runId, { limit: RUN_LAUNCH_ANCHOR_SCAN_LIMIT })) {
    if (stored.event.type === "run-launched") return stored.event.subagentModel;
  }
  return undefined;
}

/**
 * Read this run's script file from `scriptPath` on the same `run-launched` event. Both read surfaces use it on cold paths to
 * reconstruct the same absolute path—zero SQL; `dwf_run` has no such column. If absent, this run has no editable script file
 * (the project cannot save drafts, or the run predates this feature).
 *
 * Same scan and limit as {@link readRunSubagentModel}; also **deliberately not attached**
 * to {@link RunLaunchAnchor}: amendments reuse the anchor, but the predecessor's script path points to the old script, so reusing it would make the model edit a file that is no longer running.
 */
export function readRunScriptPath(journal: JournalStorePort, runId: string): string | undefined {
  for (const stored of journal.listEvents(runId, { limit: RUN_LAUNCH_ANCHOR_SCAN_LIMIT })) {
    if (stored.event.type === "run-launched") return stored.event.scriptPath;
  }
  return undefined;
}

/**
 * Resolve the anchor at submission time. Priority:
 *   1. A resumed amendment (`resume_from`) reuses the **predecessor's** anchor—every step of the same work is attached to one message.
 *   2. The caller's explicit `launchInputId` (direct hub launch: shares a UUID v7 with the controlOnly launch turn).
 *   3. The parent runtime's active-turn inputId (chat CreateWorkflow: the tool runs in that turn).
 *   4. Mint a fallback UUID v7 (CLI, host without an active turn, or amendment whose predecessor has no anchor).
 */
export function resolveLaunchAnchor(input: {
  requested?: string;
  trace: TraceContext;
  resolveLaunchInputId?: (trace: TraceContext) => string | undefined;
  predecessor?: RunLaunchAnchor;
  mint?: () => string;
}): RunLaunchAnchor {
  if (input.predecessor !== undefined) return input.predecessor;
  const inputId =
    input.requested ?? input.resolveLaunchInputId?.(input.trace) ?? (input.mint ?? uuidv7)();
  return { inputId };
}
