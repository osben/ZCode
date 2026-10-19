import type { ZCodeTaskMeta } from "@zcode/shared";
import { worstSessionPullRequestHealth } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTaskPullRequestStatus } from "@/hooks/useTaskPullRequestStatus.js";
import { selectPrimarySessionPullRequest } from "@/store/pullRequestStatusStore.js";
import {
  PullRequestStatusIcon,
  formatPullRequestHealthText,
  pullRequestStageMessageId,
} from "@/components/PullRequestStatusIcon.js";

/**
 * Sidebar row marker for a worktree session's pull requests
 * (specs/sidebar-pr-status.md): primary PR stage glyph plus the health dot of
 * open/draft PRs. Renders nothing without a worktree, without pull requests,
 * or while the status is unavailable — the row never shows a placeholder.
 */
export function TaskPullRequestMarker({ task }: { task: ZCodeTaskMeta }) {
  const { intl } = useZCodeIntl();
  const status = useTaskPullRequestStatus(task);
  if (!task.executionWorktree) {
    return null;
  }
  if (!status || status.pullRequests.length === 0) {
    return null;
  }
  const primary = selectPrimarySessionPullRequest(status);
  if (!primary) {
    return null;
  }
  const openDraft = status.pullRequests.filter(
    (pullRequest) => pullRequest.stage === "open" || pullRequest.stage === "draft",
  );
  const health = worstSessionPullRequestHealth(status.pullRequests);
  const failingCheckCount = openDraft.reduce(
    (maximum, pullRequest) => Math.max(maximum, pullRequest.failingCheckCount),
    0,
  );
  const label = [
    intl.formatMessage({ id: "pullRequest.prLabel" }, { number: String(primary.number) }),
    intl.formatMessage({ id: pullRequestStageMessageId(primary.stage) }),
    formatPullRequestHealthText(intl, health, failingCheckCount),
    status.stale ? intl.formatMessage({ id: "pullRequest.stale" }) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <PullRequestStatusIcon
      data-task-pr-stage={primary.stage}
      stage={primary.stage}
      health={health}
      dotVariant="row"
      label={label}
    />
  );
}
