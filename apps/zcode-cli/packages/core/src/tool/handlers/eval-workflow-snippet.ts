// ============================================================
// EvalWorkflowSnippet Tool Handler
// ============================================================
// Experimental channel for dynamic workflow authoring: synchronously compile and run a
// scratch-facade snippet through `DynamicWorkflowSnippetPort` into the bootstrap execution layer.
// Fully transient: no background task and no persistence. Show a confirmation only for snippets containing a world.run command.
// (see prepareApproval).
//
// The port's presence selects the path:
//   1. Port present (production wiring): compile and execute, returning {ok, diagnostics, logs, response}.
//   2. Port absent (unwired host or unit test): return an honest business failure; never pretend it ran.

import {
  EVAL_WORKFLOW_SNIPPET_DEFAULT_TIMEOUT_MS,
  EVAL_WORKFLOW_SNIPPET_SOURCE_CONFLICT_ERROR,
  EVAL_WORKFLOW_SNIPPET_SOURCE_MISSING_ERROR,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  EvalWorkflowSnippetInputJsonSchema,
  EvalWorkflowSnippetInputSchema,
  EvalWorkflowSnippetOutputJsonSchema,
  EvalWorkflowSnippetOutputSchema,
  serializeWorkflowArtifact,
  type EvalWorkflowSnippetInput,
  type EvalWorkflowSnippetOutput,
  type ModelMessageContent,
  type TraceContext,
} from "@zcode/contracts";
import {
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  SNIPPET_FACADE_DTS,
} from "@zcode/dynamic-workflow";
import type {
  ToolApprovalGate,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolInputResolutionResult,
  ToolInputValidationResult,
} from "../types.js";
import { EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION } from "./eval-workflow-snippet-description.js";
import { readWorkflowScriptFile } from "./workflow-path-source.js";
import { formatWorkflowDiagnosticLines } from "./workflow-script-notes.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";
import { requireDynamicWorkflowSkill } from "./workflow-skill-gate.js";

// The tool-level timeout is an **outer safety net**, not the snippet's wall clock. The input timeoutMs (≤600s) tells the harness
// when to kill the child process and return a normal failure; reserve additional time here for compilation and cleanup. There is
// intentionally no dual-clock behavior: on the normal path, the inner timeout always fires first.
const EVAL_WORKFLOW_SNIPPET_TOOL_TIMEOUT_MS = 660_000;
const EVAL_WORKFLOW_SNIPPET_MODEL_BYTES = 24_000;

const NOT_EXECUTED_NOTE = "NOTE: The snippet was NOT executed — fix the errors above and call the tool again.";
const UNAVAILABLE_NOTE =
  "NOTE: The snippet was NOT executed — snippet evaluation is not available in this session.";

const EVAL_WORKFLOW_SNIPPET_FAILURE_CODE = 400;

/**
 * Exactly one source is allowed, and only for **model-provided** input: after normalization, both `code` and `path` may be present
 * in a valid execution state (same reason as `CreateWorkflow`; see create-workflow-source.ts).
 */
function validateEvalWorkflowSnippetInput(input: unknown): ToolInputValidationResult {
  const parsed = EvalWorkflowSnippetInputSchema.safeParse(input);
  if (!parsed.success) return { result: true };
  const hasCode = parsed.data.code !== undefined;
  const hasPath = parsed.data.path !== undefined;
  if (hasCode === hasPath) {
    // Report "both given" and "neither given" separately: the latter is usually the arguments
    // JSON failing to parse and the adapter restoring `{}` (see WORKFLOW_SOURCE_MISSING_HINT);
    // merged into one sentence, a model that did write `code` cannot read out the cause.
    return {
      result: false,
      errorCode: EVAL_WORKFLOW_SNIPPET_FAILURE_CODE,
      message: hasCode
        ? EVAL_WORKFLOW_SNIPPET_SOURCE_CONFLICT_ERROR
        : EVAL_WORKFLOW_SNIPPET_SOURCE_MISSING_ERROR,
    };
  }
  return { result: true };
}

/**
 * Normalize a `path` source into `code`. The entire file is the snippet (do not parse a metadata block), and store the path as an
 * absolute path. The confirmation gate (`prepareApproval` reads `code` to find world.run stations) and handler then see the same bytes.
 *
 * Both sources backfill `script` (= `code`) so the PreToolUse hook can read the snippet using
 * the other three tools' field names (see the `EvalWorkflowSnippetInputSchema` comment).
 */
async function resolveEvalWorkflowSnippetInput(
  input: unknown,
  cwd: string,
): Promise<ToolInputResolutionResult> {
  const parsed = EvalWorkflowSnippetInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };
  if (parsed.data.path === undefined) {
    const { code } = parsed.data;
    // A missing `code` cannot get here: validateInput already rejects "neither given".
    if (code === undefined) return { result: true, input };
    return {
      result: true,
      input: { ...parsed.data, code, script: code } satisfies EvalWorkflowSnippetInput,
    };
  }
  const read = await readWorkflowScriptFile({
    cwd,
    inputPath: parsed.data.path,
    parseFrontmatter: false,
  });
  if (!read.ok) {
    return { result: false, errorCode: EVAL_WORKFLOW_SNIPPET_FAILURE_CODE, message: read.message };
  }
  return {
    result: true,
    input: {
      ...parsed.data,
      code: read.file.source,
      script: read.file.source,
      path: read.file.path,
    } satisfies EvalWorkflowSnippetInput,
  };
}

const evalWorkflowSnippetHandler: ToolHandler = async (input, context) => {
  const parsed = EvalWorkflowSnippetInputSchema.parse(input) as EvalWorkflowSnippetInput;
  const code = parsed.code;
  if (code === undefined) {
    // Unreachable: validateInput rejects the case where both sources are absent, and resolveInput reads `path` into `code`.
    throw new Error("EvalWorkflowSnippet handler received input without resolved code");
  }
  // When a file exists, report diagnostics using **file line numbers** (the snippet has no metadata block, so the offset is always 0).
  const location =
    parsed.path === undefined
      ? undefined
      : {
          kind: "path" as const,
          described: describeWorkflowScriptPath(parsed.path, context.workingDirectory),
          lineOffset: 0,
        };
  const startedAt = Date.now();

  const port = context.dynamicWorkflowSnippetPort;
  if (port === undefined) {
    // Unwired host: fail honestly (same semantics as CreateWorkflow's EXECUTION_UNAVAILABLE).
    return {
      ok: false,
      diagnostics: [],
      logs: [],
      response: UNAVAILABLE_NOTE,
      durationMs: 0,
    } satisfies EvalWorkflowSnippetOutput;
  }

  const result = await port.evalSnippet(
    {
      code,
      cwd: context.workingDirectory,
      timeoutMs: parsed.timeoutMs ?? EVAL_WORKFLOW_SNIPPET_DEFAULT_TIMEOUT_MS,
      trace: resolveTraceContext(context),
    },
    { signal: context.abortSignal },
  );
  const durationMs = Math.max(0, Date.now() - startedAt);

  if (result.kind === "diagnostics") {
    return {
      ok: false,
      diagnostics: result.diagnostics,
      logs: [],
      response: [
        "The snippet has errors:",
        ...formatWorkflowDiagnosticLines(result.diagnostics, location),
        "",
        NOT_EXECUTED_NOTE,
      ].join("\n"),
      durationMs,
    } satisfies EvalWorkflowSnippetOutput;
  }

  const logsSection = renderLogs(result.logs, result.logsTruncated);

  if (result.kind === "failed") {
    return {
      ok: false,
      diagnostics: [],
      logs: result.logs,
      response: [
        `The snippet failed (${result.error.code}): ${result.error.message}`,
        ...logsSection,
      ].join("\n"),
      durationMs,
    } satisfies EvalWorkflowSnippetOutput;
  }

  // Completed. An `undefined` result means “no return value”; report that faithfully instead of inventing an empty object.
  const serialized = serializeWorkflowArtifact(result.artifact);
  return {
    ok: true,
    diagnostics: [],
    logs: result.logs,
    response: [
      `The snippet completed in ${durationMs}ms.`,
      serialized === undefined ? "It returned no value." : `Return value:\n${serialized}`,
      ...logsSection,
    ].join("\n"),
    durationMs,
  } satisfies EvalWorkflowSnippetOutput;
};

/** Render logs into response (formatModelContent returns only response, so the model cannot see logs otherwise). */
function renderLogs(logs: string[], truncated: boolean): string[] {
  if (logs.length === 0) return [];
  return [
    "",
    "Logs:",
    ...logs.map((message) => `- ${message}`),
    ...(truncated ? ["- … (logs truncated)"] : []),
  ];
}

/** The port contract requires trace; synthesize it from discrete fields, as the CreateWorkflow handler does. */
function resolveTraceContext(context: ToolExecutionContext): TraceContext {
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
 * Confirmation gate for snippets: interrupt the user only when the snippet contains a world.run station. Purely read-only snippets
 * (files/git plus computation) proceed silently, as do snippets that fail to compile (the handler returns diagnostics through the
 * port, and confirming code that cannot compile has no value; same approach as the CreateWorkflow gate).
 *
 * V1 uses a **standard permission ask** (no rich preview): the permission display schema is `.strict()` on deployed desktops, so
 * adding a new payload kind would cause older desktops to discard the entire permission.requested event and remove the confirmation
 * gate (a similar regression was reproduced). Users can read the commands directly from the input code (`cmd` is a compile-time
 * literal; this is the readability benefit of the literal rule).
 *
 * Compilation happens twice here and in the port (the gate is in core, execution is in bootstrap, and ts.Program is not shared across
 * packages). Snippets are small, and the duplicate compilation means the gate does not depend on the port being present.
 */
function prepareEvalWorkflowSnippetApproval(input: unknown): ToolApprovalGate {
  const parsed = EvalWorkflowSnippetInputSchema.safeParse(input);
  // After normalization, `code` must be present (`path` has already been read into it); if absent, a caller bypassed the lifecycle, so let the handler report it.
  if (!parsed.success || parsed.data.code === undefined) return { gate: "proceed" };
  const workflow = createWorkflowProgram(parsed.data.code, { facadeDts: SNIPPET_FACADE_DTS });
  if (collectDiagnostics(workflow.program).length > 0) return { gate: "proceed" };
  const { commands, diagnostics } = collectWorldRunCommands(workflow, collectSites(workflow));
  if (diagnostics.length > 0) return { gate: "proceed" };
  return commands.length > 0 ? { gate: "ask" } : { gate: "proceed" };
}

export const evalWorkflowSnippetToolEntry: ToolEntry = {
  capability:
    "Compile and synchronously run a small dynamic-workflow TypeScript snippet (world reads + pure logic) against the real workflow execution path, fully ephemerally",
  metadata: {
    shouldDefer: true,
    name: EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
    description: EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION,
    // Once world.run is included, the snippet can produce effects: readOnly flips, and prepareApproval applies the confirmation gate
    // (ask only when a world.run station is present).
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: EVAL_WORKFLOW_SNIPPET_TOOL_TIMEOUT_MS,
    maxOutputBytes: EVAL_WORKFLOW_SNIPPET_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "low",
    needsApproval: true,
  },
  prepareApproval: prepareEvalWorkflowSnippetApproval,
  handler: evalWorkflowSnippetHandler,
  // The one-source rule applies only to model input; normalization reads `path` into `code`, so confirmation and handler see the same shape.
  validateInput: (input) => validateEvalWorkflowSnippetInput(input),
  resolveInput: (input, context) =>
    // The skill gate precedes path normalization (handlers/workflow-skill-gate.ts); snippet language rules are in the skill too.
    requireDynamicWorkflowSkill(context, EVAL_WORKFLOW_SNIPPET_TOOL_NAME) ??
    resolveEvalWorkflowSnippetInput(input, context.workingDirectory ?? "."),
  inputSchema: EvalWorkflowSnippetInputJsonSchema,
  outputSchema: EvalWorkflowSnippetOutputJsonSchema,
  runtimeInputSchema: EvalWorkflowSnippetInputSchema,
  runtimeOutputSchema: EvalWorkflowSnippetOutputSchema,
  formatModelContent: formatEvalWorkflowSnippetModelContent,
  permission: {
    permission: "evalWorkflowSnippet",
    reason:
      "evalWorkflowSnippet.runConfirmation: snippets carrying world.run commands must be confirmed",
    riskLevel: "low",
    sideEffectScope: "workspace",
    needsApproval: true,
    // Input is code text with no path subject, so match patterns by tool name only.
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // Standard permission behavior.
    // alwaysAsk belongs only to CreateWorkflow: a full workflow is load-bearing and expensive enough to override every allow rule.
    // Snippets are cheap and transient, so use the standard pattern/rule flow like Bash (always-allow and yolo still apply).
    // In the default ask flow, prepareApproval still lets read-only and uncompileable snippets proceed; the dialog appears only for
    // snippets that actually contain a command.
  },
  resultBudget: {
    maxInlineBytes: EVAL_WORKFLOW_SNIPPET_MODEL_BYTES,
    maxModelBytes: EVAL_WORKFLOW_SNIPPET_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: EVAL_WORKFLOW_SNIPPET_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: EVAL_WORKFLOW_SNIPPET_TOOL_TIMEOUT_MS,
    maxMs: EVAL_WORKFLOW_SNIPPET_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    // Pass the abort signal through to the harness to kill the sandbox child process (bestEffort because it may already have exited during cleanup).
    cleanup: "bestEffort",
    userVisibleMessage: "Snippet evaluation cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatEvalWorkflowSnippetModelContent(output: unknown): ModelMessageContent {
  const parsed = EvalWorkflowSnippetOutputSchema.safeParse(output);
  if (!parsed.success) return "EvalWorkflowSnippet returned an invalid result.";
  return parsed.data.response;
}
