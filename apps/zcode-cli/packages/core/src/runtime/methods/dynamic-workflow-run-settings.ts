import { randomUUID } from "node:crypto";
import {
  AMEND_WORKFLOW_TOOL_NAME,
  boundWorkflowLaunchMeta,
  createWorkflowPhaseAlongside,
  createWorkflowPhaseNames,
  type DynamicWorkflowRunRetuneResult,
  type TraceContext,
  type WorkflowSettingsAmendMeta,
} from "@zcode/contracts";
import {
  resolveAmendMaxConcurrency,
  resolveAmendSubagentModelChoice,
} from "../../tool/handlers/amend-workflow-resolve.js";
import { resolveKeptScriptFile } from "../../tool/handlers/amend-workflow-source.js";
import { parseWorkflowSubagentModel } from "../../tool/handlers/model-reference.js";
import {
  boundGraphOfAnalysis,
  displayOfAnalysis,
} from "../../tool/handlers/workflow-analysis-display.js";
import {
  resolveWorkflowDraftName,
  writeWorkflowDraft,
} from "../../tool/handlers/workflow-drafts.js";
import { analyzeScript } from "../../tool/handlers/workflow-script-analysis.js";
import type { ExecutableToolCall } from "../../tool/types.js";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { boundedCompileDiagnostics } from "./dynamic-workflow-run-start.js";
import {
  buildSettingsMessageText,
  enqueueSettingsTurn,
  fromTo,
  runSettingsOfSnapshot,
  type RunSettings,
} from "./dynamic-workflow-run-settings-turn.js";

export { buildSettingsMessageText } from "./dynamic-workflow-run-settings-turn.js";

/**
 * Request from the GUI's "Configure" action. Both settings follow the tool's three-state semantics:
 * omitted = inherit, `null` = use the default (session model / machine ceiling), value = set explicitly.
 */
export interface AmendWorkflowRunSettingsInput {
  runId: string;
  subagentModel?: string | null;
  maxConcurrency?: number | null;
  traceContext?: TraceContext;
}

/** Rejection vocabulary must exactly match shared's `workflowRunSettingsRejectionReasonSchema`. */
export type AmendWorkflowRunSettingsRejection =
  | "not_found"
  | "not_configurable"
  | "unchanged"
  | "script_missing"
  | "model_unavailable"
  | "compile_failed"
  | "missing_boundaries"
  | "start_failed";

export type AmendWorkflowRunSettingsResult =
  | { ok: true; runId: string; toolCallId: string; supersededRunId?: string }
  | { ok: false; reason: AmendWorkflowRunSettingsRejection; message?: string };

/**
 * GUI "Configure": revise a run with new settings while keeping the same script.
 *
 * This is the **second caller** of `port.amend` and `port.retuneConcurrency`, mirroring the AmendWorkflow tool:
 * the same three-state normalization (`resolveAmendSubagentModelChoice` / `resolveAmendMaxConcurrency`, not duplicated), same routing,
 * same compilation, and same background tracker (synthesize an AmendWorkflow descriptor). The differences are that it does not use a model turn or open
 * a confirmation window (clicking Apply in the dialog is consent, and the script is the one the user already approved), inherits arguments from the predecessor
 * (`inheritArgs`), and records the operation in the session using a queued controlOnly "settings turn."
 *
 * When only concurrency changes and the run is still in flight, the branch below applies it **in place**: same runId, no stop, no successor.
 *
 * Order is fixed: every failure before `port.amend` / `port.retuneConcurrency` has zero side effects—the old run keeps running, with no new row or message.
 */
export async function amendWorkflowRunSettings(
  this: AgentRuntimeInternal,
  input: AmendWorkflowRunSettingsInput,
): Promise<AmendWorkflowRunSettingsResult> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const port = this.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.amend !== "function") {
    // This capability is registered only when the port provides amend and getScript; if either is missing here, it is a wiring failure, not user input.
    return { ok: false, reason: "start_failed", message: "dynamic workflow amend unavailable" };
  }

  // (1) The run must exist and belong to this session; a command sent to a session may change only that session's own run.
  const snapshot = await port.getTask(input.runId);
  if (snapshot === undefined || snapshot.parentSessionId !== this.sessionId) {
    return { ok: false, reason: "not_found" };
  }
  // (2) Completed runs replay each ask from cache, so new settings have nowhere to take effect; a superseded run's successor is the one that remains active.
  if (snapshot.runStatus === "completed" || snapshot.supersededBy !== undefined) {
    return { ok: false, reason: "not_configurable" };
  }
  // (3)(4) Normalize both settings with the same three-state logic as the tool.
  const current = runSettingsOfSnapshot(snapshot);
  const model = resolveAmendSubagentModelChoice(
    input.subagentModel,
    current.subagentModel,
    this.modelCatalogPort,
  );
  if (!model.ok) {
    // The message for a missing directory is written for the model ("omit subagent_model"), while the GUI needs only the reason code.
    // When a directory exists, resolution diagnostics (such as candidate names) are useful to people too, so include them in the message.
    return {
      ok: false,
      reason: "model_unavailable",
      ...(this.modelCatalogPort === undefined ? {} : { message: model.message }),
    };
  }
  const ceiling = port.concurrencyCeiling?.();
  const bound = resolveAmendMaxConcurrency(input.maxConcurrency, current.maxConcurrency, ceiling);
  // A bound at the ceiling means "no per-run limit": snapshots include maxConcurrency only below the ceiling, using the same interpretation on both sides.
  // This makes the "unchanged" comparison work (the dialog sends null at the maximum; this also handles callers that pass the number directly).
  const nextBound =
    bound.max_concurrency === undefined || bound.max_concurrency === ceiling
      ? undefined
      : bound.max_concurrency;
  const next: RunSettings = {
    ...(model.canonical === undefined ? {} : { subagentModel: model.canonical }),
    ...(nextBound === undefined ? {} : { maxConcurrency: nextBound }),
  };
  // (5) Do not start a new run when nothing changed: a revision stops the in-flight run, so there is no reason to pay that cost for a no-op.
  const modelChanged = next.subagentModel !== current.subagentModel;
  const boundChanged = next.maxConcurrency !== current.maxConcurrency;
  if (!modelChanged && !boundChanged) return { ok: false, reason: "unchanged" };

  // (6) Branch: if only concurrency changed and the run is still in flight, apply it in place—same runId, no stop, no successor, no cache import.
  // If the port answers not_live (settled, or pending before the engine exists), continue through the steps below and perform the current revision flow.
  if (boundChanged && !modelChanged && typeof port.retuneConcurrency === "function") {
    // Pass the dialog's `null` unchanged to the port; only the port knows the ceiling, so do not guess it again here. Missing can occur only when
    // an inherited bound exceeds this machine's ceiling (the run started on a larger machine), in which case returning to the ceiling is the intended behavior.
    const answer = await port.retuneConcurrency({
      runId: input.runId,
      maxConcurrency: input.maxConcurrency ?? null,
    });
    if (answer.ok) {
      return retunedSettings.call(this, {
        answer,
        name: displayNameOfSnapshot(snapshot),
        runId: input.runId,
        traceContext,
      });
    }
    if (answer.reason === "unchanged") return { ok: false, reason: "unchanged" };
  }

  // (7) Inherit the script (the same read path as "Keeping the predecessor's script"). Read it **after** the branch: an in-place concurrency change
  // runs the same script, so its limit can still be adjusted even if that run has no saved script or the script no longer compiles.
  const script =
    typeof port.getScript === "function" ? await port.getScript(input.runId) : undefined;
  if (script === undefined || script.length === 0) {
    return { ok: false, reason: "script_missing" };
  }

  // (8) Compile. The saved script may have been written against an earlier facade; if it no longer compiles, stop here without changing the old run.
  const analysis = analyzeScript(script);
  if (!analysis.ok || analysis.diagnostics.length > 0) {
    return {
      ok: false,
      reason: "compile_failed",
      message: boundedCompileDiagnostics(
        `The stored script of run ${input.runId} has errors:`,
        analysis.diagnostics,
      ),
    };
  }

  // —— No side effects up to this point. ——

  // Persist the new run's script using the same rule and code as script inheritance in the tool:
  // if the predecessor's script file still has these exact bytes, keep referencing it; otherwise write a new draft as for a script not sourced from a file.
  // Without this, a later revision would require copying the entire script inline. Draft writing is best-effort: if it fails,
  // continue starting the run. This is the only write before amend, so at worst it leaves an unreferenced draft file.
  const graph = boundGraphOfAnalysis(analysis);
  const keptFile = await resolveKeptScriptFile({
    cwd: this.workingDirectory,
    scriptPath: snapshot.scriptPath,
    script,
  });
  const scriptPath =
    keptFile?.path ??
    (
      await writeWorkflowDraft({
        cwd: this.workingDirectory,
        name: resolveWorkflowDraftName(snapshot.name, graph),
        source: script,
      })
    )?.path;

  // (8) Revise. The `settings-` prefix distinguishes this in logs and cards from model tool calls (`tool_*`) and hub launches (`launch-`).
  const toolCallId = `settings-${randomUUID()}`;
  const phaseNames = createWorkflowPhaseNames(graph);
  const phaseAlongside = phaseNames === undefined ? undefined : createWorkflowPhaseAlongside(graph);
  const subagentModel = parseWorkflowSubagentModel(next.subagentModel);
  let amended: Awaited<ReturnType<NonNullable<typeof port.amend>>>;
  try {
    amended = await port.amend({
      scriptText: script,
      cwd: this.workingDirectory,
      predecessorRunId: input.runId,
      parentSessionId: this.sessionId,
      toolCallId,
      ...(phaseNames === undefined ? {} : { phaseNames }),
      ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
      ...(next.maxConcurrency === undefined ? {} : { maxConcurrency: next.maxConcurrency }),
      ...(subagentModel === undefined ? {} : { subagentModel }),
      ...(scriptPath === undefined ? {} : { scriptPath }),
      // The rerun uses the predecessor's own script and the arguments it had when it started.
      inheritArgs: true,
      trace: traceContext,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "start_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!amended.ok) {
    return {
      ok: false,
      reason: amended.reason === "run_not_found" ? "not_found" : "missing_boundaries",
    };
  }

  // Use only the run's own name: leave it absent when the run has no name, and let cards, sidebars, and notifications use their normal fallback for unnamed runs.
  // This previously fell back to `run <id>`, making settings-turn card and sidebar titles a run ID string;
  // that invented name also propagated through the revision chain.
  const name = displayNameOfSnapshot(snapshot);
  const amend: WorkflowSettingsAmendMeta = {
    predecessorRunId: input.runId,
    ...(modelChanged ? { subagentModel: fromTo(current.subagentModel, next.subagentModel) } : {}),
    ...(boundChanged
      ? { maxConcurrency: fromTo(current.maxConcurrency, next.maxConcurrency) }
      : {}),
    ...(ceiling === undefined ? {} : { ceiling }),
  };

  // (9)(10) Failures after this point are logged but not rolled back: the new run is already in flight and can be stopped in the sidebar; undoing it would create an orphan.
  try {
    // Background tracking: synthesize an AmendWorkflow descriptor and use the executor's normal registration path (registry, terminal waiter,
    // completion notification). `input.name` supplies the notification subject; the tool name routes dispatch under "workflow."
    const toolCall: ExecutableToolCall = {
      id: toolCallId,
      name: AMEND_WORKFLOW_TOOL_NAME,
      input: { run_id: input.runId, ...(name === undefined ? {} : { name }) },
    };
    await this.executor.trackExternalBackgroundTask(
      toolCall,
      { backgroundTaskId: amended.runId, status: "backgrounded" },
      traceContext,
      undefined,
    );
    enqueueSettingsTurn.call(this, {
      text: buildSettingsMessageText({
        ...(name === undefined ? {} : { name }),
        previous: input.runId,
        runId: amended.runId,
        superseded: amended.supersededRunId !== undefined,
        amend,
      }),
      meta: boundWorkflowLaunchMeta({
        runId: amended.runId,
        toolCallId,
        ...(name === undefined ? {} : { name }),
        ...(() => {
          const display = displayOfAnalysis(analysis);
          return display?.kind === "create_workflow" ? { display } : {};
        })(),
        amend,
      }),
      // The session must already be persisted (it owns a run), so the title seed will not be used; provide an accurate value.
      titleInput: name ?? input.runId,
      traceContext,
    });
  } catch (error) {
    this.logger?.error(
      "Workflow settings amended but post-amend bookkeeping failed",
      error instanceof Error ? error : new Error(String(error)),
      {
        ...traceContextToLogContext(traceContext),
        event: "dynamic_workflow.settings.post_amend_failed",
        module: "core.runtime",
        runId: amended.runId,
        toolCallId,
      },
    );
  }

  return {
    ok: true,
    runId: amended.runId,
    toolCallId,
    ...(amended.supersededRunId === undefined ? {} : { supersededRunId: amended.supersededRunId }),
  };
}

/**
 * Finish an in-place change: same runId, no `supersededRunId`, and **do not register a second background task**—the run is already in the tracker,
 * and registering it again would clear the completion state of a run that never stopped under AmendWorkflow's rearm rule.
 *
 * Record the settings turn, but omit `predecessorRunId` from the `amend` block; its absence means "applied in place," so the renderer draws one row,
 * and no second run card (two cards for one run look like two runs). There is no `display` either; this path does not compile.
 */
function retunedSettings(
  this: AgentRuntimeInternal,
  options: {
    answer: Extract<DynamicWorkflowRunRetuneResult, { ok: true }>;
    name: string | undefined;
    runId: string;
    traceContext: TraceContext;
  },
): AmendWorkflowRunSettingsResult {
  const { answer, name, runId, traceContext } = options;
  const toolCallId = `settings-${randomUUID()}`;
  // A side equal to the ceiling means "default," so omit that side entirely, matching the revision path's representation.
  // (The dialog sends `null` when the stepper is at the maximum, but the port always returns an absolute value, so conversion happens here.)
  const amend: WorkflowSettingsAmendMeta = {
    maxConcurrency: fromTo(
      answer.previous === answer.ceiling ? undefined : answer.previous,
      answer.maxConcurrency === answer.ceiling ? undefined : answer.maxConcurrency,
    ),
    ceiling: answer.ceiling,
  };
  try {
    enqueueSettingsTurn.call(this, {
      text: buildSettingsMessageText({
        ...(name === undefined ? {} : { name }),
        previous: runId,
        runId,
        superseded: false,
        amend,
      }),
      meta: boundWorkflowLaunchMeta({
        runId,
        toolCallId,
        ...(name === undefined ? {} : { name }),
        amend,
      }),
      titleInput: name ?? runId,
      traceContext,
    });
  } catch (error) {
    // Log and continue: the bound has **already** taken effect. Rolling back a record cannot undo it, and undoing this change is not what the user asked for.
    this.logger?.error(
      "Workflow run retuned but the settings turn could not be queued",
      error instanceof Error ? error : new Error(String(error)),
      {
        ...traceContextToLogContext(traceContext),
        event: "dynamic_workflow.settings.post_retune_failed",
        module: "core.runtime",
        runId,
        toolCallId,
      },
    );
  }
  return { ok: true, runId, toolCallId };
}

/** The run's own name (omitted when unnamed): settings turns and synthesized tracking both use this rule; never use the run ID as a title. */
function displayNameOfSnapshot(snapshot: { name?: string }): string | undefined {
  const trimmed = snapshot.name?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
