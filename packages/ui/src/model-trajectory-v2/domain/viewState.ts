import type { LedgerRow } from "./ledger.js";
import type { TimeDomain } from "./timeScale.js";

/** Per-device preferences; never setting.json (fork-unsafe storage rule). */
export const TRAJECTORY_V2_VIEW_STORAGE_KEY = "zcode.modelTrajectoryV2.view.v1";

export interface TrajectoryV2Prefs {
  chartsCollapsed: boolean;
  showSidecars: boolean;
}

export const DEFAULT_TRAJECTORY_V2_PREFS: TrajectoryV2Prefs = {
  chartsCollapsed: false,
  showSidecars: false,
};

/** Defensive parse: unknown fields are dropped and invalid values fall back to defaults. */
export function parseTrajectoryV2Prefs(raw: string | null): TrajectoryV2Prefs {
  if (!raw) return DEFAULT_TRAJECTORY_V2_PREFS;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof TrajectoryV2Prefs, unknown>>;
    return {
      chartsCollapsed:
        typeof value.chartsCollapsed === "boolean"
          ? value.chartsCollapsed
          : DEFAULT_TRAJECTORY_V2_PREFS.chartsCollapsed,
      showSidecars:
        typeof value.showSidecars === "boolean"
          ? value.showSidecars
          : DEFAULT_TRAJECTORY_V2_PREFS.showSidecars,
    };
  } catch {
    return DEFAULT_TRAJECTORY_V2_PREFS;
  }
}

/** Keep the selection when its row still exists after new data; otherwise clear it. */
export function reconcileSelection(
  selectedKey: string | null,
  rows: readonly LedgerRow[],
): string | null {
  if (!selectedKey) return null;
  return rows.some((row) => row.key === selectedKey) ? selectedKey : null;
}

/** Keep a range across refresh, clamped to the data extent; null when it no longer overlaps. */
export function reconcileRange(
  range: TimeDomain | null,
  extent: TimeDomain | null,
): TimeDomain | null {
  if (!range || !extent) return null;
  const from = Math.max(range.from, extent.from);
  const to = Math.min(range.to, extent.to);
  return to > from ? { from, to } : null;
}

/** Next selectable row key for keyboard navigation; turn headers are skipped. */
export function stepSelection(
  rows: readonly LedgerRow[],
  selectedKey: string | null,
  direction: 1 | -1,
): string | null {
  const selectable = rows.filter((row) => row.kind !== "turn");
  if (selectable.length === 0) return null;
  const index = selectable.findIndex((row) => row.key === selectedKey);
  if (index === -1)
    return (direction === 1 ? selectable[0] : selectable[selectable.length - 1])!.key;
  const next = Math.min(selectable.length - 1, Math.max(0, index + direction));
  return selectable[next]!.key;
}
