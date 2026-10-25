import {
  isAutomationCreateLimitError,
  CoreErrorType,
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  type CollaborationMode,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionResult } from "../types.js";

const DEFAULT_EXIT_PLAN_DENIED_MESSAGE = `Permission denied for ${EXIT_PLAN_MODE_TOOL_NAME}`;
const EXIT_PLAN_DENIED_BY_USER_MESSAGE = "The plan was not approved by the user.";
const WORKFLOW_REFINE_DENIED_BY_USER_MESSAGE = "The workflow run was not approved by the user.";
const AUTOMATION_CREATE_LIMIT_MODEL_MESSAGE =
  "Automation creation was not performed because the global retained-task limit of 20 was reached. " +
  "This limit cannot be recovered automatically in the current turn. Do not list, delete, overwrite, " +
  "retry, or use another tool. Reply once in the user's language that they must manually delete an " +
  "existing task on the Automations page and then retry.";

export function withAutomationCreateLimitTurnStop(
  result: ToolExecutionResult,
  input: { error: unknown; toolName: string },
): ToolExecutionResult {
  if (
    result.success ||
    input.toolName !== "CronCreate" ||
    !isAutomationCreateLimitError(input.error)
  ) {
    return result;
  }

  // The creation limit is a product boundary that requires the user to free a slot; it
  // is not an Agent-recoverable error. Hide the raw error, which may contain a
  // "Delete..." suggestion, from the model and ask the executor to cancel later tools
  // in the current step.
  return {
    ...result,
    modelContent: AUTOMATION_CREATE_LIMIT_MODEL_MESSAGE,
    turnControl: {
      reason: "automation_create_limit",
      stopTurnAfterResult: true,
    },
  };
}

export function withPlanExitDeniedTurnStop(
  result: ToolExecutionResult,
  input: {
    mode: CollaborationMode;
    planEnabled?: boolean;
    toolName: string;
  },
): ToolExecutionResult {
  if (
    !(input.planEnabled ?? input.mode === "plan") ||
    input.toolName !== EXIT_PLAN_MODE_TOOL_NAME ||
    result.success
  ) {
    return result;
  }

  const feedback = readPlanExitDeniedFeedback(result);
  if (feedback) {
    return {
      ...result,
      followUpUserInput: {
        input: feedback,
        reasonSource: "plan_approval_feedback",
      },
      // Feedback becomes a real user message through steer. tool_result can only say
      // that the plan was denied; it cannot promise that feedback will follow, or the
      // provider may see a nonexistent user message if steer is rejected.
      modelContent: EXIT_PLAN_DENIED_BY_USER_MESSAGE,
    };
  }

  // Denying plan exit means the user wants to continue discussing it; do not treat this
  // as an ordinary tool error that prompts the model to rewrite the plan on its own.
  return {
    ...result,
    turnControl: {
      reason: "plan_exit_denied",
      stopTurnAfterResult: true,
    },
  };
}

function readPlanExitDeniedFeedback(result: ToolExecutionResult): string | undefined {
  if (result.error?.type !== CoreErrorType.PermissionDenied) {
    return undefined;
  }
  // Project rules, hooks, and the broker may also return deny + reason. Only the
  // dedicated source attached to custom ExitPlanMode approval input can be interpreted
  // as user feedback.
  if (result.error.reasonSource !== "plan_approval_feedback") {
    return undefined;
  }
  const message = result.error.message.trim();
  if (!message || message === DEFAULT_EXIT_PLAN_DENIED_MESSAGE) {
    return undefined;
  }
  return message;
}

/**
 * Handle a Refine response in the workflow-run approval dialog.
 * This mirrors withPlanExitDeniedTurnStop but is narrower: it only promotes feedback
 * and has no stop-turn branch. Ordinary Deny keeps its existing behavior (send the
 * standard permission error and continue the turn). Feedback becomes a real user
 * message through steer, after which the model revises and resubmits the script in the
 * same turn, naturally triggering another approval request.
 * Do not key this by mode: CreateWorkflow asks in every mode (alwaysAsk).
 */
export function withWorkflowRefineDeniedFollowUp(
  result: ToolExecutionResult,
  input: { toolName: string },
): ToolExecutionResult {
  if (
    (input.toolName !== CREATE_WORKFLOW_TOOL_NAME && input.toolName !== AMEND_WORKFLOW_TOOL_NAME) ||
    result.success
  ) {
    return result;
  }
  const feedback = readWorkflowRefineDeniedFeedback(result);
  if (!feedback) {
    return result;
  }
  return {
    ...result,
    followUpUserInput: {
      input: feedback,
      reasonSource: "workflow_refine_feedback",
    },
    // tool_result can only say that execution was not approved; it cannot promise that
    // feedback will follow, or the provider may see a nonexistent user message if steer
    // is rejected.
    modelContent: WORKFLOW_REFINE_DENIED_BY_USER_MESSAGE,
  };
}

function readWorkflowRefineDeniedFeedback(result: ToolExecutionResult): string | undefined {
  if (result.error?.type !== CoreErrorType.PermissionDenied) {
    return undefined;
  }
  // As with readPlanExitDeniedFeedback, a deny + reason from a hook or project rule
  // lacks the dedicated source and must not be promoted to a user message.
  if (result.error.reasonSource !== "workflow_refine_feedback") {
    return undefined;
  }
  const message = result.error.message.trim();
  return message || undefined;
}

// Terminal tools such as submit_result declare stopTurnOnSuccess=true in
// ToolEntry.metadata: success means a terminal submission and must end the actor's
// turn. Read declarative metadata here instead of hard-coding tool names. Terminal
// completion is a general capability reusable by future tools, unlike conditional
// failure-side stops in withPlanExitDeniedTurnStop / withAutomationCreateLimitTurnStop,
// which are keyed to tool-specific errors or state. These handlers guarantee that
// success implies termination (the gate throws and rejection follows the failure path),
// so no handler-side signaling channel is needed.
export function withTerminalToolTurnStop(
  result: ToolExecutionResult,
  input: { entry: ToolEntry },
): ToolExecutionResult {
  if (!result.success || input.entry.metadata.stopTurnOnSuccess !== true) {
    return result;
  }
  return {
    ...result,
    turnControl: {
      reason: "subagent_terminal",
      stopTurnAfterResult: true,
    },
  };
}
