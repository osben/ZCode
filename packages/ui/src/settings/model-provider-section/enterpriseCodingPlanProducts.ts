/* eslint-disable max-lines -- Enterprise plan display models keep the static catalog, live pricing, and payment parameter conversion together; splitting them would blur their boundaries. */
import type {
  CodingPlanCampaignDiscountDetail,
  CodingPlanStaticTeamProduct,
  EnterpriseCodingPlanCreateOrderRequest,
  EnterpriseCodingPlanCreateOrderResponse,
  EnterpriseCodingPlanDiscountDetail,
  EnterpriseCodingPlanOrderCalculateResponse,
  EnterpriseCodingPlanPendingOrder,
  EnterpriseCodingPlanPaymentStatus,
  EnterpriseCodingPlanPricingProduct,
  EnterpriseCodingPlanSubscribePeriod,
  ProviderFamilyDomain,
} from "@zcode/shared";
import {
  normalizeCodingPlanCardCopyItems,
  type CodingPlanPriceUnit,
  type CodingPlanProductDisplay,
} from "@/settings/model-provider-section/codingPlanProductPresentation.js";

export type EnterpriseCodingPlanProductDisplay = CodingPlanProductDisplay & {
  enterpriseProduct: EnterpriseCodingPlanPricingProduct;
  tier: EnterpriseCodingPlanPricingProduct["tier"];
  subscribeMode: EnterpriseCodingPlanPricingProduct["subscribeMode"];
  subscribePeriod: EnterpriseCodingPlanPricingProduct["subscribePeriod"];
  purchaseMethodName: string;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  teamProjects?: EnterpriseCodingPlanPricingProduct["teamProjects"];
  apiKeyStatus?: EnterpriseCodingPlanPricingProduct["apiKeyStatus"];
  apiKeyUnavailableReason?: EnterpriseCodingPlanPricingProduct["apiKeyUnavailableReason"];
  apiKeyUnavailableMessage?: EnterpriseCodingPlanPricingProduct["apiKeyUnavailableMessage"];
  subscribed?: boolean | null;
  dynamicPricingAvailable?: boolean;
  staticCatalogAvailable?: boolean;
  /**
   * Family for this enterprise plan (zai / bigmodel).
   * The old UI hard-coded team plan items as derived from bigmodelCodingPlan,
   * so the zai family could not render even with a subscription. The family marker lets downstream visibility logic find the matching
   * codingPlanItem and team key prefix from product.family.
   * Defaulting to bigmodel preserves backward compatibility.
   */
  family?: ProviderFamilyDomain;
};

/** Interpret missing family on legacy products as BigModel only at this normalization boundary. */
export function resolveEnterpriseCodingPlanProductFamily(
  product: Pick<EnterpriseCodingPlanProductDisplay, "family">,
): ProviderFamilyDomain {
  return product.family ?? "bigmodel";
}

const ENTERPRISE_CODING_PLAN_FAILURE_STATUSES = ["FAIL", "CLOSED", "CANCELLED"] as const;

export function buildEnterpriseCodingPlanProductList(
  products: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  return products.map((product): EnterpriseCodingPlanProductDisplay => {
    const purchaseMethodName = product.purchaseMethodName?.trim() ?? "";
    return {
      productId: product.productId,
      productName: formatEnterpriseCodingPlanTier(product.tier),
      productBigTitle: formatEnterpriseCodingPlanTier(product.tier),
      originalAmount: product.originalAmount,
      payAmount: resolveEnterpriseCodingPlanDisplayPayAmount(product),
      renewAmount: product.renewAmount,
      canRepurchase: product.canRepurchase,
      inCurrentPeriod: product.subscribed === true,
      campaignDiscountDetails: product.campaignDiscountDetails,
      priceUnit: mapEnterpriseCodingPlanPriceUnit(product.subscribePeriod),
      priceCurrency: "CNY",
      productEquityList: [],
      hasPreview: true,
      enterpriseProduct: product,
      tier: product.tier,
      subscribeMode: product.subscribeMode,
      subscribePeriod: product.subscribePeriod,
      purchaseMethodName,
      organizationId: product.organizationId,
      organizationName: product.organizationName,
      projectId: product.projectId,
      projectName: product.projectName,
      teamProjects: product.teamProjects,
      apiKeyStatus: product.apiKeyStatus,
      apiKeyUnavailableReason: product.apiKeyUnavailableReason,
      apiKeyUnavailableMessage: product.apiKeyUnavailableMessage,
      subscribed: product.subscribed,
      dynamicPricingAvailable: true,
    };
  });
}

export function mergeEnterpriseCodingPlanProductList(
  staticProducts: CodingPlanStaticTeamProduct[],
  pricingProducts: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  const pricingByProductId = new Map(
    pricingProducts.map((product) => [product.productId, product]),
  );
  const staticProductIds = new Set(staticProducts.map((product) => product.productId));
  const mergedStaticProducts = staticProducts.map((staticProduct) => {
    const pricingProduct = pricingByProductId.get(staticProduct.productId);
    const enterpriseProduct: EnterpriseCodingPlanPricingProduct = pricingProduct ?? {
      productId: staticProduct.productId,
      tier: staticProduct.tier,
      subscribeMode: staticProduct.subscribeMode,
      subscribePeriod: staticProduct.subscribePeriod,
      purchaseMethodName: staticProduct.purchaseMethodName,
      originalAmount: staticProduct.originalAmount,
      discountAmount: staticProduct.discountAmount,
      payAmount: staticProduct.payAmount,
      renewAmount: staticProduct.renewAmount,
      canRepurchase: false,
    };
    const display = buildEnterpriseCodingPlanProductList([enterpriseProduct])[0]!;
    return {
      ...display,
      productName: staticProduct.productName,
      productBigTitle: staticProduct.productName,
      originalAmount: pricingProduct?.originalAmount ?? staticProduct.originalAmount,
      payAmount: pricingProduct
        ? display.payAmount
        : (staticProduct.payAmount ?? staticProduct.renewAmount),
      renewAmount: pricingProduct?.renewAmount ?? staticProduct.renewAmount,
      priceCurrency: staticProduct.priceCurrency,
      equity: normalizeCodingPlanCardCopyItems(staticProduct.equity ?? []),
      descriptionItems: normalizeCodingPlanCardCopyItems(staticProduct.description ?? []),
      dynamicPricingAvailable: pricingProduct !== undefined,
      staticCatalogAvailable: true,
    };
  });
  const purchasedPricingProducts = pricingProducts
    .filter((product) => product.subscribed === true && !staticProductIds.has(product.productId))
    .map((product) => ({
      ...buildEnterpriseCodingPlanProductList([product])[0]!,
      // The static team catalog from client/configs is only for displaying purchasable SKUs;
      // an existing Team Plan is identified by pricing/customerInfo. Do not hide actual team connection and usage-statistics entry points
      // because the static catalog is empty in a rollout or a product was omitted.
      staticCatalogAvailable: false,
    }));
  return [...mergedStaticProducts, ...purchasedPricingProducts];
}

export function resolveEnterpriseCodingPlanProductList(
  staticProducts: CodingPlanStaticTeamProduct[] | undefined,
  pricingProducts: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  // If the static catalog is missing or fails to load, pricing remains authoritative for team subscription identity and project context;
  // hide all team SKUs according to configuration semantics only when an explicit empty array was read successfully.
  return !Array.isArray(staticProducts)
    ? buildEnterpriseCodingPlanProductList(pricingProducts)
    : mergeEnterpriseCodingPlanProductList(staticProducts, pricingProducts);
}

function resolveEnterpriseCodingPlanDisplayPayAmount(
  product: EnterpriseCodingPlanPricingProduct,
): number | undefined {
  const candidateAmounts = [product.payAmount, product.renewAmount].filter(hasPositiveOrZeroAmount);
  if (candidateAmounts.length > 0) {
    // Real enterprise annual pricing products send payAmount=originalAmount and renewAmount=discounted price.
    // The card should show “discounted price + strikethrough original price,” like personal plans, so use the lowest available payment amount as the display price.
    return Math.min(...candidateAmounts);
  }
  if (
    hasPositiveOrZeroAmount(product.originalAmount) &&
    hasPositiveAmount(product.discountAmount)
  ) {
    // Personal plan cards show discounted price + strikethrough original price; enterprise pricing's discountAmount is the discount amount,
    // not a price to pass directly to the shared card, but annual products may send only originalAmount + discountAmount.
    return roundCurrencyAmount(Math.max(0, product.originalAmount - product.discountAmount));
  }
  return undefined;
}

export function buildEnterpriseCodingPlanCalculateRequest({
  product,
  maxSeats,
  duration,
  giveAmount = 0,
  balanceDeductAmount = 0,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  maxSeats: number;
  duration: number;
  giveAmount?: number;
  balanceDeductAmount?: number;
}) {
  return {
    productId: product.productId,
    maxSeats,
    subscribePeriod: product.subscribePeriod,
    subscribeMode: product.subscribeMode,
    duration: product.subscribeMode === "ONE_TIME" ? duration : undefined,
    giveAmount,
    balanceDeductAmount,
  };
}

export function buildEnterpriseCodingPlanCreateOrderRequest({
  product,
  maxSeats,
  duration,
  estimate,
  giveAmount = 0,
  balanceDeductAmount = 0,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  maxSeats: number;
  duration: number;
  giveAmount?: number;
  balanceDeductAmount?: number;
  estimate: Pick<
    EnterpriseCodingPlanOrderCalculateResponse,
    "totalOriginalAmount" | "totalPayAmount" | "thirdPayAmount"
  >;
}): EnterpriseCodingPlanCreateOrderRequest {
  return {
    productId: product.productId,
    maxSeats,
    subscribePeriod: product.subscribePeriod,
    subscribeMode: product.subscribeMode,
    purchaseType: "PAY",
    duration: product.subscribeMode === "ONE_TIME" ? duration : undefined,
    giveAmount,
    balanceDeductAmount,
    totalOriginalAmount: estimate.totalOriginalAmount,
    totalPayAmount: estimate.totalPayAmount,
    thirdPayAmount: estimate.thirdPayAmount,
  };
}

export function buildEnterpriseCodingPlanPaymentContent(
  order: Pick<EnterpriseCodingPlanCreateOrderResponse, "alipayJumpSchema" | "payUrl">,
): string {
  // Bugfix: for enterprise plans, the desktop QR code must use payUrl as specified by the API. alipayJumpSchema is a mobile deep-link schema for launching Alipay and can be too long for QR generation.
  return order.payUrl?.trim() || order.alipayJumpSchema?.trim() || "";
}

export function isEnterpriseCodingPlanThirdPartyPaymentRequired(
  order: Pick<
    EnterpriseCodingPlanCreateOrderResponse,
    "alipayJumpSchema" | "payUrl" | "thirdPayAmount"
  >,
): boolean {
  // Bugfix: when a gift balance/account balance fully covers an enterprise plan, the backend
  // creates an order with no third-party payment content. Do not open the Alipay QR page for such
  // orders, or the user will be stuck on “Complete payment on this page.”
  return order.thirdPayAmount > 0 || buildEnterpriseCodingPlanPaymentContent(order) !== "";
}

export function buildEnterpriseCodingPlanEstimateFromPendingOrder(
  order: EnterpriseCodingPlanPendingOrder,
): EnterpriseCodingPlanOrderCalculateResponse {
  const discountAmount = hasPositiveAmount(order.deductionAmount)
    ? order.deductionAmount
    : Math.max(0, order.totalAmount - order.amount);
  return {
    totalOriginalAmount: order.totalAmount,
    campaignDiscountAmount: discountAmount,
    totalPayAmount: order.amount,
    // Bugfix: the pending-orders API does not return thirdPayAmount, so the confirmation page must
    // use the amount due as a placeholder. When payment starts, refresh the QR-dialog amount from
    // the thirdPayAmount returned by the continue-payment API.
    thirdPayAmount: order.amount,
  };
}

export function buildEnterpriseCodingPlanEstimateFromOrderResponse(
  order: EnterpriseCodingPlanCreateOrderResponse,
): EnterpriseCodingPlanOrderCalculateResponse {
  return {
    totalOriginalAmount: order.totalOriginalAmount,
    campaignDiscountAmount: order.campaignDiscountAmount,
    discountDetails: order.discountDetails,
    totalPayAmount: order.totalPayAmount,
    thirdPayAmount: order.thirdPayAmount,
  };
}

export function buildEnterpriseCodingPlanCampaignDiscountDetails({
  campaignDiscountAmount,
  discountDetails,
  pricingCampaignDiscountDetails,
}: {
  campaignDiscountAmount?: number;
  discountDetails?: EnterpriseCodingPlanDiscountDetail[];
  pricingCampaignDiscountDetails?: CodingPlanCampaignDiscountDetail[];
}): CodingPlanCampaignDiscountDetail[] {
  const pricingDetails = normalizePricingCampaignDiscountDetails(
    pricingCampaignDiscountDetails,
    campaignDiscountAmount,
  );
  if (pricingDetails.length > 0) {
    return pricingDetails;
  }

  const mappedDetails = (discountDetails ?? []).flatMap((detail) => {
    if (typeof detail.discountAmount !== "number" || detail.discountAmount <= 0) {
      return [];
    }
    const discountName = detail.discountName?.trim();
    return [
      {
        campaignName: discountName || undefined,
        campaignDiscountAmount: detail.discountAmount,
        rewardDetail: discountName || undefined,
        applyScene: detail.discountType,
      },
    ];
  });
  if (mappedDetails.length > 0) {
    return mappedDetails;
  }
  if (typeof campaignDiscountAmount === "number" && campaignDiscountAmount > 0) {
    return [{ campaignDiscountAmount }];
  }
  return [];
}

export function calculateEnterpriseCodingPlanPricingDiscountAmount({
  product,
  maxSeats,
  duration,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  maxSeats: number;
  duration: number;
}): number | undefined {
  const discountAmount = product.enterpriseProduct.discountAmount;
  const displayDiscountAmount = hasPositiveAmount(discountAmount)
    ? discountAmount
    : calculateEnterpriseCodingPlanDisplayDiscountAmount(product);
  if (!hasPositiveAmount(displayDiscountAmount)) {
    return undefined;
  }
  const periodCount = product.subscribeMode === "ONE_TIME" ? Math.max(1, duration) : 1;
  return roundCurrencyAmount(
    // Root cause: enterprise pricing may report discountAmount as 0 even when the annual discount
    // is represented by the difference between originalAmount and renewAmount. Reconstruct the
    // per-seat discount from the price shown on the card for confirmation/payment details.
    displayDiscountAmount * Math.max(1, maxSeats) * periodCount,
  );
}

function calculateEnterpriseCodingPlanDisplayDiscountAmount(
  product: EnterpriseCodingPlanProductDisplay,
): number | undefined {
  const displayPayAmount = resolveEnterpriseCodingPlanDisplayPayAmount(product.enterpriseProduct);
  if (
    !hasPositiveAmount(product.enterpriseProduct.originalAmount) ||
    !hasPositiveOrZeroAmount(displayPayAmount)
  ) {
    return undefined;
  }
  const discountAmount = product.enterpriseProduct.originalAmount - displayPayAmount;
  return discountAmount > 0 ? roundCurrencyAmount(discountAmount) : undefined;
}

function normalizePricingCampaignDiscountDetails(
  details: CodingPlanCampaignDiscountDetail[] | undefined,
  campaignDiscountAmount: number | undefined,
): CodingPlanCampaignDiscountDetail[] {
  const sourceDetails = (details ?? []).filter(
    (detail) =>
      hasPositiveAmount(detail.campaignDiscountAmount) ||
      Boolean(detail.campaignName?.trim()) ||
      Boolean(detail.rewardDetail?.trim()),
  );
  if (sourceDetails.length === 0) {
    return [];
  }

  const totalDiscountAmount = hasPositiveAmount(campaignDiscountAmount)
    ? campaignDiscountAmount
    : undefined;
  const sourceAmountSum = sourceDetails.reduce(
    (sum, detail) =>
      sum + (hasPositiveAmount(detail.campaignDiscountAmount) ? detail.campaignDiscountAmount : 0),
    0,
  );
  let allocatedAmount = 0;

  return sourceDetails.flatMap((detail, index) => {
    const amount = resolvePricingCampaignDiscountAmount({
      detail,
      index,
      count: sourceDetails.length,
      totalDiscountAmount,
      sourceAmountSum,
      allocatedAmount,
    });
    allocatedAmount += amount;
    if (!hasPositiveAmount(amount)) {
      return [];
    }
    return [
      {
        ...detail,
        // Root cause: enterprise pricing returns promotion details per seat and billing period,
        // while quotes/orders return the total discount for the current seat count and duration.
        // Keep the promotion name and description from pricing, but use the current order's total
        // discount amount to avoid understating discounts on multi-seat purchases.
        campaignDiscountAmount: amount,
      },
    ];
  });
}

function resolvePricingCampaignDiscountAmount({
  detail,
  index,
  count,
  totalDiscountAmount,
  sourceAmountSum,
  allocatedAmount,
}: {
  detail: CodingPlanCampaignDiscountDetail;
  index: number;
  count: number;
  totalDiscountAmount: number | undefined;
  sourceAmountSum: number;
  allocatedAmount: number;
}): number {
  if (!hasPositiveAmount(totalDiscountAmount)) {
    return hasPositiveAmount(detail.campaignDiscountAmount) ? detail.campaignDiscountAmount : 0;
  }

  if (count === 1) {
    return totalDiscountAmount;
  }

  if (sourceAmountSum <= 0) {
    return index === 0 ? totalDiscountAmount : 0;
  }

  if (index === count - 1) {
    return roundCurrencyAmount(totalDiscountAmount - allocatedAmount);
  }

  const sourceAmount = hasPositiveAmount(detail.campaignDiscountAmount)
    ? detail.campaignDiscountAmount
    : 0;
  return roundCurrencyAmount((totalDiscountAmount * sourceAmount) / sourceAmountSum);
}

function hasPositiveAmount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasPositiveOrZeroAmount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function roundCurrencyAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function isEnterpriseCodingPlanPaymentSuccessStatus(
  status: EnterpriseCodingPlanPaymentStatus,
): boolean {
  return status === "SUCCESS";
}

export function isEnterpriseCodingPlanPaymentFailureStatus(
  status: EnterpriseCodingPlanPaymentStatus,
): boolean {
  return ENTERPRISE_CODING_PLAN_FAILURE_STATUSES.includes(
    status as (typeof ENTERPRISE_CODING_PLAN_FAILURE_STATUSES)[number],
  );
}

export function getEnterpriseCodingPlanFailureStatuses(): string[] {
  return [...ENTERPRISE_CODING_PLAN_FAILURE_STATUSES];
}

function formatEnterpriseCodingPlanTier(tier: EnterpriseCodingPlanPricingProduct["tier"]): string {
  const normalized = tier.trim();
  if (!normalized) {
    return tier;
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function mapEnterpriseCodingPlanPriceUnit(
  period: EnterpriseCodingPlanSubscribePeriod,
): CodingPlanPriceUnit {
  return period === "YEARLY" ? "year" : period === "QUARTERLY" ? "quarter" : "month";
}
