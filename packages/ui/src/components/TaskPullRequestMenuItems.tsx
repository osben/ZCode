import type { ComponentType, ReactNode } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useTaskPullRequestStatus } from "@/hooks/useTaskPullRequestStatus.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import {
  selectPrimarySessionPullRequest,
  usePullRequestStatusStore,
} from "@/store/pullRequestStatusStore.js";

/**
 * Pull request section for task context menus (specs/sidebar-pr-status.md):
 * Open items (one per pull request, max 3, primary first), Copy pull request
 * link, and an explicit Refresh that bypasses the service TTL. Rendered only
 * for worktree sessions; ordinary sessions keep no PR entries. On mobile this
 * menu is the only path to the PR list (no hover card).
 */

const PULL_REQUEST_MENU_MAX_ITEMS = 3;

interface TaskPullRequestMenuItemProps {
  children: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  title?: string;
}

interface TaskPullRequestMenuSeparatorProps {
  key?: string;
}

export function TaskPullRequestMenuItems({
  task,
  intl,
  Item,
  Separator,
  onCopyText,
}: {
  task: ZCodeTaskMeta;
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  Item: ComponentType<TaskPullRequestMenuItemProps>;
  Separator: ComponentType<TaskPullRequestMenuSeparatorProps>;
  onCopyText: (label: string, value: string | null) => void;
}) {
  const platform = useOptionalPlatform();
  const status = useTaskPullRequestStatus(task);
  if (!task.executionWorktree) {
    return null;
  }
  const primary = selectPrimarySessionPullRequest(status);
  const visiblePullRequests = (status?.pullRequests ?? []).slice(0, PULL_REQUEST_MENU_MAX_ITEMS);
  if (visiblePullRequests.length === 0) {
    // No pull requests (or no observation yet — old host, failed probe): only
    // the explicit refresh stays meaningful so the user can force a lookup
    // instead of waiting for a TTL.
    return (
      <>
        <Separator />
        <Item
          onSelect={() => {
            usePullRequestStatusStore.getState().requestForceRefresh([buildTaskEntityKey(task)]);
          }}
        >
          {intl.formatMessage({ id: "pullRequest.refresh" })}
        </Item>
      </>
    );
  }
  return (
    <>
      <Separator />
      {visiblePullRequests.map((pullRequest) => (
        <Item
          key={`${pullRequest.repository}#${pullRequest.number}`}
          onSelect={() => {
            platform?.openExternal(pullRequest.url);
          }}
        >
          <span className="truncate">
            {intl.formatMessage({ id: "pullRequest.open" }, { number: String(pullRequest.number) })}
          </span>
        </Item>
      ))}
      <Item
        disabled={!primary}
        onSelect={() => {
          onCopyText(intl.formatMessage({ id: "pullRequest.copyLink" }), primary?.url ?? null);
        }}
      >
        {intl.formatMessage({ id: "pullRequest.copyLink" })}
      </Item>
      <Item
        onSelect={() => {
          usePullRequestStatusStore.getState().requestForceRefresh([buildTaskEntityKey(task)]);
        }}
      >
        {intl.formatMessage({ id: "pullRequest.refresh" })}
      </Item>
    </>
  );
}
