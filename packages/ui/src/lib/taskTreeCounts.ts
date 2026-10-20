import type { ZCodeTaskTreeCounts } from "@zcode/services";

type TreeCountsIntl = {
  formatPlural(descriptor: { id: string }, count: number): string;
  formatMessage(descriptor: { id: string }, values?: Record<string, string | number>): string;
};

/**
 * Lists the children an erase or hide takes with its parents, e.g. "2 side chats, 3 subagents".
 * Returns null when there is nothing beyond the sessions themselves (specs/session-deletion-cascade.md §2).
 */
export function describeTreeChildren(
  intl: TreeCountsIntl,
  counts: Pick<ZCodeTaskTreeCounts, "sideChats" | "subagents" | "workflowSessions">,
): string | null {
  const parts: string[] = [];
  if (counts.sideChats > 0) {
    parts.push(intl.formatPlural({ id: "taskList.childSideChatsCount" }, counts.sideChats));
  }
  if (counts.subagents > 0) {
    parts.push(intl.formatPlural({ id: "taskList.childSubagentsCount" }, counts.subagents));
  }
  if (counts.workflowSessions > 0) {
    parts.push(
      intl.formatPlural({ id: "sessionManager.delete.workflowSessions" }, counts.workflowSessions),
    );
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Sums per-workspace counts; null as soon as one workspace could not be counted (unsupported or failed). */
export function sumTreeCounts(
  all: ReadonlyArray<ZCodeTaskTreeCounts | null>,
): ZCodeTaskTreeCounts | null {
  const total: ZCodeTaskTreeCounts = {
    total: 0,
    sideChats: 0,
    subagents: 0,
    workflowSessions: 0,
    workflowRuns: 0,
    running: 0,
  };
  for (const counts of all) {
    if (!counts) return null;
    for (const key of Object.keys(total) as Array<keyof ZCodeTaskTreeCounts>) {
      total[key] += counts[key];
    }
  }
  return total;
}

/**
 * Appends the child-sessions sentence to a hide-confirmation body: the exact list when counts are known,
 * the generic "may also include" sentence when they are unavailable (remote workspace, older CLI,
 * failure), nothing when the sessions have no children.
 */
export function appendTreeChildrenCopy(
  intl: TreeCountsIntl,
  body: string,
  counts: ZCodeTaskTreeCounts | null,
): string {
  const children = counts ? describeTreeChildren(intl, counts) : null;
  const extra = counts
    ? children
      ? intl.formatMessage({ id: "sessionManager.delete.includes" }, { items: children })
      : null
    : intl.formatMessage({ id: "sessionManager.delete.includesGeneric" });
  return extra ? `${body}\n\n${extra}` : body;
}
