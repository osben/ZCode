import { type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";

/**
 * Header bar for collapsible sections on the workflow run detail page.
 *
 * The pending-questions and artifacts sections share this bar: their collapse semantics are identical, and separate implementations would eventually diverge in corner radius, hover color,
 * or chevron angle. It is extracted verbatim from the former Script-section toggle, so this bar
 * **introduces no new visual language**. Results / event log / Script sections have been removed;
 * the two remaining callers have opposite default states (questions collapsed, artifacts expanded), which belongs to each section, not this component.
 *
 * The header handles only expansion/collapse; each section owns its content fetching, gating, and layout.
 *
 * **Intentionally not memoized**: callers are already memoized components and rerender only when their state or projection changes —
 * exactly when this bar's `expanded`/`label`/`trailing` also changes. Wrapping it in memo would force `onToggle` and
 * `trailing` into `useCallback`/`useMemo` (as required by the reactStableReferences guard),
 * adding a comparison layer that can never hit.
 */
export function WorkflowRunSectionToggle({
  expanded,
  label,
  onToggle,
  testId,
  title,
  trailing,
}: {
  expanded: boolean;
  /** aria-label: “Expand X” / “Collapse X” according to current state; `title` provides the visible heading. */
  label: string;
  onToggle: () => void;
  testId: string;
  title: string;
  /**
   * Supplementary information on the right side of the header (count, loading indicator, etc.). It remains visible while collapsed — collapsing must not hide
   * whether this section contains anything.
   */
  trailing?: ReactNode;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-label={label}
      className="flex w-full items-center gap-1.5 px-4 py-2 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40"
      data-testid={testId}
      onClick={onToggle}
      type="button"
    >
      <ChevronRightIcon
        className={cn(
          "size-3.5 shrink-0 text-foreground-subtlest transition-transform",
          expanded ? "rotate-90" : undefined,
        )}
      />
      <span className="min-w-0 flex-1 truncate text-ui-xs font-medium text-foreground-subtle">
        {title}
      </span>
      {trailing}
    </button>
  );
}
