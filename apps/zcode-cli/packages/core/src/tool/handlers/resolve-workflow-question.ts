// ============================================================
// ResolveWorkflowQuestion Tool Handler
// ============================================================
// The primary agent uses this to answer a blocking question escalated by an actor in a **running** workflow. See
// `DynamicWorkflowRunPort.resolveQuestion`.
//
// Keep the handler **very thin**: qid lookup, driver settlement, and dual event recording are all on the port service. This handler
// only gets the port (using typeof probing as in resume/listRuns), passes through qid and answer, and projects the result to the contract shape.
//
// **Pass through** the service's refusal message unchanged: the registry-writing layer owns that message (current state and next step).
// Separately maintaining the discriminator and message would make them disagree, and the reader here is the model—the message is its
// next step. Therefore, the three refusal branches here choose only a stable errorCode and do not rewrite any text.

import {
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  ResolveWorkflowQuestionInputJsonSchema,
  ResolveWorkflowQuestionInputSchema,
  ResolveWorkflowQuestionOutputJsonSchema,
  ResolveWorkflowQuestionOutputSchema,
  type ModelMessageContent,
  type ResolveWorkflowQuestionInput,
  type ResolveWorkflowQuestionOutput,
} from "@zcode/contracts";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";

const RESOLVE_WORKFLOW_QUESTION_TIMEOUT_MS = 15_000;
/** Output is one confirmation message, so 24k is ample (same as ResumeWorkflowRun). */
const RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES = 24_000;

/**
 * Local failure-code table. Numbers are only for logs (the executor projects them as `code: "N"` strings); the model actually reads
 * the message, and the service owns all three refusal messages. Start at 21 to visually separate this table from introspection (1/2)
 * and ResumeWorkflowRun (11–15); the numeric spaces are independent and must not be compared across tables.
 */
const RESOLVE_WORKFLOW_QUESTION_ERROR_CODE = {
  ANSWERING_UNAVAILABLE: 21,
  UNKNOWN_QUESTION: 22,
  ALREADY_RESOLVED: 23,
  RUN_NOT_IN_FLIGHT: 24,
} as const;

const RESOLVE_WORKFLOW_QUESTION_DESCRIPTION = [
  "Answers a blocking question that a subagent escalated from inside a RUNNING dynamic-workflow run.",
  "",
  "- Takes question_id — the ID from the escalation notification (it looks like `dwfq-...`). If that notification was lost, GetWorkflowRun lists the questions a run still owes an answer to.",
  "- The run keeps running the whole time: only the subagent that asked is parked on its call, while every other subagent and the script's control flow keep going. Your answer becomes that call's result verbatim and the subagent continues from there.",
  "- Answer directly and actionably. If you are not sure, look at the run first with GetWorkflowRun, or ask the user with AskUserQuestion, then come back and answer — nothing answers on your behalf, and the subagent waits indefinitely.",
  "- If the question reveals the SCRIPT is structurally broken (a broken gate, wrong control flow), a sentence cannot fix that: cancel the run and continue with a revised script via CreateWorkflow's `resume_from`.",
].join("\n");

/**
 * “This session cannot answer questions.” Missing port (journal unavailable, so no run service is constructed) and missing method
 * (stub lacks resolveQuestion) return the same failure; they mean the same thing to the model (following resume's typeof-probing
 * precedent). Never silently succeed: an actor would wait forever while the model thinks it answered.
 */
function resolveQuestionUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.ANSWERING_UNAVAILABLE,
    message:
      "workflow_question_answering_unavailable: this session cannot answer workflow escalations — workflow execution is not available here. This is a capability gap, not a bad question ID.",
  };
}

/** Map the port's three reasons to stable error codes; messages come unchanged from the service. */
function resolveQuestionFailureFor(reason: string, message: string): ToolHandlerFailure {
  switch (reason) {
    case "unknown_question":
      return {
        result: false,
        errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.UNKNOWN_QUESTION,
        message,
      };
    case "already_resolved":
      return {
        result: false,
        errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.ALREADY_RESOLVED,
        message,
      };
    case "run_not_in_flight":
      return {
        result: false,
        errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.RUN_NOT_IN_FLIGHT,
        message,
      };
    default:
      // Reason outside the port contract: still return a structured failure (throw indicates a wiring fault); include the original term for diagnosis.
      return {
        result: false,
        errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.UNKNOWN_QUESTION,
        message: `${message} (reason: ${reason})`,
      };
  }
}

const resolveWorkflowQuestionHandler: ToolHandler = async (
  input,
  context: ToolExecutionContext,
) => {
  const parsed = ResolveWorkflowQuestionInputSchema.parse(
    input,
  ) as ResolveWorkflowQuestionInput;

  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.resolveQuestion !== "function") {
    return resolveQuestionUnavailableFailure();
  }

  const result = await port.resolveQuestion(parsed.question_id, parsed.answer);
  if (!result.ok) {
    return resolveQuestionFailureFor(result.reason, result.message);
  }

  return {
    ok: true,
    qid: result.qid,
    // Make two things clear: the answer was delivered, and the run did not stop as a result, so the primary agent need not wait here.
    response: `Answer delivered for question ${result.qid}. The subagent that asked has resumed its turn with your answer; the run keeps going as before.`,
  } satisfies ResolveWorkflowQuestionOutput;
};

function formatResolveWorkflowQuestionModelContent(output: unknown): ModelMessageContent {
  const parsed = ResolveWorkflowQuestionOutputSchema.safeParse(output);
  if (!parsed.success) return "ResolveWorkflowQuestion returned an invalid result.";
  return parsed.data.response;
}

export const resolveWorkflowQuestionToolEntry: ToolEntry = {
  capability: "Answer a blocking question escalated by a subagent inside a running workflow run",
  metadata: {
    name: RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
    description: RESOLVE_WORKFLOW_QUESTION_DESCRIPTION,
    // Answering lets a parked actor continue work with this text; this is not a read-only operation.
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: RESOLVE_WORKFLOW_QUESTION_TIMEOUT_MS,
    maxOutputBytes: RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    // No confirmation: answering only sends text to an already-approved run (the run passed CreateWorkflow's confirmation dialog),
    // matching ResumeWorkflowRun's risk level. A dialog would keep an actor waiting for its answer even longer.
    needsApproval: false,
  },
  handler: resolveWorkflowQuestionHandler,
  inputSchema: ResolveWorkflowQuestionInputJsonSchema,
  outputSchema: ResolveWorkflowQuestionOutputJsonSchema,
  runtimeInputSchema: ResolveWorkflowQuestionInputSchema,
  runtimeOutputSchema: ResolveWorkflowQuestionOutputSchema,
  formatModelContent: formatResolveWorkflowQuestionModelContent,
  permission: {
    permission: "resolveWorkflowQuestion",
    reason: "resolveWorkflowQuestion answers a blocked subagent inside a running workflow run",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // Include question_id in the pattern-matching surface (like ResumeWorkflowRun's run_id).
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES,
    maxModelBytes: RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: RESOLVE_WORKFLOW_QUESTION_TIMEOUT_MS,
    maxMs: RESOLVE_WORKFLOW_QUESTION_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage:
      "ResolveWorkflowQuestion delivers the answer synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
