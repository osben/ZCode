import { collapseStatuses, hasPhaseVocabulary } from "./participant-model.js";
import type {
  StepRunStatus,
  StepStatusTable,
  WorkflowCausalityGraphData,
  WorkflowPhaseData,
  WorkflowStepData,
} from "./types.js";

/**
 * Pure selectors for the phase layer. Phases are a quotient layer **over the graph**:
 * this does not modify the graph; it only buckets steps by `Step.phase`. Selectors for the second layer (participants and handoffs) are in
 * participant-model.ts. The old drill-down filter (`filterGraphToPhase`) and roster (`phaseActors`) were retired with step-level rendering.
 *
 * No React or DOM.
 */

export { hasPhaseVocabulary };

/**
 * Phase ID → member steps, bucketed in `phases` order (the phase table order defines visual sequence).
 * A cross-phase copy belongs to the phase where it appears.
 */
export function phaseMembers(graph: WorkflowCausalityGraphData): Map<string, WorkflowStepData[]> {
  const members = new Map<string, WorkflowStepData[]>(
    (graph.phases ?? []).map((phase) => [phase.id, []]),
  );
  for (const step of graph.steps) {
    if (step.phase === undefined) continue;
    members.get(step.phase)?.push(step);
  }
  return members;
}

/**
 * Fold member-step statuses again (see `aggregateRunStatuses` for the grid): members without an entry do not participate.
 * If no member has an entry, this is static rendering or the whole station was unobserved; return undefined.
 */
export function collapsePhaseStatus(
  members: readonly WorkflowStepData[],
  statuses: StepStatusTable | undefined,
): StepRunStatus | undefined {
  return collapseStatuses(
    members.map((step) => step.id),
    statuses,
  );
}

/** Get a phase by ID; inspectors and hosts use it to obtain display-name data. */
export function findPhase(
  graph: WorkflowCausalityGraphData,
  phaseId: string,
): WorkflowPhaseData | undefined {
  return (graph.phases ?? []).find((phase) => phase.id === phaseId);
}
