// ============================================================
// Launch anchor for a dwf run.
// ============================================================
// A subagent's agent_step must be attributed to the turn that launched this run. The anchor is an inputId
// stored without SQL in the journal's `run-launched` event (written only once when creating the run):
//   - This file resolves it at submission time (active turn / value minted for direct launch / predecessor run's anchor / fallback value)
//     and passes it to the engine to persist.
//   - Resume and progress-event derivation read it back from the journal, so the same run retains one anchor across lifecycles.
//
// The same event also carries several related pieces of host metadata: the script-declared phase table (`phaseNames`), the run's subagent
// model selection (`subagentModel`) and permission mode (`subagentPermissionMode`, see "Permissions inside a run" in
// docs/dynamic-workflow/launch.md), the script-named model binding table (`modelBindings`), and the file the script came from
// (`scriptPath`, see "Script files" in docs/dynamic-workflow/launch.md). All of them are written once when the run is created,
// never read by the engine, and require no SQL—`dwf_run`
// has no corresponding columns.

import type { TraceContext } from "@zcode/contracts";
import type { JournalStorePort, RunEvent } from "@zcode/dynamic-workflow";
import { uuidv7 } from "@zcode/shared";
import {
  parseWorkflowSubagentPermissionMode,
  type WorkflowSubagentPermissionMode,
} from "./workflow-actor-permission.js";

export interface RunLaunchAnchor {
  /** inputId of the turn that launched the run (a minted UUID v7 for direct hub launches). */
  inputId: string;
}

/**
 * All data passed to the engine for the `run-launched` event: anchor + script-declared phase table + this run's subagent selection (`subagentModel`, canonical picker string
 * `providerId/modelId[$reasoningLevel]`).
 *
 * The latter two are **not** part of the anchor: an amended run reuses the predecessor's inputId but uses the new script's phase table, and never inherits
 * the predecessor's model ("omitted means inherit predecessor" is the tool surface's three-state value, normalized by AmendWorkflow's resolveInput).
 * Therefore these fields are combined with the anchor in submit rather than placed in {@link resolveLaunchAnchor}.
 */
export interface RunLaunch extends RunLaunchAnchor {
  phaseNames?: string[];
  subagentModel?: string;
  /**
   * Model names used by the script → canonical strings (see "Models the script names" in docs/dynamic-workflow/launch.md). Like the subagent
   * selection, not part of the anchor: an amendment's binding table is normalized by AmendWorkflow's resolveInput (same name keeps the predecessor's entry); ports do not inherit it.
   */
  modelBindings?: Record<string, string>;
  /**
   * Absolute path to this run's script file. Like the phase table and
   * subagent selection, it is not part of the anchor: an amendment records the script file for **this amendment**, never the predecessor's.
   */
  scriptPath?: string;
  /**
   * Permission mode for this run's subagents (see "Permissions inside a run" in docs/dynamic-workflow/launch.md):
   * the launching session's permission mode (plan is not carried in). Likewise not part of the anchor: an amendment is a new run and takes
   * the session's mode at amendment time, never the predecessor's.
   */
  subagentPermissionMode?: WorkflowSubagentPermissionMode;
  /** "Run together" table aligned by index with `phaseNames`; also written to the journal only when the run is created. */
  phaseAlongside?: number[][];
}

/**
 * The run's first `run-launched` (written to the journal only when the run is created). Type filtering and `limit: 1` are both pushed down
 * to the storage layer (see "Reading the journal" in docs/execution-engine.md): one query, one row—no need to read the journal's
 * first 8 events and search in memory as before.
 */
function firstRunLaunched(
  journal: JournalStorePort,
  runId: string,
): Extract<RunEvent, { type: "run-launched" }> | undefined {
  const [stored] = journal.listEvents(runId, {
    types: ["run-launched"],
    reportItems: { limit: 0 },
    limit: 1,
  });
  return stored?.event.type === "run-launched" ? stored.event : undefined;
}

/**
 * Read the run's anchor from the first `run-launched` event in the journal. Runs launched before the upgrade do not have this event, so return `undefined`;
 * the caller then omits `launchInputId` (the facts layer consequently emits no `workflow.lifecycle`; do not report subagents or synthesize one).
 */
export function readRunLaunchAnchor(
  journal: JournalStorePort,
  runId: string,
): RunLaunchAnchor | undefined {
  const launched = firstRunLaunched(journal, runId);
  return launched === undefined ? undefined : { inputId: launched.inputId };
}

/**
 * Read the run's subagent selection from `subagentModel` on the same `run-launched` event. Resume, both read surfaces, and cold replay use it to reconstruct the same canonical string—
 * zero SQL; `dwf_run` has no such column. If absent, the subagent uses the session model (the case for most runs, including those launched before the upgrade).
 *
 * Read from the same event as the anchor, but **deliberately do not attach it** to {@link RunLaunchAnchor}:
 * {@link resolveLaunchAnchor} makes amended runs reuse the predecessor's anchor, but the model must never be inherited that way. Its three-state tool value
 * (omitted = inherit predecessor, null = return to session model, string = set explicitly) is normalized by `AmendWorkflow`'s resolveInput, following the same rationale as `max_concurrency`.
 */
export function readRunSubagentModel(journal: JournalStorePort, runId: string): string | undefined {
  return firstRunLaunched(journal, runId)?.subagentModel;
}

/**
 * Read the script-named models for this run from `modelBindings` on the same `run-launched` event
 * (see "Models the script names" in docs/dynamic-workflow/launch.md). Subagent session creation (including resume), both read surfaces, and
 * cold replay use it to map the model names in personas to canonical strings—the names were resolved once at launch and are never re-resolved
 * against the catalog afterwards, so a resumed run still runs the same models the user approved. If absent, the script named no models.
 *
 * Read from the same event as {@link readRunSubagentModel}, and not attached to the anchor for the same reason.
 */
export function readRunModelBindings(
  journal: JournalStorePort,
  runId: string,
): Record<string, string> | undefined {
  return firstRunLaunched(journal, runId)?.modelBindings;
}

/**
 * Read this run's subagent permission mode from `subagentPermissionMode` on the same `run-launched` event
 * (see "Permissions inside a run" in docs/dynamic-workflow/launch.md). Resume uses it to keep subagents running in the
 * mode in effect when the run was created, regardless of the session's current mode. Absent or unknown values mean YOLO (including runs launched before this feature).
 */
export function readRunSubagentPermissionMode(
  journal: JournalStorePort,
  runId: string,
): WorkflowSubagentPermissionMode | undefined {
  const launched = firstRunLaunched(journal, runId);
  return launched === undefined
    ? undefined
    : parseWorkflowSubagentPermissionMode(launched.subagentPermissionMode);
}

/**
 * Read this run's script file from `scriptPath` on the same `run-launched` event
 * (the Provenance section of "Script files" in docs/dynamic-workflow/launch.md). Both read surfaces use it on cold paths to
 * reconstruct the same absolute path—zero SQL; `dwf_run` has no such column. If absent, this run has no editable script file
 * (the project cannot save drafts, or the run predates this feature).
 *
 * Read from the same event as {@link readRunSubagentModel}, likewise **deliberately not attached**
 * to {@link RunLaunchAnchor}: amendments reuse the anchor, but the predecessor's script path points to the old script,
 * so reusing it would make the model next edit a file that is no longer running.
 */
export function readRunScriptPath(journal: JournalStorePort, runId: string): string | undefined {
  // A fill can mint one for a run without a draft (see "The draft after a fill" in docs/dynamic-workflow/launch.md);
  // the path lands in the journal with that `hole-filled` event, and the last one present wins over the run-creation record. A narrow read
  // with type filtering: the vast majority of runs have no hole-filled events at all.
  let minted: string | undefined;
  for (const { event } of journal.listEvents(runId, {
    types: ["hole-filled"],
    reportItems: { limit: 0 },
  })) {
    if (event.type === "hole-filled" && event.scriptPath !== undefined) minted = event.scriptPath;
  }
  return minted ?? firstRunLaunched(journal, runId)?.scriptPath;
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
