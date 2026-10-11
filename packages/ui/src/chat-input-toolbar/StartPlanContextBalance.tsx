import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
import { Loader2Icon, RocketIcon } from "lucide-react";
import type { UsageEntitlementSnapshot, UsageQuotaLimit } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import {
  CodingPlanBillingDiscountBadgePill,
  CodingPlanBillingDiscountInfoDialog,
  useCodingPlanBillingDiscount,
} from "@/CodingPlanBillingDiscount.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getContextQuotaMeterGridClass } from "@/chat-input-toolbar/contextQuotaMeterGrid.js";
import { formatStartPlanBucketResetTime } from "@/lib/codingPlanQuotaPresentation.js";
import { formatQuotaModelDisplayName } from "@/settings/model-provider-section/quotaModelDisplayName.js";

export interface ChatStartPlanBalanceConfig {
  loading: boolean;
  /** Silent access refresh started when hovering to open the context panel (same semantics as onAccess in the Coding Plan section). */
  onAccess?: () => Promise<void> | void;
  onUpgradeClick?: () => void;
  /** Whether the refresh promise started by hover is pending; silent refresh does not set entitlement.loading, so the spinner must track this promise. */
  refreshing?: boolean;
  snapshot: UsageEntitlementSnapshot | null;
}

function resolveLimitTotal(limit: UsageQuotaLimit): number {
  return limit.number ?? limit.unit ?? 0;
}

function resolveLimitRemaining(limit: UsageQuotaLimit): number {
  return limit.remaining ?? 0;
}

function formatStartPlanRemainingPercentage(ratio: number, locale: string): string {
  const boundedRatio = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  return new Intl.NumberFormat(locale || undefined, {
    maximumFractionDigits: 0,
    style: "percent",
  }).format(boundedRatio);
}

function formatModelCode(modelCode: string): string {
  const normalized = modelCode.replace(/^model:/i, "");
  if (normalized.toLowerCase() === "glm-5-turbo") {
    return "GLM-5Turbo";
  }
  return normalized.toUpperCase();
}

function formatLimitModels(limit: UsageQuotaLimit): string {
  const modelNames = limit.usageDetails
    .map((detail) => {
      const displayName = detail.displayName?.trim();
      return formatQuotaModelDisplayName(displayName || formatModelCode(detail.modelCode.trim()));
    })
    .filter((modelName) => modelName.length > 0);
  if (modelNames.length === 0) {
    return limit.type;
  }

  return modelNames.join(" / ");
}

function getVisibleStartPlanLimits(snapshot: UsageEntitlementSnapshot | null): UsageQuotaLimit[] {
  return (snapshot?.quota?.limits ?? []).filter((limit) => {
    const total = resolveLimitTotal(limit);
    const remaining = resolveLimitRemaining(limit);
    return total > 0 || remaining > 0;
  });
}

export function hasChatStartPlanBalance(config: ChatStartPlanBalanceConfig | undefined): boolean {
  if (!config) {
    return false;
  }
  return (
    config.loading ||
    getVisibleStartPlanLimits(config.snapshot).length > 0 ||
    // Start Plan and Coding Plan connections are mutually exclusive, so the hover refresh entry cannot live only on the Coding Plan
    // configuration. Without a cached snapshot on first load, this section (including the trigger) would not render and users would have no hover entry point to request the initial balance.
    // Treat onAccess as sufficient for on-demand refresh and keep the trigger (matching the hasChatCodingPlanUsageRemaining fallback).
    Boolean(config.onAccess)
  );
}

function ChatStartPlanBalanceMeter({ limit, locale }: { limit: UsageQuotaLimit; locale: string }) {
  const total = resolveLimitTotal(limit);
  const remaining = resolveLimitRemaining(limit);
  const remainingRatio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  // Bucket refresh time comes only from this bucket’s expires_at (nextResetTime); do not use plan-level renewTime
  // or global aggregate time as a fallback, or the same time would be copied into every bucket when multiple plans exist.
  const renewTime = formatStartPlanBucketResetTime(locale, limit.nextResetTime);

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="min-w-0 space-y-0.5 text-ui-sm">
        <div className="min-w-0 truncate text-foreground-subtle">{formatLimitModels(limit)}</div>
        <div className="min-w-0 text-ui-sm tabular-nums">
          <span className="font-mono text-foreground">
            {formatStartPlanRemainingPercentage(remainingRatio, locale)}
          </span>
          {renewTime ? <span className="text-foreground-subtle"> · {renewTime}</span> : null}
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
        {/* Fix reason: Match the Coding Plan quota bar: after a silent refresh completes on hover, transition smoothly to the new width.
            The original sudden jump made the refresh imperceptible; retain the motion-reduce accessibility fallback. */}
        <div
          className="h-full rounded-full bg-success transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${remainingRatio * 100}%` }}
        />
      </div>
    </div>
  );
}

export function ChatStartPlanBalancePanel({
  config,
  intl,
  locale,
  separated = false,
}: {
  config: ChatStartPlanBalanceConfig;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  separated?: boolean;
}) {
  const billingDiscount = useCodingPlanBillingDiscount();
  const upgradeButtonHighlighted = billingDiscount.active === true;
  const limits = getVisibleStartPlanLimits(config.snapshot);

  if (!config.loading && limits.length === 0) {
    return null;
  }

  return (
    <div className={separated ? "border-t border-border pt-2" : undefined}>
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.startPlan.balance.title" })}
          </span>
          {config.loading || config.refreshing === true ? (
            // A silent access refresh with a cached snapshot does not set entitlement.loading to true.
            // The spinner must also follow the promise started by hover (refreshing), matching the Coding Plan section.
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
          ) : null}
        </div>
        {config.onUpgradeClick ? (
          <div className="inline-flex shrink-0 items-center gap-1">
            <CodingPlanEntryButton
              type="button"
              size="xs"
              className={cn(
                "h-6 shrink-0 gap-1 px-2 text-ui-sm",
                upgradeButtonHighlighted &&
                  "button-gradient rounded-full pr-[5px] text-white hover:bg-transparent hover:opacity-90 dark:bg-[#484A58] dark:hover:bg-[#484A58]",
              )}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                config.onUpgradeClick?.();
              }}
            >
              <RocketIcon className="size-3" />
              {intl.formatMessage({ id: "chat.quota.action.upgrade" })}
              {upgradeButtonHighlighted ? (
                <CodingPlanBillingDiscountBadgePill
                  config={billingDiscount.config}
                  iconVisible={false}
                  size="compact"
                  variant="surface"
                />
              ) : null}
            </CodingPlanEntryButton>
            {upgradeButtonHighlighted ? (
              <CodingPlanBillingDiscountInfoDialog config={billingDiscount.config} />
            ) : null}
          </div>
        ) : null}
      </div>
      <div className={cn("grid gap-2", getContextQuotaMeterGridClass(limits.length))}>
        {limits.map((limit) => (
          <ChatStartPlanBalanceMeter
            key={`${limit.type}:${formatLimitModels(limit)}`}
            limit={limit}
            locale={locale}
          />
        ))}
      </div>
    </div>
  );
}
