import { ChevronDown } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AppUsageFacets, AppUsageFilters } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { resolveModelLabel } from "@/settings/usage-stats/usageStatsUiParts.js";

type FilterKey = keyof AppUsageFilters;
type UsageIntl = ReturnType<typeof useZCodeIntl>["intl"];

interface FilterOption {
  value: string;
  label: string;
  title?: string;
}

const KNOWN_QUERY_SOURCES = new Set(["main_turn", "subagent", "workflow_child"]);

function workspaceLabel(intl: UsageIntl, key: string): FilterOption {
  if (key === "") {
    return {
      value: key,
      label: intl.formatMessage({ id: "settings.usage.filter.unknownWorkspace" }),
    };
  }
  const trimmed = key.replace(/[\\/]+$/, "");
  const name = trimmed.split(/[\\/]/).pop() || trimmed;
  return { value: key, label: name, title: key };
}

function buildOptions(intl: UsageIntl, facets: AppUsageFacets): Record<FilterKey, FilterOption[]> {
  return {
    modelIds: facets.models.map((value) => ({ value, label: resolveModelLabel(intl, value) })),
    providerIds: facets.providers.map((value) => ({ value, label: value })),
    querySources: facets.querySources.map((value) => ({
      value,
      label: KNOWN_QUERY_SOURCES.has(value)
        ? intl.formatMessage({ id: `settings.usage.source.${value}` })
        : value.replace(/_/g, " "),
    })),
    workspaceKeys: facets.workspaces.map((value) => workspaceLabel(intl, value)),
  };
}

const FILTER_ORDER: Array<{ key: FilterKey; labelId: string }> = [
  { key: "modelIds", labelId: "settings.usage.filter.models" },
  { key: "providerIds", labelId: "settings.usage.filter.providers" },
  { key: "querySources", labelId: "settings.usage.filter.sources" },
  { key: "workspaceKeys", labelId: "settings.usage.filter.workspaces" },
];

function FilterMenu({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: FilterOption[];
  selected: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const { intl } = useZCodeIntl();
  if (options.length === 0) {
    return null;
  }
  const toggle = (value: string, checked: boolean) =>
    onChange(checked ? [...selected, value] : selected.filter((item) => item !== value));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            "h-7 gap-1 rounded-full bg-surface px-2.5 text-ui-sm font-medium",
            selected.length > 0 && "text-foreground",
          )}
        >
          {label}
          {selected.length > 0 ? (
            <span className="font-mono tabular-nums">{selected.length}</span>
          ) : null}
          <ChevronDown className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-1">
        <div role="group" aria-label={label} className="max-h-64 space-y-0.5 overflow-y-auto">
          {options.map((option) => (
            <label
              key={option.value}
              title={option.title}
              className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-ui-sm hover:bg-surface"
            >
              <Checkbox
                checked={selected.includes(option.value)}
                onCheckedChange={(checked) => toggle(option.value, checked === true)}
              />
              <span className="min-w-0 truncate">{option.label}</span>
            </label>
          ))}
        </div>
        {selected.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 justify-start text-ui-sm"
            onClick={() => onChange([])}
          >
            {intl.formatMessage({ id: "settings.usage.filter.clear" })}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function hasActiveAppUsageFilters(filters: AppUsageFilters): boolean {
  return FILTER_ORDER.some(({ key }) => (filters[key]?.length ?? 0) > 0);
}

export function AppUsageFilterBar({
  facets,
  filters,
  onChange,
}: {
  facets: AppUsageFacets;
  filters: AppUsageFilters;
  onChange: (filters: AppUsageFilters) => void;
}) {
  const { intl } = useZCodeIntl();
  const options = buildOptions(intl, facets);
  const active = hasActiveAppUsageFilters(filters);
  const tokenScopedActive =
    (filters.modelIds?.length ?? 0) +
      (filters.providerIds?.length ?? 0) +
      (filters.querySources?.length ?? 0) >
    0;
  const hasAnyOptions = FILTER_ORDER.some(({ key }) => options[key].length > 0);
  if (!hasAnyOptions) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {FILTER_ORDER.map(({ key, labelId }) => (
          <FilterMenu
            key={key}
            label={intl.formatMessage({ id: labelId })}
            options={options[key]}
            selected={filters[key] ?? []}
            onChange={(values) =>
              onChange({ ...filters, [key]: values.length > 0 ? values : undefined })
            }
          />
        ))}
        {active ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-full px-2.5 text-ui-sm text-foreground-subtle"
            onClick={() => onChange({})}
          >
            {intl.formatMessage({ id: "settings.usage.filter.clearAll" })}
          </Button>
        ) : null}
      </div>
      {tokenScopedActive ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usage.filter.scopeNote" })}
        </p>
      ) : null}
    </div>
  );
}
