import { worstSessionPullRequestHealth, type SessionPullRequest } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTaskPullRequestStatus } from "@/hooks/useTaskPullRequestStatus.js";
import { selectPrimarySessionPullRequest } from "@/store/pullRequestStatusStore.js";
import {
  PullRequestStatusIcon,
  formatPullRequestHealthText,
} from "@/components/PullRequestStatusIcon.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { cn } from "@/components/lib/utils.js";

/**
 * "Pull requests" group of the status panel's Git tools section
 * (specs/sidebar-pr-status.md, surface 5): one two-line button per pull
 * request between the worktree row and Changes. Worktree sessions only —
 * the workspace branch is not a session fact.
 */
export function ConversationStatusPanelPullRequests({
  activeTaskId,
  hasWorktree,
  workspacePath,
  workspaceIdentity,
}: {
  activeTaskId: string | null | undefined;
  hasWorktree: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const status = useTaskPullRequestStatus({
    taskId: activeTaskId ?? "",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
  if (!hasWorktree || !activeTaskId) {
    return null;
  }
  if (
    status?.state === "unavailable" &&
    (status.unavailableReason === "no_gh" || status.unavailableReason === "auth")
  ) {
    return (
      <div
        data-status-panel-pull-requests="unavailable"
        className="flex min-h-8 w-full items-center px-2 text-ui-sm text-foreground-subtlest"
      >
        {intl.formatMessage({
          id:
            status.unavailableReason === "no_gh"
              ? "pullRequest.unavailableNoGh"
              : "pullRequest.unavailableAuth",
        })}
      </div>
    );
  }
  if (!status || status.pullRequests.length === 0) {
    return null;
  }
  const openDraft = status.pullRequests.filter(
    (pullRequest) => pullRequest.stage === "open" || pullRequest.stage === "draft",
  );
  const failingCheckCount = openDraft.reduce(
    (maximum, pullRequest) => Math.max(maximum, pullRequest.failingCheckCount),
    0,
  );
  return (
    <div data-status-panel-pull-requests="list" className="py-1">
      <div className="flex h-6 w-full items-center gap-2 px-2 text-ui-sm text-foreground-subtle">
        {intl.formatMessage(
          { id: "pullRequest.sectionTitle" },
          { count: String(status.pullRequests.length) },
        )}
      </div>
      {status.pullRequests.map((pullRequest) => (
        <PullRequestToolsRow
          key={`${pullRequest.repository}#${pullRequest.number}`}
          pullRequest={pullRequest}
          failingCheckCount={failingCheckCount}
          onOpen={() => platform?.openExternal(pullRequest.url)}
        />
      ))}
      {status.stale ? (
        <div className="flex h-6 w-full items-center px-2 text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "pullRequest.stale" })}
        </div>
      ) : null}
    </div>
  );
}

function PullRequestToolsRow({
  pullRequest,
  failingCheckCount,
  onOpen,
}: {
  pullRequest: SessionPullRequest;
  failingCheckCount: number;
  onOpen: () => void;
}) {
  const { intl } = useZCodeIntl();
  const health = worstSessionPullRequestHealth([pullRequest]);
  const healthText = formatPullRequestHealthText(intl, health, failingCheckCount);
  return (
    <button
      type="button"
      data-status-panel-pull-request={pullRequest.number}
      className={cn(
        "flex min-h-12 w-full min-w-0 flex-col items-start justify-center gap-0.5 rounded-lg px-2 py-1.5 text-left text-ui-base text-[var(--color-foreground)] transition-colors",
        "hover:bg-[var(--color-hover)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]",
      )}
      onClick={onOpen}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <PullRequestStatusIcon
          stage={pullRequest.stage}
          health={health}
          dotVariant="detail"
          iconClassName="size-4"
        />
        <span className="min-w-0 flex-1 truncate">{pullRequest.title}</span>
        {healthText ? (
          <span className="shrink-0 text-ui-sm text-foreground-subtle">{healthText}</span>
        ) : null}
      </span>
      <span className="flex w-full min-w-0 items-center gap-1 pl-6 text-ui-sm text-foreground-subtle">
        {pullRequest.stage === "merged" && pullRequest.mergedAt ? (
          <span className="min-w-0 truncate">
            {intl.formatMessage(
              { id: "pullRequest.mergedAgo" },
              { time: formatTaskRelativeTime(Date.parse(pullRequest.mergedAt), intl) },
            )}
          </span>
        ) : (
          <>
            <span className="min-w-0 truncate">
              {`${pullRequest.repository} #${pullRequest.number}`}
            </span>
            <span className="shrink-0 font-mono tabular-nums">
              <span className="text-[var(--color-diff-added)]">+{pullRequest.additions}</span>{" "}
              <span className="text-[var(--color-diff-removed)]">-{pullRequest.deletions}</span>
            </span>
          </>
        )}
      </span>
    </button>
  );
}

/** Collapsed-section trailing glyph: the primary PR before the +N −M diff. */
export function PrimaryPullRequestTrailingIcon({
  activeTaskId,
  workspacePath,
  workspaceIdentity,
}: {
  activeTaskId: string | null | undefined;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const status = useTaskPullRequestStatus({
    taskId: activeTaskId ?? "",
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
  const primary = selectPrimarySessionPullRequest(status);
  if (!primary) {
    return null;
  }
  return (
    <PullRequestStatusIcon
      data-status-panel-pull-request-trailing={primary.stage}
      stage={primary.stage}
      health={worstSessionPullRequestHealth(status?.pullRequests ?? [primary])}
      dotVariant="row"
      iconClassName="size-3.5"
    />
  );
}
