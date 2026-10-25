import { ModelSelectionFacade, type ProviderRegistryFacadeSource } from "@zcode/provider";
import {
  isBuiltinModelProviderId,
  isChatGptPlanProviderId,
  isStartPlanModelProviderId,
  OFF_PEAK_PROVIDER_IDS,
} from "@zcode/shared";
import { resolveLegacyReasoningLevel } from "./legacy-reasoning-level.js";

/** Host and managed Worker share identity classification; resolution remains the responsibility of the pure Provider Facade. */
export function createNodeModelSelectionFacade(
  source: ProviderRegistryFacadeSource,
): ModelSelectionFacade {
  return new ModelSelectionFacade(
    source,
    (providerId) => {
      // Start is resolved by its real ID; it must not participate in paid-connection uniqueness checks or be mapped to a paid quota.
      if (isStartPlanModelProviderId(providerId)) return "ordinary";
      if (isChatGptPlanProviderId(providerId)) return "chatgpt-plan";
      if (isBuiltinModelProviderId(providerId)) return "account-plan";
      if (Object.values(OFF_PEAK_PROVIDER_IDS).some((id) => id === providerId))
        return "account-offpeak";
      return "ordinary";
    },
    resolveLegacyReasoningLevel,
  );
}
