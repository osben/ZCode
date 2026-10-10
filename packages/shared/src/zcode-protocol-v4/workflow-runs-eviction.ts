// ============================================================
// Make room when the table is full: who can leave, when entries can take a slot, and how evicted entries remain countable
// ============================================================
// Eviction rules are pure functions with no clock or I/O. Phase-based counting of unlisted entries is maintained by workflow-runs-unlisted.ts.
//
// Why make room. The old behavior at the limit was **reject new entries**, while the read view shows “which subagents are running now” — so after a wide
// fan-out run exceeded 1024, no newly created subagent could enter, and the run card and phase roster stayed stuck on the earliest
// **already completed** entries, removing the reason this feature exists. Eviction reverses that: terminal entries make room.
//
// Evicting only terminal entries is not enough: a phase may emit **all** actor-created and **all** node-queued events in its first few seconds,
// filling both tables with the first 1024 still-queued entries before any one terminates; the remaining 976 actors and nodes are rejected.
// The scheduler then dispatches FIFO, leaving every **running** subagent from the 1025th onward outside the table. A subagent becomes important when it is **dispatched**,
// not when it is queued — so `node-dispatched` is also an opportunity to take a slot (activation below).
//
// Table priority, highest to lowest, follows what a subagent is doing **right now**: **running** (a node is dispatched /
// executing / waiting / repairing / nudged) > **idle** (none are running but some are queued: waiting for a slot) > **completed** (all settled).
// Three invariants constrain eviction, each with a visible consequence:
//   1. Running entries never leave — they are exactly what must remain visible;
//   2. An actor never outlives its last **listed** node: actor status is derived from its nodes
//      (workflow-runs-actor-status.ts), and an actor without nodes derives as waiting, appearing as a pending badge that never moves.
//      Therefore evict a whole group (actor + all its nodes), and do not list a completed actor whose node cannot fit (orphan rule);
//   3. Evicted entries **remain countable**: in addition to the two run-level counters (workflow-runs-caps.ts),
//      count by **birth phase** (workflow-runs-unlisted.ts) — the read view is drawn by phase.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunState,
} from "./workflow-runs.js";
import { addToUnlistedBucket, withUnlistedBuckets } from "./workflow-runs-unlisted.js";

/**
 * Three entry-capacity limits used by reduction, defaulting to {@link WORKFLOW_RUNS_LIMITS}.
 * Eviction and counting rules apply to the limits supplied by the caller.
 */
export interface WorkflowRunEntryLimits {
  readonly maxActors: number;
  readonly maxNodes: number;
  readonly maxPhases: number;
}

interface InstanceRef {
  siteId: string;
  ordinal: number;
}

/** Candidate victim: two keys for within-class sorting plus its index in the table. */
interface Candidate {
  index: number;
  phaseName: string | undefined;
  failed: boolean;
}

/** One **non-live group**: an actor plus all its listed nodes (by index), and its category. */
interface Group extends Candidate {
  nodeIndexes: number[];
  /** All owned nodes have settled: this subagent has finished its work. */
  finished: boolean;
  /** None are running but some are queued: this subagent is waiting for a slot and has not started work. */
  idle: boolean;
  /** No listed nodes owned by this actor: it has not been asked yet, or its settlement was a cache hit without an actor. */
  zeroNode: boolean;
}

/** Increment for one evicted subagent in its bucket (`phaseName` is its **birth** phase). */
interface EvictedAgent {
  phaseName: string | undefined;
  actors: number;
  actorsSettled?: number;
  actorsFailed?: number;
}

/** Slot-admission result for one node event. */
export interface WorkflowNodeSeating {
  /** Run after making room (possibly evicting multiple entries) and placing the actor. */
  run: WorkflowRunState;
  /** Whether this instance may enter the node table (false = reject as before; caller counts it as rejected). */
  admitNew: boolean;
  /** This admission returned an **unlisted** instance to the node table (caller decrements nodesUnlisted). */
  activated: boolean;
}

function sameInstance(left: InstanceRef, right: InstanceRef): boolean {
  return left.siteId === right.siteId && left.ordinal === right.ordinal;
}

function isFailed(node: WorkflowRunNode): boolean {
  return node.outcome === "failed" || node.outcome === "cancelled";
}

/**
 * May this event add a **new key** to the table — and, correspondingly, add a step to `nodesUsed`?
 *
 * **Restrict only runs that have overflowed (`truncated`)**; `live` represents the stricter condition (a birth
 * event that advances the high-water mark, or activation below). Below the limit, always admit, exactly as before the eviction change.
 *
 * Why restrict: eviction is the first operation that makes the table **shrink**, so a newly freed slot could bring back an instance already counted in
 * `nodesUnlisted` (a replayed event or an intermediate phase that arrives after queued was rejected), making the instance both listed and counted and falsifying the total.
 *
 * Why not apply it to all runs: reduction **still applies** events below the high-water mark (it just will not lower the mark), and
 * CLI cold materialization feeds journal replay and live events through the same reducer. If a live event starts a run first,
 * its entire journal prefix is below the high-water mark — restricting every run would leave that run's card empty. Both gaps require
 * a prior rejection or eviction, represented by `truncated`, so gating on it leaves every under-limit path unchanged.
 */
export function admitsNewEntry(run: WorkflowRunState, live: boolean): boolean {
  return run.truncated !== true || live;
}

/**
 * Make room in the actor table for an **active newcomer** by evicting a completed group. If the table is not full, the newcomer is already listed, or there is
 * no completed group, return the original run (the caller then upserts as usual; a full table still rejects new entries).
 *
 * Birth events can displace only **completed** groups: a newcomer still queued has no reason to displace another queued actor — neither has started work,
 * and either row conveys the same lack of information. Idle groups yield only to activation (actual work starting).
 */
export function withRoomForActor(
  run: WorkflowRunState,
  ref: InstanceRef,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunState {
  if (run.actors.length < limits.maxActors) return run;
  if (run.actors.some((actor) => sameInstance(actor, ref))) return run;
  const victim = pickVictim(listedGroups(run).filter((group) => group.finished));
  return victim === undefined ? run : evictGroup(run, victim, limits);
}

/**
 * Admission for one node event: the only entry point for eviction, B2 rejection, and dispatch with birth facts (activation).
 *
 * The main reducer can therefore pass the event through unchanged without deciding “should this be admitted?” — the predicate has three branches,
 * each with a reason that exists only after overflow.
 */
export function seatWorkflowNode(
  run: WorkflowRunState,
  seat: {
    eventType: string;
    ref: InstanceRef;
    actorRef: InstanceRef | null;
    /** Present only on `node-dispatched` with birth facts: actor entry created from those facts. */
    actor: WorkflowRunActor | null;
    /** Whether this event is the instance's birth event (`node-queued` or cache-hit `node-settled`). */
    born: boolean;
    advancesWaterMark: boolean;
  },
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowNodeSeating {
  const byBirth = admitsNewEntry(run, seat.born && seat.advancesWaterMark);
  if (!seat.advancesWaterMark) return { run, admitNew: byBirth, activated: false };
  // Replayed events neither evict nor take a slot: both branches below require advancing the high-water mark.
  if (seat.eventType === "node-dispatched" && seat.actor !== null && run.truncated === true) {
    return activateInstance(run, seat.ref, seat.actor, limits);
  }
  if (seat.eventType !== "node-queued") return { run, admitNew: byBirth, activated: false };
  // B2: in an overflowed run, a queued node with no recognizable owner should not take a slot — it cannot render a badge (pills are filtered by
  // run.actors), and later dispatched work needs that slot. Unowned nodes (world-read) are not subject to this rule.
  if (
    run.truncated === true &&
    seat.actorRef !== null &&
    !run.actors.some((actor) => sameInstance(actor, seat.actorRef!))
  ) {
    return { run, admitNew: false, activated: false };
  }
  return {
    run: withRoomForNode(run, seat.ref, seat.actorRef, limits),
    admitNew: byBirth,
    activated: false,
  };
}

/**
 * Make room in a full node table for an **active newcomer**: first evict a settled unowned node (world-read belongs to no group,
 * so eviction removes only one row); if none exists, evict a completed group. Return the original run if no slot can be freed.
 *
 * `owner` is the actor that owns the new node. **Its own group is never a victim**: when a subagent doing its fourth ask hits a full table,
 * its first three asks appear completed; evicting that group would remove this **currently dispatched** subagent from the actor table,
 * leaving the new node pointing to a missing actor and rendering no badge. A group that just received work is not completed by definition.
 */
function withRoomForNode(
  run: WorkflowRunState,
  ref: InstanceRef,
  owner: InstanceRef | null,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  if (run.nodes.length < limits.maxNodes) return run;
  if (run.nodes.some((node) => sameInstance(node, ref))) return run;
  const loose = pickVictim(looseSettledNodes(run));
  if (loose !== undefined) return evictSingleNode(run, loose, limits);
  const victim = pickVictim(spareGroups(run, owner).filter((group) => group.finished));
  return victim === undefined ? run : evictGroup(run, victim, limits);
}

/**
 * **Dispatch means admission.** A `node-dispatched` event with birth facts (the engine resends the same facts carried by this instance's
 * `node-queued` and its subagent's `actor-created` at dispatch time) returns an unlisted instance to the node table,
 * and returns its subagent to the actor table when needed.
 *
 * Make room in this order: actor slot, then node slot; each step checks its own table. Evicting a **group** for an actor slot also frees
 * at least one node row, while evicting a **zero-node** actor frees none — so the second step must still recheck the table size.
 * If no slot can be made, reject the whole admission (the earlier eviction is discarded and the original run is returned), **do not** add only the node —
 * a node pointing to an unlisted actor is exactly what this rule is meant to eliminate.
 */
function activateInstance(
  run: WorkflowRunState,
  ref: InstanceRef,
  actor: WorkflowRunActor,
  limits: WorkflowRunEntryLimits,
): WorkflowNodeSeating {
  const nodeListed = run.nodes.some((node) => sameInstance(node, ref));
  const actorListed = run.actors.some((listed) => sameInstance(listed, actor));
  if (nodeListed && actorListed) return { run, admitNew: true, activated: false };
  let next = run;
  if (!actorListed && next.actors.length >= limits.maxActors) {
    const victim = pickGroupVictim(next, null, true);
    if (victim === undefined) return { run, admitNew: false, activated: false };
    next = evictGroup(next, victim, limits);
  }
  if (!nodeListed && next.nodes.length >= limits.maxNodes) {
    // Priority: oldest settled node owned by this actor > settled unowned node > another group's node. Drop its own history first,
    // because that removes only one row and leaves the actor in the table (its badge remains); a subagent gives up its own row before taking another's.
    // Without this rule, a subagent doing k asks could be blocked from the table by its **own** completed work: those nodes are not an evictable group
    // (its group cannot be a victim) but still occupy slots.
    const own = ownSettledNodes(next, actor)[0];
    if (own !== undefined) next = evictSingleNode(next, own, limits);
    else {
      const loose = pickVictim(looseSettledNodes(next));
      if (loose !== undefined) next = evictSingleNode(next, loose, limits);
      else {
        // A zero-node actor cannot help here (this branch needs a node slot, not an actor slot), so it cannot be a victim.
        const victim = pickGroupVictim(next, actor, false);
        if (victim === undefined) return { run, admitNew: false, activated: false };
        next = evictGroup(next, victim, limits);
      }
    }
  }
  if (!actorListed) {
    // Decrement the subagent's bucket when it returns to the table (workflow-runs-unlisted.ts): it is no longer unlisted.
    next = withUnlistedBuckets(
      { ...next, actors: [...next.actors, actor] },
      addToUnlistedBucket(next.unlistedByPhase, actor.phaseName, { actors: -1 }, limits.maxPhases),
    );
  }
  return { run: next, admitNew: true, activated: !nodeListed };
}

/**
 * A **rejected** `actor-created`: there is no run-level actor counter, so its only trace is its bucket.
 * This bucket can later increase or decrease — it represents the number of subagents currently unlisted, not a historical total.
 */
export function absorbRefusedActor(
  run: WorkflowRunState,
  phaseName: string | undefined,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunState {
  return withUnlistedBuckets(
    run,
    addToUnlistedBucket(run.unlistedByPhase, phaseName, { actors: 1 }, limits.maxPhases),
  );
}

/**
 * A node **settled at birth** is rejected from the table (cache-hit `node-settled`, which is itself the birth event):
 * count it in its birth-phase bucket and remove its actor too under the orphan rule, since the actor has no listed nodes.
 *
 * If the actor is already unlisted, count **only** the node bucket: that subagent was already counted as `actors` in **its own** birth-phase bucket,
 * and the node's phase stamp may differ; moreover, a subagent with two cache-hit nodes would otherwise count twice as “completed.”
 * When attribution is uncertain, omit it — the subagent remains unlisted and the read view counts it as pending until it returns to the table.
 * Do not increment the two run-level counters here — that is `countUnlistedInstance`'s job, and doing it in both places would double count.
 */
export function absorbRefusedSettledNode(
  run: WorkflowRunState,
  node: WorkflowRunNode,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunState {
  let buckets = addToUnlistedBucket(
    run.unlistedByPhase,
    node.phaseName,
    { settled: 1 },
    limits.maxPhases,
  );
  const owner =
    node.actorSiteId === undefined || node.actorOrdinal === undefined
      ? null
      : { siteId: node.actorSiteId, ordinal: node.actorOrdinal };
  const index = owner === null ? -1 : run.actors.findIndex((actor) => sameInstance(actor, owner));
  const actor = index < 0 ? undefined : run.actors[index]!;
  const orphan = actor !== undefined && !ownsListedNode(run, actor);
  if (orphan) {
    // The orphan can be attributed and counted only once: this actor is in the table, and carries its own birth phase.
    buckets = addToUnlistedBucket(
      buckets,
      actor.phaseName,
      { actors: 1, actorsSettled: 1, actorsFailed: isFailed(node) ? 1 : 0 },
      limits.maxPhases,
    );
  }
  return withUnlistedBuckets(
    orphan ? { ...run, actors: run.actors.filter((_, position) => position !== index) } : run,
    buckets,
  );
}

/**
 * The two tables for a new incarnation. **An overflowed run restarts with empty tables**: re-arming replays the entire script prefix, and only empty tables
 * ensure every instance in this incarnation is either listed or counted exactly once. Keeping a table with prior omissions would count some entries twice — an evicted instance in the prefix
 * was already added to `nodesUnlisted` and would return to the table on replay.
 *
 * Preserve non-overflowed runs exactly as they are (even object references): ordinary resume must not erase history.
 */
export function workflowRunTablesForNewLife(run: WorkflowRunState): {
  actors: WorkflowRunActor[];
  nodes: WorkflowRunNode[];
} {
  if (run.truncated !== true) return { actors: run.actors, nodes: run.nodes };
  return { actors: [], nodes: [] };
}

/**
 * Group victim for an activation: completed group > idle group > zero-node actor. Always exclude the `owner` group.
 *
 * Only the **actor-slot** branch passes `allowZeroNode = true`: removing a zero-node actor frees one actor slot but no node slots;
 * using it to free a node slot would make the caller think it created room when the node still cannot enter.
 */
function pickGroupVictim(
  run: WorkflowRunState,
  owner: InstanceRef | null,
  allowZeroNode: boolean,
): Group | undefined {
  const groups = spareGroups(run, owner);
  return (
    pickVictim(groups.filter((group) => group.finished)) ??
    // Choose the **last** idle group in table order: with FIFO dispatch, the most recently created one is dispatched last, so its slot is least urgent.
    groups.filter((group) => group.idle).at(-1) ??
    // Similarly choose the last zero-node actor, and only as a last resort: it has no nodes, score, or table history,
    // so readers see no loss when it is evicted, and it returns with its facts when next dispatched. Without this tier, a wide fan-out after
    // resume can deadlock — empty tables restart, the prefix recreates 2,000 actors, cache-hit settlements omit actors,
    // leaving a table full of zero-node actors that nobody can evict; every later dispatch is rejected.
    (allowZeroNode ? groups.filter((group) => group.zeroNode).at(-1) : undefined)
  );
}

function spareGroups(run: WorkflowRunState, owner: InstanceRef | null): Group[] {
  const groups = listedGroups(run);
  if (owner === null) return groups;
  return groups.filter((group) => !sameInstance(run.actors[group.index]!, owner));
}

/**
 * Within-class ordering: evict non-failed entries first (failures are the only completed facts readers may want to revisit), then choose the phase with the most candidates
 * (spend the limit where entries are crowded), then choose the earliest in table order. This is pure, so cold replay evicts the same set.
 */
function pickVictim<T extends Candidate>(candidates: readonly T[]): T | undefined {
  if (candidates.length === 0) return undefined;
  const unfailed = candidates.filter((candidate) => !candidate.failed);
  const pool = unfailed.length > 0 ? unfailed : candidates;
  const crowd = new Map<string, number>();
  // Phase names cannot be empty (schema min(1)), so the empty string is a safe key for the unphased bucket.
  for (const candidate of pool) {
    const key = candidate.phaseName ?? "";
    crowd.set(key, (crowd.get(key) ?? 0) + 1);
  }
  let best = pool[0]!;
  let bestCrowd = crowd.get(best.phaseName ?? "") ?? 0;
  for (const candidate of pool) {
    const size = crowd.get(candidate.phaseName ?? "") ?? 0;
    // Replace only when **strictly** more crowded, so ties keep the earliest candidate in table order.
    if (size > bestCrowd) {
      best = candidate;
      bestCrowd = size;
    }
  }
  return best;
}

/**
 * All **non-live** groups in the table, in actor-table order. A group must have at least one listed node — an actor not yet assigned work
 * is not a candidate (its `node-queued` event may still be in transit).
 *
 * Two categories based on what the subagent is doing **right now**: no queued nodes means its work is finished;
 * any queued node means it is idle, waiting for a slot — other settled asks do not change that. A subagent doing three asks, with the first complete and the next queued,
 * is the latter. If it were classified as “all nodes are queued,” it would become a group that is neither live nor evictable, allowing a table full of such groups to block active newcomers,
 * exactly the symptom this rule removes (engine-shaped event streams showed each run losing 2–4 active subagents).
 */
function listedGroups(run: WorkflowRunState): Group[] {
  const owned = new Map<
    string,
    { nodeIndexes: number[]; live: boolean; queued: boolean; failed: boolean }
  >();
  run.nodes.forEach((node, index) => {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) return;
    const key = instanceKey({ siteId: node.actorSiteId, ordinal: node.actorOrdinal });
    const bucket = owned.get(key) ?? { nodeIndexes: [], live: false, queued: false, failed: false };
    bucket.nodeIndexes.push(index);
    if (node.phase === "queued") bucket.queued = true;
    else if (node.phase !== "settled") bucket.live = true;
    if (isFailed(node)) bucket.failed = true;
    owned.set(key, bucket);
  });
  const groups: Group[] = [];
  run.actors.forEach((actor, index) => {
    const bucket = owned.get(instanceKey(actor));
    if (bucket?.live === true) return;
    groups.push({
      index,
      phaseName: actor.phaseName,
      failed: bucket?.failed ?? false,
      nodeIndexes: bucket?.nodeIndexes ?? [],
      finished: bucket !== undefined && !bucket.queued,
      idle: bucket?.queued === true,
      // No listed nodes: only the actor-slot branch of activation treats it as a victim (see pickGroupVictim);
      // both birth paths accept only `finished`, so this tier does not change any under-limit behavior.
      zeroNode: bucket === undefined,
    });
  });
  return groups;
}

/** Unowned node: a listed node with no actor (world-read). Only settled nodes are candidates. */
function looseSettledNodes(run: WorkflowRunState): Candidate[] {
  const candidates: Candidate[] = [];
  run.nodes.forEach((node, index) => {
    if (node.actorSiteId !== undefined || node.phase !== "settled") return;
    candidates.push({ index, phaseName: node.phaseName, failed: isFailed(node) });
  });
  return candidates;
}

/**
 * Settled nodes owned by the newcomer **itself**, in table order (earliest = oldest ask).
 *
 * Does not use {@link pickVictim}: selection here is not “which one is the best victim?” but “which history is oldest?” — the oldest is least likely to be revisited by readers.
 * The whole group still cannot be a victim; this removes a row, not a person.
 */
function ownSettledNodes(run: WorkflowRunState, owner: InstanceRef): Candidate[] {
  const candidates: Candidate[] = [];
  run.nodes.forEach((node, index) => {
    if (node.actorSiteId !== owner.siteId || node.actorOrdinal !== owner.ordinal) return;
    if (node.phase !== "settled") return;
    candidates.push({ index, phaseName: node.phaseName, failed: isFailed(node) });
  });
  return candidates;
}

function ownsListedNode(run: WorkflowRunState, actor: WorkflowRunActor): boolean {
  return run.nodes.some(
    (node) => node.actorSiteId === actor.siteId && node.actorOrdinal === actor.ordinal,
  );
}

function instanceKey(ref: InstanceRef): string {
  return `${ref.siteId}\0${ref.ordinal}`;
}

/** Remove a whole group: the actor and all its nodes leave both tables in **one** reduction, preserving the order of other entries. */
function evictGroup(
  run: WorkflowRunState,
  group: Group,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  const actor = run.actors[group.index]!;
  const dropped = new Set(group.nodeIndexes);
  const evicted = group.nodeIndexes.map((index) => run.nodes[index]!);
  // Evicting a completed group carries the fact “this subagent has finished”; an idle group only makes room, and its work has not started yet.
  // It will return to the table when dispatched (activation), so do not count it in actorsSettled.
  return {
    ...withUnlistedEvictions(
      run,
      evicted,
      {
        phaseName: actor.phaseName,
        actors: 1,
        ...(group.finished ? { actorsSettled: 1, actorsFailed: group.failed ? 1 : 0 } : {}),
      },
      limits,
    ),
    actors: run.actors.filter((_, index) => index !== group.index),
    nodes: run.nodes.filter((_, index) => !dropped.has(index)),
    truncated: true,
  };
}

/**
 * Remove one node row: either a settled unowned node or the newcomer's oldest settled node.
 *
 * Both paths use the same accounting because neither changes the **actor** count: no actor leaves, so record only the three node counts
 * (two run-level counters + `settled` in this node's birth-phase bucket).
 */
function evictSingleNode(
  run: WorkflowRunState,
  candidate: Candidate,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  const node = run.nodes[candidate.index]!;
  return {
    ...withUnlistedEvictions(run, [node], undefined, limits),
    nodes: run.nodes.filter((_, index) => index !== candidate.index),
    truncated: true,
  };
}

/**
 * Record evicted entries in the two run-level counters and their respective birth-phase buckets.
 *
 * Increment `nodesUnlisted` for **all** evicted nodes, and `nodesUnlistedSettled` only for those already **settled**:
 * an evicted idle group contains queued nodes that have not settled; counting them would inflate completion.
 */
function withUnlistedEvictions(
  run: WorkflowRunState,
  nodes: readonly WorkflowRunNode[],
  agent: EvictedAgent | undefined,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  let buckets = run.unlistedByPhase;
  if (agent !== undefined) {
    const { phaseName, ...delta } = agent;
    buckets = addToUnlistedBucket(buckets, phaseName, delta, limits.maxPhases);
  }
  let settledCount = 0;
  for (const node of nodes) {
    if (node.phase !== "settled") continue;
    settledCount += 1;
    buckets = addToUnlistedBucket(buckets, node.phaseName, { settled: 1 }, limits.maxPhases);
  }
  const settledTotal = (run.usage.nodesUnlistedSettled ?? 0) + settledCount;
  return withUnlistedBuckets(
    {
      ...run,
      usage: {
        ...run.usage,
        nodesUnlisted: (run.usage.nodesUnlisted ?? 0) + nodes.length,
        // Omit the entire key when zero (same convention as workflow-runs-caps.ts).
        ...(settledTotal > 0 ? { nodesUnlistedSettled: settledTotal } : {}),
      },
    },
    buckets,
  );
}
