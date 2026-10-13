import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CodingPlanBillingDiscountConfig } from "@zcode/shared";
import { InfoIcon, RocketIcon, XIcon } from "lucide-react";
import {
  CodingPlanBillingDiscountBadgePill,
  CodingPlanBillingDiscountInfoDialog,
} from "@/CodingPlanBillingDiscount.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { codingPlanAutoContinueDelayMs } from "@/lib/codingPlanLimitAutoContinue.js";
import type {
  SessionQuotaBannerKind,
  SessionQuotaBannerState,
} from "@/v4/sessionQuotaBannerState.js";

const MESSAGE_IDS: Record<SessionQuotaBannerKind, string> = {
  "model-very-low": "chat.quota.startPlan.modelVeryLow",
  "model-exhausted": "chat.quota.startPlan.modelExhausted",
  "daily-exhausted": "chat.quota.startPlan.dailyExhausted",
  "concurrent-limit": "chat.quota.startPlan.concurrentLimit",
  "provider-limited": "chat.quota.providerLimited",
  "mcp-quota-exhausted": "chat.quota.mcp.quotaExhausted",
  "mcp-plan-required": "chat.quota.mcp.codingPlanRequired",
};

function resolveMessageId(state: SessionQuotaBannerState): string {
  if (state.kind === "model-very-low") {
    return state.quotaPeriod === "daily"
      ? "chat.quota.startPlan.bucketDailyLow"
      : state.quotaPeriod === "one_time"
        ? "chat.quota.startPlan.bucketActivityLow"
        : "chat.quota.startPlan.modelVeryLow";
  }
  if (state.kind === "concurrent-limit") {
    return state.concurrentLimitReason === "retry-exhausted-busy"
      ? "chat.quota.startPlan.concurrentLimit.retryExhausted"
      : "chat.quota.startPlan.concurrentLimit";
  }
  return state.kind ? MESSAGE_IDS[state.kind] : "";
}

function formatTokenCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat().format(Math.max(0, Math.floor(value)));
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

export function ConversationQuotaBanner({
  state,
  billingDiscountActive,
  billingDiscountConfig,
  upgradeActionLabelId = "chat.quota.action.upgrade",
  onUpgrade,
  onDismiss,
  onShown,
  autoContinueDefault = true,
  autoContinueReady = true,
  onAutoContinue,
}: {
  state: SessionQuotaBannerState;
  billingDiscountActive?: boolean;
  billingDiscountConfig?: CodingPlanBillingDiscountConfig;
  upgradeActionLabelId?: string;
  onUpgrade?: () => void;
  onDismiss: () => void;
  onShown?: () => void;
  autoContinueDefault?: boolean;
  autoContinueReady?: boolean;
  onAutoContinue?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const bannerRef = useRef<HTMLDivElement>(null);
  const [autoContinue, setAutoContinue] = useState(autoContinueReady && autoContinueDefault);
  const autoContinueInitialized = useRef(autoContinueReady);
  const hasAutoContinueCallback = typeof onAutoContinue === "function";
  const onAutoContinueRef = useRef(onAutoContinue);
  useLayoutEffect(() => {
    onAutoContinueRef.current = onAutoContinue;
  }, [onAutoContinue]);
  useEffect(() => {
    if (!onShown || !state.visible || !bannerRef.current) return;
    // Background tasks also compute quota state; consume the bucket's one reminder per period only when it is actually visible.
    let intersecting = false;
    const report = () => {
      if (intersecting && document.visibilityState === "visible") onShown();
    };
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry?.isIntersecting ?? false;
      report();
    });
    observer.observe(bannerRef.current);
    document.addEventListener("visibilitychange", report);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", report);
    };
  }, [onShown, state.visible]);
  useEffect(() => {
    if (autoContinueInitialized.current || !autoContinueReady) return;
    autoContinueInitialized.current = true;
    setAutoContinue(autoContinueDefault);
  }, [autoContinueDefault, autoContinueReady]);
  useEffect(() => {
    if (
      !autoContinueReady ||
      !autoContinue ||
      !state.visible ||
      state.providerLimitedResetAt === null ||
      !hasAutoContinueCallback
    ) {
      return;
    }
    const delayMs = codingPlanAutoContinueDelayMs(
      state.providerLimitedResetAt,
      Date.now(),
      Math.random(),
    );
    const timer = setTimeout(() => onAutoContinueRef.current?.(), delayMs);
    return () => clearTimeout(timer);
  }, [
    autoContinue,
    autoContinueReady,
    hasAutoContinueCallback,
    state.providerLimitedResetAt,
    state.visible,
  ]);
  if (!state.visible || !state.kind) return null;

  const resetTime =
    state.kind === "provider-limited" && state.providerLimitedResetAt !== null
      ? new Intl.DateTimeFormat(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(state.providerLimitedResetAt)
      : null;
  const message = (() => {
    if (resetTime) {
      return intl.formatMessage({ id: "chat.quota.providerLimited.resetAt" }, { time: resetTime });
    }
    if (state.kind === "provider-limited" && state.providerLimitedMessage) {
      return state.providerLimitedMessage;
    }
    return intl.formatMessage(
      { id: resolveMessageId(state) },
      {
        model: state.modelName ?? "",
        // The MCP notice names a specific server; the server-side text is English, so all UI copy must use i18n.
        server: state.mcpServerName ?? "",
        remaining:
          state.remainingTokens === null
            ? formatTokenCount(null)
            : new Intl.NumberFormat(locale, {
                notation: "compact",
                maximumFractionDigits: 1,
              }).format(state.remainingTokens),
        percent: formatPercent(state.remainingPercent),
      },
    );
  })();
  const showBillingDiscountBadge = Boolean(onUpgrade) && billingDiscountActive === true;

  return (
    <div
      ref={bannerRef}
      className="mb-3 w-full px-4 max-md:px-2"
      data-testid="v4-session-quota-banner"
    >
      <div className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-ui-base text-foreground">
          <InfoIcon className="size-4 shrink-0" />
          <div className="min-w-0 break-words">{message}</div>
        </div>
        {onUpgrade ? (
          <div className="inline-flex shrink-0 items-center gap-1">
            <CodingPlanEntryButton
              type="button"
              size="sm"
              className={cn(
                "h-auto gap-1.5 rounded-full",
                // Bugfix: The V4 migration restored only the white promotional badge and omitted the matching promotional background on the upgrade button,
                // making it clash with the default black background. Keep it consistent with the Model Settings and Context panels.
                showBillingDiscountBadge &&
                  "button-gradient pr-px text-white hover:bg-transparent hover:opacity-90 dark:bg-[#484A58] dark:hover:bg-[#484A58]",
              )}
              onClick={onUpgrade}
            >
              <RocketIcon className="size-3.5" />
              {intl.formatMessage({ id: upgradeActionLabelId })}
              {showBillingDiscountBadge ? (
                <CodingPlanBillingDiscountBadgePill
                  config={billingDiscountConfig}
                  iconVisible={false}
                  variant="surface"
                />
              ) : null}
            </CodingPlanEntryButton>
            {showBillingDiscountBadge ? (
              <CodingPlanBillingDiscountInfoDialog config={billingDiscountConfig} />
            ) : null}
          </div>
        ) : null}
        {state.providerLimitedResetAt !== null ? (
          <label className="inline-flex shrink-0 items-center gap-2 text-ui-sm text-foreground">
            <Checkbox
              aria-label={intl.formatMessage({ id: "chat.quota.providerLimited.autoContinue" })}
              checked={autoContinue}
              disabled={!autoContinueReady}
              onCheckedChange={(checked) => setAutoContinue(checked === true)}
            />
            {intl.formatMessage({ id: "chat.quota.providerLimited.autoContinue" })}
          </label>
        ) : null}
        {state.dismissible ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onDismiss}
            aria-label={intl.formatMessage({ id: "common.close" })}
            className="shrink-0 rounded-full text-foreground-subtle hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
