export type CodingPlanResetType = "FIVE_HOUR" | "WEEK";

export interface CodingPlanResetScopeRequest {
  preferredProviderId: string;
  /** Registry static access category, or Team scope resolved at the call boundary. */
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}

export interface CodingPlanResetOpportunitySnapshot {
  expireAt: number;
}

export interface CodingPlanResetHistorySnapshot {
  usedAt: number;
}

export interface CodingPlanResetStatusSnapshot {
  availableFiveHourResets: CodingPlanResetOpportunitySnapshot[];
  availableWeekResets: CodingPlanResetOpportunitySnapshot[];
  latestFiveHourResetHistory: CodingPlanResetHistorySnapshot | null;
  latestWeekResetHistory: CodingPlanResetHistorySnapshot | null;
  hasUnreadHistory: boolean;
}

export interface CodingPlanResetOpportunityRequest extends CodingPlanResetScopeRequest {
  idempotencyKey: string;
}

export interface CodingPlanResetOpportunityResult {
  granted: boolean;
  nextTryAt: number | null;
}

export interface CodingPlanResetUseRequest extends CodingPlanResetScopeRequest {
  idempotencyKey: string;
  resetType: CodingPlanResetType;
}

export interface CodingPlanResetUseResult {
  used: true;
}
import type { ZCodeAccountAccess, ZCodeProviderAccountAccess } from "./zcode-protocol/index.js";
