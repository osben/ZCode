// ============================================================
// AmendWorkflow Tool Handler
// ============================================================
//
// There are only two differences from CreateWorkflow: resolveInput resolves the **predecessor run** instead of a saved file
// (omitted script, concurrency limit, and subagent model are inherited from the predecessor; see amend-workflow-resolve.ts; script
// sources are documented in amend-workflow-source.ts), and the handler calls `port.amend` (the service stops the live predecessor,
// waits for settlement, imports, and starts). Compilation, diagnostic paths, display payload, and backgrounded contract are shared
// verbatim with CreateWorkflow. The model-facing response follows the same format and adds only which run was replaced and, when the
// script was inherited, that the script is unchanged.

import {
  AMEND_WORKFLOW_TOOL_NAME,
  AmendWorkflowInputJsonSchema,
  AmendWorkflowInputSchema,
  CreateWorkflowOutputJsonSchema,
  CreateWorkflowOutputSchema,
  type AmendWorkflowInput,
  type CreateWorkflowOutput,
  type ModelMessageContent,
  createWorkflowPhaseAlongside,
  createWorkflowPhaseNames,
} from "@zcode/contracts";
import type {
  ToolApprovalGate,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";
import { AMEND_WORKFLOW_TOOL_DESCRIPTION } from "./amend-workflow-description.js";
import {
  AMEND_WORKFLOW_ERROR_CODE,
  predecessorNotFoundFailure,
  resolveAmendWorkflowInput,
  scriptUnavailableFailure,
  validateAmendWorkflowSource,
} from "./amend-workflow-resolve.js";
import {
  isConcurrencyOnlyAmend,
  resolveRetuneFallbackAmend,
  runConcurrencyRetune,
} from "./amend-workflow-retune.js";
import {
  DIAGNOSTICS_NOT_EXECUTED_NOTE,
  EXECUTION_UNAVAILABLE_NOTE,
  describeWorkflowConcurrencyLimit,
  resolveTraceContext,
} from "./create-workflow.js";
import { describeWorkflowSubagentModel, parseWorkflowSubagentModel } from "./model-reference.js";
import { boundGraphOfAnalysis, displayOfAnalysis } from "./workflow-analysis-display.js";
import { recordAuthoredWorkflowDraft } from "./workflow-draft-read-state.js";
import { resolveWorkflowDraftName, writeWorkflowDraft } from "./workflow-drafts.js";
import {
  formatWorkflowDiagnosticLines,
  workflowAmendedScriptSentence,
  workflowScriptFileNote,
  type WorkflowScriptLocation,
} from "./workflow-script-notes.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import {
  allScriptModelsBound,
  describeScriptModelBindings,
  readScriptModelBindings,
  scriptModelSelections,
  unresolvedScriptModelDiagnostics,
} from "./workflow-script-models.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";
import { amendWorkflowNeedsSkill, requireDynamicWorkflowSkill } from "./workflow-skill-gate.js";
import {
  applyWorkflowSettingsAdjustments,
  describeWorkflowRunSettings,
  readAppliedWorkflowSettings,
  withWorkflowAdjustableSettings,
} from "./workflow-settings-adjustment.js";

const AMEND_WORKFLOW_TIMEOUT_MS = 15_000;
const AMEND_WORKFLOW_MODEL_BYTES = 24_000;

function amendUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.AMEND_UNAVAILABLE,
    message:
      "workflow_amend_unavailable: this session cannot amend workflow runs — workflow execution is not available here. This is a capability gap, not a status problem.",
  };
}

/** Map the port's two rejection reasons to structured failures with actionable messages (the discriminator is the message prefix). */
function amendRefusalFor(reason: string, runId: string): ToolHandlerFailure {
  switch (reason) {
    case "run_not_found":
      return predecessorNotFoundFailure(runId);
    case "missing_boundaries":
      return {
        result: false,
        errorCode: AMEND_WORKFLOW_ERROR_CODE.MISSING_BOUNDARIES,
        message: `workflow_amend_missing_boundaries: run ${runId}'s journal predates transcript-boundary bookkeeping (or its boundaries were never recorded), so its finished asks cannot seed an amended run — there is no fallback. Submit this script as a fresh CreateWorkflow instead. Nothing was stopped or created.`,
      };
    default:
      // For a reason outside the port contract, still return a structured failure (throw indicates a wiring fault); include the original term for log diagnosis.
      return {
        result: false,
        errorCode: AMEND_WORKFLOW_ERROR_CODE.MISSING_BOUNDARIES,
        message: `workflow_amend_refused: the workflow runtime refused to amend run ${runId} (reason: ${reason}). Nothing was stopped or created.`,
      };
  }
}

/**
 * Message returned to the model when compilation fails. Format diagnostic lines and NOTE using “Script files” file coordinates
 * when the script has a file. For an inherited script, first say it was **inherited**: the model did not write these lines in this call,
 * and diagnostics alone would make it think it supplied a bad parameter—the same reason we identify an inherited subagent model that
 * is no longer available. In both cases, clarify that the predecessor was not changed; otherwise the model may think it stopped a live run.
 */
function compileFailureResponse(
  input: AmendWorkflowInput,
  diagnostics: CreateWorkflowOutput["diagnostics"],
  location: WorkflowScriptLocation | undefined,
): string {
  const inherited = input.predecessor?.script_inherited === true;
  const note =
    location !== undefined
      ? workflowScriptFileNote(location)
      : inherited
        ? "NOTE: Nothing ran — pass a rewritten `script` that compiles."
        : DIAGNOSTICS_NOT_EXECUTED_NOTE;
  return [
    inherited
      ? `This amend kept run ${input.run_id}'s script, inherited because you omitted both \`script\` and \`path\`, and that script no longer compiles against the current workflow facade:`
      : "The revised workflow script has errors:",
    ...formatWorkflowDiagnosticLines(diagnostics, location),
    "",
    `${note} Run ${input.run_id} was not touched.`,
  ].join("\n");
}

const amendWorkflowHandler: ToolHandler = async (input, context) => {
  const parsed = AmendWorkflowInputSchema.parse(input) as AmendWorkflowInput;
  // In-place concurrency update (docs/dynamic-workflow/launch.md, “Changing only the parallelism of a live run”):
  // the route detected by resolveInput leaves one trace here—no script, only a concurrency value. If the port returns `not_live`
  // (the run settled between the two steps), fall back to a real amendment; load the script and compile it only then.
  if (isConcurrencyOnlyAmend(parsed)) {
    const retuned = await runConcurrencyRetune(parsed, context);
    if (retuned !== undefined) return retuned;
    const fallback = await resolveRetuneFallbackAmend(parsed, context);
    if (!fallback.result) return fallback;
    return await amendResolvedWorkflow(fallback.input, context);
  }
  return await amendResolvedWorkflow(parsed, context);
};

/** Revision implementation: input now always contains the script that will run (both the tool route and fallback have resolved it). */
async function amendResolvedWorkflow(
  parsed: AmendWorkflowInput,
  context: ToolExecutionContext,
): Promise<CreateWorkflowOutput | ToolHandlerFailure> {
  // resolveInput always supplies the script (`path` is read into `script`, omission is filled from the predecessor, or resolution
  // fails immediately). If it is missing here, a caller bypassed normalization; return a structured failure rather than passing
  // undefined to the compiler.
  const script = parsed.script;
  if (script === undefined) return scriptUnavailableFailure(parsed.run_id, "host");
  const cwd = context.workingDirectory;

  const analysis = analyzeScript(script);
  // Models named by the script use the same route as CreateWorkflow (an unbound name reports 9011). The message must distinguish
  // “the inherited predecessor model is gone” from “this name cannot be resolved,” so reread the predecessor's binding table only when a name is actually unbound.
  const modelBindings = readScriptModelBindings(parsed);
  const modelDiagnostics =
    analysis.ok && !allScriptModelsBound(analysis, modelBindings)
      ? unresolvedScriptModelDiagnostics(
          analysis,
          modelBindings,
          context.modelCatalogPort,
          (await context.dynamicWorkflowRunPort?.getTask(parsed.run_id))?.modelBindings,
        )
      : [];
  const diagnostics = [...analysis.diagnostics, ...modelDiagnostics];
  const ok = analysis.ok && modelDiagnostics.length === 0;
  const causalityGraph = boundGraphOfAnalysis(analysis);

  // Inline revisions follow the same rule as CreateWorkflow: persist the working copy **regardless of compilation result**, so an
  // uncompileable revision still has a file to edit. Analyze first only to choose a name (use the first stage name if there is no
  // `name` or predecessor name). If `path` is present, do not write it; that file is already the working copy. An inherited script may
  // or may not have a file: resolveInput fills `path` if the predecessor's file still contains these bytes (the new run keeps it);
  // otherwise, write a new draft under the “script not from a file” rule.
  const inlineDraft =
    parsed.path === undefined
      ? await writeWorkflowDraft({
          cwd,
          name: resolveWorkflowDraftName(parsed.name ?? parsed.predecessor?.name, causalityGraph),
          source: script,
        })
      : undefined;
  // Record a file as model-authored only when the model wrote the script in this call. Do not do so for a new draft of an inherited
  // script: those bytes may come from another session or before compaction, and read-before-edit is meant to prevent claiming the model
  // has seen content it has not.
  if (inlineDraft !== undefined && parsed.predecessor?.script_inherited !== true) {
    await recordAuthoredWorkflowDraft(context, {
      path: inlineDraft.path,
      source: script,
      toolName: "AmendWorkflow",
    });
  }
  // A run always records the file **containing this revision's script**. If the script changed, never reuse the predecessor's path:
  // that file contains the old script, so attaching it to the new run would make the model edit code that is no longer running next
  // time. An inherited script can keep the predecessor's file only if its current bytes still match, as verified by resolveKeptScriptFile.
  const scriptPath = parsed.path ?? inlineDraft?.path;
  const location: WorkflowScriptLocation | undefined =
    scriptPath === undefined
      ? undefined
      : {
          kind: parsed.path === undefined ? "draft" : "path",
          described: describeWorkflowScriptPath(scriptPath, cwd),
          lineOffset: parsed.script_line_offset ?? 0,
        };

  if (!ok) {
    // Compilation failed: nothing was stopped or created.
    return {
      diagnostics,
      ok,
      response: compileFailureResponse(parsed, diagnostics, location),
      ...(causalityGraph === undefined ? {} : { causalityGraph }),
    } satisfies CreateWorkflowOutput;
  }

  const port = context.dynamicWorkflowRunPort;
  if (port === undefined) {
    return {
      diagnostics,
      ok,
      response: `The revised workflow script compiled cleanly.\n\n${EXECUTION_UNAVAILABLE_NOTE}`,
      ...(causalityGraph === undefined ? {} : { causalityGraph }),
    } satisfies CreateWorkflowOutput;
  }
  if (typeof port.amend !== "function") return amendUnavailableFailure();

  const amended = await port.amend(
    {
      scriptText: script,
      cwd: context.workingDirectory,
      predecessorRunId: parsed.run_id,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      parentSessionId: context.sessionId,
      toolCallId: context.toolCallId,
      // Use the declaration stage table for the new script. Revisions inherit inputId from the predecessor, but the sidebar timeline
      // must show stations from the new script. The index in the “running simultaneously” table refers to this new table, so both must
      // come from the same graph.
      ...(() => {
        const phaseNames = createWorkflowPhaseNames(causalityGraph);
        if (phaseNames === undefined) return {};
        const phaseAlongside = createWorkflowPhaseAlongside(causalityGraph);
        return { phaseNames, ...(phaseAlongside === undefined ? {} : { phaseAlongside }) };
      })(),
      // resolveInput normalized the three states to one number or none. `null` can only come from a caller bypassing normalization
      // (the port does not accept it), so treat it as absent as well.
      ...(typeof parsed.max_concurrency === "number"
        ? { maxConcurrency: parsed.max_concurrency }
        : {}),
      // Same as above: resolveInput normalized the three states to one canonical model or none. `null` can only come from a caller
      // bypassing normalization, so treat it as absent (the port does not accept it).
      ...(() => {
        const subagentModel = parseWorkflowSubagentModel(parsed.subagent_model ?? undefined);
        return subagentModel === undefined ? {} : { subagentModel };
      })(),
      // Models named by the new script: resolveInput normalized these into a table using “same name inherits from predecessor”; the port does not inherit any bindings.
      ...(() => {
        const selections = scriptModelSelections(modelBindings);
        return selections === undefined ? {} : { modelBindings: selections };
      })(),
      // Script file for this revision. If absent, draft persistence failed, so return the existing model-facing message.
      ...(scriptPath === undefined ? {} : { scriptPath }),
      trace: resolveTraceContext(context),
    },
    { signal: context.abortSignal },
  );
  if (!amended.ok) return amendRefusalFor(amended.reason, parsed.run_id);

  const superseded =
    amended.supersededRunId === undefined
      ? `Run ${parsed.run_id} had already settled; its finished work is imported as cache.`
      : `Run ${amended.supersededRunId} was still running: it has been stopped and superseded, and everything it finished before the stop is imported as cache. It will not send a notification of its own.`;
  // When reusing the script, say it is unchanged so the model knows this revision only changes settings and does not need to inspect a new script it did not write.
  const started =
    parsed.predecessor?.script_inherited === true
      ? `The script of run ${parsed.run_id} started unchanged in the background as run ${amended.runId}.`
      : `The revised script started in the background as run ${amended.runId}.`;
  const defaultConcurrency = port.defaultConcurrency?.();
  // Adjustment in the confirmation dialog: same sentence and same location as CreateWorkflow (workflow-settings-adjustment.ts).
  const settingsSentences = describeWorkflowRunSettings({
    applied: readAppliedWorkflowSettings(context.inputAdjustments),
    defaultConcurrency,
    describeLimit: () =>
      describeWorkflowConcurrencyLimit(parsed.max_concurrency ?? undefined, defaultConcurrency),
    describeModel: () => describeWorkflowSubagentModel(parsed.subagent_model ?? undefined),
    describeScriptModels: () => describeScriptModelBindings(modelBindings),
  });
  return {
    diagnostics,
    ok,
    // Follow CreateWorkflow's backgrounded guidance: provide the ID, say it is still running and results will arrive as a notification,
    // and explicitly discourage default polling.
    response: `${superseded} ${started} It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.${settingsSentences}${location === undefined ? "" : workflowAmendedScriptSentence(location)}`,
    status: "backgrounded",
    backgroundTaskId: amended.runId,
    ...(causalityGraph === undefined ? {} : { causalityGraph }),
  } satisfies CreateWorkflowOutput;
}

/**
 * Confirmation preview: share the same code as CreateWorkflow (if compilation fails, let the handler return diagnostics).
 * The display kind remains `create_workflow` so the UI has one implementation of the graph, draft pen, and diagnostic card.
 * The tool name and `run_id` / `predecessor` input communicate that this is a revision.
 */
function prepareAmendWorkflowApproval(input: unknown): ToolApprovalGate {
  const parsed = AmendWorkflowInputSchema.safeParse(input);
  // With no script, there is nothing to approve. Allow both cases here:
  //   - In-place concurrency changes (docs/dynamic-workflow/launch.md, “No window, for any owner”): the dialog presents the script that will run,
  //     but this route runs no script and only changes a number; ownership is irrelevant—a dialog for another user's run could make “approved nothing” look like approval of a new run.
  //   - If normalization was bypassed, allow the handler to return a structured failure; opening a dialog would still provide nothing to approve.
  if (!parsed.success || parsed.data.script === undefined) return { gate: "proceed" };
  const analysis = analyzeScript(parsed.data.script);
  if (!analysis.ok) return { gate: "proceed" };
  // An unbound model name follows CreateWorkflow: skip the dialog and let the handler report 9011.
  if (!allScriptModelsBound(analysis, readScriptModelBindings(parsed.data))) {
    return { gate: "proceed" };
  }
  const display = displayOfAnalysis(analysis, AMEND_WORKFLOW_TOOL_NAME);
  return { gate: "ask", ...(display ? { display } : {}) };
}

export const amendWorkflowToolEntry: ToolEntry = {
  capability:
    "Revise an existing dynamic-workflow run with a new script: stop it if it is still running, import its finished work, and start the revision in the background",
  metadata: {
    name: AMEND_WORKFLOW_TOOL_NAME,
    description: AMEND_WORKFLOW_TOOL_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: AMEND_WORKFLOW_TIMEOUT_MS,
    maxOutputBytes: AMEND_WORKFLOW_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: amendWorkflowHandler,
  // A revision may provide at most one script source. This applies only to model input (after normalization, both `script` and `path` may be present).
  validateInput: (input) => validateAmendWorkflowSource(input),
  resolveInput: async (input, context) => {
    // The skill gate runs before predecessor resolution: a revision with `path` / `script` is editing a script; a settings-only call reuses the predecessor's script and passes through.
    if (amendWorkflowNeedsSkill(input)) {
      const refused = requireDynamicWorkflowSkill(context, AMEND_WORKFLOW_TOOL_NAME);
      if (refused) return refused;
    }
    // Populate the block only for shapes that open the dialog: normalized in-place concurrency updates have no script and therefore no confirmation dialog.
    return withWorkflowAdjustableSettings(
      await resolveAmendWorkflowInput(input, context),
      context,
      (resolved) => resolved.script !== undefined,
    );
  },
  applyInputAdjustments: (input, adjustments, context) =>
    applyWorkflowSettingsAdjustments(input, adjustments, context, {
      errorCode: AMEND_WORKFLOW_ERROR_CODE.SUBAGENT_MODEL,
      schema: AmendWorkflowInputSchema,
    }),
  prepareApproval: prepareAmendWorkflowApproval,
  inputSchema: AmendWorkflowInputJsonSchema,
  outputSchema: CreateWorkflowOutputJsonSchema,
  runtimeInputSchema: AmendWorkflowInputSchema,
  runtimeOutputSchema: CreateWorkflowOutputSchema,
  formatModelContent: formatAmendWorkflowModelContent,
  permission: {
    permission: "createWorkflow",
    reason: "amendWorkflow.runConfirmation: user must confirm running the revised script",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // Same gate as CreateWorkflow (alwaysAsk); the permission service's owner rule allows this session's own run through the always-ask branch.
    alwaysAsk: true,
    askOptions: { allowAlways: "session" },
  },
  resultBudget: {
    maxInlineBytes: AMEND_WORKFLOW_MODEL_BYTES,
    maxModelBytes: AMEND_WORKFLOW_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: AMEND_WORKFLOW_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: AMEND_WORKFLOW_TIMEOUT_MS,
    maxMs: AMEND_WORKFLOW_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "AmendWorkflow typechecks synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatAmendWorkflowModelContent(output: unknown): ModelMessageContent {
  const parsed = CreateWorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return "AmendWorkflow returned an invalid result.";
  return parsed.data.response;
}
