import { Activity, List, ListChecks, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { ClientSceneLucideIcon } from "@/components/ClientSceneLucideIcon.js";

export type OffPeakTemplateIconName =
  | "standupGitSummary"
  | "ciFlakyReport"
  | "documentationSyncCheck"
  | "customize"
  | "standupGitSummarySecondary"
  | "followUpMonitor";

const OFF_PEAK_TEMPLATE_ICONS: Record<OffPeakTemplateIconName, LucideIcon> = {
  standupGitSummary: List,
  ciFlakyReport: Activity,
  // Add the documentation-sync template after merging release/current; reuse the checklist semantics to prevent catalog/icon union types from drifting.
  documentationSyncCheck: ListChecks,
  customize: SlidersHorizontal,
  standupGitSummarySecondary: List,
  followUpMonitor: ListChecks,
};

/** Semantic icon mapping for the Automations case; the home-page case always uses Moon. */
export function OffPeakTemplateIcon({
  className,
  iconName,
  name,
}: {
  className?: string;
  iconName?: string;
  name: OffPeakTemplateIconName;
}) {
  const Icon = OFF_PEAK_TEMPLATE_ICONS[name];
  return (
    <ClientSceneLucideIcon
      className={className}
      name={iconName}
      aria-hidden="true"
      size={16}
      strokeWidth={2}
      fallback={
        <Icon
          aria-hidden="true"
          className={className}
          data-off-peak-template-icon={name}
          size={16}
          strokeWidth={2}
        />
      }
    />
  );
}
