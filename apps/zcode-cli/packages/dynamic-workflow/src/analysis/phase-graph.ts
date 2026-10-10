import { UNPHASED_ID } from "./constants.js";
import type { OrderEvent, PhaseInfo } from "./causality-order.js";
import { KIND_RANK, reduceOrdering, type OrderKind } from "./causality-reduce.js";
import type { CausalityGraph, Certainty, OrderEdge, Phase, Step } from "./causality-graph.js";

/**
 * Phase view: the grouping applied by the author's `phase("name")` markers, and its **quotient graph**
 *
 * of the causal graph. The causal graph itself remains untouched; this mechanically transforms
 * the completed graph in two ways:
 *
 *  - **Cross-phase copies**: a step claimed by k>1 phases becomes k copies (`~`-suffixed IDs and
 *    a `source` link, using the same mechanism and separator as may-set lane copies), ensuring a
 *    complete partition where every step belongs to exactly one phase;
 *  - **Quotient graph**: project reduced step edges onto phase pairs according to claim relations,
 *    deduplicate them, and apply the same
 *    {@link reduceOrdering}。
 *
 * With no markers, this is an identity function: all three fields are absent and existing snapshots
 * remain byte-for-byte unchanged. This is a contract, not an optimization; the UI switches views
 * based on whether the phase vocabulary is present.
 *
 * This has its own module instead of living in causality-graph.ts: that file is already at its
 * max-lines limit, and phases are a view layered on top of it, just as the causal graph is layered
 * on top of the site graph.
 */

/** Copy ID separator, shared with may-set lane copies (combined expansions look like `ask#2~actor#1~phase#2`). */
const COPY_SEPARATOR = "~";

/** Claim relations: which phase owns each site and how certain the claim is. All keys are **site IDs**. */
interface PhaseClaims {
  /** Site -> phases claiming it, deduplicated in issue order. */
  bySite: Map<string, string[]>;
  /** `${site}|${phase}` -> claim certainty within that phase. */
  certainty: Map<string, Certainty>;
  /** Phase -> clock position of the first member issue; sort key for quotient-graph facts. */
  position: Map<string, number>;
  /** `${site}|${phase}` -> first/last issue positions for this site in the phase (temporal feasibility checks). */
  firstIssue: Map<string, number>;
  lastIssue: Map<string, number>;
}

/** Quotient-graph input: reduced step edges (sink edges removed), with certainty inherited from endpoints. */
export interface PhaseSourceFact {
  from: string;
  to: string;
  kind: OrderKind;
  certainty: Certainty;
  /** Underlying kind before a carry edge is retyped; carry minimization uses it to judge witness strength. */
  carryOf?: Exclude<OrderKind, "carry">;
  /**
   * Set of phases containing the issue events that witness this fact (present only on seq facts
   * produced by await barriers; see `Fact.toPhases` in causality-graph.ts). Narrow the head with
   * {@link headPhasesOf}.
   */
  toPhases?: ReadonlySet<string>;
}

/**
 * Phases in which an edge's head may land: **intersect when provenance is available; otherwise expand fully**.
 *
 * Copy rewriting and quotient projection must use the same rule, or `phaseEdges` and the step
 * edges shown when drilling down would tell different stories. This is why both consumers share
 * this function.
 *
 * In practice, the intersection equals `toPhases` (the witness phase of a barrier fact must be a
 * claimed phase of the head site). Writing the intersection explicitly ensures upstream changes
 * that discard/narrow phases cannot attach an edge to a nonexistent phase.
 */
function headPhasesOf(claiming: readonly string[], toPhases: ReadonlySet<string> | undefined): string[] {
  if (toPhases === undefined) return [...claiming];
  const narrowed = claiming.filter((phase) => toPhases.has(phase));
  return narrowed.length > 0 ? narrowed : [...claiming];
}

/**
 * Read claim relations from issue events. An issue is the identity point of a step, so this pass
 * contains all ownership logic.
 *
 * Derive certainty independently for each (site, phase): within that phase, **at least one** issue
 * must be region-chain-certain, and the step must not be the target of a control edge. This mirrors
 * `certaintyOf` in causality-graph.ts, replacing "all issues" with "issues in this phase." When a
 * shared helper is copied into preflight (top level) and gate (inside a loop and branch), the two
 * copies can therefore have different certainty, which is why copies need independent derivation.
 */
export function collectPhaseClaims(
  events: readonly OrderEvent[],
  steps: ReadonlySet<string>,
  certainChain: (chain: readonly string[]) => boolean,
  controlled: ReadonlySet<string>,
): PhaseClaims {
  const bySite = new Map<string, string[]>();
  const position = new Map<string, number>();
  const firstIssue = new Map<string, number>();
  const lastIssue = new Map<string, number>();
  const certainSeen = new Set<string>();
  // Use the same clock as causality-graph.ts: advance once per issue event, whether or not it is a graph step.
  let clock = 0;
  for (const event of events) {
    if (event.at !== "issue") continue;
    const at = clock;
    clock += 1;
    if (!steps.has(event.step)) continue;
    const claiming = bySite.get(event.step);
    if (claiming === undefined) bySite.set(event.step, [event.phase]);
    else if (!claiming.includes(event.phase)) claiming.push(event.phase);
    if (!position.has(event.phase)) position.set(event.phase, at);
    const key = `${event.step}|${event.phase}`;
    if (!firstIssue.has(key)) firstIssue.set(key, at);
    lastIssue.set(key, at);
    if (certainChain(event.regions)) certainSeen.add(key);
  }

  const certainty = new Map<string, Certainty>();
  for (const [site, claiming] of bySite) {
    for (const phase of claiming) {
      const key = `${site}|${phase}`;
      certainty.set(key, certainSeen.has(key) && !controlled.has(site) ? "always" : "maybe");
    }
  }
  return { bySite, certainty, firstIssue, lastIssue, position };
}

/**
 * Add the phase vocabulary to a completed causal graph: copies, `Step.phase`, the phase table, and phase edges.
 *
 * Run **after** `expandMaySetLanes` (claim each lane copy separately). Like that function, this
 * mechanically rewrites the completed graph without recomputing the existing steps, lanes,
 * regions, or step edges.
 */
export function projectPhaseGraph(
  graph: CausalityGraph,
  phases: readonly PhaseInfo[],
  claims: PhaseClaims,
  facts: readonly PhaseSourceFact[],
  sharesIteration: (a: string, b: string) => boolean,
): CausalityGraph {
  if (phases.length === 0) return graph; // No markers -> no vocabulary; graph remains byte-for-byte unchanged.

  const claimsOf = (siteId: string): string[] => claims.bySite.get(siteId) ?? [UNPHASED_ID];
  const certaintyOfClaim = (siteId: string, phase: string): Certainty =>
    claims.certainty.get(`${siteId}|${phase}`) ?? "maybe";

  /**
   * Temporal feasibility: whether an edge a→b can land on the copy pair (a@P, b@Q).
   *
   * Each phase copy **occupies a position in time**, the key difference from may-set lane copies:
   * lane copies are adjacent at the same rank, so full expansion asserts no order; full phase
   * expansion would assert false order (for example, gate's bench settle before preflight's bench
   * issue). The issue positions for each (site, phase) are available from the walk. A permitted
   * order is allowed; an impossible order is not.
   *
   * Two alternatives, joined by OR:
   *  - **Position**: at least one issue of b in Q occurs after the first issue of a in P;
   *  - **Repetition**: the sites share a closed iteration region. This is **required**: the producer
   *    in iteration k feeds the copy in iteration k+1, which is positionally "after" and realizable
   *    (the reduce-accumulator lesson). Removing this would erase all cross-phase loop-carried data,
   *    inventing concurrency in the only forbidden direction.
   *
   * Share `sharesIteration` with `realizableCarry` in causality-graph.ts: both ask the same question
   * about the same relation, and must not answer it independently.
   */
  const admits = (from: string, fromPhase: string, to: string, toPhase: string): boolean => {
    const firstFrom = claims.firstIssue.get(`${from}|${fromPhase}`);
    const lastTo = claims.lastIssue.get(`${to}|${toPhase}`);
    if (firstFrom === undefined || lastTo === undefined) return true; // No positions to compare: do not reject.
    return lastTo > firstFrom || sharesIteration(from, to);
  };
  /**
   * Edge kinds constrained by temporal feasibility. `carry` is excluded because `realizableCarry`
   * already checks its feasibility, and carry itself asserts "next iteration," making positional
   * comparison meaningless. `fifo` is excluded because lane rules already decide it, and copies
   * of the same site share a lane and are genuinely FIFO-ordered.
   */
  const ADMITTED_KINDS = new Set<OrderKind>(["data", "control", "seq"]);

  // --- 1. Cross-phase copies -------------------------------------------------------
  // Copies are **both-run, not candidates**; do not change them to maybe by analogy with may-set
  // copies. The site is actually issued by both callers (the shared helper runs once in preflight
  // and once in gate), so both copies execute. Each copy's certainty reflects only the certainty
  // of its own phase's claim, not "one or the other."
  //
  // `region` and `repeat` are **site-level facts** (from the site's first issue), intentionally not
  // recomputed per phase. Copies mechanically rewrite the completed graph; recomputing region
  // ownership would require a separate region tree for each phase, which is a different decision.
  // Thus gate's bench copy carries the `region` and `stack` from preflight's first issue; do not
  // "fix" this without a decision.
  const copiesOf = new Map<string, (Step & { phase: string })[]>();
  for (const step of graph.steps) {
    const siteId = step.source ?? step.id;
    const claiming = claimsOf(siteId);
    if (claiming.length < 2) continue;
    copiesOf.set(
      step.id,
      claiming.map((phase) => ({
        ...step,
        certainty: weakest([step.certainty, certaintyOfClaim(siteId, phase)]),
        id: `${step.id}${COPY_SEPARATOR}${phase}`,
        phase,
        // `source` is the site ID reported by the runtime; set it **only once** because lane copies already carry it.
        source: siteId,
      })),
    );
  }

  const steps: Step[] = graph.steps.flatMap((step) => {
    const copies = copiesOf.get(step.id);
    if (copies !== undefined) return copies;
    // k = 1: the claim is unique, so this phase's certainty is identical to the step's (all issues
    // belong to this phase); no override is needed.
    return [{ ...step, phase: claimsOf(step.source ?? step.id)[0] as string }];
  });

  // --- 2. Edge rewriting: mirror expandMaySetLanes ---------------------------------
  const stepById = new Map(graph.steps.map((step) => [step.id, step]));
  const siteOf = (id: string): string => {
    const step = stepById.get(id);
    return step === undefined ? id : (step.source ?? step.id);
  };
  // Fact provenance is indexed by **site pairs** (facts predate both kinds of copies, with one
  // fact per ordered pair), so lane-copy edges are first mapped back to site pairs for lookup.
  const provenance = new Map<string, ReadonlySet<string>>();
  for (const fact of facts) {
    if (fact.toPhases !== undefined) provenance.set(`${fact.from}|${fact.to}`, fact.toPhases);
  }

  const endpointsOf = (
    id: string,
    toPhases?: ReadonlySet<string>,
  ): { certainty: Certainty; id: string; lane?: string; phase: string }[] => {
    const copies = copiesOf.get(id);
    if (copies !== undefined) {
      const heads = new Set(headPhasesOf(claimsOf(siteOf(id)), toPhases));
      return copies
        .filter((copy) => heads.has(copy.phase))
        .map((copy) => ({
          certainty: copy.certainty,
          id: copy.id,
          lane: copy.lane,
          phase: copy.phase,
        }));
    }
    const step = stepById.get(id);
    return [
      {
        certainty: step?.certainty ?? "maybe",
        id,
        lane: step?.lane,
        phase: claimsOf(siteOf(id))[0] as string,
      },
    ];
  };

  const edges: OrderEdge[] = [];
  for (const edge of graph.edges) {
    // Neither endpoint is a copy -> preserve as-is. This early return also guarantees byte-for-byte
    // identity with no markers: single-endpoint pairs never pass through any rules below.
    if (!copiesOf.has(edge.from) && !copiesOf.has(edge.to)) {
      edges.push(edge);
      continue;
    }
    const fromSite = siteOf(edge.from);
    const toSite = siteOf(edge.to);
    // Do not narrow the tail by provenance (settle events have no phase), but the **tail is also
    // constrained by temporal feasibility**; this removes the spurious tail edge where a copy is
    // placed before the ask that produced its own argument.
    const pairs: { certainty: Certainty; from: string; to: string }[] = [];
    const admitted: typeof pairs = [];
    for (const tail of endpointsOf(edge.from)) {
      for (const head of endpointsOf(edge.to, provenance.get(`${fromSite}|${toSite}`))) {
        // Match fifo by lane, using the same rule as lane expansion. Phase copies of one site share
        // a lane, so fifo edges between them survive, correctly: the site's two issues are FIFO-ordered.
        if (edge.kind === "fifo" && tail.lane !== head.lane) continue;
        // A copy can point to itself only when the original edge was already a self-edge (copies of
        // different sites cannot share an ID). This documents an invariant; the branch is not reached by the corpus.
        if (tail.id === head.id && edge.from !== edge.to) continue;
        const pair = {
          certainty: weakest([edge.certainty, tail.certainty, head.certainty]),
          from: tail.id,
          to: head.id,
        };
        pairs.push(pair);
        if (!ADMITTED_KINDS.has(edge.kind) || admits(fromSite, tail.phase, toSite, head.phase)) {
          admitted.push(pair);
        }
      }
    }
    // If all candidates are rejected, fall back to full expansion, matching {@link headPhasesOf}:
    // a real ordering that is infeasible everywhere means the position check misled us, and silently
    // deleting a real ordering would invent concurrency.
    for (const pair of admitted.length > 0 ? admitted : pairs) {
      edges.push({ ...edge, ...pair });
    }
  }

  // --- 3. Phase table: nonempty phases, with unphased first -------------------------
  const members = new Set<string>(steps.map((step) => step.phase as string));
  const phaseList: Phase[] = [];
  if (members.has(UNPHASED_ID)) phaseList.push({ id: UNPHASED_ID });
  for (const phase of phases) {
    // Drop phases with no members (may-set narrowing may remove every step from a phase); an empty node has no home to reference.
    if (!members.has(phase.id)) continue;
    phaseList.push({ id: phase.id, loc: phase.loc, name: phase.name });
  }
  const live = new Set(phaseList.map((phase) => phase.id));

  // --- 4. Quotient graph: compute from claim relations, independent of materialized copies ---
  const quotient: PhaseSourceFact[] = [];
  for (const fact of facts) {
    // Match copy rewriting exactly: narrow the head ({@link headPhasesOf}) and check temporal
    // feasibility ({@link admits}), applying only when at least one endpoint is copied. The two
    // consumers must tell the same story: `phaseEdges` and the drilled-down step edges must agree.
    const tails = claimsOf(fact.from);
    const heads = headPhasesOf(claimsOf(fact.to), fact.toPhases);
    const copied = tails.length > 1 || claimsOf(fact.to).length > 1;
    const gated = copied && ADMITTED_KINDS.has(fact.kind);
    const pairs: { from: string; to: string }[] = [];
    const admitted: typeof pairs = [];
    for (const from of tails) {
      for (const to of heads) {
        pairs.push({ from, to });
        if (!gated || admits(fact.from, from, fact.to, to)) admitted.push({ from, to });
      }
    }
    for (const { from, to } of admitted.length > 0 ? admitted : pairs) {
      if (!live.has(from) || !live.has(to)) continue;
      // Do not draw within-phase ordering; a within-phase carry means the loop stays entirely in
      // one phase, so retain it as a self-loop.
      if (from === to && fact.kind !== "carry") continue;
      quotient.push({
        certainty: fact.certainty,
        from,
        kind: fact.kind,
        to,
        ...(fact.carryOf === undefined ? {} : { carryOf: fact.carryOf }),
      });
    }
  }

  const position = (id: string): number => claims.position.get(id) ?? 0;
  const deduped = dedupePhaseFacts(quotient).sort(
    (a, b) =>
      position(a.from) - position(b.from) ||
      position(a.to) - position(b.to) ||
      a.kind.localeCompare(b.kind),
  );
  // Phase edges do not carry `exact`: it witnesses taint on data edges and is undefined on the quotient.
  const phaseEdges: OrderEdge[] = reduceOrdering(deduped).map((fact) => ({
    certainty: fact.certainty,
    from: fact.from,
    kind: fact.kind,
    to: fact.to,
  }));

  const sink = graph.sink;
  return {
    edges,
    lanes: graph.lanes,
    phaseEdges,
    phases: phaseList,
    regions: graph.regions,
    steps,
    // Do not draw phase-level sink edges (the UI derives them from the fedBy step's phase), but fedBy itself must follow copies.
    ...(sink === undefined
      ? {}
      : { sink: { fedBy: sink.fedBy.flatMap((id) => endpointsOf(id).map((end) => end.id)) } }),
  };
}

/**
 * Keep one fact per ordered phase pair: use the strongest kind ({@link KIND_RANK}) and let maybe
 * win certainty. This **mirrors step-level `dedupeFacts` exactly**, prioritizing consistency ("any
 * always witness means always" is semantically more accurate in the quotient).
 */
function dedupePhaseFacts(facts: readonly PhaseSourceFact[]): PhaseSourceFact[] {
  const byPair = new Map<string, PhaseSourceFact>();
  for (const fact of facts) {
    const key = `${fact.from}|${fact.to}`;
    const existing = byPair.get(key);
    if (existing === undefined) {
      byPair.set(key, { ...fact });
      continue;
    }
    if (KIND_RANK[fact.kind] > KIND_RANK[existing.kind]) existing.kind = fact.kind;
    if (existing.carryOf === undefined && fact.carryOf !== undefined) existing.carryOf = fact.carryOf;
    if (fact.certainty === "maybe") existing.certainty = "maybe";
  }
  return [...byPair.values()];
}

function weakest(values: readonly Certainty[]): Certainty {
  return values.includes("maybe") ? "maybe" : "always";
}
