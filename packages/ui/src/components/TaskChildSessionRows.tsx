/**
 * Child-conversation rows under a parent task row (spec: sidebar-child-conversation-counts.md §4,
 * §7): the group nesting rail (ml-4 border-l pl-2) with one row per child — bot/message-circle
 * glyph, truncated title, spinner while running, relative time otherwise — plus the "+N more"
 * overflow row. Shared by the grouped row and TaskListItem (projects / timeline / pinned views).
 * Clicking a child opens that session through the owner's select path, which binds the parent's
 * workspace. Side chats stay writable; subagents open read-only because the Host rejects child
 * input. The overflow row opens the parent conversation, where the full subagent history lives.
 */
import { Bot, LoaderIcon, MessageCircle } from "lucide-react";
import { useCallback, useState, type MouseEvent } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isChildSessionsExpanded,
  persistChildSessionsExpanded,
} from "@/lib/childSessionExpansionPreference.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";

export interface ChildSessionSelectOptions {
  readOnly?: boolean;
  selectionSideChat?: boolean;
}

/** Opens a session in the parent task's workspace; the row owner binds workspace identity. */
export type ChildSessionSelectHandler = (
  sessionId: string,
  options: ChildSessionSelectOptions,
) => void;

/** Per-parent expansion backed by the single localStorage owner (childSessionExpansionPreference). */
export function useChildSessionsExpansion(parentSessionId: string): [boolean, () => void] {
  const [expanded, setExpanded] = useState(() => isChildSessionsExpanded(parentSessionId));
  const toggle = useCallback(() => {
    persistChildSessionsExpanded(parentSessionId, !expanded);
    setExpanded(!expanded);
  }, [expanded, parentSessionId]);
  return [expanded, toggle];
}

export function TaskChildSessionRows({
  task,
  onSelectSession,
}: {
  task: ZCodeTaskMeta;
  onSelectSession: ChildSessionSelectHandler;
}) {
  const { intl } = useZCodeIntl();
  const listed = task.childSessions ?? [];
  if (listed.length === 0) return null;
  const overflow = Math.max(
    0,
    (task.sideChatCount ?? 0) + (task.subagentCount ?? 0) - listed.length,
  );
  const openSession =
    (sessionId: string, taskType: "subagent_child" | "selection_side_chat" | null = null) =>
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onSelectSession(sessionId, {
        readOnly: taskType === "subagent_child",
        selectionSideChat: taskType === "selection_side_chat",
      });
    };
  return (
    <div className="ml-4 border-l border-border py-px pl-2" data-child-sessions-list="true">
      {listed.map((child) => (
        <button
          key={child.sessionId}
          data-child-session-id={child.sessionId}
          type="button"
          onClick={openSession(child.sessionId, child.taskType)}
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
              // Rotate the HTML wrapper, not the SVG, matching TaskListItem (assumed cheaper; not profiled).
              <span
                role="img"
                aria-label={intl.formatMessage({ id: "taskList.childRunningLabel" })}
                className="flex size-3 items-center justify-center motion-safe:animate-spin"
              >
                <LoaderIcon aria-hidden="true" className="size-3" />
              </span>
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
