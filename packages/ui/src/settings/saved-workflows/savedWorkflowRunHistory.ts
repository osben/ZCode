// Grouping and presentation for run history.
// Associate only when `dwf_run.name === workflow name`; do not guess which workflow a run with a different model-generated name belongs to.
import type { ZCodeSavedWorkflowRun, ZCodeSavedWorkflowRunStatus } from "@zcode/shared";

/** Newest row by `updatedAt` per name (the server sorts by time_updated descending, so take only the first occurrence). */
export function lastRunByWorkflowName(
  runs: readonly ZCodeSavedWorkflowRun[],
): Map<string, ZCodeSavedWorkflowRun> {
  const byName = new Map<string, ZCodeSavedWorkflowRun>();
  const sorted = [...runs].sort((left, right) => right.updatedAt - left.updatedAt);
  for (const run of sorted) {
    if (run.name === undefined || byName.has(run.name)) continue;
    byName.set(run.name, run);
  }
  return byName;
}

type SavedWorkflowRunBadgeKind = "completed" | "errored" | "running" | "stopped" | "never";

/**
 * Four states for the card's "Last run" badge + "Never run." pending and running share the active appearance.
 * Terminal states are errored / stopped; older CLI versions may still send
 * `failed` / `cancelled`, so fold them into the same semantics instead of omitting the badge.
 */
export function savedWorkflowRunBadgeKind(
  status: ZCodeSavedWorkflowRunStatus | "errored" | "stopped" | "failed" | "cancelled" | undefined,
): SavedWorkflowRunBadgeKind {
  switch (status) {
    case undefined:
      return "never";
    case "pending":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "errored":
    case "failed":
      return "errored";
    case "stopped":
    case "cancelled":
      return "stopped";
  }
}

/** Argument chip in a run-history row: `key=value`, with the value compacted as JSON. */
export function formatSavedWorkflowRunArgs(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  return Object.entries(args).map(
    ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
}

/** Duration of one run in milliseconds; use now for non-terminal states. */
export function savedWorkflowRunDurationMs(run: ZCodeSavedWorkflowRun, now: number): number {
  const end = run.status === "pending" || run.status === "running" ? now : run.updatedAt;
  return Math.max(0, end - run.createdAt);
}

export function formatSavedWorkflowTokens(spent: number): string {
  if (!Number.isFinite(spent)) return "—";
  if (spent >= 1_000_000) return `${(spent / 1_000_000).toFixed(1)}M`;
  if (spent >= 1_000) return `${(spent / 1_000).toFixed(1)}k`;
  return String(Math.round(spent));
}
