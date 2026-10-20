import type { SessionPullRequest, SessionPullRequestHealth } from "./git.js";

const SESSION_PULL_REQUEST_HEALTH_SEVERITY: Record<SessionPullRequestHealth, number> = {
  conflict: 5,
  failing: 4,
  optional_failing: 3,
  running: 2,
  passing: 1,
  none: 0,
};

/**
 * Worst health across the open and draft pull requests of a task
 * (specs/sidebar-pr-status.md): merged/closed pull requests do not color the
 * row; severity order conflict > failing > optional_failing > running >
 * passing > none.
 */
export function worstSessionPullRequestHealth(
  pullRequests: readonly SessionPullRequest[],
): SessionPullRequestHealth {
  let worst: SessionPullRequestHealth = "none";
  for (const pullRequest of pullRequests) {
    if (pullRequest.stage !== "open" && pullRequest.stage !== "draft") {
      continue;
    }
    let health: SessionPullRequestHealth = "none";
    if (pullRequest.hasConflict) {
      health = "conflict";
    } else if (
      pullRequest.checks === "failing" ||
      pullRequest.checks === "optional_failing" ||
      pullRequest.checks === "running" ||
      pullRequest.checks === "passing"
    ) {
      health = pullRequest.checks;
    }
    if (
      SESSION_PULL_REQUEST_HEALTH_SEVERITY[health] > SESSION_PULL_REQUEST_HEALTH_SEVERITY[worst]
    ) {
      worst = health;
    }
  }
  return worst;
}
