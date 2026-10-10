import type { EnterpriseCodingPlanProductDisplay } from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";

// 2026-09: the native purchase panel (CodingPlanPurchasePanel) was removed and purchasing moved to an embedded official-site
// WebView. This file extracts the enterprise-plan grouping/tier display helpers still used by Settings (Detail.tsx) and login recovery,
// avoiding a dependency from active code on the 6,200-line dead panel file.

export type PurchaseAudience = "personal" | "team";

export interface EnterpriseCodingPlanProductGroup {
  key: string;
  title: string;
  products: EnterpriseCodingPlanProductDisplay[];
}
