import { type UsageEntitlementSnapshot } from "@zcode/shared";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

export function pickCodingPlanEntitlementProvider(
  codingPlanProvider: ProviderSettingsFormProvider | null | undefined,
): ProviderSettingsFormProvider | null {
  // Coding Plan and regular API keys are separate entry points.
  // Entitlements and model entry points follow only the Coding Plan provider’s own key, so a regular provider key cannot incorrectly activate a subscription state.
  return codingPlanProvider ?? null;
}

export function hasActiveUsageEntitlementSnapshot(
  snapshot: UsageEntitlementSnapshot | null,
  providerId?: string,
): boolean {
  return resolveUsageEntitlementOutcome(snapshot, providerId) === "active";
}

export type UsageEntitlementOutcome = "active" | "inactive" | "unknown";

/** Treat only an authoritative no_plan as invalid; network/authentication errors and incomplete snapshots remain unknown. */
export function resolveUsageEntitlementOutcome(
  snapshot: UsageEntitlementSnapshot | null,
  providerId?: string,
): UsageEntitlementOutcome {
  if (!snapshot) return "unknown";
  if (providerId && snapshot.provider?.id && snapshot.provider.id !== providerId) {
    return "unknown";
  }
  if (snapshot.unavailableReason === "no_plan") return "inactive";
  // A quota or remaining quota does not prove a subscription; for individuals and teams, entitlements are established by the subscription summary returned by the service.
  return snapshot.subscription?.details.length ? "active" : "unknown";
}
