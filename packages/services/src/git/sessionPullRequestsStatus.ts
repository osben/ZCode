import type { SessionPullRequest, SessionPullRequestStatus } from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { sortSessionPullRequests } from "./sessionPullRequestMapping.js";

// Pure status helpers for the session pull request service (specs/sidebar-pr-status.md).

export function unavailableStatus(
  unavailableReason: "no_gh" | "auth" | "not_github" | "error",
): SessionPullRequestStatus {
  return {
    state: "unavailable",
    unavailableReason,
    source: "branch",
    pullRequests: [],
    primaryNumber: null,
    fetchedAt: null,
    stale: false,
  };
}

/** The branch-entry fields the task-level assembly reads. */
export interface BranchStatusEntry {
  state: "ready" | "unavailable" | "rate_limited";
  unavailableReason: "no_gh" | "auth" | "not_github" | "error" | null;
  pullRequests: SessionPullRequest[];
  fetchedAtMs: number;
  stale: boolean;
}

// Combines the cached branch entries of one task into its status.
export function assembleBranchStatus(
  entries: readonly BranchStatusEntry[],
  servingStaleDueToRateLimit: boolean,
): SessionPullRequestStatus {
  const pullRequests = sortSessionPullRequests(entries.flatMap((entry) => entry.pullRequests));
  const primary = pullRequests[0] ?? null;
  const anyReady = entries.some((entry) => entry.state === "ready");
  // Reason: a ready branch can sit beside a branch with no data yet; the partial result must
  // not present itself as a complete fresh answer.
  const partial = anyReady && entries.some((entry) => entry.state !== "ready");
  const stale =
    entries.some((entry) => entry.stale) ||
    partial ||
    (servingStaleDueToRateLimit && pullRequests.length > 0);
  const fetchedAtMs =
    entries.length > 0 ? Math.max(...entries.map((entry) => entry.fetchedAtMs)) : 0;
  // A branch set with no entry at all means "never fetched": rate_limited
  // while backoff blocks the refresh, otherwise a plain empty ready state.
  let state: SessionPullRequestStatus["state"] = "ready";
  if (entries.length === 0) {
    state = servingStaleDueToRateLimit ? "rate_limited" : "ready";
  } else if (!anyReady) {
    state = entries.every((entry) => entry.state === "rate_limited")
      ? "rate_limited"
      : "unavailable";
  }
  return {
    state,
    unavailableReason:
      state === "unavailable"
        ? (entries.find((entry) => entry.unavailableReason !== null)?.unavailableReason ?? "error")
        : null,
    source: "branch",
    pullRequests,
    primaryNumber: primary?.number ?? null,
    fetchedAt: fetchedAtMs > 0 ? new Date(fetchedAtMs).toISOString() : null,
    stale,
  };
}

// Logs only the stage transition: workspace paths, remote identities, repositories, and PR numbers
// stay out of logs.
export function logStageChanges(
  logger: ServiceLogger,
  previous: SessionPullRequest[],
  next: SessionPullRequest[],
): void {
  if (previous === next) {
    return;
  }
  const previousStageById = new Map(
    previous.map((pullRequest) => [
      `${pullRequest.repository}#${pullRequest.number}`,
      pullRequest.stage,
    ]),
  );
  for (const pullRequest of next) {
    const id = `${pullRequest.repository}#${pullRequest.number}`;
    const from = previousStageById.get(id) ?? null;
    if (from !== pullRequest.stage) {
      logger.info(undefined, "session pull request stage changed", {
        from,
        to: pullRequest.stage,
      });
    }
  }
}
