import { useId } from "react";
import { APP_USAGE_MAX_WINDOW_DAYS } from "@zcode/shared";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  APP_USAGE_PRESETS,
  type AppUsageGranularity,
  type AppUsagePreset,
  type CustomRangeValidation,
} from "@/settings/usage-stats/appUsageRangeViewModel.js";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
} from "@/settings/usage-stats/usageStatsUiParts.js";

const GRANULARITIES: AppUsageGranularity[] = ["day", "week", "month"];

export interface AppUsageRangeControlsProps {
  preset: AppUsagePreset;
  onPresetChange: (preset: AppUsagePreset) => void;
  customFrom: string;
  customTo: string;
  onCustomChange: (range: { from: string; to: string }) => void;
  customValidation: CustomRangeValidation;
  today: string;
  compare: boolean;
  onCompareChange: (compare: boolean) => void;
  granularity: AppUsageGranularity;
  onGranularityChange: (granularity: AppUsageGranularity) => void;
  showGranularity: boolean;
}

export function AppUsageRangeControls(props: AppUsageRangeControlsProps) {
  const { intl } = useZCodeIntl();
  const compareId = useId();
  const showCompare = props.preset !== "all";
  const validationMessageId =
    props.preset === "custom" && props.customValidation !== "ok"
      ? `settings.usage.customRange.${props.customValidation}`
      : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.appUsageRangeTitle" })}
        </div>
        {/* Six pills do not fit a phone width; scroll the strip instead of wrapping it. */}
        <div className="max-w-full overflow-x-auto">
          <Tabs
            value={props.preset}
            onValueChange={(value) => props.onPresetChange(value as AppUsagePreset)}
            className="shrink-0"
          >
            <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
              {APP_USAGE_PRESETS.map((option) => (
                <TabsTrigger key={option} value={option} className={USAGE_STATS_TABS_TRIGGER_CLASS}>
                  {intl.formatMessage({ id: `settings.usage.range.${option}` })}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      {props.preset === "custom" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.usage.customRange.from" })}
            <Input
              type="date"
              size="sm"
              className="w-auto"
              value={props.customFrom}
              max={props.today}
              aria-invalid={props.customValidation !== "ok"}
              onChange={(event) =>
                props.onCustomChange({ from: event.target.value, to: props.customTo })
              }
            />
          </label>
          <label className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.usage.customRange.to" })}
            <Input
              type="date"
              size="sm"
              className="w-auto"
              value={props.customTo}
              max={props.today}
              aria-invalid={props.customValidation !== "ok"}
              onChange={(event) =>
                props.onCustomChange({ from: props.customFrom, to: event.target.value })
              }
            />
          </label>
          {validationMessageId ? (
            <span role="alert" className="text-ui-sm text-destructive">
              {intl.formatMessage({ id: validationMessageId }, { days: APP_USAGE_MAX_WINDOW_DAYS })}
            </span>
          ) : null}
        </div>
      ) : null}

      {showCompare || props.showGranularity ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {showCompare ? (
            <div className="flex items-center gap-2">
              <Switch
                id={compareId}
                size="sm"
                checked={props.compare}
                onCheckedChange={props.onCompareChange}
              />
              <label htmlFor={compareId} className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "settings.usage.compare.label" })}
              </label>
            </div>
          ) : (
            <span />
          )}
          {props.showGranularity ? (
            <Tabs
              value={props.granularity}
              onValueChange={(value) => props.onGranularityChange(value as AppUsageGranularity)}
              className="shrink-0"
              aria-label={intl.formatMessage({ id: "settings.usage.granularity.label" })}
            >
              <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
                {GRANULARITIES.map((option) => (
                  <TabsTrigger
                    key={option}
                    value={option}
                    className={USAGE_STATS_TABS_TRIGGER_CLASS}
                  >
                    {intl.formatMessage({ id: `settings.usage.granularity.${option}` })}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
