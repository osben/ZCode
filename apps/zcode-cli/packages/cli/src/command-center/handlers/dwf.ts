import type { TuiSubmitPromptResult } from "@zcode/tui";
import type {
  DynamicWorkflowRunResumeErrorReason,
  DynamicWorkflowRunSessionSummary,
} from "@zcode/contracts";
import type { CommandCenterDeps } from "../types.js";
import { splitArgs } from "../utils.js";

const DWF_USAGE = "Usage: /dwf [list|cancel [runId]|resume <runId>]";

/** Default row count for `/dwf list`; the server has its own cap, and this value only aims to fit one screen. */
const DWF_LIST_LIMIT = 20;

/**
 * Set of non-terminal run states. These are the candidates when `/dwf cancel` has no
 * runId: pending means created but not started, and running means active; both still
 * have work that can be stopped. completed / errored / stopped are settled, so
 * cancellation has no effect.
 */
const IN_FLIGHT_STATUSES: readonly DynamicWorkflowRunSessionSummary["status"][] = [
  "pending",
  "running",
];

export async function handleDwfCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const [action = "list", runId] = splitArgs(args);

  if (action === "list") {
    if (!app.listDynamicWorkflowRuns) return unavailable(deps);
    const runs = await app.listDynamicWorkflowRuns({ limit: DWF_LIST_LIMIT });
    return respond(deps, formatRunList(runs));
  }

  if (action === "cancel") {
    return await handleCancel(runId, app, deps);
  }

  if (action === "resume") {
    if (!runId) return respond(deps, DWF_USAGE);
    if (!app.resumeWorkflowRun) return unavailable(deps);
    const result = await app.resumeWorkflowRun({ workId: runId });
    return respond(
      deps,
      result.ok
        ? `Resumed dynamic workflow run ${result.runId}.`
        : `Cannot resume ${runId}: ${describeResumeRejection(result.reason)} (${result.reason})${result.message === undefined ? "" : `\n${result.message}`}`,
    );
  }

  return respond(deps, DWF_USAGE);
}

async function handleCancel(
  runId: string | undefined,
  app: Awaited<ReturnType<CommandCenterDeps["getApp"]>>,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  if (!app.cancelBackgroundTask) return unavailable(deps);

  let targetRunId = runId;
  if (!targetRunId) {
    // Without a runId, choose for the user only when exactly one run is active. List
    // multiple candidates and ask the user to specify one: cancellation spends money
    // and loses progress, so the cost of guessing incorrectly is asymmetric.
    if (!app.listDynamicWorkflowRuns) return respond(deps, DWF_USAGE);
    const runs = await app.listDynamicWorkflowRuns({ limit: DWF_LIST_LIMIT });
    const inFlight = runs.filter((run) => IN_FLIGHT_STATUSES.includes(run.status));
    if (inFlight.length === 0) {
      return respond(deps, "No in-flight dynamic workflow runs to cancel.");
    }
    if (inFlight.length > 1) {
      return respond(
        deps,
        [
          "Multiple in-flight dynamic workflow runs; pass the run id to cancel one:",
          ...inFlight.map((run) => `- ${formatRunLine(run)}`),
          "",
          "Usage: /dwf cancel <runId>",
        ].join("\n"),
      );
    }
    targetRunId = inFlight[0]!.runId;
  }

  // runId ≡ taskId: workflow runs are registered under runId in the background-task registry.
  const result = await app.cancelBackgroundTask(targetRunId);
  if (!result.cancelled) {
    const reason = result.reason ? `: ${result.reason}` : ".";
    return respond(deps, `Could not cancel ${targetRunId} (${result.status})${reason}`);
  }
  return respond(deps, `Cancelled dynamic workflow run ${targetRunId}.`);
}

function formatRunList(runs: DynamicWorkflowRunSessionSummary[]): string {
  if (runs.length === 0) {
    return "No dynamic workflow runs in this session.";
  }
  return [
    `Dynamic workflow runs (${runs.length}):`,
    ...runs.map((run) => `- ${formatRunLine(run)}`),
    "",
    "Use /dwf cancel <runId> or /dwf resume <runId>.",
  ].join("\n");
}

/**
 * One row = `runId · label · status · resumable · updated` + failure suffix.
 *
 * `label` and `updatedAt` are additive optional fields (older servers omit them): fall
 * back to runId for the label and omit the timestamp. A missing column is degraded data,
 * not an error; never hide the whole row for it. If label equals runId, do not print it
 * twice; runId is the server's final fallback and would produce `dwfrun_x dwfrun_x`.
 */
function formatRunLine(run: DynamicWorkflowRunSessionSummary): string {
  const columns = [run.runId];
  const label = run.label ?? run.runId;
  if (label !== run.runId) columns.push(label);
  // stopped includes a reason: `stopped/provider`.
  columns.push(run.stopReason === undefined ? run.status : `${run.status}/${run.stopReason}`);
  // Print the server's resumable decision directly; do not derive it again from status
  // + failureCode. The predicates could eventually diverge, showing “resumable” while
  // the command is rejected.
  if (run.resumable) columns.push("resumable");
  if (run.updatedAt !== undefined) columns.push(`updated ${formatUpdatedAt(run.updatedAt)}`);
  return `${columns.join(" · ")}${formatFailure(run)}`;
}

/**
 * Convert epoch milliseconds to readable time using a short ISO-style format in the
 * local timezone. Terminal users see their machine's local time; a UTC `Z` suffix would
 * require mental conversion during local debugging.
 */
function formatUpdatedAt(updatedAt: number): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return String(updatedAt);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatFailure(run: DynamicWorkflowRunSessionSummary): string {
  if (!run.failureCode && !run.failureMessage) return "";
  const code = run.failureCode ?? run.status;
  return run.failureMessage ? ` (${code}: ${run.failureMessage})` : ` (${code})`;
}

function describeResumeRejection(reason: DynamicWorkflowRunResumeErrorReason): string {
  switch (reason) {
    case "not_found":
      return "no such run in this session's journal";
    case "not_resumable":
      return "only a stopped run can be resumed (an errored run needs a corrected script via AmendWorkflow)";
    case "superseded":
      return "the run was stopped and superseded by an amended run; that successor is the live one";
    case "already_running":
      return "the run is already in flight";
    case "script_missing":
      return "the recorded run has no script to re-run";
    case "script_mismatch":
      return "the recorded script no longer matches its hash";
    case "compile_failed":
      return "the recorded script no longer compiles against the current workflow facade; rewrite it and use AmendWorkflow";
  }
}

function unavailable(deps: CommandCenterDeps): TuiSubmitPromptResult {
  return respond(deps, "Dynamic workflow runs are not available in this client.");
}

function respond(deps: CommandCenterDeps, response: string): TuiSubmitPromptResult {
  return {
    mode: deps.getMode?.(),
    response,
  };
}
