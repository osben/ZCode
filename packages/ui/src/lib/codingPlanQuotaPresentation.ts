import type { UsageEntitlementSnapshot, UsageQuotaLimit } from "@zcode/shared";

type CodingPlanQuotaResetFormat = "date" | "dateTime" | "adaptive";

/**
 * Equivalent types for Token / Credit quotas.
 *
 * The zai business backend uses `CREDIT_LIMIT` as the type for Team Plan quota/limit,
 * while the bigmodel backend uses `TOKENS_LIMIT`. Their unit/number semantics are identical
 *(unit=3,number=5 → a 5-hour window; unit=6 → weekly); only the type enum names differ.
 * Treat these two types as equivalent here so zai/bigmodel team plans match in the same UI consumers.
 * This set remains compatible if the zai backend later aligns on TOKENS_LIMIT.
 */
const TOKEN_LIMIT_TYPES = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT"]);

/**
 * Type for Tool quotas.
 * Both bigmodel and zai backends currently use TIME_LIMIT for monthly tool-call quotas, so no equivalence set is needed.
 */
const TOOL_LIMIT_TYPES = new Set(["TIME_LIMIT"]);

export function isSameLimitCategory(
  limitType: string,
  queryType: UsageQuotaLimit["type"],
): boolean {
  if (limitType === queryType) {
    return true;
  }
  // A zai team plan returns CREDIT_LIMIT, which must also match when consumers query by TOKENS_LIMIT.
  if (TOKEN_LIMIT_TYPES.has(queryType)) {
    return TOKEN_LIMIT_TYPES.has(limitType);
  }
  if (TOOL_LIMIT_TYPES.has(queryType)) {
    return TOOL_LIMIT_TYPES.has(limitType);
  }
  return false;
}

export function findCodingPlanQuotaLimit(
  limits: UsageQuotaLimit[] | undefined,
  type: UsageQuotaLimit["type"],
  unit: number,
  number?: number,
): UsageQuotaLimit | null {
  return (
    limits?.find(
      (limit) =>
        isSameLimitCategory(limit.type, type) &&
        limit.unit === unit &&
        (number == null || limit.number === number),
    ) ?? null
  );
}

/**
 * Official Server MCP quota (total quota sent by the server).
 *
 * The server places it in a separate field of the entitlement snapshot rather than quota.limits[], so it cannot use
 * findCodingPlanQuotaLimit; centralize it as the only read path here instead of duplicating the `?.` chain in each display.
 */
export function resolveMcpQuotaLimit(
  snapshot: UsageEntitlementSnapshot | null | undefined,
): UsageQuotaLimit | null {
  return snapshot?.mcpQuota?.aggregate ?? null;
}

export function getQuotaRemainingPercentage(limit: UsageQuotaLimit | null): number | null {
  if (typeof limit?.percentage !== "number" || !Number.isFinite(limit.percentage)) {
    return null;
  }

  // The quota API’s percentage represents the amount used, while Usage Remaining and
  // usage-stat quota cards both represent “how much remains.” Invert it consistently here so the two displays agree.
  return Math.max(0, Math.min(100, 100 - limit.percentage));
}

/**
 * When 100% of the quota remains (no usage yet), resetting has no benefit; the UI hides the “Reset” button and opportunity badge.
 * This is a display-only gate; it does not affect server allocation, status polling, or opportunity state itself.
 * The processing/completed displays do not use this check, so completion feedback for a manual reset still plays fully.
 */
export function isCodingPlanQuotaLimitFull(limit: UsageQuotaLimit | null | undefined): boolean {
  return getQuotaRemainingPercentage(limit ?? null) === 100;
}

export function formatQuotaRemainingPercentage(
  locale: string,
  limit: UsageQuotaLimit | null,
): string {
  const remainingPercentage = getQuotaRemainingPercentage(limit);
  if (remainingPercentage == null) {
    return "--";
  }

  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: remainingPercentage >= 10 ? 0 : 1,
  }).format(remainingPercentage)}%`;
}

/**
 * The single formatting entry point for Start Plan quota-bucket renewal times (shared by the settings balance card and chat-input bubble).
 *
 * Both surfaces once maintained identical copies of formatStartPlanBalanceRenewTime;
 * updating only one caused inconsistent displays. Match the Coding Plan format for bucket renewal times:
 * show only HH:mm for today and only the date for other days.
 */
export function formatStartPlanBucketResetTime(
  locale: string,
  value: number | null | undefined,
): string | undefined {
  return formatQuotaResetTime({ locale, value, format: "adaptive" });
}

export function formatQuotaResetTime(params: {
  locale: string;
  value: number | null | undefined;
  format: CodingPlanQuotaResetFormat;
  compactToday?: boolean;
}): string | undefined {
  if (!params.value) {
    return undefined;
  }

  const resetAt = new Date(params.value);
  if (Number.isNaN(resetAt.getTime())) {
    return undefined;
  }

  const now = new Date();
  const isToday =
    resetAt.getFullYear() === now.getFullYear() &&
    resetAt.getMonth() === now.getMonth() &&
    resetAt.getDate() === now.getDate();

  if (params.format === "date") {
    return new Intl.DateTimeFormat(params.locale, {
      month: "short",
      day: "numeric",
    }).format(resetAt);
  }

  // adaptive: show only HH:mm for today (the time is actionable), and only the date for other days
  // (matching the display semantics of Coding Plan's 5-hour window and weekly/monthly resets).
  if (params.format === "adaptive") {
    if (isToday) {
      return new Intl.DateTimeFormat(params.locale, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(resetAt);
    }
    return new Intl.DateTimeFormat(params.locale, {
      month: "short",
      day: "numeric",
    }).format(resetAt);
  }

  return new Intl.DateTimeFormat(params.locale, {
    ...(params.compactToday && isToday
      ? {}
      : {
          month: "short",
          day: "numeric",
        }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(resetAt);
}
