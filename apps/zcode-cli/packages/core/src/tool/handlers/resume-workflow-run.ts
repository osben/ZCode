// ============================================================
// ResumeWorkflowRun Tool Handler
// ============================================================
// Resume a stopped DWF run (model-facing entry point; resumable set = `stopped`, regardless of reason). See the port contract.
// `DynamicWorkflowRunPort.resume`（contracts/src/interfaces/dynamic-workflow-run.port.ts）。
//
// Keep the handler **very thin**: the port.resume service owns the gate (resumable-state check), registry replacement, and
// compileOnce/scriptHash revalidation. This handler only gets the port, passes through run_id, and projects the result to the contract
// shape. The backgrounded output makes the executor use CreateWorkflow's automatic tracking path (call-runner → trackBackgroundTask),
// with no new code for snapshots, waiting, cancellation, or notifications.
//
// Resume is pinned by scriptHash to the same script approved at submit time, matching the UI Resume button's risk level, so model
// calls execute directly. PreToolUse deny and project deny rules can still block them. There is no prepareApproval either: runId cannot
// be validated synchronously, so an invalid ID would fail with run_not_found after approval; a dialog would prevent nothing.

import {
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  ResumeWorkflowRunInputJsonSchema,
  ResumeWorkflowRunInputSchema,
  ResumeWorkflowRunOutputJsonSchema,
  ResumeWorkflowRunOutputSchema,
  type ModelMessageContent,
  type ResumeWorkflowRunInput,
  type ResumeWorkflowRunOutput,
} from "@zcode/contracts";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";

const RESUME_WORKFLOW_RUN_TIMEOUT_MS = 15_000;
/** As with CreateWorkflow, output is only one guidance message, so 24k is ample. */
const RESUME_WORKFLOW_RUN_MODEL_BYTES = 24_000;

/**
 * Local failure-code table. Numbers are not exposed to the model (the executor projects errorCode to a `code: "N"` string); the
 * message prefix is the only authoritative discriminator. The comments clarify ownership of the numeric spaces:
 *
 *   - `not_found` **reuses the introspection table** (workflow-run-introspection.ts) RUN_NOT_FOUND code and message (same key and
 *     code), so it is not listed here;
 *   - The other four codes in this table are **independent from the introspection numeric space and must not be compared across
 *     tables**. They start at 11 to avoid visual collisions with introspection (1/2), but the actual safeguard is that numbers are
 *     only for logs and the message prefix is the discriminator. Document ownership here instead of merging into a shared table;
 *     turning the introspection module into a DWF-wide failure-code table would burden a read-only tool set with execution semantics.
 */
const RESUME_WORKFLOW_RUN_ERROR_CODE = {
  RESUME_UNAVAILABLE: 11,
  NOT_RESUMABLE: 12,
  ALREADY_RUNNING: 13,
  SCRIPT_MISSING: 14,
  SCRIPT_MISMATCH: 15,
  SUPERSEDED: 16,
  COMPILE_FAILED: 17,
} as const;

const RESUME_WORKFLOW_RUN_DESCRIPTION = [
  "Resumes a dynamic-workflow run whose status is `stopped` — the user cancelled it, you stopped it with TaskStop, a provider-side error stopped it (expired sign-in, model not in the plan, quota cap), or the process that owned it exited (`interrupted`). The run continues under the same run ID: finished steps are replayed from the journal without spending tokens, unfinished steps are dispatched again. The one stopped run that is NOT resumable is a `superseded` one: an AmendWorkflow replaced it, and its successor is the live run.",
  "",
  "- Takes run_id — from CreateWorkflow's or AmendWorkflow's result, from a completion notification, or from GetWorkflowRun / ListWorkflowRuns.",
  "- The resumed run is backgrounded: you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.",
  "- An `errored` run (the script itself failed) is NOT resumable — replaying it would fail the same way. Fix the script and submit it with AmendWorkflow instead. A completed run is not resumable either; a `superseded` run is refused with the successor's ID.",
  "- Stop reason `user` means the user stopped it on purpose: resume it only when the user asks you to; never resume a run the user just cancelled on your own initiative. Reason `model` is your own TaskStop. Reason `provider` means a provider-side error stopped it: resolve the cause with the user first (the stop notification names it), then resume. The exception is a usage cap with a known reset time: ZCode resumes that run by itself after the reset, so do not resume it before then. Reason `interrupted` (the process died) is different: continuing it is usually what the user wants.",
].join("\n");

/**
 * “This session cannot resume runs.” Missing port (journal unavailable, so the run service is not constructed) and missing method
 * (stub has no resume) produce the same failure; they mean the same thing to the model (following listRuns/getRunDetail typeof-probing
 * precedent). Never silently downgrade; the model could otherwise wait for a notification that will never arrive.
 */
function workflowResumeUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.RESUME_UNAVAILABLE,
    message:
      "workflow_resume_unavailable: this session cannot resume workflow runs — workflow execution is not available here. This is a capability gap, not a status problem.",
  };
}

/** Map port reasons to structured failures with actionable messages (the discriminator is the message prefix). */
function resumeFailureFor(reason: string, runId: string, detail?: string): ToolHandlerFailure {
  switch (reason) {
    // A saved script may no longer fit the current facade; if compilation fails, revise the script before replaying it.
    case "compile_failed":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.COMPILE_FAILED,
        message: `workflow_run_compile_failed: the stored script of run ${runId} no longer compiles against the current workflow facade, so it cannot be replayed as-is. Rewrite it for the current facade and submit it with AmendWorkflow, which keeps the finished work of this run.${detail === undefined ? "" : `\n${detail}`}`,
      };
    case "not_resumable":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.NOT_RESUMABLE,
        message:
          "workflow_run_not_resumable: this run is not in the resumable set — only a `stopped` run can be resumed (any stop reason except `superseded`). An `errored` run needs a corrected script submitted with AmendWorkflow; a completed run has nothing to resume. Check the status with GetWorkflowRun.",
      };
    case "superseded":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.SUPERSEDED,
        message: `workflow_run_superseded: run ${runId} was stopped by an AmendWorkflow and superseded; its unfinished work belongs to the successor run (see GetWorkflowRun's <superseded_by>). Read or amend the successor instead of resuming this run.`,
      };
    // The already_running gate is scoped to the in-flight registry of **this run service instance** (per-app/per-session). Concurrent
    // resume of the same journal run from different sessions is not blocked; this message describes only this instance's semantics and
    // makes no promise about cross-instance behavior.
    case "already_running":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.ALREADY_RUNNING,
        message:
          "workflow_run_already_running: this run is already in flight in this session's workflow runtime. Wait for its completion notification instead of resuming it again.",
      };
    case "script_missing":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.SCRIPT_MISSING,
        message:
          "workflow_run_script_missing: this run's journal record has no stored script text (it predates script persistence), so there is nothing to re-run. Start a fresh run with CreateWorkflow instead.",
      };
    case "script_mismatch":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.SCRIPT_MISMATCH,
        message: `workflow_run_script_mismatch: the stored script hash for run ${runId} no longer matches the stored script text — the journal record was modified by an outside force. Start a fresh run with CreateWorkflow instead.`,
      };
    default:
      // Reason outside the port contract: still return a structured failure (do not throw; that signals a wiring fault). Preserve the
      // discriminator prefix and include the original term for log diagnosis.
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.NOT_RESUMABLE,
        message: `workflow_run_not_resumable: the workflow runtime refused to resume run ${runId} (reason: ${reason}).`,
      };
  }
}

const resumeWorkflowRunHandler: ToolHandler = async (input, context: ToolExecutionContext) => {
  const parsed = ResumeWorkflowRunInputSchema.parse(input) as ResumeWorkflowRunInput;

  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.resume !== "function") {
    return workflowResumeUnavailableFailure();
  }

  const result = await port.resume(parsed.run_id);
  if (!result.ok) {
    // not_found reuses the introspection tool's run_not_found key (same key, code, and message).
    return result.reason === "not_found"
      ? workflowRunNotFoundFailure(parsed.run_id)
      : resumeFailureFor(result.reason, parsed.run_id, result.message);
  }

  return {
    ok: true,
    runId: result.runId,
    // Follow CreateWorkflow's backgrounded guidance (create-workflow.ts): give the ID, say it is still running and results will arrive
    // as a notification, and explicitly discourage default polling. Without that sentence, the model was observed to use TaskOutput
    // immediately and turn the async run into a synchronous wait.
    response: `The workflow run ${result.runId} has been resumed and is running in the background. It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.`,
    status: "backgrounded",
    // backgroundTaskId ≡ runId (same identity as CreateWorkflow's backgrounded output); cancellation, TaskOutput lookup, and terminal
    // notifications share this key.
    backgroundTaskId: result.runId,
  } satisfies ResumeWorkflowRunOutput;
};

function formatResumeWorkflowRunModelContent(output: unknown): ModelMessageContent {
  const parsed = ResumeWorkflowRunOutputSchema.safeParse(output);
  if (!parsed.success) return "ResumeWorkflowRun returned an invalid result.";
  return parsed.data.response;
}

export const resumeWorkflowRunToolEntry: ToolEntry = {
  capability: "Resume a stopped dynamic-workflow run under the same run ID",
  metadata: {
    shouldDefer: true,
    name: RESUME_WORKFLOW_RUN_TOOL_NAME,
    description: RESUME_WORKFLOW_RUN_DESCRIPTION,
    // Resuming restarts the execution child process and actor session (replay settled nodes and redispatch unfinished ones), matching
    // CreateWorkflow; the read-only declaration does not apply.
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: RESUME_WORKFLOW_RUN_TIMEOUT_MS,
    maxOutputBytes: RESUME_WORKFLOW_RUN_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    // No confirmation: the run is pinned to the same already-approved script.
    needsApproval: false,
  },
  handler: resumeWorkflowRunHandler,
  inputSchema: ResumeWorkflowRunInputJsonSchema,
  outputSchema: ResumeWorkflowRunOutputJsonSchema,
  runtimeInputSchema: ResumeWorkflowRunInputSchema,
  runtimeOutputSchema: ResumeWorkflowRunOutputSchema,
  formatModelContent: formatResumeWorkflowRunModelContent,
  permission: {
    permission: "resumeWorkflowRun",
    reason: "resumeWorkflowRun.runConfirmation: resuming continues executing a stopped workflow run",
    riskLevel: "low",
    sideEffectScope: "none",
    // scriptHash pins resume to the same script approved at submit time; settled nodes only replay. Its risk matches the UI button,
    // so model calls execute directly. PreToolUse deny (call-runner, before execution) and project deny rules
    // (denyPriority:"beforeAsk") still apply.
    needsApproval: false,
    // Include run_id in the pattern-matching surface (like TaskOutput's task_id) so project rules can target a specific run.
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: RESUME_WORKFLOW_RUN_MODEL_BYTES,
    maxModelBytes: RESUME_WORKFLOW_RUN_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: RESUME_WORKFLOW_RUN_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: RESUME_WORKFLOW_RUN_TIMEOUT_MS,
    maxMs: RESUME_WORKFLOW_RUN_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "ResumeWorkflowRun resumes the run synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
