/**
 * Sidebar side-chat marker (spec: sidebar-child-conversation-counts.md §4, §9): a message-circle
 * glyph with the tabular side-chat count, styled like the neighboring clock/moon/worktree meta icons
 * (size-3.5, the row's muted meta color). Subagents are not counted (§9). With an onToggle the marker
 * doubles as the side-chat list expander (click stops row propagation so it does not select the
 * task); without one it renders display-only (drag overlay).
 */
import { MessageCircle } from "lucide-react";
import type { MouseEvent } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function ChildSessionCountsMarker({
  task,
  expanded,
  onToggle,
}: {
  task: ZCodeTaskMeta;
  expanded: boolean;
  onToggle?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const sideChats = task.sideChatCount ?? 0;
  if (sideChats <= 0) return null;
  const tooltip = intl.formatPlural({ id: "taskList.childSideChatsCount" }, sideChats);
  const content = (
    <span className="flex items-center gap-0.5 tabular-nums">
      <MessageCircle aria-hidden="true" className="size-3.5 shrink-0" />
      {sideChats}
    </span>
  );
  if (!onToggle) {
    return (
      <span data-child-sessions-marker="true" title={tooltip} aria-label={tooltip}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-child-sessions-marker="true"
      aria-expanded={expanded}
      title={tooltip}
      aria-label={tooltip}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      className="flex shrink-0 items-center gap-1.5 rounded-sm text-foreground-subtle hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
    >
      {content}
    </button>
  );
}
