import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseBinder } from "./instance-phases.js";
import { aggregateRunStatuses, statusOfRunNode } from "./run-status.js";
import {
  IMPLICIT_PHASE_ID,
  type StepRunStatus,
  type StepStatusTable,
  type WorkflowCausalityGraphData,
  type WorkflowHandoffData,
  type WorkflowParticipantData,
  type WorkflowPhaseData,
} from "./types.js";

/**
 * Pure selectors for the participant layer.
 *
 * The payload's `participants` are already sorted in **handoff order** by the analyzer (the first is the initiator),
 * and `handoffs` are already reduced. This module only groups, collapses statuses, and counts, plus two UI-specific tasks:
 *   - synthesize an implicit phase for scripts without markers (`withImplicitPhase`) so the board has one rendering model;
 *   - during a run, split `many` cards by actual instance, narrow member cards by ordinal, and bind a single card to its
 *     only instance or split it when multiple instances exist (`liveParticipantView`).
 *
 * No React or DOM dependencies: both the projection layer and components consume it, and tests call it directly.
 */

export { IMPLICIT_PHASE_ID };

/** This used to be the sole view-switching check; now it only answers whether this graph needs an implicit phase. */
export function hasPhaseVocabulary(graph: WorkflowCausalityGraphData): boolean {
  return graph.phases !== undefined && graph.phases.length > 0;
}

/**
 * A script without a `phase()` marker becomes one implicit module: the phase table contains only `workflow`
 * (no name; the UI localizes it as "Workflow"), there are no phase edges, and control flow reaches normal completion
 * exactly when the script has a return value. Every step and card belongs to it (the analyzer's `unphased` is only a
 * placeholder for "no phase"; card IDs remain unchanged).
 * A graph with a phase vocabulary is returned unchanged (same reference, memo-friendly).
 */
export function withImplicitPhase(graph: WorkflowCausalityGraphData): WorkflowCausalityGraphData {
  if (hasPhaseVocabulary(graph)) return graph;
  return {
    ...graph,
    exits: graph.sink !== undefined && graph.sink.length > 0 ? [IMPLICIT_PHASE_ID] : [],
    participants: graph.participants.map((participant) => ({
      ...participant,
      phase: IMPLICIT_PHASE_ID,
    })),
    phaseEdges: [],
    phases: [{ id: IMPLICIT_PHASE_ID }],
    steps: graph.steps.map((step) => ({ ...step, phase: IMPLICIT_PHASE_ID })),
  };
}

/** Participants in one phase, preserving payload order (handoff order). */
export function participantsOfPhase(
  graph: WorkflowCausalityGraphData,
  phaseId: string,
): WorkflowParticipantData[] {
  return graph.participants.filter((participant) => participant.phase === phaseId);
}

export function participantById(
  graph: WorkflowCausalityGraphData,
  id: string,
): WorkflowParticipantData | undefined {
  return graph.participants.find((participant) => participant.id === id);
}

/** Handoff edges whose endpoints are both in the given set (edges within a phase). */
export function handoffsWithin(
  graph: WorkflowCausalityGraphData,
  ids: ReadonlySet<string>,
): WorkflowHandoffData[] {
  return graph.handoffs.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
}

export function handoffsAround(
  graph: WorkflowCausalityGraphData,
  id: string,
): { incoming: WorkflowHandoffData[]; outgoing: WorkflowHandoffData[] } {
  return {
    incoming: graph.handoffs.filter((edge) => edge.to === id),
    outgoing: graph.handoffs.filter((edge) => edge.from === id),
  };
}

/** Counts for the card's secondary row: ask count and workspace-read count (only one can be nonzero per card). */
export interface ParticipantCounts {
  asks: number;
  reads: number;
}

export function participantCounts(
  graph: WorkflowCausalityGraphData,
  participant: WorkflowParticipantData,
): ParticipantCounts {
  const kinds = new Map(graph.steps.map((step) => [step.id, step.kind]));
  let asks = 0;
  let reads = 0;
  for (const id of participant.steps) {
    if (kinds.get(id) === "world-read") reads += 1;
    else asks += 1;
  }
  return { asks, reads };
}

/** If any step has `repeat`, show the repeated-iteration glyph on the card (a self-loop disappears at participant granularity, leaving this as its cue). */
export function participantRepeats(
  graph: WorkflowCausalityGraphData,
  participant: WorkflowParticipantData,
): boolean {
  const repeating = new Set(
    graph.steps.filter((step) => step.repeat !== undefined).map((step) => step.id),
  );
  return participant.steps.some((id) => repeating.has(id));
}

/**
 * Collapse statuses for multiple steps: collect statuses only for steps that **have entries** and pass them to
 * `aggregateRunStatuses` (the sole aggregation point; see its ordering). Steps without entries do not participate:
 * they are sites the control flow did not visit, not queued nodes. Return undefined when there are no entries (or for
 * static rendering). Shared by cards, stations, and the inspector title indicator.
 */
export function collapseStatuses(
  stepIds: readonly string[],
  statuses: StepStatusTable | undefined,
): StepRunStatus | undefined {
  if (statuses === undefined) return undefined;
  const values: StepRunStatus[] = [];
  for (const id of stepIds) {
    const status = statuses[id];
    if (status !== undefined) values.push(status);
  }
  return aggregateRunStatuses(values);
}

/**
 * Status for one card: prefer the instance-specific override from the live view (member card / split instance card);
 * otherwise collapse the card's step statuses.
 */
export function participantStatus(
  participant: WorkflowParticipantData,
  statuses: StepStatusTable | undefined,
  participantStatuses?: Record<string, StepRunStatus>,
): StepRunStatus | undefined {
  return participantStatuses?.[participant.id] ?? collapseStatuses(participant.steps, statuses);
}

/** Other phases where the same lane appears (the inspector's "also in" row). */
export function participantAlsoIn(
  graph: WorkflowCausalityGraphData,
  participant: WorkflowParticipantData,
): WorkflowPhaseData[] {
  const phases = new Set(
    graph.participants
      .filter((other) => other.lane === participant.lane && other.phase !== participant.phase)
      .map((other) => other.phase),
  );
  return (graph.phases ?? []).filter((phase) => phases.has(phase.id));
}

/** ID of a split instance card: `${participant.id}@${ordinal}`. */
export function instanceCardId(participantId: string, ordinal: number): string {
  return `${participantId}@${ordinal}`;
}

/**
 * Instance associated with a card:
 * the single instance belonging to a split instance card (`many` card or a single card with multiple instances),
 * or the one **bound** to the original card (a single card with exactly one instance, or the i-th member card).
 * The name is the effective name emitted by the engine, which the card should display when available.
 */
export interface ParticipantInstance {
  /** Participant ID before splitting (for a bound card, this is the card's own ID). */
  participant: string;
  ordinal: number;
  name?: string;
  /**
   * The original card is bound, not split: its ID and label rule stay unchanged (member cards remain `#i`; single cards have no label),
   * so the runtime name gets no visual marker. If absent, this is a split instance card whose label is `#ordinal`.
   */
  bound?: true;
}

export interface LiveParticipantView {
  /** Graph with participants and handoffs split by instance; without a run, this is the input graph (same reference). */
  graph: WorkflowCausalityGraphData;
  /** Card statuses narrowed by instance (member cards and instance cards); remaining cards use collapsed step statuses. */
  participantStatuses: Record<string, StepRunStatus>;
  /** Instance-card ID to identity. */
  instances: Record<string, ParticipantInstance>;
}

/**
 * Live view.
 *
 *  - `many` card: create one card for each actor instance seen in that lane and copy the original card's handoff edges to each instance card;
 *    keep the original card while no instance has appeared (status is collapsed from its steps).
 *  - Single card: bind the original card to the lane's only instance (ID unchanged, status still collapsed from steps, now with a name);
 *    with two or more instances, use the same split path as `many` because runtime cardinality takes precedence over static cardinality.
 *  - Member card (literal cardinality expansion): member i binds to the i-th instance in the lane sorted by ordinal and uses only that
 *    instance's nodes for status; if the instance has not appeared, it is pending and unbound. Extra instances beyond `of` get no card.
 *  - Synthetic lanes such as workspace have no instances, so their cards stay unchanged.
 *
 * Narrow nodes by `(siteId ∈ card sites, actorSiteId === lane, actorOrdinal === ordinal, card phase ∈
 * phasesOf(node))`; derive the site from `step.source ?? step.id` (may-set copies report site IDs, matching
 * the association key in run-status.ts). If an instance is present but has no node at its sites, it is pending:
 * the instance is observed, it simply has not acted at this station yet (collapsing an empty set returns undefined; absence is resolved here).
 *
 * "Instance binding": the instances claimed by one card are no longer all instances in the **entire lane**. When the same site is
 * re-entered by k phases, k cards share a lane; claiming by lane would broadcast every instance to every station (each listing all 100).
 * See {@link instancesOfCard}.
 */
export function liveParticipantView(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): LiveParticipantView {
  if (run === undefined) return { graph, instances: {}, participantStatuses: {} };
  const siteOf = new Map(graph.steps.map((step) => [step.id, step.source ?? step.id]));
  const binder = phaseBinder(graph, run);
  const sitesOf = (participant: WorkflowParticipantData) =>
    new Set(participant.steps.map((id) => siteOf.get(id) ?? id));
  const index = runIndex(run);
  /**
   * Instances belonging to this card: actors in the lane that have a node at **one of this card's sites** whose stamp falls in this
   * card's phase. Actors with no node at any of these sites yet (created but not asked, or not yet reached this station) are assigned
   * by **their own birth stamp**. In runs without stamps, `phasesOf` always returns all phases, and these two rules together reproduce
   * today's lane-based behavior, leaving old runs byte-for-byte unchanged.
   *
   * Use the lane index instead of rescanning `run.nodes` for every card; see {@link runIndex}. Sort each lane only once.
   * This preserves the old filter-then-sort order because sorting is stable and filtering preserves order.
   */
  const instancesOfCard = (participant: WorkflowParticipantData, sites: ReadonlySet<string>) => {
    const claimed: WorkflowRunState["actors"][number][] = [];
    for (const actor of index.actorsBySite.get(participant.lane) ?? []) {
      let seen = false;
      let here = false;
      for (const node of index.nodesByActor.get(actorKey(participant.lane, actor.ordinal)) ?? []) {
        if (!sites.has(node.siteId)) continue;
        seen = true;
        if (binder.has(participant.phase, node.phaseName)) {
          here = true;
          break;
        }
      }
      if (here || (!seen && binder.has(participant.phase, actor.phaseName))) claimed.push(actor);
    }
    return claimed;
  };
  const statusFor = (
    participant: WorkflowParticipantData,
    ordinal: number,
    sites: ReadonlySet<string>,
  ): StepRunStatus => {
    const values: StepRunStatus[] = [];
    for (const node of index.nodesByActor.get(actorKey(participant.lane, ordinal)) ?? []) {
      if (!sites.has(node.siteId) || !binder.has(participant.phase, node.phaseName)) continue;
      values.push(statusOfRunNode(node));
    }
    return aggregateRunStatuses(values) ?? "pending";
  };

  const participants: WorkflowParticipantData[] = [];
  const replacements = new Map<string, string[]>();
  const participantStatuses: Record<string, StepRunStatus> = {};
  const instances: Record<string, ParticipantInstance> = {};
  let changed = false;
  for (const participant of graph.participants) {
    const sites = sitesOf(participant);
    const actors = instancesOfCard(participant, sites);
    if (participant.member !== undefined) {
      const actor = actors[participant.member.index];
      participantStatuses[participant.id] =
        actor === undefined ? "pending" : statusFor(participant, actor.ordinal, sites);
      if (actor !== undefined) instances[participant.id] = boundInstance(participant.id, actor);
      participants.push(participant);
      continue;
    }
    if (participant.many !== true && actors.length === 1) {
      instances[participant.id] = boundInstance(participant.id, actors[0]!);
      participants.push(participant);
      continue;
    }
    if (participant.many === true || actors.length > 1) {
      if (actors.length === 0) {
        participants.push(participant);
        continue;
      }
      changed = true;
      const ids: string[] = [];
      for (const actor of actors) {
        const id = instanceCardId(participant.id, actor.ordinal);
        const { many: _many, ...rest } = participant;
        participants.push({ ...rest, id });
        participantStatuses[id] = statusFor(participant, actor.ordinal, sites);
        instances[id] = {
          ordinal: actor.ordinal,
          participant: participant.id,
          ...(actor.name === undefined ? {} : { name: actor.name }),
        };
        ids.push(id);
      }
      replacements.set(participant.id, ids);
      continue;
    }
    participants.push(participant);
  }
  if (!changed) return { graph, instances, participantStatuses };

  const handoffs: WorkflowHandoffData[] = [];
  for (const edge of graph.handoffs) {
    const froms = replacements.get(edge.from) ?? [edge.from];
    const tos = replacements.get(edge.to) ?? [edge.to];
    for (const from of froms) for (const to of tos) handoffs.push({ ...edge, from, to });
  }
  return { graph: { ...graph, handoffs, participants }, instances, participantStatuses };
}

/**
 * Join key parts with `\0`, for the same reason as shared's `workflow-runs-actor-status.ts`: siteId is an arbitrary engine-provided
 * string, and a printable separator such as `-` could collide for ("a-1", 2) and ("a", "1-2").
 */
function actorKey(siteId: string, ordinal: number): string {
  return `${siteId}\0${ordinal}`;
}

interface RunIndex {
  /** `actorKey` to nodes belonging to that instance, preserving `run.nodes` order. */
  nodesByActor: ReadonlyMap<string, WorkflowRunState["nodes"][number][]>;
  /** Lane to its actors, sorted by ascending ordinal (claim order). */
  actorsBySite: ReadonlyMap<string, WorkflowRunState["actors"][number][]>;
}

/**
 * Build the two indexes once per view. Without them, every instance card would rescan `run.nodes` to collect its status: the table limit
 * is 1024 instances × 1024 nodes, or about one million comparisons per frame. With indexes, modeling is linear in actors + nodes.
 *
 * Nodes without actors (world-read) and legacy payloads without ordinals are not indexed: the old filter
 * `node.actorSiteId === lane && node.actorOrdinal === ordinal` always rejected them, so dropping them is equivalent.
 */
function runIndex(run: WorkflowRunState): RunIndex {
  const nodesByActor = new Map<string, WorkflowRunState["nodes"][number][]>();
  for (const node of run.nodes) {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;
    const key = actorKey(node.actorSiteId, node.actorOrdinal);
    const bucket = nodesByActor.get(key);
    if (bucket === undefined) nodesByActor.set(key, [node]);
    else bucket.push(node);
  }
  const actorsBySite = new Map<string, WorkflowRunState["actors"][number][]>();
  for (const actor of run.actors) {
    const bucket = actorsBySite.get(actor.siteId);
    if (bucket === undefined) actorsBySite.set(actor.siteId, [actor]);
    else bucket.push(actor);
  }
  for (const actors of actorsBySite.values()) actors.sort((a, b) => a.ordinal - b.ordinal);
  return { actorsBySite, nodesByActor };
}

function boundInstance(
  participantId: string,
  actor: WorkflowRunState["actors"][number],
): ParticipantInstance {
  return {
    bound: true,
    ordinal: actor.ordinal,
    participant: participantId,
    ...(actor.name === undefined ? {} : { name: actor.name }),
  };
}
