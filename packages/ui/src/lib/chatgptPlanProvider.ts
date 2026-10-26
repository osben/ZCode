import type { ProviderConfigObject } from "@zcode/provider";
import { isChatGptPlanProviderId } from "@zcode/shared";

/**
 * The ChatGPT plan brand mark, identical to the catalog template's `config.logo`. Surfaces with
 * no runtime provider entry (zero signed-in accounts) use it directly.
 */
export const CHATGPT_PLAN_PROVIDER_LOGO: NonNullable<ProviderConfigObject["logo"]> = {
  type: "builtin",
  key: "openai",
};

/**
 * The ChatGPT plan (official OpenAI SIWC) subscription provider family: the builtin template
 * id plus the runtime per-account entries (`account:chatgpt-plan:<accountKey>`).
 */
export function isChatGptPlanSubscriptionProviderId(providerId: string): boolean {
  return isChatGptPlanProviderId(providerId);
}
