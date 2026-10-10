import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ProviderSettingsView } from "@zcode/services";
import {
  getModelProviderFamilySpec,
  type ModelProviderFamilySpec,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyConnectionSelectionSettings,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  useUsageEntitlement,
  type UsageEntitlementRefreshOptions,
} from "@/hooks/useUsageEntitlement.js";
import type { CodingPlanEntitlementState } from "@/settings/model-provider-section/constants.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";

function resolveCodingPlanProviderFingerprintAutoRefresh({
  loading,
  providerFingerprint,
  skippedProviderFingerprint,
  suppressAutoRefresh,
}: {
  loading: boolean;
  providerFingerprint: string;
  skippedProviderFingerprint: string;
  suppressAutoRefresh: boolean;
}): {
  shouldRefresh: boolean;
  skippedProviderFingerprint: string;
} {
  if (loading || !providerFingerprint) {
    return { shouldRefresh: false, skippedProviderFingerprint };
  }
  if (suppressAutoRefresh) {
    return {
      shouldRefresh: false,
      skippedProviderFingerprint: providerFingerprint,
    };
  }
  if (skippedProviderFingerprint === providerFingerprint) {
    return {
      shouldRefresh: false,
      skippedProviderFingerprint: "",
    };
  }
  return { shouldRefresh: true, skippedProviderFingerprint: "" };
}

function useProviderFamilyEntitlements(params: {
  familySpec: ModelProviderFamilySpec;
  selection: ProviderFamilyConnectionSelection | undefined;
  providerSettingsView: ProviderSettingsView | null;
}) {
  const codingPlanProviderId =
    params.selection?.kind === "team-coding-plan"
      ? params.familySpec.teamCodingPlanProviderId
      : params.familySpec.individualCodingPlanProviderId;
  const startPlanProviderId = params.familySpec.startPlanProviderId;
  const accountAccess = resolveAccountProviderInspectionAccess(
    params.providerSettingsView,
    codingPlanProviderId,
  );
  const startOptions = buildStartPlanEntitlementOptions(
    params.providerSettingsView,
    startPlanProviderId,
  );
  const registryFingerprint = accountAccess
    ? JSON.stringify([params.providerSettingsView?.revision, accountAccess])
    : "";
  const startProviderFingerprint = startOptions.enabled ? (startOptions.cacheKey ?? "") : "";
  const entitlementAccess = resolveEntitlementAccountAccess(
    accountAccess?.access,
    params.selection,
  );
  // Team query identity also includes product/org/project. Using only Registry's static Access
  // would reuse the previous project's entitlement cache after switching teams, so cache identity must include runtime account context.
  const codingFingerprint = registryFingerprint
    ? JSON.stringify([registryFingerprint, entitlementAccess])
    : "";
  const codingEnabled = Boolean(codingFingerprint);
  const startEnabled = Boolean(startProviderFingerprint);
  const coding = useUsageEntitlement({
    enabled: codingEnabled,
    refreshOnMount: false,
    includeSubscription: true,
    preferredProviderId: codingPlanProviderId,
    accountAccess: entitlementAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: codingPlanProviderId,
      providerFingerprint: codingFingerprint,
    }),
  });
  const start = useUsageEntitlement(startOptions);

  return useMemo(
    () => ({
      coding,
      codingEnabled,
      codingFingerprint,
      codingPlanProviderId,
      start,
      startEnabled,
      startPlanProviderId,
      startProviderFingerprint,
    }),
    // After the Family orchestration refactor, this returned a new object on every render, making equivalent entitlement facts lose
    // referential stability and amplifying plan-state updates into an access-refresh loop on the Provider settings page.
    [
      coding.error,
      coding.loading,
      coding.refresh,
      coding.snapshot,
      codingEnabled,
      codingFingerprint,
      codingPlanProviderId,
      start.error,
      start.loading,
      start.refresh,
      start.snapshot,
      startEnabled,
      startPlanProviderId,
      startProviderFingerprint,
    ],
  );
}

function resolveEntitlementAccountAccess(
  access: ZCodeProviderAccountAccess | undefined,
  selection: ProviderFamilyConnectionSelection | undefined,
): ZCodeProviderAccountAccess | ZCodeAccountAccess | undefined {
  if (access?.mode !== "team-coding-plan" || selection?.kind !== "team-coding-plan") {
    // Display queries target this plan itself; do not let the runtime current resolver switch it to a different current plan.
    return access && (access.mode === "start-plan" || access.mode === "individual-coding-plan")
      ? { type: "zhipu-account", family: access.accountType, planKind: access.mode }
      : access;
  }
  return {
    type: "zhipu-account",
    family: access.accountType,
    planKind: "team-coding-plan",
    productId: selection.productId,
    organizationId: selection.organizationId,
    projectId: selection.projectId,
  };
}

export function useCodingPlanAccessRefresh({
  refresh,
  selectedPlanKey,
}: {
  refresh: (options?: UsageEntitlementRefreshOptions) => Promise<void>;
  selectedPlanKey: string | null;
}): void {
  useEffect(() => {
    if (!selectedPlanKey) {
      return;
    }
    // The old effect depended on the entire selectedNavItem, so changes in quota/loading projection were
    // mistaken for the user reopening the plan. Respond only to stable plan-selection identity here.
    void refresh({ silent: true, reason: "access" });
  }, [refresh, selectedPlanKey]);
}

export function useCodingPlanEntitlements({
  providerSettingsView,
  connectionSelections = {},
  suppressProviderFingerprintAutoRefresh = false,
}: {
  providerSettingsView: ProviderSettingsView | null;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  suppressProviderFingerprintAutoRefresh?: boolean;
}): {
  entitlements: Partial<Record<string, CodingPlanEntitlementState>>;
  /** Start Plan Provider that currently has Account Access and can query entitlements independently. */
  enabledStartPlanProviderIds: string[];
  refresh: (options?: UsageEntitlementRefreshOptions) => Promise<void>;
} {
  const skippedProviderFingerprintAutoRefreshRef = useRef("");
  const loading = providerSettingsView === null;
  // React Hooks must keep a fixed call order, so call both Families explicitly instead of iterating dynamically over Spec.
  const zaiFamily = useProviderFamilyEntitlements({
    familySpec: getModelProviderFamilySpec("zai"),
    selection: connectionSelections.zai,
    providerSettingsView,
  });
  const bigmodelFamily = useProviderFamilyEntitlements({
    familySpec: getModelProviderFamilySpec("bigmodel"),
    selection: connectionSelections.bigmodel,
    providerSettingsView,
  });

  const refresh = useCallback(
    (options: UsageEntitlementRefreshOptions = {}) => {
      // Start/Coding use independent provider IDs and cache keys; refresh in parallel when both are available.
      const refreshJobs: Array<Promise<void>> = [];
      if (zaiFamily.codingEnabled) {
        refreshJobs.push(zaiFamily.coding.refresh(options));
      }
      if (zaiFamily.startEnabled) {
        refreshJobs.push(zaiFamily.start.refresh(options));
      }
      if (bigmodelFamily.codingEnabled) {
        refreshJobs.push(bigmodelFamily.coding.refresh(options));
      }
      if (bigmodelFamily.startEnabled) {
        refreshJobs.push(bigmodelFamily.start.refresh(options));
      }
      return Promise.all(refreshJobs).then(() => undefined);
    },
    [
      bigmodelFamily.coding.refresh,
      bigmodelFamily.codingEnabled,
      bigmodelFamily.start.refresh,
      bigmodelFamily.startEnabled,
      zaiFamily.coding.refresh,
      zaiFamily.codingEnabled,
      zaiFamily.start.refresh,
      zaiFamily.startEnabled,
    ],
  );

  const providerFingerprint = useMemo(
    () =>
      [
        zaiFamily.codingFingerprint,
        zaiFamily.startEnabled ? zaiFamily.startProviderFingerprint : "",
        bigmodelFamily.codingFingerprint,
        bigmodelFamily.startEnabled ? bigmodelFamily.startProviderFingerprint : "",
      ]
        .filter(Boolean)
        .join("|"),
    [
      bigmodelFamily.codingFingerprint,
      bigmodelFamily.startEnabled,
      bigmodelFamily.startProviderFingerprint,
      zaiFamily.codingFingerprint,
      zaiFamily.startEnabled,
      zaiFamily.startProviderFingerprint,
    ],
  );

  useEffect(() => {
    const decision = resolveCodingPlanProviderFingerprintAutoRefresh({
      loading,
      providerFingerprint,
      skippedProviderFingerprint: skippedProviderFingerprintAutoRefreshRef.current,
      suppressAutoRefresh: suppressProviderFingerprintAutoRefresh,
    });
    skippedProviderFingerprintAutoRefreshRef.current = decision.skippedProviderFingerprint;
    if (!decision.shouldRefresh) {
      return;
    }

    // The first entitlement snapshot may be stale after provider configuration loads/saves asynchronously.
    // Connection-mode synchronization separately refreshes Account Access; do not cascade the same change into plan/balance refreshes.
    refresh({ force: true, silent: true, reason: "auth" });
  }, [providerFingerprint, loading, refresh, suppressProviderFingerprintAutoRefresh]);

  return useMemo(
    () => ({
      entitlements: {
        [zaiFamily.codingPlanProviderId]: {
          snapshot: zaiFamily.coding.snapshot,
          loading: zaiFamily.coding.loading,
          error: zaiFamily.coding.error,
        },
        [zaiFamily.startPlanProviderId]: {
          snapshot: zaiFamily.startEnabled ? zaiFamily.start.snapshot : null,
          loading: zaiFamily.startEnabled ? zaiFamily.start.loading : false,
          error: zaiFamily.startEnabled ? zaiFamily.start.error : null,
        },
        [bigmodelFamily.codingPlanProviderId]: {
          snapshot: bigmodelFamily.coding.snapshot,
          loading: bigmodelFamily.coding.loading,
          error: bigmodelFamily.coding.error,
        },
        [bigmodelFamily.startPlanProviderId]: {
          snapshot: bigmodelFamily.startEnabled ? bigmodelFamily.start.snapshot : null,
          loading: bigmodelFamily.startEnabled ? bigmodelFamily.start.loading : false,
          error: bigmodelFamily.startEnabled ? bigmodelFamily.start.error : null,
        },
      },
      enabledStartPlanProviderIds: [
        ...(zaiFamily.startEnabled ? [zaiFamily.startPlanProviderId] : []),
        ...(bigmodelFamily.startEnabled ? [bigmodelFamily.startPlanProviderId] : []),
      ],
      refresh,
    }),
    [bigmodelFamily, refresh, zaiFamily],
  );
}
