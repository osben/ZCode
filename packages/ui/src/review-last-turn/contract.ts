/**
 * review-last-turn contract (specs/review-last-turn-source.md). The Review pane "Last turn" source reads
 * per-turn file changes owned by the v4 projection; it never writes or caches them as its own truth.
 */
import type { GitPaneDataset } from "@/hooks/useGitRepository.js";

export interface LastTurnGitDataset {
  /** Read-only "last-turn" dataset: one row per file of the latest turn that changed files. */
  dataset: GitPaneDataset;
  /** Source option count: header aggregate until details load, then the listed file count. */
  count: number;
}
