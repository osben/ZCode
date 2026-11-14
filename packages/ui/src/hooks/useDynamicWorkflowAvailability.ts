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
 * 用户选择变化后的同步（docs/dynamic-workflow/launch.md「The user's choice」），挂在 Root 里一次。
 * 设置文件是选择的唯一来源；任何窗口写入后，共享设置广播让每个窗口的 Root 都读到新值，
 * 各自通知本窗口的 Host（转发给远程 Host、排队重发 CLI 策略），Host 记下选择即返回，随后重读快照；
 * 不等 CLI 应答，CLI 正忙时界面也不会停在旧模式。
 *   - 首次读到的值只是基线：启动时 Host 自己会读设置文件，不需要信号；
 *   - 多次变化串行：上一轮「信号 → 重读」完成后才开始下一轮，慢的重读不会盖掉新结果；
 *   - Host 同步失败仍重读：快照以 Host 当前算出的结果为准。
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
