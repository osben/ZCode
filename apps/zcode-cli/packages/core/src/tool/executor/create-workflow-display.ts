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
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";

/**
 * Three tools share the `create_workflow` display: the two start tools and hole completion—its output is
 * CreateWorkflowOutput, the graph represents the effective script, and the UI's shared row renderer recognizes completion by tool name
 * (docs/dynamic-workflow/presentation.md, “The fill row” in “Holes on the timeline”).
 */
const CREATE_WORKFLOW_DISPLAY_TOOL_NAMES: ReadonlySet<string> = new Set([
  CREATE_WORKFLOW_TOOL_NAME,
  AMEND_WORKFLOW_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
]);

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
  if (!CREATE_WORKFLOW_DISPLAY_TOOL_NAMES.has(toolName)) return undefined;
  const parsed = CreateWorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  // In-place concurrency updates have no display (docs/dynamic-workflow/launch.md, “Changing only the parallelism of a
  // live run”): this route does not compile any script, while `ok` in this `create_workflow` payload means “compiled” in the UI.
  // Check for the **explicit `retuned` block**, not the shape—“ok with no status” also means “no run port, typecheck only” for this tool.
  // The tool card therefore falls back to the response body.
  if (parsed.data.retuned !== undefined) return undefined;

  const { causalityGraph, diagnostics, fill, ok } = parsed.data;
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
    // The field that gives the completion row its name (see contracts' CreateWorkflowOutputSchema.fill for why it is part of display).
    ...(fill === undefined ? {} : { fill }),
  };
}
