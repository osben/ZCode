// ============================================================
// Phase-edge folding and reduction - the only phase-layer edge removal point in the display graph
// ============================================================
// Split from create-workflow-graph-bounds.ts: folding is self-contained graph theory (ordered-pair folding, strongly connected
// components, and analyzer reduction on the quotient graph), while the rest of the bounding layer handles referential integrity and
// limits. Keeping this separate makes the logic easier to read and test and leaves room under the bounds file's max-lines limit.

import {
  reduceOrdering,
  type ReducibleEdge,
  // Same reason as in bounds: use the /projections subpath instead of the root barrel, which would bundle the TypeScript compiler in
  // the browser (portfolio replay reuses this path).
} from "@zcode/dynamic-workflow/projections";

/** An edge before folding; its kind has already collapsed to whether it is a back edge. */
export interface RawEdge {
  from: string;
  to: string;
  back: boolean;
}

/**
 * Fold phase edges (handoff edges were reduced by the analyzer using the same algorithm, so they are not handled here):
 *
 * 1. Fold each ordered pair into one edge, preserving first-seen order. `back` is true only when **all** folded edges are back edges.
 *    Any forward fact makes it forward: prefer one extra ordering constraint over losing one. Drop self-loops.
 *
 * 2. Reduce on the **quotient graph**, not the original graph. Find strongly connected components using forward edges (ignore back
 * edges). Keep all edges within a component. Deduplicate cross-component edges by (component pair, kind), then pass them to the
 * analyzer's greedy irreducible reduction (all forward edges share a kind; back edges are carried with `carryOf: "seq"`, reducing it
 * to untyped reduction), then expand surviving component pairs back to original edges. Preserve input order.
 *
 * Reducing the original graph is wrong because a witness path can loop back. If two unrelated if/else blocks reuse the same pair of
 * phase names, the quotient graph can contain ordinary branch edges in both directions between them. Reduction may then infer that
 * choice→A is implied by choice→B→A and remove it, making the diagram falsely claim “the condition always takes B, and A branches
 * from B.” Paths through nodes in the same cycle as their endpoints say nothing about control reaching those nodes; witnesses are valid
 * only on the quotient DAG.
 */
export function foldPhaseEdges(raw: readonly RawEdge[]): RawEdge[] {
  const folded = foldPairs(raw);
  const componentOf = componentsOf(folded);
  const component = (id: string): string => componentOf.get(id) ?? id;
  const keyOf = (from: string, to: string, back: boolean): string => `${from} ${to} ${back}`;

  // Deduplicate cross-component edges by (component pair, kind), preserving first-seen order. Edges within a component never enter
  // reduction: they become self-loops in the quotient graph and say nothing about reachability in the DAG.
  const order: string[] = [];
  const byKey = new Map<string, ReducibleEdge>();
  for (const edge of folded) {
    const from = component(edge.from);
    const to = component(edge.to);
    if (from === to) continue;
    const key = keyOf(from, to, edge.back);
    if (byKey.has(key)) continue;
    order.push(key);
    byKey.set(
      key,
      edge.back ? { carryOf: "seq", from, kind: "carry", to } : { from, kind: "seq", to },
    );
  }
  const condensed = order.map((key) => byKey.get(key) as ReducibleEdge);
  const kept = new Set(
    reduceOrdering(condensed).map((edge) => keyOf(edge.from, edge.to, edge.kind === "carry")),
  );
  return folded.filter((edge) => {
    const from = component(edge.from);
    const to = component(edge.to);
    return from === to || kept.has(keyOf(from, to, edge.back));
  });
}

/** Fold each ordered pair into one edge, preserving first-seen order; `back` is the conjunction across folded edges; drop self-loops. */
function foldPairs(raw: readonly RawEdge[]): RawEdge[] {
  const order: string[] = [];
  const byKey = new Map<string, RawEdge>();
  for (const edge of raw) {
    if (edge.from === edge.to) continue;
    const key = `${edge.from} ${edge.to}`;
    const seen = byKey.get(key);
    if (seen === undefined) {
      order.push(key);
      byKey.set(key, { ...edge });
    } else {
      seen.back = seen.back && edge.back;
    }
  }
  return order.map((key) => byKey.get(key) as RawEdge);
}

/**
 * Map each node to the representative of its strongly connected component (the first node seen in the component). Consider only
 * forward edges: back edges mean “next iteration,” and including them would collapse the entire loop body to one node so genuinely
 * redundant edges inside it could no longer be removed.
 *
 * Use mutual reachability instead of Tarjan: phase graphs are bounded at 32 nodes (`CREATE_WORKFLOW_GRAPH_MAX_PHASES`), so the cost
 * is negligible. “a reaches b and b reaches a” is the component definition itself and needs no extra proof to understand.
 */
function componentsOf(folded: readonly RawEdge[]): Map<string, string> {
  const nodes: string[] = [];
  const seen = new Set<string>();
  const next = new Map<string, string[]>();
  for (const edge of folded) {
    for (const id of [edge.from, edge.to]) {
      if (seen.has(id)) continue;
      seen.add(id);
      nodes.push(id);
    }
    if (edge.back) continue;
    const list = next.get(edge.from);
    if (list === undefined) next.set(edge.from, [edge.to]);
    else list.push(edge.to);
  }

  const reach = new Map<string, Set<string>>();
  for (const start of nodes) {
    const reached = new Set<string>();
    const stack = [...(next.get(start) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (reached.has(node)) continue;
      reached.add(node);
      stack.push(...(next.get(node) ?? []));
    }
    reach.set(start, reached);
  }

  const componentOf = new Map<string, string>();
  for (const node of nodes) {
    if (componentOf.has(node)) continue;
    componentOf.set(node, node);
    for (const other of reach.get(node) ?? []) {
      if (componentOf.has(other)) continue;
      if (reach.get(other)?.has(node) === true) componentOf.set(other, node);
    }
  }
  return componentOf;
}
