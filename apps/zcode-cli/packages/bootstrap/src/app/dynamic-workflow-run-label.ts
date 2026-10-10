// ============================================================
// Display label for a workflow run (derived at read time; never written back to dwf_run.name).
// ============================================================
//
// Two reasons for keeping this in a separate module:
//   1. **Both read surfaces share one path.** If the list (ListWorkflowRuns) and detail (GetWorkflowRun) each build their own fallback,
//      they may drift and show different names for the same run.
//   2. **Directly unit-testable.** The run service pulls in AgentRuntime / engine / journal dependencies;
//      a pure function should not require that cost just to test its behavior.

import type { DynamicWorkflowRunSummary } from "@zcode/contracts";

/**
 * Character limit for a script-derived label. 80 fits in one readable list row; a derived heuristic stops looking like a label when it gets longer.
 */
const DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS = 80;

/**
 * Derive the run's display label: `name` → first non-empty script line (trimmed and truncated to 80) → runId.
 *
 * Deliberately avoid "smarter" extraction (first comment, regex title search, agent name): the first line is **honest**
 * ("the script starts with this"), while every extra heuristic is another way to produce a misleading label for someone else's script.
 *
 * **Never write the derived result back** to `dwf_run.name`: persisting it would turn a display heuristic into data, making it impossible to know later
 * whether the run actually had a name.
 */
export function resolveDynamicWorkflowRunLabel(input: {
  runId: string;
  name?: string;
  scriptText?: string;
}): Pick<DynamicWorkflowRunSummary, "label" | "labelSource"> {
  // A blank name is equivalent to no name: it would appear as an unclickable empty row, not a label.
  const name = input.name?.trim();
  if (name !== undefined && name.length > 0) return { label: name, labelSource: "name" };

  const firstLine = firstNonEmptyLine(input.scriptText);
  if (firstLine !== undefined) {
    return { label: boundLabel(firstLine), labelSource: "script" };
  }

  // This should never happen (submit requires scriptText). Keep labelSource as "script": the tool surface distinguishes only
  // "user-named" and "derived" labels; adding another source for an impossible branch would make consumers add an unreachable check.
  return { label: input.runId, labelSource: "script" };
}

/** First non-empty line (already trimmed). Return undefined if the entire text is blank. */
function firstNonEmptyLine(scriptText: string | undefined): string | undefined {
  if (scriptText === undefined) return undefined;
  for (const line of scriptText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/**
 * Truncate to the limit without leaving a lone surrogate. Scripts are external, model-written input, and string literals can contain emoji;
 * half a surrogate pair is invalid text and can break downstream JSON encoding/decoding in some runtimes
 * (same handling as create-workflow's boundGraphText and port payload bounding).
 */
function boundLabel(value: string): string {
  if (value.length <= DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS) return value;
  const cut = value.slice(0, DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS);
  const lastCode = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}
