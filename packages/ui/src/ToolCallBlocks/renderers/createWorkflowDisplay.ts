import {
  toolCallCreateWorkflowDisplaySchema,
  type ToolCallCreateWorkflowDisplay,
} from "@zcode/shared/zcode-protocol-v4";
import { isPlainRecord } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";

/**
 * Read rules for CreateWorkflow tool output (display payload and plain-text fallback). Split from
 * `create-workflow.tsx` to meet oxlint's 400-line limit, following `createWorkflowInput.ts`: pure functions, no JSX.
 */
// Structured diagnostics use only the display channel. Safely parse raw.display with the packages/shared schema;
// if it is missing or malformed, use the plain-text fallback. Never dump JSON or throw.
export function readWorkflowDisplay(raw: unknown): ToolCallCreateWorkflowDisplay | null {
  if (!isPlainRecord(raw)) {
    return null;
  }

  const parsed = toolCallCreateWorkflowDisplaySchema.safeParse(raw.display);
  return parsed.success ? parsed.data : null;
}

export function readFallbackOutputText(output: unknown): string | null {
  if (typeof output === "string") {
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (isPlainRecord(output)) {
    for (const key of ["response", "output", "text", "content"] as const) {
      const candidate = output[key];
      if (typeof candidate === "string") {
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }

  return null;
}

interface WorkflowDiagnosticPosition {
  line: number;
  column: number;
  message: string;
}

/**
 * Hover tooltip for a compiler feedback row: show the lead sentence first (what did not happen and who acts next),
 * then each `L{line}:C{col} message` in the same format received by the model for easy comparison after copying.
 */
export function formatWorkflowFeedbackTooltip(
  lede: string,
  diagnostics: readonly WorkflowDiagnosticPosition[],
): string {
  return [
    lede,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
}

/** Script lines referenced by diagnostics (first-seen order, deduplicated, positive line numbers only); highlight them when the script expands. */
export function workflowDiagnosticLines(
  diagnostics: readonly WorkflowDiagnosticPosition[],
): number[] {
  const lines = diagnostics.map((diagnostic) => diagnostic.line).filter((line) => line > 0);
  return [...new Set(lines)];
}
