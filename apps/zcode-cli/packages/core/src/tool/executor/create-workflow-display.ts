/**
 * Build the CreateWorkflow result-card display. Split from result-display.ts to keep it
 * within the 400-line limit. Like workflow-observation-display.ts, this dispatches by
 * tool name, safe-parses the output schema, and applies a separate display-side limit.
 */

import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS,
  CREATE_WORKFLOW_TOOL_NAME,
  CreateWorkflowOutputSchema,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";

/**
 * ⚠ The field set in this projection is **frozen** (see the schema comment in
 * contracts for the reason). Gate-specific facts—such as the saved-run source and the
 * resolved script—must travel through **tool input**, never through display.
 */
export function createCreateWorkflowDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  // Both launch tools share one display kind, so the UI needs only one implementation of the graph, draft pen, and diagnostics card.
  if (toolName !== CREATE_WORKFLOW_TOOL_NAME && toolName !== AMEND_WORKFLOW_TOOL_NAME) {
    return undefined;
  }
  const parsed = CreateWorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  // In-place concurrency tuning has no display: it does not compile any script, while
  // the UI interprets `ok` in this `create_workflow` payload as “compiled”. Check for an
  // **explicit `retuned` block**, not just the shape: this tool can also return “ok with
  // no status” when there is no run port and only typechecking occurred. In that case,
  // the tool card falls back to the response body.
  if (parsed.data.retuned !== undefined) return undefined;

  const { causalityGraph, diagnostics, ok } = parsed.data;
  // Display bypasses the tool-result budget, so both diagnostic count and individual
  // message length need independent limits before entering live events and persisted
  // metadata. This prevents type errors from expanding continuous/replayable messages
  // without bound. causalityGraph is already limited at the tool-output boundary
  // (handler's boundCausalityGraph plus the output schema), so pass it through directly.
  const errorCount = diagnostics.length;
  const bounded = diagnostics
    .slice(0, CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS)
    .map((diagnostic) => ({
      line: diagnostic.line,
      column: diagnostic.column,
      code: diagnostic.code,
      message: diagnostic.message.slice(0, CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS),
    }));
  const truncated = errorCount > bounded.length;

  return {
    kind: "create_workflow",
    ok,
    errorCount,
    diagnostics: bounded,
    ...(causalityGraph === undefined ? {} : { causalityGraph }),
    ...(truncated ? { truncated: true } : {}),
  };
}
