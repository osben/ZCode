import { createContext } from "react";
import type { TrajectoryVisualRole } from "@/ModelTrajectoryRoleStyles.js";

export interface TrajectoryExpansionCommand {
  expanded: boolean;
  version: number;
}

export type TrajectoryExpansionCommands = Record<TrajectoryVisualRole, TrajectoryExpansionCommand>;

export const TRAJECTORY_EXPANSION_KINDS: readonly TrajectoryVisualRole[] = [
  "system",
  "user",
  "reasoning",
  "assistant",
  "tool-call",
  "tool-result",
];

export function createTrajectoryExpansionCommands(): TrajectoryExpansionCommands {
  return Object.fromEntries(
    TRAJECTORY_EXPANSION_KINDS.map((kind) => [kind, { expanded: true, version: 0 }]),
  ) as TrajectoryExpansionCommands;
}

export const TrajectoryExpansionCommandContext = createContext<TrajectoryExpansionCommands | null>(
  null,
);

export interface TrajectoryExpansionOverride {
  open: boolean;
  commandVersion: number;
}

/**
 * Input rows above this count start collapsed. The first page of a card is mounted regardless of its state;
 * a card with at most this many input rows keeps the all-expanded default.
 */
export const TRAJECTORY_COLLAPSED_BY_DEFAULT_ROWS = 40;

/** Number of input rows mounted per page of a call card; "show next" adds one page. */
export const TRAJECTORY_ROW_PAGE_SIZE = 40;

/** Input rows mounted on each side of a search-revealed row that lies past the page. */
export const TRAJECTORY_REVEAL_RADIUS = 10;

export interface TrajectoryInputRowWindow {
  /** Rows [0, pageEnd) are mounted: the card's single per-card limit. */
  pageEnd: number;
  /** Rows [revealStart, revealEnd) are mounted around a search reveal; empty when not windowed. */
  revealStart: number;
  revealEnd: number;
  /** Rows between the page and the reveal window (or after the page when not windowed). */
  hiddenBefore: number;
  /** Rows after the reveal window (or after the page when not windowed). */
  hiddenAfter: number;
  windowed: boolean;
}

/**
 * Derive which input rows a card mounts. The reveal window is render-only: it never changes the per-card limit,
 * so a hit at row 900 mounts the page plus 21 rows, not 901 rows.
 */
export function resolveInputRowWindow({
  total,
  limit,
  revealIndex,
}: {
  total: number;
  limit: number;
  revealIndex?: number;
}): TrajectoryInputRowWindow {
  const pageEnd = Math.min(total, Math.max(0, limit));
  const windowed = revealIndex !== undefined && revealIndex >= pageEnd && revealIndex < total;
  if (!windowed) {
    return {
      pageEnd,
      revealStart: pageEnd,
      revealEnd: pageEnd,
      hiddenBefore: 0,
      hiddenAfter: total - pageEnd,
      windowed: false,
    };
  }
  const revealStart = Math.max(pageEnd, revealIndex - TRAJECTORY_REVEAL_RADIUS);
  const revealEnd = Math.min(total, revealIndex + TRAJECTORY_REVEAL_RADIUS + 1);
  return {
    pageEnd,
    revealStart,
    revealEnd,
    hiddenBefore: revealStart - pageEnd,
    hiddenAfter: total - revealEnd,
    windowed: true,
  };
}

export interface TrajectoryExpansionRegistry {
  overrides: ReadonlyMap<string, TrajectoryExpansionOverride>;
  setOverride: (key: string, override: TrajectoryExpansionOverride) => void;
  /** Number of input rows mounted per call card, keyed by the card's stable key. */
  rowLimits: ReadonlyMap<string, number>;
  setRowLimit: (key: string, limit: number) => void;
}

export const TrajectoryExpansionRegistryContext = createContext<TrajectoryExpansionRegistry | null>(
  null,
);
