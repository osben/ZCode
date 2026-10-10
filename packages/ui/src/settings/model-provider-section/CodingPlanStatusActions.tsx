import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
import { ArrowLeftIcon, Loader2Icon, RocketIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodingPlanLoginOptions } from "./codingPlanPricingCards.js";

export function CodingPlanStatusActions({
  providerName,
  isDisconnected,
  isUnavailable,
  isPurchased,
  loginLoading,
  loginButtonId,
  loginVisible,
  canDisconnectProvider,
  disconnectLoading,
  onLogin,
  onDisconnect,
}: {
  providerName: string;
  isDisconnected: boolean;
  isUnavailable: boolean;
  isPurchased: boolean;
  loginLoading?: boolean;
  loginButtonId: string;
  loginVisible: boolean;
  canDisconnectProvider: boolean;
  disconnectLoading?: boolean;
  onLogin?: (options?: CodingPlanLoginOptions) => void;
  onDisconnect?: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex shrink-0 flex-wrap justify-start gap-2">
      {loginVisible && (isDisconnected || isUnavailable) && onLogin ? (
        <Button type="button" size="lg" onClick={() => onLogin()} disabled={loginLoading}>
          {loginLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {intl.formatMessage({ id: loginButtonId }, { provider: providerName })}
        </Button>
      ) : null}
      {canDisconnectProvider && onDisconnect && !isPurchased ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={disconnectLoading}
          onClick={onDisconnect}
        >
          {disconnectLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {intl.formatMessage({
            id: "settings.modelProvider.codingPlan.disconnect",
          })}
        </Button>
      ) : null}
    </div>
  );
}

export function CodingPlanUpgradeAction({
  loginLoading,
  upgradePlansVisible,
  actionLabelId = "settings.modelProvider.codingPlan.upgrade",
  onUpgradePlansVisibleChange,
}: {
  loginLoading?: boolean;
  upgradePlansVisible: boolean;
  actionLabelId?: string;
  onUpgradePlansVisibleChange: (visible: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  // The open-source edition is not eligible for quota promotions; the upgrade entry shows the action without a discount badge or promotion details.
  return (
    <CodingPlanEntryButton
      bypassGate={upgradePlansVisible}
      type="button"
      size="lg"
      onClick={() => {
        // The purchase/upgrade entry must open the panel first. The panel handles expired OAuth after the user selects
        // a plan/cycle, so clicking Upgrade does not jump straight to login and hide the purchase flow.
        onUpgradePlansVisibleChange(!upgradePlansVisible);
      }}
      disabled={loginLoading}
    >
      {loginLoading ? (
        // Upgrade may first refresh the OAuth business token.
        // Without a spinner while disabled, users may think the click did not register.
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : upgradePlansVisible ? (
        <ArrowLeftIcon className="size-3.5" />
      ) : (
        <RocketIcon className="size-3.5" />
      )}
      {intl.formatMessage({
        id: upgradePlansVisible ? "settings.modelProvider.codingPlan.cancelUpgrade" : actionLabelId,
      })}
    </CodingPlanEntryButton>
  );
}
