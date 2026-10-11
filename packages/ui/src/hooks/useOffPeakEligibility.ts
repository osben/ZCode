import { useEffect } from "react";
import type { AppSettings } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { useOffPeakTaskStore } from "@/store/offPeakTaskStore.js";

/** The two off-peak entry points share initialization, connection, and Registry notification boundaries; components do not store eligibility separately. */
export function useOffPeakEligibility(
  settings: AppSettings | null | undefined,
  registryRevision: number | undefined,
): void {
  const { offPeakTaskService, codingPlanSubscriptionService } = useServices();
  const initialize = useOffPeakTaskStore((state) => state.initialize);
  const refresh = useOffPeakTaskStore((state) => state.refreshCodingPlanSupport);
  const family = settings?.providerFamilyDomain;
  const connection = family ? settings?.providerFamilyConnectionSelections?.[family] : undefined;
  const freshnessKey = settings
    ? JSON.stringify([registryRevision, family, connection])
    : undefined;

  useEffect(() => {
    void initialize({ offPeakTaskService, codingPlanSubscriptionService });
  }, [initialize, offPeakTaskService, codingPlanSubscriptionService]);

  useEffect(() => {
    if (freshnessKey === undefined) return;
    // A Settings change is only an invalidation signal; the ProviderSettings View revision comes from a completed Registry publish.
    // Recheck even if selection is unchanged, since the account may become ready later; the Store deduplicates notifications from both entry points by key.
    void refresh(offPeakTaskService, freshnessKey);
  }, [freshnessKey, offPeakTaskService, refresh]);
}
