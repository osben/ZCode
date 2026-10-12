// ============================================================
// FillWorkflowHole: everything before confirmation (resolveInput and its structured failures)
// ============================================================
// docs/dynamic-workflow/launch.md, "The `FillWorkflowHole` tool" -> "Input and output", "Approval".
//
// Split out of fill-workflow-hole.ts (the same split as amend-workflow-resolve.ts): that side is
// the handler and tool declaration, this side is **the single port read in the whole flow** —
// normalizing the model's input into "the execution facts that are about to happen": the function
// body's bytes (inline or read from a file), whether the hole is the one this run is waiting at,
// whether it belongs to this session, and where the draft is. Afterwards the permission side, the
// confirmation dialog, and the handler face only one function body and one `hole` fact block.

import { readFile } from "node:fs/promises";
import {
  FILL_WORKFLOW_HOLE_SOURCE_ERROR,
  FillWorkflowHoleInputSchema,
  type DynamicWorkflowRunHole,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSnapshot,
  type FillWorkflowHoleHole,
  type FillWorkflowHoleInput,
} from "@zcode/contracts";
import type {
  ToolHandlerFailure,
  ToolInputResolutionContext,
  ToolInputResolutionResult,
} from "../types.js";
import { spliceHoleBodyPreview } from "./fill-workflow-hole-splice.js";
import { resolveWorkflowScriptFilePath } from "./workflow-path-source.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";

/**
 * Local failure code table. The numbers are only log bits (the executor projects them as
 * `code: "N"`); the discriminant is the message prefix. `run_not_found` reuses the introspection
 * table's same key and code. Numbering starts at 31 only to avoid visually colliding with the
 * introspection table (1/2), ResumeWorkflowRun (11–15), ResolveWorkflowQuestion (21–24), and
 * AmendWorkflow (21–29) — each table's numeric space is independent.
 */
export const FILL_WORKFLOW_HOLE_ERROR_CODE = {
  FILL_UNAVAILABLE: 31,
  HOLE_NOT_WAITING: 32,
  FILL_UNCHANGED: 33,
  FILL_FILE: 34,
  IDS_UNSTABLE: 35,
  BODY_UNAVAILABLE: 36,
} as const;

/** Code for input-level violations (not exactly one source), the same 400 as CreateWorkflow / AmendWorkflow. */
const FILL_WORKFLOW_HOLE_INPUT_FAILURE_CODE = 400;

/**
 * Exactly **one** function-body source holds only for the input as emitted by the model (after
 * normalization, `script` and `path` both being present is a legal execution state: the bytes of
 * `path` were read into `script`). Giving neither is also a violation — there is no body to carry over.
 */
export function validateFillWorkflowHoleSource(
  input: unknown,
): { result: true } | ToolHandlerFailure {
  const parsed = FillWorkflowHoleInputSchema.safeParse(input);
  if (!parsed.success) return { result: true };
  const sources = [parsed.data.script, parsed.data.path].filter((value) => value !== undefined);
  if (sources.length === 1) return { result: true };
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_INPUT_FAILURE_CODE,
    message: FILL_WORKFLOW_HOLE_SOURCE_ERROR,
  };
}

// ------------------------------------------------------------
// The last rejected attempt (`fill_unchanged` in docs/dynamic-workflow/launch.md)
// ------------------------------------------------------------
// "The bytes of a `path` equal what this hole last rejected" means the edit was forgotten, and it
// must be caught before the dialog opens. One table per session, keyed by (session, run, hole):
// the handler records those bytes when the port reports `compile_failed`, and resolveInput
// compares against them when `path` is submitted. It only applies to `path` — pasting the same
// body inline casts a new fill file, which is a different error that the diagnostics describe.

const rejectedFills = new Map<string, string>();

function rejectionKey(sessionId: string | undefined, runId: string, holeId: string): string {
  return `${sessionId ?? ""}\u0000${runId}\u0000${holeId}`;
}

export function rememberRejectedFill(
  sessionId: string | undefined,
  runId: string,
  holeId: string,
  body: string,
): void {
  rejectedFills.set(rejectionKey(sessionId, runId, holeId), body);
}

/** For tests: clear the "last rejected" table so cases cannot see each other. */
export function resetFillWorkflowHoleRejectionsForTests(): void {
  rejectedFills.clear();
  preview = undefined;
}

// ------------------------------------------------------------
// The confirmation dialog's preview (docs/dynamic-workflow/launch.md, "Approval")
// ------------------------------------------------------------
// prepareApproval is synchronous and only sees the input, while the effective script can only be
// assembled by reading the port (the run's script). So resolveInput records the assembled preview
// in a **single slot**, and prepareApproval claims it by (run, hole, body) — the same posture as
// workflow-script-analysis.ts's single-slot memory: the only repetition worth converging is this
// immediately adjacent pair of calls.

/** One preview in the single slot: the effective script plus the run's model binding table (prepareApproval uses it to judge which models the body names). */
export interface FillPreview {
  effectiveScript: string;
  modelBindings: Record<string, string>;
}

let preview: ({ runId: string; holeId: string; body: string } & FillPreview) | undefined;

/** prepareApproval takes the preview: if the input matches, the effective script and binding table; otherwise `undefined` (the dialog still opens, just without it). */
export function takeFillPreview(
  runId: string,
  holeId: string,
  body: string,
): FillPreview | undefined {
  if (preview === undefined) return undefined;
  if (preview.runId !== runId || preview.holeId !== holeId || preview.body !== body)
    return undefined;
  return { effectiveScript: preview.effectiveScript, modelBindings: preview.modelBindings };
}

// ------------------------------------------------------------
// resolveInput
// ------------------------------------------------------------

/**
 * The single port read in the whole flow: resolves `run_id` + `hole_id` into the `hole` fact block
 * and back-fills it into the input.
 *
 * The order must not change: run lookup (missing is `run_not_found`, unrelated to the body) ->
 * whether the hole is waiting (terminal runs, unknown ids, and already-filled holes all settle
 * here — no confirmation dialog doomed to fail) -> settle the body (read the file; an unreadable
 * file is reported by name) -> compare bytes (`fill_unchanged`) -> back-fill the fact block and
 * assemble the preview. **Unconditionally overrides** any `hole` the model supplied: forgeries are
 * invalid.
 *
 * When the port is absent (an unwired host), the body still settles and passes through unchanged:
 * the handler returns the structured "this session cannot fill" failure, and the permission side,
 * reading no `hole`, asks as usual.
 */
export async function resolveFillWorkflowHoleInput(
  input: unknown,
  context: ToolInputResolutionContext,
): Promise<ToolInputResolutionResult> {
  const parsed = FillWorkflowHoleInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };
  const cwd = context.workingDirectory ?? ".";
  const { hole: _forged, ...model } = parsed.data;
  void _forged;
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined) {
    const body = await resolveFillBody(model, cwd);
    if (!body.result) return body;
    return { result: true, input: { ...model, ...body.fields } satisfies FillWorkflowHoleInput };
  }

  const snapshot = await port.getTask(model.run_id);
  if (snapshot === undefined) return runNotFoundFailure(model.run_id);
  const waiting = findWaitingHole(snapshot, model.run_id, model.hole_id);
  if (waiting !== undefined && "result" in waiting) return waiting;

  const body = await resolveFillBody(model, cwd);
  if (!body.result) return body;
  if (model.path !== undefined) {
    const rejected = rejectedFills.get(
      rejectionKey(context.sessionId, model.run_id, model.hole_id),
    );
    if (rejected !== undefined && rejected === body.fields.script) {
      return unchangedFillFailure(body.described ?? model.path, model.run_id, model.hole_id);
    }
  }

  const hole =
    waiting === undefined ? undefined : describeHole(snapshot, waiting, context.sessionId);
  await rememberFillPreview(port, model.run_id, model.hole_id, body.fields.script, snapshot);
  return {
    result: true,
    input: {
      ...model,
      ...body.fields,
      ...(hole === undefined ? {} : { hole }),
    } satisfies FillWorkflowHoleInput,
  };
}

function runNotFoundFailure(runId: string): ToolHandlerFailure {
  const base = workflowRunNotFoundFailure(runId);
  return {
    ...base,
    message: `${base.message} Nothing was filled: \`run_id\` pointed at a run that does not exist — take it from the hole notification or from ListWorkflowRuns.`,
  };
}

/**
 * Whether this hole is the one the run is waiting at. All three kinds of "not" return
 * `hole_not_waiting`, with the message naming which one (the rejection table in
 * docs/dynamic-workflow/launch.md): the run is not in flight (if stopped, point at
 * ResumeWorkflowRun — the hole asks again after resuming), the id is unknown or not yet reached,
 * or the hole is already filled. When the snapshot has no `holes` table (old host), return
 * `undefined`: undecidable, leave it to the port.
 */
function findWaitingHole(
  snapshot: DynamicWorkflowRunSnapshot,
  runId: string,
  holeId: string,
): DynamicWorkflowRunHole | ToolHandlerFailure | undefined {
  const status = snapshot.runStatus;
  if (status === "stopped") {
    return notWaitingFailure(
      `run ${runId} is stopped (${snapshot.stopReason ?? "unknown reason"}), so nothing is waiting at ${holeId}. Continue it with ResumeWorkflowRun first; the hole will ask again once the script reaches it.`,
    );
  }
  if (status === "completed" || status === "errored") {
    return notWaitingFailure(
      `run ${runId} has already ${status}, so nothing is waiting at ${holeId}.`,
    );
  }
  const holes = snapshot.holes;
  if (holes === undefined) return undefined;
  const entry = holes.find((hole) => hole.siteId === holeId);
  if (entry === undefined) {
    return notWaitingFailure(
      `run ${runId} is not waiting at ${holeId}: no hole with that id has been reached (unknown id, or the script has not got there yet). GetWorkflowRun lists the holes it is waiting at.`,
    );
  }
  if (entry.state !== "waiting") {
    return notWaitingFailure(
      `hole ${holeId} ("${entry.name}") of run ${runId} is already filled; the branch has resumed with that body. To change what it does, edit the run's draft and use AmendWorkflow.`,
    );
  }
  return entry;
}

function notWaitingFailure(detail: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.HOLE_NOT_WAITING,
    message: `hole_not_waiting: ${detail} Nothing was filled.`,
  };
}

function unchangedFillFailure(
  described: string,
  runId: string,
  holeId: string,
): ToolHandlerFailure {
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_UNCHANGED,
    message: `fill_unchanged: ${described} is byte-for-byte the body that was just rejected for hole ${holeId} of run ${runId}, so resubmitting it would fail the same way. Edit the file first (the diagnostics name the lines), then call FillWorkflowHole again with the same \`path\`. Nothing was filled.`,
  };
}

/**
 * The `hole` fact block. `owned_by_this_session` folds in the two amend-rule conditions (initiated
 * by this session, and not stopped by the user's own hand) — the permission service reads only
 * this bit (docs/dynamic-workflow/launch.md, "Approval").
 */
function describeHole(
  snapshot: DynamicWorkflowRunSnapshot,
  entry: DynamicWorkflowRunHole,
  sessionId: string | undefined,
): FillWorkflowHoleHole {
  const owned =
    sessionId !== undefined &&
    snapshot.parentSessionId !== undefined &&
    snapshot.parentSessionId === sessionId &&
    snapshot.stopReason !== "user";
  return {
    name: entry.name,
    type: entry.type,
    ...(snapshot.scriptPath === undefined ? {} : { draft_path: snapshot.scriptPath }),
    ...(entry.line === undefined ? {} : { line: entry.line }),
    owned_by_this_session: owned,
  };
}

/** The normalized function-body fields (both sources share the shape), plus the file spelling the model-facing side should see. */
type FillBodyResolution =
  | { result: true; fields: { script: string; path?: string }; described?: string }
  | ToolHandlerFailure;

/**
 * Both sources normalize into the same fields. `path` is read byte-for-byte (no metadata block is
 * stripped: a fill file contains exactly the statements), and the read happens in resolveInput
 * rather than the handler — the confirmation dialog must render the bytes about to be spliced in,
 * and hooks and project rules must match against them.
 */
async function resolveFillBody(
  model: FillWorkflowHoleInput,
  cwd: string,
): Promise<FillBodyResolution> {
  if (model.path !== undefined) {
    const absolute = resolveWorkflowScriptFilePath(cwd, model.path);
    const described = describeWorkflowScriptPath(absolute, cwd);
    try {
      const script = await readFile(absolute, "utf8");
      if (script.length === 0) return fillFileFailure(`${described} is empty`);
      return { result: true, described, fields: { script, path: absolute } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fillFileFailure(`${described} could not be read: ${reason}`);
    }
  }
  if (model.script !== undefined) return { result: true, fields: { script: model.script } };
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.BODY_UNAVAILABLE,
    message: `workflow_fill_body_unavailable: ${FILL_WORKFLOW_HOLE_SOURCE_ERROR}`,
  };
}

function fillFileFailure(detail: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_FILE,
    message: `workflow_fill_file_unreadable: ${detail}. Pass \`path\` for the fill file a previous result named, or submit the body inline as \`script\`. Nothing was filled.`,
  };
}

/** Assembles the effective script once into the single slot (a missing run script or a failed splice only means no preview; it never fails). */
async function rememberFillPreview(
  port: DynamicWorkflowRunPort,
  runId: string,
  holeId: string,
  body: string,
  snapshot: DynamicWorkflowRunSnapshot,
): Promise<void> {
  preview = undefined;
  if (typeof port.getScript !== "function") return;
  let stored: string | undefined;
  try {
    stored = await port.getScript(runId);
  } catch {
    return;
  }
  if (stored === undefined || stored.length === 0) return;
  const effectiveScript = spliceHoleBodyPreview(stored, holeId, body);
  if (effectiveScript === undefined) return;
  // An absent binding table means the run never named a model (the snapshot's `modelBindings` is present only when one was named).
  preview = { runId, holeId, body, effectiveScript, modelBindings: snapshot.modelBindings ?? {} };
}
