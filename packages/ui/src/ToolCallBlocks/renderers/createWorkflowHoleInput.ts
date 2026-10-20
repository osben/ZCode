import {
  isSyntheticLaneId,
  type WorkflowCausalityGraphData,
} from "@/components/workflow-graph/types.js";
import { isPlainRecord } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";

/**
 * Target hole of a FillWorkflowHole row (docs/dynamic-workflow/presentation.md "The fill row"): `run_id` /
 * `hole_id` come from the row's input (written by the model); **the name, draft path, and line come from
 * the display's `fill` block** — the tool writes them from the resolved hole into its output and the
 * projection carries them verbatim. The `hole` block in the input is backfilled by resolveInput for
 * permission rules and is not stored in the transcript (observed live on 2026-09-28 in the first relay
 * run: reading only the input left the row title as `hole#1`) — it is still read here only so the
 * confirmation-dialog path can get the resolved input; display wins when present. Split out of
 * createWorkflowInput.ts (max-lines gate).
 */
export interface WorkflowHoleTarget {
  runId: string | undefined;
  holeId: string | undefined;
  name: string | undefined;
  draftPath: string | undefined;
  line: number | undefined;
}

/** The display's `fill` block (same shape as shared's toolCallCreateWorkflowDisplaySchema.fill), verbatim when unresolved. */
export interface WorkflowDisplayFill {
  siteId: string;
  name: string;
  draftPath?: string;
  line?: number;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

export function readWorkflowHoleTarget(
  input: unknown,
  fill?: WorkflowDisplayFill,
): WorkflowHoleTarget | undefined {
  if (!isPlainRecord(input)) return undefined;
  const hole = isPlainRecord(input.hole) ? input.hole : undefined;
  const line = fill?.line ?? hole?.line;
  return {
    runId: trimmed(input.run_id),
    holeId: trimmed(input.hole_id) ?? trimmed(fill?.siteId),
    name: trimmed(fill?.name) ?? trimmed(hole?.name),
    draftPath: trimmed(fill?.draftPath) ?? trimmed(hole?.draft_path),
    line: typeof line === "number" && Number.isInteger(line) && line > 0 ? line : undefined,
  };
}

/** The fill body (`script`): uses the same channel as CreateWorkflow's script; streaming draft scanning derives phases from it. */
export function readWorkflowHoleBody(input: unknown): string | undefined {
  return isPlainRecord(input) && typeof input.script === "string" ? input.script : undefined;
}

/**
 * How many phases and subagents one fill wrote ("hole filled · {name} · {k} phases · {m} subagents"):
 * phases and sites with `fill === holeId` on the valid script's graph. The hole's own phase
 * (a fill with no phases) does not count as a phase.
 */
export function workflowFillCounts(
  graph: WorkflowCausalityGraphData | undefined,
  holeId: string,
): { phases: number; agents: number } {
  if (graph === undefined) return { agents: 0, phases: 0 };
  const phases = (graph.phases ?? []).filter((phase) => phase.fill === holeId).length;
  const lanes = new Set<string>();
  for (const step of graph.steps) {
    // An open inner hole written by the fill (kind `hole`, lane `main`) is not a subagent.
    if (step.fill === holeId && step.kind !== "hole" && !isSyntheticLaneId(step.lane)) {
      lanes.add(step.lane);
    }
  }
  return { agents: lanes.size, phases };
}
