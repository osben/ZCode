// ============================================================
// CreateWorkflow Tool Handler
// ============================================================
// Typechecks a dynamic-workflow script against the facade, and — once the user has
// confirmed at the gate — starts the run in the background through
// `DynamicWorkflowRunPort`.
//
// Two paths, selected by whether the port is injected:
//   1. Port present (production wiring): clean compile + Allow → port.submit → return
//      {status:"backgrounded", backgroundTaskId: runId}; the result returns to the main agent
//      through the background-notification pipeline.
//   2. Port absent (unwired host, unit test): preserve the pre-wiring placeholder behavior—
//      return only diagnostics and the causal graph; execute nothing.
//
// The invalid-script path is independent of the port and remains unchanged: `prepareApproval`
// suppresses the dialog, and the handler returns diagnostics directly without starting or
// creating a run. Asking the user to approve code that does not compile would only interrupt the
// agent's own repair/retry loop with a decision that has no effect.

import {
  CreateWorkflowInputJsonSchema,
  CreateWorkflowInputSchema,
  CreateWorkflowOutputJsonSchema,
  CreateWorkflowOutputSchema,
  type CreateWorkflowInput,
  type CreateWorkflowOutput,
  type ModelMessageContent,
  type TraceContext,
  createWorkflowPhaseAlongside,
  createWorkflowPhaseNames,
} from "@zcode/contracts";
import type {
  ToolApprovalGate,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
} from "../types.js";
import { CREATE_WORKFLOW_TOOL_DESCRIPTION } from "./create-workflow-description.js";
import {
  CREATE_WORKFLOW_FAILURE_CODE,
  resolveCreateWorkflowInput,
  validateCreateWorkflowSource,
} from "./create-workflow-source.js";
import {
  describeWorkflowSubagentModel,
  parseWorkflowSubagentModel,
} from "./model-reference.js";
import { boundGraphOfAnalysis, displayOfAnalysis } from "./workflow-analysis-display.js";
import { recordAuthoredWorkflowDraft } from "./workflow-draft-read-state.js";
import { resolveWorkflowDraftName, writeWorkflowDraft } from "./workflow-drafts.js";
import {
  formatWorkflowDiagnosticLines,
  workflowLaunchedScriptSentence,
  workflowSavedDraftNote,
  workflowScriptFileNote,
  type WorkflowScriptLocation,
} from "./workflow-script-notes.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";
import { createWorkflowNeedsSkill, requireDynamicWorkflowSkill } from "./workflow-skill-gate.js";
import {
  allScriptModelsBound,
  describeScriptModelBindings,
  readScriptModelBindings,
  scriptModelSelections,
  unresolvedScriptModelDiagnostics,
  withScriptModelBindingsResolved,
} from "./workflow-script-models.js";
import {
  applyWorkflowSettingsAdjustments,
  describeWorkflowRunSettings,
  readAppliedWorkflowSettings,
  withWorkflowAdjustableSettings,
} from "./workflow-settings-adjustment.js";

const CREATE_WORKFLOW_TOOL_NAME = "CreateWorkflow";
const CREATE_WORKFLOW_TIMEOUT_MS = 15_000;
const CREATE_WORKFLOW_MODEL_BYTES = 24_000;

// Split the "not executed" NOTE by path into two statements, each describing only facts that are
// true on that path. The old single constant (PLACEHOLDER_HINT) became false in both claims after
// engine wiring: it said the execution model was still under development and this tool only did
// type checking, while a clean script with the port present now starts a background run. The
// model is the only reader of this text; false guidance may cause it to skip submission or submit
// again.
export const DIAGNOSTICS_NOT_EXECUTED_NOTE =
  "NOTE: The workflow was NOT executed — fix the errors above and resubmit.";
export const EXECUTION_UNAVAILABLE_NOTE =
  "NOTE: The workflow was NOT executed — workflow execution is not available in this session, so the script was only typechecked.";

const createWorkflowHandler: ToolHandler = async (input, context) => {
  // Input has already been normalized by resolveInput here: `script` is always present, so both
  // sources have the same shape. `saved` is provenance only (the run label fallback and argument
  // persistence read it); execution does not read a single byte from it. Therefore, if a hook
  // changes `saved` after normalization, that is **intentionally ineffective** and cannot change
  // what will run.
  const parsed = CreateWorkflowInputSchema.parse(input) as CreateWorkflowInput;
  const script = parsed.script;
  if (script === undefined) {
    // Unreachable: validateInput rejects "neither provided," and resolveInput fills script from
    // saved. If this happens, something bypassed the executor lifecycle; report it instead of
    // silently running an empty script.
    throw new Error("CreateWorkflow handler received input without a resolved script");
  }
  const saved = parsed.saved;
  const cwd = context.workingDirectory;

  const analysis = analyzeScript(script);
  // Models named by the script (docs/dynamic-workflow/launch.md, “Models the script names”): `resolveInput` has written resolvable names
  // to `model_bindings`; report unbound names as 9011 here, using the same path as compilation errors because the script must be changed.
  const modelBindings = readScriptModelBindings(parsed);
  const modelDiagnostics = analysis.ok
    ? unresolvedScriptModelDiagnostics(analysis, modelBindings, context.modelCatalogPort)
    : [];
  const diagnostics = [...analysis.diagnostics, ...modelDiagnostics];
  const ok = analysis.ok && modelDiagnostics.length === 0;
  // The confirmation dialog and persisted output use the same static analysis; no model call
  // changes the name in between.
  const causalityGraph = boundGraphOfAnalysis(analysis);

  // Always persist a working copy of an inline script, **regardless of compile result**:
  // scripts that do not compile never reach the confirmation dialog, so the handler is their
  // only required path. Not writing them would leave the only script needing edits without a
  // file. Run analysis first only to determine its name: without `name`, use the first stage name
  // from the graph. A copy of the saved source was already written in resolveInput; path sources
  // are not written.
  const inlineDraft =
    saved === undefined && parsed.path === undefined
      ? await writeWorkflowDraft({
          cwd,
          name: resolveWorkflowDraftName(parsed.name, causalityGraph),
          source: script,
        })
      : undefined;
  // This draft contains exactly the bytes in the model's current `script`; record that it wrote
  // the file so the next Edit does not need a prior Read.
  if (inlineDraft !== undefined) {
    await recordAuthoredWorkflowDraft(context, {
      path: inlineDraft.path,
      source: script,
      toolName: "CreateWorkflow",
    });
  }
  const location = describeScriptLocation(parsed, inlineDraft?.path, cwd);

  if (!ok) {
    return {
      diagnostics,
      ok,
      response: [
        // A saved definition failing to compile is **its** problem, not an input issue with this
        // call. Without naming the file, the model may think it just made a mistake and retry the
        // same input unchanged.
        saved === undefined
          ? "The workflow script has errors:"
          : `The saved workflow '${saved.name}'${saved.path === undefined ? "" : ` (${saved.path})`} has errors:`,
        // If there is a file, report **file lines** (line numbers can be pasted directly into an
        // `Edit` call). Keep the `diagnostics` array in the output unchanged; the transcript view
        // renders the body.
        ...formatWorkflowDiagnosticLines(diagnostics, location),
        "",
        diagnosticsNote(parsed, location, cwd),
      ].join("\n"),
      ...(causalityGraph === undefined ? {} : { causalityGraph }),
    } satisfies CreateWorkflowOutput;
  }

  const port = context.dynamicWorkflowRunPort;
  if (port === undefined) {
    // Unwired host: preserve placeholder semantics. Deliberately do not degrade to "pretend it
    // started"; the model would wait for a notification that will never arrive.
    return {
      diagnostics,
      ok,
      response: `The workflow script compiled cleanly.\n\n${EXECUTION_UNAVAILABLE_NOTE}`,
      ...(causalityGraph === undefined ? {} : { causalityGraph }),
    } satisfies CreateWorkflowOutput;
  }

  // Always record an **absolute path** for the run: it is part of run identity, while the
  // session working directory may change. `location.described` controls how the model sees it
  // (another representation of the same absolute path, not a different source).
  const scriptPath = resolveSubmittedScriptPath(parsed, inlineDraft?.path);

  // Submission failures (corrupt compiled output, unavailable journal) propagate as tool-call
  // failures. Never swallow them as successful output with a backgroundTaskId, which would make
  // the background tracker poll a nonexistent run.
  const submitted = await port.submit(
    {
      scriptText: script,
      cwd: context.workingDirectory,
      // Persist the optional display name through to dwf_run.name (submit → EngineConfig →
      // createRun); do not leave it only in the tool row and task-title fallback chain, or runs
      // enumerated across sessions will show only a bare runId.
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      // Arguments follow the same metadata path as name / scriptText / cwd: submit → EngineConfig
      // → createRun persists dwf_run.args_json → inject into the sandbox. Inline runs have no
      // arguments, so omit the field; the sandbox interprets absence as `{}` (invariant 7: `args`
      // is always defined).
      // Each source has its own location: for `saved`, arguments live in `saved.args`; for
      // `path`, they live in top-level `args` (the model-facing form). They cannot both be
      // present because validateInput binds `args` and `path` together.
      ...(() => {
        const args = parsed.args ?? saved?.args;
        return args === undefined ? {} : { args };
      })(),
      parentSessionId: context.sessionId,
      toolCallId: context.toolCallId,
      // Pass the declared phase table through run-launched so the sidebar mini-track can render
      // stages. The concurrent-phase table uses the same source and row; its index refers to the
      // same table, so computing it separately could misalign them.
      ...(() => {
        const phaseNames = createWorkflowPhaseNames(causalityGraph);
        if (phaseNames === undefined) return {};
        const phaseAlongside = createWorkflowPhaseAlongside(causalityGraph);
        return { phaseNames, ...(phaseAlongside === undefined ? {} : { phaseAlongside }) };
      })(),
      // resolveInput already rounds the concurrency limit down to at least 1 (the confirmation dialog shows the effective value), with no upper bound;
      // if absent, use default concurrency and do not create an empty key.
      ...(parsed.max_concurrency === undefined ? {} : { maxConcurrency: parsed.max_concurrency }),
      // The subagent model was also resolved to canonical form in resolveInput (unresolvable
      // calls cannot reach here), so just split the string back into a structured selection.
      // Absence means inherit the session model; do not create an empty key. The port interprets
      // field presence as "this run explicitly selected a model."
      ...(() => {
        const subagentModel = parseWorkflowSubagentModel(parsed.subagent_model);
        return subagentModel === undefined ? {} : { subagentModel };
      })(),
      // Models named by the script follow the same path as the subagent model: they have been resolved to canonical form, so only unpack them into structured selections here. If no
      // models were named, omit the entire key.
      ...(() => {
        const selections = scriptModelSelections(modelBindings);
        return selections === undefined ? {} : { modelBindings: selections };
      })(),
      // Pass the script's home through run-launched; terminal notifications and GetWorkflowRun
      // read it back from there. If saving the draft failed, omit the field entirely: the port
      // interprets it as "this run has an editable file," and undefined would make that claim false.
      ...(scriptPath === undefined ? {} : { scriptPath }),
      trace: resolveTraceContext(context),
    },
    { signal: context.abortSignal },
  );

  const { runId } = submitted;
  const defaultConcurrency = port.defaultConcurrency?.();
  // Adjustments made in the confirmation dialog (docs/dynamic-workflow/launch.md, “Adjusting the settings in the window”): the input
  // already contains adjusted values, but the model's tool_use block still has its original values, so report the adjustments first.
  const settingsSentences = describeWorkflowRunSettings({
    applied: readAppliedWorkflowSettings(context.inputAdjustments),
    defaultConcurrency,
    describeLimit: () =>
      describeWorkflowConcurrencyLimit(parsed.max_concurrency, defaultConcurrency),
    describeModel: () => describeWorkflowSubagentModel(parsed.subagent_model),
    describeScriptModels: () => describeScriptModelBindings(modelBindings),
  });

  return {
    diagnostics,
    ok,
    // Wording follows backgrounded Bash (bash-model-content.ts): provide the ID, say it is still
    // running, and state that the result will arrive as a notification. The placeholder hint must
    // disappear on this path.
    // After receiving backgrounded output, the model may immediately block on TaskOutput,
    // turning an asynchronous run into a synchronous wait. Explicitly discourage default polling
    // in the wording (TaskOutput remains available when the user explicitly asks to wait; this
    // changes only default guidance, not tool semantics).
    response: `The workflow script compiled cleanly and the run started in the background with ID: ${runId}. It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.${settingsSentences}${location === undefined ? "" : workflowLaunchedScriptSentence(location)}`,
    status: "backgrounded",
    backgroundTaskId: runId,
    ...(causalityGraph === undefined ? {} : { causalityGraph }),
  } satisfies CreateWorkflowOutput;
};

/**
 * Script file for this run (absolute path, persisted with the submission in the journal): the
 * `path` source uses its original file, the `saved` source uses its newly written copy, and the
 * inline source uses its newly written draft. All three may be absent if writing the draft fails.
 */
function resolveSubmittedScriptPath(
  parsed: CreateWorkflowInput,
  inlineDraft: string | undefined,
): string | undefined {
  if (parsed.path !== undefined) return parsed.path;
  if (parsed.saved !== undefined) return parsed.saved.draft;
  return inlineDraft;
}

/** Script-file identity shown to the model; absent when there is no file (draft write failed),
 * causing wording to fall back to the previous form. */
function describeScriptLocation(
  parsed: CreateWorkflowInput,
  inlineDraft: string | undefined,
  cwd: string,
): WorkflowScriptLocation | undefined {
  const absolute = resolveSubmittedScriptPath(parsed, inlineDraft);
  if (absolute === undefined) return undefined;
  return {
    // A `path` source is a file supplied by the model, not just written by the tool, so use a different verb.
    kind: parsed.path === undefined ? "draft" : "path",
    described: describeWorkflowScriptPath(absolute, cwd),
    lineOffset: parsed.script_line_offset ?? 0,
  };
}

/**
 * NOTE shown when compilation fails. Three cases: for a saved source, name the definition it was
 * copied from; for other sources with a file, name the file; without a file, preserve the old
 * wording (on that path the model can only submit inline again).
 */
function diagnosticsNote(
  parsed: CreateWorkflowInput,
  location: WorkflowScriptLocation | undefined,
  cwd: string,
): string {
  const saved = parsed.saved;
  if (location === undefined) {
    return saved === undefined
      ? DIAGNOSTICS_NOT_EXECUTED_NOTE
      : "NOTE: The workflow was NOT executed — the saved file needs fixing (edit it, or save a corrected version).";
  }
  if (saved !== undefined) {
    return workflowSavedDraftNote({
      savedName: saved.name,
      // Show the definition using model-facing path syntax too: if it needs to edit the
      // definition, it will use `SaveWorkflow`. An absolute path among workspace-relative paths
      // would look like it belongs to another machine.
      savedPath:
        saved.path === undefined
          ? location.described
          : describeWorkflowScriptPath(saved.path, cwd),
      draft: location.described,
    });
  }
  return workflowScriptFileNote(location);
}

/**
 * One sentence in the result copy describing the effective concurrency limit (shared with `AmendWorkflow`). **Include it only when a limit is set**:
 * a run using default concurrency has nothing to report, and “up to N” would make the model think it had set a limit.
 *
 * Mark a limit equal to default concurrency as “(default)”: making that explicit tells the model the run is equivalent to having no limit,
 * so it will not later repeat or “correct” it as a limit it chose.
 */
export function describeWorkflowConcurrencyLimit(
  limit: number | undefined,
  defaultConcurrency: number | undefined,
): string {
  if (limit === undefined) return "";
  const subject = limit === 1 ? "1 subagent runs" : `${limit} subagents run`;
  return ` At most ${subject} at once${limit === defaultConcurrency ? " (the default)" : ""}.`;
}

/**
 * The port contract requires `trace` while `context.traceContext` is optional, so synthesize it
 * from the individual fields.
 */
export function resolveTraceContext(context: ToolExecutionContext): TraceContext {
  return (
    context.traceContext ??
    ({
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    } as TraceContext)
  );
}

/**
 * Decide whether "run this script" warrants interrupting the user, then construct the preview
 * rendered in the confirmation dialog.
 *
 * **The same code handles both source paths**: input was normalized by `resolveInput` and
 * `script` is always present, so this code neither knows nor needs to know whether it was written
 * inline or read from disk. A saved run therefore has a confirmation dialog identical byte for
 * byte to the inline case; the test "the same script produces identical display through both
 * paths" pins down this behavior.
 *
 * Let the handler handle two failure types without showing a dialog: input does not match the
 * schema, or compilation fails. Asking the user to approve code that does not compile would
 * interrupt the agent's own repair/retry loop with a decision that has no effect. (Parse errors
 * are already handled earlier in `resolveInput`, so they never reach here.)
 */
function prepareCreateWorkflowApproval(input: unknown): ToolApprovalGate {
  const parsed = CreateWorkflowInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.script === undefined) return { gate: "proceed" };

  const analysis = analyzeScript(parsed.data.script);
  if (!analysis.ok) return { gate: "proceed" };
  // A model named by the script is unbound (missing from the catalog): treat it like a compile failure, skip the dialog, and let the handler report 9011.
  if (!allScriptModelsBound(analysis, readScriptModelBindings(parsed.data))) {
    return { gate: "proceed" };
  }

  // The dialog supplies its own title and centers the graph; display uses the same constructor
  // as the launch-turn metadata for direct start.
  const display = displayOfAnalysis(analysis);
  return { gate: "ask", ...(display ? { display } : {}) };
}

export const createWorkflowToolEntry: ToolEntry = {
  capability:
    "Typecheck a dynamic-workflow TypeScript script against the facade and, once confirmed, start the run in the background",
  metadata: {
    shouldDefer: true,
    name: CREATE_WORKFLOW_TOOL_NAME,
    description: CREATE_WORKFLOW_TOOL_DESCRIPTION,
    // With the engine wired, this call starts an execution child process and multiple actor
    // sessions; update the read-only declaration to match the execution semantics.
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: CREATE_WORKFLOW_TIMEOUT_MS,
    maxOutputBytes: CREATE_WORKFLOW_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: createWorkflowHandler,
  // Exactly-one-of source applies only to model input (both are valid together after
  // normalization), so enforce it here rather than in the schema; see the CreateWorkflowInputSchema comment.
  validateInput: (input) => validateCreateWorkflowSource(input),
  // The only disk read in the entire flow. Hooks, permission rules, the confirmation dialog, and the handler all see the same bytes afterward.
  // Normalize the concurrency limit here too, before the dialog, so the user does not approve a value that will not take effect.
  // Read the model catalog here as well: resolve `subagent_model` to canonical form before the dialog, so the user does not approve
  // a name that has not been recognized and discover only after approval that it cannot be resolved.
  resolveInput: async (input, context) => {
    // Check the skill gate before any parsing: reject script submission if dynamic-workflows has
    // not been read (saved sources are exempt; see the gate module).
    if (createWorkflowNeedsSkill(input)) {
      const refused = requireDynamicWorkflowSkill(context, CREATE_WORKFLOW_TOOL_NAME);
      if (refused) return refused;
    }
    const resolved = await resolveCreateWorkflowInput(
      input,
      context.workingDirectory ?? ".",
      context.modelCatalogPort,
    );
    // Resolve script-named models after normalizing the script (all three sources now have `script`), so the dialog shows the bindings that will take effect.
    const resolution = withScriptModelBindingsResolved(resolved, context.modelCatalogPort);
    // Refill the two settings adjustable in the dialog along with normalization (docs/dynamic-workflow/launch.md, “Adjusting the settings
    // in the window”): use the input rather than display because display's field set is frozen.
    return withWorkflowAdjustableSettings(resolution, context);
  },
  applyInputAdjustments: (input, adjustments, context) =>
    applyWorkflowSettingsAdjustments(input, adjustments, context, {
      errorCode: CREATE_WORKFLOW_FAILURE_CODE,
      schema: CreateWorkflowInputSchema,
    }),
  prepareApproval: prepareCreateWorkflowApproval,
  inputSchema: CreateWorkflowInputJsonSchema,
  outputSchema: CreateWorkflowOutputJsonSchema,
  runtimeInputSchema: CreateWorkflowInputSchema,
  runtimeOutputSchema: CreateWorkflowOutputSchema,
  formatModelContent: formatCreateWorkflowModelContent,
  permission: {
    permission: "createWorkflow",
    // Diagnostic only, not user-facing: the confirmation dialog renders a localized title, and
    // the UI filters reasons that look like internal information.
    reason: "createWorkflow.runConfirmation: user must confirm running the analyzed script",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // A workflow is a complete execution plus model call; always ask first in every permission
    // mode, including yolo / plan.
    alwaysAsk: true,
    // "Each invocation is a different script" no longer applies to saved workflows: invoking by
    // name means the same name refers to the "same" workflow each time. But sameness is not enough
    // to skip confirmation. Always confirm for two stronger reasons: every run costs money and
    // has real side effects; and the saved file can change after approval (manual edit, git pull,
    // someone else's commit), so "this name was approved before" does not prove "this is the same
    // code." **Persistent** approval is never granted.
    //
    // What can be relaxed is **session-scoped**: after reviewing and approving the first script
    // in this session, the user may choose "Always allow in this session" to skip confirmation
    // for subsequent CreateWorkflow calls in this session. Authorization lives only in the
    // PermissionService instance's memory; restart / cold restore / `/new` starts from zero.
    askOptions: { allowAlways: "session" },
  },
  resultBudget: {
    maxInlineBytes: CREATE_WORKFLOW_MODEL_BYTES,
    maxModelBytes: CREATE_WORKFLOW_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: CREATE_WORKFLOW_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: CREATE_WORKFLOW_TIMEOUT_MS,
    maxMs: CREATE_WORKFLOW_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "CreateWorkflow typechecks synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatCreateWorkflowModelContent(output: unknown): ModelMessageContent {
  const parsed = CreateWorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return "CreateWorkflow returned an invalid result.";
  return parsed.data.response;
}
