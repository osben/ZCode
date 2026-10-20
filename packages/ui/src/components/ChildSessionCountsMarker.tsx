import { formatPluralMessage } from "../i18n/formatPlural.js";
/**
 * Sidebar child-conversation marker (spec: sidebar-child-conversation-counts.md): message-circle and
 * bot glyph segments with tabular counts, styled like the neighboring clock/moon/worktree meta icons
 * (size-3.5, the row's muted meta color). A segment renders only when its own count is non-zero;
 * while subagents run, the bot segment uses the row's existing loading idiom — a spinning LoaderIcon
 * next to running/total. With an onToggle the marker doubles as the child-list expander (click stops
 * row propagation so it does not select the task); without one it renders display-only (drag overlay).
 */
import { Bot, LoaderIcon, MessageCircle } from "lucide-react";
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
  const subagents = task.subagentCount ?? 0;
  const running = task.runningSubagentCount ?? 0;
  // Within the facts TTL the cached total can lag the live running count (first subagent of a
  // parent); the denominator clamps so the running form is never "2/1"-shaped.
  const subagentTotal = Math.max(subagents, running);
  if (sideChats <= 0 && subagentTotal <= 0) return null;
  const tooltipParts: string[] = [];
  if (sideChats > 0) {
    tooltipParts.push(formatPluralMessage(intl, "taskList.childSideChatsCount", sideChats));
  }
  if (subagentTotal > 0) {
    tooltipParts.push(formatPluralMessage(intl, "taskList.childSubagentsCount", subagentTotal));
  }
  if (running > 0) {
    tooltipParts.push(formatPluralMessage(intl, "taskList.childSubagentsRunningCount", running));
  }
  const tooltip = tooltipParts.join(" · ");
  const segmentClass = "flex items-center gap-0.5 tabular-nums";
  const content = (
    <>
      {sideChats > 0 ? (
        <span className={segmentClass}>
          <MessageCircle aria-hidden="true" className="size-3.5 shrink-0" />
          {sideChats}
        </span>
      ) : null}
      {subagentTotal > 0 ? (
        <span className={segmentClass}>
          {running > 0 ? (
            <LoaderIcon aria-hidden="true" className="size-3.5 shrink-0 motion-safe:animate-spin" />
          ) : (
            <Bot aria-hidden="true" className="size-3.5 shrink-0" />
          )}
          {running > 0 ? `${running}/${subagentTotal}` : subagentTotal}
        </span>
      ) : null}
    </>
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
