import { isBuiltinModelProviderId, isStartPlanModelProviderId } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { logger } from "@/logger.js";

export interface AccountConnectionLoss {
  readonly providerId: string;
  readonly connectionKey: string;
  /** A new account/connection or restored availability immediately invalidates the old suggestion, including any in-flight query. */
  readonly isCurrent: () => boolean;
}

/** Compare only confirmed states for the same connection; a manually selected unavailable plan must not trigger automatic fallback. */
export function createAccountConnectionRefreshObserver(
  notify: (event: AccountConnectionLoss) => void | Promise<void>,
) {
  let disposed = false;
  let latestRevision = -1;
  let key: string | undefined;
  let previous: string | undefined;
  let generation = 0;
  return {
    async accept(view: ProviderSettingsView) {
      if (disposed || view.revision < latestRevision) return;
      latestRevision = view.revision;
      const current = view.providers.find(
        (p) =>
          p.accountState?.current === true &&
          isBuiltinModelProviderId(p.providerId) &&
          !isStartPlanModelProviderId(p.providerId),
      );
      const nextKey = current?.accountState?.connectionKey;
      const next = current?.accountState?.availability;
      if (nextKey !== key) {
        key = nextKey;
        previous = undefined;
        generation++;
      }
      // Do not infer identity when an older Host has no identity facts; unknown must not erase an existing confirmed baseline.
      if (!key || !current || !next || next === "unknown") return;
      const lost = (previous === "available" || previous === "pending") && next === "unavailable";
      if (next !== previous) generation++;
      previous = next;
      if (!lost) return;
      const eventGeneration = generation;
      try {
        await notify({
          providerId: current.providerId,
          connectionKey: key,
          isCurrent: () =>
            !disposed && generation === eventGeneration && previous === "unavailable",
        });
      } catch (error) {
        // A failed availability query is not a new invalidation event; repeated View renders must not create endless notifications/retries.
        logger.lifecycle.warn("[AccountConnection] 生成套餐失效提示失败，保留当前选择", { error });
      }
    },
    invalidate() {
      key = undefined;
      previous = undefined;
      generation++;
    },
    dispose() {
      disposed = true;
      generation++;
    },
  };
}
