import { useEffect, useState, type ComponentType, type SVGProps } from "react";
import {
  DYNAMIC_WORKFLOW_MODES,
  isDynamicWorkflowOffered,
  normalizeDynamicWorkflowMode,
  TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM,
  TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_TRIGGER,
  testId,
  type AppSettings,
  type DynamicWorkflowMode,
} from "@zcode/shared";
import {
  DynamicWorkflowAlwaysOnIcon,
  DynamicWorkflowOffIcon,
  DynamicWorkflowOnCommandIcon,
} from "@/components/icons/dynamicWorkflowModeIcons.js";
import {
  Select,
  SelectContent,
  SelectRichItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import type { DynamicWorkflowAvailabilitySnapshot } from "@/store/dynamicWorkflowAvailabilityStore.js";

const MODE_ICONS: Record<DynamicWorkflowMode, ComponentType<SVGProps<SVGSVGElement>>> = {
  disabled: DynamicWorkflowOffIcon,
  onDemand: DynamicWorkflowOnCommandIcon,
  alwaysOn: DynamicWorkflowAlwaysOnIcon,
};

/**
 * What the settings row should display (docs/dynamic-workflow/launch.md "The user's choice"). Returns null
 * while the snapshot is loading, on read failure, or when the server does not offer the feature: the row
 * is not rendered and the staged rollout stays invisible to the user. Both the value and the "default"
 * come from the Host-computed result; the renderer does not apply the user's choice itself.
 */
export function resolveDynamicWorkflowModeSettingView(
  snapshot: DynamicWorkflowAvailabilitySnapshot,
): { value: DynamicWorkflowMode; offeredMode: DynamicWorkflowMode } | null {
  const config = snapshot.config;
  if (snapshot.status !== "ready" || !config || !isDynamicWorkflowOffered(config)) return null;
  return { value: config.mode, offeredMode: config.offeredMode };
}

/** Selecting the server-provided mode equals deleting the choice (empty-string sentinel, normalized to deletion by the service layer); installs keep following server flips. */
export function buildDynamicWorkflowModePatch(
  next: DynamicWorkflowMode,
  offeredMode: DynamicWorkflowMode,
): Pick<AppSettings, "dynamicWorkflowMode"> {
  return {
    dynamicWorkflowMode: (next === offeredMode ? "" : next) as AppSettings["dynamicWorkflowMode"],
  };
}

export function DynamicWorkflowModeSetting() {
  const { intl } = useZCodeIntl();
  const { update } = useSettings();
  const view = resolveDynamicWorkflowModeSettingView(useDynamicWorkflowAvailability());
  // Persist the choice → Root notifies the Host to re-push the policy → snapshot reread; the whole chain takes several hundred ms; the trigger shows the just-selected value meanwhile.
  // A visible row means the feature is offered, so the effective mode must equal the user's choice; the optimistic and final values match.
  const [pending, setPending] = useState<DynamicWorkflowMode | null>(null);
  const settledValue = view?.value;
  useEffect(() => {
    if (pending !== null && settledValue === pending) setPending(null);
  }, [pending, settledValue]);

  if (!view) return null;
  const value = pending ?? view.value;
  const label = intl.formatMessage({ id: "settings.dynamicWorkflow" });

  const handleValueChange = async (rawValue: string) => {
    const next = normalizeDynamicWorkflowMode(rawValue);
    if (!next || next === value) return;
    setPending(next);
    try {
      await update(buildDynamicWorkflowModePatch(next, view.offeredMode));
    } catch (error) {
      setPending(null);
      logger.warn("[settings] 保存动态工作流模式失败", { error: String(error) });
      toast(intl.formatMessage({ id: "settings.dynamicWorkflow.saveError" }));
    }
  };

  // No wrapping element: SettingsRow draws row separators via first:border-t-0; wrapping would make this the first row and drop the top border.
  return (
    <SettingsRow
      label={label}
      description={intl.formatMessage({ id: "settings.dynamicWorkflowDescription" })}
      // Bugfix: the default control column is only 192px and flex would squeeze the 260px trigger down to 192px, making the list that follows the trigger width too narrow;
      // the wide layout gives a 280px control column (label moves below on phone widths), so trigger and list both render at the design's 260px.
      controlLayout="wide"
      control={
        <Select value={value} onValueChange={(next) => void handleValueChange(next)}>
          <SelectTrigger
            size="lg"
            className="w-[260px] min-w-0 justify-between"
            aria-label={label}
            data-testid={TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_TRIGGER}
          >
            <SelectValue />
          </SelectTrigger>
          {/* Two-line options expand with popper below the trigger; item-aligned would cover this row's label and description.
              Bugfix: popper only sets min-width, so the list width would be blown out by the longest description line; fix it to the trigger width (260px),
              letting descriptions wrap inside the list, matching the design. */}
          <SelectContent
            position="popper"
            align="end"
            sideOffset={4}
            className="w-(--radix-select-trigger-width)"
          >
            {DYNAMIC_WORKFLOW_MODES.map((mode) => {
              const Icon = MODE_ICONS[mode];
              return (
                <SelectRichItem
                  key={mode}
                  value={mode}
                  data-testid={testId(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM, mode)}
                  icon={<Icon className="size-4.5" />}
                  title={intl.formatMessage({ id: `settings.dynamicWorkflow.option.${mode}` })}
                  titleAdornment={
                    mode === view.offeredMode ? (
                      <span className="inline-flex h-4 shrink-0 items-center rounded-sm bg-tag px-1 text-ui-xs font-medium text-foreground-subtle">
                        {intl.formatMessage({ id: "settings.dynamicWorkflow.defaultTag" })}
                      </span>
                    ) : null
                  }
                  description={intl.formatMessage({
                    id: `settings.dynamicWorkflow.option.${mode}.description`,
                  })}
                />
              );
            })}
          </SelectContent>
        </Select>
      }
    />
  );
}
