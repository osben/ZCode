import type { WorkflowCausalityGraphData } from "./types.js";

/**
 * The single rendering point for names that take shape only at runtime.
 *
 * The analyzer provides a pattern, not a name: `` agent(`Researcher${i + 1}`) `` cannot become eight concrete names (that would require
 * expanding `map`, while `×N` exists specifically to avoid expansion). Only the literal template prefix/suffix are available.
 * The projection therefore carries only the two affixes; the ellipsis is added **here**, following the same rule as the anonymous fallback label
 * (see the header of lane-name.ts): the projection is a memoized pure function, so copy and glyphs should be formed during rendering and the projection should store only data.
 *
 * The ellipsis (rather than `*` or `${…}`) is intentional: it still reads as a name and introduces no new visual vocabulary.
 */
const ELLIPSIS = "…";

/** Name pattern for a lane/card; the shape comes from the protocol and is not redefined here. */
export type NamePattern = NonNullable<WorkflowCausalityGraphData["lanes"][number]["namePattern"]>;

/**
 * `{head: "Researcher"}` → `Researcher…`, `{tail: "-worker"}` → `…-worker`, both ends → `a…b`.
 *
 * When both affixes are absent, return undefined rather than a lone `…`: the analyzer will not emit this pattern, but `{}` passes `.strict()`;
 * without this fallback, the UI would show a meaningless ellipsis.
 */
export function formatNamePattern(pattern: NamePattern | undefined): string | undefined {
  if (pattern === undefined) return undefined;
  const head = pattern.head ?? "";
  const tail = pattern.tail ?? "";
  if (head === "" && tail === "") return undefined;
  return `${head}${ELLIPSIS}${tail}`;
}
