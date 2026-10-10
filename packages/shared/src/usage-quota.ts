/**
 * Pure type definitions related to Coding Plan quotas.
 *
 * Split from usage-stats.ts: MCP quota integration pushed that file past the oxlint max-lines (400) limit,
 * and quotas form a self-contained group of types that do not depend on aggregated statistics. Splitting them keeps both files under the limit.
 * This file has no dependencies of its own; usage-stats.ts imports and re-exports it one-way, so there is no circular dependency.
 */

export interface UsageQuotaSnapshot {
  level: string | null;
  limits: UsageQuotaLimit[];
}

export interface UsageQuotaLimit {
  type: string;
  /** Start Plan server quota bucket and period identity; period timestamps are milliseconds and used to deduplicate reminders. */
  bucketId?: string;
  userPlanId?: string;
  periodStart?: number;
  periodEnd?: number;
  /** Period type of the associated entitlement, such as daily / one_time. */
  period?: string;
  meter?: string;
  unitType?: string;
  /** Plan identity for this Start Plan bucket, used only to group by plan in Settings. */
  planId?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
  usageDetails: UsageQuotaUsageDetail[];
}

export interface UsageQuotaUsageDetail {
  modelCode: string;
  displayName?: string;
  usage: number;
}

/**
 * Synthetic value for `aggregate.type`.
 *
 * Do not reuse TOKENS_LIMIT / TIME_LIMIT: `isSameLimitCategory` treats TIME_LIMIT as the same category as tool quotas,
 * which would make the existing findCodingPlanQuotaLimit query incorrectly match the MCP aggregate quota.
 */
export const MCP_USAGE_QUOTA_LIMIT_TYPE = "MCP_USAGE_LIMIT" as const;

/** Coding Plan connection that owns the MCP quota, so the UI can decide whether to show it under the current provider tab. */
export type UsageMcpQuotaScope =
  | {
      providerFamily: "zai" | "bigmodel";
      targetType: "PERSONAL";
    }
  | {
      providerFamily: "zai" | "bigmodel";
      targetType: "TEAM";
      organizationId: string;
      projectId: string;
    };

export interface UsageMcpQuotaSnapshot {
  /** Server server_time in milliseconds (the API returns Unix seconds). */
  serverTime: number;
  level: string | null;
  scope: UsageMcpQuotaScope;
  /**
   * Equivalent representation of server `total_usage` (total used / total quota / total remaining), reusing the existing quota bar/card
   * display logic. Note that percentage follows the quota API convention: **percentage used**; the display side converts it to remaining quota.
   */
  aggregate: UsageQuotaLimit;
}
