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
