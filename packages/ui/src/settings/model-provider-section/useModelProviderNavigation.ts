/* eslint-disable max-lines -- Model Provider navigation centrally computes groups, selected items, and Coding Plan entitlement state; consolidate it when splitting later. */
import { useEffect, useMemo } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import type {
  ProviderFamilyConnectionSelection,
  ProviderFamilyConnectionSelectionSettings,
  ProviderFamilyDomain,
} from "@zcode/shared";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  isStartPlanModelProviderId,
  resolveModelProviderFamilySpecByProviderId,
  resolveProviderFamilyDomainFromOAuthProvider,
  type OAuthProviderId,
} from "@zcode/shared";
import {
  OLLAMA_NAV_KEY,
  OLLAMA_PROVIDER_ID,
  OLLAMA_PROVIDER_NAME,
} from "@/settings/model-provider-section/ollamaSync.js";
import {
  CHATGPT_PLAN_PROVIDER_LOGO,
  isChatGptPlanSubscriptionProviderId,
} from "@/lib/chatgptPlanProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  CODING_PLAN_PROVIDER_SPECS,
  isSelectableNavItem,
  type CodingPlanEntitlementState,
  type ModelProviderNavGroup,
  type ModelProviderSelectableNavItem,
  type PresetProviderSpec,
} from "@/settings/model-provider-section/constants.js";
import {
  ACP_DETECT_NODE_KEY,
  ACP_LOADING_NODE_KEY,
  isAcpManagedProvider,
  isAcpNodeKey,
} from "@/settings/model-provider-section/acpAgentConfig.js";
import { pickCodingPlanEntitlementProvider } from "@/lib/codingPlanProvider.js";
import {
  createCodingPlanProviderNodeKey,
  createCustomProviderNodeKey,
  createPresetProviderNodeKey,
} from "@/settings/model-provider-section/utils.js";
import {
  sortModelProvidersForDisplay,
  type ProviderOrderView,
} from "@/lib/modelProviderOrdering.js";
import type { EnterpriseCodingPlanProductDisplay } from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import {
  buildVisibleFamilyConnectionItems,
  resolveCodingPlanEntitlementState,
} from "@/settings/model-provider-section/providerFamilyConnectionVisibility.js";

interface PresetProviderWithConfig extends PresetProviderSpec {
  provider: ProviderSettingsFormProvider | null;
}

interface UseModelProviderNavigationOptions {
  presetProviders: PresetProviderWithConfig[];
  modelProviders: ProviderSettingsFormProvider[];
  /** Providers for which the current account has explicit entitlement. Omission means no account entitlements yet; production Settings always passes this explicitly. */
  entitledAccountProviderIds?: ReadonlySet<string>;
  modelProvidersLoading?: boolean;
  displayOrder?: ProviderOrderView;
  codingPlanEntitlements?: Partial<Record<string, CodingPlanEntitlementState>>;
  providerFamilyDomain?: ProviderFamilyDomain | null;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  pendingConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
  familyConnectionSettingsLoading?: boolean;
  familyConnectionSettingsFailed?: boolean;
  subscribedTeamProducts?: EnterpriseCodingPlanProductDisplay[];
  showPurchasedTeamPlanFallback?: boolean;
  selectedNodeKey: string | null;
  setSelectedNodeKey: (key: string | null) => void;
  /** The "ACP agents" group, already built by the page; omitted (undefined/null) when the host reports ACP unsupported. */
  acpGroup?: ModelProviderNavGroup | null;
  /** The first ACP detection is still in flight; an `acp-*` selection must not be corrected away yet. */
  acpDetectionPending?: boolean;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}

export function useModelProviderNavigation({
  presetProviders,
  modelProviders,
  entitledAccountProviderIds = new Set(),
  modelProvidersLoading = false,
  displayOrder,
  codingPlanEntitlements = {},
  providerFamilyDomain = null,
  connectionSelections = {},
  pendingConnectionSelections = {},
  familyConnectionSettingsLoading = false,
  familyConnectionSettingsFailed = false,
  subscribedTeamProducts = [],
  showPurchasedTeamPlanFallback = false,
  selectedNodeKey,
  setSelectedNodeKey,
  acpGroup = null,
  acpDetectionPending = false,
  intl,
}: UseModelProviderNavigationOptions) {
  const customProviders = useMemo(() => {
    const allCustomProviders = modelProviders.filter(
      // ACP agents are listed only in the "ACP agents" group, never again as custom providers.
      (provider) =>
        provider.config.group === "standard-personal" && !isAcpManagedProvider(provider),
    );
    // Reuse the model-menu display order so providers appear in the same order in Settings and the chat box.
    return sortModelProvidersForDisplay(allCustomProviders, displayOrder);
  }, [displayOrder, modelProviders]);

  const codingPlanItems = useMemo(
    () =>
      CODING_PLAN_PROVIDER_SPECS.filter((spec) =>
        shouldShowCodingPlanForProviderFamilyDomain(spec.oauthProviderId, providerFamilyDomain),
      ).map((spec) => {
        const provider = modelProviders.find((item) => item.providerId === spec.id) ?? null;
        const accountEntitled = entitledAccountProviderIds.has(spec.id);
        const entitlementProvider = pickCodingPlanEntitlementProvider(provider);
        const entitlement = codingPlanEntitlements[spec.id];
        const state = resolveCodingPlanEntitlementState({
          providerId: spec.id,
          accountEntitled,
          accountAvailability: provider?.accountState?.availability,
          accountUnavailableReason: provider?.accountState?.unavailableReason,
          entitlement,
          modelProvidersLoading,
        });

        return {
          key: createCodingPlanProviderNodeKey(spec.id),
          type: "codingPlan" as const,
          presetId: spec.id,
          oauthProviderId: spec.oauthProviderId,
          label: isStartPlanModelProviderId(spec.id)
            ? "Start Plan"
            : `${spec.providerName} - ${intl.formatMessage({
                id: "settings.modelProvider.connectionMode.codingPlan",
              })}`,
          providerName: spec.providerName,
          provider: entitlementProvider,
          accountEntitled,
          status: state.status,
          statusLabelId: state.statusLabelId,
          ...(isStartPlanModelProviderId(spec.id) &&
          entitlement?.snapshot?.unavailableReason === "not_authenticated"
            ? {
                accountLoginRequired: true,
                statusLabelId: "settings.modelProvider.startPlan.status.loginExpired",
              }
            : {}),
          planLevel: state.planLevel,
          currentProductId: state.currentProductId,
          subscriptionBillingCycle: state.subscriptionBillingCycle,
          subscriptionRenewTime: state.subscriptionRenewTime,
          subscriptionExpireTime: state.subscriptionExpireTime,
          subscriptionDetails: state.subscriptionDetails,
          quotaLimits: state.quotaLimits,
          mcpQuotaLimit: state.mcpQuotaLimit ?? null,
          purchaseUrl: spec.purchaseUrl,
          statusActive: entitlementProvider?.executable === true,
        };
      }),
    [
      entitledAccountProviderIds,
      codingPlanEntitlements,
      intl,
      modelProviders,
      modelProvidersLoading,
      providerFamilyDomain,
    ],
  );
  const connectionModeCodingPlanItems = useMemo(
    () =>
      buildVisibleFamilyConnectionItems({
        items: codingPlanItems.filter((item) => !isStartPlanModelProviderId(item.presetId)),
        codingPlanEntitlements,
        subscribedTeamProducts,
        showPurchasedTeamPlanFallback,
        connectionSelections: {
          ...connectionSelections,
          ...pendingConnectionSelections,
        },
        teamPlanSelections: Object.fromEntries(
          Object.entries({ ...connectionSelections, ...pendingConnectionSelections }).filter(
            ([, selection]) => selection?.kind === "team-coding-plan",
          ),
        ),
      }),
    [
      codingPlanEntitlements,
      showPurchasedTeamPlanFallback,
      codingPlanItems,
      connectionSelections,
      pendingConnectionSelections,
      subscribedTeamProducts,
    ],
  );

  const navigationGroups = useMemo<ModelProviderNavGroup[]>(() => {
    const groups: ModelProviderNavGroup[] = [
      {
        id: "preset",
        title: intl.formatMessage({ id: "settings.modelProvider.presetTitle" }),
        items: [
          ...presetProviders.map(({ id, displayName, provider }) => {
            const statusProvider = resolvePresetFamilyStatusProvider({
              presetId: id,
              provider,
              connectionModeItems: connectionModeCodingPlanItems,
              connectionSelections,
              modelProviders,
            });
            return {
              key: createPresetProviderNodeKey(id),
              type: "preset" as const,
              presetId: id,
              label: displayName,
              logo: modelProviders.find(
                (candidate) =>
                  candidate.providerId ===
                  resolveModelProviderFamilySpecByProviderId(id)?.individualCodingPlanProviderId,
              )?.config.logo,
              provider,
              displayName,
              statusProvider,
              statusActive: statusProvider?.executable === true,
            };
          }),
          ...codingPlanItems.filter((item) => isStartPlanModelProviderId(item.presetId)),
        ],
      },
      {
        // ChatGPT plan is an independent identity domain: always listed, never filtered
        // by the zai/bigmodel active-provider family scope, and rendered after those blocks.
        // Exactly ONE settings entry regardless of the runtime account set (zero accounts
        // must still route to the sign-in page; N accounts must not create duplicate keys).
        // Prefer an executable account so the shared status agrees with a usable provider;
        // fall back to the first entry when every account is identity-only.
        id: "chatgpt",
        title: intl.formatMessage({ id: "settings.modelProvider.chatgpt.navigationTitle" }),
        items: [
          (() => {
            const accountProviders = modelProviders.filter((candidate) =>
              isChatGptPlanSubscriptionProviderId(candidate.providerId),
            );
            const provider =
              accountProviders.find((candidate) => candidate.executable) ??
              accountProviders[0] ??
              null;
            return {
              key: createPresetProviderNodeKey(BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan),
              type: "preset" as const,
              presetId: BUILTIN_MODEL_PROVIDER_IDS.chatgptPlan,
              label: intl.formatMessage({ id: "settings.modelProvider.chatgpt.navigationPlan" }),
              logo: provider?.config.logo ?? CHATGPT_PLAN_PROVIDER_LOGO,
              provider: provider ?? null,
              displayName: intl.formatMessage({
                id: "settings.modelProvider.chatgpt.navigationPlan",
              }),
              statusProvider: provider ?? null,
              statusActive: provider?.executable === true,
            };
          })(),
        ],
      },
      {
        id: "custom",
        title: intl.formatMessage({ id: "settings.modelProvider.customTitle" }),
        items: customProviders.map((provider) => ({
          key: createCustomProviderNodeKey(provider.providerId),
          type: "custom" as const,
          label: getProviderFormLabel(provider),
          provider,
          statusActive: provider.executable === true,
        })),
      },
      {
        // Always listed: the entry is the detector; the synced provider also stays under Custom providers.
        id: "local",
        title: intl.formatMessage({ id: "settings.modelProvider.ollama.groupTitle" }),
        items: [
          (() => {
            const provider =
              modelProviders.find((candidate) => candidate.providerId === OLLAMA_PROVIDER_ID) ??
              null;
            return {
              key: OLLAMA_NAV_KEY,
              type: "ollama" as const,
              label: OLLAMA_PROVIDER_NAME,
              provider,
              statusActive: provider?.enabled === true && provider.models.length > 0,
            };
          })(),
        ],
      },
      ...(acpGroup ? [acpGroup] : []),
    ];

    return groups;
  }, [
    acpGroup,
    customProviders,
    codingPlanItems,
    connectionModeCodingPlanItems,
    // Format left navigation group headings inside this memo.
    // Provider/entitlement references may stay the same after a language switch, so intl must be a dependency to refresh copy from the old locale.
    intl,
    connectionSelections,
    pendingConnectionSelections,
    presetProviders,
    modelProviders,
  ]);

  const navigationItems = useMemo(() => {
    const visibleItems = navigationGroups.flatMap((group) => group.items);
    const visibleKeys = new Set(visibleItems.map((item) => item.key));
    return [
      ...visibleItems,
      ...connectionModeCodingPlanItems.filter((item) => !visibleKeys.has(item.key)),
    ];
  }, [connectionModeCodingPlanItems, navigationGroups]);

  const selectableNavigationItems = useMemo(
    () => navigationItems.filter(isSelectableNavItem),
    [navigationItems],
  );
  const selectableSideNavigationItems = useMemo(
    () => navigationGroups.flatMap((group) => group.items).filter(isSelectableNavItem),
    [navigationGroups],
  );

  const navigationItemByKey = useMemo(
    () => new Map(selectableNavigationItems.map((item) => [item.key, item])),
    [selectableNavigationItems],
  );
  const sideNavigationItemByKey = useMemo(
    () => new Map(selectableSideNavigationItems.map((item) => [item.key, item])),
    [selectableSideNavigationItems],
  );

  const selectedNavItem = selectedNodeKey
    ? resolveSelectedProviderFamilyConnectionItem({
        selectedNodeKey,
        navigationItemByKey,
        selectableNavigationItems,
        connectionSelections,
        pendingConnectionSelections,
        familyConnectionSettingsLoading,
        familyConnectionSettingsFailed,
        modelProvidersLoading,
      })
    : null;

  const requestedItem = selectedNodeKey ? navigationItemByKey.get(selectedNodeKey) : undefined;
  const requestedFamily =
    requestedItem?.type === "preset"
      ? resolveModelProviderFamilySpecByProviderId(requestedItem.presetId)
      : null;
  const requestedSelection = requestedFamily ? connectionSelections[requestedFamily.id] : undefined;
  const navigationUnavailable =
    !modelProvidersLoading &&
    !familyConnectionSettingsLoading &&
    (familyConnectionSettingsFailed ||
      Boolean(
        requestedFamily &&
        requestedSelection &&
        requestedSelection.kind !== "start-plan" &&
        !selectableNavigationItems.some((item) =>
          connectionSelectionMatchesNavigationItem(requestedFamily.id, requestedSelection, item),
        ),
      ));

  const fallbackNodeKey = resolveFallbackModelProviderNodeKey({
    selectedNodeKey,
    selectableNavigationItems,
  });
  // When the first scan finds agents, a selection parked on the catalog entry moves to the first agent.
  const firstAcpAgentKey = acpGroup?.items.find((item) => item.type === "acpAgent")?.key ?? null;
  useEffect(() => {
    // Detection owns the ACP rows until it settles: an acp-agent selection is not yet resolvable.
    if (acpDetectionPending && isAcpNodeKey(selectedNodeKey)) {
      return;
    }
    if (
      firstAcpAgentKey &&
      (selectedNodeKey === ACP_DETECT_NODE_KEY || selectedNodeKey === ACP_LOADING_NODE_KEY)
    ) {
      setSelectedNodeKey(firstAcpAgentKey);
      return;
    }
    const hasSelectedNode = selectedNodeKey ? sideNavigationItemByKey.has(selectedNodeKey) : false;
    if (hasSelectedNode) {
      return;
    }

    if (selectedNodeKey !== fallbackNodeKey) {
      setSelectedNodeKey(fallbackNodeKey);
    }
  }, [
    acpDetectionPending,
    fallbackNodeKey,
    firstAcpAgentKey,
    selectedNavItem,
    selectedNodeKey,
    setSelectedNodeKey,
    sideNavigationItemByKey,
  ]);

  return {
    navigationGroups,
    navigationItems,
    selectedNavItem,
    navigationUnavailable,
  };
}

function shouldShowCodingPlanForProviderFamilyDomain(
  oauthProviderId: OAuthProviderId,
  providerFamilyDomain: ProviderFamilyDomain | null,
): boolean {
  if (!providerFamilyDomain) {
    return true;
  }
  return resolveProviderFamilyDomainFromOAuthProvider(oauthProviderId) === providerFamilyDomain;
}

function resolvePresetFamilyStatusProvider({
  presetId,
  provider,
  connectionModeItems,
  connectionSelections,
  modelProviders,
}: {
  presetId: PresetProviderSpec["id"];
  provider: ProviderSettingsFormProvider | null;
  connectionModeItems: ModelProviderNavGroup["items"];
  connectionSelections: ProviderFamilyConnectionSelectionSettings;
  modelProviders: ProviderSettingsFormProvider[];
}): ProviderSettingsFormProvider | null {
  const familySpec = resolveModelProviderFamilySpecByProviderId(presetId);
  if (!familySpec) {
    return provider;
  }
  const connectionItem = pickFamilyModeNavigationItem(
    connectionModeItems.filter(isSelectableNavItem),
    familySpec.id,
    connectionSelections,
  );
  if (!connectionItem || !isPlanConnectionNavigationItem(connectionItem)) {
    return null;
  }
  // A Team item in the menu may be derived from a personal item and carry a provider that is not the team execution identity.
  // Return to the Settings View by exact plan ID; do not activate it from menu entitlements or an inherited provider.
  return (
    modelProviders.find((candidate) => candidate.providerId === connectionItem.presetId) ?? null
  );
}

export function resolveFallbackModelProviderNodeKey({
  selectedNodeKey,
  selectableNavigationItems,
}: {
  selectedNodeKey: string | null;
  selectableNavigationItems: Array<ModelProviderSelectableNavItem>;
}): string | null {
  const initialConnectionItem = pickInitialConnectionNavigationItem(selectableNavigationItems);
  const initialSideNodeKey = initialConnectionItem
    ? resolveSideNavigationNodeKeyForConnectionItem(initialConnectionItem)
    : null;
  if (isFamilyPresetNodeKey(selectedNodeKey) && initialSideNodeKey) {
    // After successful App OAuth login, another preset entry is hidden based on the active provider.
    // If the selected item disappears, fall back to the initialization priority for the matching family instead of putting the connection method back in the sidebar.
    return initialSideNodeKey;
  }

  // Initialization occurs only when there is no valid selection; if the user's current choice is valid, the parent effect does not call fallback and steal focus.
  return (
    initialSideNodeKey ??
    resolveSideNavigationNodeKeyForConnectionItem(selectableNavigationItems[0] ?? null)
  );
}

function resolveSelectedProviderFamilyConnectionItem({
  selectedNodeKey,
  navigationItemByKey,
  selectableNavigationItems,
  connectionSelections,
  pendingConnectionSelections,
  familyConnectionSettingsLoading,
  familyConnectionSettingsFailed,
  modelProvidersLoading,
}: {
  selectedNodeKey: string;
  navigationItemByKey: Map<string, ModelProviderSelectableNavItem>;
  selectableNavigationItems: Array<ModelProviderSelectableNavItem>;
  connectionSelections: ProviderFamilyConnectionSelectionSettings;
  pendingConnectionSelections: ProviderFamilyConnectionSelectionSettings;
  familyConnectionSettingsLoading?: boolean;
  familyConnectionSettingsFailed?: boolean;
  modelProvidersLoading?: boolean;
}): ModelProviderSelectableNavItem | null {
  const selectedItem = navigationItemByKey.get(selectedNodeKey) ?? null;
  if (!selectedItem) {
    return null;
  }
  if (selectedItem.type !== "preset") {
    return selectedItem;
  }
  const familySpec = resolveModelProviderFamilySpecByProviderId(selectedItem.presetId);
  if (!familySpec) {
    return selectedItem;
  }
  if (familyConnectionSettingsLoading) {
    // When Model Settings opens from an external entry, do not infer Start Plan from the default OAuth connection method before settings first hydrate,
    // or the right-side connection method briefly flashes as Start before correcting to the saved settings.
    return null;
  }
  const mergedSelections = { ...connectionSelections, ...pendingConnectionSelections };
  const resolvedItem =
    !familyConnectionSettingsFailed &&
    pickFamilyModeNavigationItem(selectableNavigationItems, familySpec.id, mergedSelections);
  if (resolvedItem) {
    return resolvedItem;
  }
  if (modelProvidersLoading) return null;
  // An invalid/expired connection affects only the current settings-page destination; do not let the detail page interpret null as permanent loading.
  // Do not write back Family preference or change conversation Selection; users can choose again on this same Family page.
  return pickInitialConnectionNavigationItem(
    selectableNavigationItems.filter(
      (item) =>
        "presetId" in item &&
        resolveModelProviderFamilySpecByProviderId(item.presetId)?.id === familySpec.id,
    ),
  );
}

function resolveSideNavigationNodeKeyForConnectionItem(
  item: ModelProviderSelectableNavItem | null,
): string | null {
  if (!item) {
    return null;
  }
  if (item.type !== "preset" && item.type !== "codingPlan" && item.type !== "teamPlan") {
    return item.key;
  }
  if (item.type === "codingPlan" && isStartPlanModelProviderId(item.presetId)) return item.key;
  const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
  if (!familySpec) {
    return item.key;
  }
  return createPresetProviderNodeKey(familySpec.startPlanProviderId);
}

function pickInitialConnectionNavigationItem(
  selectableNavigationItems: Array<ModelProviderSelectableNavItem>,
): ModelProviderSelectableNavItem | null {
  const planItems = selectableNavigationItems.filter(isPlanConnectionNavigationItem);
  const personalCodingPlanItem = planItems.find(
    (item) =>
      item.type === "codingPlan" &&
      !isStartPlanModelProviderId(item.presetId) &&
      item.status === "purchased",
  );
  if (personalCodingPlanItem) {
    return personalCodingPlanItem;
  }
  const teamPlanItem = planItems.find((item) => item.type === "teamPlan");
  if (teamPlanItem) {
    return teamPlanItem;
  }
  const personalCodingPlanFallback = planItems.find(
    (item) => item.type === "codingPlan" && !isStartPlanModelProviderId(item.presetId),
  );
  if (personalCodingPlanFallback) {
    return personalCodingPlanFallback;
  }
  if (planItems[0]) {
    return planItems[0];
  }
  return selectableNavigationItems.find((item) => item.type === "preset") ?? null;
}

function pickFamilyModeNavigationItem(
  selectableNavigationItems: Array<ModelProviderSelectableNavItem>,
  familyId: "zai" | "bigmodel",
  connectionSelections: ProviderFamilyConnectionSelectionSettings,
): ModelProviderSelectableNavItem | null {
  const selection = connectionSelections[familyId];
  if (!selection) return null;
  return (
    selectableNavigationItems.find((item) =>
      connectionSelectionMatchesNavigationItem(familyId, selection, item),
    ) ?? null
  );
}

export function resolveSelectedFamilyModeNodeKey({
  selectedNavItem,
  selectableNavigationItems,
  connectionSelections = {},
  pendingConnectionSelections = {},
}: {
  selectedNavItem: ModelProviderSelectableNavItem | null;
  selectableNavigationItems: Array<ModelProviderSelectableNavItem>;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  pendingConnectionSelections?: ProviderFamilyConnectionSelectionSettings;
}): string | null {
  if (
    selectedNavItem?.type !== "preset" &&
    selectedNavItem?.type !== "codingPlan" &&
    selectedNavItem?.type !== "teamPlan"
  ) {
    return null;
  }
  const familySpec = resolveModelProviderFamilySpecByProviderId(selectedNavItem.presetId);
  if (!familySpec) {
    return null;
  }
  const savedItem = pickFamilyModeNavigationItem(selectableNavigationItems, familySpec.id, {
    ...connectionSelections,
    ...pendingConnectionSelections,
  });
  return savedItem && savedItem.key !== selectedNavItem.key ? savedItem.key : null;
}

export function connectionSelectionMatchesNavigationItem(
  family: ProviderFamilyDomain,
  selection: ProviderFamilyConnectionSelection,
  item: ModelProviderSelectableNavItem,
): boolean {
  if (!("presetId" in item)) return false;
  const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
  if (familySpec?.id !== family) return false;
  if (selection.kind === "start-plan") {
    return false;
  }
  if (selection.kind === "individual-coding-plan") {
    return (
      item.type === "codingPlan" && item.presetId === familySpec.individualCodingPlanProviderId
    );
  }
  return (
    item.type === "teamPlan" &&
    item.presetId === familySpec.teamCodingPlanProviderId &&
    // Team connections are identified by platform, organization, and project; subscribed products may change between entitlement snapshots and pricing corrections.
    // Do not mistake a product update for a lost connection to the same project, or initialization will show an empty selection and an incorrect error.
    item.organizationId === selection.organizationId &&
    item.projectId === selection.projectId
  );
}

function isPlanConnectionNavigationItem(
  item: ModelProviderSelectableNavItem,
): item is Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" | "teamPlan" }> {
  return (
    (item.type === "codingPlan" && !isStartPlanModelProviderId(item.presetId)) ||
    item.type === "teamPlan"
  );
}

function isFamilyPresetNodeKey(nodeKey: string | null): boolean {
  return (
    nodeKey?.startsWith("coding-plan:") === true ||
    nodeKey?.startsWith("team:") === true ||
    nodeKey === `preset:${BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan}` ||
    nodeKey === `preset:${BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan}`
  );
}
