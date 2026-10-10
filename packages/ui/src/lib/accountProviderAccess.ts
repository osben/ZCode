import type { ProviderSettingsView } from "@zcode/services";
import { type ZCodeProviderAccountAccess, zcodeProviderAccountAccessSchema } from "@zcode/shared";

interface EntitledAccountProviderAccess {
  readonly providerId: string;
  readonly access: ZCodeProviderAccountAccess;
  readonly label?: string;
}

export function resolveEntitledAccountProviderAccess(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): EntitledAccountProviderAccess | null {
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  if (provider?.effectiveConfig.access?.type !== "zhipu-account") {
    return null;
  }

  // Registry Access is a static accountType/mode constraint; dynamic planKind and Team scope
  // can be resolved only by the account service at request time. The old schema incorrectly treated every real Registry Provider as empty.
  const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.effectiveConfig.access);
  if (!parsed.success || parsed.data.entitled !== true) return null;
  const label = provider.providerName?.trim();
  return {
    providerId,
    access: parsed.data,
    ...(label ? { label } : {}),
  };
}

export function resolveEntitledAccountProviderAccessFingerprint(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): string {
  const access = resolveEntitledAccountProviderAccess(view, providerId);
  return access ? JSON.stringify([view?.revision, access.providerId, access.access]) : "";
}

/**
 * A read-only plan query is not model execution. Pending/unselected accounts still need to show entitlements, so do not require current.
 * Use this function only for balance/subscription queries, never for model requests or ModelSelection completion.
 */
export function resolveAccountProviderInspectionAccess(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): EntitledAccountProviderAccess | null {
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  if (!provider) return null;
  // Even when Start entitlement is explicitly absent, perform a read-only query for the expiration reason; execution permission remains controlled by the entitled gate.
  if (
    provider.accountState?.availability === "unavailable" &&
    !(
      provider.effectiveConfig.access?.type === "zhipu-account" &&
      provider.effectiveConfig.access.mode === "start-plan" &&
      provider.accountState.unavailableReason === "not-entitled"
    )
  )
    return null;
  const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.effectiveConfig.access);
  if (!parsed.success || parsed.data.mode === "off-peak") return null;
  if (!provider.accountState && parsed.data.entitled !== true) return null;
  return { providerId, access: parsed.data };
}
