// ============================================================
// escalate Tool Handler
// ============================================================
// A workflow actor (child AgentRuntime) uses this tool to escalate a **real blocker** to the primary agent that created the workflow,
// then waits in its ask for an answer. The handler passes the question to the injected WorkflowEscalatePort and waits for the outcome:
//   - answered → return the primary agent's answer; the actor's turn continues in place and the ask settles normally.
//   - refused  → return the message supplied by the port (budget exhausted / no ask in flight).
//
// Both outcomes are **ordinary tool results**, not ToolHandlerFailure. This differs from submit_result's rejection:
// its error tool_result is a repair path (the model should retry), but there is nothing to repair here. Rendering “escalation budget
// exhausted” as an error would make the model repeatedly hit the same wall, and speculative workarounds are exactly what this feature prevents.
//
// If the port is absent, still throw ConfigurationError (as submit_result does). This tool is registered only in actor sessions with
// the port injected, so reaching this point indicates a wiring fault, not an outcome.

import {
  CoreErrorType,
  ESCALATE_TOOL_NAME,
  EscalateInputJsonSchema,
  EscalateInputSchema,
  EscalateOutputJsonSchema,
  EscalateOutputSchema,
  createCoreError,
  type EscalateInput,
  type EscalateOutput,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

/** An answer may be a full explanation; use the same model-facing limit as submit_result. */
const MAX_ESCALATE_MODEL_BYTES = 16_000;

/**
 * The tool description defines the actor's **usage discipline**, which matters more than the mechanism: the mechanism only lets an
 * actor ask; the discipline ensures it asks only when appropriate. The description sets four constraints: last resort (not curiosity),
 * one focused question at a time, blocking may take a long time, and a maximum of three per ask.
 */
const ESCALATE_DESCRIPTION = [
  "Escalates a question that is BLOCKING you to the main agent that created this workflow, and waits here for the answer.",
  "",
  "This is a LAST RESORT, for when you are genuinely stuck on something outside your reach:",
  "- a gate that is broken or impossible to pass (a check capped at 95 when the threshold is 96);",
  "- instructions that contradict each other, so no output can satisfy both;",
  "- a fact you cannot obtain (a tradeoff, an external convention, what 'good' means here) that only whoever started this run knows.",
  "",
  "Do NOT use it for curiosity, progress reports, asking permission, confirming a conclusion you could verify yourself, or thinking out loud. None of those are blocked — keep working.",
  "",
  "Ask ONE focused question that can be answered in a sentence, and put your evidence in `context`: what you already tried, and exactly where you are stuck. The quality of the answer depends on it.",
  "",
  "The cost: this call BLOCKS until the main agent answers, which may take a long time. You get at most 3 escalations per ask; the 4th tells you the budget is spent and to proceed on your own best judgement. Do not spend them on questions not worth waiting for.",
].join("\n");

const escalateHandler: ToolHandler = async (input, context) => {
  const parsed = EscalateInputSchema.parse(input) as EscalateInput;

  // Same gate as submit_result: port presence is the criterion, independent of runtimeScope / taskType.
  if (!context.workflowEscalatePort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Workflow escalate port is not configured for escalate",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: ESCALATE_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const outcome = await context.workflowEscalatePort.escalate({
    toolCallId: context.toolCallId,
    question: parsed.question,
    ...(parsed.context === undefined ? {} : { context: parsed.context }),
    trace: resolveToolTraceContext(context),
  });

  if (outcome.kind === "answered") {
    return {
      status: "answered",
      message: outcome.answer,
      qid: outcome.qid,
    } satisfies EscalateOutput;
  }

  // The port supplies the refusal message (current state and next step); pass it through unchanged. Maintaining the discriminator
  // and message separately would eventually make them disagree, and the reader here is the model.
  return {
    status: "refused",
    message: outcome.message,
    reason: outcome.reason,
  } satisfies EscalateOutput;
};

export const escalateToolEntry: ToolEntry = {
  capability: "Escalate a blocking question from a workflow subagent to the main agent and wait",
  metadata: {
    shouldDefer: true,
    name: ESCALATE_TOOL_NAME,
    description: ESCALATE_DESCRIPTION,
    readOnly: false,
    destructive: false,
    // Intentionally differs from submit_result: escalation is **not** a terminal tool. It does not end the turn or exclude sibling
    // tools; only this call is suspended, not the entire actor.
    concurrentSafe: true,
    maxOutputBytes: MAX_ESCALATE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: escalateHandler,
  formatModelContent: formatEscalateModelContent,
  inputSchema: EscalateInputJsonSchema,
  outputSchema: EscalateOutputJsonSchema,
  runtimeInputSchema: EscalateInputSchema,
  runtimeOutputSchema: EscalateOutputSchema,
  permission: {
    permission: "workflow.escalate",
    reason: "escalate asks the main agent a blocking question from inside a workflow run",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_ESCALATE_MODEL_BYTES,
    maxModelBytes: MAX_ESCALATE_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_ESCALATE_MODEL_BYTES,
      direction: "head",
    },
  },
  // Waiting may take arbitrarily long (there is intentionally no timeout; “decide for yourself after a timeout” would reintroduce
  // speculative workarounds). Existing cancellation is the escape hatch: the driver's cancelAsk also rejects the suspended escalation deferred.
  timeout: {
    kind: "none",
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "escalate was cancelled before the main agent answered",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

/** The model sees only text: the answer or refusal message. The discriminator is not exposed to the model. */
function formatEscalateModelContent(output: unknown): string {
  const parsed = EscalateOutputSchema.safeParse(output);
  if (!parsed.success) return "escalate returned an invalid result.";
  return parsed.data.message;
}

function resolveToolTraceContext(context: Parameters<ToolHandler>[1]): TraceContext {
  return (
    context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
  );
}
