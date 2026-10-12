import type { IUsageStatsService } from "@zcode/services";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";

/** Consumes the target Host's existing account view and entitlement owner; stores no balance or login state of its own. */
export function useStartPlanEntitlement(
  providerId: string,
  service: IUsageStatsService | undefined,
  refreshOnAccess = false,
) {
  const settings = useProviderSettingsView();
  return useUsageEntitlementWithService(service, {
    ...buildStartPlanEntitlementOptions(
      settings.state.status === "ready" ? settings.state.view : null,
      providerId,
    ),
    refreshOnMount: refreshOnAccess,
    mountRefreshReason: "access",
  });
}
