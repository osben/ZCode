import { useEffect, useMemo, useRef } from "react";
import type { ICodingPlanSubscriptionService, IZCodeAgentService } from "@zcode/services";
import type { DynamicWorkflowMode } from "@zcode/shared";
import { logger } from "@/logger.js";
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

/**
 * Synchronize after the user's selection changes (docs/dynamic-workflow/launch.md, “The user's
 * choice”), registered once in Root. The settings file is the sole source of the selection. After
 * any window writes it, the shared settings broadcast lets every Root read the new value; each
 * notifies its Host (resend CLI policy and forward to the remote Host), then the Host rereads the snapshot.
 * - The first value is only a baseline: Host reads the settings file at startup, so no signal is needed.
 * - Serialize repeated changes: start the next “signal → reread” only after the previous one finishes, so a slow reread cannot overwrite a newer result.
 * - Reread even if Host synchronization fails: the snapshot reflects the result currently computed by Host.
 */
export function useDynamicWorkflowUserModeSync(params: {
  settingsLoaded: boolean;
  userMode: DynamicWorkflowMode | undefined;
  zcodeAgentService: Pick<IZCodeAgentService, "syncDynamicWorkflowUserMode">;
  codingPlanSubscriptionService: ICodingPlanSubscriptionService;
}): void {
  const { settingsLoaded, userMode, zcodeAgentService, codingPlanSubscriptionService } = params;
  const reload = useDynamicWorkflowAvailabilityStore((state) => state.reload);
  const observedRef = useRef<{ userMode: DynamicWorkflowMode | undefined } | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!settingsLoaded) return;
    const observed = observedRef.current;
    observedRef.current = { userMode };
    if (observed === null || observed.userMode === userMode) return;
    chainRef.current = chainRef.current.then(async () => {
      try {
        await zcodeAgentService.syncDynamicWorkflowUserMode(userMode ? { mode: userMode } : {});
      } catch (error) {
        logger.warn("[dynamic-workflow] 用户选择同步到 Host 失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await reload(codingPlanSubscriptionService);
    });
  }, [codingPlanSubscriptionService, reload, settingsLoaded, userMode, zcodeAgentService]);
}
