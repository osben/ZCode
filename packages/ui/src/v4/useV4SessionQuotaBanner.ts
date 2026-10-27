import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  isStartPlanModelProviderId,
  parseChatGptPlanAccountProviderId,
} from "@zcode/shared";
import type { IUsageStatsService } from "@zcode/services";
import type { SessionErrorInfo, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import {
  resolveGlmQuotaBannerBusinessCode,
  resolveStartPlanConcurrentLimitBannerReason,
  resolveStartPlanConcurrentLimitBusinessCode,
  resolveStartPlanQuotaExhaustedBusinessCode,
} from "@/lib/providerBusinessError.js";
import {
  isMaxCodingPlanSnapshot,
  isTerminalCodingPlanSnapshot,
} from "@/lib/sidebarCodingPlanUpgrade.js";
import {
  buildSessionQuotaBannerDismissKey,
  buildSessionQuotaBannerState,
  resolveQuotaBannerUpgradeProviderId,
  shouldOfferQuotaBannerUpgrade,
} from "@/v4/sessionQuotaBannerState.js";
import type { McpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";
import { logger } from "@/logger.js";
import { sessionQuotaBannerDismissalStore } from "@/v4/sessionQuotaBannerDismissalStore.js";
import { startPlanQuotaReminderStore } from "@/v4/startPlanQuotaReminderStore.js";

const CHATGPT_PLAN_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";

function isGlmQuotaBannerProviderId(providerId: string | null): boolean {
  return (
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

function isRunningPhase(phase: SessionPhase | null): boolean {
  return phase === "prewarming" || phase === "running";
}

/**
 * V4 quota business state: the conversation snapshot provides only the current provider/model/error, while quota still comes from
 * the entitlement service. Merge them in the renderer; do not write purchase or quota state back to the conversation.
 */
export function useV4SessionQuotaBanner(params: {
  sessionId: string | null;
  error: SessionErrorInfo | null;
  errorKey: string | null;
  phase: SessionPhase | null;
  providerId: string | null;
  modelId: string | null;
  usageStatsService?: IUsageStatsService;
  /**
   * Fact that the official Server MCP is unavailable. The caller parses this from conversation rows — it is a projection of session events
   * and unrelated to the entitlement service, so do not fetch it in this hook.
   */
  mcpUnavailableNotice?: McpUnavailableNotice | null;
}) {
  const activeProviderId = params.providerId?.trim() || null;
  const modelId = params.modelId?.trim() || null;
  const isStartPlanProvider = Boolean(
    activeProviderId && isStartPlanModelProviderId(activeProviderId),
  );
  // The attributed provider code is the structured business fact; `code` can be a wrapper or,
  // after cold hydration, the adapter error class name, which hid 3009 behind a generic banner.
  const businessCode = params.error?.attribution?.providerErrorCode?.trim() || params.error?.code;
  const quotaExhaustedCode = resolveStartPlanQuotaExhaustedBusinessCode(
    businessCode,
    params.error?.message,
  );
  const concurrentLimitCode = resolveStartPlanConcurrentLimitBusinessCode(
    businessCode,
    params.error?.message,
  );
  const providerLimitedCode = resolveGlmQuotaBannerBusinessCode(businessCode);
  const serverQuotaExhausted = quotaExhaustedCode === "1005" && isStartPlanProvider;
  const serverConcurrentLimited = Boolean(concurrentLimitCode) && isStartPlanProvider;
  const serverProviderLimited = Boolean(
    providerLimitedCode && isGlmQuotaBannerProviderId(activeProviderId),
  );
  // ChatGPT plan limit (specs/chatgpt-plan-signin.md "Limits and recovery in Desktop"): the error carries no reset
  // time and there is no official usage source, so the banner never shows one.
  const chatGptPlanAccountKey = activeProviderId
    ? parseChatGptPlanAccountProviderId(activeProviderId)
    : null;
  const serverChatGptPlanLimited =
    businessCode === CHATGPT_PLAN_USAGE_LIMIT_CODE && chatGptPlanAccountKey !== null;
  const takesOverError =
    serverQuotaExhausted ||
    serverConcurrentLimited ||
    serverProviderLimited ||
    serverChatGptPlanLimited;

  const settings = useProviderSettingsView();
  const entitlement = useUsageEntitlementWithService(params.usageStatsService, {
    ...buildStartPlanEntitlementOptions(
      settings.state.status === "ready" ? settings.state.view : null,
      isStartPlanProvider ? activeProviderId! : "",
    ),
  });
  const reminderVersion = useSyncExternalStore(
    startPlanQuotaReminderStore.subscribe,
    startPlanQuotaReminderStore.getSnapshot,
    startPlanQuotaReminderStore.getSnapshot,
  );
  // The display instance updates when the task/model changes; balance refresh must not create a new instance or it would immediately dismiss the current notice.
  const reminderOwner = useMemo(
    () => ({ sessionId: params.sessionId, activeProviderId, modelId }),
    [params.sessionId, activeProviderId, modelId],
  );
  const state = useMemo(
    () =>
      buildSessionQuotaBannerState({
        activeProviderId,
        snapshot: entitlement.snapshot,
        modelId,
        isReminderHidden: (key, referenceTime) =>
          startPlanQuotaReminderStore.isHidden(key, reminderOwner, referenceTime),
        serverQuotaExhausted,
        serverConcurrentLimited,
        ...(concurrentLimitCode ? { serverConcurrentLimitBusinessCode: concurrentLimitCode } : {}),
        ...(concurrentLimitCode
          ? {
              serverConcurrentLimitReason: resolveStartPlanConcurrentLimitBannerReason(
                params.error?.message,
              ),
            }
          : {}),
        ...(providerLimitedCode ? { serverProviderLimitedBusinessCode: providerLimitedCode } : {}),
        ...(serverProviderLimited
          ? { serverProviderLimitedMessage: params.error?.message ?? null }
          : {}),
        ...(params.mcpUnavailableNotice
          ? { mcpUnavailableNotice: params.mcpUnavailableNotice }
          : {}),
        ...(serverChatGptPlanLimited ? { serverChatGptPlanLimited } : {}),
      }),
    [
      activeProviderId,
      serverChatGptPlanLimited,
      reminderOwner,
      reminderVersion,
      concurrentLimitCode,
      entitlement.snapshot,
      modelId,
      params.error?.message,
      params.mcpUnavailableNotice,
      providerLimitedCode,
      serverConcurrentLimited,
      serverProviderLimited,
      serverQuotaExhausted,
    ],
  );

  const dismissKey = buildSessionQuotaBannerDismissKey(
    state,
    takesOverError ? params.errorKey : null,
  );
  const previousReminderKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previousKey = previousReminderKeyRef.current;
    previousReminderKeyRef.current = state.reminderKey;
    // End the display instance once a shown notice exits, preventing it from popping up again in the same period if balance rises and then falls.
    if (previousKey && previousKey !== state.reminderKey) {
      startPlanQuotaReminderStore.dismiss(previousKey);
    }
  }, [state.reminderKey]);
  useSyncExternalStore(
    sessionQuotaBannerDismissalStore.subscribe,
    sessionQuotaBannerDismissalStore.getSnapshot,
    sessionQuotaBannerDismissalStore.getSnapshot,
  );
  const dismissed = Boolean(
    params.sessionId &&
    dismissKey &&
    sessionQuotaBannerDismissalStore.isDismissed(params.sessionId, dismissKey),
  );
  const restoredDismissalRef = useRef<string | null>(null);
  useEffect(() => {
    if (!dismissed || !params.sessionId || !dismissKey) return;
    const fingerprint = `${params.sessionId}\u0000${dismissKey}`;
    if (restoredDismissalRef.current === fingerprint) return;
    restoredDismissalRef.current = fingerprint;
    logger.debug("session quota banner dismissal restored", {
      dismissKey,
      sessionId: params.sessionId,
    });
  }, [dismissKey, dismissed, params.sessionId]);

  const upgradeProviderId = resolveQuotaBannerUpgradeProviderId(activeProviderId);
  const shouldCheckTerminalPlan =
    state.visible &&
    upgradeProviderId !== null &&
    // Notices without an upgrade entry (such as exhausted MCP daily quota) do not need to check whether the user already has the top-tier plan,
    // avoiding one refreshOnMount entitlement request.
    shouldOfferQuotaBannerUpgrade(state.kind) &&
    !isStartPlanModelProviderId(upgradeProviderId);
  const upgradeEntitlement = useUsageEntitlementWithService(params.usageStatsService, {
    enabled: shouldCheckTerminalPlan,
    includeSubscription: true,
    preferredProviderId: upgradeProviderId ?? undefined,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    refreshOnMount: true,
  });
  const terminalSnapshot =
    entitlement.snapshot?.provider?.id === upgradeProviderId
      ? entitlement.snapshot
      : upgradeEntitlement.snapshot?.provider?.id === upgradeProviderId
        ? upgradeEntitlement.snapshot
        : null;
  const terminalPlan = terminalSnapshot !== null && isTerminalCodingPlanSnapshot(terminalSnapshot);
  const maxPlan = terminalSnapshot !== null && isMaxCodingPlanSnapshot(terminalSnapshot);

  const previousPhaseRef = useRef<SessionPhase | null>(params.phase);
  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = params.phase;
    if (!isStartPlanProvider || previousPhase === params.phase) return;
    if (isRunningPhase(previousPhase) !== isRunningPhase(params.phase)) {
      // Task start reserves quota, and termination charges or releases it; bypass ordinary freshness correction once.
      void entitlement.refresh({ force: true, silent: true, reason: "manual" });
    }
  }, [entitlement.refresh, isStartPlanProvider, params.phase]);

  const modelRefreshInitializedRef = useRef(false);
  const previousModelKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const nextKey = isStartPlanProvider && modelId ? `${activeProviderId}:${modelId}` : null;
    const previousKey = previousModelKeyRef.current;
    previousModelKeyRef.current = nextKey;
    if (!modelRefreshInitializedRef.current) {
      modelRefreshInitializedRef.current = true;
      return;
    }
    if (nextKey && nextKey !== previousKey) {
      void entitlement.refresh({ reason: "initial" });
    }
  }, [activeProviderId, entitlement.refresh, isStartPlanProvider, modelId]);

  const dismiss = useCallback(() => {
    if (state.reminderKey) {
      // Clicking dismiss itself proves that the user saw the notice; do not make dismissal ineffective while waiting for the visibility callback.
      if (state.reminderExpiresAt !== undefined && state.reminderReferenceTime !== undefined) {
        startPlanQuotaReminderStore.markShown(
          state.reminderKey,
          state.reminderExpiresAt,
          reminderOwner,
          state.reminderReferenceTime,
        );
      }
      startPlanQuotaReminderStore.dismiss(state.reminderKey);
      return;
    }
    if (!params.sessionId || !dismissKey) return;
    sessionQuotaBannerDismissalStore.dismiss(params.sessionId, dismissKey);
  }, [
    dismissKey,
    params.sessionId,
    reminderOwner,
    state.reminderKey,
    state.reminderExpiresAt,
    state.reminderReferenceTime,
  ]);

  const markShown = useCallback(() => {
    if (
      state.reminderKey &&
      state.reminderExpiresAt !== undefined &&
      state.reminderReferenceTime !== undefined
    ) {
      startPlanQuotaReminderStore.markShown(
        state.reminderKey,
        state.reminderExpiresAt,
        reminderOwner,
        state.reminderReferenceTime,
      );
    }
  }, [reminderOwner, state.reminderExpiresAt, state.reminderKey, state.reminderReferenceTime]);

  return {
    state,
    dismissKey,
    dismissed,
    dismiss,
    markShown,
    takesOverError,
    upgradeProviderId:
      terminalPlan || !shouldOfferQuotaBannerUpgrade(state.kind) ? null : upgradeProviderId,
    upgradeActionLabelId: maxPlan ? "chat.quota.action.renew" : "chat.quota.action.upgrade",
  } as const;
}
