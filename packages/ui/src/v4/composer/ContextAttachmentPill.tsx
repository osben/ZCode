import type { HTMLAttributes, ReactNode } from "react";
import { XIcon } from "lucide-react";
import {
  AttachmentHoverCard,
  AttachmentHoverCardContent,
  AttachmentHoverCardTrigger,
  type AttachmentHoverCardContentProps,
} from "@/components/ai-elements/attachments.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";

interface ContextAttachmentPillProps {
  children: ReactNode;
  contentAlign?: AttachmentHoverCardContentProps["align"];
  icon: ReactNode;
  label: string;
  onRemoveAll?: () => void;
  removeLabel: string;
  triggerProps?: Omit<HTMLAttributes<HTMLDivElement>, "children"> &
    Partial<Record<`data-${string}`, string | number>>;
}

/**
 * Context attachments share the same pill and detail-popover shell to avoid duplicating layout and interaction styles for each type.
 * The trigger uses asChild and the detail view uses a Portal, leaving only one pill node in the message attachment container.
 */
export function ContextAttachmentPill({
  children,
  contentAlign = "start",
  icon,
  label,
  onRemoveAll,
  removeLabel,
  triggerProps,
}: ContextAttachmentPillProps) {
  return (
    <AttachmentHoverCard>
      <AttachmentHoverCardTrigger asChild>
        <div
          {...triggerProps}
          aria-label={label}
          className={cn(
            "group flex h-8 max-w-full cursor-pointer select-none items-center gap-1.5 rounded-full border-0 bg-surface py-1.5 text-ui-base font-medium text-foreground transition-all hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
            // The input and conversation flow share this shell, but only the input has a close button.
            // Compressing right padding unconditionally would make conversation-flow pills look off-center, so vary spacing by whether a remove action exists.
            onRemoveAll ? "pl-3 pr-1.5" : "px-3",
          )}
          role="button"
          tabIndex={0}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {icon}
            <span className="truncate">{label}</span>
          </span>
          {onRemoveAll ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-5 shrink-0 rounded-full text-foreground-subtle opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={(event) => {
                event.stopPropagation();
                onRemoveAll();
              }}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </AttachmentHoverCardTrigger>
      <AttachmentHoverCardContent
        align={contentAlign}
        side="top"
        className="w-80 rounded-xl border border-border bg-tooltip p-1 text-tooltip-foreground shadow-md ring-0"
      >
        <div className="max-h-64 overflow-y-auto">{children}</div>
      </AttachmentHoverCardContent>
    </AttachmentHoverCard>
  );
}
