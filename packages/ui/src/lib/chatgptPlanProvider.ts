import { isChatGptPlanProviderId } from "@zcode/shared";

/**
 * The ChatGPT plan (official OpenAI SIWC) subscription provider family: the builtin template
 * id plus the runtime per-account entries (`account:chatgpt-plan:<accountKey>`).
 */
export function isChatGptPlanSubscriptionProviderId(providerId: string): boolean {
  return isChatGptPlanProviderId(providerId);
}
