import type { ZCodeTaskMeta } from "@zcode/shared";
import { worstSessionPullRequestHealth } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTaskPullRequestStatus } from "@/hooks/useTaskPullRequestStatus.js";
import { selectPrimarySessionPullRequest } from "@/store/pullRequestStatusStore.js";
import {
  PullRequestStatusIcon,
  formatPullRequestHealthText,
  pullRequestStageMessageId,
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
  const openDraft = status.pullRequests.filter(
    (pullRequest) => pullRequest.stage === "open" || pullRequest.stage === "draft",
  );
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
