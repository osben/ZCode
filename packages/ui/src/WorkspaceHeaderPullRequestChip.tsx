import type { ZCodeTaskMeta } from "@zcode/shared";
import { worstSessionPullRequestHealth } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTaskPullRequestStatus } from "@/hooks/useTaskPullRequestStatus.js";
import { selectPrimarySessionPullRequest } from "@/store/pullRequestStatusStore.js";
import {
  PullRequestStatusIcon,
  maxOpenDraftFailingCheckCount,
  pullRequestLabelParts,
} from "@/components/PullRequestStatusIcon.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

/**
 * Session header chip (specs/sidebar-pr-status.md, surface 4): stage icon +
 * primary PR number + health dot, opening the pull request externally.
 * Worktree sessions only.
 */
export function WorkspaceHeaderPullRequestChip({ task }: { task: ZCodeTaskMeta | null }) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const status = useTaskPullRequestStatus(task ?? { taskId: "", workspacePath: "" });
  if (!task?.executionWorktree) {
    return null;
  }
  const primary = status ? selectPrimarySessionPullRequest(status) : null;
  if (!status || !primary) {
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
    <ControlHintTooltip title={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-workspace-header-pull-request={primary.number}
        aria-label={label}
        className="h-6 gap-1 px-1.5 text-ui-sm"
        onClick={() => {
          platform?.openExternal(primary.url);
        }}
      >
        <PullRequestStatusIcon stage={primary.stage} health={health} dotVariant="row" />
        <span className="font-mono tabular-nums text-foreground-subtle">{`#${primary.number}`}</span>
      </Button>
    </ControlHintTooltip>
  );
}
