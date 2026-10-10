import { randomUUID } from "node:crypto";
import {
  CREATE_WORKFLOW_TOOL_NAME,
  boundWorkflowLaunchMeta,
  createWorkflowPhaseAlongside,
  createWorkflowPhaseNames,
  type SavedWorkflowScope,
  type TraceContext,
} from "@zcode/contracts";
import type { CompileDiagnostic } from "@zcode/dynamic-workflow";
import {
  resolveSavedWorkflow,
  validateWorkflowArgs,
} from "../../tool/handlers/saved-workflows/index.js";
import {
  boundGraphOfAnalysis,
  displayOfAnalysis,
} from "../../tool/handlers/workflow-analysis-display.js";
import { writeWorkflowDraft } from "../../tool/handlers/workflow-drafts.js";
import { analyzeScript } from "../../tool/handlers/workflow-script-analysis.js";
import type { ExecutableToolCall } from "../../tool/types.js";
import { uuidv7 } from "@zcode/shared";
import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { emitControlOnlyUserTurn, persistWorkflowLaunchUserMessage } from "./control-only-turn.js";

/**
 * Structured result from `startSavedWorkflowRun`. On success, it provides the two run
 * correlation keys (`runId` ≡ backgroundTaskId ≡ cancelBackgroundWork's workId; and
 * `toolCallId` for linking the tool card to the detail page). On failure, `reason` is the
 * discriminator (house rule: use error codes, not text, for control flow) and `message`
 * carries a human-readable reason for inline GUI display.
 */
export type StartSavedWorkflowRunResult =
  | { ok: true; runId: string; toolCallId: string }
  | {
      ok: false;
      reason:
        | "invalid_name"
        | "not_found"
        | "invalid_args"
        | "compile_failed"
        | "session_busy"
        | "start_failed";
      message?: string;
    };

/** Limit for combined compile diagnostics (≈2 KB): diagnostics travel in the ACK `message`; longer stack traces are not useful to read. */
const COMPILE_DIAGNOSTICS_MAX_CHARS = 2_000;

/**
 * Start a saved workflow directly from the hub.
 *
 * This is the **second caller** of `port.submit` and mirrors the CreateWorkflow tool
 * path: it uses the same saved-workflow normalization (`resolveSavedWorkflow` +
 * `validateWorkflowArgs`, without duplication) and the same background tracker
 * (`trackExternalBackgroundTask` receives a synthetic CreateWorkflow descriptor). The
 * resulting run is indistinguishable for notifications / cancellation / resumption /
 * the detail panel. The only differences are that it does not call
 * `ToolExecutor.execute` (bypassing permission checks + `alwaysAsk` is the purpose of
 * this feature; clicking in the hub is consent) and it records the user's actual action
 * in the session with a controlOnly “launch turn” (the model first learns of this run
 * when a completion / question notification arrives).
 *
 * Keep this order fixed. Failures in steps ①② happen **before any persistence** (no run,
 * message, event, or task); failures after ④ are logged but not rolled back (the run is
 * already active and can be cancelled in the detail panel), and the method still returns ok.
 */
export async function startSavedWorkflowRun(
  this: AgentRuntimeInternal,
  input: {
    name: string;
    scope?: SavedWorkflowScope;
    args?: Record<string, unknown>;
    traceContext?: TraceContext;
  },
): Promise<StartSavedWorkflowRunResult> {
  const traceContext = input.traceContext ?? this.rootTraceContext;

  // (0) Reject a busy session. This method is meaningful only for a newly created empty
  // session. Queueing a launch during an active turn would require coordinating a
  // controlOnly turn with provider grammar (future work for “join current session”). The
  // GUI sends this only for empty sessions, so it should not normally happen.
  if (this.hasActiveOrQueuedTurnWork()) {
    return { ok: false, reason: "session_busy" };
  }

  const cwd = this.workingDirectory;

  // (1) Resolve and validate arguments using the same normalization as
  // create-workflow-source (the second caller; do not duplicate it).
  const found = resolveSavedWorkflow({ cwd, name: input.name, scope: input.scope });
  if (!found.ok) {
    if (found.reason === "invalid_name") {
      return {
        ok: false,
        reason: "invalid_name",
        message: `'${input.name}' is not a usable workflow name: ${found.detail}`,
      };
    }
    if (found.reason === "not_found") {
      return {
        ok: false,
        reason: "not_found",
        message:
          input.scope === undefined
            ? `No saved workflow named '${input.name}' in this project or globally.`
            : `No ${input.scope} workflow named '${input.name}'.`,
      };
    }
    // parse_error / read_error means the file exists but is invalid. For the GUI, the
    // next step is the same as “not found” (this name cannot run), so use not_found; but
    // explain in message that this is a file problem rather than a name problem, so the
    // user repairs the file instead of changing its name.
    return {
      ok: false,
      reason: "not_found",
      message: `The saved workflow '${input.name}' at ${found.path} could not be read: ${found.detail}`,
    };
  }

  const validated = validateWorkflowArgs(found.meta.args, input.args);
  if (!validated.ok) {
    return {
      ok: false,
      reason: "invalid_args",
      message: [
        `The arguments for saved workflow '${found.name}' are not valid:`,
        ...validated.errors.map((error) => `- ${error}`),
      ].join("\n"),
    };
  }

  // (2) Compile. Reject any diagnostics, matching CreateWorkflow's handling of scripts
  // that do not compile (launching a run that is certain to fail only delays the same
  // error). Include diagnostics in a bounded message.
  const analysis = analyzeScript(found.script);
  if (!analysis.ok || analysis.diagnostics.length > 0) {
    return {
      ok: false,
      reason: "compile_failed",
      message: boundedCompileDiagnostics(
        `The saved workflow '${found.name}' has errors:`,
        analysis.diagnostics,
      ),
    };
  }

  // —— No side effects up to this point: no run, message, event, or task. ——

  const port = this.dynamicWorkflowRunPort;
  if (port === undefined) {
    // Port is absent (stub / test host): report unsupported capability to the GUI. Do not degrade to pretending the run started.
    return { ok: false, reason: "start_failed", message: "dynamic workflow port unavailable" };
  }

  // Initialize context and persist the parent session before submission. An actor's
  // session_task_link references the parent through parent_session_id; creating the
  // first actor fails its foreign-key constraint if the parent row does not exist. Use
  // the workflow name as the parent's initial-input title, and reuse it idempotently for
  // later launch turns. If submission fails, the GUI deletes the empty session after
  // receiving a rejected ACK.
  await this.ensureContextInitialized(traceContext);
  await this.ensureSessionPersisted(found.name, traceContext);

  // (3) toolCallId: the `launch-` prefix distinguishes it in logs and tool cards from model tool-call ids (`tool_*`) and resume rearming.
  const toolCallId = `launch-${randomUUID()}`;
  const hasArgs = Object.keys(validated.args).length > 0;
  // Launch anchor: direct start has no user turn, so mint a UUID v7 to serve as both the
  // run's `run-launched.inputId` and the controlOnly launch turn's inputId below. The
  // launch-turn run card and the subagent's agent_step then attach to the same message.
  const launchInputId = uuidv7();
  // The declared phase list submitted here uses the same “analysis result → bounded
  // display graph” projection as the launch-turn display (phases come from the control-
  // flow layer; passing only the causality graph would omit them). It then uses the same
  // createWorkflowPhaseNames, so the same script shows the same sidebar lanes on both paths.
  const launchGraph = boundGraphOfAnalysis(analysis);
  const phaseNames = createWorkflowPhaseNames(launchGraph);
  // The index in the “running simultaneously” table points into `phaseNames`, so both must come from the same graph and projection.
  const phaseAlongside =
    phaseNames === undefined ? undefined : createWorkflowPhaseAlongside(launchGraph);

  // (3b) Working copy. A direct hub launch and CreateWorkflow with a saved source are
  // the same case, so use the same copy rule: copy byte-for-byte (including metadata
  // blocks) and do not modify the saved definition. If the copy fails, omit `scriptPath`;
  // the run still starts, but its terminal notification cannot link to an editable file.
  const draft = await writeWorkflowDraft({ cwd, name: found.name, source: found.source });

  // (4) Submit the launch. If submission is rejected or throws, exit before the launch turn; never convert failure into success with a runId.
  let runId: string;
  try {
    const submitted = await port.submit({
      scriptText: found.script,
      cwd,
      name: found.name,
      ...(hasArgs ? { args: validated.args } : {}),
      parentSessionId: this.sessionId,
      toolCallId,
      launchInputId,
      ...(phaseNames === undefined ? {} : { phaseNames }),
      ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
      ...(draft === undefined ? {} : { scriptPath: draft.path }),
      trace: traceContext,
    });
    runId = submitted.runId;
  } catch (error) {
    return { ok: false, reason: "start_failed", message: describeError(error) };
  }

  const launchText = buildLaunchMessageText(found.name, found.scope, runId, validated.args);
  // Carry the graph and script with the launch turn. The run detail panel and the
  // end-of-turn run card use toolCallId to find the launch row and read
  // display.causalityGraph and input.script. Direct launches have no tool row, so attach
  // the same display and script to launch metadata; otherwise their detail panel would
  // have neither graph nor script. Use the same “analysis result → display graph”
  // projection as CreateWorkflow, including all three layers (sites / phases / subagent
  // cards). This previously hand-built the arguments and passed only the causality graph,
  // leaving sites but no phases or subagent cards and an empty spine in the detail panel.
  const display = displayOfAnalysis(analysis);
  const meta = boundWorkflowLaunchMeta({
    runId,
    toolCallId,
    name: found.name,
    scope: found.scope,
    path: found.path,
    ...(hasArgs ? { args: validated.args } : {}),
    description: found.meta.description,
    ...(display?.kind === "create_workflow" ? { display } : {}),
    script: found.script,
  });

  // Log failures after ④ without rollback: the run is active and can be cancelled in the detail panel; retracting it would create an unowned orphan run.
  try {
    // (5) Launch turn: user-visible message (synthetic + workflowLaunch metadata) +
    // history + controlOnly turn boundary. The session title is the workflow name
    // (ensureSessionPersisted uses it as the initial-input title).
    const messageId = createMessageId();
    await emitControlOnlyUserTurn.call(this, {
      messageId,
      titleInput: found.name,
      historyText: launchText,
      turnInput: launchText,
      traceContext,
      inputId: launchInputId,
      inputSource: "workflow_launch",
      workflowLaunch: meta,
      persistMessage: () =>
        persistWorkflowLaunchUserMessage.call(this, {
          messageID: messageId,
          text: launchText,
          meta,
          traceContext,
        }),
    });

    // (6) Background tracking: synthesize a CreateWorkflow descriptor and use the
    // executor's trackBackgroundTask path (runtime-task registry registration = session
    // cleanup guard, BackgroundTaskStarted, terminal waiter, and settlement notification).
    // `input.name` supplies the notification subject (workflowTaskSubject), while
    // `name: CreateWorkflow` selects the "workflow" per-tool lifecycle. Completion
    // notifications / cancellation / resumption / detail panel need no changes.
    const toolCall: ExecutableToolCall = {
      id: toolCallId,
      name: CREATE_WORKFLOW_TOOL_NAME,
      input: {
        name: found.name,
        saved: {
          name: found.name,
          scope: found.scope,
          ...(hasArgs ? { args: validated.args } : {}),
        },
      },
    };
    await this.executor.trackExternalBackgroundTask(
      toolCall,
      { backgroundTaskId: runId, status: "backgrounded" },
      traceContext,
      undefined,
    );
  } catch (error) {
    this.logger?.error(
      "Saved workflow launched but post-submit bookkeeping failed",
      error instanceof Error ? error : new Error(String(error)),
      {
        ...traceContextToLogContext(traceContext),
        event: "dynamic_workflow.launch.post_submit_failed",
        module: "core.runtime",
        runId,
        toolCallId,
      },
    );
  }

  return { ok: true, runId, toolCallId };
}

/**
 * Canonical model-side text for the launch turn (English and not localized because it
 * enters the provider transcript and is read by the model on its next turn). Append
 * arguments as a JSON block when present. The final sentence always discourages duplicate
 * launches: the run is already active, and progress will arrive through notifications.
 */
function buildLaunchMessageText(
  name: string,
  scope: SavedWorkflowScope,
  runId: string,
  args: Record<string, unknown>,
): string {
  const lines = [
    `Started the saved workflow "${name}" (${scope}) from the workflows hub as run ${runId}.`,
  ];
  if (Object.keys(args).length > 0) {
    lines.push("", "Arguments:", "```json", JSON.stringify(args, null, 2), "```");
  }
  lines.push("", "Progress and results arrive as background notifications; do not start it again.");
  return lines.join("\n");
}

/**
 * Combine compile diagnostics into one bounded text block, with one `L{line}:C{column}
 * {message}` per item. Hub launches and GUI configuration share this because both pass
 * diagnostics through the ACK `message` to a bounded monospace block in the GUI.
 */
export function boundedCompileDiagnostics(
  heading: string,
  diagnostics: readonly CompileDiagnostic[],
): string {
  const body = [
    heading,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
  return body.length > COMPILE_DIAGNOSTICS_MAX_CHARS
    ? `${body.slice(0, COMPILE_DIAGNOSTICS_MAX_CHARS - 1)}…`
    : body;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
