import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowDraftPosition } from "@/ToolCallBlocks/shared.js";
import {
  isPlainRecord,
  readWorkflowAmendTarget,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import { isAmendWorkflowToolCall, isCreateWorkflowToolCall } from "@/lib/workflowToolNames.js";

/**
 * Join table from workflow tool rows to draft positions (draft number and whether they have been superseded), built in one pass over the row window.
 *
 * A script that does not compile is not a failure: nothing ran, and the diagnostic goes back to the model for another attempt. The card must show the draft number
 * and whether a newer draft follows, facts not available on a single row. They can only be read from row order; this is the only implementation, and cards read its result.
 *
 * Rules:
 * - Lineage: tool name, plus predecessor `run_id` for revisions. Count creations among creations; each run's revisions start at 1.
 * - Draft number: 1 + the number of failed rows (`ok === false`) in the same lineage and turn since the most recent successful compile (`display.ok === true`);
 *   rows without display (streaming, awaiting approval, rejected, canceled) do not count or reset the number; a new turn starts at 1.
 * - Superseded: a later row in the same lineage exists in the window (in the same or a later turn).
 *
 * The row window is bounded, so draft numbers may be low after earlier drafts leave the window. Draft numbers are display-only and have no other consumers.
 */
export function buildWorkflowDraftByToolCallId(
  rows: readonly ConversationRow[] | undefined,
): ReadonlyMap<string, WorkflowDraftPosition> {
  const byToolCallId = new Map<string, WorkflowDraftPosition>();
  // Lineage → latest toolCallId for that lineage (used to mark it superseded when a later row appears).
  const latestByLineage = new Map<string, string>();
  // Lineage + turn → consecutive failure count since the last successful compile.
  const failuresByLineageTurn = new Map<string, number>();

  for (const row of rows ?? []) {
    if (row.kind !== "toolCall") continue;
    const lineage = workflowDraftLineage(row);
    if (lineage === undefined) continue;

    const previous = latestByLineage.get(lineage);
    if (previous !== undefined) {
      const position = byToolCallId.get(previous);
      if (position !== undefined) byToolCallId.set(previous, { ...position, superseded: true });
    }
    latestByLineage.set(lineage, row.toolCallId);

    const turnKey = `${lineage}\u0000${row.turnId}`;
    const failures = failuresByLineageTurn.get(turnKey) ?? 0;
    byToolCallId.set(row.toolCallId, { ordinal: failures + 1, superseded: false });

    const compiled = readCompiled(row);
    if (compiled === false) failuresByLineageTurn.set(turnKey, failures + 1);
    if (compiled === true) failuresByLineageTurn.set(turnKey, 0);
  }
  return byToolCallId;
}

function workflowDraftLineage(row: ToolCallRow): string | undefined {
  if (isAmendWorkflowToolCall(row)) {
    return `amend\u0000${readWorkflowAmendTarget(row.input) ?? ""}`;
  }
  return isCreateWorkflowToolCall(row) ? "create" : undefined;
}

/**
 * Whether this row has been compiled: `true` / `false` comes from display; it is `undefined` when there is no display.
 * The canonical location for display is `output.display`; top-level `display` is a compatibility path for old snapshots
 * (with the same precedence as `toolCallRowToLegacyNode`; if the two readers diverge, cards and status labels will disagree).
 */
function readCompiled(row: ToolCallRow): boolean | undefined {
  const display: unknown = row.output?.display ?? row.display;
  if (!isPlainRecord(display) || display.kind !== "create_workflow") return undefined;
  return typeof display.ok === "boolean" ? display.ok : undefined;
}
