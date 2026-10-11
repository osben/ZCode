import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

interface DesktopTopOverlayActionButtonProps {
  title: string;
  ariaLabel: string;
  children: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
  side?: ComponentProps<typeof ControlHintTooltip>["side"];
  buttonClassName?: string;
  testId?: string;
}

export function DesktopTopOverlayActionButton({
  title,
  ariaLabel,
  children,
  shortcut,
  disabled,
  onClick,
  onMouseEnter,
  side = "bottom",
  buttonClassName,
  testId,
}: DesktopTopOverlayActionButtonProps) {
  return (
    <ControlHintTooltip title={title} shortcut={shortcut} side={side}>
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        // The base Button defaults to transition-all, which also animates title-bar button size and position changes while the window is resizing,
        // making buttons appear to reset before following the window during continuous resizing on Windows; overlay buttons need only a hover-color transition.
        className={cn("[app-region:no-drag] transition-colors", buttonClassName)}
        data-testid={testId}
        aria-label={ariaLabel}
        disabled={disabled}
        // The top overlay’s new-task entry reuses a business function with an optional provider parameter.
        // Passing it directly to React onClick would pass MouseEvent as the provider and throw when the logging IPC tries to clone it.
        // Discard the DOM event here and call the no-argument action expected by the component.
        onClick={() => onClick()}
        onMouseEnter={onMouseEnter}
      >
        {children}
      </Button>
    </ControlHintTooltip>
  );
}
