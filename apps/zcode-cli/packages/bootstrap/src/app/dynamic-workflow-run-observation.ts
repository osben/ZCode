// ============================================================
// Dynamic Workflow Run observation helpers (the read-only half of the run service)
// ============================================================
// Snapshot/list/detail synthesis rules, split from dynamic-workflow-run-service.ts: that service
// owns entry points and gates, while this file owns the pure rules for composing registry + journal
// into public read surfaces (no I/O, no state).

import type { DwfRunListItem, DwfRunSessionListItem } from "@zcode/adapters/storage";
import {
  boundDynamicWorkflowRunEventPayload,
  DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES,
  DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS,
  type DynamicWorkflowRunError,
  type DynamicWorkflowRunHole,
  type DynamicWorkflowRunLogEntry,
  type DynamicWorkflowRunPendingQuestion,
  type DynamicWorkflowRunSessionSummary,
  type DynamicWorkflowRunSnapshot,
  type DynamicWorkflowRunStopReason,
  type DynamicWorkflowRunSummary,
} from "@zcode/contracts";
import type {
  JournalStorePort,
  RunRecord,
  RunSettlement,
  RunStatus,
  RunStopReason,
  StoredEvent,
  WorkflowErrorCode,
  WorkflowErrorJson,
} from "@zcode/dynamic-workflow";
import { artifactsOf } from "./dynamic-workflow-run-artifact-projection.js";
import { runLineageActiveMs } from "./dynamic-workflow-run-elapsed.js";
import {
  readRunModelBindings,
  readRunScriptPath,
  readRunSubagentModel,
} from "./dynamic-workflow-run-launch-anchor.js";
import { resolveDynamicWorkflowRunLabel } from "./dynamic-workflow-run-label.js";
import { lineageFields, supersededByOf } from "./dynamic-workflow-run-lineage.js";
import type { CompiledHole } from "./dynamic-workflow-run-holes.js";
import type { ActorSessionQuiescence } from "./workflow-driver-quiescence.js";
import type { WorkflowRunControl } from "./workflow-run-control.js";

/**
 * Artifact aggregation lives in dynamic-workflow-run-artifact-projection.ts (this file reached
 * oxlint's 400-line limit). Re-export unchanged instead of making four call sites change imports:
 * they depend on the observation surface, and this split was only for the line limit, not a boundary
 * change. A cross-module rename would make git blame point to a commit unrelated to the intent.
 */
export { artifactsOf };

/** Registry entry for an active or recently settled run. */
export interface RunRegistryEntry {
  controller: AbortController;
  startedAt: Date;
  toolCallId?: string;
  parentSessionId?: string;
  /**
   * In-memory copies of three submit-time metadata fields, used only in the **microtask gap between
   * submit → createRun**: the journal row does not exist yet, but enumeration must filter this run
   * by project (cwd) and provide labels (name / first script line). Once the row exists, the journal
   * is authoritative for all three and the copies are no longer read.
   */
  cwd: string;
  name?: string;
  scriptText: string;
  /**
   * Effective concurrency ceiling for this run (in-memory copy of `dwf_run.caps_max_concurrency`,
   * for the same gap rationale). submit / amend set it; **resume does not**, because it reuses the
   * journaled caps and that row already exists.
   */
  maxConcurrency?: number;
  /**
   * Live control surface for this run (docs/dynamic-workflow/concurrency.md "The control path").
   * Kept alongside, not merged with, {@link controller}: that is the only channel for "stop this
   * run," while this is the only channel for "change a run setting." Their recipients also differ
   * (harness signal vs engine and admission gate).
   *
   * All three entry-creation paths (submit / amend / resume) create one; launch connects both ends.
   * If the entry exists but its `setMaxConcurrency` handle returns false, the run settled between
   * those steps, so `retuneConcurrency` returns `not_live`.
   */
  control?: WorkflowRunControl;
  /**
   * Subagent model for this run (in-memory copy of the canonical picker string on the `run-launched`
   * event, `providerId/modelId[$reasoningLevel]`). Same gap rationale: AmendWorkflow's resolveInput
   * reads the snapshot to decide what to inherit, and an amendment of a just-started run can land in
   * the microtasks between submit and the engine recording the event.
   *
   * **All three entry paths set it**: submit / amend use the just-normalized string, and resume
   * reads the event header once and copies it. The value is fixed when the run is created and never
   * changes, so the copy cannot diverge from the event. Read surfaces follow one rule: use the entry
   * when present, and scan events only for cold rows (no entry in this process). Omission means
   * subagents use the session model.
   */
  subagentModel?: string;
  /**
   * Model bindings named by this run's script (in-memory copy of `modelBindings` on the
   * `run-launched` event; docs/dynamic-workflow/launch.md "Models the script names"). Same rules as
   * {@link subagentModel}: all three entry-creation paths set it, it never changes afterward, and
   * read surfaces read the entry when present. Omission means the script named no models.
   */
  modelBindings?: Record<string, string>;
  /**
   * Script file for this run (in-memory copy of the absolute path on the `run-launched` event).
   * Follows the same rules as {@link subagentModel}: all three entry paths set it (submit / amend
   * use the input, resume reads and copies the event header once), and the value is fixed at run
   * creation so the copy cannot diverge from the event. Omission means this run has no file.
   */
  scriptPath?: string;
  /** Predecessor of an amended run (in-memory copy of `dwf_run.resumed_from`, the only enumeration source before the journal row exists). */
  resumedFrom?: string;
  /**
   * Hole fact table of the **currently effective script** (docs/execution-engine.md "Holes"): the
   * snapshot's `type` / `line` and the progress payload's `type` read it. All three entry-creation
   * paths set it from the compiled artifact; a fill replaces it with the effective script's table —
   * holes nested inside a function body appear this way. It is replaced in lockstep with
   * `scriptText`; both must describe the same script.
   */
  holes?: readonly CompiledHole[];
  /**
   * Phase table in effect at this moment (holes keyed by name): submit / amend copy the table
   * supplied by the submitter, resume reads it back from the event, and a fill replaces it with the
   * effective script's table (the same one the engine records on `hole-filled`). The snapshot's
   * before / after read it.
   */
  phaseNames?: readonly string[];
  /**
   * Usage baseline for this run (`spentTokens` after predecessor settlement). Same gap rationale:
   * before the row is persisted, both read surfaces can read usage only from the entry, and an
   * amendment of a just-started run can land in those microtasks. **Only amend sets it**: fresh
   * submit starts from zero, and the resume row already exists.
   */
  inheritedTokens?: number;
  /**
   * **Session-quiescence probe** supplied by this run's driver (workflow-driver-quiescence.ts).
   * Filled during driver construction, so it is absent from a newly created entry; during that gap,
   * the run has not created any actor sessions to query.
   *
   * Only amend reads it: after superseding an active predecessor, it must confirm those sessions
   * finished writing before continuing an unfinished ask (`inFlight`). The probe belongs to this
   * entry, one per run, and lives as long as the driver; no separate process-level registry is needed.
   */
  quiescence?: ActorSessionQuiescence;
  /** Settlement promise awaited by waitForTask; the fire-and-forget chain is attached here. */
  settlement: Promise<RunSettlement>;
  /** Terminal state after settlement (artifact / error lives only here; the journal does not store script return values). */
  terminal?: RunSettlement;
  completedAt?: Date;
  /**
   * Whether the log "journal row is a foreign terminal state" was already recorded for this entry
   * (see precedence notes in {@link synthesizeRunStatus}). The tracker polls every second; without
   * this marker, it would emit the same warning every second.
   */
  foreignTerminalLogged?: true;
}

/**
 * Set of terminal run states (excluding pending / running).
 * This is the **single authority** for what counts as terminal: journal SQL performs only an
 * index-friendly prefilter, and this set is checked again before reconciliation so a future
 * nonterminal state requires a change in only one place.
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "errored",
  "stopped",
]);

/**
 * Compose a snapshot from the journal row and live registry. If neither contains the run, return
 * undefined (the caller normalizes this to lost).
 *
 * The caller projects `pendingQuestions` from the **in-memory** escalation table (this file does no
 * I/O and holds no state). An empty array means there are no pending questions, so omit the field
 * entirely rather than sending an empty array.
 *
 * The caller also supplies `defaultConcurrency` (reading it probes process CPU count = I/O).
 * Omission means this read does not evaluate the default and omits `maxConcurrency` entirely; see
 * {@link runConcurrencyField}.
 */
export function snapshotOf(
  taskId: string,
  runs: Map<string, RunRegistryEntry>,
  journal: JournalStorePort,
  pendingQuestions: readonly DynamicWorkflowRunPendingQuestion[] = [],
  defaultConcurrency?: number,
  /**
   * Holes (docs/execution-engine.md "The run snapshot"), projected by the caller under the same
   * rule as `pendingQuestions` (`waiting` needs the engine's parked table, which is live state
   * outside this I/O boundary); empty means the entire field is absent.
   */
  holes: readonly DynamicWorkflowRunHole[] = [],
): DynamicWorkflowRunSnapshot | undefined {
  const entry = runs.get(taskId);
  const record = journal.getRun(taskId);
  if (entry === undefined && record === undefined) return undefined;

  // Single implementation of status synthesis (see {@link synthesizeRunStatus}). The snapshot
  // vocabulary has no pending state, so collapse it at the last step: runStatusToTaskStatus maps
  // pending and running to running, preserving the existing behavior that a registry entry means
  // the run is active. Without this, the first poll after submit would classify the run as lost.
  const status: DynamicWorkflowRunSnapshot["status"] = runStatusToTaskStatus(
    synthesizeRunStatus(entry, record?.status),
  );

  // reports / artifacts / active duration are read only at terminal state: their only consumers are
  // terminal notifications and terminal TaskOutput, while snapshots are repeatedly polled by the
  // background tracker — reading them while in flight has no readers, only cost.
  const settled = status !== "running";

  // Active duration of the lineage (docs/dynamic-workflow/transcript-and-notifications.md "How long it took").
  const activeDurationMs = settled ? runLineageActiveMs(journal, taskId) : undefined;

  // Actual terminal state + stop reason + structured failure
  // (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md): the snapshot base `status`
  // uses the background task tracker's generic vocabulary (stopped becomes cancelled, errored
  // becomes failed), so notifications need these three fields to report the real result. Omit them
  // before terminal state because no final outcome exists yet.
  const runStatus = synthesizeRunStatus(entry, record?.status);
  const terminal = TERMINAL_RUN_STATUSES.has(runStatus);
  const stopReason = terminal ? stopReasonOf(entry, record) : undefined;
  const failure = terminal ? terminalErrorField(runStatus, entry, record).error : undefined;
  const error = failure?.message;
  // Ownership: AmendWorkflow's resolveInput reads the snapshot to determine whether the run belongs
  // to this session. See lineageFields for the lineage endpoint pointers.
  const parentSessionId = entry?.parentSessionId ?? record?.parentSessionId;

  return {
    runId: taskId,
    taskId,
    startedAt: entry?.startedAt ?? new Date(0),
    status,
    ...(terminal ? { runStatus } : {}),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...lineageFields(entry?.resumedFrom ?? record?.resumedFrom, supersededByOf(entry, record)),
    // Prefer the in-memory copy to the journal, like every gap field above: the row does not exist
    // during the microtasks between submit and createRun, when AmendWorkflow's resolveInput may read this snapshot.
    ...runConcurrencyField(
      entry?.maxConcurrency ?? record?.caps.maxConcurrency,
      defaultConcurrency,
    ),
    // Subagent model: **read the entry when present** (all three entry paths set it; see
    // RunRegistryEntry.subagentModel). Only scan the event header for a cold row (bounded scan of
    // eight events, not the whole journal). There is no "worth mentioning" check as with the
    // concurrency ceiling: it exists only when explicitly set, and presence carries the full
    // meaning. Omission means use the session model.
    ...runSubagentModelField(
      entry === undefined ? readRunSubagentModel(journal, taskId) : entry.subagentModel,
    ),
    // Script file: same rules as the subagent model (read the entry when present, scan the event
    // header only for cold rows) and likewise "present only when recorded." Terminal notifications
    // use it to suggest "edit this file in place," so the snapshot must include it.
    ...runScriptPathField(
      entry === undefined ? readRunScriptPath(journal, taskId) : entry.scriptPath,
    ),
    // Models named by the script: same rules as the subagent model. AmendWorkflow and the GUI
    // "configuration" view use it to let bindings with the same name carry over.
    ...runModelBindingsField(
      entry === undefined ? readRunModelBindings(journal, taskId) : entry.modelBindings,
    ),
    ...(failure === undefined ? {} : { failure }),
    ...(activeDurationMs === undefined ? {} : { activeDurationMs }),
    ...(entry?.completedAt === undefined ? {} : { completedAt: entry.completedAt }),
    ...(error === undefined ? {} : { error }),
    // When there are no items, omit the entire field (same as reports) so readers remove the pending section instead of rendering it empty.
    ...(pendingQuestions.length === 0 ? {} : { pendingQuestions }),
    ...(holes.length === 0 ? {} : { holes }),
    ...(settled ? reportsOf(taskId, journal) : {}),
    // User-facing artifacts. ⚠ This is **different from** the adjacent `output`
    // (`entry.terminal.artifact` = script's top-level return value, also called artifact inside the
    // engine): this is output published for users through `artifact.*`, while that is returned to the model.
    ...(settled ? artifactsOf(taskId, journal) : {}),
    ...(entry?.terminal?.status === "completed"
      ? { output: entry.terminal.artifact }
      : // After restart, this process's registry is empty, so artifacts can only be read from journal records (migration 0020's
        // result_json). In-memory terminal state takes precedence above; it is the original value just received from this process's engine.
        record?.status === "completed" && record.result !== undefined
        ? { output: record.result }
        : {}),
  };
}

/**
 * `maxConcurrency` on both read surfaces (`getTask` snapshot and `getRunDetail` detail)
 *
 * **Present only when different from the default concurrency** (above or below both count): a run
 * at the default has nothing to report; that is the default behavior, and attaching the default
 * value to every row would make the model read "unlimited" as "limited." If the caller omits the
 * default, omit the entire field as well: without the comparison, reporting a number would be a guess.
 *
 * One implementation is shared by both read surfaces; separate checks would eventually disagree on
 * whether a value equal to the default should be present.
 */
export function runConcurrencyField(
  applied: number | undefined,
  defaultConcurrency: number | undefined,
): { maxConcurrency?: number } {
  if (applied === undefined || defaultConcurrency === undefined || applied === defaultConcurrency) {
    return {};
  }
  return { maxConcurrency: applied };
}

/**
 * `subagentModel` on both read surfaces (`getTask` snapshot and `getRunDetail` detail)
 *
 * One rule: **present only if configured**. Unlike {@link runConcurrencyField}, there is no
 * comparable default here: "uses the session model" is not a string that belongs in this field, and
 * filling in the current session model would make readers interpret "not set" as "set to the
 * session model." Those are distinct states in amend's three-state input.
 *
 * One implementation is shared by both read surfaces, for the same reason as the concurrency ceiling.
 */
export function runSubagentModelField(subagentModel: string | undefined): {
  subagentModel?: string;
} {
  return subagentModel === undefined ? {} : { subagentModel };
}

/** `modelBindings` on both read surfaces: same rule as {@link runSubagentModelField}, present only when recorded (and non-empty). */
export function runModelBindingsField(modelBindings: Record<string, string> | undefined): {
  modelBindings?: Record<string, string>;
} {
  return modelBindings === undefined || Object.keys(modelBindings).length === 0
    ? {}
    : { modelBindings };
}

/**
 * `scriptPath` on both read surfaces. Same rule as {@link runSubagentModelField}: **present only
 * when recorded**, with no comparable default. "This run has no script file" is not a path that can
 * be stored in this field, and guessing a path would send the model to edit a file unrelated to the
 * run. One implementation is shared by both read surfaces.
 */
export function runScriptPathField(scriptPath: string | undefined): { scriptPath?: string } {
  return scriptPath === undefined ? {} : { scriptPath };
}

/**
 * `reports` and `reportCount` on a terminal snapshot: journal node rows with `kind = "report"`
 * (written once, always `completed`, reported item in `result`), in insertion order = report order.
 *
 * Why read from the journal instead of the projection: `workflowRuns.reports` is a bounded,
 * memory-only display surface (empty after cold recovery), while these rows are the **durable home**
 * for those items. Completion notifications must include artifacts for failed / cancelled runs too:
 * a run that failed on ask 12 still completed 11 asks, which is why `report` exists. Therefore read
 * the durable copy.
 *
 * Read only the first {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS} items, at most
 * {@link DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES} bytes of items, with the total from a single
 * `count(*)` (docs/execution-engine.md "Reading the journal"). Fix rationale: this used to read the
 * entire node table with every report item into memory — a fully reported run had to decode
 * GiB-scale items at settlement, while the notification section's character budget only fits a few
 * dozen. A count limit alone is not enough: with a 1 MiB per-item cap, 256 items are 256 MiB. When
 * there are none, both fields are absent so notifications drop the whole `<reports>` section
 * instead of sending an empty one.
 */
function reportsOf(
  taskId: string,
  journal: JournalStorePort,
): { reports?: readonly unknown[]; reportCount?: number } {
  const reportCount = journal.countNodes(taskId, "report");
  if (reportCount === 0) return {};
  const reports = journal
    .listNodes(taskId, {
      kinds: ["report"],
      withResult: true,
      limit: DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS,
      maxResultBytes: DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORT_BYTES,
    })
    .map((node) => node.result);
  return { reports, reportCount };
}

/**
 * **Only implementation for synthesizing authoritative status**, with four priority levels:
 *   in-memory terminal state > active entry (trust journal only when nonterminal) > journal status >
 *   "in registry but row not written yet."
 *
 * While this process's engine is still active, a journal terminal row may have come from orphan
 * reconciliation by another instance and must not end local tracking. Prefer in-memory terminal
 * state after local settlement. The second level handles an active, unsettled entry: ignore foreign
 * terminal rows and wait for the engine to settle, avoiding premature model notification and losing
 * the actual completion result after marking the task complete.
 *
 * Shared by all three read surfaces (snapshot, list, detail). Return the journal's {@link RunStatus}
 * vocabulary rather than snapshot status because it is more precise: `pending` (accepted, engine
 * has not written a row yet) is a useful distinction for model introspection. The snapshot surface
 * collapses it into `running` only because of its own vocabulary limits
 * ({@link runStatusToTaskStatus} performs the collapse). Collapsing earlier and reconstructing it
 * later would require downstream code to guess which kind of `running` it is.
 */
function synthesizeRunStatus(
  entry: RunRegistryEntry | undefined,
  journalStatus: RunStatus | undefined,
): RunStatus {
  // In-memory terminal state takes priority: settlement just received from this process's engine
  // is newer than the journal row, which may not be fully written yet.
  if (entry?.terminal !== undefined) return terminalRunStatus(entry.terminal);
  // Here, `entry !== undefined` means an active run owned by this service. A terminal journal row
  // can only be an external write, so ignore it and report the run active. Trust nonterminal rows
  // (pending / running) as they were written by the engine. Block only terminal rows: the gap where
  // `journalStatus` is absent must still fall through to `pending` below (a more precise state that
  // model introspection understands).
  if (
    entry !== undefined &&
    journalStatus !== undefined &&
    TERMINAL_RUN_STATUSES.has(journalStatus)
  ) {
    return "running";
  }
  if (journalStatus !== undefined) return journalStatus;
  // Registry exists, journal does not: microtask gap between submit → createRun. `pending` is the
  // **only honest** status at this moment: the run is accepted, but the engine has not written any rows.
  return "pending";
}

function terminalRunStatus(settlement: RunSettlement): RunStatus {
  switch (settlement.status) {
    case "completed":
      return "completed";
    case "stopped":
      return "stopped";
    default:
      return "errored";
  }
}

/**
 * Map logical terminal state to the background task tracker's generic vocabulary. The tracker is
 * shared with bash / subagent tasks and does not know stopped / errored: stopped becomes
 * `cancelled`, errored becomes `failed`. The real state is exposed separately in snapshot's
 * `runStatus` / `stopReason`.
 */
function runStatusToTaskStatus(status: RunStatus): DynamicWorkflowRunSnapshot["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "errored":
      return "failed";
    case "stopped":
      return "cancelled";
    // pending / running are both still active.
    default:
      return "running";
  }
}

/**
 * Stop reason: prefer in-memory terminal state (settlement just received from this process's
 * engine), then the journal row. Meaningful only for stopped; return undefined for other states.
 *
 * Same precedence as {@link synthesizeRunStatus}: **an active entry has no stop reason**. If the row
 * contains one, it must be an external write. All three read surfaces must agree; status "active"
 * with reason "interrupted" would be harder to diagnose than either value being wrong.
 */
function stopReasonOf(
  entry: RunRegistryEntry | undefined,
  record: { status?: RunStatus; stopReason?: RunStopReason } | undefined,
): DynamicWorkflowRunStopReason | undefined {
  if (entry?.terminal !== undefined) {
    return entry.terminal.status === "stopped" ? entry.terminal.reason : undefined;
  }
  if (entry !== undefined) return undefined;
  if (record?.status === "stopped") return record.stopReason ?? "user";
  return undefined;
}

/**
 * Journal row (plus optional in-memory entry) → common intersection for list and detail.
 *
 * Read timestamps **directly from the journal row**, intentionally bypassing {@link snapshotOf}'s
 * `new Date(0)` fallback: after the in-memory entry is evicted, that start time is fabricated, and
 * introspection time is what the model uses to judge "how long ago."
 */
export function journalRunSummary(
  row: DwfRunListItem,
  entry: RunRegistryEntry | undefined,
  ownerSessionId: string,
): DynamicWorkflowRunSummary {
  const ownedByThisSession = entry !== undefined || row.parentSessionId === ownerSessionId;
  // Read **journal** status rather than the synthesized value: the meaning is "the journal says it
  // has not finished, but this session cannot verify it." (They are necessarily equal in this
  // branch—another session and absent from this registry, so no in-memory terminal state can
  // override the journal. Keep the literal source to preserve this assertion if another truth source is added.)
  const possiblyInterrupted = !TERMINAL_RUN_STATUSES.has(row.status) && !ownedByThisSession;
  const stopReason = stopReasonOf(entry, row);
  return {
    runId: row.runId,
    ...resolveDynamicWorkflowRunLabel({
      runId: row.runId,
      ...(row.name === undefined ? {} : { name: row.name }),
      ...(row.scriptText === undefined ? {} : { scriptText: row.scriptText }),
    }),
    status: synthesizeRunStatus(entry, row.status),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...lineageFields(entry?.resumedFrom ?? row.resumedFrom, supersededByOf(entry, row)),
    ownedByThisSession,
    // Present only when true: omission means "no such concern," while false would add a noisy field to every row.
    ...(possiblyInterrupted ? { possiblyInterrupted: true } : {}),
    createdAt: row.timeCreated,
    updatedAt: row.timeUpdated,
  };
}

/**
 * Run with only an in-memory entry (microtask gap between submit → createRun) → common intersection.
 *
 * Ownership is always true (the run is in this session's registry), so it never includes
 * `possiblyInterrupted`. Use the registration timestamp; this is not a fallback guess but the
 * actual submission time (the journal row records the same millisecond-level `Date.now()`).
 */
export function registryRunSummary(
  runId: string,
  entry: RunRegistryEntry,
): DynamicWorkflowRunSummary {
  return {
    runId,
    ...resolveDynamicWorkflowRunLabel({
      runId,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      scriptText: entry.scriptText,
    }),
    status: synthesizeRunStatus(entry, undefined),
    ...(entry.terminal?.status === "stopped" ? { stopReason: entry.terminal.reason } : {}),
    ...lineageFields(entry.resumedFrom, supersededByOf(entry, undefined)),
    ownedByThisSession: true,
    createdAt: entry.startedAt.getTime(),
    updatedAt: (entry.completedAt ?? entry.startedAt).getTime(),
  };
}

/**
 * Only completed runs include artifacts, and an `undefined` artifact means **omit the entire field** (same as completion notifications).
 *
 * Same precedence as {@link snapshotOf}: the in-memory terminal artifact is the **original value**
 * just received from this process's engine; journal result_json is its shape after a JSON round trip
 * and is used only after entry eviction. Return the value **unchanged and unserialized**—core has a
 * single model-facing text projection, and another port-side projection would make the same artifact
 * look different in notifications and tools.
 */
export function terminalResultField(
  status: RunStatus,
  entry: RunRegistryEntry | undefined,
  row?: { result?: unknown },
): { result?: unknown } {
  if (status !== "completed") return {};
  if (entry?.terminal?.status === "completed" && entry.terminal.artifact !== undefined) {
    return { result: entry.terminal.artifact };
  }
  // `result: null` is a valid artifact (`ask<T | null>` can return it), so check `!== undefined`
  // rather than truthiness. The decoder likewise writes this key only when the column is non-NULL.
  return row?.result === undefined ? {} : { result: row.result };
}

/**
 * errored always has a failure; stopped includes one only for provider / interrupted (user / model
 * stops are not failures). Journal `failure_json` is **authoritative** and contains a structured
 * code, allowing the model to distinguish `Interrupted` (process died), `ProviderStop`
 * (deterministic model-side error), and `DriverError` (script failure). Expose the code unchanged;
 * never collapse it into a generic failure. Include structured details for `ProviderStop` too.
 */
export function terminalErrorField(
  status: RunStatus,
  entry: RunRegistryEntry | undefined,
  row?: { failure?: WorkflowErrorJson },
): { error?: DynamicWorkflowRunError } {
  if (status !== "errored" && status !== "stopped") return {};
  // In-memory terminal state takes precedence: settlement just received from this process's engine
  // has the original value (including full ProviderStop details); the journal row has its
  // post-JSON-round-trip shape and is used only after entry eviction.
  const memoryError =
    entry?.terminal?.status === "errored"
      ? entry.terminal.error
      : entry?.terminal?.status === "stopped"
        ? entry.terminal.error
        : undefined;
  if (memoryError !== undefined) {
    // Failures before engine construction (child process could not spawn, constructor threw) put a
    // wrapped plain Error in the registry; it may have no code at runtime. Classify it as
    // DriverError instead of inventing a new code: these failures truly come from the driver layer,
    // outside the engine.
    const code = typeof memoryError.code === "string" ? memoryError.code : "DriverError";
    const providerStop = (memoryError as { providerStop?: WorkflowErrorJson["providerStop"] })
      .providerStop;
    return {
      error: {
        code,
        message: memoryError.message,
        ...(providerStop === undefined ? {} : { providerStop }),
      },
    };
  }
  if (row?.failure !== undefined) {
    return {
      error: {
        code: row.failure.code,
        message: row.failure.message,
        ...(row.failure.providerStop === undefined
          ? {}
          : { providerStop: row.failure.providerStop }),
      },
    };
  }
  return {};
}

/**
 * One journal `log` event → one logTail item on the port.
 *
 * Bound messages with {@link boundDynamicWorkflowRunEventPayload} instead of slicing locally: the
 * string limit (2048) and surrogate-safe truncation rule already live on the port side, and copying
 * them here could diverge after a future tuning change. The query pushes down `type='log'` filtering,
 * so a non-log event indicates implementation drift; return an empty message rather than failing the
 * entire detail surface.
 */
export function toLogTailEntry(stored: StoredEvent): DynamicWorkflowRunLogEntry {
  const message = stored.event.type === "log" ? stored.event.message : "";
  const { payload } = boundDynamicWorkflowRunEventPayload({ message });
  return {
    sequence: stored.sequence,
    message: typeof payload.message === "string" ? payload.message : "",
    // Pass through the persisted timestamp; legacy journal rows without this column omit it (readers then show no age).
    ...(stored.timeCreated === undefined ? {} : { at: stored.timeCreated }),
  };
}

/** Await settlement while respecting the caller's signal (interrupting the wait does not cancel the run). */
export async function settleOrAbort(
  settlement: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) {
    await settlement;
    return;
  }
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    void settlement.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
    );
  });
}

/**
 * Failure code written by orphan reconciliation (host-level value, never produced by the engine).
 * Persisted with `stopped(interrupted)`: status + stopReason already say "interrupted by process
 * death," and this code is a second piece of evidence for the same fact (legacy rows have only it).
 */
export const INTERRUPTED_FAILURE_CODE: WorkflowErrorCode = "Interrupted";

/**
 * Sole predicate for the resume gate: **stopped is resumable**, except `superseded`—its unfinished
 * work belongs to the successor, and replaying it would duplicate work against a workspace the
 * successor is modifying. errored / completed are not resumable.
 * {@link DynamicWorkflowRunSessionSummary.resumable} uses the same predicate; if the UI derives it
 * again from status, the two rules will eventually disagree and show an enabled button for a
 * command that is refused.
 */
export function isResumableRecord(record: Pick<RunRecord, "status" | "stopReason">): boolean {
  return isResumableSettlement(record.status, record.stopReason);
}

/**
 * Settlement-fact form of the same predicate: it computes the `resumable` bit on `run-settled`
 * payloads (live via toProgressPayload from engine events, cold replay via journal-row seeding); the reducer only transports it.
 */
export function isResumableSettlement(status: RunStatus, stopReason?: RunStopReason): boolean {
  return status === "stopped" && stopReason !== "superseded";
}

/**
 * Enumeration row → session enumeration summary. Three values intentionally share sources with other surfaces:
 *   - `resumable` uses the same predicate as the resume gate ({@link isResumableRecord});
 *   - `label` uses the derivation shared by both read surfaces ({@link resolveDynamicWorkflowRunLabel});
 *     adding a separate fallback here could make the same run show different names in `/dwf list` and tool cards;
 *   - `updatedAt` reads `timeUpdated` directly from the journal row (`RunRecord` has no timestamp, so this accepts an enumeration row).
 */
export function toSessionSummary(
  row: DwfRunSessionListItem,
  entry?: RunRegistryEntry,
): DynamicWorkflowRunSessionSummary {
  const { label } = resolveDynamicWorkflowRunLabel({
    runId: row.runId,
    ...(row.name === undefined ? {} : { name: row.name }),
    ...(row.scriptText === undefined ? {} : { scriptText: row.scriptText }),
  });
  // The fourth read surface uses the same precedence ({@link synthesizeRunStatus}): a terminal row
  // under a live entry is an external write, so report running and omit stop reason and failure.
  // Without this branch, the session list alone would show a run as stopped while snapshot / list /
  // detail all report it active.
  const status = synthesizeRunStatus(entry, row.status);
  const stopReason = stopReasonOf(entry, row);
  const live = entry !== undefined && entry.terminal === undefined;
  return {
    runId: row.runId,
    ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
    label,
    updatedAt: row.timeUpdated,
    status,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...lineageFields(row.resumedFrom, supersededByOf(entry, row)),
    ...(live || row.failure?.code === undefined ? {} : { failureCode: row.failure.code }),
    ...(live || row.failure?.message === undefined ? {} : { failureMessage: row.failure.message }),
    resumable: isResumableSettlement(status, stopReason),
  };
}
