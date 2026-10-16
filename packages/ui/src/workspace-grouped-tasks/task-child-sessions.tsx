/**
 * Child-conversation rows under a parent task row (spec: sidebar-child-conversation-counts.md):
 * the group nesting rail (ml-4 border-l pl-2) with one row per child — bot/message-circle glyph,
 * truncated title, spinner while running, relative time otherwise — plus the "+N more" overflow row.
 * Clicking a child opens that session as the active conversation through the row's regular
 * onSelectTask path (children are real sessions; v1 opens them in place rather than the side pane
 * or the unwired subagent drilldown). The overflow row opens the parent conversation, where the
 * full subagent history lives.
 */
import { Bot, LoaderIcon, MessageCircle } from "lucide-react";
import type { MouseEvent } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";

type SelectTaskHandler = (
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
) => void;

export function TaskChildSessionRows({
  task,
  onSelectTask,
}: {
  task: ZCodeTaskMeta;
  onSelectTask: SelectTaskHandler;
}) {
  const { intl } = useZCodeIntl();
  const listed = task.childSessions ?? [];
  if (listed.length === 0) return null;
  const overflow = Math.max(
    0,
    (task.sideChatCount ?? 0) + (task.subagentCount ?? 0) - listed.length,
  );
  const openSession = (sessionId: string) => (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onSelectTask(task.workspacePath, sessionId, task.workspaceIdentity);
  };
  return (
    <div className="ml-4 border-l border-border py-px pl-2" data-child-sessions-list="true">
      {listed.map((child) => (
        <button
          key={child.sessionId}
          type="button"
          onClick={openSession(child.sessionId)}
          aria-label={intl.formatMessage(
            {
              id:
                child.taskType === "subagent_child"
                  ? "taskList.childSubagentRowLabel"
                  : "taskList.childSideChatRowLabel",
            },
            { title: child.title },
          )}
          className="flex h-6 w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left text-ui-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          {child.taskType === "subagent_child" ? (
            <Bot aria-hidden="true" className="size-3 shrink-0" />
          ) : (
            <MessageCircle aria-hidden="true" className="size-3 shrink-0" />
          )}
          <span className="min-w-0 truncate">{child.title}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1 text-ui-xs text-foreground-subtlest">
            {child.running ? (
              <LoaderIcon
                aria-label={intl.formatMessage({ id: "taskList.childRunningLabel" })}
                className="size-3 animate-spin"
              />
            ) : (
              <span className="tabular-nums">
                {formatTaskRelativeTime(child.lastActivityAt, intl)}
              </span>
            )}
          </span>
        </button>
      ))}
      {overflow > 0 ? (
        <button
          type="button"
          onClick={openSession(task.taskId)}
          className="flex h-5 w-full items-center rounded-sm px-1.5 pl-[22px] text-left text-ui-xs text-foreground-subtlest hover:bg-surface-hover hover:text-foreground-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          {intl.formatMessage({ id: "taskList.childMoreLabel" }, { count: overflow })}
        </button>
      ) : null}
    </div>
  );
}
