import { memo } from "react";
import { PinIcon, XIcon } from "lucide-react";
import type {
  AssistantTextRow,
  ConversationRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  TID_V4_PINNED_BAR,
  TID_V4_PINNED_CHIP,
  TID_V4_PINNED_CHIP_UNPIN,
  testId,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

export type PinnedConversationRow = AssistantTextRow | UserInputRow;

/**
 * Pinned rows from the loaded snapshot window, newest pin first. v1 reads only the window; pins on
 * rows outside the loaded range appear once that range is loaded (see docs/chat-message-pins.md).
 */
export function selectPinnedRows(rows: readonly ConversationRow[]): PinnedConversationRow[] {
  return rows
    .filter(
      (row): row is PinnedConversationRow =>
        (row.kind === "assistantText" || row.kind === "userInput") &&
        typeof row.pinnedAt === "number",
    )
    .sort((a, b) => (b.pinnedAt as number) - (a.pinnedAt as number));
}

/**
 * Compact chips bar above the timeline for display-only message pins. Clicking a chip jumps to the
 * message through the timeline's row-positioning action; each chip carries its own unpin button.
 * Renders null when nothing is pinned, so the empty bar occupies no space.
 */
export const ConversationPinnedBar = memo(function ConversationPinnedBar({
  rows,
  onJumpToRow,
  onUnpin,
  className,
}: {
  rows: readonly ConversationRow[];
  onJumpToRow: (rowId: number) => void;
  onUnpin: (row: PinnedConversationRow) => void;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const pinnedRows = selectPinnedRows(rows);
  if (pinnedRows.length === 0) return null;
  const jumpLabel = intl.formatMessage({ id: "chat.pinnedBar.jumpToMessage" });
  const unpinLabel = intl.formatMessage({ id: "chat.message.unpin" });
  return (
    <div
      data-testid={TID_V4_PINNED_BAR}
      data-v4-pinned-bar="true"
      className={cn(
        "flex shrink-0 items-center gap-1.5 overflow-x-auto px-4 py-1.5 @md/conversation:px-6",
        className,
      )}
    >
      <PinIcon
        className="size-3.5 shrink-0 text-foreground-subtlest"
        aria-label={intl.formatMessage({ id: "chat.pinnedBar.title" })}
      />
      {pinnedRows.map((row) => (
        <div
          key={`${row.rowId}:${row.entityId ?? ""}`}
          data-testid={testId(TID_V4_PINNED_CHIP, String(row.rowId))}
          className="flex max-w-[16rem] shrink-0 items-center gap-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-hover)] py-0.5 pl-2 pr-0.5"
        >
          <button
            type="button"
            className="max-w-[13rem] truncate text-ui-sm text-foreground-subtle hover:text-foreground"
            title={jumpLabel}
            aria-label={`${jumpLabel}: ${row.text.slice(0, 120)}`}
            onClick={() => onJumpToRow(row.rowId)}
          >
            {row.text.slice(0, 60)}
          </button>
          <button
            type="button"
            className="flex size-4 shrink-0 items-center justify-center rounded-full text-foreground-subtlest hover:bg-[var(--color-surface-hover)] hover:text-foreground"
            aria-label={unpinLabel}
            data-testid={testId(TID_V4_PINNED_CHIP_UNPIN, String(row.rowId))}
            onClick={() => onUnpin(row)}
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
});
