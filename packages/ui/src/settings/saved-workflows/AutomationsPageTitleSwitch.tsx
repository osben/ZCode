import { useCallback, type KeyboardEvent } from "react";
import { TID_AUTOMATIONS_PAGE_TAB, testId } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** The two top-level tabs for the Automations page. */
export type AutomationsPageTab = "automation" | "workflow";

const AUTOMATIONS_PAGE_TABS: readonly AutomationsPageTab[] = ["automation", "workflow"];

/**
 * Title for the Automations page. When the dynamic-workflow rollout is off,
 * the page has only Automations, so use the flat h1 from before the Workflow tab was introduced—do not leave a one-item tablist
 * or keep arrow-key switching in place.
 */
export function AutomationsPageTitle({
  workflowTabEnabled,
  value,
  onValueChange,
}: {
  workflowTabEnabled: boolean;
  value: AutomationsPageTab;
  onValueChange: (tab: AutomationsPageTab) => void;
}) {
  const { intl } = useZCodeIntl();
  if (!workflowTabEnabled) {
    // Use the same typography as the switch state: 30/34 page-title hierarchy, which should not change depending on whether the switch is present.
    return (
      <h1 className="text-[30px] font-medium leading-[34px] tracking-[0.114px] text-foreground">
        {intl.formatMessage({ id: "settings.automations.title" })}
      </h1>
    );
  }
  return <AutomationsPageTitleSwitch value={value} onValueChange={onValueChange} />;
}

/**
 * The page title is itself the switch: two 30px labels, "Automations / Workflows," side by side, with the inactive one in a secondary color.
 * Do not add another row of tabs under the title; the Scheduled / Off-Peak pill row stays inside Automations, with a separate visual for each level.
 * Use the title hierarchy from the original AutomationsSection h1.
 */
export function AutomationsPageTitleSwitch({
  value,
  onValueChange,
}: {
  value: AutomationsPageTab;
  onValueChange: (tab: AutomationsPageTab) => void;
}) {
  const { intl } = useZCodeIntl();
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = AUTOMATIONS_PAGE_TABS.indexOf(value);
      const next =
        AUTOMATIONS_PAGE_TABS[
          (index + (event.key === "ArrowRight" ? 1 : -1) + AUTOMATIONS_PAGE_TABS.length) %
            AUTOMATIONS_PAGE_TABS.length
        ]!;
      onValueChange(next);
    },
    [onValueChange, value],
  );

  return (
    <div
      role="tablist"
      aria-label={intl.formatMessage({ id: "automations.pageTab.ariaLabel" })}
      className="flex items-baseline gap-5"
      onKeyDown={handleKeyDown}
    >
      {AUTOMATIONS_PAGE_TABS.map((tab) => {
        const active = tab === value;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            data-testid={testId(TID_AUTOMATIONS_PAGE_TAB, tab)}
            onClick={() => onValueChange(tab)}
            className={cn(
              "rounded-md text-[30px] font-medium leading-[34px] tracking-[0.114px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
              active ? "text-foreground" : "text-foreground-subtle hover:text-foreground",
            )}
          >
            {intl.formatMessage({ id: `automations.pageTab.${tab}` })}
          </button>
        );
      })}
    </div>
  );
}
