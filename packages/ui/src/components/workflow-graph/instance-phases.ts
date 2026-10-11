import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseNameMatches } from "./phase-name.js";
import type { WorkflowCausalityGraphData } from "./types.js";

/**
 * Phase ownership for runtime instances.
 *
 * Static may-set copies are indexed by phase (`ask#1~phase#3`); runtime instances carry the same coordinate—the current phase name
 * (`phaseName`) recorded by the engine when it assigned the ordinal. This centralizes the rule for which display phases contain a stamp,
 * shared by card binding (participant-model.ts) and station observation (timeline-model.ts): one **partition**, not a broadcast.
 */

/** Whether this run has phase information: any actor/node carries a stamp. Older CLIs, older runs, and unmarked scripts do not. */
export function runHasPhaseVocabulary(run: WorkflowRunState | undefined): boolean {
  if (run === undefined) return false;
  return (
    run.actors.some((actor) => actor.phaseName !== undefined) ||
    run.nodes.some((node) => node.phaseName !== undefined)
  );
}

/**
 * Display phases that own one stamp:
 *   - With a stamp → display phase with the matching name (`phaseNameMatches`, including its truncation fallback).
 *   - Without a stamp when the run has phase vocabulary → **unnamed** display phase (`unphased` / implicit `workflow`): the analyzer
 *     places steps before the first marker in the unnamed `unphased` phase, so "unstamped ↔ unnamed" are two sides of the same fact.
 *   - Without a stamp and without run vocabulary → all phases (current behavior).
 * If any branch produces an empty result, use all phases: duplicate display is preferable to hiding a running subagent.
 */
export function phasesOf(
  phaseName: string | undefined,
  graph: WorkflowCausalityGraphData,
  runHasVocabulary: boolean,
): Set<string> {
  const phases = graph.phases ?? [];
  const all = () => new Set(phases.map((phase) => phase.id));
  if (phaseName === undefined && !runHasVocabulary) return all();
  const matched = phases.filter((phase) =>
    phaseName === undefined ? phase.name === undefined : phaseNameMatches(phase.name, phaseName),
  );
  return matched.length === 0 ? all() : new Set(matched.map((phase) => phase.id));
}

/** Resolver created once per view: compute vocabulary detection and each stamp's result once (queried for every node). */
export interface PhaseBinder {
  phasesOf(phaseName: string | undefined): ReadonlySet<string>;
  /** Whether this stamp belongs to this station/card. */
  has(phaseId: string, phaseName: string | undefined): boolean;
}

export function phaseBinder(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): PhaseBinder {
  const vocabulary = runHasPhaseVocabulary(run);
  // The graph has no phase vocabulary yet (an unmarked script before the UI synthesizes its implicit phase), so there are no coordinates
  // to partition; treat every stamp as belonging. Otherwise, an always-empty ownership set would remove every instance from every card.
  const ungrouped = (graph.phases ?? []).length === 0;
  const cache = new Map<string | undefined, ReadonlySet<string>>();
  const resolve = (phaseName: string | undefined): ReadonlySet<string> => {
    const hit = cache.get(phaseName);
    if (hit !== undefined) return hit;
    const phases = phasesOf(phaseName, graph, vocabulary);
    cache.set(phaseName, phases);
    return phases;
  };
  return {
    has: (phaseId, phaseName) => ungrouped || resolve(phaseName).has(phaseId),
    phasesOf: resolve,
  };
}
