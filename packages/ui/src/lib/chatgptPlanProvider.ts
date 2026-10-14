import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";

/** The ChatGPT plan (official OpenAI SIWC) builtin subscription provider. */
export function isChatGptPlanSubscriptionProviderId(providerId: string): boolean {
  return providerId === BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan;
}
