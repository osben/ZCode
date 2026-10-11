/**
 * Small pieces shared by the four preset renderers: labels contract, empty state, field labels, and reveal-animation class names.
 *
 * These components **never use i18n directly**: the run side pane and `workflow-artifact` tab each own intl
 * and pass translated copy through `labels`. The renderers should be reusable in the side pane, tab, and (in the future) hub detail page;
 * callers decide the wording for each context, while looking up message IDs inside the components would couple all three.
 */

import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

/** Three translations the caller must provide (all other copy comes from labels / titles written by the spec author). */
export type PresetLabels = {
  /** Name for the board column that receives statuses not listed in columns. */
  otherColumn: string;
  /** Message shown before any data has arrived. */
  empty: string;
  /** “N items” — row count in a table or card count on a board. */
  itemsCount: (count: number) => string;
};

/**
 * Reveal animation for new items. Stable React keys + play only on **mount**, so existing items do not replay when new ones arrive;
 * disabled entirely under `motion-reduce`.
 */
export const REVEAL_ANIMATION_CLASS =
  "animate-in fade-in duration-300 ease-out motion-reduce:animate-none";

/** Placeholder when there is no data. Keep its presence minimal: a board may naturally be empty while running. */
export function PresetEmpty({ label, compact }: { label: string; compact?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-lg border border-dashed border-border text-foreground-subtlest",
        compact ? "px-2 py-3 text-ui-xs" : "px-4 py-8 text-ui-sm",
      )}
      data-testid="artifact-preset-empty"
    >
      {label}
    </div>
  );
}

/** Consistent field name + unit format: put the unit in parentheses after the label rather than repeating it for every value (dataviz convention). */
export function fieldHeading(label: string, unit?: string): string {
  return unit ? `${label} (${unit})` : label;
}

/**
 * Title bar for the full-size layout: the spec author writes title / description in the user's language, and this renders them verbatim.
 * If all three values are absent, the whole block is **omitted** (including its margins), so spacing belongs here instead of in a wrapper div at the call site.
 */
export function PresetHeading({
  title,
  description,
  trailing,
  className,
}: {
  title?: string;
  description?: string;
  trailing?: ReactNode;
  className?: string;
}) {
  if (!title && !description && !trailing) {
    return null;
  }
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        {title ? (
          <div className="truncate text-ui-base font-medium text-foreground">{title}</div>
        ) : null}
        {description ? (
          <div className="mt-0.5 text-ui-sm text-foreground-subtle">{description}</div>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}
