import {
  BUILTIN_MODEL_PROVIDER_IDS,
  type ProviderFamilyDomain,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type { SidebarUsageCodingPlanProviderId } from "@/lib/sidebarUsageCodingPlanProviderPreference.js";

export function resolveSidebarCodingPlanUpgradeFallbackProviderId(
  providerFamilyDomain: ProviderFamilyDomain | null,
): SidebarUsageCodingPlanProviderId {
  // API Key mode does not inject a plan key for the Coding Plan provider, so the avatar's upgrade entry
  // cannot infer the provider from entitlement or usage data. Fall back to the entry for the provider's family domain.
  return providerFamilyDomain === "bigmodel"
    ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
    : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
}

function normalizePlanLevel(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function hasPlanLevelToken(value: string | null | undefined, token: string): boolean {
  return new RegExp(`(^|[\\s_-])${token}($|[\\s_-])`, "i").test(value?.trim() ?? "");
}

function isTerminalCodingPlanLevel(value: string | null | undefined): boolean {
  const normalized = normalizePlanLevel(value);
  // Determine whether the plan tier is a terminal state that cannot be upgraded: enterprise/team count as terminal.
  return normalized.includes("enterprise") || normalized.includes("team");
}

function isMaxCodingPlanLevel(value: string | null | undefined): boolean {
  const normalized = normalizePlanLevel(value);
  return normalized === "max" || hasPlanLevelToken(value, "max");
}

export function isTerminalCodingPlanSnapshot(snapshot: UsageEntitlementSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  if (isTerminalCodingPlanLevel(snapshot.quota?.level)) {
    return true;
  }

  return (snapshot.subscription?.details ?? []).some((detail) => {
    const productId = normalizePlanLevel(detail.productId);
    const productName = normalizePlanLevel(detail.productName);
    return isTerminalCodingPlanLevel(productId) || isTerminalCodingPlanLevel(productName);
  });
}

export function isMaxCodingPlanSnapshot(snapshot: UsageEntitlementSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  if (isMaxCodingPlanLevel(snapshot.quota?.level)) {
    return true;
  }

  return (snapshot.subscription?.details ?? []).some((detail) => {
    const productId = detail.productId;
    const productName = detail.productName;
    return isMaxCodingPlanLevel(productId) || isMaxCodingPlanLevel(productName);
  });
}
