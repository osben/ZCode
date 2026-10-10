import { useEffect, useMemo } from "react";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
import {
  useDynamicWorkflowAvailabilityStore,
  type DynamicWorkflowAvailabilitySnapshot,
} from "@/store/dynamicWorkflowAvailabilityStore.js";

/**
 * Read the dynamic-workflow rollout snapshot.
 * Read-only and does not issue requests: the loader in Root is the sole data owner. Consumers (automation page, run panel)
 * may be inside a workspace-level ServiceProvider (with a remote Host accessor); letting them fetch independently could
 * overwrite the app-level snapshot.
 */
export function useDynamicWorkflowAvailability(): DynamicWorkflowAvailabilitySnapshot {
  // Subscribe field by field: a selector returning an object literal creates a new reference each time, which useSyncExternalStore treats as a change.
  const status = useDynamicWorkflowAvailabilityStore((state) => state.status);
  const enabled = useDynamicWorkflowAvailabilityStore((state) => state.enabled);
  const config = useDynamicWorkflowAvailabilityStore((state) => state.config);
  return useMemo(() => ({ status, enabled, config }), [config, enabled, status]);
}

/**
 * Fetch at the app-session level, mounted once in Root. Retry when the service changes (for example, after mobile `/remote`
 * completes workspace bridging). Fetch and failure-retry rules are in dynamicWorkflowAvailabilityStore.
 */
export function useDynamicWorkflowAvailabilityLoader(
  service: ICodingPlanSubscriptionService,
): void {
  const ensureLoaded = useDynamicWorkflowAvailabilityStore((state) => state.ensureLoaded);
  useEffect(() => {
    void ensureLoaded(service);
  }, [ensureLoaded, service]);
}
