// ============================================================
// AmendWorkflow - which script this revision runs
// ============================================================
//
// The script has three possible sources, normalized into the same fields: `path` (usual case: an edited script file), `script` (the
// complete inline script), or neither (reuse the predecessor's archived script). This is split out of resolveInput itself
// (amend-workflow-resolve.ts) for the same reason as `create-workflow-source.ts`: this module **reads the world** (script files and
// the predecessor's archived script), while the handler **changes the world**. Combining them would invite a later reader to load the
// file again in the handler, so the confirmation dialog would no longer show the exact bytes that will execute.

import {
  AMEND_WORKFLOW_SOURCE_ERROR,
  AmendWorkflowInputSchema,
  type AmendWorkflowInput,
  type AmendWorkflowPredecessor,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSnapshot,
} from "@zcode/contracts";
import type { ToolHandlerFailure } from "../types.js";
import { normalizeWorkflowMaxConcurrency } from "./create-workflow-source.js";
import { readWorkflowScriptFile } from "./workflow-path-source.js";

/**
 * Local failure codes. Numbers are for logs only (the executor projects them as `code: "N"`); the discriminator is the message prefix.
 * `run_not_found` reuses the introspection table's key and code because a referenced run missing from any of the three tools means the same thing.
 * Start at 21 only to avoid visual collisions with the introspection table (1/2) and ResumeWorkflowRun (11–15).
 */
export const AMEND_WORKFLOW_ERROR_CODE = {
  AMEND_UNAVAILABLE: 21,
  MISSING_BOUNDARIES: 22,
  SUBAGENT_MODEL: 23,
  SCRIPT_UNCHANGED: 24,
  SCRIPT_FILE: 25,
  SCRIPT_UNAVAILABLE: 26,
  // The three rejections specific to the concurrency-only route (docs/dynamic-workflow/launch.md, “Changing only the
  // parallelism of a live run”); none of them changes the run.
  RETUNE_UNCHANGED: 27,
  RUN_SETTLED: 28,
  NOT_RETUNABLE: 29,
} as const;

/** Input-level violation (both sources were provided); uses the same 400 code as `CreateWorkflow`. */
const AMEND_WORKFLOW_INPUT_FAILURE_CODE = 400;

/**
 * A revision may provide **at most one** script source. This applies only to model input (same reason as
 * `validateCreateWorkflowSource`: after normalization, having both `script` and `path` is a valid execution state).
 * Providing neither is allowed; it means “reuse the predecessor's script.”
 */
export function validateAmendWorkflowSource(input: unknown): { result: true } | ToolHandlerFailure {
  const parsed = AmendWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true };
  if (parsed.data.script !== undefined && parsed.data.path !== undefined) {
    return {
      result: false,
      errorCode: AMEND_WORKFLOW_INPUT_FAILURE_CODE,
      message: AMEND_WORKFLOW_SOURCE_ERROR,
    };
  }
  return { result: true };
}

/**
 * Both sources were omitted, but there is no script to reuse. Both causes share one discriminator because the model's next step is the same: provide a script.
 *
 *   - `record`: the predecessor record has no script (an older run from before scripts were persisted);
 *   - `host`: this session has no run port, or the port lacks `getScript` (an older host).
 */
export function scriptUnavailableFailure(
  runId: string,
  cause: "record" | "host",
): ToolHandlerFailure {
  const why =
    cause === "record"
      ? `run ${runId} has no stored script to keep (it predates script persistence)`
      : `this host cannot read run ${runId}'s stored script`;
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.SCRIPT_UNAVAILABLE,
    message: `workflow_amend_script_unavailable: ${why}, so the script cannot be omitted here — pass the whole script as \`script\`, or its file as \`path\`. Nothing was stopped or created.`,
  };
}

/**
 * Normalize the concurrency limit's three states (docs/dynamic-workflow/concurrency.md, “Two bounds on a run”):
 *
 *   - number → round down to at least 1, with no upper bound (values above and below the default both apply);
 *   - `null` → remove the limit entirely (the new run uses default concurrency);
 *   - omitted → inherit the predecessor's limit **unchanged**. Snapshots include `maxConcurrency` **only when it differs from the default**, so “the predecessor never set a limit”
 *     and “the predecessor ran at the default” are equivalent here: both omit the key; a predecessor whose limit was raised passes that number on.
 *
 * The three states exist only up to this point: the confirmation dialog and handler see only “a number or none.” **The sole exception is the in-place concurrency route**
 * (amend-workflow-retune.ts): `retuneConcurrency` accepts `number | null` itself because only the port knows the default concurrency; the tool must not infer it again.
 */
export function resolveAmendMaxConcurrency(
  requested: number | null | undefined,
  inherited: number | undefined,
): { max_concurrency?: number } {
  if (requested === null) return {};
  const resolved = requested ?? inherited;
  if (resolved === undefined) return {};
  return { max_concurrency: normalizeWorkflowMaxConcurrency(resolved) };
}

/**
 * Predecessor facts (step 2 in docs/dynamic-workflow/launch.md, “From call to run”). resolveInput and the fallback from an in-place
 * concurrency change (which rereads the snapshot after a settlement race) share this derivation so they cannot disagree about
 * the run's current state.
 */
export function describePredecessor(
  snapshot: DynamicWorkflowRunSnapshot,
  sessionId: string | undefined,
): AmendWorkflowPredecessor {
  // Snapshot `status` uses generic tracker terms (for example, stopped becomes cancelled); the actual value is `runStatus`, present
  // only for terminal states. Treat every nonterminal state as running (pending and running are equivalent here: amend stops either).
  const status = snapshot.runStatus ?? "running";
  return {
    ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
    status,
    ...(snapshot.stopReason === undefined ? {} : { stop_reason: snapshot.stopReason }),
    owned_by_this_session:
      sessionId !== undefined &&
      snapshot.parentSessionId !== undefined &&
      snapshot.parentSessionId === sessionId,
  };
}

/** Normalized script fields (same shape for all three sources), plus the model-facing file path and whether the script was inherited. */
export type AmendScriptResolution =
  | {
      result: true;
      fields: { script: string; path?: string; script_line_offset?: number };
      described?: string;
      inherited: boolean;
    }
  | ToolHandlerFailure;

/**
 * Normalize the three script sources into one set of fields.
 *
 *   - `path`: read the file. If it has a metadata block, strip the block and **ignore the declarations**. Revisions do not carry
 *     arguments (those are facts from the predecessor run and live in the journal), so there is nothing to validate here. Still strip
 *     the block so the compiler does not treat it as part of the script.
 *   - `script`: use it as-is.
 *   - Both omitted: read the predecessor's archived script through the port (the same bytes replayed by resume). Resolve it here,
 *     not in the handler: the confirmation dialog must draw the graph for the script that will run, and hooks/project rules must
 *     match it; both happen before the handler. An empty string is equivalent to absence because the runtime schema's `.min(1)` rejects
 *     empty scripts. Also check the inherited script's source file ({@link resolveKeptScriptFile}): if the predecessor's file still
 *     contains these bytes, keep recording it for the new run; otherwise leave `path` absent and let the handler write a new draft
 *     under the “script not from a file” rule.
 *
 * If the port is absent (an unwired host), the first two sources still work; the third cannot be reused and fails immediately.
 */
export async function resolveAmendScript(options: {
  model: AmendWorkflowInput;
  cwd: string;
  port: DynamicWorkflowRunPort | undefined;
  /** Script file from the predecessor snapshot (absolute path); used to confirm the source when reusing a script. */
  predecessorScriptPath: string | undefined;
}): Promise<AmendScriptResolution> {
  const { model, cwd, port } = options;
  if (model.path !== undefined) {
    const read = await readWorkflowScriptFile({ cwd, inputPath: model.path });
    if (!read.ok) {
      return {
        result: false,
        errorCode: AMEND_WORKFLOW_ERROR_CODE.SCRIPT_FILE,
        message: `workflow_script_file_unreadable: ${read.message} Nothing was stopped or created.`,
      };
    }
    return {
      result: true,
      inherited: false,
      described: read.file.described,
      fields: {
        script: read.file.script,
        path: read.file.path,
        ...(read.file.bodyLineOffset === 0 ? {} : { script_line_offset: read.file.bodyLineOffset }),
      },
    };
  }
  if (model.script !== undefined) {
    return { result: true, inherited: false, fields: { script: model.script } };
  }
  if (port === undefined || typeof port.getScript !== "function") {
    return scriptUnavailableFailure(model.run_id, "host");
  }
  const stored = await port.getScript(model.run_id);
  if (stored === undefined || stored.length === 0) {
    return scriptUnavailableFailure(model.run_id, "record");
  }
  const kept = await resolveKeptScriptFile({
    cwd,
    scriptPath: options.predecessorScriptPath,
    script: stored,
  });
  return {
    result: true,
    inherited: true,
    ...(kept === undefined ? {} : { described: kept.described }),
    fields: {
      script: stored,
      ...(kept === undefined
        ? {}
        : {
            path: kept.path,
            ...(kept.lineOffset === 0 ? {} : { script_line_offset: kept.lineOffset }),
          }),
    },
  };
}

/**
 * Confirm the source file of an inherited script: if the file recorded by the predecessor still contains the inherited bytes **now**,
 * keep recording it for the new run. Neither the script nor file has changed, so it remains the new run's script file and the model can
 * edit it for the next revision. Tool reuse and GUI “Configure” share this rule.
 *
 * If anything differs (the predecessor recorded no file, it is missing, unreadable, or modified), return `undefined` so the caller
 * writes a new draft under the “script not from a file” rule. Never attach a file whose contents no longer match the script to the new
 * run; diagnostics and “edit this file” would point to different code.
 */
export async function resolveKeptScriptFile(options: {
  cwd: string;
  scriptPath: string | undefined;
  script: string;
}): Promise<{ path: string; described: string; lineOffset: number } | undefined> {
  if (options.scriptPath === undefined) return undefined;
  const read = await readWorkflowScriptFile({ cwd: options.cwd, inputPath: options.scriptPath });
  if (!read.ok || read.file.script !== options.script) return undefined;
  return {
    path: read.file.path,
    described: read.file.described,
    lineOffset: read.file.bodyLineOffset,
  };
}

/**
 * Preflight check that “the file has not been edited.”
 *
 * Applies only to a model-provided `path`: this check catches **forgetting to edit**. Pasting the script again or explicitly saying
 * “leave the script unchanged” (omitting both sources) is not that mistake. Also applies only when this call changes nothing else:
 * a revision that changes `max_concurrency` or `subagent_model` is meaningful even if the script is unchanged (`null` counts as
 * provided because it explicitly clears the value).
 *
 * `getScript` is an optional port member; skip this preflight when it is absent. It is a convenience, not a correctness gate.
 */
export async function refuseUnchangedScript(options: {
  port: DynamicWorkflowRunPort;
  /** Model-provided input (before normalization); a `path` filled in during inheritance does not count as model-provided. */
  model: AmendWorkflowInput;
  resolvedScript: string;
  described: string | undefined;
}): Promise<ToolHandlerFailure | undefined> {
  const { port, model, resolvedScript, described } = options;
  if (model.path === undefined) return undefined;
  if (model.max_concurrency !== undefined || model.subagent_model !== undefined) return undefined;
  if (typeof port.getScript !== "function") return undefined;

  const previous = await port.getScript(model.run_id);
  if (previous === undefined || previous !== resolvedScript) return undefined;
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.SCRIPT_UNCHANGED,
    message: `workflow_script_unchanged: ${described ?? model.path} is byte-for-byte the script run ${model.run_id} was started with, so amending it would repeat that run exactly. Edit the file first, then call AmendWorkflow again with the same \`path\`; to change only the settings, pass them and omit \`path\`; to continue a stopped run under the same script, use ResumeWorkflowRun. Nothing was stopped or created.`,
  };
}
