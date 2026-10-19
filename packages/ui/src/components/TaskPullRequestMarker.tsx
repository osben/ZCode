import type { ZCodeTaskMeta } from "@zcode/shared";
import { worstSessionPullRequestHealth } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTaskPullRequestStatus } from "@/hooks/useTaskPullRequestStatus.js";
import { selectPrimarySessionPullRequest } from "@/store/pullRequestStatusStore.js";
import {
  PullRequestStatusIcon,
  maxOpenDraftFailingCheckCount,
  pullRequestLabelParts,
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
  const health = worstSessionPullRequestHealth(status.pullRequests);
  const label = [
    ...pullRequestLabelParts(
      intl,
      primary,
      health,
      maxOpenDraftFailingCheckCount(status.pullRequests),
    ),
    ...(status.stale ? [intl.formatMessage({ id: "pullRequest.stale" })] : []),
  ].join(" · ");
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
