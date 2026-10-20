/* oxlint-disable eslint(max-lines) -- V4ComposerToolbar groups model/reasoning-depth/context-usage controls; splitting further would scatter state shared by toolbar shortcuts and model-catalog memoization. */
/**
 * V4 composer toolbar.
 *
 * All display components reuse the old chat-input-toolbar's pure-props components (ModelConfigSelect /
 * ChatModeSwitchControl / ThoughtLevelCycleControl / ChatContextUsage) and match the old ChatInputToolbar's
 * appearance. State orchestration uses new v4 wiring and does not revive the old ChatInputToolbar effect
 * chain or protocol write paths:
 * - The current model/tier comes from Composer; usage for a running conversation comes from snapshot.usage.contextWindow.
 * - Model, reasoning depth, and mode update only the Composer intent for the next Submission.
 * - Static model facts come from the target Host ModelSelectionView; workspace configOptions provides only
 *   non-model presentation such as mode.
 *
 * New tasks and existing conversations use the same Composer display facts; prewarm does not fill in the model or tier.
 * On submit, the host (SessionPane) sends the frozen selection with the Submission.
 * Do not gate all three controls on config!==null—the draft state would render none of them.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlarmClockIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  getModelProviderFamilySpec,
  resolveModelProviderFamilySpecByProviderId,
  resolveContextBudgetTone,
  ZCODE_AGENT_PROVIDER,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type UsageEntitlementSnapshot,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
  type ZCodeProvider,
  type ZCodeConfigOption,
} from "@zcode/shared";
import { TID_V4_MODEL_CONFIG, TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import type {
  SessionConfigState,
  SessionPhase,
  SessionUsageState,
} from "@zcode/shared/zcode-protocol-v4";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import type { ComposerModelOptions } from "@/chat-input-toolbar/ComposerModelMenu.js";
import { Button } from "@/components/ui/button.js";
import { HighspeedModelIndicator } from "@/highspeed/HighspeedModelIndicator.js";
import { formatHighspeedRemainingTime } from "@/highspeed/highspeedTime.js";
import { ChatContextUsage } from "@/chat-input-toolbar/display.js";
import {
  hasChatCodingPlanUsageRemaining,
  type ChatCodingPlanUsageRemainingConfig,
} from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import {
  hasChatStartPlanBalance,
  type ChatStartPlanBalanceConfig,
} from "@/chat-input-toolbar/StartPlanContextBalance.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import {
  getNextThoughtLevelValue,
  getThoughtLevelLabel,
} from "@/chat-input-toolbar/thoughtLevelOptions.js";
import type { V4ComposerConfigPicker } from "@/v4/composer/configPickerState.js";
import { useToolbarShortcutBindings } from "@/v4/composer/toolbarShortcuts.js";
import {
  resolveModelSelectTriggerDisplay,
  shouldShowManageModelsAction,
} from "@/chat-input-toolbar/modelSelection.js";
import { resolveV4ModelTriggerDisplay } from "@/v4/composer/modelTriggerDisplay.js";
import {
  setPendingSettingsSectionIntent,
  setPendingSettingsUsageCodingPlanIntent,
} from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { ModelSelectionView } from "@zcode/services";
import type {
  ModelSelectionState,
  ModelSelectionRefreshResult,
} from "@/hooks/useModelSelectionView.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useComposerConnectionSwitch } from "@/hooks/useComposerConnectionSwitch.js";
import {
  buildComposerPlanGroups,
  composerConnectionKey,
  chooseConnectionModel,
} from "@/lib/composerPlanGroups.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import {
  useUsageEntitlement,
  type UsageEntitlementRefreshOptions,
} from "@/hooks/useUsageEntitlement.js";
import { useToolbarConfigOptions } from "@/hooks/useZCodeConfig.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { logger } from "@/logger.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useCodingPlanEntitlements } from "@/settings/model-provider-section/useCodingPlanEntitlements.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import {
  buildCodingPlanUsageSources,
  type CodingPlanUsageSource,
} from "@/lib/codingPlanUsageSources.js";
import {
  type SidebarUsageCodingPlanProviderId,
  type SidebarUsageCodingPlanSourceId,
  writeSidebarUsageCodingPlanProviderPreference,
} from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
import {
  resolveDraftDisplayedConfig,
  resolveDraftModelThoughtOption,
  resolveDraftThoughtCurrentValue,
} from "@/v4/composer/draftWorkspaceDefaults.js";

// Re-export split components (mode selection moved to V4ComposerModeControls to split an oversized file):
// existing consumers (ConversationComposer) continue importing from this module; the public interface is unchanged.
export { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";

const V4_COMPOSER_INPUT_SELECTOR = `[data-testid="${TID_V4_COMPOSER_INPUT}"]`;
const MODEL_SELECTION_LOADING_STATE: ModelSelectionState = { status: "loading" };

/** Stable no-op callback (the single hotkey-hook instance handles only options owned by this component; other actions are placeholders). */
function noop(): void {}

function HighspeedCountdown({ expiresAt }: { expiresAt: number }) {
  const { intl, locale } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingTime = formatHighspeedRemainingTime(expiresAt, now);
  const absoluteExpiryLabel = intl.formatMessage(
    { id: "chat.highspeed.expiresAt" },
    {
      time: new Date(expiresAt).toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    },
  );
  const remainingTimeLabel = intl.formatMessage(
    { id: "chat.highspeed.remainingTime" },
    { time: remainingTime },
  );

  // Root cause: the countdown previously collapsed after Think, continuing to occupy a fixed 82px
  // in medium-width windows. In narrow windows, hide only the value and keep the hoverable clock entry.
  return (
    <span
      aria-label={absoluteExpiryLabel}
      title={remainingTimeLabel}
      data-highspeed-countdown="true"
      className="highspeed-inline-countdown inline-flex h-7 w-[82px] shrink-0 items-center justify-center gap-1 rounded-md p-1 text-ui-caption @max-xl/composer:w-7 @max-xl/composer:gap-0 @max-xl/composer:p-0"
    >
      <AlarmClockIcon className="size-4 shrink-0" aria-hidden="true" />
      <span
        data-highspeed-countdown-value="true"
        className="relative h-[18px] w-[54px] shrink-0 leading-4 tabular-nums @max-xl/composer:hidden"
      >
        <span className="absolute left-0 top-0.5">{remainingTime}</span>
      </span>
    </span>
  );
}

export interface ModelSelectionSource {
  provider: string;
  model: string;
}

type V4ContextPlanConnection =
  | { kind: "none" }
  | {
      family: ProviderFamilyDomain;
      kind: "personalCoding";
      providerId:
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
    }
  | {
      family: ProviderFamilyDomain;
      kind: "teamCoding";
      providerId:
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
      selection: Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>;
    }
  | {
      family: ProviderFamilyDomain;
      kind: "start";
      providerId:
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
    };

function resolveFamilyForPlanProviderId(providerId: string | null | undefined): {
  family: ProviderFamilyDomain;
  kind: "personalCoding" | "teamCoding" | "start";
} | null {
  switch (providerId?.trim()) {
    case BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan:
      return { family: "zai", kind: "personalCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan:
      return { family: "zai", kind: "teamCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan:
      return { family: "zai", kind: "start" };
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan:
      return { family: "bigmodel", kind: "personalCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan:
      return { family: "bigmodel", kind: "teamCoding" };
    case BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan:
      return { family: "bigmodel", kind: "start" };
    default:
      return null;
  }
}

function resolveV4ContextPlanConnection(params: {
  connectionSelections?: ProviderFamilyConnectionSelectionSettings | null;
  providerId?: string | null;
}): V4ContextPlanConnection {
  const providerFamily = resolveFamilyForPlanProviderId(params.providerId);
  if (!providerFamily) {
    return { kind: "none" };
  }

  // Start quota belongs to the input's effective model; a global paid connection must not gate its lookup.
  if (providerFamily.kind === "start") {
    const providerId = params.providerId?.trim();
    if (
      providerId !== BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan &&
      providerId !== BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
    ) {
      return { kind: "none" };
    }
    return {
      family: providerFamily.family,
      kind: "start",
      providerId,
    };
  }

  const selection = params.connectionSelections?.[providerFamily.family];
  if (!selection) return { kind: "none" };

  const providerId = params.providerId?.trim();
  if (providerFamily.kind === "teamCoding" && selection.kind === "team-coding-plan") {
    return {
      family: providerFamily.family,
      kind: "teamCoding",
      providerId: providerId as
        | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
        | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      selection,
    };
  }
  if (providerFamily.kind !== "personalCoding" || selection.kind !== "individual-coding-plan") {
    return { kind: "none" };
  }

  return {
    family: providerFamily.family,
    kind: "personalCoding",
    providerId: providerId as
      | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
      | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  };
}

function resolveContextTeamUsageSourceFromEntitlementSnapshot({
  accountAccess,
  snapshot,
}: {
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess | null;
  snapshot?: UsageEntitlementSnapshot | null;
}): CodingPlanUsageSource | null {
  if (snapshot?.context?.scope !== "team") {
    return null;
  }
  const organizationId = snapshot.context.organizationId?.trim() ?? "";
  const projectId = snapshot.context.projectId?.trim() ?? "";
  if (!organizationId || !projectId) {
    return null;
  }
  const subscription = snapshot.subscription?.details[0] ?? null;
  const productId =
    snapshot.context.productId?.trim() || subscription?.productId?.trim() || "current";
  // The old implementation hard-coded createBigModelTeamPlanConnectionKey and the bigmodelCodingPlan providerId,
  // causing zai team snapshots to also use a bigmodel-prefixed sourceId (unlike settings/usage sources).
  // Look up the family from snapshot.provider.id and generate the matching prefix.
  const familySpec = resolveModelProviderFamilySpecByProviderId(snapshot.provider?.id ?? "");
  const family: ProviderFamilyDomain = familySpec?.id ?? "bigmodel";
  if (!accountAccess) {
    return null;
  }
  if ("mode" in accountAccess && accountAccess.mode !== "team-coding-plan") {
    return null;
  }
  if (
    "planKind" in accountAccess &&
    (accountAccess.planKind !== "team-coding-plan" ||
      accountAccess.productId !== productId ||
      accountAccess.organizationId !== organizationId ||
      accountAccess.projectId !== projectId)
  ) {
    return null;
  }
  const codingPlanProviderId = getModelProviderFamilySpec(family).teamCodingPlanProviderId;
  const sourceId = ["team", family, productId, organizationId, projectId]
    .map(encodeURIComponent)
    .join(":") as SidebarUsageCodingPlanSourceId;
  const displayName =
    snapshot.context.displayName?.trim() || subscription?.productName?.trim() || "Team";

  return {
    id: sourceId,
    providerId: codingPlanProviderId,
    accountAccess: {
      type: "zhipu-account",
      family,
      planKind: "team-coding-plan",
      productId,
      organizationId,
      projectId,
    },
    label: `${familySpec?.id === "zai" ? "ZAI" : "BigModel"} - ${displayName}`,
  };
}

function resolveContextCodingPlanUsageSource(params: {
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess | null;
  cachedTeamSources?: readonly CodingPlanUsageSource[];
  entitlementSnapshot?: UsageEntitlementSnapshot | null;
  // The old type/guard was hard-coded to bigmodelCodingPlan, so zai team context always returned null.
  // Allow both zai and bigmodel codingPlan provider IDs.
  providerId?:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan;
  teamSelection?: Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>;
  subscribedTeamProducts: Parameters<
    typeof buildCodingPlanUsageSources
  >[0]["subscribedTeamProducts"];
}): CodingPlanUsageSource | null {
  if (!params.teamSelection) return null;
  if (!params.accountAccess) return null;

  return (
    buildCodingPlanUsageSources({
      accountAccesses: {
        [resolveModelProviderFamilySpecByProviderId(params.providerId ?? "")?.id ?? "bigmodel"]:
          params.accountAccess,
      },
      subscribedTeamProducts: params.subscribedTeamProducts,
    }).find(
      (source) =>
        "planKind" in source.accountAccess &&
        source.accountAccess.planKind === "team-coding-plan" &&
        source.accountAccess.productId === params.teamSelection?.productId &&
        source.accountAccess.organizationId === params.teamSelection?.organizationId &&
        source.accountAccess.projectId === params.teamSelection?.projectId,
    ) ??
    params.cachedTeamSources?.find(
      (source) =>
        "planKind" in source.accountAccess &&
        source.accountAccess.planKind === "team-coding-plan" &&
        source.accountAccess.productId === params.teamSelection?.productId &&
        source.accountAccess.organizationId === params.teamSelection?.organizationId &&
        source.accountAccess.projectId === params.teamSelection?.projectId,
    ) ??
    resolveContextTeamUsageSourceFromEntitlementSnapshot({
      accountAccess: params.accountAccess,
      snapshot: params.entitlementSnapshot,
    })
  );
}

export interface V4ComposerToolbarProps {
  workspacePath: string;
  workspaceIdentity?: string;
  modelSelectionView?: ModelSelectionView | null;
  modelSelectionState?: ModelSelectionState;
  modelSelectionReload?: () => void;
  modelSelectionRefresh?: () => Promise<ModelSelectionRefreshResult>;
  sessionId: string | null;
  phase: SessionPhase | null;
  provider?: ZCodeProvider;
  /** Whether the toolbar currently runs inside the Web remote-control shell. */
  isWebRemoteControl?: boolean;
  /** Whether the current viewport uses the mobile input layout. */
  isMobileViewport?: boolean;
  /** Draft state (sessionId=null); distinguishes new-task presentation only and does not change the selection source. */
  draftMode?: boolean;
  /** Composer selection for the current scope; new tasks and existing conversations both display this state only. */
  draftConfig?: Partial<SessionConfigState>;
  usage: SessionUsageState | null;
  disabled: boolean;
  /** Lock the model for this turn while a Highspeed card is active; do not allow switching through the picker or shortcuts. */
  modelLocked?: boolean;
  /** Show the Highspeed model and countdown after the diffusion tail starts (immediately on restored entry). */
  highspeedPresented?: boolean;
  /** Whether this entry is an activation effect for a newly drawn hit; restored model markers do not flip. */
  highspeedEntranceAnimated?: boolean;
  /** Play the shimmer once after the model flip finishes and settles. */
  highspeedSweepActive?: boolean;
  /** Highspeed card expiry time; when present, show a countdown between the model and Think. */
  highspeedExpiresAt?: number;
  /** Model bound to the draw response; overrides trigger text only while the model is locked. */
  highspeedModel?: string;
  /** Exclusive owner for configuration pickers within one composer; renderer-local presentation only. */
  activeConfigPicker: V4ComposerConfigPicker | null;
  onConfigPickerOpenChange: (picker: V4ComposerConfigPicker, open: boolean) => void;
  /**
   * Selected model (providerId/modelId decoded from the catalog value), updated and persisted by the Composer owner.
   * sourceModel identifies only the origin of this user action; do not fill CAS or reasoning tier from the Session projection.
   */
  onSelectModel: (
    provider: string,
    model: string,
    sourceModel: ModelSelectionSource | null,
    reasoningLevel?: string,
  ) => void;
  /** Selected reasoning depth; modelContext pins the target model for this user action. */
  onSelectThought: (thought: string, modelContext: { provider: string; model: string }) => void;
  onSwitchMode: (mode: string) => void;
  /** If prepare/configOptions fails, custom-provider selection uses the workspace recovery chain. */
  onRecoverCustomModelSelection?: (
    value: string,
    sourceModel: ModelSelectionSource | null,
  ) => Promise<void> | void;
  onSendCompressionCommand?: (command: string) => void;
}

/** Model/reasoning-depth/context-usage group (rendered left of the send button, as in the old UI). */
function V4ComposerModelControlsImpl({
  workspacePath,
  workspaceIdentity,
  modelSelectionView = null,
  modelSelectionState = MODEL_SELECTION_LOADING_STATE,
  modelSelectionReload,
  modelSelectionRefresh,
  provider,
  isWebRemoteControl = false,
  isMobileViewport = false,
  draftMode = false,
  draftConfig,
  usage,
  disabled,
  modelLocked = false,
  highspeedPresented = false,
  highspeedEntranceAnimated = false,
  highspeedSweepActive = false,
  highspeedExpiresAt,
  highspeedModel,
  activeConfigPicker,
  onConfigPickerOpenChange,
  onSelectModel,
  onSelectThought,
  onSendCompressionCommand,
  onRecoverCustomModelSelection,
}: V4ComposerToolbarProps) {
  const { intl, locale } = useZCodeIntl();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  // Read the configuration surface's default workspace catalog (taskId=null), not legacy conversation state.
  const { error: configOptionsError } = useToolbarConfigOptions(
    workspacePath,
    null,
    workspaceIdentity,
  );
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const providerSourcesLoading = providerSettingsRead.state.status !== "ready";
  // 配置面存活服务读（过渡归宿 = 配置面 v4 化）：连接方式选中键喂 BigModel Team Plan 门控豁免。
  const baseServices = useBaseWorkspaceServices();
  const { settings: sharedSettings } = useSettings({ services: baseServices });
  const {
    entitlements,
    enabledStartPlanProviderIds,
    refresh: refreshCodingPlanEntitlements,
  } = useCodingPlanEntitlements({
    providerSettingsView,
    connectionSelections: sharedSettings?.providerFamilyConnectionSelections,
    // Refresh context only when the user hovers/opens it; do not request quota when the composer mounts.
    suppressProviderFingerprintAutoRefresh: true,
  });
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const modelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);
  // Ctrl+M shortcut: increment openRequestKey to ask ModelConfigSelect to open its menu (the old handleOpenModelMenuShortcut behavior).
  const [modelMenuOpenRequestKey, setModelMenuOpenRequestKey] = useState(0);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const handleOpenModelMenuShortcut = useCallback(() => {
    setModelMenuOpenRequestKey((current) => current + 1);
  }, []);
  const handleModelPickerOpenChange = useCallback(
    (open: boolean) => {
      onConfigPickerOpenChange("model", open);
    },
    [onConfigPickerOpenChange],
  );
  const handleThoughtPickerOpenChange = useCallback(
    (open: boolean) => {
      onConfigPickerOpenChange("thought", open);
    },
    [onConfigPickerOpenChange],
  );

  const modelOption = modelSelectionView?.providers.some((provider) => provider.models.length > 0)
    ? ({
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "",
        options: [],
      } satisfies ZCodeConfigOption)
    : undefined;

  // Empty model/tier values were previously filled from stale Session values, making the UI contradict the actual non-submittable state.
  // The Composer owner already performs initialization; the display layer only consumes it and must not fill values again.
  const effectiveConfig = useMemo<SessionConfigState | null>(() => {
    return resolveDraftDisplayedConfig(draftConfig ?? {});
  }, [draftConfig]);

  const handleOpenStartPlanUpgrade = useCallback(
    (providerId: string) => {
      openCodingPlanUpgrade({
        providerId,
        funnelContext: createCodingPlanFunnelContext({
          providerId,
          upgradeSource: "session_token_usage",
          eventRegion: "app.session",
          eventText: intl.formatMessage({ id: "chat.quota.action.upgrade" }),
          entryPlanState: resolveCodingPlanEntryPlanState({
            providerId,
            displayStatus: "purchased",
            planLevel: "start",
          }),
        }),
      });
    },
    [intl, openCodingPlanUpgrade],
  );
  const handleOpenUsageDetails = useCallback(
    (sourceId?: SidebarUsageCodingPlanSourceId) => {
      if (sourceId) {
        writeSidebarUsageCodingPlanProviderPreference(sourceId);
      }
      // “More” for remaining quota opens Coding Plan usage directly (selecting the current plan using the source preference set above),
      // not app usage. The general Usage entry still uses setPendingSettingsUsageIntent.
      setPendingSettingsUsageCodingPlanIntent();
      openSettingsTab();
    },
    [openSettingsTab],
  );

  const contextPlanConnection = useMemo(
    () =>
      resolveV4ContextPlanConnection({
        connectionSelections: sharedSettings?.providerFamilyConnectionSelections,
        providerId: effectiveConfig?.provider,
      }),
    [effectiveConfig?.provider, sharedSettings?.providerFamilyConnectionSelections],
  );
  const contextAccountProviderAccess = useMemo(
    () =>
      contextPlanConnection.kind === "personalCoding" || contextPlanConnection.kind === "teamCoding"
        ? resolveEntitledAccountProviderAccess(
            providerSettingsView,
            contextPlanConnection.providerId,
          )
        : null,
    [contextPlanConnection, providerSettingsView],
  );
  const contextStartPlanBalanceConfig = useMemo<ChatStartPlanBalanceConfig | undefined>(() => {
    if (contextPlanConnection.kind !== "start") {
      return undefined;
    }
    const entitlement = entitlements[contextPlanConnection.providerId];
    // Mount the Start Plan hover lookup only when independent Account Access is available.
    const startPlanEntitlementEnabled = enabledStartPlanProviderIds.includes(
      contextPlanConnection.providerId,
    );
    return {
      loading: entitlement?.loading ?? providerSourcesLoading,
      // The hover access-refresh entry must not be limited to Coding Plan configuration (onAccess):
      // Start Plan users otherwise never refresh today's balance by hovering over the context panel and must
      // wait for settings/sidebar refreshes to sync it passively. Use the same silent access refresh as Coding Plan;
      // the 60-second access window and in-flight request coalescing are handled by refresh policy, so repeated hovering does not amplify billing/balance requests.
      ...(startPlanEntitlementEnabled
        ? {
            onAccess: () => refreshCodingPlanEntitlements({ silent: true, reason: "access" }),
          }
        : {}),
      onUpgradeClick: () => handleOpenStartPlanUpgrade(contextPlanConnection.providerId),
      snapshot:
        entitlement?.snapshot?.provider?.id === contextPlanConnection.providerId
          ? entitlement.snapshot
          : null,
    };
  }, [
    contextPlanConnection,
    enabledStartPlanProviderIds,
    entitlements,
    handleOpenStartPlanUpgrade,
    providerSourcesLoading,
    refreshCodingPlanEntitlements,
  ]);
  const contextStartPlanBalance = hasChatStartPlanBalance(contextStartPlanBalanceConfig)
    ? contextStartPlanBalanceConfig
    : undefined;

  // 按当前连接 family 拉取团队产品，避免 zai 团队误用 bigmodel 产品目录。
  const connectionFamily =
    resolveModelProviderFamilySpecByProviderId(effectiveConfig?.provider ?? "")?.id ??
    sharedSettings?.providerFamilyDomain ??
    "bigmodel";
  const user = useZCodeStoreWithDefault((state) => state.user, undefined);
  const connectionAuthenticated =
    user !== null &&
    Boolean(
      providerSettingsView?.providers.some(
        (p) =>
          p.effectiveConfig.access?.type === "zhipu-account" &&
          p.effectiveConfig.access.accountType === connectionFamily &&
          p.enabled &&
          p.accountState?.unavailableReason !== "not-authenticated" &&
          (p.effectiveConfig.access.mode === "team-coding-plan" ||
            p.accountState?.availability === "available"),
      ),
    );
  const enterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled:
      !providerSourcesLoading &&
      (contextPlanConnection.kind === "teamCoding" || activeConfigPicker === "model") &&
      connectionAuthenticated,
    authenticated: connectionAuthenticated,
    family: connectionFamily,
  });
  const subscribedTeamProducts = useMemo(
    () =>
      (connectionAuthenticated
        ? enterpriseProducts.snapshot?.productList.filter((product) => product.subscribed === true)
        : undefined) ?? [],
    [connectionAuthenticated, enterpriseProducts.snapshot?.productList],
  );
  const authSessionSeq = useZCodeStoreWithDefault((state) => state.authSessionSeq, 0);
  const teamUsageScope = useMemo(
    () => ({}),
    [baseServices, connectionFamily, user?.id, authSessionSeq],
  );
  const contextTeamUsageSourceCacheRef = useRef<{
    scope: object;
    sources: CodingPlanUsageSource[];
  }>({ scope: teamUsageScope, sources: [] });
  // 原因：独立来源缓存可复活已清空的目录；鉴权边界要在本次渲染就隔离，不能等待 Provider 刷新。
  if (contextTeamUsageSourceCacheRef.current.scope !== teamUsageScope || !connectionAuthenticated)
    contextTeamUsageSourceCacheRef.current = { scope: teamUsageScope, sources: [] };
  const contextCodingPlanUsageProviderId =
    contextPlanConnection.kind === "personalCoding" || contextPlanConnection.kind === "teamCoding"
      ? contextPlanConnection.providerId
      : undefined;
  const contextCodingPlanUsageTeamSource = useMemo(
    () =>
      connectionAuthenticated && contextPlanConnection.kind === "teamCoding"
        ? resolveContextCodingPlanUsageSource({
            accountAccess: contextAccountProviderAccess?.access,
            cachedTeamSources: contextTeamUsageSourceCacheRef.current.sources,
            // 原硬取 bigmodelCodingPlan 的 entitlement snapshot，
            // zai team plan 查不到额度。改为按 connection.providerId 取对应 snapshot。
            entitlementSnapshot: entitlements[contextPlanConnection.providerId]?.snapshot ?? null,
            providerId: contextPlanConnection.providerId,
            teamSelection: contextPlanConnection.selection,
            subscribedTeamProducts,
          })
        : null,
    [
      connectionAuthenticated,
      teamUsageScope,
      contextAccountProviderAccess?.access,
      contextPlanConnection,
      entitlements,
      subscribedTeamProducts,
    ],
  );
  useEffect(() => {
    if (!contextCodingPlanUsageTeamSource) {
      return;
    }
    const cache = contextTeamUsageSourceCacheRef.current.sources;
    const nextCache = cache.filter((source) => source.id !== contextCodingPlanUsageTeamSource.id);
    nextCache.unshift(contextCodingPlanUsageTeamSource);
    // Team -> Personal(no_plan) -> Team 期间企业商品或个人 snapshot 可能短暂缺失。
    // 保留最近解析过的团队 source，避免输入框 context 余额跟随水合顺序闪断。
    contextTeamUsageSourceCacheRef.current = {
      scope: teamUsageScope,
      sources: nextCache.slice(0, 8),
    };
  }, [contextCodingPlanUsageTeamSource, teamUsageScope]);
  const contextCodingPlanUsageSelectedSourceId: SidebarUsageCodingPlanSourceId | undefined =
    contextPlanConnection.kind === "teamCoding"
      ? contextCodingPlanUsageTeamSource?.id
      : contextCodingPlanUsageProviderId;
  const teamEntitlement = useUsageEntitlement({
    enabled: !providerSourcesLoading && Boolean(contextCodingPlanUsageTeamSource),
    includeSubscription: true,
    // Previously this hard-coded bigmodelCodingPlan. When a zai-family team plan was selected,
    // contextCodingPlanUsageTeamSource.providerId was zaiCodingPlan but this still passed bigmodelCodingPlan.
    // The server's pickQuotaProvider then failed to find the zai provider by exact providerId,
    // resolveAuthorization returned null, and the input context usage area showed no quota for the zai team plan.
    // Follow the team source's providerId instead (resolveContextTeamUsageSourceFromEntitlementSnapshot /
    // resolveV4ContextPlanConnection already produce zaiCodingPlan/bigmodelCodingPlan according to family).
    preferredProviderId:
      contextCodingPlanUsageTeamSource?.providerId ??
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: contextCodingPlanUsageTeamSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: contextCodingPlanUsageTeamSource?.id,
    refreshOnMount: false,
  });
  const refreshTaskEntitlements = useCallback(
    async (options?: UsageEntitlementRefreshOptions) => {
      // The Team Plan context panel uses sourceId to isolate its freshness key; publish it with global entitlements
      // during task-boundary refreshes, and the underlying request key coalesces identical team requests.
      await Promise.all([refreshCodingPlanEntitlements(options), teamEntitlement.refresh(options)]);
    },
    [refreshCodingPlanEntitlements, teamEntitlement.refresh],
  );
  const contextCodingPlanUsageProviders = useMemo(() => {
    if (contextPlanConnection.kind !== "personalCoding" || !contextCodingPlanUsageProviderId) {
      return [];
    }
    const access = contextAccountProviderAccess;
    if (!access) return [];
    return [
      {
        providerId: contextCodingPlanUsageProviderId as SidebarUsageCodingPlanProviderId,
        accountAccess: access.access,
        label:
          access.label ||
          (contextCodingPlanUsageProviderId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
            ? "Z.ai - Coding Plan"
            : "BigModel - Coding Plan"),
      },
    ];
  }, [contextAccountProviderAccess, contextCodingPlanUsageProviderId, contextPlanConnection.kind]);
  const codingPlanUsageEntitlements = useMemo<
    ChatCodingPlanUsageRemainingConfig["entitlements"]
  >(() => {
    if (contextCodingPlanUsageTeamSource) {
      return [
        {
          sourceId: contextCodingPlanUsageTeamSource.id,
          providerId: contextCodingPlanUsageTeamSource.providerId,
          accountAccess: contextCodingPlanUsageTeamSource.accountAccess,
          label: contextCodingPlanUsageTeamSource.label,
          snapshot: teamEntitlement.snapshot,
          loading: teamEntitlement.loading,
          error: teamEntitlement.error,
        },
      ];
    }

    if (
      contextPlanConnection.kind !== "personalCoding" ||
      !contextCodingPlanUsageProviderId ||
      contextCodingPlanUsageProviders.length === 0
    ) {
      return [];
    }
    const providerId = contextCodingPlanUsageProviderId;
    const entitlement = entitlements[providerId];
    return [
      {
        sourceId: providerId,
        providerId,
        accountAccess: contextCodingPlanUsageProviders[0]!.accountAccess,
        snapshot: entitlement?.snapshot ?? null,
        loading: entitlement?.loading ?? providerSourcesLoading,
        error: entitlement?.error ?? null,
      },
    ];
  }, [
    contextCodingPlanUsageProviderId,
    contextCodingPlanUsageProviders.length,
    contextCodingPlanUsageTeamSource,
    contextPlanConnection.kind,
    entitlements,
    providerSourcesLoading,
    teamEntitlement.error,
    teamEntitlement.loading,
    teamEntitlement.snapshot,
  ]);
  const handleUsageClick = useCallback(
    () => handleOpenUsageDetails(contextCodingPlanUsageSelectedSourceId),
    [contextCodingPlanUsageSelectedSourceId, handleOpenUsageDetails],
  );
  const codingPlanUsageRemainingConfig = useMemo<
    ChatCodingPlanUsageRemainingConfig | undefined
  >(() => {
    if (contextPlanConnection.kind !== "personalCoding" && !contextCodingPlanUsageTeamSource) {
      return undefined;
    }
    return {
      availableProviders: contextCodingPlanUsageProviders,
      entitlements: codingPlanUsageEntitlements,
      modelProvidersLoading: providerSourcesLoading,
      onEntitlementRefresh: () => refreshTaskEntitlements({ force: true, silent: true }),
      onAccess: () => refreshTaskEntitlements({ silent: true, reason: "access" }),
      onUsageClick: handleUsageClick,
      selectedProviderId: contextCodingPlanUsageSelectedSourceId,
    };
  }, [
    contextCodingPlanUsageProviders,
    contextCodingPlanUsageSelectedSourceId,
    contextCodingPlanUsageTeamSource,
    contextPlanConnection.kind,
    codingPlanUsageEntitlements,
    handleUsageClick,
    providerSourcesLoading,
    refreshTaskEntitlements,
  ]);
  const codingPlanUsageRemaining =
    codingPlanUsageRemainingConfig &&
    hasChatCodingPlanUsageRemaining(codingPlanUsageRemainingConfig)
      ? codingPlanUsageRemainingConfig
      : undefined;

  // Use debug for high-frequency interaction diagnostics so production log volume does not grow with every selection.
  useEffect(() => {
    if (!draftMode) return;
    logger.debug("[v4-toolbar] draft effectiveConfig changed", {
      provider: effectiveConfig?.provider ?? null,
      model: effectiveConfig?.model ?? null,
      thought: effectiveConfig?.thought ?? null,
      modelSelectionRevision: modelSelectionView?.revision ?? null,
    });
  }, [draftMode, effectiveConfig, modelSelectionView?.revision]);

  const modelGroupLabels = useMemo(
    () => ({
      apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
      apiKeyBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.apiKeyBadge",
      }),
      chatgptPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.chatgpt.pickerBadge",
      }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
      codingPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlanBadge",
      }),
      startPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlan",
      }),
      startPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlanBadge",
      }),
      teamPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.teamPlanBadge",
      }),
      teamPlanFallbackLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.teamPlan",
      }),
    }),
    [intl],
  );
  const modelSelectGroups = useMemo<ModelSelectGroup[]>(() => {
    if (!modelSelectionView) return [];
    return buildRegistryModelSelectGroups(displayProvider, modelSelectionView, modelGroupLabels);
  }, [displayProvider, modelGroupLabels, modelSelectionView]);

  // Restore the “Manage models” entry (the old onManageModels opened settings and focused the model-provider section).
  const handleOpenModelProviderSettings = useCallback(() => {
    setPendingSettingsSectionIntent("modelProvider");
    openSettingsTab();
  }, [openSettingsTab]);
  const showManageModelsAction = shouldShowManageModelsAction(handleOpenModelProviderSettings);
  const manageModelsLabel = intl.formatMessage({
    id: "chat.toolbar.model.manageModels",
  });

  // Encode the currently projected model: use the custom-model encoding when its provider matches the catalog; otherwise fall back to the bare model ID.
  const rawModelValue = useMemo(() => {
    if (!effectiveConfig || !effectiveConfig.model) return "";
    const providerExists = modelSelectionView?.providers.some(
      (candidate) => candidate.providerId === effectiveConfig.provider,
    );
    if (providerExists) {
      return encodeCustomModelValue(effectiveConfig.provider, effectiveConfig.model);
    }
    return effectiveConfig.model;
  }, [effectiveConfig, modelSelectionView]);

  // Trigger display fallback: if `<synthetic>` (a placeholder model synthesized during SDK
  // restore) or the current model is absent from the selectable group (invalid/offline/signed out),
  // fall back to the placeholder/default “Select model” instead of showing an internal protocol placeholder or invalid model.
  // Do not show protocol-internal placeholders or invalid model IDs. Reuse resolveModelSelectTriggerDisplay.
  const triggerDisplay = useMemo(
    () =>
      resolveModelSelectTriggerDisplay(
        rawModelValue,
        modelSelectGroups,
        showManageModelsAction,
        manageModelsLabel,
      ),
    [manageModelsLabel, modelSelectGroups, rawModelValue, showManageModelsAction],
  );
  const normalizedModelValue = triggerDisplay.value ?? "";

  const modelTriggerDisplay = useMemo(() => {
    // For a non-selectable value (unselected/synthetic/unavailable), show the placeholder or default “Select model.”
    const fallbackLabel =
      triggerDisplay.placeholder ?? intl.formatMessage({ id: "chat.toolbar.model.label" });
    const providerName =
      modelSelectionView?.providers.find(
        (candidate) => candidate.providerId === effectiveConfig?.provider,
      )?.providerName ?? undefined;
    return resolveV4ModelTriggerDisplay({
      modelGroups: modelSelectGroups,
      normalizedValue: normalizedModelValue,
      fallbackLabel,
      providerId: effectiveConfig?.provider,
      providerName,
    });
  }, [
    effectiveConfig?.provider,
    intl,
    modelSelectionView,
    modelSelectGroups,
    normalizedModelValue,
    triggerDisplay.placeholder,
  ]);
  const handleModelValueChange = useCallback(
    (value: string, reasoningLevel?: string) => {
      if (modelLocked) return;
      const decoded = decodeCustomModelValue(value);
      // The model visible when clicked in a draft may exist only in the catalog or may already be superseded by
      // the latest draft intent; do not let SessionPane infer it again from a late prewarm projection.
      const sourceModel =
        effectiveConfig?.provider && effectiveConfig.model
          ? {
              provider: effectiveConfig.provider,
              model: effectiveConfig.model,
            }
          : null;
      // Debug log for draft model-switch troubleshooting: clicked value and decode branch.
      logger.debug("[v4-toolbar] model select onValueChange", {
        value,
        decodedProviderId: decoded?.providerId ?? null,
        decodedModelName: decoded?.modelName ?? null,
        draftMode,
      });
      const selectedRegistryProvider = decoded?.providerId
        ? modelSelectionView?.providers.find(
            (candidate) => candidate.providerId === decoded.providerId,
          )
        : undefined;
      const customRecoveryEligible = isApiKeyAccess(selectedRegistryProvider?.config.access);
      if (
        configOptionsError &&
        decoded?.providerId &&
        customRecoveryEligible &&
        onRecoverCustomModelSelection
      ) {
        setRecoveryPending(true);
        void Promise.resolve(onRecoverCustomModelSelection(value, sourceModel))
          .catch((error) => {
            logger.warn("[v4-toolbar] custom provider recovery failed", {
              error: error instanceof Error ? error.message : String(error),
              providerId: decoded.providerId,
            });
          })
          .finally(() => {
            setRecoveryPending(false);
          });
        return;
      }
      if (decoded) {
        if (reasoningLevel !== undefined)
          onSelectModel(decoded.providerId, decoded.modelName ?? "", sourceModel, reasoningLevel);
        else onSelectModel(decoded.providerId, decoded.modelName ?? "", sourceModel);
        return;
      }
      const slashIndex = value.indexOf("/");
      if (slashIndex > 0) {
        onSelectModel(value.slice(0, slashIndex), value.slice(slashIndex + 1), sourceModel);
        return;
      }
      // Bare model ID: keep the current provider (the host fills it from the latest projection).
      onSelectModel("", value, sourceModel);
    },
    [
      configOptionsError,
      displayProvider,
      draftMode,
      effectiveConfig?.model,
      effectiveConfig?.provider,
      onRecoverCustomModelSelection,
      onSelectModel,
      modelLocked,
      modelSelectionView,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const planGroups = useMemo(
    () =>
      buildComposerPlanGroups(
        modelSelectGroups,
        subscribedTeamProducts,
        providerSettingsView,
        displayProvider,
        modelGroupLabels,
        sharedSettings?.providerFamilyConnectionSelections,
      ),
    [
      modelSelectGroups,
      subscribedTeamProducts,
      providerSettingsView,
      displayProvider,
      modelGroupLabels,
      sharedSettings?.providerFamilyConnectionSelections,
    ],
  );
  const connectionSwitch = useComposerConnectionSwitch({
    workspacePath,
    workspaceIdentity,
    agentProvider: displayProvider,
    normalizedValue: normalizedModelValue,
    onSelectModel: handleModelValueChange,
    waitForPresentation: true,
    refreshPresentation: modelSelectionRefresh,
    presentationStatus: modelSelectionState.status,
    presentationRevision: modelSelectionView?.revision,
    presentationErrorRevision:
      modelSelectionState.status === "ready"
        ? modelSelectionState.refreshError?.revision
        : undefined,
  });
  const selectedProviderId = decodeCustomModelValue(normalizedModelValue)?.providerId;
  const selectedPlanGroup = planGroups.find((group) => {
    const connection = group.connection;
    if (!connection || connection.providerId !== selectedProviderId) return false;
    const selection = sharedSettings?.providerFamilyConnectionSelections?.[connection.family];
    return (
      connection.selection?.kind !== "team-coding-plan" ||
      (selection && composerConnectionKey(connection.family, selection) === connection.key)
    );
  });
  const selectedPlanKey = connectionSwitch.pending
    ? connectionSwitch.previousKey
    : (selectedPlanGroup?.key ??
      // 团队共用模型 value；当前过期行隐藏后，不能误选另一团队并阻止用户点击它。
      planGroups.find(
        (group) =>
          group.connection?.selection?.kind !== "team-coding-plan" &&
          group.items.some((item) => item.value === normalizedModelValue),
      )?.key);

  const draftModelThoughtOption = useMemo(
    () =>
      effectiveConfig
        ? resolveDraftModelThoughtOption(
            effectiveConfig.provider,
            effectiveConfig.model,
            modelSelectionView,
          )
        : null,
    [effectiveConfig, modelSelectionView],
  );

  // Candidate tiers come only from the target Host's ModelSelectionView; the selected tier comes only from Composer.
  const thoughtOption = useMemo<ZCodeConfigOption | null>(() => {
    if (!effectiveConfig) return null;
    if (!draftModelThoughtOption) return null;
    return {
      ...draftModelThoughtOption,
      currentValue: resolveDraftThoughtCurrentValue({
        thought: effectiveConfig.thought,
        thoughtLevels: draftModelThoughtOption.options?.map((option) => option.value) ?? [],
      }),
    };
  }, [draftModelThoughtOption, effectiveConfig]);

  const handleThoughtValueChange = useCallback(
    (value: string) => {
      if (!effectiveConfig) return;
      if (!value.trim()) {
        // Rebuilding the controlled Select across models may emit an empty value once; this is not a user selection.
        // Propagating it would mark the model intent superseded and prevent the accepted model from being written to the global tuple.
        logger.debug("[v4-toolbar] ignore synthetic empty thought change", {
          model: effectiveConfig.model,
          provider: effectiveConfig.provider,
        });
        return;
      }
      onSelectThought(value, {
        provider: effectiveConfig.provider,
        model: effectiveConfig.model,
      });
    },
    [effectiveConfig, onSelectThought],
  );

  // Ctrl+T shortcut: cycle the next Submission's reasoning depth in catalog order.
  const handleCycleThoughtLevel = useCallback(() => {
    if (!thoughtOption || thoughtOption.type !== "select") {
      return;
    }
    const nextValue = getNextThoughtLevelValue(thoughtOption);
    if (nextValue == null) {
      return;
    }
    if (!effectiveConfig) return;
    onSelectThought(nextValue, {
      provider: effectiveConfig.provider,
      model: effectiveConfig.model,
    });
  }, [effectiveConfig, onSelectThought, thoughtOption]);

  const taskUsage = useMemo(() => {
    const contextWindow = usage?.contextWindow;
    if (!contextWindow) return null;
    return {
      used: contextWindow.usedTokens,
      size: contextWindow.maxTokens,
      ...(contextWindow.cache ? { cache: contextWindow.cache } : {}),
      ...(contextWindow.breakdown ? { breakdown: contextWindow.breakdown } : {}),
      ...(contextWindow.autoCompactThresholdTokens !== undefined
        ? { autoCompactThresholdTokens: contextWindow.autoCompactThresholdTokens }
        : {}),
      ...(contextWindow.autoCompactThresholdAuthoritative === true
        ? { autoCompactThresholdAuthoritative: true }
        : {}),
      ...(contextWindow.microcompactThresholdTokens !== undefined
        ? { microcompactThresholdTokens: contextWindow.microcompactThresholdTokens }
        : {}),
    };
  }, [usage?.contextWindow]);
  const usageTone = taskUsage
    ? resolveContextBudgetTone({
        autoCompactThresholdTokens:
          taskUsage.autoCompactThresholdAuthoritative === true
            ? taskUsage.autoCompactThresholdTokens
            : undefined,
        contextWindow: taskUsage.size,
        microcompactThresholdTokens: taskUsage.microcompactThresholdTokens,
        usedTokens: taskUsage.used,
      })
    : "normal";
  // Toolbar shortcuts are now command-table commands: tooltip shortcut labels read from the active bindings,
  // so button hints update immediately after rebinding (do not hard-code their text).
  const modelShortcutLabel = useShortcutCommandLabel("openModelMenu");
  const thoughtShortcutLabel = useShortcutCommandLabel("cycleThoughtLevel");
  const selectConnection = connectionSwitch.select;
  // 原因：内联对象会在无关渲染时使 memo 选择器失效；按展示事实和回调缓存选项。
  const composerOptions = useMemo<ComposerModelOptions>(
    () => ({
      providerMenu: {
        groups: planGroups,
        selectedKey: selectedPlanKey,
        pending: connectionSwitch.pending,
        // 团队目录查询不是用户的连接切换操作，不能把登录错误挂到 API 菜单。
        error: connectionSwitch.error,
        onSelect: (group) => {
          // 原因：展示失败时设置可能已成功；已选连接仍须允许重试，不能被同 key 短路。
          if (group.key === selectedPlanKey && !connectionSwitch.error) return;
          if (group.connection) {
            void selectConnection(group.connection, selectedPlanKey);
          } else {
            const model = chooseConnectionModel(
              group.items,
              decodeCustomModelValue(normalizedModelValue)?.modelName,
            );
            const providerId = decodeCustomModelValue(model?.value ?? "")?.providerId;
            // 原因：普通 API 原先绕过连接切换 owner，缺少 loading 且会暴露旧目录。
            if (providerId)
              void selectConnection(
                {
                  key: group.key,
                  label: group.label,
                  providerId,
                  family: connectionFamily,
                  items: group.items,
                },
                selectedPlanKey,
              );
          }
        },
      },
      providerLabel: intl.formatMessage({ id: "chat.toolbar.combined.provider" }),
      modelsLabel: intl.formatMessage({ id: "chat.toolbar.combined.models" }),
      effortLabel: intl.formatMessage({ id: "chat.toolbar.combined.effort" }),
      effortShortcutLabel: thoughtShortcutLabel,
      selectModelLabel: intl.formatMessage({ id: "chat.toolbar.combined.selectModel" }),
      levels:
        thoughtOption?.options?.map((entry) => ({
          value: entry.value,
          label: getThoughtLevelLabel(intl, displayProvider, thoughtOption, entry),
        })) ?? [],
      value: String(thoughtOption?.currentValue ?? ""),
      onValueChange: handleThoughtValueChange,
    }),
    [
      planGroups,
      selectedPlanKey,
      connectionSwitch.pending,
      connectionSwitch.error,
      selectConnection,
      normalizedModelValue,
      connectionFamily,
      intl,
      thoughtShortcutLabel,
      thoughtOption,
      displayProvider,
      handleThoughtValueChange,
    ],
  );
  const isModelOptionLocked = useCallback(() => false, []);

  // Keyboard shortcuts (formerly useToolbarShortcutBindings): Ctrl+M opens the model menu; Ctrl+T cycles reasoning depth.
  // Mode cycling (Ctrl+Shift+M) is bound separately by V4ComposerModeSwitch (modeOption lives there).
  // An empty model is a valid awaiting-selection state, including for existing conversations; do not hide the reselection entry.
  // Show it when selectable groups exist, and also when no groups exist but “Manage models” is available, so users always have a model entry point.
  const modelMenuVisible = modelSelectGroups.length > 0 || showManageModelsAction;
  // Root cause: the fixed-width mobile submenu ignored the available width Radix measured for the
  // current side, and the shared min-w-32 prevented further shrinking in very narrow spaces. Keep
  // the submenu interaction while treating the viewport edge as a hard limit.
  const providerSubmenuClassName =
    isWebRemoteControl && isMobileViewport
      ? "w-40 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)"
      : undefined;
  useToolbarShortcutBindings({
    hasAnyOption: Boolean(modelOption) || Boolean(thoughtOption),
    toolbarDisabled: disabled || recoveryPending || connectionSwitch.pending,
    modelMenuDisabled:
      disabled || recoveryPending || modelLocked || connectionSwitch.pending || !modelMenuVisible,
    modelOption,
    thoughtOption: thoughtOption ?? undefined,
    onOpenModelMenu: handleOpenModelMenuShortcut,
    onCycleThoughtLevel: handleCycleThoughtLevel,
    onCycleSessionMode: noop,
  });

  return (
    <>
      {/*
        E2E contract (TID_V4_MODEL_CONFIG): data-* attribute anchors for Composer/usage state.
        Bug cause: Switching models deliberately clears the source model's explicit thought setting. The
        visible control then shows the target model's default level from its Option Spec, while the
        old anchor still exposes the empty raw projection. data-thought must match the controlled
        value the user actually sees; do not introduce a second draft state.
      */}
      <span
        data-testid={TID_V4_MODEL_CONFIG}
        data-source={effectiveConfig || draftConfig?.mode ? "composer" : ""}
        data-provider={effectiveConfig?.provider ?? ""}
        data-model={effectiveConfig?.model ?? ""}
        data-thought={
          thoughtOption?.type === "select"
            ? String(thoughtOption.currentValue ?? "")
            : (effectiveConfig?.thought ?? "")
        }
        data-thought-levels={
          thoughtOption?.type === "select"
            ? (thoughtOption.options ?? []).map((option) => option.value).join(",")
            : ""
        }
        data-mode={draftConfig?.mode ?? ""}
        data-plan-enabled={draftConfig?.planEnabled ?? false}
        data-usage-used={usage?.contextWindow?.usedTokens ?? ""}
        data-usage-max={usage?.contextWindow?.maxTokens ?? ""}
        data-usage-tone={usageTone}
        className="hidden"
      />
      {/* A Highspeed card locks the model the moment it activates; do not wait for the motion handoff to finish before hiding, or the usage ring briefly flashes. */}
      {!modelLocked ? (
        <ChatContextUsage
          codingPlanUsageRemaining={codingPlanUsageRemaining}
          taskUsage={taskUsage}
          startPlanBalance={contextStartPlanBalance}
          selectedProvider={displayProvider}
          intl={intl}
          locale={locale}
          onSendCompressionCommand={onSendCompressionCommand}
          compressionDisabled={disabled || recoveryPending}
        />
      ) : null}
      {/* The speed-wheel model is decided by the current card and the model picker is unavailable then, so the indicator takes precedence over the picker loading state. */}
      {highspeedPresented && highspeedModel ? (
        <HighspeedModelIndicator
          model={highspeedModel}
          originalModel={modelTriggerDisplay.fullLabel}
          sweepActive={highspeedSweepActive}
          animateEntrance={highspeedEntranceAnimated}
        />
      ) : modelSelectionState.status === "error" && modelSelectionReload ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-ui-sm text-destructive"
          onClick={modelSelectionReload}
        >
          {intl.formatMessage({ id: "chat.toolbar.model.loadFailedRetry" })}
        </Button>
      ) : modelSelectionState.status === "unavailable" ? (
        <span className="px-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id:
              modelSelectionState.reason === "remote-waiting"
                ? "chat.toolbar.model.remoteWaiting"
                : "chat.toolbar.model.targetMissing",
          })}
        </span>
      ) : modelMenuVisible &&
        !providerSourcesLoading &&
        planGroups.length === 0 &&
        !connectionSwitch.pending ? (
        // 空配置是正常状态；直接复用 Provider 设置入口，不展开无名称、无模型的菜单。
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-ui-sm"
          data-testid="chat-model-select-trigger"
          onClick={handleOpenModelProviderSettings}
        >
          {manageModelsLabel}
        </Button>
      ) : modelMenuVisible ? (
        <ModelConfigSelect
          key={workspaceIdentity?.trim() || workspacePath}
          modelGroups={modelSelectGroups}
          contentAlign="center"
          normalizedValue={normalizedModelValue}
          triggerLabel={modelTriggerDisplay.modelLabel}
          composerOptions={composerOptions}
          showManageModelsAction={showManageModelsAction}
          manageModelsLabel={manageModelsLabel}
          onManageModels={handleOpenModelProviderSettings}
          lockReasonMessage={intl.formatMessage({
            id: modelLocked
              ? "chat.highspeed.modelLocked"
              : "chat.toolbar.modelSwitch.lockedByRunningTask",
          })}
          isItemLocked={isModelOptionLocked}
          onValueChange={handleModelValueChange}
          disabled={
            disabled ||
            recoveryPending ||
            modelLocked ||
            (modelSelectionState.status !== "ready" &&
              !(modelSelectionState.status === "loading" && modelSelectionState.catalog))
          }
          tooltipTitle={modelTriggerDisplay.fullLabel}
          shortcutLabel={modelShortcutLabel}
          triggerRef={modelTriggerRef}
          open={!modelLocked && activeConfigPicker === "model"}
          onOpenChange={handleModelPickerOpenChange}
          openRequestKey={modelMenuOpenRequestKey}
          labelVisibilityClassName="hidden @sm/composer:inline-flex"
          indicatorClassName="block group-data-[composer-model-icon=true]/toolbar:hidden"
          triggerLabelClassName="block min-w-0 text-left group-data-[composer-model-icon=true]/toolbar:hidden [&>span]:max-w-full [&>span>span]:block [&>span>span]:truncate"
          triggerClassName="composer-model-trigger group-data-[composer-model-icon=true]/toolbar:px-1.5 group-data-[composer-model-icon=true]/toolbar:justify-center"
          triggerIconClassName="hidden group-data-[composer-model-icon=true]/toolbar:inline-flex"
          focusSelectorOnClose={V4_COMPOSER_INPUT_SELECTOR}
          providerSubmenuClassName={providerSubmenuClassName}
        />
      ) : null}
      {highspeedPresented && highspeedExpiresAt !== undefined ? (
        <HighspeedCountdown expiresAt={highspeedExpiresAt} />
      ) : null}
      {thoughtOption && (modelLocked || highspeedPresented) ? (
        <ThoughtLevelCycleControl
          composerCollapsePriority={3}
          labelVisibilityClassName="inline-flex"
          indicatorClassName="block"
          triggerClassName={cn(highspeedPresented && "text-ui-caption")}
          option={thoughtOption}
          onValueChange={handleThoughtValueChange}
          disabled={disabled || recoveryPending}
          intl={intl}
          provider={displayProvider}
          shortcutLabel={thoughtShortcutLabel}
          triggerRef={thoughtTriggerRef}
          open={activeConfigPicker === "thought"}
          onOpenChange={handleThoughtPickerOpenChange}
          restoreFocusSelector={V4_COMPOSER_INPUT_SELECTOR}
        />
      ) : null}
    </>
  );
}

export const V4ComposerModelControls = memo(V4ComposerModelControlsImpl);
import { isApiKeyAccess } from "@zcode/provider";
