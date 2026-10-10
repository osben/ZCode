import { useCallback } from "react";
import { resolveModelProviderFamilyIdByProviderId } from "@zcode/shared";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useServices } from "@/hooks/useServices.js";
import { type CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";
import { resolveCodingPlanUpgradeProductsProviderId } from "@/settings/model-provider-section/codingPlanPricingCards.js";
import { normalizeCodingPlanProviderId } from "@/settings/model-provider-section/codingPlanPurchaseAuth.js";
import { useCodingPlanEntitlements } from "@/settings/model-provider-section/useCodingPlanEntitlements.js";
import {
  beginCodingPlanUpgradeLogin,
  resolvePendingCodingPlanUpgradeAfterLogin,
  type CodingPlanUpgradeDialogTarget,
} from "@/settings/codingPlanUpgradeLoginRecovery.js";
import { CodingPlanEmbeddedWebviewDialog } from "@/settings/CodingPlanEmbeddedWebviewDialog.js";
import { logger } from "@/logger.js";

export { isCodingPlanPurchaseAuthPending } from "@/settings/model-provider-section/codingPlanPurchaseAuth.js";
export {
  beginCodingPlanUpgradeLogin,
  resolvePendingCodingPlanUpgradeAfterLogin,
} from "@/settings/codingPlanUpgradeLoginRecovery.js";
export type { CodingPlanUpgradeDialogTarget } from "@/settings/codingPlanUpgradeLoginRecovery.js";

interface CodingPlanUpgradeDialogProps {
  target?: CodingPlanUpgradeDialogTarget;
  onClose: () => void;
  onOpenResult?: (opened: boolean) => void;
  // Compatibility with the existing CodingPlanUpgradeDialogProvider contract.
  // The purchase/sign-in flow moved into the official-site WebView, so App no longer needs the "close dialog to sign in → reopen on success"
  // recovery path. This prop is currently unused; keep the signature to avoid changing the Provider.
  onReopen?: (target: CodingPlanUpgradeDialogTarget) => void;
}

// Completion refresh: called after the official-site page reports a successful purchase through window.zcodeBridge.notifyPurchaseComplete.
async function refreshCodingPlanUpgradeCompletion(params: {
  productsProviderId: CodingPlanProviderId | null;
  providerId: CodingPlanProviderId | null;
  refreshCodingPlanEntitlements: () => Promise<unknown> | unknown;
  refreshProviderState: () => Promise<unknown> | unknown;
  refreshTeamPlanProducts?: () => Promise<unknown> | unknown;
}) {
  await Promise.all([
    params.refreshProviderState(),
    params.refreshCodingPlanEntitlements(),
    // The Team Plan connection entry depends on authenticated pricing/customer project snapshots.
    // Refresh it before closing the global purchase dialog so the new team project is visible after Done.
    params.refreshTeamPlanProducts?.(),
  ]);
}

async function closeAndRefreshCodingPlanUpgradeFromWebview(params: {
  onClose: () => void;
  refresh: () => Promise<unknown> | unknown;
  onRefreshError?: (error: unknown) => void;
}) {
  // The completion signal from the official-site WebView means "close the upgrade dialog and refresh the provider."
  // Close first so a slow provider/entitlement refresh cannot keep the user in the WebView after a successful payment.
  params.onClose();
  try {
    await params.refresh();
  } catch (error) {
    params.onRefreshError?.(error);
  }
}

export function CodingPlanUpgradeDialog({
  target,
  onClose,
  onOpenResult,
}: CodingPlanUpgradeDialogProps) {
  const { providerSettingsService, credentialService, codingPlanSubscriptionService } =
    useServices();
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const { refresh: refreshCodingPlanEntitlements } = useCodingPlanEntitlements({
    providerSettingsView,
  });

  const providerId = normalizeCodingPlanProviderId(target?.providerId);
  const productsProviderId = providerId
    ? resolveCodingPlanUpgradeProductsProviderId(providerId)
    : null;
  const teamPlanFamily = productsProviderId
    ? resolveModelProviderFamilyIdByProviderId(productsProviderId)
    : null;
  const refreshProviderState = useCallback(
    () => providerSettingsService.refresh("coding-plan-purchase-complete"),
    [providerSettingsService],
  );
  // Official-site purchase completion: the WebView tells App to close the upgrade dialog and refresh the current provider in the background.
  const handlePurchaseComplete = useCallback(async () => {
    await closeAndRefreshCodingPlanUpgradeFromWebview({
      onClose,
      refresh: () =>
        refreshCodingPlanUpgradeCompletion({
          productsProviderId,
          providerId,
          refreshCodingPlanEntitlements,
          refreshProviderState,
          refreshTeamPlanProducts:
            teamPlanFamily !== null
              ? () =>
                  // After purchase completes, the WebView dialog closes first and its hook unmounts immediately.
                  // Fetch the current family's team projects directly through the service so unmount timing cannot swallow the refresh request.
                  codingPlanSubscriptionService.getEnterprisePricing({
                    authenticated: true,
                    family: teamPlanFamily,
                  })
              : undefined,
        }),
      onRefreshError: (error) => {
        // Refresh failure must not block closing: the user has paid successfully, and the plan will update on the next normal refresh.
        logger.warn("[CodingPlanUpgradeDialog] 购买完成后刷新状态失败", {
          providerId,
          productsProviderId,
          error,
        });
      },
    });
  }, [
    codingPlanSubscriptionService,
    onClose,
    productsProviderId,
    providerId,
    refreshCodingPlanEntitlements,
    refreshProviderState,
    teamPlanFamily,
  ]);

  if (!target || !providerId || !productsProviderId) {
    return null;
  }

  return (
    <CodingPlanEmbeddedWebviewDialog
      open
      onOpenResult={onOpenResult}
      credentialService={credentialService}
      providerId={providerId}
      funnelContext={target.funnelContext}
      audience={target.initialAudience}
      teamPlanKey={target.initialTeamPlanKey}
      onPurchaseComplete={handlePurchaseComplete}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    />
  );
}
