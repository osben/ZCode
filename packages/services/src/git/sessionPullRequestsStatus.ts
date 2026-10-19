import type { SessionPullRequest, SessionPullRequestStatus } from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";

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
