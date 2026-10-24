/**
 * Side-chat rows under a parent task row (spec: sidebar-child-conversation-counts.md §4, §7, §9): the
 * group nesting rail (ml-4 border-l pl-2) with one row per side chat — message-circle glyph,
 * truncated title, relative time — plus the "+N more" overflow row. Shared by the grouped row and
 * TaskListItem (projects / timeline / pinned views). Subagents are not listed (§9). Owners render the
 * list as a sibling of the parent row's hover/press/context-menu target (§9.5), so each row hovers on
 * its own. Clicking a side chat opens it through the owner's select path, which binds the parent's
 * workspace; each row owns a context menu.
 */
import { MessageCircle } from "lucide-react";
import { useCallback, useState, type MouseEvent } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isChildSessionsExpanded,
  persistChildSessionsExpanded,
} from "@/lib/childSessionExpansionPreference.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { copyTextToClipboard } from "@/useTaskListItemContextActions.js";

export interface ChildSessionSelectOptions {
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

/** Side chats shown under the parent row: every listed one while expanded, none when collapsed. */
export function visibleChildSessions(
  task: Pick<ZCodeTaskMeta, "childSessions">,
  expanded: boolean,
): NonNullable<ZCodeTaskMeta["childSessions"]> {
  return expanded ? (task.childSessions ?? []) : [];
}

function SideChatRow({
  child,
  onOpen,
}: {
  child: NonNullable<ZCodeTaskMeta["childSessions"]>[number];
  onOpen: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [menuOpen, setMenuOpen] = useState(false);
  const copyLabel = intl.formatMessage({ id: "appHeader.copySessionId" });
  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger
        asChild
        // The flat parent <li> listens to contextmenu directly; the grouped parent trigger already
        // skips a default-prevented event. Stopping here keeps the parent's menu closed in both.
        onContextMenu={(event) => event.stopPropagation()}
      >
        <button
          data-child-session-id={child.sessionId}
          type="button"
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            event.preventDefault();
            event.stopPropagation();
            onOpen();
          }}
          aria-label={intl.formatMessage(
            { id: "taskList.childSideChatRowLabel" },
            { title: child.title },
          )}
          className="flex h-6 w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left text-ui-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          <MessageCircle aria-hidden="true" className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{child.title}</span>
          <span className="ml-auto shrink-0 text-ui-xs tabular-nums text-foreground-subtlest">
            {formatTaskRelativeTime(child.lastActivityAt, intl)}
          </span>
        </button>
      </ContextMenuTrigger>
      {menuOpen ? (
        // Mounted only while open, like the grouped row's menu: always-mounted Radix Presence/Portal
        // content loops on nested updates during drag reordering.
        <ContextMenuContent onClick={(event) => event.stopPropagation()}>
          <ContextMenuItem data-child-session-menu-open={child.sessionId} onSelect={onOpen}>
            {intl.formatMessage({ id: "common.open" })}
          </ContextMenuItem>
          <ContextMenuItem
            data-child-session-menu-copy-id={child.sessionId}
            onSelect={() => void copyTextToClipboard(copyLabel, child.sessionId)}
          >
            {copyLabel}
          </ContextMenuItem>
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}

export function TaskChildSessionRows({
  task,
  expanded,
  onSelectSession,
}: {
  task: ZCodeTaskMeta;
  expanded: boolean;
  onSelectSession: ChildSessionSelectHandler;
}) {
  const { intl } = useZCodeIntl();
  const listed = visibleChildSessions(task, expanded);
  if (listed.length === 0) return null;
  // Beyond the summary cap: the true total is larger than the list.
  const overflow = Math.max(0, (task.sideChatCount ?? 0) - listed.length);
  return (
    <div className="ml-4 border-l border-border py-px pl-2" data-child-sessions-list="true">
      {listed.map((child) => (
        <SideChatRow
          key={child.sessionId}
          child={child}
          onOpen={() => onSelectSession(child.sessionId, { selectionSideChat: true })}
        />
      ))}
      {overflow > 0 ? (
        <button
          type="button"
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            event.preventDefault();
            event.stopPropagation();
            onSelectSession(task.taskId, {});
          }}
          className="flex h-5 w-full items-center rounded-sm px-1.5 pl-[22px] text-left text-ui-xs text-foreground-subtlest hover:bg-surface-hover hover:text-foreground-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
        >
          {intl.formatMessage({ id: "taskList.childMoreLabel" }, { count: overflow })}
        </button>
      ) : null}
    </div>
  );
}
