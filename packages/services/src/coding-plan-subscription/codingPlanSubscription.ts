import type {
  CodingPlanAgreementResponse,
  CodingPlanBatchPreviewRequest,
  CodingPlanBatchPreviewResponse,
  CodingPlanCreateSignRequest,
  CodingPlanPaymentCheckRequest,
  CodingPlanPaymentCheckResponse,
  CodingPlanPendingOrderCheckRequest,
  CodingPlanPendingOrderCheckResponse,
  CodingPlanPaypalSetupTokenRequest,
  CodingPlanPaypalSetupTokenResponse,
  CodingPlanPaypalSubscribeRequest,
  CodingPlanPaypalSubscribeResponse,
  CodingPlanPaypalSupportRequest,
  CodingPlanPaypalSupportResponse,
  CodingPlanProductInfo,
  CodingPlanProductInfoRequest,
  CodingPlanStaticProductsConfig,
  CodingPlanStaticTeamProductsConfig,
  CodingPlanPreviewRequest,
  CodingPlanPreviewResponse,
  CodingPlanStripeBindRequest,
  CodingPlanStripeBindResponse,
  CodingPlanStripeCard,
  CodingPlanStripePayRequest,
  CodingPlanStripePayResponse,
  CodingPlanStripeUnbindRequest,
  CodingPlanUpdateSignRequest,
  EnterpriseCodingPlanCreateOrderRequest,
  EnterpriseCodingPlanCreateOrderResponse,
  EnterpriseCodingPlanCancelOrderRequest,
  EnterpriseCodingPlanCancelOrderResponse,
  EnterpriseCodingPlanBalanceResponse,
  EnterpriseCodingPlanContinuePayRequest,
  EnterpriseCodingPlanOrderCalculateRequest,
  EnterpriseCodingPlanOrderCalculateResponse,
  EnterpriseCodingPlanPendingOrder,
  EnterpriseCodingPlanOrderStatusRequest,
  EnterpriseCodingPlanOrderStatusResponse,
  EnterpriseCodingPlanPricingRequest,
  EnterpriseCodingPlanPricingResponse,
  StartPlanPreviewConfig,
  ZCodeModelContextBudgetStrategy,
  ForceUpdateConfig,
  DynamicWorkflowClientConfig,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface OffPeakClientConfig {
  readonly enabled: boolean;
  readonly modelSelectionView: ModelSelectionView;
  /** Forced channel for mock demos: not sent on the real path; the UI uses Account support from the Host. */
  readonly codingPlanActive?: boolean;
}

export interface ICodingPlanSubscriptionService {
  batchPreview(request?: CodingPlanBatchPreviewRequest): Promise<CodingPlanBatchPreviewResponse>;
  getStaticProducts(): Promise<CodingPlanStaticProductsConfig>;
  getStaticTeamProducts(): Promise<CodingPlanStaticTeamProductsConfig>;
  getStartPlanPreview(): Promise<StartPlanPreviewConfig | null>;
  /** Off-peak task rollout config; forceRefresh lets the entry point fetch again when opened (bypassing the 1h snapshot cache). */
  getOffPeakClientConfig(options?: { forceRefresh?: boolean }): Promise<OffPeakClientConfig>;
  /**
   * Dynamic-workflow rollout snapshot: remote `configs.dynamicWorkflow.mode`
   * after applying local overrides; forceRefresh bypasses the 1h snapshot cache. Requests fail closed (disabled/default).
   */
  getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig>;
  /** Compatibility interface: always returns preflight-v1 without reading remote configuration or cache. */
  getModelContextBudgetStrategy(): Promise<ZCodeModelContextBudgetStrategy>;
  getForceUpdateConfig(): Promise<ForceUpdateConfig | null>;
  productInfo(request: CodingPlanProductInfoRequest): Promise<CodingPlanProductInfo>;
  preview(request: CodingPlanPreviewRequest): Promise<CodingPlanPreviewResponse>;
  createSign(request: CodingPlanCreateSignRequest): Promise<CodingPlanAgreementResponse>;
  updateSign(request: CodingPlanUpdateSignRequest): Promise<CodingPlanAgreementResponse>;
  checkPayment(request: CodingPlanPaymentCheckRequest): Promise<CodingPlanPaymentCheckResponse>;
  checkPendingOrders(
    request?: CodingPlanPendingOrderCheckRequest,
  ): Promise<CodingPlanPendingOrderCheckResponse>;
  queryStripeCards(request?: {
    providerId?: CodingPlanPreviewRequest["providerId"];
  }): Promise<CodingPlanStripeCard[]>;
  bindStripeCard(request: CodingPlanStripeBindRequest): Promise<CodingPlanStripeBindResponse>;
  unbindStripeCard(request: CodingPlanStripeUnbindRequest): Promise<string>;
  payStripe(request: CodingPlanStripePayRequest): Promise<CodingPlanStripePayResponse>;
  checkPaypalSupport(
    request?: CodingPlanPaypalSupportRequest,
  ): Promise<CodingPlanPaypalSupportResponse>;
  createPaypalSetupToken(
    request: CodingPlanPaypalSetupTokenRequest,
  ): Promise<CodingPlanPaypalSetupTokenResponse>;
  subscribePaypal(
    request: CodingPlanPaypalSubscribeRequest,
  ): Promise<CodingPlanPaypalSubscribeResponse>;
  getEnterprisePricing(
    request?: EnterpriseCodingPlanPricingRequest,
  ): Promise<EnterpriseCodingPlanPricingResponse>;
  getEnterpriseBalance(): Promise<EnterpriseCodingPlanBalanceResponse>;
  calculateEnterpriseOrder(
    request: EnterpriseCodingPlanOrderCalculateRequest,
  ): Promise<EnterpriseCodingPlanOrderCalculateResponse>;
  createEnterpriseOrder(
    request: EnterpriseCodingPlanCreateOrderRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse>;
  getEnterprisePendingOrders(): Promise<EnterpriseCodingPlanPendingOrder[]>;
  cancelEnterpriseOrder(
    request: EnterpriseCodingPlanCancelOrderRequest,
  ): Promise<EnterpriseCodingPlanCancelOrderResponse>;
  continueEnterpriseOrderPayment(
    request: EnterpriseCodingPlanContinuePayRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse>;
  checkEnterpriseOrderStatus(
    request: EnterpriseCodingPlanOrderStatusRequest,
  ): Promise<EnterpriseCodingPlanOrderStatusResponse>;
}

export const ICodingPlanSubscriptionService =
  createServiceDescriptor<ICodingPlanSubscriptionService>(ServiceChannels.CodingPlanSubscription);
