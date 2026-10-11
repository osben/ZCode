import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type InputEvent,
  type ReactNode,
} from "react";
import { cn } from "@/components/lib/utils.js";

const AUTOMATION_INSTRUCTIONS_MIN_HEIGHT_PX = 116;
const AUTOMATION_INSTRUCTIONS_MAX_HEIGHT_PX = 156;

interface AutomationInstructionsComposerProps {
  invalid?: boolean;
  children: ReactNode;
}

/**
 * Shared interaction contract for feature triggers at the bottom of Instructions.
 * Scheduled and Off-Peak forms previously used separate hover, focus-within, and corner-radius rules for their expanded states,
 * making the same feature appear as a pill/square and use inconsistent open backgrounds across automation types.
 * Use semantic rem-based line-height classes to avoid compressing text when the interface font size changes.
 */
export const AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME =
  "h-7 rounded-full text-ui-base font-normal leading-5 text-foreground-subtle hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground";

/**
 * Input content on Scheduled and Off-Peak settings pages consistently uses a 14px body font.
 * The pages previously maintained separate title, schedule, and Instructions sizes, with some hourly schedule branches falling back to 12px.
 */
export const AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME = "text-ui-base leading-5";

/**
 * Shared composite Instructions input for Automations.
 * The textarea provides the standard Input outline; the parent supplies only the toolbar surface layer.
 * Geometry, surface layering, and global Input outline states are centralized here; callers provide only field state and toolbar content.
 */
export function AutomationInstructionsComposer({
  invalid = false,
  children,
}: AutomationInstructionsComposerProps) {
  return (
    <div
      data-invalid={invalid || undefined}
      className="flex min-h-39 flex-col overflow-hidden rounded-xl border-0 bg-surface @container/composer"
    >
      {children}
    </div>
  );
}

export function AutomationInstructionsTextarea({
  rows = 5,
  onInput,
  value,
  ...props
}: Omit<ComponentProps<"textarea">, "className" | "ref">) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAutomaticHeightRef = useRef<number | null>(null);
  const resizeToContent = useCallback((textarea: HTMLTextAreaElement) => {
    const currentHeight = Number.parseFloat(textarea.style.height);
    const lastAutomaticHeight = lastAutomaticHeightRef.current;
    const hasManualHeight =
      lastAutomaticHeight !== null &&
      Number.isFinite(currentHeight) &&
      Math.abs(currentHeight - lastAutomaticHeight) > 1;
    const contentHeight = textarea.scrollHeight;

    // Auto-grow used to overwrite height on every input, immediately discarding a height set by dragging on Desktop.
    // When the manual height differs from the previous automatic height, maintain only internal scrolling and preserve the user's size choice.
    if (hasManualHeight) {
      textarea.style.overflowY = contentHeight > currentHeight ? "auto" : "hidden";
      return;
    }

    // Keep auto-grow when there has been no manual resize: short content returns to 116px, about 7 lines cap at 156px,
    // and longer content scrolls only inside the body area.
    textarea.style.height = `${AUTOMATION_INSTRUCTIONS_MIN_HEIGHT_PX}px`;
    const automaticHeight = Math.min(
      Math.max(contentHeight, AUTOMATION_INSTRUCTIONS_MIN_HEIGHT_PX),
      AUTOMATION_INSTRUCTIONS_MAX_HEIGHT_PX,
    );
    textarea.style.height = `${automaticHeight}px`;
    lastAutomaticHeightRef.current = automaticHeight;
    textarea.style.overflowY =
      contentHeight > AUTOMATION_INSTRUCTIONS_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    if (textareaRef.current) {
      resizeToContent(textareaRef.current);
    }
  }, [resizeToContent, value]);

  const handleInput = (event: InputEvent<HTMLTextAreaElement>) => {
    resizeToContent(event.currentTarget);
    onInput?.(event);
  };

  return (
    <textarea
      {...props}
      ref={textareaRef}
      value={value}
      rows={rows}
      onInput={handleInput}
      className={cn(
        "h-29 min-h-29 max-h-39 shrink-0 resize-none overflow-y-hidden rounded-xl border border-input-border bg-input p-3 text-foreground outline-none transition-colors placeholder:text-ui-base placeholder:text-foreground-subtlest hover:border-input-border-hover focus:border-input-border-focused focus:bg-input-focused focus:outline-none aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
        AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
      )}
    />
  );
}

export function AutomationInstructionsToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-0 p-1.5 sm:h-10 sm:flex-nowrap">
      {children}
    </div>
  );
}
