import { BUILTIN_MODEL_PROVIDER_IDS, resolveZaiBusinessBaseUrl } from "@zcode/shared";
import type { CodingPlanSubscriptionProviderId } from "@zcode/shared";
import {
  BigModelCodingPlanSubscriptionProvider,
  createZaiLoginAuthHeaders,
} from "./bigmodelCodingPlanSubscriptionProvider.js";

/**
 * ZaiCodingPlanSubscriptionProvider
 *
 * Historically, Team Plan enterprise pricing existed only for the bigmodel family. The service layer sent all
 * enterprise read requests directly to BigModelCodingPlanSubscriptionProvider, hard-coding the bigmodel
 * domain + bigmodelCodingPlan providerId + bigmodel OAuth token. Even when the zai family created
 * a Team Plan connection key, it had no independent pricing source (dead code).
 *
 * Make the full Team Plan flow symmetric between zai and bigmodel:
 * this class extends BigModelCodingPlanSubscriptionProvider and overrides only the family-specific enterprise read path:
 *   - providerId  → zaiCodingPlan
 *   - Business domain   → resolveZaiCodingPlanHost() (configured ZAI Business origin in tests / api.z.ai in production)
 *   - OAuth token → loadZaiAuthorization() (oauth:zai:access_token; reuses the parent implementation)
 *   - Authorization headers → createZaiLoginAuthHeaders()
 *
 * Scope: only the family-specific behavior for getEnterprisePricing + enrichEnterprisePricingTeamProjects
 * (through protected virtual methods). The enterprise purchase flow (balance/order/pending/cancel/
 * continue/status) remains on the parent's bigmodel domain, matching the zai Team Plan product boundary of "pricing + team context reads only."
 *
 * Reuse the parent for all other methods (batchPreview/preview/productInfo/checkPayment/checkPendingOrders/
 * Stripe/PayPal/createSign/updateSign/staticConfigs):
 *   - Purchase operations already route dynamically by request.providerId in the parent resolveEndpointConfig
 *     (zai uses /api/pay + zai host + zai token; bigmodel uses /api/biz + bigmodel host + bigmodel token).
 *   - staticConfigs is platform-level client/configuration data and is independent of family.
 */
export class ZaiCodingPlanSubscriptionProvider extends BigModelCodingPlanSubscriptionProvider {
  protected codingPlanProviderId(): CodingPlanSubscriptionProviderId {
    return BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
  }

  protected resolveFamilyEnterpriseHost(): string {
    return resolveZaiCodingPlanHost();
  }

  protected async loadFamilyEnterpriseToken(): Promise<string> {
    // Reuse the parent loadZaiAuthorization; credential key = oauth:zai:access_token.
    return this.loadZaiAuthorization();
  }

  protected createFamilyEnterpriseAuthHeaders(token: string): Record<string, string> {
    return createZaiLoginAuthHeaders(token);
  }
}

/**
 * zai business domain (/api/biz and /api/pay).
 * Equivalent to the parent's file-scoped resolveZaiCodingPlanHost; kept separate because that function is not exported.
 * Must remain aligned with the parent implementation and follow the product environment (configured ZAI Business origin in tests / api.z.ai in production).
 */
function resolveZaiCodingPlanHost(): string {
  return resolveZaiBusinessBaseUrl(process.env);
}
