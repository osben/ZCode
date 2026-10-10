// ============================================================
// AmendWorkflow: everything before confirmation (resolveInput and its structured failures)
// ============================================================
//
// Split from amend-workflow.ts: that file contains the handler and tool declaration; this is the **only port read in the flow**.
// It normalizes model input into “facts about the execution that is about to happen.” Every optional field follows the same rule
// (omission reuses the predecessor), and all three are resolved here: script (three sources; see amend-workflow-source.ts),
// concurrency limit, and subagent model. Hooks, permissions, confirmation, and the handler then see only one script, one number
// or none, and one canonical model or none.

import {
  AmendWorkflowInputSchema,
  type AmendWorkflowInput,
  type ModelCatalogPort,
} from "@zcode/contracts";
import type {
  ToolHandlerFailure,
  ToolInputResolutionContext,
  ToolInputResolutionResult,
} from "../types.js";
import { SUBAGENT_MODEL_UNAVAILABLE } from "./create-workflow-source.js";
import { resolveConcurrencyRetuneRoute } from "./amend-workflow-retune.js";
import {
  AMEND_WORKFLOW_ERROR_CODE,
  describePredecessor,
  refuseUnchangedScript,
  resolveAmendMaxConcurrency,
  resolveAmendScript,
} from "./amend-workflow-source.js";
import { resolveModelReference } from "./model-reference.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";

export {
  AMEND_WORKFLOW_ERROR_CODE,
  resolveAmendMaxConcurrency,
  scriptUnavailableFailure,
  validateAmendWorkflowSource,
} from "./amend-workflow-source.js";

/** The predecessor does not exist: reuse the introspection tool's `run_not_found`, adding only a sentence naming `run_id`. */
export function predecessorNotFoundFailure(runId: string): ToolHandlerFailure {
  const base = workflowRunNotFoundFailure(runId);
  return {
    ...base,
    message: `${base.message} Nothing was stopped or created: \`run_id\` pointed at a run that does not exist — pass an existing run's ID (see ListWorkflowRuns), or start a fresh run with CreateWorkflow.`,
  };
}

/**
 * The only port read in the flow: resolve `run_id` into the predecessor facts and add them to the input.
 *
 * Both permission checks (runs in this session do not require confirmation; permission/service.ts) and the confirmation dialog
 * (“still running and will be stopped”) read these facts. Both run before the handler and must be synchronous, so resolve them here.
 * **Always overwrite** any model-provided `predecessor`; a forged value is invalid. If the predecessor is missing, stop here instead
 * of showing a confirmation dialog that is guaranteed to fail.
 *
 * Keep this order: find the predecessor (missing means `run_not_found`, independent of the script) → resolve the script (read the
 * file or predecessor snapshot; name the reason if it cannot be read) → compare bytes (`script_unchanged`). Reversing it would make
 * a request for a missing run fail first because its file cannot be read, prompting the model to fix something that is not the problem.
 *
 * If the port is absent (an unwired host), pass through a supplied script (inline or file) as-is: the handler will only typecheck
 * it, without executing, matching CreateWorkflow. Permissions cannot read `predecessor`, so they ask as usual. If neither script
 * source is provided, there is nothing to reuse and the call fails immediately; it cannot fall back to typechecking because there is
 * nothing to compile.
 */
export async function resolveAmendWorkflowInput(
  input: unknown,
  context: ToolInputResolutionContext,
): Promise<ToolInputResolutionResult> {
  const parsed = AmendWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };
  const cwd = context.workingDirectory ?? ".";
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined) {
    const {
      predecessor: _forged,
      max_concurrency: requested,
      subagent_model: _model,
      script_line_offset: _offset,
      ...rest
    } = parsed.data;
    void _forged;
    void _model;
    void _offset;
    // Without a port there is neither a predecessor nor a ceiling: `null` (clear) and omission (reuse) both become absent, while a number passes through unchanged.
    // From here on, normalized input always has one shape: one number or none.
    const subagentModel = resolveAmendSubagentModel(
      parsed.data.subagent_model,
      undefined,
      context.modelCatalogPort,
    );
    if (!subagentModel.result) return subagentModel;
    const script = await resolveAmendScript({
      model: parsed.data,
      cwd,
      port,
      predecessorScriptPath: undefined,
    });
    if (!script.result) return script;
    return {
      result: true,
      input: {
        ...rest,
        ...script.fields,
        ...(typeof requested === "number" ? { max_concurrency: requested } : {}),
        ...subagentModel.field,
      },
    };
  }
  const snapshot = await port.getTask(parsed.data.run_id);
  if (snapshot === undefined) return predecessorNotFoundFailure(parsed.data.run_id);
  const predecessor = describePredecessor(snapshot, context.sessionId);
  // Branch the route here and only here: the predecessor was just read (so we know whether it is live), and the input shape shows
  // whether anything besides concurrency changes. On a match, adjust concurrency in place—without reading, inheriting, or compiling
  // a script. Normalized input therefore has **no script**, which is how the handler and prepareApproval recognize this route.
  const retune = resolveConcurrencyRetuneRoute({
    model: parsed.data,
    port,
    predecessor,
    inherited: snapshot.maxConcurrency,
  });
  if (retune !== undefined) return retune;
  const subagentModel = resolveAmendSubagentModel(
    parsed.data.subagent_model,
    snapshot.subagentModel,
    context.modelCatalogPort,
  );
  if (!subagentModel.result) return subagentModel;
  const script = await resolveAmendScript({
    model: parsed.data,
    cwd,
    port,
    predecessorScriptPath: snapshot.scriptPath,
  });
  if (!script.result) return script;
  const unchanged = await refuseUnchangedScript({
    port,
    model: parsed.data,
    resolvedScript: script.fields.script,
    described: script.described,
  });
  if (unchanged !== undefined) return unchanged;
  const {
    predecessor: _forged,
    max_concurrency: _tristate,
    subagent_model: _model,
    // Like `predecessor`, this is a resolved fact; discard any model-provided offset (recomputed from the file below).
    script_line_offset: _offset,
    ...rest
  } = parsed.data;
  void _forged;
  void _model;
  void _offset;
  const resolved: AmendWorkflowInput = {
    ...rest,
    ...script.fields,
    ...resolveAmendMaxConcurrency(
      parsed.data.max_concurrency,
      snapshot.maxConcurrency,
      port.concurrencyCeiling?.(),
    ),
    ...subagentModel.field,
    predecessor: {
      ...predecessor,
      ...(script.inherited ? { script_inherited: true as const } : {}),
    },
  };
  return { result: true, input: resolved };
}

/**
 * Normalize the subagent model's three states using the same shape convention as the concurrency limit. The three states end here;
 * confirmation and the handler see only one canonical model or none:
 *
 *   - String → resolve it; if resolution fails, fail the entire call (nothing is stopped or created, and no dialog opens).
 *   - `null` → clear it, removing the key entirely (the new run uses the session model).
 *   - Omitted → reuse the predecessor snapshot and **resolve it again**. The predecessor may be days old, and its model may since
 *     have been removed or disabled. Without re-resolution, failure would occur only when the subagent first speaks, appearing as a runtime failure.
 *
 * If the catalog is absent, handle the two sources differently: reject a model-provided string as CreateWorkflow does (do not silently
 * pass through a value the host cannot resolve), but pass through an **inherited** model unchanged. It was already resolved for the
 * predecessor; failing the whole revision over a field omitted from this call would blame the user for a host wiring gap.
 */
function resolveAmendSubagentModel(
  requested: string | null | undefined,
  inherited: string | undefined,
  catalog: ModelCatalogPort | undefined,
): { result: true; field: { subagent_model?: string } } | ToolHandlerFailure {
  const choice = resolveAmendSubagentModelChoice(requested, inherited, catalog);
  if (choice.ok) {
    return {
      result: true,
      field: choice.canonical === undefined ? {} : { subagent_model: choice.canonical },
    };
  }
  // If the inherited model fails, make clear that it was **inherited**. This call did not name a model; returning the resolution
  // diagnostic without that context would make the model think it supplied a bad parameter and retry unchanged.
  return subagentModelFailure(
    choice.inherited
      ? `This amend inherited the predecessor run's subagent model (\`${choice.text}\`), which is no longer usable. ${choice.message}\n\nPass \`subagent_model: null\` to run the revision on the session model instead.`
      : choice.message,
  );
}

/**
 * The **canonical decision logic** for the subagent model's three states, shared by the tool and GUI “Configure” flow
 * (runtime's amendWorkflowRunSettings); reuse the resolver instead of duplicating it. They differ only in how they **report** failure:
 * the tool reports it to the model (with a suggestion to set `subagent_model: null`), while the GUI reports it to the user
 * (the diagnostic goes in the ACK message).
 *
 * Result: absent `canonical` means “use the session model”; failure includes `inherited` (whether the failed value was reused) and the resolution diagnostic.
 */
export function resolveAmendSubagentModelChoice(
  requested: string | null | undefined,
  inherited: string | undefined,
  catalog: ModelCatalogPort | undefined,
):
  | { ok: true; canonical?: string }
  | { ok: false; inherited: boolean; text: string; message: string } {
  if (requested === null) return { ok: true };
  const text = requested ?? inherited;
  if (text === undefined) return { ok: true };
  if (catalog === undefined) {
    return requested === undefined
      ? { ok: true, canonical: text }
      : { ok: false, inherited: false, text, message: SUBAGENT_MODEL_UNAVAILABLE };
  }
  const resolution = resolveModelReference(text, catalog.listModels());
  if (!resolution.ok) {
    return { ok: false, inherited: requested === undefined, text, message: resolution.message };
  }
  return { ok: true, canonical: resolution.canonical };
}

/** Convert resolution failure to a structured business failure. The discriminator is the message prefix, matching this file's other codes. */
function subagentModelFailure(message: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.SUBAGENT_MODEL,
    message: `workflow_subagent_model_unresolved: ${message} Nothing was stopped or created.`,
  };
}
