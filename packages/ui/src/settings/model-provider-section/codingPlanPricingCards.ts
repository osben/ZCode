import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";

// Dead-code cleanup: the native purchase component CodingPlanPricingCards and its resolver were removed with
// CodingPlanPurchasePanel (the purchase flow moved to an embedded official-site webview).
// This file retains only the login parameter type and plan-product source resolution still used by settings.

export type CodingPlanLoginOptions = {
  forceOAuth?: boolean;
};

export function resolveCodingPlanUpgradeProductsProviderId(
  providerId: CodingPlanProviderId,
): CodingPlanProviderId {
  // Start Plan is a free entry point; the coding-plan list should display the original paid Z.AI Coding Plan products directly.
  // Continuing to use the Start Plan providerId would show the free Start SKU again as a purchasable plan.
  if (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan) {
    return BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
  }

  // BigModel Start Plan is also a free entry point; when expanding upgrade options, use
  // the BigModel paid Coding Plan product source instead of requesting free SKUs with the Start providerId.
  return providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
    ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
    : providerId;
}
