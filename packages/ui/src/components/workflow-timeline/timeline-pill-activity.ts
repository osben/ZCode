import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { workflowRunOverlay } from "@/components/workflow-graph/run-status.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { TimelinePill } from "./timeline-model.js";

// Used to live in timeline-model.ts; after dwf-recursive and dwf-pipeline-display merged, that file
// reached 430 lines (oxlint max-lines cap 400). A pill's activity label reads only display and run
// and takes no part in model folding, so it gets its own file.

/** What a pill is "doing right now": prefer the running step's label, then the last settled one, then the first. */
export function pillActivity(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
  pill: TimelinePill,
): { label: string; asks: number; reads: number } {
  const stepsById = new Map(graph.steps.map((step) => [step.id, step]));
  const statuses = run === undefined ? {} : workflowRunOverlay(run, graph).statuses;
  let asks = 0;
  let reads = 0;
  let running: string | undefined;
  let done: string | undefined;
  let first: string | undefined;
  for (const id of pill.stepIds) {
    const step = stepsById.get(id);
    // The hole's own station (kind `hole`) is not an ask and contributes no pill label.
    if (step === undefined || step.kind === "hole") continue;
    if (step.kind === "world-read") reads += 1;
    else asks += 1;
    first ??= step.label;
    const status = statuses[id];
    if (status === "running") running ??= step.label;
    else if (status === "done" || status === "failed") done = step.label;
  }
  return { asks, label: running ?? done ?? first ?? "", reads };
}
