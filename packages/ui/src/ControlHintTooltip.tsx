import {
  cloneElement,
  isValidElement,
  useCallback,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/components/lib/utils.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";

interface ControlHintTooltipProps {
  children: ReactNode;
  title: ReactNode;
  description?: string;
  shortcut?: string;
  standalone?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: ComponentProps<typeof TooltipContent>["side"];
  align?: ComponentProps<typeof TooltipContent>["align"];
  sideOffset?: ComponentProps<typeof TooltipContent>["sideOffset"];
  className?: string;
  triggerClassName?: string;
  triggerRef?: Ref<HTMLElement>;
}

type TriggerChildProps = {
  className?: string;
  ref?: Ref<HTMLElement>;
};

const shortcutKbdBaseClassName =
  "rounded-md h-4 inline-flex items-center border border-b-2 border-border bg-tooltip-tag px-1.5 text-ui-xs font-medium text-tooltip-tag-foreground";

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) {
    return;
  }
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  ref.current = value;
}

export function ControlHintTooltip({
  children,
  title,
  description,
  shortcut,
  standalone = false,
  open,
  onOpenChange,
  side = "top",
  align = "center",
  sideOffset = 2,
  className,
  triggerClassName,
  triggerRef,
}: ControlHintTooltipProps) {
  const useAppleShortcutFont = isAppleKeyboardPlatform();
  const shortcutFontClassName = useAppleShortcutFont ? "tracking-normal" : "font-mono";
  const shortcutFontStyle = useAppleShortcutFont
    ? {
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", sans-serif',
      }
    : undefined;
  const isTriggerElement = isValidElement<TriggerChildProps>(children);
  const childRef = isTriggerElement ? children.props.ref : undefined;
  // Radix Tooltip/Dropdown/Popper asChild triggers synchronously call setState when the ref changes.
  // Keep the callback ref identity stable; otherwise every render detaches and reattaches the ref, causing an update loop.
  const composedTriggerRef = useCallback(
    (value: HTMLElement | null) => {
      setRef(childRef, value);
      setRef(triggerRef, value);
    },
    [childRef, triggerRef],
  );
  const trigger = isTriggerElement ? (
    cloneElement(children, {
      // Previously, an extra span caused events and refs to land on different DOM nodes when Radix Tooltip/Select/Popover used nested asChild elements,
      // triggering a SlotClone render-stack error. Attach directly to the actual trigger instead.
      className: cn("shrink-0", children.props.className, triggerClassName),
      ref: composedTriggerRef,
    })
  ) : (
    <span
      ref={triggerRef as Ref<HTMLSpanElement>}
      className={cn("inline-flex shrink-0", triggerClassName)}
    >
      {children}
    </span>
  );

  // Large conversations render many ControlHintTooltip instances for message actions. Creating a Provider for each one
  // would grow the Radix context tree with the message count; Root provides a shared Provider instead.
  const tooltip = (
    <Tooltip open={open} onOpenChange={onOpenChange}>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          description
            ? "max-w-72 flex-col items-start gap-1.5 px-3 py-2 text-left"
            : "max-w-[min(28rem,calc(100vw-1rem))] items-center gap-2 px-2.5 py-1 text-left has-data-[slot=kbd]:pr-1",
          className,
        )}
      >
        {description ? (
          <div className="flex w-full items-start justify-between gap-3">
            <span className="text-ui-sm font-medium leading-4 text-tooltip-foreground">
              {title}
            </span>
            {shortcut ? (
              <kbd
                data-slot="kbd"
                className={cn(shortcutKbdBaseClassName, shortcutFontClassName, "shrink-0")}
                style={shortcutFontStyle}
              >
                {shortcut}
              </kbd>
            ) : null}
          </div>
        ) : (
          // Undescribed tooltips were constrained by both max-w-xs and nowrap, clipping long English and Chinese text.
          // Keep short tooltips content-sized, allow wrapping beyond the viewport’s safe width, and use explicit line breaks for structured hints.
          <span className="text-ui-sm font-medium whitespace-pre-line break-words text-tooltip-foreground">
            {title}
          </span>
        )}
        {description ? (
          <span className="max-w-64 text-ui-sm/relaxed text-tooltip-foreground/80">
            {description}
          </span>
        ) : null}
        {!description && shortcut ? (
          <kbd
            data-slot="kbd"
            className={cn(shortcutKbdBaseClassName, shortcutFontClassName, "shrink-0")}
            style={shortcutFontStyle}
          >
            {shortcut}
          </kbd>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );

  // A few components need to render outside Root during SSR or unit tests; this wrapper adds a Provider on demand,
  // avoiding business-layer recomposition of Tooltip primitives without creating duplicate contexts for regular list tooltips.
  return standalone ? <TooltipProvider>{tooltip}</TooltipProvider> : tooltip;
}
