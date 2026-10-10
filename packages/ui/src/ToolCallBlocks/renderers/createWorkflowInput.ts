/**
 * Read rules for CreateWorkflow tool inputs.
 *
 * Extracted from `create-workflow.tsx`: these are pure functions, while the card component grows linearly with run state/diagnostics/graph interactions.
 * Keeping them together pushed that file over oxlint max-lines (400); `rows.ts → toolDisplay.ts` and `ToolCallBlocks.tsx → resolveRenderer.ts` are precedents. This file has no JSX and does not render UI.
 *
 * One definition, three consumers—the chat card, launch confirmation dialog, and run details page—so each surface reads the same input consistently.
 */

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Phases for the in-progress kind label (before a run is linked). “Validation” applies only in the `running` phase: the script is analyzed in `prepareApproval`
 * before the confirmation dialog, while the model’s `inputStreaming` phase can last tens of seconds. The phase comes only from the v4 state attached verbatim to raw by the adapter; if absent, do not guess.
 *
 * When `amend` is true, use revision wording:
 * same renderer and phases, different labels—the model is editing something the user is already looking at, not launching something.
 */
export function readWorkflowKindMessageId(
  raw: unknown,
  isRunning: boolean,
  amend = false,
  /**
   * This call only adjusts the concurrency limit (`isWorkflowRetuneInput`): it does not write or compile a script, so do not mention “validation” at all while it is in flight. The revision vocabulary’s `writing` label (“Adjusting workflow”) is always true for it—whether it applies in place or (if the run has settled) falls back to a true revision—so use it throughout the in-flight period instead of adding a label for a phase that lasts only a few hundred milliseconds. Awaiting confirmation is different: its own wording is more informative while that phase is present.
   */
  retuning = false,
): string {
  const ids = amend ? AMEND_KIND_IDS : CREATE_KIND_IDS;
  if (!isRunning) {
    return ids.ran;
  }

  const v4Status = isPlainRecord(raw) ? raw.v4Status : undefined;
  if (v4Status === "pendingApproval") {
    return ids.awaitingConfirmation;
  }
  if (v4Status === "inputStreaming" || retuning) {
    return ids.writing;
  }

  return ids.running;
}

/**
 * Kind label for the pre-launch ToolLayout row:
 * - Compile error (display exists and `ok === false`): “Workflow draft (revision draft)”—nothing ran; this draft needs corrections.
 * - Failure without display (rejected / tool error): still “Workflow (revision)”;
 * - Writing: “Writing (revision),” or “Editing…” from draft 2 onward—the model is responding to feedback rather than starting over;
 * - Otherwise: awaiting confirmation.
 * Uses the same vocabulary as `readWorkflowKindMessageId`, with the phase already computed by the renderer.
 */
export function readWorkflowPrelaunchKindMessageId(
  phase: { compileErrors: boolean; failed: boolean; writing: boolean; revising: boolean },
  amend: boolean,
): string {
  const ids = amend ? AMEND_KIND_IDS : CREATE_KIND_IDS;
  if (phase.compileErrors) return ids.draft;
  if (phase.failed) return ids.ran;
  if (phase.writing) return phase.revising ? ids.revising : ids.writing;
  return ids.awaitingConfirmation;
}

interface WorkflowKindIds {
  writing: string;
  revising: string;
  awaitingConfirmation: string;
  running: string;
  ran: string;
  draft: string;
}

const CREATE_KIND_IDS: WorkflowKindIds = {
  writing: "chat.toolCall.workflow.writing",
  revising: "chat.toolCall.workflow.revising",
  awaitingConfirmation: "chat.toolCall.workflow.awaitingConfirmation",
  running: "chat.toolCall.workflow.running",
  ran: "chat.toolCall.workflow.ran",
  draft: "chat.toolCall.workflow.draft",
};

/** Revision wording. `running` (validating) has no special label: validation is part of creation, so reuse the creation wording. */
const AMEND_KIND_IDS: WorkflowKindIds = {
  writing: "chat.toolCall.workflow.amend.writing",
  revising: "chat.toolCall.workflow.amend.revising",
  awaitingConfirmation: "chat.toolCall.workflow.amend.awaitingConfirmation",
  running: "chat.toolCall.workflow.running",
  ran: "chat.toolCall.workflow.amend.ran",
  draft: "chat.toolCall.workflow.amend.draft",
};

/** Optional display name in CreateWorkflow tool input; the chat card and launch confirmation dialog share this read rule. */
export function readWorkflowName(input: unknown): string | undefined {
  if (isPlainRecord(input) && typeof input.name === "string") {
    const trimmed = input.name.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

/** Script source in CreateWorkflow tool input; the chat card and launch confirmation dialog share this read rule. */
export function readWorkflowScript(input: unknown): string | undefined {
  if (isPlainRecord(input) && typeof input.script === "string" && input.script.length > 0) {
    return input.script;
  }

  return undefined;
}

/**
 * Predecessor run being revised by AmendWorkflow input (`run_id`). When present, this supersedes the predecessor: create a new run from the new script and import its cache; stop the predecessor first if it is still running.
 *
 * Same rule as `readWorkflowScript`: read from the **input channel**, not display, so lineage adds no payload. Relevant only to AmendWorkflow rows—CreateWorkflow input has no `run_id`.
 */
export function readWorkflowAmendTarget(input: unknown): string | undefined {
  return isPlainRecord(input) ? readTrimmedString(input.run_id) : undefined;
}

/**
 * Predecessor facts filled into AmendWorkflow input by CLI `resolveInput`: the confirmation dialog uses `status` to decide whether to say “still running; will be stopped.” These are the only two fields the read-only confirmation dialog needs; permission checks use `owned_by_this_session` on the CLI side, and the UI does not inspect it.
 */
interface WorkflowAmendPredecessor {
  status: string | undefined;
  name: string | undefined;
}

export function readWorkflowAmendPredecessor(input: unknown): WorkflowAmendPredecessor | undefined {
  if (!isPlainRecord(input) || !isPlainRecord(input.predecessor)) {
    return undefined;
  }
  const predecessor = input.predecessor;
  return {
    status: readTrimmedString(predecessor.status),
    name: readTrimmedString(predecessor.name),
  };
}

/**
 * `max_concurrency`: requested maximum number of subagents running at once. Create and Amend use the same field name, so there is one read rule.
 *
 * Accept only positive integers: Amend’s `null` (remove the limit) and absence mean the same thing in the confirmation dialog—there is no limit to describe, so omit the row. The value here is **already the effective value**: both tools’ `resolveInput` clamps values above the ceiling before opening the dialog. Do not clamp again; this function neither has nor needs the ceiling. (Once a run is active, its concurrency chip shows min(this limit, shared cap); that is separate.)
 */
export function readWorkflowMaxConcurrency(input: unknown): number | undefined {
  if (!isPlainRecord(input)) {
    return undefined;
  }
  const value = input.max_concurrency;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * This AmendWorkflow call **only adjusts the concurrency limit**: `run_id` + `max_concurrency`, with no script source and no model/name change. While the run is active, it applies in place:
 * it does not stop or create a run or compile; the result is one sentence, with no display.
 *
 * **Input is the only wire location for this fact**: structured tool output goes through v4 (only `text` and `display`), and all three `create_workflow` display schemas have a frozen `.strict()` field set—an extra key would make older clients discard the entire tool result. So presentation branches on input shape, with no protocol change.
 *
 * Inspect only the **shape**; do not predict the outcome. If the run has already settled, the same call falls back to a true revision (including the predecessor script for compilation). That path leaves a display and creates a run linked by toolCallId; both are wiring-layer signals. While streaming, input may be partial and temporarily have this shape before the script arrives, so use it only to choose wording true for either outcome; do not change the row’s form based on it.
 */
export interface WorkflowRetuneCall {
  runId: string;
  /**
   * Requested limit; `null` removes this run’s own limit (returns to the local machine ceiling).
   *
   * ⚠ **Unclamped**: CLI `resolveInput` clamps it to `[1, ceiling]`, while this reads the value emitted by the model. Display code must compare it with the local ceiling and must never present this number as the effective concurrency.
   */
  requested: number | null;
}

export function readWorkflowRetuneCall(input: unknown): WorkflowRetuneCall | undefined {
  if (!isPlainRecord(input)) return undefined;
  const runId = readWorkflowAmendTarget(input);
  if (runId === undefined) return undefined;
  const bound = input.max_concurrency;
  const requested = bound === null ? null : readWorkflowMaxConcurrency(input);
  if (requested === undefined) return undefined;
  // Any other intent means this is not “only adjusting the concurrency limit”: scripts and paths need compilation, while model/name changes create another run.
  if (readWorkflowScript(input) !== undefined || readTrimmedString(input.path) !== undefined) {
    return undefined;
  }
  if (input.subagent_model !== undefined || input.name !== undefined) return undefined;
  return { runId, requested };
}

/**
 * `subagent_model`: which model the **subagents** in this run use.
 * Same rule as `max_concurrency`: Create and Amend share one field name and one read rule.
 *
 * Accept only a non-empty string: Amend’s `null` (return to session model) and absence are equivalent in the confirmation dialog—the subagent follows the session model, with no second model to describe, so omit the row. The value here is **already effective**: both tools’ `resolveInput` resolves the requested name to canonical `providerId/modelId[$level]` before the dialog opens; unresolvable calls never reach the dialog. Do no shape validation here—the UI is not a second resolver.
 */
export function readWorkflowSubagentModel(input: unknown): string | undefined {
  return isPlainRecord(input) ? readTrimmedString(input.subagent_model) : undefined;
}

/**
 * This revision reuses the predecessor’s script.
 * There is one evidence source for each surface, with one read rule:
 *
 * - The confirmation dialog reads CLI `resolveInput`-filled input: the script is present, and `predecessor.script_inherited` says it was reused;
 * - The chat card reads the **model-emitted** input (row input comes from streaming parameters, before backfill): only when both script sources, `script` and `path`, are absent was the script omitted. Missing only `script` is insufficient—`path` revisions (normally “Script files”) also omit `script` while supplying a revised script.
 *
 * The second rule is true only after input is **complete**—the script may not have arrived during streaming, so the caller asks only when not `inputStreaming`.
 * If input is not a record (snapshot-truncated preview or unknown shape), assert nothing.
 */
export function readWorkflowAmendScriptInherited(input: unknown): boolean {
  if (!isPlainRecord(input)) {
    return false;
  }
  if (isPlainRecord(input.predecessor) && input.predecessor.script_inherited === true) {
    return true;
  }
  return readWorkflowScript(input) === undefined && readTrimmedString(input.path) === undefined;
}

/**
 * Chat-card check: this row’s input says “reuse predecessor script.” Do not report that when input was truncated to a snapshot preview—that means bytes are missing, not the script. The caller also asks only for a **completed** revision row (the script may not have arrived while streaming).
 */
export function readWorkflowCardKeptScript(toolCall: {
  input: unknown;
  snapshotRefs?: readonly { field: string }[];
}): boolean {
  const trimmed = (toolCall.snapshotRefs ?? []).some((ref) => ref.field === "input");
  return !trimmed && readWorkflowAmendScriptInherited(toolCall.input);
}

/** Predecessor is still active (pending / running); the revision stops it first. */
export function isWorkflowAmendPredecessorLive(
  predecessor: WorkflowAmendPredecessor | undefined,
): boolean {
  return predecessor?.status === "running" || predecessor?.status === "pending";
}

/**
 * Saved source in normalized CreateWorkflow input (the reusable-workflow spec’s normalized shape: `{name, script, saved: {name, args, path, scope}}`).
 *
 * Same rule as `readWorkflowScript`: read from the **input channel**, not display, so the chat card and launch confirmation dialog share one read rule rather than parsing independently. Missing `saved` means inline submission,
 * not a fallback—the inline path stays exactly as it is today.
 */
export interface WorkflowSavedSource {
  name: string;
  path: string | undefined;
  scope: string | undefined;
  /** Validated args bag after input backfill. Missing or malformed shape becomes an empty object, never undefined. */
  args: Record<string, unknown>;
}

export function readWorkflowSaved(input: unknown): WorkflowSavedSource | undefined {
  if (!isPlainRecord(input) || !isPlainRecord(input.saved)) {
    return undefined;
  }

  const saved = input.saved;
  // The name identifies this source: if it cannot be read, treat the source as absent instead of rendering an empty badge.
  const name = typeof saved.name === "string" ? saved.name.trim() : "";
  if (name.length === 0) {
    return undefined;
  }

  return {
    name,
    path: readTrimmedString(saved.path),
    scope: readTrimmedString(saved.scope),
    args: isPlainRecord(saved.args) ? saved.args : {},
  };
}

/** Display form for args/defaults: keep strings as-is (quotes only add noise to Chinese arguments), JSON-encode everything else so all four declared types (string / number / boolean / json) remain readable. */
export function formatWorkflowArgValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular references and other non-serializable values must not crash the entire confirmation dialog.
    return String(value);
  }
}
