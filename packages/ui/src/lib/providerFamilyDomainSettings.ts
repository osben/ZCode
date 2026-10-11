import type { ISettingService } from "@zcode/services";
import {
  type AppSettings,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
} from "@zcode/shared";

export function resolveLogoutProviderFamilyDomain(params: {
  currentDomain: ProviderFamilyDomain | null | undefined;
}): ProviderFamilyDomain | null {
  void params;
  return null;
}

export async function setProviderFamilyDomain(
  settingService: Pick<ISettingService, "get" | "update">,
  domain: ProviderFamilyDomain,
): Promise<void> {
  const currentSettings = await settingService.get();
  await settingService.update({
    providerFamilyDomain: domain,
    providerFamilyDomainUpdatedAt: Date.now(),
    providerFamilyDomainMigrated: true,
    // OAuth login from WelcomeScreen means the user chose the Coding Plan/OAuth mode for the same family.
    // Writing only providerFamilyDomain would preserve the apiKey mode from the prior API Key flow, leaving the user in API Key mode after login.
    providerFamilyConnectionSelections: buildOAuthProviderFamilySelections(
      domain,
      currentSettings.providerFamilyConnectionSelections,
    ),
  });
}

export function buildOAuthProviderFamilySelections(
  domain: ProviderFamilyDomain,
  currentSelections: ProviderFamilyConnectionSelectionSettings | null | undefined,
): ProviderFamilyConnectionSelectionSettings {
  return {
    ...currentSelections,
    [domain]: { kind: "individual-coding-plan" },
  };
}

export async function clearProviderFamilyDomain(
  settingService: Pick<ISettingService, "update">,
): Promise<void> {
  await settingService.update({
    // Cleanup reason: undefined can be dropped when providerFamilyDomain is sent over RPC.
    // settingService normalizes an empty string to undefined, ensuring sign-out/unlink does not keep filtering by the old domain.
    providerFamilyDomain: "" as AppSettings["providerFamilyDomain"],
    providerFamilyDomainUpdatedAt: Date.now(),
    providerFamilyDomainMigrated: true,
  });
}
