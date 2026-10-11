import { applyDynamicWorkflowUserMode, type ApiClient } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { ICodingPlanSubscriptionService } from "./codingPlanSubscription.js";
import { BigModelCodingPlanSubscriptionProvider } from "./bigmodelCodingPlanSubscriptionProvider.js";
import type { ModelSelectionView } from "@zcode/provider";
import { ZaiCodingPlanSubscriptionProvider } from "./zaiCodingPlanSubscriptionProvider.js";

interface CodingPlanSubscriptionServiceDependencies {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load">;
  resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
  /**
   * Dynamic-workflow mode chosen by the user in Settings (launch.md "The user's choice"). Injected only
   * by assemblies that own settings authority (desktop local Host, web/standalone server); when absent,
   * the snapshot contains only the server-side "offer".
   */
  resolveDynamicWorkflowUserMode?: () => Promise<unknown>;
}

/**
 * The original service bound all calls directly to one BigModelCodingPlanSubscriptionProvider,
 * leaving the zai family without an independent Team Plan pricing source (dead code).
 *
 * Make the full Team Plan flow symmetric between zai and bigmodel:
 * hold both bigmodel and zai provider instances; route the enterprise read path (getEnterprisePricing) by
 * request.family to the matching instance. Default to bigmodel when family is omitted, preserving compatibility with existing callers.
 *
 * The other operations (purchases/staticConfigs/preview, etc.) are independent of family or already route inside the provider by
 * request.providerId, so they can all be delegated to the bigmodel provider:
 *   - The enterprise purchase flow (balance/order/pending/cancel/continue/status) remains on the bigmodel domain by product decision.
 *   - staticConfigs is platform-level client/configuration data and is independent of family.
 *   - Purchase operations (Stripe/PayPal/preview/createSign, etc.) already route within the provider by request.providerId.
 */
export function createCodingPlanSubscriptionService(
  dependencies: CodingPlanSubscriptionServiceDependencies,
): ICodingPlanSubscriptionService {
  const bigmodelProvider = new BigModelCodingPlanSubscriptionProvider(dependencies);
  const zaiProvider = new ZaiCodingPlanSubscriptionProvider(dependencies);

  // Select the enterprise read-path provider by family; default to bigmodel, including for historical calls without a family.
  const resolveEnterprisePricingProvider = (
    family?: "bigmodel" | "zai",
  ): BigModelCodingPlanSubscriptionProvider => (family === "zai" ? zaiProvider : bigmodelProvider);

  return {
    batchPreview: (request) => bigmodelProvider.batchPreview(request),
    getStaticProducts: () => bigmodelProvider.getStaticProducts(),
    getStaticTeamProducts: () => bigmodelProvider.getStaticTeamProducts(),
    getStartPlanPreview: () => bigmodelProvider.getStartPlanPreview(),
    getManualClaimPlanPreviews: () => bigmodelProvider.getManualClaimPlanPreviews(),
    claimManualPlan: (request) => bigmodelProvider.claimManualPlan(request),
    getOffPeakClientConfig: (options) => bigmodelProvider.getOffPeakClientConfig(options),
    // Dynamic-workflow rollout data comes from the same source as client/configs,
    // so like other platform-level configuration it always uses the bigmodel provider, regardless of family.
    // The user's choice is applied to the "offer" here so the renderer reads the effective value; the
    // rule lives only in shared's applyDynamicWorkflowUserMode—the renderer does not recompute it.
    getDynamicWorkflowClientConfig: async (options) => {
      const offer = await bigmodelProvider.getDynamicWorkflowClientConfig(options);
      const resolveUserMode = dependencies.resolveDynamicWorkflowUserMode;
      return resolveUserMode ? applyDynamicWorkflowUserMode(offer, await resolveUserMode()) : offer;
    },
    getModelContextBudgetStrategy: () => bigmodelProvider.getModelContextBudgetStrategy(),
    getBillingDiscount: () => bigmodelProvider.getBillingDiscount(),
    getRequestVerificationConfig: () => bigmodelProvider.getRequestVerificationConfig(),
    getForceUpdateConfig: () => bigmodelProvider.getForceUpdateConfig(),
    productInfo: (request) => bigmodelProvider.productInfo(request),
    preview: (request) => bigmodelProvider.preview(request),
    createSign: (request) => bigmodelProvider.createSign(request),
    updateSign: (request) => bigmodelProvider.updateSign(request),
    checkPayment: (request) => bigmodelProvider.checkPayment(request),
    checkPendingOrders: (request) => bigmodelProvider.checkPendingOrders(request),
    queryStripeCards: (request) => bigmodelProvider.queryStripeCards(request),
    bindStripeCard: (request) => bigmodelProvider.bindStripeCard(request),
    unbindStripeCard: (request) => bigmodelProvider.unbindStripeCard(request),
    payStripe: (request) => bigmodelProvider.payStripe(request),
    checkPaypalSupport: (request) => bigmodelProvider.checkPaypalSupport(request),
    createPaypalSetupToken: (request) => bigmodelProvider.createPaypalSetupToken(request),
    subscribePaypal: (request) => bigmodelProvider.subscribePaypal(request),
    getEnterprisePricing: (request) =>
      resolveEnterprisePricingProvider(request?.family).getEnterprisePricing(request),
    getEnterpriseBalance: () => bigmodelProvider.getEnterpriseBalance(),
    calculateEnterpriseOrder: (request) => bigmodelProvider.calculateEnterpriseOrder(request),
    createEnterpriseOrder: (request) => bigmodelProvider.createEnterpriseOrder(request),
    getEnterprisePendingOrders: () => bigmodelProvider.getEnterprisePendingOrders(),
    cancelEnterpriseOrder: (request) => bigmodelProvider.cancelEnterpriseOrder(request),
    continueEnterpriseOrderPayment: (request) =>
      bigmodelProvider.continueEnterpriseOrderPayment(request),
    checkEnterpriseOrderStatus: (request) => bigmodelProvider.checkEnterpriseOrderStatus(request),
  };
}
