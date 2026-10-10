import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";

/**
 * Cache the result from `timeline-model.ts`; build it once for each (graph, run) pair.
 *
 * Why **object identity** is a sound key: both inputs are immutable protocol objects—the graph is the validated `causalityGraph`
 * in a row's display payload and the run is an entry in the `workflowRuns` projection. Projection reduction and key-level
 * updates use shallow reconstruction (changed entries get new objects, unchanged elements keep their references), so "same object"
 * means "same content", and any content change necessarily creates a new object. The cache cannot return a stale model.
 *
 * Why not use local `useMemo`: the run card and details page may render the same run in one frame, but separate useMemo calls
 * recognize only their own instances and build it twice (each can take tens of milliseconds at the board limit). A two-level WeakMap
 * (run, then graph) makes the second use a lookup. Keys are weak references, so when a projection frame creates new run objects,
 * entries from the previous frame can be collected and the map does not grow.
 */
const BY_RUN = new WeakMap<object, WeakMap<object, unknown>>();

/** Static graphs without a run (confirmation dialog, compile feedback card) use the same map, with a module-level sentinel for the run key. */
const NO_RUN: object = {};

export function sharedTimelineModel<Model>(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
  build: () => Model,
): Model {
  const runKey: object = run ?? NO_RUN;
  let byGraph = BY_RUN.get(runKey);
  if (byGraph === undefined) {
    byGraph = new WeakMap<object, unknown>();
    BY_RUN.set(runKey, byGraph);
  }
  // Use `has` instead of `get() !== undefined`: the model is always an object, but the check should not depend on that.
  if (byGraph.has(graph)) return byGraph.get(graph) as Model;
  const model = build();
  byGraph.set(graph, model);
  return model;
}
