/* eslint-disable max-lines -- Cross-process Usage, Entitlement, and Reset protocols temporarily share one set of Account Access fields and runtime schemas here. */
import { z } from "zod";

// Quota types live in usage-quota.ts; see its header for details. Re-export them here to preserve existing import paths.
export * from "./usage-quota.js";
import type { UsageMcpQuotaSnapshot, UsageQuotaSnapshot } from "./usage-quota.js";
import type { ZCodeAccountAccess, ZCodeProviderAccountAccess } from "./zcode-protocol/index.js";

export const ESTIMATED_TOKEN_CHAR_DIVISOR = 3;

export type UsageStatsRange = "all" | "7d" | "30d";
export type CodingPlanUsageRange = "today" | "7d" | "30d" | "custom";
export type CodingPlanUsageGranularity = "hour" | "day";
export type CodingPlanUsageDetailMetric = "credits" | "usage";
export type CodingPlanUsageDetailSubject = "model" | "tool";

export interface UsageStatsRequest {
  range: UsageStatsRange;
  /** Usage-statistics source. App Usage explicitly uses local session aggregation; Coding Plan explicitly uses the monitor API. */
  dataSource?: "local" | "monitor";
  /** The Settings page can pass the user's selected Z.AI / BigModel source, avoiding an implicit choice when both are configured. */
  preferredProviderId?: string;
  /** Static Registry access category or dynamic account-access context resolved at the call boundary. */
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  /** When a source is specified, it must match preferredProviderId; do not fall back to another provider or local aggregation. */
  requirePreferredProvider?: boolean;
  /** Whether host environment variables may override the provider key. Allowed by default; can be disabled for an explicit provider. */
  allowEnvApiKey?: boolean;
  /**
   * Bucket statistics by the caller's time zone.
   * The UI defaults to the browser's current time zone; the host falls back to the system time zone when omitted.
   */
  timeZone?: string;
}

export interface CodingPlanUsageRequest {
  range: CodingPlanUsageRange;
  /** Custom date range. Applies only when range=custom; interpreted as calendar days in the caller's time zone, up to 30 days. */
  customStartDate?: string | null;
  customEndDate?: string | null;
  preferredProviderId: string;
  /** Static Registry access category or the dynamic account-access context bound to this Team query. */
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  timeZone?: string;
}

/** Highspeed reads only the regular Pro/Max decode TPS; it does not trigger the full Coding Plan usage aggregation. */
export interface CodingPlanRegularTpsRequest {
  preferredProviderId: string;
  /**
   * Static Registry access category or dynamic account-access context resolved at the call boundary.
   *
   * Bug cause: this request previously carried only organizationId/projectId, and request-time
   * authorization relied on the host guessing the account per provider. After the provider
   * refactor, Coding Plan authorization is resolved uniformly through accountAccess (Team scope is
   * included there); when it is missing, resolveAuthorization necessarily returns null, and the
   * time-saver silently shows nothing.
   */
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  timeZone?: string;
}

export interface UsageEntitlementRequest {
  /** Invalidate the corresponding Start Plan balance cache briefly after a purchase or claim completes. */
  invalidateBalanceCache?: boolean;
  /** Compatibility hint for older callers; Coding Plan entitlements must be fetched from the subscription and summarized, never inferred from quota alone. */
  includeSubscription?: boolean;
  /** The chat composer can pass the selected built-in provider so BigModel/Z.AI usage follows the model selection. */
  preferredProviderId?: string;
  /** Static access category for the specified Account Provider or dynamic account-access context resolved at the call boundary. */
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  /** Allow reading the key even if this built-in provider is hidden in the provider list when the current model explicitly selects it. */
  allowDisabledPreferredProvider?: boolean;
  /** When a source is specified, it must match preferredProviderId; do not fall back to another provider. */
  requirePreferredProvider?: boolean;
  /** Whether host environment variables may override the provider key. Allowed by default; can be disabled for an explicit provider. */
  allowEnvApiKey?: boolean;
}

export interface UsageEntitlementSnapshot {
  generatedAt: number;
  /** Server time from the current quota response (milliseconds), separate from the local snapshot generation time in generatedAt. */
  serverTime?: number;
  authenticated: boolean;
  unavailableReason?: "not_authenticated" | "not_configured" | "no_plan" | "unavailable";
  /** Preserve an explicit expiration reason for display when no Start Plan is available. */
  startPlanExpired?: boolean;
  /** Explicit reason a team subscription is unavailable; returned only with no_plan. */
  teamPlanUnavailableReason?: "expired" | "unassigned";
  /** Personal/team context for the current entitlement query, used by Settings to determine the connection method. */
  context?: UsageEntitlementContext | null;
  /** Model provider currently used to query quota. */
  provider: UsageEntitlementProviderInfo | null;
  remaining: UsageEntitlementRemaining | null;
  subscription: UsageEntitlementSubscription | null;
  quota: UsageQuotaSnapshot | null;
  /**
   * Call quota for the official ZCode Server MCP (`/api/v1/mcp/usage`).
   * It is delivered in the same snapshot as quota to reuse the entitlement cache, in-flight deduplication, and TTL policies.
   * It is null (optional data) if fetching fails, Coding Plan is not enabled, or the quota does not belong to this query's connection.
   */
  mcpQuota?: UsageMcpQuotaSnapshot | null;
}

export interface UsageEntitlementContext {
  scope: "personal" | "team";
  organizationId?: string | null;
  projectId?: string | null;
  displayName?: string | null;
  productId?: string | null;
}

export type PlanIdentityStatus = "coding_plan" | "start_plan" | "no_plan" | "unknown";

export interface PlanIdentitySnapshot {
  generatedAt: number;
  planStatus: PlanIdentityStatus;
  planProductId: string;
}

export interface UsageEntitlementRemaining {
  count: number;
  isShow: boolean;
  percentage?: number;
  nextResetTime?: number | null;
}

export interface UsageEntitlementProviderInfo {
  id: string;
  name: string;
}

export interface UsageEntitlementSubscription {
  identityType: "email" | "phoneNumber" | "unknown";
  identityMasked: string | null;
  details: UsageEntitlementSubscriptionDetail[];
}

export interface UsageEntitlementSubscriptionDetail {
  productId: string;
  productName: string;
  purchaseTime: string | null;
  beginTime: string | null;
  billingCycle?: string | null;
  renewTime?: string | null;
  expireTime: string | null;
  /** Entitlement effective time for a Start Plan balance; optional for other subscription types. */
  entitlements?: Array<{
    entitlementId: string;
    /** Server-side entitlement show_name, used for pending-activation notices. */
    showName?: string | null;
    effectiveTime: string | null;
  }>;
}

export interface UsageStatsSnapshot {
  range: UsageStatsRange;
  generatedAt: number;
  timeZone: string;
  estimatedTokenCharDivisor: number;
  summary: UsageStatsSummary;
  /** Daily series filled with consecutive dates; missing dates are set to 0 for direct use in trend charts. */
  daily: UsageStatsDaySummary[];
  heatmap: UsageStatsHeatmap;
  models: UsageStatsModelUsage[];
  /**
   * Data-source identifier, used by the UI to distinguish provider monitor data from local session aggregation.
   * App Usage explicitly reads local session aggregation; Coding Plan explicitly reads the current provider monitor.
   */
  source?: "bigmodel-monitor" | "local";
  /** Provider for remote usage data, for displaying sources such as BigModel / Z.AI in the UI. */
  sourceProvider?: UsageEntitlementProviderInfo | null;
  /** Tool-call breakdown (available only through the BigModel tool-usage API; omitted for local aggregation). */
  tools?: UsageStatsToolUsage[];
}

// ── App Usage (actual statistics from the agent database) ─────────────
export const APP_USAGE_RANGES = ["all", "7d", "30d"] as const;
export type AppUsageRange = (typeof APP_USAGE_RANGES)[number];

/** Longest custom window the rollup can serve (rollup retention is 2 years). */
export const APP_USAGE_MAX_WINDOW_DAYS = 800;
const APP_USAGE_DAY_MS = 86_400_000;

function appUsageDateToDayIndex(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(time);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(time / APP_USAGE_DAY_MS);
}

const appUsageCalendarDateSchema = z
  .string()
  .refine((value) => appUsageDateToDayIndex(value) !== null, {
    message: "expected a real calendar date as YYYY-MM-DD",
  });

/** Echoed window in responses; no cross-field checks so a newer host can never fail an older client. */
export const appUsageWindowShapeSchema = z.object({
  from: z.string(),
  to: z.string(),
});

/** Inclusive local calendar days in the request time zone. Requests validate the cross-field rules. */
export const appUsageWindowSchema = z
  .object({ from: appUsageCalendarDateSchema, to: appUsageCalendarDateSchema })
  .strict()
  .refine(
    ({ from, to }) => (appUsageDateToDayIndex(from) ?? 0) <= (appUsageDateToDayIndex(to) ?? 0),
    {
      message: "window.from must not be after window.to",
    },
  )
  .refine(
    ({ from, to }) =>
      (appUsageDateToDayIndex(to) ?? 0) - (appUsageDateToDayIndex(from) ?? 0) + 1 <=
      APP_USAGE_MAX_WINDOW_DAYS,
    { message: `window must span at most ${APP_USAGE_MAX_WINDOW_DAYS} days` },
  );

const appUsageFilterValuesSchema = z.array(z.string().max(1024)).max(50);
export const appUsageFiltersSchema = z
  .object({
    modelIds: appUsageFilterValuesSchema.optional(),
    providerIds: appUsageFilterValuesSchema.optional(),
    querySources: appUsageFilterValuesSchema.optional(),
    workspaceKeys: appUsageFilterValuesSchema.optional(),
  })
  .strict();

/**
 * Optional request fields shared by the legacy and v4 usage-stats methods. Additive on purpose:
 * `range` keeps its three values, and a request without these fields behaves exactly as before.
 * With `window`, the bounds come from the window and `range` is only echoed back.
 */
export const APP_USAGE_INCLUDES = ["hourly", "sessions"] as const;
export type AppUsageInclude = (typeof APP_USAGE_INCLUDES)[number];

export const appUsageRequestExtrasShape = {
  window: appUsageWindowSchema.optional(),
  compare: z.boolean().optional(),
  filters: appUsageFiltersSchema.optional(),
  /** Extra breakdowns to compute for the window (hour/weekday grid, busiest sessions). */
  include: z.array(z.enum(APP_USAGE_INCLUDES)).max(APP_USAGE_INCLUDES.length).optional(),
} as const;

export const appUsageFavoriteModelSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
  share: z.number(),
});

export const appUsageSummarySchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheHitRate: z.number(),
  totalSessions: z.number(),
  totalTurns: z.number(),
  toolCallCount: z.number(),
  toolErrorRate: z.number(),
  modelErrorRate: z.number(),
  avgTimeToFirstTokenMs: z.number().nullable(),
  avgTurnDurationMs: z.number().nullable(),
  activeDays: z.number(),
  currentStreakDays: z.number(),
  longestSessionMs: z.number(),
  longestStreakDays: z.number(),
  peakDayTokens: z.number(),
  favoriteModel: appUsageFavoriteModelSchema.nullable(),
});

export const appUsageHeatmapCellSchema = z.object({
  date: z.string(),
  level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  totalTokens: z.number(),
  turnCount: z.number(),
  toolCallCount: z.number(),
});

export const appUsageHeatmapWeekSchema = z.object({
  weekIndex: z.number(),
  days: z.array(appUsageHeatmapCellSchema.nullable()),
});

export const appUsageHeatmapSchema = z.object({
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  maxTokens: z.number(),
  weeks: z.array(appUsageHeatmapWeekSchema),
});

export const appUsageDailyModelItemSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
});

export const appUsageDailyModelUsageSchema = z.object({
  date: z.string(),
  models: z.array(appUsageDailyModelItemSchema),
});

export const appUsageModelUsageSchema = z.object({
  modelId: z.string().nullable(),
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  requestCount: z.number(),
  share: z.number(),
});

export const appUsageToolUsageSchema = z.object({
  toolName: z.string(),
  callCount: z.number(),
  errorCount: z.number(),
  errorRate: z.number(),
  avgDurationMs: z.number().nullable(),
});

/** Previous period of equal length, aligned day by day with the main series. */
export const appUsageComparisonSchema = z.object({
  window: appUsageWindowShapeSchema,
  summary: appUsageSummarySchema,
  dailyTokens: z.array(z.number()),
});

/** Filter options present in the window; workspaces are session directories ('' = unknown). */
export const appUsageFacetsSchema = z.object({
  models: z.array(z.string()),
  providers: z.array(z.string()),
  querySources: z.array(z.string()),
  workspaces: z.array(z.string()),
});

export const appUsageSessionSchema = z.object({
  sessionId: z.string(),
  title: z.string().nullable(),
  workspaceKey: z.string(),
  totalTokens: z.number(),
  turnCount: z.number(),
  durationMs: z.number(),
});

export const appUsageSnapshotSchema = z.object({
  range: z.enum(APP_USAGE_RANGES),
  generatedAt: z.number(),
  timeZone: z.string(),
  source: z.literal("agent-db"),
  summary: appUsageSummarySchema,
  heatmap: appUsageHeatmapSchema,
  dailyModelUsage: z.array(appUsageDailyModelUsageSchema),
  models: z.array(appUsageModelUsageSchema),
  tools: z.array(appUsageToolUsageSchema),
  /** Echo of the requested custom window; absent for preset ranges and from older hosts. */
  window: appUsageWindowShapeSchema.optional(),
  previous: appUsageComparisonSchema.optional(),
  /** Only on the all-time snapshot, and only when the host reads the rollup. */
  facets: appUsageFacetsSchema.optional(),
  /** 168 cells, index = weekday * 24 + hour in the request time zone, Sunday = 0; present on request. */
  hourlyTokens: z
    .array(z.number())
    .length(7 * 24)
    .optional(),
  topSessions: z.array(appUsageSessionSchema).optional(),
});

export type AppUsageSummary = z.infer<typeof appUsageSummarySchema>;
export type AppUsageHeatmapCell = z.infer<typeof appUsageHeatmapCellSchema>;
export type AppUsageHeatmapWeek = z.infer<typeof appUsageHeatmapWeekSchema>;
export type AppUsageHeatmap = z.infer<typeof appUsageHeatmapSchema>;
export type AppUsageDailyModelItem = z.infer<typeof appUsageDailyModelItemSchema>;
export type AppUsageDailyModelUsage = z.infer<typeof appUsageDailyModelUsageSchema>;
export type AppUsageModelUsage = z.infer<typeof appUsageModelUsageSchema>;
export type AppUsageToolUsage = z.infer<typeof appUsageToolUsageSchema>;
export type AppUsageFavoriteModel = z.infer<typeof appUsageFavoriteModelSchema>;
export type AppUsageSnapshot = z.infer<typeof appUsageSnapshotSchema>;

export type AppUsageWindow = z.infer<typeof appUsageWindowSchema>;
export type AppUsageFilters = z.infer<typeof appUsageFiltersSchema>;
export type AppUsageComparison = z.infer<typeof appUsageComparisonSchema>;
export type AppUsageFacets = z.infer<typeof appUsageFacetsSchema>;
export type AppUsageSession = z.infer<typeof appUsageSessionSchema>;

export interface AppUsageRequest {
  range: AppUsageRange;
  timeZone?: string;
  /** Custom local-day window; when set, `range` is only echoed. Omit for the legacy preset behavior. */
  window?: AppUsageWindow;
  /** Also return the previous period of equal length. Ignored for the all-time range. */
  compare?: boolean;
  filters?: AppUsageFilters;
  include?: AppUsageInclude[];
}

export interface CodingPlanUsageSnapshot {
  range: CodingPlanUsageRange;
  rangeStartDate: string;
  rangeEndDate: string;
  generatedAt: number;
  sourceProvider: UsageEntitlementProviderInfo;
  quota: UsageQuotaSnapshot | null;
  activity: CodingPlanActivitySnapshot;
  detail: CodingPlanUsageDetailSnapshot;
  modelUsage: CodingPlanModelUsageSnapshot;
  toolUsage: CodingPlanToolUsageSnapshot;
  health: CodingPlanHealthSnapshot;
}

export interface CodingPlanActivitySnapshot {
  summary: CodingPlanActivitySummary;
  heatmap: AppUsageHeatmap;
}

export interface CodingPlanActivitySummary {
  totalTokens: number;
  peakDailyTokens: number;
  peakDailyTokensDate: string | null;
  totalUsageDurationMs: number;
  currentStreakDays: number;
  longestStreakDays: number;
  favoriteModelName: string | null;
}

export interface CodingPlanUsageDetailSnapshot {
  model: CodingPlanUsageDetailSummary;
  tool: CodingPlanUsageDetailSummary;
}

export interface CodingPlanUsageDetailSummary {
  cacheHitRate: number | null;
  cacheHitRateTrend: number | null;
  totalCredits: number;
  totalCreditsTrend: number | null;
  averageDailyCredits: number;
  averageDailyCreditsTrend: number | null;
}

export interface CodingPlanModelUsageSnapshot {
  xTime: string[];
  granularity: CodingPlanUsageGranularity;
  totalModelCallCount: number;
  totalTokensUsage: number;
  modelDataList: CodingPlanModelData[];
  modelSummaryList: CodingPlanModelSummary[];
}

export interface CodingPlanModelData {
  modelName: string;
  sortOrder: number;
  tokensUsage: number[];
  creditsUsage?: number[];
  cachedInputTokensUsage?: number[];
  uncachedInputTokensUsage?: number[];
  outputTokensUsage?: number[];
  cachedInputCreditsUsage?: number[];
  uncachedInputCreditsUsage?: number[];
  outputCreditsUsage?: number[];
  totalTokens: number;
  totalCredits?: number;
}

export interface CodingPlanModelSummary {
  modelName: string;
  totalTokens: number;
  totalCredits?: number;
  sortOrder: number;
}

export interface CodingPlanToolUsageSnapshot {
  xTime: string[];
  granularity: CodingPlanUsageGranularity;
  toolDataList: CodingPlanToolData[];
  toolSummaryList: CodingPlanToolSummary[];
}

export interface CodingPlanToolData {
  toolCode: string;
  toolName: string;
  sortOrder: number;
  usageCount: number[];
  creditsUsage?: number[];
  totalUsageCount: number;
  totalCredits?: number;
}

export interface CodingPlanToolSummary {
  toolCode: string;
  toolName: string;
  totalUsageCount: number;
  totalCredits?: number;
  sortOrder: number;
}

export interface CodingPlanHealthSnapshot {
  xTime: string[];
  proMaxDecodeSpeed: number[];
  liteDecodeSpeed: number[];
}

export interface UsageStatsToolUsage {
  /** Internal tool identifier, such as search-prime / web-reader / zread / search-mcp. */
  toolCode: string;
  /** Human-readable name for display. */
  displayName: string;
  totalCalls: number;
  /** Per-day call counts with the same length as daily, for plotting trends. */
  dailyCalls: number[];
}

export interface UsageStatsSummary {
  totalSessions: number;
  totalMessages: number;
  totalCharacters: number;
  totalEstimatedTokens: number;
  activeDays: number;
  mostActiveDay: UsageStatsDaySummary | null;
  favoriteModel: UsageStatsFavoriteModel | null;
  longestSessionMs: number;
  longestStreakDays: number;
  currentStreakDays: number;
  firstActivityDate: string | null;
  lastActivityDate: string | null;
  peakHour: UsageStatsPeakHour | null;
}

export interface UsageStatsPeakHour {
  hour: number;
  totalEstimatedTokens: number;
  messageCount: number;
}

export interface UsageStatsFavoriteModel {
  modelId: string | null;
  totalCharacters: number;
  totalEstimatedTokens: number;
  share: number;
}

export interface UsageStatsDaySummary {
  date: string;
  label: string;
  totalCharacters: number;
  totalEstimatedTokens: number;
  sessionCount: number;
  messageCount: number;
  activityScore: number;
}

export interface UsageStatsHeatmap {
  startDate: string | null;
  endDate: string | null;
  maxActivityScore: number;
  weeks: UsageStatsHeatmapWeek[];
  monthLabels: UsageStatsHeatmapMonthLabel[];
}

export interface UsageStatsHeatmapWeek {
  weekIndex: number;
  days: Array<UsageStatsHeatmapCell | null>;
}

export interface UsageStatsHeatmapMonthLabel {
  weekIndex: number;
  date: string;
}

export interface UsageStatsHeatmapCell {
  date: string;
  level: 0 | 1 | 2 | 3 | 4;
  totalCharacters: number;
  totalEstimatedTokens: number;
  sessionCount: number;
  messageCount: number;
  activityScore: number;
}

export interface UsageStatsModelUsage {
  modelId: string | null;
  totalCharacters: number;
  totalEstimatedTokens: number;
  inputCharacters: number;
  inputEstimatedTokens: number;
  outputCharacters: number;
  outputEstimatedTokens: number;
  sessionCount: number;
  messageCount: number;
  share: number;
}
