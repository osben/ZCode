import { useEffect, useState, type ReactNode } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const SIDE_PANE_TAB_TOOLTIP_DELAY_MS = 1_500;

export function SidePaneTabTitleTooltip({
  children,
  isDragging,
  title,
}: {
  children: ReactNode;
  isDragging: boolean;
  title: string;
}) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (isDragging) {
      // Clear the open state when dragging starts so the tooltip does not reopen on the old tab when dragging ends.
      setIsOpen(false);
    }
  }, [isDragging]);

  return (
    <TooltipProvider delayDuration={SIDE_PANE_TAB_TOOLTIP_DELAY_MS} skipDelayDuration={0}>
      <ControlHintTooltip
        title={title}
        side="bottom"
        // ControlHintTooltip adds shrink-0 to regular buttons by default; side tabs must retain their equal-width shrink behavior.
        triggerClassName="shrink"
        open={isOpen && !isDragging}
        onOpenChange={(open) => setIsOpen(isDragging ? false : open)}
      >
        {children}
      </ControlHintTooltip>
    </TooltipProvider>
  );
}
