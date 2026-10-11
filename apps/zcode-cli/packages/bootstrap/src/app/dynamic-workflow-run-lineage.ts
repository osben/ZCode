// ============================================================
// Lineage read surface for Dynamic Workflow Runs (a small part of the observation surface).
// ============================================================
// The two pointers at either end of the revision chain: `resumedFrom` points to the predecessor,
// and `supersededBy` points to the successor that stopped this run. Snapshots, lists, and detail
// views all need both keys, so define the rule once here.
// Split from dynamic-workflow-run-observation.ts because that file reached oxlint's 400-line limit.

import type { RunStatus } from "@zcode/dynamic-workflow";

/** Terminal view with only the two lineage keys; both a registry entry's `terminal` and a journal row satisfy it. */
interface SupersedableSettlement {
  status: RunStatus;
  supersededBy?: string;
}

/**
 * Successor pointer: prefer in-memory terminal state, then the journal row. It is meaningful only
 * for stopped(superseded); treat it as absent for other states even if the payload contains it (which
 * should not happen), so a completed run is not shown as superseded.
 */
export function supersededByOf(
  entry: { terminal?: SupersedableSettlement } | undefined,
  record: { status?: RunStatus; supersededBy?: string } | undefined,
): string | undefined {
  if (entry?.terminal !== undefined) {
    return entry.terminal.status === "stopped" ? entry.terminal.supersededBy : undefined;
  }
  return record?.status === "stopped" ? record.supersededBy : undefined;
}

/** Emit only when both pointers are present (absence means there is no endpoint, while `undefined` would add a noisy key to every row). */
export function lineageFields(
  resumedFrom: string | undefined,
  supersededBy: string | undefined,
): { resumedFrom?: string; supersededBy?: string } {
  return {
    ...(resumedFrom === undefined ? {} : { resumedFrom }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
  };
}
