/**
 * Child-conversation rows under a parent task row (spec: sidebar-child-conversation-counts.md §4,
 * §7): the group nesting rail (ml-4 border-l pl-2) with one row per child — bot/message-circle
 * glyph, truncated title, spinner while running, relative time otherwise — plus the "+N more"
 * overflow row. Shared by the grouped row and TaskListItem (projects / timeline / pinned views).
 * Clicking a child opens that session through the owner's select path, which binds the parent's
 * workspace. Side chats stay writable; subagents open read-only because the Host rejects child
 * input. The overflow row opens the parent conversation, where the full subagent history lives.
 */
import { Bot, LoaderIcon, MessageCircle, Square } from "lucide-react";
import { useCallback, useState, type MouseEvent } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isChildSessionsExpanded,
  persistChildSessionsExpanded,
} from "@/lib/childSessionExpansionPreference.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import {
  useTaskConversationCommandSender,
  type TaskConversationCommandTarget,
} from "@/hooks/useTaskInteractionAutoResolutionSnooze.js";

export interface ChildSessionSelectOptions {
  readOnly?: boolean;
  selectionSideChat?: boolean;
  /**
   * Owning parent task, set by the row owner: children are absent from the top-level tree, so
   * remote workspace attachment and stale-navigation checks resolve against the parent.
   */
  parentTaskId?: string;
}

/** Opens a session in the parent task's workspace; the row owner binds workspace identity. */
export type ChildSessionSelectHandler = (
  sessionId: string,
  options: ChildSessionSelectOptions,
  title?: string,
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

/**
 * Children shown under the parent row: every listed child while expanded, otherwise only the
 * running ones (spec §8: live subagents stay visible without a click; finished ones collapse).
 */
export function visibleChildSessions(
  task: Pick<ZCodeTaskMeta, "childSessions">,
  expanded: boolean,
): NonNullable<ZCodeTaskMeta["childSessions"]> {
  const listed = task.childSessions ?? [];
  return expanded ? listed : listed.filter((child) => child.running);
}

/**
 * Sidebar Stop for a running background subagent (spec sidebar-child-conversation-counts §8.3): the
 * same cancelBackgroundWork command the status panel sends, addressed to the parent session on its
 * own Host. The row changes only when the next parent summary arrives (no optimistic removal).
 */
export function useStopChildBackgroundWork(
  parent: TaskConversationCommandTarget & { sessionId: string },
  // Rows receive intl as a prop (no provider in every render path), so the owner localizes.
  failureMessage: string,
): (workId: string) => Promise<void> {
  const sendCommand = useTaskConversationCommandSender(parent);
  return useCallback(
    async (workId: string) => {
      const fail = (reason: string) => {
        logger.warn("[sidebar-child] 停止后台子代理失败", {
          parentSessionId: parent.sessionId,
          workId,
          reason,
        });
        toast(failureMessage);
      };
      if (!sendCommand) {
        fail("target-unavailable");
        return;
      }
      const envelope = createCommandEnvelope({
        type: "cancelBackgroundWork",
        sessionId: parent.sessionId,
        payload: { workId },
      });
      pendingCommandRegistry.record(envelope);
      try {
        const ack = await sendCommand(envelope);
        pendingCommandRegistry.applyAck(envelope, ack);
        if (ack.status !== "accepted" && ack.status !== "duplicate" && ack.status !== "noop") {
          fail(ack.reasonCode ?? ack.status);
          return;
        }
        logger.info("[sidebar-child] 已请求停止后台子代理", {
          parentSessionId: parent.sessionId,
          workId,
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    },
    [failureMessage, parent.sessionId, sendCommand],
  );
}

export function TaskChildSessionRows({
  task,
  expanded,
  onToggle,
  onSelectSession,
  onStopBackgroundWork,
}: {
  task: ZCodeTaskMeta;
  expanded: boolean;
  onToggle: () => void;
  onSelectSession: ChildSessionSelectHandler;
  /** Stops a running background subagent (spec §8.3); rows without a backgroundWorkId get no Stop. */
  onStopBackgroundWork?: (workId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const listed = visibleChildSessions(task, expanded);
  if (listed.length === 0) return null;
  const overflow = Math.max(
    0,
    (task.sideChatCount ?? 0) + (task.subagentCount ?? 0) - listed.length,
  );
  const openSession =
    (
      sessionId: string,
      taskType: "subagent_child" | "selection_side_chat" | null = null,
      title?: string,
    ) =>
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onSelectSession(
        sessionId,
        {
          readOnly: taskType === "subagent_child",
          selectionSideChat: taskType === "selection_side_chat",
        },
        title,
      );
    };
  return (
    <div className="ml-4 border-l border-border py-px pl-2" data-child-sessions-list="true">
      {listed.map((child) => (
        <div key={child.sessionId} className="group/child-row flex min-w-0 items-center">
          <button
            data-child-session-id={child.sessionId}
            type="button"
            onClick={openSession(child.sessionId, child.taskType, child.title)}
            aria-label={intl.formatMessage(
              {
                id:
                  child.taskType === "subagent_child"
                    ? "taskList.childSubagentRowLabel"
                    : "taskList.childSideChatRowLabel",
              },
              { title: child.title },
            )}
            className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 text-left text-ui-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
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
          {child.running && child.backgroundWorkId && onStopBackgroundWork ? (
            <button
              type="button"
              data-child-session-stop={child.sessionId}
              title={intl.formatMessage({ id: "taskList.childStopLabel" })}
              aria-label={intl.formatMessage({ id: "taskList.childStopLabel" })}
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                event.preventDefault();
                event.stopPropagation();
                onStopBackgroundWork(child.backgroundWorkId!);
              }}
              className="ml-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground-subtlest hover:bg-surface-hover hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
            >
              <Square aria-hidden="true" className="size-3" />
            </button>
          ) : null}
        </div>
      ))}
      {overflow > 0 ? (
        <button
          type="button"
          // Collapsed: reveal the finished children; expanded: beyond the cap, open the parent.
          aria-expanded={expanded ? undefined : false}
          onClick={
            expanded
              ? openSession(task.taskId)
              : (event: MouseEvent<HTMLButtonElement>) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onToggle();
                }
          }
          className="flex h-5 w-full items-center rounded-sm px-1.5 pl-[22px] text-left text-ui-xs text-foreground-subtlest hover:bg-surface-hover hover:text-foreground-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          {intl.formatMessage({ id: "taskList.childMoreLabel" }, { count: overflow })}
        </button>
      ) : null}
    </div>
  );
}
