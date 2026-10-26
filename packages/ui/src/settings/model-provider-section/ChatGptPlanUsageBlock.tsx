/**
 * Usage windows of one ChatGPT plan account (specs/chatgpt-plan-signin.md "Usage display (Settings)"): a meter,
 * the share left, and a "Resets in" countdown per window, with stale and reset-pending states.
 */
import type { SiwcPlanUsageSnapshot, SiwcPlanUsageWindow } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  usageRemainingPercent,
  usageResetAbsolute,
  usageResetCountdown,
  usageSeverity,
  usageStaleMinutes,
  usageWindowLabel,
  type UsageMessage,
  type UsageSeverity,
  type UsageWindowRole,
} from "./chatgptPlanUsage.js";

const SEVERITY_BAR: Record<UsageSeverity, string> = {
  normal: "bg-primary",
  warning: "bg-warning",
  critical: "bg-destructive",
};

function UsageWindowRow({
  window,
  role,
  limitReached,
  nowMs,
}: {
  window: SiwcPlanUsageWindow;
  role: UsageWindowRole;
  limitReached: boolean;
  nowMs: number;
}) {
  const { intl, locale } = useZCodeIntl();
  const format = (message: UsageMessage) => intl.formatMessage({ id: message.id }, message.values);
  const label = format(usageWindowLabel(window, role));
  const countdown = usageResetCountdown(window.resetsAt, nowMs);
  if (countdown === "pending") {
    return (
      <div
        className="flex min-w-0 flex-col gap-1"
        data-testid="chatgpt-plan-usage-window"
        data-role={role}
      >
        <div className="flex min-w-0 items-center justify-between gap-2 text-ui-sm">
          <span className="text-foreground">{label}</span>
          <span className="text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.chatgpt.usage.resetPending" })}
          </span>
        </div>
      </div>
    );
  }
  const severity = usageSeverity(window.usedPercent, role === "primary" && limitReached);
  const remaining = usageRemainingPercent(window.usedPercent);
  const left = intl.formatMessage(
    { id: "settings.modelProvider.chatgpt.usage.left" },
    { percent: remaining },
  );
  const severityText = intl.formatMessage({
    id: `settings.modelProvider.chatgpt.usage.severity.${severity}`,
  });
  const absolute = window.resetsAt ? usageResetAbsolute(window.resetsAt, nowMs, locale) : null;
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-testid="chatgpt-plan-usage-window"
      data-role={role}
      data-severity={severity}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 text-ui-sm">
        <span className="text-foreground">{label}</span>
        <span className="tabular-nums text-foreground-subtle">{left}</span>
      </div>
      <div
        role="meter"
        aria-label={`${label}: ${left}, ${severityText}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining}
        className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10"
      >
        <div
          className={`h-full rounded-full ${SEVERITY_BAR[severity]}`}
          style={{ width: `${remaining}%` }}
        />
      </div>
      {countdown ? (
        <span className="text-ui-sm text-foreground-subtle" title={absolute ?? undefined}>
          {intl.formatMessage(
            { id: "settings.modelProvider.chatgpt.usage.resetsIn" },
            { duration: format(countdown) },
          )}
        </span>
      ) : null}
    </div>
  );
}

export function ChatGptPlanUsageBlock({
  usage,
  nowMs,
}: {
  usage: SiwcPlanUsageSnapshot;
  nowMs: number;
}) {
  const { intl } = useZCodeIntl();
  const staleMinutes = usageStaleMinutes(usage, nowMs);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="chatgpt-plan-usage">
      {usage.limitReached ? (
        <p role="alert" className="text-ui-sm font-medium text-destructive">
          {intl.formatMessage({ id: "settings.modelProvider.chatgpt.usage.limitReached" })}
        </p>
      ) : null}
      <UsageWindowRow
        window={usage.primary}
        role="primary"
        limitReached={usage.limitReached === true}
        nowMs={nowMs}
      />
      {usage.secondary ? (
        <UsageWindowRow
          window={usage.secondary}
          role="secondary"
          limitReached={false}
          nowMs={nowMs}
        />
      ) : null}
      {staleMinutes !== null ? (
        <p className="text-ui-sm text-foreground-subtle" data-testid="chatgpt-plan-usage-stale">
          {intl.formatMessage(
            { id: "settings.modelProvider.chatgpt.usage.stale" },
            { minutes: staleMinutes },
          )}
        </p>
      ) : null}
    </div>
  );
}
