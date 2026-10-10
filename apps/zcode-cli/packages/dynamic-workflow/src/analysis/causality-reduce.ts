/**
 * Type-aware transitive reduction over the happens-before relation. With one arrow
 * style on screen, reduction carries the whole burden of keeping the picture readable —
 * and it must stay TYPED even though rendering is not. A uniform reduction over the
 * untyped relation deletes the wrong arrows: in `planner-reviewer`, `scan → judge` is
 * the genuine data dependency and the incidental ordering path
 * `scan → plan → review → judge` transitively implies it, so a uniform pass would keep
 * the incidental chain and drop the meaningful edge.
 *
 * Precedence: `data` = `control` > `fifo` > `seq`.
 *
 * Fix history
 *
 * 1. Forward-edge deletion now checks each edge against the SURVIVING set. The old implementation deleted edges in one batch against the ORIGINAL
 * relation, then monotonically restored edges whose witness paths had themselves been deleted. Restoring an edge could create witnesses for other removed
 * edges, but no later pass removed those edges, so cyclic inputs accumulated a severely over-restored edge set (observed symptom: in a jsonl-db optimization
 * loop, 55 of 66 forward edges were implied by other edges). Phase 1's "one step per site" rule causes shared helpers (called before and after a loop)
 * to produce forward edges in both directions; cycles are normal rather than exceptional, so reduction must remain minimal on cyclic graphs. Checking each
 * edge against the surviving set removes the need for restoration: every removed edge has a surviving witness at deletion time, and later deletions do not
 * invalidate earlier deletions—the witness for a later-deleted edge can substitute into the earlier witness. Allowed kinds shrink monotonically
 * (seq ⊇ fifo ⊇ data=control), so substitution never weakens the witness. On DAGs, behavior matches the only valid typed transitive reduction edge by edge;
 * only graphs with residual cycles change.
 *
 * 2. Added carry-edge reduction (the old rule "never remove carry" is obsolete). A carry edge asserts A@k → B@k+1, and the composition
 * "forward path within round k → exactly one carry edge → forward path within round k+1" asserts the same fact, so a carry edge with such a witness is
 * redundant (an eight-step loop once produced 19 back edges, while the forward chain plus one back edge fully described it). Compare strength by hop:
 * every witness hop (a carry hop uses its underlying kind, the original forward kind before conversion) must be at least as strong as the removed carry's
 * underlying kind. Exactly one carry hop is required; two hops assert k → k+2 and are strictly weaker. As in the forward pass, check each edge against
 * the surviving set so two mutually witnessing back edges are never both removed—the cycle remains closed.
 */

export type OrderKind = "data" | "control" | "fifo" | "seq" | "carry";

/**
 * Dedup precedence when several facts hold for one ordered pair — the same kind lattice
 * {@link JUSTIFIED_BY} reads, in the shape a dedup needs. Lives here rather than beside
 * either consumer because the step-level dedup and the phase quotient's must agree by
 * construction.
 */
export const KIND_RANK: Record<OrderKind, number> = {
  carry: 0,
  control: 4,
  data: 3,
  fifo: 2,
  seq: 1,
};


export interface ReducibleEdge {
  from: string;
  to: string;
  kind: OrderKind;
  /**
   * Underlying kind of a `carry` edge: the forward kind the back edge had before being converted to carry. Carry reduction uses it
   * to decide how strong a witness must be. If absent, treat it as hard (data)—prefer retaining an extra back edge over deleting a data fact.
   */
  carryOf?: Exclude<OrderKind, "carry">;
}

/** Kinds a justifying path may consist of, per the kind of the edge under test. */
const JUSTIFIED_BY: Partial<Record<OrderKind, ReadonlySet<OrderKind>>> = {
  // A hard dependency yields only to a path of hard dependencies. `data` and `control`
  // are both non-removable — no refactoring can make a consumer precede its producer,
  // or a guarded step precede its guard — so either one justifies either one. What this
  // does NOT yield to is `seq`/`fifo`: those are incidental serialization the reader is
  // meant to be able to delete mentally, and the constraint must survive that deletion.
  // This is what kills the phantom producer→sink edges the actor projection emitted
  // through relays, and what keeps `scan → judge` alive against the incidental
  // `scan → plan → review → judge`.
  //
  // Bug: `data` originally yielded to `data` alone, which kept every data fact that a
  // control edge already implied. In a refine-until-approved loop that is most of the
  // picture — `initial plan → revision` reads as a second arrow on top of
  // `initial plan → initial review → (guards) → revision`, saying nothing the chain
  // did not. Ordering-redundant arrows are pure ink here, because the renderer draws
  // every kind identically; a data edge earns its place only by asserting an order no
  // hard path already asserts.
  control: new Set<OrderKind>(["data", "control"]),
  data: new Set<OrderKind>(["data", "control"]),
  // FIFO yields to a real dependency or to another FIFO hop (a same-actor chain
  // already implies its own transitive closure), but never to bare serialization.
  // For example, `assess → refine → wrap up` already implies `assess → wrap up`.
  fifo: new Set<OrderKind>(["data", "control", "fifo"]),
  // Pure serialization yields to any ordering at all.
  seq: new Set<OrderKind>(["data", "control", "fifo", "seq"]),
};

/** Underlying kind of a carry edge; if absent, treat as hard (see {@link ReducibleEdge.carryOf}). */
const underlyingOf = (edge: ReducibleEdge): Exclude<OrderKind, "carry"> =>
  edge.carryOf ?? "data";

/**
 * Drop edges a strong-enough path of surviving edges already implies — forward edges
 * first (each decided against the surviving set, in input order), then `carry` edges
 * against the surviving result (one forward leg, exactly one carry hop, one forward
 * leg). Deterministic given input order; on a DAG the forward phase is the unique
 * typed transitive reduction, and on residual cycles (one step issued from several
 * call sites) both phases stay sound — every drop has a surviving witness — and
 * irredundant.
 */
export function reduceOrdering<E extends ReducibleEdge>(edges: readonly E[]): E[] {
  const dropped = new Set<E>();
  const forward = edges.filter((edge) => edge.kind !== "carry");
  const carries = edges.filter((edge) => edge.kind === "carry");

  const outgoing = new Map<string, E[]>();
  for (const edge of forward) {
    const list = outgoing.get(edge.from);
    if (list === undefined) outgoing.set(edge.from, [edge]);
    else list.push(edge);
  }

  /**
   * Is `to` reachable from `from` over surviving `allowed`-kind forward edges without
   * using any direct `from → to` hop? Any such path has length ≥ 2, which is exactly
   * the reduction condition. Cycle-safe: the visited set bounds the walk.
   *
   * Deliberately certainty-BLIND. A certainty-aware variant (an unconditional ordering
   * may only yield to an unconditional path) is strictly sounder per-execution, and was
   * tried: it restores an edge from every ancestor of the returned artifact in 30 corpus
   * fixtures, because a path through any conditional step stops justifying anything.
   * That is precisely the phantom producer→sink noise the design exists to remove, and
   * the reader is not doing per-execution case analysis — they read a chain as a chain.
   * Certainty stays a model-only property of the surviving edges.
   */
  const reaches = (from: string, to: string, allowed: ReadonlySet<OrderKind>): boolean => {
    const seen = new Set<string>([from]);
    const stack: string[] = [];
    for (const edge of outgoing.get(from) ?? []) {
      if (edge.to === to || !allowed.has(edge.kind) || dropped.has(edge)) continue;
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        stack.push(edge.to);
      }
    }
    while (stack.length > 0) {
      const node = stack.pop() as string;
      for (const edge of outgoing.get(node) ?? []) {
        if (!allowed.has(edge.kind) || dropped.has(edge)) continue;
        if (edge.to === to) return true;
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          stack.push(edge.to);
        }
      }
    }
    return false;
  };

  for (const edge of forward) {
    const allowed = JUSTIFIED_BY[edge.kind];
    if (allowed === undefined) continue; // defensive: `carry` is already filtered out
    if (edge.from === edge.to) continue;
    if (reaches(edge.from, edge.to, allowed)) dropped.add(edge);
  }

  const carryOutgoing = new Map<string, E[]>();
  for (const edge of carries) {
    const list = carryOutgoing.get(edge.from);
    if (list === undefined) carryOutgoing.set(edge.from, [edge]);
    else list.push(edge);
  }

  /**
   * Does a surviving composition `forward* → one carry hop → forward*` (every hop of
   * an `allowed` kind, the carry hop judged by its underlying kind) connect `from` to
   * `to` without using `candidate` itself? Two-state walk: state 1 is "the carry hop
   * is spent". Parallel edges cannot occur (facts are deduped per ordered pair before
   * back-edge typing), so any witness found here has length ≥ 2 by construction.
   */
  const carryWitness = (candidate: E, allowed: ReadonlySet<OrderKind>): boolean => {
    const seen = new Set<string>([`${candidate.from} 0`]);
    const stack: [string, 0 | 1][] = [[candidate.from, 0]];
    while (stack.length > 0) {
      const [node, spent] = stack.pop() as [string, 0 | 1];
      const push = (next: string, state: 0 | 1): boolean => {
        if (state === 1 && next === candidate.to) return true;
        const key = `${next} ${state}`;
        if (!seen.has(key)) {
          seen.add(key);
          stack.push([next, state]);
        }
        return false;
      };
      for (const edge of outgoing.get(node) ?? []) {
        if (!allowed.has(edge.kind) || dropped.has(edge)) continue;
        if (push(edge.to, spent)) return true;
      }
      if (spent === 1) continue;
      for (const edge of carryOutgoing.get(node) ?? []) {
        if (edge === candidate || dropped.has(edge) || !allowed.has(underlyingOf(edge))) continue;
        if (push(edge.to, 1)) return true;
      }
    }
    return false;
  };

  for (const edge of carries) {
    const allowed = JUSTIFIED_BY[underlyingOf(edge)];
    if (allowed === undefined) continue;
    if (carryWitness(edge, allowed)) dropped.add(edge);
  }

  return edges.filter((edge) => !dropped.has(edge));
}
