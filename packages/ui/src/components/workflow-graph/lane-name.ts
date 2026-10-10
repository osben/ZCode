import { laneClassOf, type LaneClass, type WorkflowLaneData } from "./types.js";
import { formatNamePattern, type NamePattern } from "./name-pattern.js";

/**
 * The single policy point for lane display names.
 *
 * A station ID (`actor#3`) is **identity**: a journal key, an anchor in hover titles, and a handle for investigating issues.
 * A display name is **presentation**. If they are conflated, the UI shows a lane named "actor#3"—using the key as the name.
 * Names come from only two sources: a name written in the script (shown as-is; localizing it would change the author's words),
 * or a localized fallback when analysis cannot retrieve a name.
 *
 * Why the fallback must be applied at render time: the projection (flow-elements.ts) is a memoized pure function, independent of language.
 * Baking localized copy into the projection would leave stale text when users switch languages (workspace/unresolved lanes have always
 * been localized at render time for this reason). The projection therefore carries data only; copy is produced here.
 */

/**
 * All inputs needed to determine a lane's display name, excluding id: id is identity and never participates in naming.
 * Both `LaneHead` and candidate lane references (`LaneRef`) have this shape, so both call sites share one policy.
 */
export interface LaneNaming {
  laneClass: LaneClass;
  /** Name given in the script by `agent("planner")`; absent when analysis cannot retrieve a literal. */
  name?: string;
  /**
   * Literal text around a name interpolation (`` agent(`researcher${i + 1}`) ``). It follows `name`
   * and precedes the anonymous fallback: it conveys more than "Unnamed agent" without presenting a word the author wrote as-is.
   */
  namePattern?: NamePattern;
  /** 1-based index when multiple anonymous agent lanes coexist in a graph; absent when there is only one. */
  anonymousIndex?: number;
}

/**
 * Minimal shape of `IntlInstance["formatMessage"]`. The helper needs only this function and does not touch React,
 * so the policy itself can be unit tested with a fake formatter.
 */
export type LaneNameFormatter = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/** Identify synthetic lanes by class rather than name: they describe what runs here and have fixed copy. */
const NAME_ID_BY_CLASS: Partial<Record<LaneClass, string>> = {
  unresolved: "chat.toolCall.workflow.graph.lane.unresolved",
  workspace: "chat.toolCall.workflow.graph.lane.script",
};

export function laneDisplayName(lane: LaneNaming, formatMessage: LaneNameFormatter): string {
  const classNameId = NAME_ID_BY_CLASS[lane.laneClass];
  if (classNameId !== undefined) return formatMessage({ id: classNameId });
  // Show the author's exact words; localizing them would change what the author wrote.
  if (lane.name !== undefined) return lane.name;
  // An interpolated name is still in the author's words, so do not localize it; only add an ellipsis.
  const patterned = formatNamePattern(lane.namePattern);
  if (patterned !== undefined) return patterned;
  // Show an index only when needed to distinguish lanes: for one anonymous lane, the "1" in "Unnamed agent 1" conveys nothing.
  return lane.anonymousIndex === undefined
    ? formatMessage({ id: "chat.toolCall.workflow.graph.lane.anonymous" })
    : formatMessage(
        { id: "chat.toolCall.workflow.graph.lane.anonymousIndexed" },
        { index: lane.anonymousIndex },
      );
}

/**
 * Reference to one lane: identity (`id`) plus all material needed to form its display name. **Never a preformatted display string**—
 * the anonymous fallback copy is created by `laneDisplayName` at render time; see the file header.
 */
export interface LaneRef extends LaneNaming {
  id: string;
}

/**
 * Assign 1-based indices in lane order to "unnamed agent lanes" only when two or more coexist:
 * when a graph has one anonymous lane, the "1" in "Unnamed agent 1" distinguishes nothing and is noise.
 *
 * **A lane with a pattern counts as named** and is excluded from this count: showing "researcher…" plus an anonymous index
 * would make the index disagree with the number of visibly anonymous lanes. Two identical patterns can still collide, just as two lanes
 * literally named `"worker"` can; this helper does not add another disambiguation rule.
 *
 * Counting is language-independent, so it belongs in this layer and can be tested on its own; the copy is formed at render time.
 */
function anonymousLaneIndexes(lanes: readonly WorkflowLaneData[]): Map<string, number> {
  const anonymous = lanes.filter(
    (lane) =>
      lane.name === undefined &&
      formatNamePattern(lane.namePattern) === undefined &&
      laneClassOf(lane.id) === "agent",
  );
  if (anonymous.length < 2) return new Map();
  return new Map(anonymous.map((lane, index) => [lane.id, index + 1]));
}

/**
 * Lane ID to naming material (not a display string).
 *
 * Shared by three consumers: the graph roster, candidate lanes in step cards, and the instance selector for transcript drill-down.
 * **They must use the same source**: the anonymous index is the lane's position among anonymous lanes in the graph. Computing it separately
 * will eventually disagree, so the selector may show "Unnamed agent 2" while the graph shows "Unnamed agent 1".
 *
 * It lives here rather than in the projection layer (flow-elements.ts) so consumers that do not render a graph (drill-down parsing is pure)
 * do not need to pull React Flow in just to access naming material. Callers provide `{id, laneClass}` as a fallback for lane IDs missing
 * from the graph, so future changes such as station specialization do not break drill-down.
 */
export function laneRefsById(lanes: readonly WorkflowLaneData[]): Map<string, LaneRef> {
  const anonymousIndexes = anonymousLaneIndexes(lanes);
  return new Map(
    lanes.map((lane) => {
      const anonymousIndex = anonymousIndexes.get(lane.id);
      return [
        lane.id,
        {
          id: lane.id,
          laneClass: laneClassOf(lane.id),
          ...(lane.name === undefined ? {} : { name: lane.name }),
          ...(lane.namePattern === undefined ? {} : { namePattern: lane.namePattern }),
          ...(anonymousIndex === undefined ? {} : { anonymousIndex }),
        },
      ];
    }),
  );
}
