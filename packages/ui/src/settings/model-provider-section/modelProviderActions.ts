import type { ConfirmDialogRequest } from "@/store/confirmDialogStore.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
export async function confirmAndDeleteModelProvider({
  provider,
  confirmDialog,
  intl,
  deleteProvider,
}: {
  provider: ProviderSettingsFormProvider;
  confirmDialog: (payload: ConfirmDialogRequest) => Promise<boolean>;
  intl: IntlInstance;
  deleteProvider: (providerId: string) => Promise<void>;
}) {
  if (provider.config.group === "zai-family" || provider.config.group === "bigmodel-family") {
    return;
  }

  logger.info("[ModelProviderSection] 请求删除自定义模型供应商", {
    providerId: provider.providerId,
    providerName: getProviderFormLabel(provider),
  });

  const confirmed = await confirmDialog({
    title: intl.formatMessage(
      { id: "settings.modelProvider.deleteConfirmTitle" },
      { name: getProviderFormLabel(provider) },
    ),
    description: intl.formatMessage({
      id: "settings.modelProvider.deleteConfirmDescription",
    }),
    confirmLabel: intl.formatMessage({
      id: "settings.modelProvider.deleteConfirmAction",
    }),
    cancelLabel: intl.formatMessage({ id: "common.cancel" }),
  });
  if (!confirmed) {
    logger.info("[ModelProviderSection] 用户取消删除自定义模型供应商", {
      providerId: provider.providerId,
      providerName: getProviderFormLabel(provider),
    });
    return;
  }

  try {
    await deleteProvider(provider.providerId);
  } catch (error) {
    logger.error("[ModelProviderSection] 删除模型供应商失败", error);
  }
}

export async function refreshModelProviderSection({
  refresh,
  refreshTeamPlanProducts,
}: {
  refresh: () => Promise<void>;
  refreshTeamPlanProducts?: () => Promise<void>;
}) {
  // The Model Provider top-bar refresh is the account-entitlement refresh entry point.
  // Team Plan connection details come from enterprise pricing/customerInfo and are not updated by a regular provider-list refresh.
  await Promise.all([refresh(), refreshTeamPlanProducts?.()]);
}

export async function refreshProviderPanelAfterAuthChange({
  refreshModelProviders,
  refreshCodingPlanEntitlements,
  refreshTeamPlanProducts,
  refreshCodingPlanProducts,
  refreshPurchaseTokenState,
  refreshPlanSnapshots = true,
}: {
  refreshModelProviders: () => Promise<void>;
  refreshCodingPlanEntitlements: () => Promise<void>;
  refreshTeamPlanProducts: (options?: { force?: boolean }) => Promise<void>;
  refreshCodingPlanProducts: () => void;
  refreshPurchaseTokenState: () => Promise<unknown>;
  refreshPlanSnapshots?: boolean;
}): Promise<void> {
  await refreshPurchaseTokenState();
  if (refreshPlanSnapshots) {
    await Promise.all([
      refreshModelProviders(),
      refreshCodingPlanEntitlements(),
      refreshTeamPlanProducts({ force: true }),
    ]);
  } else {
    // Switching connection mode only saves the local connection choice and refreshes the target provider key.
    // Do not also refresh today's balance/plan snapshot, which would multiply concurrent Start Plan balance and entitlement queries.
    await refreshModelProviders();
  }
  refreshCodingPlanProducts();
}
