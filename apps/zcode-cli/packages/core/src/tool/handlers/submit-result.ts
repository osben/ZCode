// ============================================================
// submit_result Tool Handler
// ============================================================
// A workflow actor (child AgentRuntime) uses this tool to submit the structured terminal result for the current ask. The handler
// passes it to the injected WorkflowSubmitPort and waits for the engine's decision:
//   - accept → return successful output; the executor attaches turnControl to end this turn on success.
//   - reject → return the violations as ToolHandlerFailure; it becomes an error tool_result without turnControl, so the loop continues
//     and the model retries in the same session. This is the repair path.
// The per-ask schema is not part of the tool declaration; it is supplied with the ask instruction's epilogue (preserving the
// frozen-tool cache invariant). This handler only forwards the request; the engine validates the schema on the port side.

import {
  CoreErrorType,
  SUBMIT_RESULT_TOOL_NAME,
  SubmitResultInputJsonSchema,
  SubmitResultInputSchema,
  SubmitResultOutputJsonSchema,
  SubmitResultOutputSchema,
  createCoreError,
  typedSubmitResultInputSchema,
  type JsonSchema,
  type SubmitResultInput,
  type SubmitResultOutput,
  type SubmitViolation,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolHandlerFailure } from "../types.js";

const MAX_SUBMIT_RESULT_MODEL_BYTES = 16_000;

// Normalize rejected violation lists to this errorCode for the error tool_result's code field.
const SUBMIT_RESULT_REJECTED_ERROR_CODE = 1;

const submitResultHandler: ToolHandler = async (input, context) => {
  const parsed = SubmitResultInputSchema.parse(input) as SubmitResultInput;

  // Gate: workflowSubmitPort is injected only in workflow actor sessions. Do not check runtimeScope; a workflow actor's taskType is
  // "workflow_child" while its runtimeScope is currently "main". Port presence is the correct criterion independent of taskType.
  if (!context.workflowSubmitPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Workflow submit port is not configured for submit_result",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: SUBMIT_RESULT_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const verdict = await context.workflowSubmitPort.respond({
    toolCallId: context.toolCallId,
    result: parsed.result,
    trace: resolveToolTraceContext(context),
  });

  if (verdict.accept) {
    return { status: "accepted" } satisfies SubmitResultOutput;
  }

  // Reject: return ToolHandlerFailure, which call-runner converts to error tool_result. The violations remain in modelContent; without
  // turnControl, the loop continues and the model can repair and retry in-session.
  return submitResultRejection(verdict.violations);
};

/**
 * submit_result tool entry. Without a schema, use the generic declaration (`result` accepts any JSON; per-ask schema comes in the
 * ask suffix). With a schema, use a typed declaration for DWF mono subagents (`result` is that actor's only ask result schema, frozen
 * and stable across asks so the cache prefix is preserved), and mark it eligible for `strict` so the Anthropic adapter can enforce it
 * natively. Only provider-visible declaration and description differ: handler, permissions, concurrency group, terminal semantics, and
 * budget are byte-for-byte identical. Engine validation is the same for both; the typed declaration only lets the provider see (and
 * when supported, enforce) the shape too.
 */
export function createSubmitResultToolEntry(resultSchema?: JsonSchema): ToolEntry {
  const typed = resultSchema !== undefined;
  return {
    capability: "Submit the structured terminal result for a workflow subagent's ask",
    metadata: {
      shouldDefer: true,
      name: SUBMIT_RESULT_TOOL_NAME,
      description: typed
        ? "Submit the structured result for the current ask. The `result` argument must match this tool's schema."
        : "Submit the structured result for the current ask. The required JSON shape is described in the ask instructions.",
      readOnly: false,
      destructive: false,
      // Payload semantics: declare concurrentSafe:false so the scheduler places it in a separate serial group. When a valid submission
      // runs (success terminates the turn), later-scheduled sibling tools receive the existing synthetic ToolCancelled and earlier
      // ones finish first; no new termination mechanism is needed.
      concurrentSafe: false,
      // Terminal tool: a valid submission (engine accept) is success and must end the actor's turn. Declare this intrinsic capability
      // in metadata so the executor's generic withTerminalToolTurnStop attaches turnControl on success, without hard-coding the tool
      // name at execution or adding a stop-signal channel to the handler.
      stopTurnOnSuccess: true,
      maxOutputBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
      sideEffectScope: "session",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: submitResultHandler,
    formatModelContent: formatSubmitResultModelContent,
    inputSchema: typed ? typedSubmitResultInputSchema(resultSchema) : SubmitResultInputJsonSchema,
    ...(typed ? { strict: true } : {}),
    outputSchema: SubmitResultOutputJsonSchema,
    // Runtime Zod validation is the same for both (result accepts any JSON); the engine validates per-ask shape on the port side and returns repairable violations.
    runtimeInputSchema: SubmitResultInputSchema,
    runtimeOutputSchema: SubmitResultOutputSchema,
    permission: {
      permission: "workflow.submitResult",
      reason: "submit_result delivers the subagent's terminal result to the workflow engine",
      riskLevel: "low",
      sideEffectScope: "session",
      needsApproval: false,
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
      maxModelBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
      strategy: "truncate",
      preview: {
        maxBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
        direction: "head",
      },
    },
    // Engine decisions may take arbitrarily long; kind:"none" sets no wall-clock timeout, and cancellation aborts the tool call.
    timeout: {
      kind: "none",
    },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "submit_result was cancelled before the engine returned a verdict",
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

/** Generic declaration entry (the one in the built-in tool table). */
export const submitResultToolEntry: ToolEntry = createSubmitResultToolEntry();

function submitResultRejection(violations: readonly SubmitViolation[]): ToolHandlerFailure {
  return {
    result: false,
    errorCode: SUBMIT_RESULT_REJECTED_ERROR_CODE,
    message: formatSubmitViolations(violations),
  };
}

// Match the dynamic-workflow synthesis format: one violation per line, `<path>: expected <expected>, got <got>`, so the model can fix them one by one.
function formatSubmitViolations(violations: readonly SubmitViolation[]): string {
  const header = "The submitted result does not match the required schema:";
  if (violations.length === 0) {
    return `${header}\n(no details provided)`;
  }
  const lines = violations.map(
    (violation) => `${violation.path}: expected ${violation.expected}, got ${violation.got}`,
  );
  return [header, ...lines].join("\n");
}

function formatSubmitResultModelContent(output: unknown): string {
  const parsed = SubmitResultOutputSchema.safeParse(output);
  if (!parsed.success) return "submit_result returned an invalid result.";
  return "The result was accepted.";
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
