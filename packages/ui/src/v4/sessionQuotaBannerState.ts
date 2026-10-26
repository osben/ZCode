import {
  BUILTIN_MODEL_PROVIDER_IDS,
  isStartPlanModelProviderId,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type {
  GlmQuotaBannerBusinessCode,
  StartPlanConcurrentLimitBannerReason,
} from "@/lib/providerBusinessError.js";
import type { McpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";
import { parseCodingPlanLimitResetAt } from "@/lib/codingPlanLimitAutoContinue.js";

import {
  allBucketsExhausted,
  bucketMatchesModel,
  bucketRemainingRatio,
  bucketReminderKey,
  getActiveModelBuckets,
} from "@/v4/startPlanQuotaBuckets.js";

export type SessionQuotaBannerKind =
  | "model-very-low"
  | "model-exhausted"
  | "daily-exhausted"
  | "concurrent-limit"
  | "provider-limited"
  | "chatgpt-plan-limited"
  | "mcp-quota-exhausted"
  | "mcp-plan-required";

export interface SessionQuotaBannerState {
  visible: boolean;
  kind: SessionQuotaBannerKind | null;
  concurrentLimitBusinessCode: "3008" | "3009" | "3010" | null;
  concurrentLimitReason: StartPlanConcurrentLimitBannerReason | null;
  providerLimitedBusinessCode: GlmQuotaBannerBusinessCode | null;
  providerLimitedMessage: string | null;
  providerLimitedResetAt: number | null;
  modelName: string | null;
  /** For official Server MCP notices only: name of the MCP server with the issue, used in the message. */
  mcpServerName: string | null;
  /** For official Server MCP notices only: tool row that produced this fact, included in the deduplication key. */
  mcpNoticeRowId: number | null;
  /** Only low-quota notices carry the stable quota-period key; this does not affect dismissal of other business errors. */
  reminderKey?: string;
  reminderExpiresAt?: number;
  /** Snapshot time consistent with quota-period validity; do not convert it to the device clock. */
  reminderReferenceTime?: number;
  quotaPeriod?: string;
  remainingTokens: number | null;
  remainingPercent: number | null;
  dismissible: boolean;
  blocksSubmit: boolean;
  priority: number;
}

export const HIDDEN_SESSION_QUOTA_BANNER_STATE: SessionQuotaBannerState = {
  visible: false,
  kind: null,
  concurrentLimitBusinessCode: null,
  concurrentLimitReason: null,
  providerLimitedBusinessCode: null,
  providerLimitedMessage: null,
  providerLimitedResetAt: null,
  modelName: null,
  mcpServerName: null,
  mcpNoticeRowId: null,
  remainingTokens: null,
  remainingPercent: null,
  dismissible: false,
  blocksSubmit: false,
  priority: 0,
};

function isGlmQuotaBannerProviderId(providerId: string): boolean {
  return (
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

export function normalizeProviderLimitedBannerMessage(
  message: string | null | undefined,
): string | null {
  const normalizedMessage = message?.trim();
  if (!normalizedMessage) return null;
  const bracketParts = [...normalizedMessage.matchAll(/\[([^\]]*)\]/gu)].map(
    (match) => match[1]?.trim() ?? "",
  );
  return bracketParts.length >= 3 && bracketParts[1] ? bracketParts[1] : normalizedMessage;
}

/**
 * Preserve the existing priority of quota business errors; for Start Plan, show low-quota notices per bucket and determine exhaustion across all valid buckets.
 */
export function buildSessionQuotaBannerState(params: {
  activeProviderId: string | null;
  snapshot: UsageEntitlementSnapshot | null;
  modelId: string | null;
  serverQuotaExhausted?: boolean;
  isReminderHidden?: (key: string, referenceTime: number) => boolean;
  serverConcurrentLimited?: boolean;
  serverConcurrentLimitBusinessCode?: "3008" | "3009" | "3010";
  serverConcurrentLimitReason?: StartPlanConcurrentLimitBannerReason;
  serverProviderLimitedBusinessCode?: GlmQuotaBannerBusinessCode;
  serverProviderLimitedMessage?: string | null;
  /** The ChatGPT plan usage limit was reached (specs/chatgpt-plan-signin.md "Limits and recovery in Desktop"). */
  serverChatGptPlanLimited?: boolean;
  /** When every exhausted ChatGPT plan window resets, from the renderer usage store; null when unknown. */
  chatGptPlanResetAt?: number | null;
  /** Fact that an official Server MCP was determined unavailable during this session (from the tool row's structured marker). */
  mcpUnavailableNotice?: McpUnavailableNotice | null;
}): SessionQuotaBannerState {
  if (
    params.serverConcurrentLimited === true &&
    params.activeProviderId &&
    isStartPlanModelProviderId(params.activeProviderId)
  ) {
    return {
      visible: true,
      kind: "concurrent-limit",
      concurrentLimitBusinessCode: params.serverConcurrentLimitBusinessCode ?? null,
      concurrentLimitReason: params.serverConcurrentLimitReason ?? "initial-busy",
      providerLimitedBusinessCode: null,
      providerLimitedMessage: null,
      providerLimitedResetAt: null,
      modelName: params.modelId,
      mcpServerName: null,
      mcpNoticeRowId: null,
      remainingTokens: null,
      remainingPercent: null,
      dismissible: true,
      blocksSubmit: false,
      priority: 60,
    };
  }

  if (
    params.serverQuotaExhausted === true &&
    params.activeProviderId &&
    isStartPlanModelProviderId(params.activeProviderId)
  ) {
    return {
      visible: true,
      kind: "daily-exhausted",
      concurrentLimitBusinessCode: null,
      concurrentLimitReason: null,
      providerLimitedBusinessCode: null,
      providerLimitedMessage: null,
      providerLimitedResetAt: null,
      modelName: null,
      mcpServerName: null,
      mcpNoticeRowId: null,
      remainingTokens: null,
      remainingPercent: 0,
      dismissible: false,
      blocksSubmit: false,
      priority: 50,
    };
  }

  if (params.serverChatGptPlanLimited === true) {
    return {
      visible: true,
      kind: "chatgpt-plan-limited",
      concurrentLimitBusinessCode: null,
      concurrentLimitReason: null,
      providerLimitedBusinessCode: null,
      providerLimitedMessage: null,
      providerLimitedResetAt: params.chatGptPlanResetAt ?? null,
      modelName: params.modelId,
      mcpServerName: null,
      mcpNoticeRowId: null,
      remainingTokens: null,
      remainingPercent: null,
      dismissible: true,
      blocksSubmit: false,
      priority: 45,
    };
  }

  if (
    params.serverProviderLimitedBusinessCode &&
    params.activeProviderId &&
    isGlmQuotaBannerProviderId(params.activeProviderId)
  ) {
    return {
      visible: true,
      kind: "provider-limited",
      concurrentLimitBusinessCode: null,
      concurrentLimitReason: null,
      providerLimitedBusinessCode: params.serverProviderLimitedBusinessCode,
      providerLimitedMessage: normalizeProviderLimitedBannerMessage(
        params.serverProviderLimitedMessage,
      ),
      providerLimitedResetAt: parseCodingPlanLimitResetAt(
        params.activeProviderId,
        params.serverProviderLimitedBusinessCode,
        params.serverProviderLimitedMessage,
      ),
      modelName: params.modelId,
      mcpServerName: null,
      mcpNoticeRowId: null,
      remainingTokens: null,
      remainingPercent: null,
      dismissible: true,
      blocksSubmit: false,
      priority: 45,
    };
  }

  // Official Server MCP unavailable (quota exhausted / no Coding Plan).
  //
  // Placement: it must come after the server-side business errors above (model-side issues are more urgent and must not be blocked by an MCP notice),
  // and before the Start-Plan-only early return below — Coding Plan sessions always hit that return,
  // so this branch would never run if placed after it.
  if (params.mcpUnavailableNotice) {
    const mcpQuotaExhausted = params.mcpUnavailableNotice.code === "quota_exceeded";
    return {
      visible: true,
      kind: mcpQuotaExhausted ? "mcp-quota-exhausted" : "mcp-plan-required",
      concurrentLimitBusinessCode: null,
      concurrentLimitReason: null,
      providerLimitedBusinessCode: null,
      providerLimitedMessage: null,
      providerLimitedResetAt: null,
      modelName: null,
      mcpServerName: params.mcpUnavailableNotice.serverName,
      mcpNoticeRowId: params.mcpUnavailableNotice.rowId,
      remainingTokens: null,
      remainingPercent: null,
      dismissible: true,
      // MCP unavailability does not affect model conversations; never block input.
      blocksSubmit: false,
      priority: mcpQuotaExhausted ? 6 : 8,
    };
  }

  if (
    !params.activeProviderId ||
    !isStartPlanModelProviderId(params.activeProviderId) ||
    params.snapshot?.provider?.id !== params.activeProviderId
  ) {
    return HIDDEN_SESSION_QUOTA_BANNER_STATE;
  }

  const referenceTime = params.snapshot.serverTime ?? params.snapshot.generatedAt;
  const buckets = getActiveModelBuckets(params.snapshot);
  if (allBucketsExhausted(buckets)) {
    return {
      ...HIDDEN_SESSION_QUOTA_BANNER_STATE,
      visible: true,
      kind: "daily-exhausted",
      remainingTokens: 0,
      remainingPercent: 0,
      priority: 50,
    };
  }
  const modelId = params.modelId?.trim() ?? "";
  const modelBuckets = modelId
    ? buckets.filter((bucket) => bucketMatchesModel(bucket, modelId))
    : [];
  const modelName =
    modelBuckets.flatMap((bucket) => bucket.usageDetails).find((detail) => detail.displayName)
      ?.displayName ?? modelId;
  if (allBucketsExhausted(modelBuckets)) {
    return {
      ...HIDDEN_SESSION_QUOTA_BANNER_STATE,
      visible: true,
      kind: "model-exhausted",
      modelName,
      remainingTokens: 0,
      remainingPercent: 0,
      priority: 40,
    };
  }
  for (const bucket of modelBuckets) {
    const ratio = bucketRemainingRatio(bucket);
    const key = bucketReminderKey(bucket);
    if (
      ratio === null ||
      ratio <= 0 ||
      ratio > 0.1 ||
      !key ||
      params.isReminderHidden?.(key, referenceTime)
    )
      continue;
    return {
      ...HIDDEN_SESSION_QUOTA_BANNER_STATE,
      visible: true,
      kind: "model-very-low",
      modelName,
      remainingTokens: bucket.remaining ?? null,
      remainingPercent: ratio * 100,
      reminderKey: key,
      reminderReferenceTime: referenceTime,
      reminderExpiresAt: Math.min(bucket.periodEnd!, bucket.nextResetTime ?? Infinity),
      quotaPeriod: bucket.period,
      dismissible: true,
      priority: 30,
    };
  }
  return HIDDEN_SESSION_QUOTA_BANNER_STATE;
}

export function buildSessionQuotaBannerDismissKey(
  state: SessionQuotaBannerState,
  serverErrorKey?: string | null,
): string | null {
  if (!state.visible || !state.kind) return null;
  if (state.reminderKey) return state.reminderKey;
  return [
    state.kind,
    state.concurrentLimitBusinessCode ?? "",
    state.concurrentLimitReason ?? "",
    state.providerLimitedBusinessCode ?? "",
    state.providerLimitedMessage ?? "",
    state.modelName ?? "",
    // Deduplicate MCP notices by server + specific call: after dismissing once, do not show it again for the same call;
    // show it again if a later call fails (new rowId).
    state.mcpServerName ?? "",
    state.mcpNoticeRowId ?? "",
    state.remainingTokens ?? "",
    state.remainingPercent ?? "",
    state.blocksSubmit ? "blocked" : "unblocked",
    serverErrorKey ?? "",
  ].join(":");
}

export function resolveQuotaBannerUpgradeProviderId(providerId: string | null): string | null {
  return providerId;
}

/**
 * Whether this notice should include an upgrade entry point.
 *
 * Do not include one for `mcp-quota-exhausted`: once today's quota is exhausted, users must wait for the daily reset, and an upgrade button would suggest
 * that paying lets them continue immediately, which is misleading. Missing entitlement (`mcp-plan-required`) is what an upgrade can resolve.
 */
export function shouldOfferQuotaBannerUpgrade(kind: SessionQuotaBannerKind | null): boolean {
  // The ChatGPT plan is managed on chatgpt.com; the banner offers "Manage usage" instead of a ZCode upgrade.
  return kind !== "mcp-quota-exhausted" && kind !== "chatgpt-plan-limited";
}
