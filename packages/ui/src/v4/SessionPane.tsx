import { resolveSelectionSideInheritedModel } from "@/lib/selectionSideInheritedModel.js";
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import type { SessionCreateSource } from "@zcode/shared";
import { reportSessionCreate } from "@/lib/sessionCreateTelemetry.js";
import { getLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
import { BotGroupDeliveryProvider } from "@/v4/BotGroupDeliveryAction.js";
/* oxlint-disable eslint(max-lines) -- SessionPane is the single-pane vertical command orchestration boundary (subscribe/send/stop/fork/edit/retry/queue/slash), at the same granularity as the old ChatView. HEAD already exceeds the limit (693 counted lines); splitting command groups would break the closure discipline around dispatchCommand/snapshotRef. */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Hand } from "lucide-react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  buildCustomSupplierKey,
  TID_CHAT_EMPTY,
  TID_V4_SESSION_PANE,
  testId,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import type {
  ConversationShareAccessMode,
  GitChangeSourceId,
  HighspeedCardSnapshot,
  HighspeedPrepareTurnResult,
  GitRepositorySummary,
  ModelSelection,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type {
  AttachmentRef,
  CommandAck,
  CommandEnvelope,
  CommandType,
  ConversationSnapshot,
  ConversationRowTarget,
  SessionErrorInfo,
  SessionModelTransition,
  UserInputRow,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { PluginUiSessionProvider } from "@/plugin-ui/index.js";
import {
  getConversationShareErrorDetails,
  resolveConversationShareFallbackIssueCode,
  resolveConversationSharePublishErrorMessageId,
  sanitizeConversationShareWarnings,
} from "@/lib/conversationShareError.js";
import { localizeConversationShareUrl } from "@zcode/shared";
import type {
  ConversationShareAllowedArtifact,
  ConversationShareTurnPreflightResult,
  ImportedConversationShare,
} from "@zcode/services";
import { useCodingPlanBillingDiscountFromService } from "@/CodingPlanBillingDiscount.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { CHAT_ERROR_RESUME_MESSAGE } from "@/lib/chatErrorResume.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import { WORKSPACE_FILE_DRAG_MIME } from "@/lib/workspaceFileDrag.js";
import { buildChatSessionScrollMemoryKey } from "@/lib/chatSessionScrollMemory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useServices } from "@/hooks/useServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { browserGlobalNoticeStore } from "@/global-notice/globalNoticeStore.js";
import {
  HIGHSPEED_SEND_WAIT_BUDGET_MS,
  prepareHighspeedSendContext,
  readRegularTpsWithinSendBudget,
  resolveHighspeedPrepareSelection,
  type HighspeedSendContext,
  type HighspeedTurnPreparer,
} from "@/highspeed/highspeedSend.js";
import {
  calculateHighspeedSavedDurationFromMetrics,
  readHighspeedRegularTpsFromHealth,
} from "@/highspeed/highspeedSavedTime.js";
import { buildHighspeedShareNotice } from "@/highspeed/highspeedShare.js";
import {
  claimHighspeedCardAutoShare,
  claimHighspeedHealthyAttempt,
  completeHighspeedTurn,
  discardHighspeedTurn,
  getHighspeedCardTps,
  getHighspeedTurnVersion,
  hydrateHighspeedTurnsFromTranscript,
  listExpiredHighspeedCardsAwaitingTps,
  listHighspeedCardAutoShareCandidates,
  listHighspeedTurnsAwaitingMetricsPersistence,
  listPendingHighspeedTurns,
  markHighspeedCardAutoShared,
  markHighspeedTurnMetricsPersisted,
  recordHighspeedTurn,
  resolveNextHighspeedAutoShareAt,
  setHighspeedCardTps,
  subscribeHighspeedTurns,
} from "@/highspeed/highspeedTurnStore.js";
import { claimHighspeedFallbackToast } from "@/highspeed/highspeedToastClaims.js";
import {
  collectHighspeedCardShareBlockers,
  listHighspeedCardsAwaitingAutoShare,
} from "@/highspeed/highspeedShareDiagnostics.js";
import type { SessionOpenTrigger } from "@/lib/sessionOpenArmsTelemetry.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { resolveWorkflowResumeHandler } from "@/v4/workflowResumeGate.js";
import {
  workflowSessionModelOf,
  type WorkflowRunSettingsChange,
} from "@/components/workflow-timeline/workflowRunSettings.js";
import { useWorkflowRunJournalSummaries } from "@/hooks/useWorkflowRunJournalSummaries.js";
import { usePlanIdentitySnapshot } from "@/hooks/usePlanIdentitySnapshot.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { buildGenUiModelContext } from "@zcode/shared/gen-ui";
import { useWorkspaceHomePath } from "@/hooks/useWorkspaceHomePath.js";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { captureComposerRecentSubmission } from "@/lib/composerRecent.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import { resolveEntitledAccountProviderAccess } from "@/lib/accountProviderAccess.js";
import { getProviderSettingsSnapshot } from "@/lib/providerSettingsSnapshot.js";
import {
  buildDraftCreateConfigPayload,
  useDraftConfigControl,
} from "@/v4/composer/useDraftConfigControl.js";
import type { ModelSelectionSource } from "@/v4/composer/V4ComposerToolbar.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import {
  createComposerSubmissionConfig,
  type ComposerSubmissionConfig,
} from "@/v4/composer/composerSubmissionConfig.js";
import { useDraftSessionPrewarm } from "@/v4/composer/useDraftSessionPrewarm.js";
import { projectSessionConfigToTaskConfigOptions } from "@/v4/composer/sessionConfigTaskCache.js";
import { useDraftRuntimeRebuildGate } from "@/v4/composer/useDraftRuntimeRebuildGate.js";
import { useDraftModelReadinessGate } from "@/v4/composer/useDraftModelReadinessGate.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
  DEFAULT_CONVERSATION_SHARE_DOCK_STATE,
  getConversationShareDockState,
  getConversationShareSelectedProductTurnIds,
  getConversationShareSelectedRowIds,
  useConversationShareSelectionStore,
  type ConversationShareDisplayWarnings,
} from "@/store/conversationShareSelectionStore.js";
import type { GroupedDraftTaskState } from "@/store/zcodeSessionStoreTypes.js";
import {
  ConversationComposer,
  type ComposerRestoreRequest,
  type ConversationComposerSendOptions,
  type ConversationComposerSendResult,
} from "@/v4/ConversationComposer.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { shouldIgnoreEscapeForStopGeneration } from "@/v4/composer/escapeStop.js";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";
import { ConversationDraftSuggestedPromptsContainer } from "@/v4/ConversationDraftSuggestedPromptsContainer.js";
import { ConversationHeader, type PaneWorkspaceBadge } from "@/v4/ConversationHeader.js";
import { ConversationQueuePanel } from "@/v4/ConversationQueuePanel.js";
import { projectPendingGuideQueue } from "@/v4/pendingGuideProjection.js";
import { ConversationQuotaBanner } from "@/v4/ConversationQuotaBanner.js";
import { PendingCommandRecoveryBanner } from "@/v4/PendingCommandRecoveryBanner.js";
import { WorkspaceHookPendingBanner } from "@/v4/WorkspaceHookPendingBanner.js";
import { ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";
import { SessionSubscriptionErrorPanel } from "@/v4/SessionSubscriptionErrorPanel.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { ConversationShareImportNotice } from "@/v4/ConversationShareImportNotice.js";
import { ConversationShareConfirmationDock } from "@/v4/ConversationShareConfirmationDock.js";
import { ConversationShareSuccessDock } from "@/v4/ConversationShareSuccessDock.js";
import {
  ConversationShareSelectionDock,
  type ConversationShareSelectionPreflightState,
} from "@/v4/ConversationShareSelectionDock.js";
import { ConversationShareSelectionPanel } from "@/v4/ConversationShareSelectionPanel.js";
import { ConversationShareSelectionReopenTab } from "@/v4/ConversationShareSelectionReopenTab.js";
import { ConversationShareSelectionScrim } from "@/v4/ConversationShareSelectionScrim.js";
import {
  buildConversationSharePreflightCacheEntries,
  conversationSharePreflightCacheKey,
  conversationShareTurnFingerprint,
  dedupeConversationShareIssues,
  aggregateConversationShareBlockingIssues,
  getMissingConversationSharePreflightTurnIds,
} from "@/v4/conversationSharePreflightCache.js";
import { ConversationBottomDockTransition } from "@/v4/ConversationBottomDockTransition.js";
import { ensureConversationShareAttempt } from "@/v4/conversationShareAttempt.js";
import { useConversationShareSelectionOutsideDismiss } from "@/v4/useConversationShareSelectionOutsideDismiss.js";
import {
  resolveConversationSelectionTooltipEnabled,
  resolveConversationShareBackgroundScrollLocked,
  resolveConversationShareSelectionPanelVisible,
} from "@/v4/conversationShareModePolicy.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { buildConversationTurnNavigatorItems } from "@/v4/conversationTurnNavigatorHelpers.js";
import { SessionPluginReferenceIconBoundary } from "@/v4/SessionPluginReferenceIconProvider.js";
import {
  resolveConversationStatusPanelVariant,
  shouldUseConversationStatusPanelInlineLayout,
} from "@/v4/conversationLayout.js";
import {
  buildConversationStatusPanelModel,
  resolveSoleRunningWorkflowRunTarget,
} from "@/v4/conversationStatusPanelModel.js";
import type { ConversationStatusPanelWorkflowRunTarget } from "@/v4/conversationStatusPanelModel.js";
import {
  buildWorkflowRunByRunId,
  buildWorkflowSaveCandidatesByRunId,
  buildWorkflowRunByToolCallId,
  buildWorkflowRunPendingQuestionsByRunId,
  buildWorkflowFillGraphByRunId,
  buildWorkflowGraphByToolCallId,
} from "@/v4/workflowRunCardJoin.js";
import { buildWorkflowDraftByToolCallId } from "@/v4/workflowDraftJoin.js";
import {
  WORKFLOW_RUN_DIRECTORY_LIMIT,
  countEndedWorkflowRuns,
  workflowRunDirectoryRefreshKey,
} from "@/v4/workflowRunDirectoryModel.js";
import {
  hasOlderRows,
  shouldAutoLoadIncompleteLeadingTurn,
} from "@/v4/conversationProjectionStore.js";
import type {
  ConversationFileChangesRequestOptions,
  ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import {
  advanceAssistantPreviewPptxAutoOpenGate,
  createAssistantPreviewPptxAutoOpenGateState,
  resolveLatestCompletedAssistantPreviewTurn,
  type AssistantPreviewPptxAutoOpenTarget,
} from "@/v4/assistantPreviewPptxAutoOpen.js";
import {
  hasPluginReferenceUserRows,
  isSessionPluginCatalogReady,
} from "@/v4/pluginReferenceIconProjection.js";
import { shouldResyncForStaleAuthority } from "@/v4/staleAuthorityRecovery.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { createConfigCommandBarrier } from "@/v4/configCommandBarrier.js";
import { recordV4CommandAck } from "@/v4/commandAckObservability.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";
import {
  useScopedConversationTelemetryForegroundEnabled,
  useScopedConversationTelemetrySupervisor,
} from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { resolveSendAckSettlement } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { useSessionSubscriptionErrorTelemetry } from "@/v4/telemetry/useSessionSubscriptionErrorTelemetry.js";
import { useSessionOpenArmsTelemetry } from "@/v4/telemetry/useSessionOpenArmsTelemetry.js";
import {
  parseV4VisibleSlashCommand,
  parseSelectionSideSlashCommand,
  v4QueuedCommandText,
  type V4VisibleSlashCommand,
} from "@/v4/slashCommands.js";
import { useSlashCommands } from "@/hooks/useSlashCommands.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { usePendingCommandRecovery } from "@/v4/usePendingCommandRecovery.js";
import { useV4SessionQuotaBanner } from "@/v4/useV4SessionQuotaBanner.js";
import { resolveMcpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";
import { shouldFocusTimelineAfterComposerSend } from "@/v4/promptScrollFocusPolicy.js";
import {
  hasChatLoadingBlockingActiveWork,
  hasChatLoadingBlockingInteraction,
} from "@/v4/chatLoadingVisibility.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { isProviderNotReadyError } from "@/lib/chatPrepareError.js";
import { useOptionalCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useIsMobileTextInputViewport } from "@/lib/mobileTextInput.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenWorkflowRunSideTabRequest,
  OpenWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenWorkflowActorSessionSideTabRequest,
  OpenWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  OpenWorkflowWorkspaceSideTabRequest,
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenSelectionSideChatRequest,
  SyncSubagentSessionTabsRequest,
  OpenSubagentSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import {
  buildSelectionSideChatKey,
  clearSelectionSideChat,
  createSelectionSideChat,
  isSelectionSideChatBlocked,
  registerSelectionSideChatOpener,
  setSelectionSideChatBlocked,
  subscribeSelectionSideChatRuntime,
} from "@/lib/selectionSideChatRuntime.js";
import {
  normalizeSlashCommandValue,
  shouldOfferSideSlashCommand,
  type AppSlashCommand,
} from "@/slashCommandHelpers.js";
import {
  clearConversationSelectionReferenceScope,
  dispatchConversationSelectionAdd,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";

export interface SessionPaneProps {
  paneId: string;
  sessionId: string | null;
  /** Low-cardinality open entry point, supplied by the pane host; the default exists only for compatibility with older callers. */
  openTrigger?: SessionOpenTrigger;
  rootSessionId?: string;
  /** Read-only views such as subagent details on the right: hide composer/input and do not send inline editing commands. */
  readOnly?: boolean;
  /** Explicit exception for read-only views: allow file summaries to restore the workspace, but do not enable session editing. */
  allowWorkspaceFileRewind?: boolean;
  /** Selection side chat: keep the regular composer/tools, but hide and disable edit/retry/fork/goal. */
  selectionSideChat?: boolean;
  /** Text-selection actions from the main session are sent only to the currently active auxiliary child in the Side Pane. */
  activeSelectionSideChatSessionId?: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  /** Prompt-template telemetry currently covers only Desktop; Web/mobile remote control keeps the UI behavior without emitting this event. */
  isDesktop?: boolean;
  compactForRemoteControl?: boolean;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string) => void;
  /** deleteSession: after deleting the current session, return to a draft (the shell starts a new draft). */
  onSessionDeleted?: () => void;
  /** When a hidden side-pane child no longer exists, the host removes the corresponding tab. */
  onSelectionSideChatUnavailable?: () => void;
  /**
   * Focus layer: global shortcuts (Esc to stop) and add-to-chat events are routed only to the
   * focused pane. Defaults to true for single-pane consumers (V4ChatPane).
   */
  focused?: boolean;
  /**
   * Whether the pane is actually visible. Non-focused panes in split view still pass true; hidden force-mounted side-pane tabs pass false.
   * Affects foreground UI telemetry only, not live subscriptions or background /event/report.
   */
  telemetryVisible?: boolean;
  /** Split a new draft pane to the right (the host omits this when the leaf limit is reached). */
  onSplitRight?: () => void;
  /** Split a new draft pane below. */
  onSplitDown?: () => void;
  /** Close this pane (supplied only for non-primary panes; closing a pane does not stop the session). */
  onClosePane?: () => void;
  /** Ownership badge for a cross-workspace pane (supplied when the pane workspace differs from the shell's current workspace). */
  workspaceBadge?: PaneWorkspaceBadge;
  /**
   * contextHeader above the draft composer (m5: workspace switch menu + Git branch).
   * Constructed and supplied by app-shell (depends on shell capabilities such as workspaceTabs / remote-connection callbacks);
   * omitted for non-primary panes (workspace switching is a shell-level action).
   */
  draftComposerHeader?: ReactNode;
  /** The main draft exposes its drop controller to the app-shell title bar; other panes consume it only on their own surface. */
  onDropTargetControllerChange?: (controller: ConversationDropTargetController | null) => void;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  summaryPanelVariantOverride?: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
  onSyncSubagentSessionTabs?: (request: SyncSubagentSessionTabsRequest) => void;
  onOpenSelectionSideChat?: (request: OpenSelectionSideChatRequest) => void;
  onOpenPlanDetail?: (request: OpenScopedPlanDetailSideTabRequest) => void;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** Artifact chip in a notification row → full-size viewer tab. */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
  /** Subagent pill on a tool card → transcript tab; uses the same host handler as the subagent row on the details page. */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** Script pill on a tool card → script transcript tab; uses the same host handler as the script row on the details page. */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}

const MOBILE_PLAN_INTERACTION_RECONCILE_DELAY_MS = 500;
function createSessionErrorKey(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): string {
  return [
    sessionId?.trim() || "draft",
    error.code,
    error.at,
    error.message,
    error.traceId ?? "",
    error.detail ?? "",
  ].join(":");
}

const EMPTY_SUBAGENT_PROJECTION: NonNullable<ConversationSnapshot["subagents"]> = {
  revision: 0,
  childSessionIds: [],
  running: [],
  endedTotal: 0,
};

const MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES = 20;

function toComposerUiError(
  sessionId: string | null | undefined,
  error: SessionErrorInfo,
): ZCodeUiError {
  return {
    code: error.code,
    message: error.message,
    ...(error.traceId ? { traceId: error.traceId } : {}),
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.underlyingErrorMessage
      ? { underlyingErrorMessage: error.underlyingErrorMessage }
      : {}),
    ...(error.underlyingErrorDetail ? { underlyingErrorDetail: error.underlyingErrorDetail } : {}),
    // The V4 snapshot already includes the security attribution; pass it through here so errors are grouped by that attribution.
    ...(error.attribution ? { attribution: error.attribution } : {}),
    ...(sessionId ? { taskId: sessionId } : {}),
  };
}

function submissionConfigFromCommand(
  type: CommandType,
  payload: Record<string, unknown>,
): ComposerSubmissionConfig | null {
  const candidate =
    type === "createSession"
      ? (payload.firstInput as Record<string, unknown> | undefined)
      : type === "sendText" || type === "sendGoalCommand"
        ? payload
        : undefined;
  if (!candidate?.modelSelection || !candidate.mode) return null;
  return {
    modelSelection: candidate.modelSelection as ComposerSubmissionConfig["modelSelection"],
    mode: candidate.mode as ComposerSubmissionConfig["mode"],
    planEnabled:
      typeof candidate.planEnabled === "boolean"
        ? candidate.planEnabled
        : candidate.mode === "plan",
  };
}

function isConversationFileDrag(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types);
  return (
    types.includes("Files") ||
    types.includes(WORKSPACE_FILE_DRAG_MIME) ||
    Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")
  );
}

export interface QueuedComposerRestoreTarget {
  baseRevision: number;
  queueItemId: string;
  sourceCommandId: string;
  inputKind: "sendText" | "sendGoalCommand";
  text: string;
  attachments: readonly AttachmentRef[];
  config?: ComposerRestoreRequest["config"];
}

export function resolveQueuedComposerRestore(
  snapshot: ConversationSnapshot,
  queueItemId: string,
): QueuedComposerRestoreTarget | null {
  const item = snapshot.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
  if (!item || item.kind === "compact") return null;
  const config = {
    ...(item.mode ? { mode: item.mode } : {}),
    ...(typeof item.planEnabled === "boolean" ? { planEnabled: item.planEnabled } : {}),
    ...(item.modelSelection ? { modelSelection: item.modelSelection } : {}),
  };
  return {
    baseRevision: snapshot.revision,
    queueItemId,
    sourceCommandId: item.sourceCommandId,
    inputKind: item.kind,
    text: v4QueuedCommandText(item.kind, item.text),
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

export function shouldRestoreQueuedComposerFromAck(status: CommandAck["status"]): boolean {
  return status === "accepted" || status === "duplicate";
}

/**
 * Pane binding at the Highspeed send origin (spec §9.2): freeze it synchronously when sending is
 * triggered, then use it after prepare returns to decide whether the pane still shows this send's
 * Task/draft and whether to display the card here and register its activation.
 */
interface HighspeedPaneOrigin {
  sessionId: string | null;
  /** Pane binding generation at send start; for a draft's first send, detects whether the pane left the draft. */
  paneBinding: number;
  draftId: string | null;
}

/**
 * Single-pane vertical slice: subscribe → render rows → composer send/stop (06-ui §SessionPane).
 *
 * React performance (vercel-react-best-practices):
 * - Leaf components (Header/Timeline/QueuePanel/InputControls/Composer/GoalBanner) are all memoized;
 * - Every callback uses useCallback and **does not depend on the frequently changing snapshot**—snapshot/composer text is read through refs,
 *   keeping callback references stable during streaming and avoiding needless rerenders when new functions reach memoized children;
 * - Local input state for model forms lives in the corresponding child component, so typing does not rerender the whole pane.
 */
export function SessionPane({
  paneId,
  sessionId,
  openTrigger,
  rootSessionId,
  readOnly = false,
  allowWorkspaceFileRewind = false,
  selectionSideChat = false,
  activeSelectionSideChatSessionId = null,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  isDesktop = false,
  compactForRemoteControl = false,
  provider,
  onSessionCreated,
  onSelectionSideChatUnavailable,
  focused = true,
  telemetryVisible = true,
  onSplitRight,
  onSplitDown,
  onClosePane,
  workspaceBadge,
  draftComposerHeader,
  onDropTargetControllerChange,
  gitSummary,
  gitDirtyFileCount,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeTaskChangeSummary,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  onRefreshGit,
  onOpenGitReview,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onOpenCodeViewer,
  onAutoOpenAssistantPptx,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenBackgroundBash,
  onOpenSubagentDirectory,
  onSyncSubagentSessionTabs,
  onOpenSelectionSideChat,
  onOpenPlanDetail,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  onOpenWorkflowRunDirectory,
  onOpenWorkflowActorSession,
  onOpenWorkflowWorkspace,
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
}: SessionPaneProps) {
  const {
    layer,
    sendCommand,
    attachmentPut,
    attachmentRead,
    attachmentReadRange,
    onRuntimeRestart,
    onRuntimeLifecycle,
    fileChanges,
    fileRewindPreview,
  } = useV4Conversation();
  const platform = useOptionalPlatform();
  const {
    conversationShareService,
    highspeedCardService,
    modelSelectionService,
    usageStatsService,
    zcodeSessionService,
    zcodeTaskService,
  } = useServices();
  const { intl, locale } = useZCodeIntl();
  const slashCommands = useSlashCommands(workspacePath, workspaceIdentity);
  const baseWorkspaceServices = useBaseWorkspaceServices();
  const workspaceHomePath = useWorkspaceHomePath({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
  });
  // SessionPane is already inside the target Workspace's ServiceProvider, so subscribe directly to that Host Service;
  // do not parse workspace/remote routing again in the presentation component.
  const conversationTelemetry = useScopedConversationTelemetrySupervisor({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const conversationTelemetryForegroundEnabled = useScopedConversationTelemetryForegroundEnabled({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const conversationTelemetryForegroundOwnerRef = useRef<object>({});
  useEffect(() => {
    if (
      !conversationTelemetry ||
      !conversationTelemetryForegroundEnabled ||
      !telemetryVisible ||
      !sessionId
    ) {
      return undefined;
    }
    return conversationTelemetry.attachForeground(
      conversationTelemetryForegroundOwnerRef.current,
      sessionId,
    );
  }, [conversationTelemetry, conversationTelemetryForegroundEnabled, sessionId, telemetryVisible]);
  const [lease, setLease] = useState<SessionLease | null>(null);
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;
  const newlyCreatedSessionIdRef = useRef<string | null>(null);
  const shareDraft = useConversationShareSelectionStore((storeState) =>
    sessionId ? storeState.drafts[sessionId] : undefined,
  );
  const shareDockState = useConversationShareSelectionStore((storeState) =>
    sessionId ? storeState.dockStates[sessionId] : undefined,
  );
  const shareDock = shareDockState ?? DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
  const shareTitle = shareDock.title ?? snapshot?.meta.title?.trim() ?? sessionId ?? "";
  const shareDisclosureAccepted = shareDock.disclosureAccepted;
  const sharePublishing = shareDock.publishing;
  const shareProgress = shareDock.progress;
  const shareCompletedArtifacts = shareDock.completedArtifacts;
  const shareTotalArtifacts = shareDock.totalArtifacts;
  const publishedShareUrl = shareDock.publishedShareUrl;
  const shareError = shareDock.error;
  const shareWarnings = shareDock.warnings;
  const shareActive = shareDraft?.scope === "partial";
  const shareInSelectionStage = shareActive && (shareDraft?.stage ?? "selection") === "selection";
  // The overlay, selection panel, and background scroll lock must share one decision, or the overlay will remain after the panel closes.
  const shareSelectionPanelVisible = resolveConversationShareSelectionPanelVisible({
    partialShareActive: shareActive,
    stage: shareDraft?.stage ?? "selection",
    view: shareDraft?.view,
  });
  const finishShare = useConversationShareSelectionStore((value) => value.finishSelection);
  const updateShareDockState = useConversationShareSelectionStore((value) => value.updateDockState);
  const goToShareConfiguration = useConversationShareSelectionStore(
    (value) => value.goToConfiguration,
  );
  const goToShareSelection = useConversationShareSelectionStore((value) => value.goToSelection);
  const syncAvailableTurns = useConversationShareSelectionStore(
    (value) => value.syncAvailableTurns,
  );
  const toggleShareRow = useConversationShareSelectionStore((value) => value.toggleRow);
  const deselectShareProductTurn = useConversationShareSelectionStore(
    (value) => value.deselectProductTurn,
  );
  const setAllShareRowsSelected = useConversationShareSelectionStore(
    (value) => value.setAllRowsSelected,
  );
  const setShareAccessMode = useConversationShareSelectionStore((value) => value.setAccessMode);
  const showShareTimeline = useConversationShareSelectionStore((value) => value.showTimeline);
  const showShareSelectionPanel = useConversationShareSelectionStore(
    (value) => value.showSelectionPanel,
  );
  const dismissShareSelectionPanel = useCallback(() => {
    if (sessionId) showShareTimeline(sessionId);
  }, [sessionId, showShareTimeline]);
  useConversationShareSelectionOutsideDismiss({
    enabled: shareSelectionPanelVisible,
    onDismiss: dismissShareSelectionPanel,
  });
  const shareRenderUnits = useMemo(
    () => buildConversationTurnRenderUnits(snapshot?.rows.window ?? []),
    [snapshot?.rows.window],
  );
  const shareItems = useMemo(
    () =>
      buildConversationTurnNavigatorItems(shareRenderUnits, {
        assistantEmptyPreview: intl.formatMessage({
          id: "chat.turnNavigator.emptyAssistant",
        }),
        assistantRunningPreview: intl.formatMessage({
          id: "chat.turnNavigator.runningAssistant",
        }),
        userFallbackPreview: intl.formatMessage({
          id: "chat.turnNavigator.userFallback",
        }),
      }),
    [intl, shareRenderUnits],
  );
  const eligibleShareItems = useMemo(
    () => shareItems.filter((item) => !item.isRunning),
    [shareItems],
  );
  const eligibleShareRowIds = useMemo(
    () => new Set(eligibleShareItems.map((item) => item.rowId)),
    [eligibleShareItems],
  );
  useEffect(() => {
    if (!sessionId || !shareActive) return;
    const rowsById = new Map((snapshot?.rows.window ?? []).map((row) => [row.rowId, row]));
    syncAvailableTurns(
      sessionId,
      eligibleShareItems.flatMap((item) => {
        const productTurnId = rowsById.get(item.rowId)?.productTurnId;
        return productTurnId ? [{ rowId: item.rowId, productTurnId }] : [];
      }),
    );
  }, [eligibleShareItems, sessionId, shareActive, snapshot?.rows.window, syncAvailableTurns]);
  const selectedShareRowIds = useMemo(
    () =>
      new Set(
        sessionId
          ? getConversationShareSelectedRowIds(
              useConversationShareSelectionStore.getState(),
              sessionId,
            )
          : [],
      ),
    [sessionId, shareDraft],
  );
  const selectedShareProductTurnIds = useMemo(
    () =>
      sessionId
        ? getConversationShareSelectedProductTurnIds(
            useConversationShareSelectionStore.getState(),
            sessionId,
          )
        : [],
    [sessionId, shareDraft],
  );
  const sharePreflightMetaRef = useRef<{
    revision: number;
    logEpoch: string;
    capabilitiesFingerprint: string;
    supportedArtifactTypes: readonly ConversationShareAllowedArtifact[];
  }>({
    revision: 0,
    logEpoch: "",
    capabilitiesFingerprint: "",
    supportedArtifactTypes: [],
  });
  const [sharePreflightVersion, setSharePreflightVersion] = useState(0);
  const selectedShareTurnFingerprints = useMemo(
    () =>
      new Map(
        selectedShareProductTurnIds.map((productTurnId) => [
          productTurnId,
          conversationShareTurnFingerprint(
            snapshot?.rows.window ?? [],
            productTurnId,
            workspacePath,
            {
              workspaceKey: workspaceIdentity?.trim() || workspacePath,
              remoteSessionId: remoteSessionId ?? "",
              sessionId: sessionId ?? "",
              revision: snapshot?.revision,
              logEpoch: snapshot?.logEpoch,
              capabilitiesFingerprint: sharePreflightMetaRef.current.capabilitiesFingerprint,
            },
          ),
        ]),
      ),
    [
      remoteSessionId,
      selectedShareProductTurnIds,
      sessionId,
      sharePreflightVersion,
      snapshot?.logEpoch,
      snapshot?.revision,
      snapshot?.rows.window,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const eligibleShareProductTurnIds = useMemo(() => {
    const rowsById = new Map((snapshot?.rows.window ?? []).map((row) => [row.rowId, row]));
    const seen = new Set<string>();
    return eligibleShareItems.flatMap((item) => {
      const productTurnId = rowsById.get(item.rowId)?.productTurnId;
      if (!productTurnId || seen.has(productTurnId)) return [];
      seen.add(productTurnId);
      return [productTurnId];
    });
  }, [eligibleShareItems, snapshot?.rows.window]);
  const sharePreflightCacheRef = useRef(new Map<string, ConversationShareTurnPreflightResult>());
  // Transport failures are cached as blockers by turn, so changing the selection alone cannot trigger the RPC again;
  // clear the cache and retry when the retry token changes, so a transient network issue does not leave the user stuck in the selection stage.
  const [sharePreflightRetryToken, setSharePreflightRetryToken] = useState(0);
  const sharePreflightScopeKey = `${workspaceIdentity?.trim() || workspacePath}\u0000${remoteSessionId ?? ""}\u0000${sessionId ?? ""}`;
  const sharePreflightScopeKeyRef = useRef<string | null>(null);
  const sharePreflightCacheKey = useCallback(
    (productTurnId: string) =>
      conversationSharePreflightCacheKey(sharePreflightScopeKey, productTurnId),
    [sharePreflightScopeKey],
  );
  const retrySharePreflight = useCallback(() => {
    for (const productTurnId of selectedShareProductTurnIds) {
      sharePreflightCacheRef.current.delete(sharePreflightCacheKey(productTurnId));
    }
    setSharePreflightRetryToken((token) => token + 1);
    setSharePreflightVersion((version) => version + 1);
  }, [selectedShareProductTurnIds, sharePreflightCacheKey]);
  const shareHydratedSessionRef = useRef<string | null>(null);
  const sharePreflight = useMemo<ConversationShareSelectionPreflightState>(() => {
    if (!shareInSelectionStage || !sessionId || compactForRemoteControl) {
      return { status: "idle" };
    }
    if (selectedShareProductTurnIds.length === 0) {
      return { status: "idle" };
    }
    const entries = selectedShareProductTurnIds.map((productTurnId) => {
      const entry = sharePreflightCacheRef.current.get(sharePreflightCacheKey(productTurnId));
      return entry?.turnFingerprint === selectedShareTurnFingerprints.get(productTurnId)
        ? entry
        : undefined;
    });
    if (entries.some((entry) => entry === undefined)) {
      return { status: "checking" };
    }
    const resolvedEntries = entries.filter(
      (entry): entry is ConversationShareTurnPreflightResult => entry !== undefined,
    );
    return {
      status: "ready",
      ...sharePreflightMetaRef.current,
      blockingIssues: aggregateConversationShareBlockingIssues(resolvedEntries),
      skippableWarnings: dedupeConversationShareIssues(
        resolvedEntries.flatMap((entry) => entry.skippableWarnings),
      ),
      deferredIssues: dedupeConversationShareIssues(
        resolvedEntries.flatMap((entry) => entry.deferredIssues),
      ),
      turnResults: resolvedEntries,
    };
  }, [
    compactForRemoteControl,
    sessionId,
    selectedShareProductTurnIds,
    selectedShareTurnFingerprints,
    sharePreflightCacheKey,
    shareInSelectionStage,
    sharePreflightVersion,
  ]);

  useEffect(() => {
    if (sharePreflightScopeKeyRef.current === sharePreflightScopeKey) return;
    sharePreflightScopeKeyRef.current = sharePreflightScopeKey;
    sharePreflightCacheRef.current.clear();
    sharePreflightMetaRef.current = {
      revision: 0,
      logEpoch: "",
      capabilitiesFingerprint: "",
      supportedArtifactTypes: [],
    };
    setSharePreflightVersion((version) => version + 1);
  }, [sharePreflightScopeKey]);

  useEffect(() => {
    if (shareActive && sessionId) return;
    sharePreflightCacheRef.current.clear();
    sharePreflightMetaRef.current = {
      revision: 0,
      logEpoch: "",
      capabilitiesFingerprint: "",
      supportedArtifactTypes: [],
    };
    setSharePreflightVersion((version) => version + 1);
  }, [sessionId, shareActive]);

  useEffect(() => {
    // Preflight results are cached per turn: selecting/deselecting only re-aggregates the current selection.
    // An RPC runs only on first selection or when the turn fingerprint changes; publish still performs its own authoritative stat/read/SHA checks, so this cache is not final evidence.
    const requestScopeKey = sharePreflightScopeKey;
    if (
      !shareInSelectionStage ||
      !sessionId ||
      compactForRemoteControl ||
      selectedShareProductTurnIds.length === 0
    ) {
      return undefined;
    }
    const missingProductTurnIds = getMissingConversationSharePreflightTurnIds(
      sharePreflightScopeKey,
      selectedShareProductTurnIds,
      sharePreflightCacheRef.current,
      selectedShareTurnFingerprints,
    );
    if (missingProductTurnIds.length === 0) return undefined;
    const requestRows = snapshot?.rows.window ?? [];
    const timer = setTimeout(() => {
      void conversationShareService
        .preflight({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId,
          selection: {
            kind: "productTurns",
            productTurnIds: missingProductTurnIds,
          },
        })
        .then(
          (result) => {
            if (!shareActive || requestScopeKey !== sharePreflightScopeKeyRef.current) return;
            sharePreflightMetaRef.current = {
              revision: result.revision,
              logEpoch: result.logEpoch,
              capabilitiesFingerprint: result.capabilitiesFingerprint,
              supportedArtifactTypes: result.supportedArtifactTypes,
            };
            // In dev, the host process does not restart when services are rebuilt, so older hosts may
            // return no turnResults. Calling .map directly would throw and be reported downstream as a server preflight failure.
            // Item-level fallback logic is centralized in the helper; see conversationSharePreflightCache.
            const resultTurnFingerprints = new Map(
              missingProductTurnIds.map((productTurnId) => [
                productTurnId,
                conversationShareTurnFingerprint(requestRows, productTurnId, workspacePath, {
                  workspaceKey: workspaceIdentity?.trim() || workspacePath,
                  remoteSessionId: remoteSessionId ?? "",
                  sessionId,
                  revision: result.revision,
                  logEpoch: result.logEpoch,
                  capabilitiesFingerprint: result.capabilitiesFingerprint,
                }),
              ]),
            );
            const entries = buildConversationSharePreflightCacheEntries(
              result,
              missingProductTurnIds,
              resultTurnFingerprints,
            );
            for (const entry of entries) {
              sharePreflightCacheRef.current.set(
                sharePreflightCacheKey(entry.productTurnId),
                entry,
              );
            }
            setSharePreflightVersion((version) => version + 1);
          },
          (error: unknown) => {
            // Only RPC or actual server failures reach this branch. Rendering errors in the success
            // callback are handled by the catch below and are not misreported as preflight results.
            // Use unknown when issues are missing; the log is the only diagnostic clue.
            const details = getConversationShareErrorDetails(error);
            logger.warn("[v4-share] 会话分享预检失败", {
              sessionId,
              turnCount: missingProductTurnIds.length,
              name: details.name,
              kind: details.kind,
              reasonCode: details.reasonCode,
              issueCount: details.issueCount ?? 0,
              message: error instanceof Error ? error.message : String(error),
            });
            if (!shareActive || requestScopeKey !== sharePreflightScopeKeyRef.current) return;
            const issues =
              details.issues && details.issues.length > 0
                ? details.issues
                : [
                    {
                      code: resolveConversationShareFallbackIssueCode(details),
                      scope: "transport" as const,
                    },
                  ];
            for (const productTurnId of missingProductTurnIds) {
              sharePreflightCacheRef.current.set(sharePreflightCacheKey(productTurnId), {
                productTurnId,
                turnFingerprint: selectedShareTurnFingerprints.get(productTurnId),
                blockingIssues: issues,
                skippableWarnings: [],
                deferredIssues: [],
              });
            }
            setSharePreflightVersion((version) => version + 1);
          },
        )
        .catch((error: unknown) => {
          // Rendering errors are logged but not written to the preflight cache, so a frontend bug is not shown as a share failure.
          logger.error("[v4-share] 会话分享预检结果处理异常", {
            sessionId,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [
    compactForRemoteControl,
    conversationShareService,
    remoteSessionId,
    selectedShareProductTurnIds,
    selectedShareTurnFingerprints,
    sharePreflightCacheKey,
    sharePreflightRetryToken,
    sharePreflightScopeKey,
    sessionId,
    shareActive,
    shareInSelectionStage,
    snapshot?.rows.window,
    workspaceIdentity,
    workspacePath,
  ]);
  const sessionLeaseReady = lease?.sessionId === sessionId;
  const shouldMeasureExistingSessionOpen =
    sessionLeaseReady && newlyCreatedSessionIdRef.current !== sessionId;
  useSessionOpenArmsTelemetry({
    sessionId,
    snapshot,
    openTiming: sessionLeaseReady ? state.openTiming : undefined,
    rendererTiming: sessionLeaseReady ? state.rendererTiming : undefined,
    openKind: sessionLeaseReady ? lease?.openKind : undefined,
    openTrigger,
    startedAt: sessionLeaseReady ? lease?.startedAt : undefined,
    status: state.status,
    lastError: state.lastError,
    enabled: shouldMeasureExistingSessionOpen,
    readOnly,
    reporter: platform,
  });
  useEffect(() => {
    const newlyCreatedSessionId = newlyCreatedSessionIdRef.current;
    if (newlyCreatedSessionId !== null && newlyCreatedSessionId !== sessionId) {
      newlyCreatedSessionIdRef.current = null;
    }
  }, [sessionId]);
  const mobilePlanInteractionReconcileTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  useEffect(() => {
    const timers = mobilePlanInteractionReconcileTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [lease, sessionId]);
  const handleMobilePlanInteractionAccepted = useCallback(
    (interactionId: string) => {
      if (!compactForRemoteControl || !lease) return;
      const timers = mobilePlanInteractionReconcileTimersRef.current;
      if (timers.has(interactionId)) return;
      const timer = setTimeout(() => {
        timers.delete(interactionId);
        const authoritativeSnapshot = lease.store.getState().snapshot;
        const stillPending = authoritativeSnapshot?.pendingInteractions.some(
          (interaction) => interaction.interactionId === interactionId,
        );
        if (!stillPending) return;
        // Root cause: the mobile Plan receipt ACK and replayable cleanup use separate async paths;
        // if the cleanup frame is lost, the old interaction remains forever. Reuse the existing
        // same-sub recovery only when authoritative pending state remains after the grace period;
        // do not hide the dialog locally or affect desktop continuous behavior.
        logger.warn("[v4-pane] 手机 Plan ACK 后 pending 未收口，触发权威恢复", {
          interactionId,
          sessionId,
          workspaceKey: workspaceIdentity?.trim() || workspacePath,
        });
        lease.store.recoverFromStaleAuthority();
      }, MOBILE_PLAN_INTERACTION_RECONCILE_DELAY_MS);
      timers.set(interactionId, timer);
    },
    [compactForRemoteControl, lease, sessionId, workspaceIdentity, workspacePath],
  );
  const pluginReferenceIconsEnabled =
    isSessionPluginCatalogReady(state.status, sessionId, snapshot?.sessionId) &&
    hasPluginReferenceUserRows(snapshot?.rows.window ?? []);
  // The send_result completion signal is when the user message is actually rendered in conversation history.
  // z-code does not render optimistically; the bubble appears only after the projection includes a userInput row, so ACK accepted is not completion.
  // Use useEffect instead of a store subscription: effects run after the DOM commit, when the bubble is on screen.
  useEffect(() => {
    const rows = snapshot?.rows.window;
    if (!rows || rows.length === 0) return;
    // Do not inspect only the last userInput: a background result row may be appended immediately after it.
    // Looking only at the tail would miss the user's row and report render_timeout. The supervisor filters
    // against its pending-render map in O(1), so historical backfill or rows from a reloaded session do not trigger it.
    for (const row of rows) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        conversationTelemetry?.notifyUserInputRendered(row.sourceCommandId);
      }
    }
  }, [conversationTelemetry, snapshot]);
  const fileChangesRequestCache = useMemo(
    () => new Map<string, Promise<V4ConversationFileChangesResult>>(),
    [fileChanges, sessionId, snapshot?.logEpoch],
  );
  const [dismissedErrorKeys, setDismissedErrorKeys] = useState<readonly string[]>([]);
  const [sendSubmissionError, setSendSubmissionError] = useState<ZCodeUiError | null>(null);
  const [paneLocalSummaryPanelVariantOverride, setPaneLocalSummaryPanelVariantOverride] =
    useState<ChatViewSummaryPanelVariant | null>(null);
  const [terminalSectionOpen, setTerminalSectionOpen] = useState(false);
  const [agentSectionOpen, setAgentSectionOpen] = useState(false);
  const [workflowSectionOpen, setWorkflowSectionOpen] = useState(false);
  const [dropTargetController, setDropTargetController] =
    useState<ConversationDropTargetController | null>(null);
  const handleDropTargetControllerChange = useCallback(
    (controller: ConversationDropTargetController | null) => {
      setDropTargetController(controller);
      onDropTargetControllerChange?.(controller);
    },
    [onDropTargetControllerChange],
  );
  const readOnlyDropTargetController = useMemo<ConversationDropTargetController>(
    () => ({
      active: false,
      kind: null,
      onDragLeave: () => {},
      onDragOver: (event) => {
        if (!isConversationFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "none";
      },
      onDrop: (event) => {
        if (!isConversationFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
      },
    }),
    [],
  );
  const effectiveDropTargetController = readOnly
    ? readOnlyDropTargetController
    : dropTargetController;
  const isMobileTextInputViewport = useIsMobileTextInputViewport();

  // Pass the latest values through refs so stable callbacks do not depend on frequently changing snapshots/text.
  const snapshotRef = useRef<ConversationSnapshot | null>(snapshot);
  const sessionIdRef = useRef(sessionId);
  const [activeHighspeedCard, setActiveHighspeedCard] = useState<HighspeedCardSnapshot | null>(
    null,
  );
  // One-shot activation request: only the send path registers a new draw hit; the composer consumes it after locking the entry mode.
  const [highspeedActivationCardId, setHighspeedActivationCardId] = useState<string | null>(null);
  // Identity of the most recently displayed card in this pane; used to tell restores and reused-card sends from new hits.
  const presentedHighspeedCardIdRef = useRef<string | null>(null);
  const highspeedMetricsInFlightRef = useRef(new Set<string>());
  const highspeedTurnVersion = useSyncExternalStore(
    subscribeHighspeedTurns,
    getHighspeedTurnVersion,
    getHighspeedTurnVersion,
  );
  const [highspeedAutoShareClock, refreshHighspeedAutoShareClock] = useState(0);
  const dispatchCommandRef = useRef<
    | ((
        type: CommandType,
        payload: Record<string, unknown>,
        targetSessionId: string | null,
        baseRevision?: number,
        baseLogEpoch?: string,
      ) => Promise<CommandAck>)
    | null
  >(null);
  const autoOpenedAssistantPptxKeysRef = useRef<Set<string>>(new Set());
  const assistantPreviewPptxGateRef = useRef(createAssistantPreviewPptxAutoOpenGateState());
  const [assistantPreviewPptxAutoOpenTarget, setAssistantPreviewPptxAutoOpenTarget] =
    useState<AssistantPreviewPptxAutoOpenTarget | null>(null);
  const autoLoadIncompleteTurnCursorRef = useRef<string | null>(null);
  snapshotRef.current = snapshot;
  sessionIdRef.current = sessionId;
  const handleAutoOpenAssistantPptx = useCallback(
    (request: AssistantPreviewCardsAutoOpenRequest) => {
      if (!onAutoOpenAssistantPptx || request.sources.length === 0) return;
      if (autoOpenedAssistantPptxKeysRef.current.has(request.key)) return;
      autoOpenedAssistantPptxKeysRef.current.add(request.key);
      onAutoOpenAssistantPptx(request);
    },
    [onAutoOpenAssistantPptx],
  );
  const composerDraftStateRef = useRef({ hasContent: false, busy: false });
  const [queueEditOperation, setQueueEditOperation] = useState<{
    queueItemId: string;
    sessionId: string;
    workspaceKey: string;
  } | null>(null);
  const queueEditOperationRef = useRef(queueEditOperation);
  queueEditOperationRef.current = queueEditOperation;
  const [composerRestoreRequest, setComposerRestoreRequest] =
    useState<ComposerRestoreRequest | null>(null);
  const nextComposerRestoreRequestIdRef = useRef(1);
  const timelineScrollToBottomRef = useRef<(() => void) | null>(null);
  const timelineScrollToQueryRef = useRef<
    ((target: { unitIndex: number; rowId: number }) => void) | null
  >(null);
  const conversationLayoutContainerRef = useRef<HTMLDivElement>(null);
  const hasExternalSummaryPanelVariantControl = Boolean(onSummaryPanelVariantOverrideChange);
  const effectiveSummaryPanelVariantOverride = hasExternalSummaryPanelVariantControl
    ? (summaryPanelVariantOverride ?? null)
    : paneLocalSummaryPanelVariantOverride;
  const handleSummaryPanelVariantChange = useCallback(
    (variant: ChatViewSummaryPanelVariant | null) => {
      if (onSummaryPanelVariantOverrideChange) {
        onSummaryPanelVariantOverrideChange(variant);
        return;
      }
      setPaneLocalSummaryPanelVariantOverride(variant);
    },
    [onSummaryPanelVariantOverrideChange],
  );

  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // Increment the generation whenever the pane rebinds to a Task/workspace: after A → B → A, the
  // sessionId may match while the generation differs. Like sessionIdRef, sync during render so
  // send callbacks can read the latest binding across awaits.
  const paneBindingKey = `${workspaceKey}\u0000${sessionId ?? ""}`;
  const paneBindingRef = useRef({ key: paneBindingKey, generation: 0 });
  if (paneBindingRef.current.key !== paneBindingKey) {
    paneBindingRef.current = {
      key: paneBindingKey,
      generation: paneBindingRef.current.generation + 1,
    };
  }
  useEffect(() => {
    let disposed = false;
    if (!sessionId) {
      setActiveHighspeedCard(null);
      return () => undefined;
    }
    void highspeedCardService
      .getSnapshot()
      .then((serviceSnapshot) => {
        if (disposed) return;
        const card = serviceSnapshot.card;
        const now = Date.now();
        if (!card || card.taskId !== sessionId || card.expiresAt <= now) {
          setActiveHighspeedCard(null);
          return;
        }
        presentedHighspeedCardIdRef.current = card.cardId;
        setActiveHighspeedCard(card);
      })
      .catch((error) => {
        if (disposed) return;
        setActiveHighspeedCard(null);
        logger.warn("[highspeed] 读取卡片状态失败，输入框按普通状态展示", {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      });
    return () => {
      disposed = true;
    };
  }, [highspeedCardService, sessionId]);
  useEffect(() => {
    if (!activeHighspeedCard) return;
    const cardId = activeHighspeedCard.cardId;
    const expiresAt = activeHighspeedCard.expiresAt;
    // Root cause: card cleanup relied on a one-shot setTimeout. When the window was hidden or the
    // screen slept, Chromium froze the page and timers stopped. After wake, overdue timeouts could
    // remain pending, while the composer countdown recovered immediately because its interval
    // rereads Date.now() each second. This left a zombie card with a 00:00:00 countdown and an
    // accelerated input; only the next message's prepareTurn could clear it. Recompute from the
    // wall clock on return: clear expired cards immediately and reschedule the remaining duration
    // for active cards (same clock compensation as the share timer below; spec §9.2/§9.3).
    const clearIfExpired = () => {
      if (Date.now() < expiresAt) return false;
      setActiveHighspeedCard((current) => (current?.cardId === cardId ? null : current));
      return true;
    };
    if (clearIfExpired()) return;
    let timer: number | undefined;
    const arm = () => {
      window.clearTimeout(timer);
      // Root cause: setTimeout uses a monotonic clock, but expiration checks use wall-clock
      // Date.now(); millisecond drift or an NTP adjustment can fire the timer before wall-clock
      // expiry. If we only check and do not reschedule, acceleration never ends while the window stays open.
      timer = window.setTimeout(() => {
        if (!clearIfExpired()) arm();
      }, expiresAt - Date.now());
    };
    arm();
    const refreshFromWindowWake = () => {
      if (document.visibilityState === "hidden") return;
      if (!clearIfExpired()) arm();
    };
    document.addEventListener("visibilitychange", refreshFromWindowWake);
    window.addEventListener("focus", refreshFromWindowWake);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshFromWindowWake);
      window.removeEventListener("focus", refreshFromWindowWake);
    };
  }, [activeHighspeedCard]);
  useEffect(() => {
    if (!sessionId) return;
    const nextAutoShareAt = resolveNextHighspeedAutoShareAt(sessionId);
    if (nextAutoShareAt === null) return;
    const delayMs = Math.max(0, nextAutoShareAt - Date.now()) + 20;
    // Root cause: the old share timer was tied to Turn completion and published the card as soon
    // as the first Turn ended. The full card's expiresAt now wakes aggregation; if a Turn is still
    // running at expiry, wait for its completion event to trigger aggregation again.
    const timer = window.setTimeout(
      () => refreshHighspeedAutoShareClock((revision) => revision + 1),
      delayMs,
    );
    return () => window.clearTimeout(timer);
  }, [highspeedTurnVersion, sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    // Root cause (2026-08-31): expiration wakeups depended on renderer setTimeout. When the window
    // was hidden or occluded, Chromium froze the page and timers stopped. Per-card TPS sampling and
    // completion persistence stalled, leaving the footer view button disabled until another user
    // message changed the store version (violating spec 9.3: expiration boundaries trigger rerenders
    // from the session clock without requiring another message). Reconcile the clock on window
    // return; every aggregation entry point has claim/idempotency guards, so duplicate triggers are safe.
    const refreshFromWindowWake = () => {
      if (document.visibilityState === "hidden") return;
      refreshHighspeedAutoShareClock((revision) => revision + 1);
    };
    document.addEventListener("visibilitychange", refreshFromWindowWake);
    window.addEventListener("focus", refreshFromWindowWake);
    return () => {
      document.removeEventListener("visibilitychange", refreshFromWindowWake);
      window.removeEventListener("focus", refreshFromWindowWake);
    };
  }, [refreshHighspeedAutoShareClock, sessionId]);
  useEffect(() => {
    if (!sessionId || snapshot?.sessionId !== sessionId) return;
    const terminalStates = new Set(["completedSuccess", "completedInterrupted", "failed"]);
    hydrateHighspeedTurnsFromTranscript(
      sessionId,
      snapshot.rows.window
        .filter((row): row is UserInputRow => row.kind === "userInput")
        .map((row) => ({
          sourceCommandId: row.sourceCommandId,
          createdAt: row.createdAt,
          highspeed: row.highspeed,
        })),
    );
    const pendingTurns = listPendingHighspeedTurns(sessionId);
    for (const record of pendingTurns) {
      const userRow = snapshot.rows.window.find(
        (row) => row.kind === "userInput" && row.sourceCommandId === record.sourceCommandId,
      );
      if (userRow?.kind === "userInput" && !userRow.highspeed) {
        // Root cause: the Highspeed queue records metrics at admission ACK. If the card expires
        // before actual promotion, the CLI removes the Highspeed intent and uses the original
        // model. Revoke the pre-registration using the authoritative user row so regular output is
        // not incorrectly included in Highspeed sharing.
        discardHighspeedTurn(record.sourceCommandId);
        continue;
      }
      const header = snapshot.rows.window.find(
        (row) => row.kind === "turnHeader" && row.sourceCommandId === record.sourceCommandId,
      );
      // Diagnostic (debug; triggered frequently by snapshots): names the blocker when completed-turn metrics do not settle.
      if (!header || header.kind !== "turnHeader") {
        logger.debug("[highspeed] turn 统计未完成：rows.window 中缺少 turnHeader", {
          sourceCommandId: record.sourceCommandId,
        });
        continue;
      }
      if (!terminalStates.has(header.state) || header.outputTokens === undefined) {
        logger.debug("[highspeed] turn 统计未完成：turnHeader 非终态或无 outputTokens", {
          sourceCommandId: record.sourceCommandId,
          state: header.state,
          hasOutputTokens: header.outputTokens !== undefined,
        });
        continue;
      }
      const durationMs = Math.max(
        0,
        header.activeMs ?? (header.endedAt !== undefined ? header.endedAt - header.startedAt : 0),
      );
      completeHighspeedTurn({
        sourceCommandId: record.sourceCommandId,
        outputTokens: header.outputTokens,
        durationMs,
        ...(header.modelDurationMs !== undefined
          ? { modelDurationMs: header.modelDurationMs }
          : {}),
        ...(header.toolDurationMs !== undefined ? { toolDurationMs: header.toolDurationMs } : {}),
        ...(header.otherDurationMs !== undefined
          ? { otherDurationMs: header.otherDurationMs }
          : {}),
      });
    }

    const autoShareNow = Date.now();
    for (const card of listExpiredHighspeedCardsAwaitingTps(sessionId, autoShareNow)) {
      if (!claimHighspeedHealthyAttempt(card.cardId, card.allTurnsCompleted)) {
        // Diagnostic (debug): check once at card expiry and once after completion; if no TPS is available after both attempts, sharing will stall.
        logger.debug("[highspeed] 卡级 healthy 查询机会已用尽，仍无有效 TPS", {
          cardId: card.cardId,
          allTurnsCompleted: card.allTurnsCompleted,
        });
        continue;
      }
      void highspeedCardService
        .healthy(card.cardId)
        .then((usage) => {
          if (usage.completionTokens <= 0 || usage.durationSeconds <= 0) {
            logger.warn("[highspeed] 卡级 healthy 未返回有效 TPS，本轮完成后再补查", {
              cardId: card.cardId,
              completionTokens: usage.completionTokens,
              durationSeconds: usage.durationSeconds,
            });
            return;
          }
          setHighspeedCardTps(card.cardId, usage.completionTokens / usage.durationSeconds);
        })
        .catch((error) => {
          logger.warn("[highspeed] 卡级 healthy 查询失败，本轮完成后再补查", {
            cardId: card.cardId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    const dispatch = dispatchCommandRef.current;
    if (dispatch) {
      for (const record of listHighspeedTurnsAwaitingMetricsPersistence(sessionId)) {
        if (!record.metrics || highspeedMetricsInFlightRef.current.has(record.sourceCommandId)) {
          continue;
        }
        const userRow = snapshot.rows.window.find(
          (row): row is UserInputRow =>
            row.kind === "userInput" && row.sourceCommandId === record.sourceCommandId,
        );
        const regularTps = record.card.regularTps ?? userRow?.highspeed?.regularTps;
        const highspeedTps = getHighspeedCardTps(record.card.cardId);
        // Diagnostic (debug): missing persistence prerequisites can leave this turn waiting forever; a silent skip would make it hard to locate.
        if (!userRow || !userRow.entityId || !regularTps || !highspeedTps) {
          logger.debug("[highspeed] 完成态持久化前置缺失，本轮暂不派发", {
            sourceCommandId: record.sourceCommandId,
            userRowInWindow: userRow !== undefined && userRow !== null,
            hasEntityId: Boolean(userRow?.entityId),
            hasRegularTps: Boolean(regularTps),
            hasCardTps: Boolean(highspeedTps),
          });
          continue;
        }
        const savedDurationMs = calculateHighspeedSavedDurationFromMetrics(
          record.metrics,
          regularTps,
          highspeedTps,
        );
        highspeedMetricsInFlightRef.current.add(record.sourceCommandId);
        let metricsPersisted = false;
        void dispatch(
          "setHighspeedMetrics",
          {
            target: { rowId: userRow.rowId, entityId: userRow.entityId },
            regularTps,
            outputTokens: record.metrics.outputTokens,
            durationMs: record.metrics.durationMs,
            highspeedTps,
            savedDurationMs,
            ...(record.metrics.modelDurationMs !== undefined
              ? { modelDurationMs: record.metrics.modelDurationMs }
              : {}),
            ...(record.metrics.toolDurationMs !== undefined
              ? { toolDurationMs: record.metrics.toolDurationMs }
              : {}),
            ...(record.metrics.otherDurationMs !== undefined
              ? { otherDurationMs: record.metrics.otherDurationMs }
              : {}),
          },
          sessionId,
          snapshot.revision,
          snapshot.logEpoch,
        )
          .then((ack) => {
            if (ack.status !== "accepted" && ack.status !== "duplicate") {
              logger.warn("[highspeed] 完成态统计持久化被拒绝", {
                reasonCode: ack.reasonCode,
                sourceCommandId: record.sourceCommandId,
                status: ack.status,
              });
              return;
            }
            markHighspeedTurnMetricsPersisted(record.sourceCommandId, savedDurationMs);
            metricsPersisted = true;
          })
          .catch((error) => {
            logger.warn("[highspeed] 完成态统计持久化失败", {
              error: error instanceof Error ? error.message : String(error),
              sourceCommandId: record.sourceCommandId,
            });
          })
          .finally(() => {
            highspeedMetricsInFlightRef.current.delete(record.sourceCommandId);
            // Root cause: React may consume the store update from the persistence ACK before in-flight
            // cleanup, causing this pass to be skipped. Wake it explicitly after a successful ACK so
            // another prompt is not required.
            if (metricsPersisted) {
              refreshHighspeedAutoShareClock((revision) => revision + 1);
            }
          });
      }
    }

    for (const candidate of listHighspeedCardAutoShareCandidates(sessionId)) {
      if (candidate.expiresAt > autoShareNow) continue;
      // Root cause: clearing only in-flight state after failure lets later snapshots retry automatic sharing until they hit 429.
      if (!claimHighspeedCardAutoShare(candidate.cardId, autoShareNow)) continue;
      // Share cards are now generated on the client; no backend share request is made. Publish local metrics in the lower-left corner after expiry.
      browserGlobalNoticeStore?.publish(
        buildHighspeedShareNotice({ cardId: candidate.cardId, metrics: candidate.metrics }),
      );
      markHighspeedCardAutoShared(candidate.cardId);
    }

    // Diagnostic (debug; triggered frequently by snapshots): log the blocker when a card has
    // expired, has never been considered for sharing, and is not a candidate. On 2026-08-31 the
    // lower-left share card stayed stale for 36 minutes without logs because all these gates silently skipped it.
    for (const cardId of listHighspeedCardsAwaitingAutoShare(sessionId, autoShareNow)) {
      const blockers = collectHighspeedCardShareBlockers(cardId);
      if (blockers.length > 0) {
        logger.debug("[highspeed] 卡已到期但未进入自动分享，阻塞原因", {
          cardId,
          blockers,
        });
      }
    }
  }, [highspeedAutoShareClock, highspeedCardService, highspeedTurnVersion, sessionId, snapshot]);
  const workspaceConfigOptions = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).configOptions,
  );
  useEffect(() => {
    if (
      !sessionId ||
      snapshot?.sessionId !== sessionId ||
      !snapshot.config.provider.trim() ||
      !snapshot.config.model.trim() ||
      !workspaceConfigOptions?.length
    ) {
      return;
    }
    // Bug cause: V4 session configuration exists only in ConversationSnapshot, while the legacy task config bucket stays empty.
    // When a user creates a task from a custom-model session, startDraft can inherit only the workspace default model.
    // Overlay the authoritative configuration onto the full catalog and cache it per task; do not change the session or workspace source of truth.
    useZCodeSessionStore
      .getState()
      .setTaskConfigOptions(
        workspacePath,
        sessionId,
        projectSessionConfigToTaskConfigOptions(workspaceConfigOptions, snapshot.config),
        workspaceIdentity,
      );
  }, [
    sessionId,
    snapshot?.config.mode,
    snapshot?.config.model,
    snapshot?.config.provider,
    snapshot?.config.thought,
    snapshot?.sessionId,
    workspaceConfigOptions,
    workspaceIdentity,
    workspacePath,
  ]);
  useEffect(() => {
    const scopeKey = `${workspaceKey}\u0000${sessionId ?? "draft"}`;
    const enabled = Boolean(onAutoOpenAssistantPptx && focused && sessionId);
    const result = advanceAssistantPreviewPptxAutoOpenGate(assistantPreviewPptxGateRef.current, {
      enabled,
      scopeKey,
      logEpoch: snapshot?.logEpoch,
      phase: snapshot?.control.phase,
      completedTurn: resolveLatestCompletedAssistantPreviewTurn(snapshot?.rows.window ?? []),
    });
    assistantPreviewPptxGateRef.current = result.state;
    if (result.target !== undefined) {
      setAssistantPreviewPptxAutoOpenTarget(result.target);
    }
  }, [
    focused,
    onAutoOpenAssistantPptx,
    sessionId,
    snapshot?.control.phase,
    snapshot?.logEpoch,
    snapshot?.rows.window,
    workspaceKey,
  ]);
  useEffect(() => {
    // Avoid carrying an old key across workspace/session/logEpoch changes. Keys are already isolated;
    // this cleanup only marks the lifecycle boundary and prevents the Set growing with session count in a long-lived workbench.
    autoOpenedAssistantPptxKeysRef.current.clear();
  }, [sessionId, snapshot?.logEpoch, workspaceKey]);
  const composerTextInsertRequest = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).composerTextInsertRequest,
  );
  const timelineBottomRequest = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).timelineBottomRequest,
  );
  const draftRuntimeInvalidationVersion = useZCodeSessionStore(
    (store) =>
      store.getWorkspaceState(workspacePath, workspaceIdentity).draftRuntimeInvalidationVersion,
  );
  const handleExternalTextInsertApplied = useCallback(
    (requestId: number) => {
      useZCodeSessionStore
        .getState()
        .clearComposerTextInsertRequest(workspacePath, requestId, workspaceIdentity);
    },
    [workspaceIdentity, workspacePath],
  );
  const composerBindingRef = useRef({ sessionId, workspaceKey });
  composerBindingRef.current = { sessionId, workspaceKey };
  const configCommandBarrier = useMemo(() => createConfigCommandBarrier(), []);
  // Soft review does not block interaction; do not hide Composer or disable selection quoting.
  const blockingInteractionId =
    snapshot?.pendingInteractions.find(
      (interaction) => interaction.payload.kind !== "workspaceHookReview",
    )?.interactionId ?? null;
  const selectionSideChatKey = sessionId
    ? buildSelectionSideChatKey(workspaceKey, sessionId)
    : null;
  const selectionSideActionBlocked = useSyncExternalStore(
    subscribeSelectionSideChatRuntime,
    () =>
      activeSelectionSideChatSessionId
        ? isSelectionSideChatBlocked(activeSelectionSideChatSessionId)
        : false,
    () => false,
  );
  const timelineScrollMemoryKey = buildChatSessionScrollMemoryKey({
    workspacePath,
    workspaceIdentity,
    paneId,
    sessionId,
    taskId: null,
  });

  const {
    agentStartupAllowed: draftAgentStartupAllowed,
    error: draftModelReadinessError,
    dismissError: dismissDraftModelReadinessError,
    ensureReadyForSend: ensureDraftModelReadyForSend,
    markProviderNotReady: markDraftProviderNotReady,
  } = useDraftModelReadinessGate({
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    modelSelectionService,
  });

  // Composer stores the renderer intent for the next Submission; the prewarm session only carries draft warm-up state.
  const {
    composerDraft,
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    replaceComposerDraft,
    updateComposerContent,
  } = useDraftConfigControl({
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig: snapshot?.sessionId === sessionId ? snapshot.config : null,
    agentStartupAllowed: draftAgentStartupAllowed,
    modelSelectionService,
  });
  useEffect(() => {
    if (!sessionId || snapshot?.sessionId !== sessionId) return;
    const now = Date.now();
    for (const row of snapshot.rows.window) {
      if (
        row.kind !== "userInput" ||
        !row.sourceCommandId ||
        row.highspeed?.fallbackAt === undefined
      ) {
        continue;
      }
      if (
        focused &&
        now - row.highspeed.fallbackAt >= -5_000 &&
        now - row.highspeed.fallbackAt <= 15_000 &&
        claimHighspeedFallbackToast(row.sourceCommandId)
      ) {
        // Show separate messages for an expired card and an unavailable acceleration service; older data has no fallbackReason, so treat it as an expired card.
        toast(
          intl.formatMessage({
            id:
              row.highspeed.fallbackReason === "highspeed_request_failed"
                ? "chat.highspeed.requestFailedFallback"
                : "chat.highspeed.cardExpiredFallback",
          }),
        );
      }
    }
  }, [focused, intl, sessionId, snapshot]);
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const draftModelSelectionRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (sessionId !== null) {
      draftModelSelectionRevisionRef.current = null;
      return;
    }
    const revision = modelSelectionView?.revision ?? null;
    const previousRevision = draftModelSelectionRevisionRef.current;
    draftModelSelectionRevisionRef.current = revision;
    if (
      revision === null ||
      previousRevision === null ||
      revision === previousRevision ||
      (draftConfigRef.current.provider && draftConfigRef.current.model)
    ) {
      return;
    }
    // Bug cause: during cold start, the normal Provider can prewarm the draft before the Account Overlay enters
    // Selection View. The old prewarm session froze an early fallback, leaving the Renderer on an old model
    // even after the latest View included the current account connection. An unsent draft with no explicit
    // selection is not execution state; rebuild it when the View updates. Explicit selections and real sessions stay frozen.
    useZCodeSessionStore.getState().invalidateDraftRuntime(workspacePath, workspaceIdentity);
  }, [draftConfigRef, modelSelectionView?.revision, sessionId, workspaceIdentity, workspacePath]);
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView);
  const createSubmissionFromComposer = useCallback(
    () => createComposerSubmissionConfig(draftConfigRef.current, modelSelectionView),
    [draftConfigRef, modelSelectionView],
  );
  const composerSubmissionReady = useMemo(
    () => createComposerSubmissionConfig(draftConfig, modelSelectionView) !== null,
    [draftConfig, modelSelectionView],
  );
  const codingPlanUpgradeDialog = useOptionalCodingPlanUpgradeDialog();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const billingDiscount = useCodingPlanBillingDiscountFromService(
    baseWorkspaceServices.codingPlanSubscriptionService,
  );
  const promoteGroupedDraftTask = useZCodeSessionStore((state) => state.promoteGroupedDraftTask);
  // The first-send commandId already exists at accepted and is also the completion message_id; no need to wait for the reply to finish.
  const reportDraftCreated = useCallback(
    (createdSessionId: string, source: SessionCreateSource, messageId: string) => {
      void reportSessionCreate(platform, {
        sessionId: createdSessionId,
        messageId,
        workspacePath,
        workspaceIdentity,
        remoteSessionId,
        source,
        clientKind: isDesktop ? "desktop" : compactForRemoteControl ? "mobile" : "web",
      });
    },
    [
      platform,
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      isDesktop,
      compactForRemoteControl,
    ],
  );
  const handleDraftSessionCreated = useCallback(
    (
      createdSessionId: string,
      groupedDraftTask: GroupedDraftTaskState | null | undefined,
      createSource?: SessionCreateSource,
      messageId?: string,
    ) => {
      if (messageId) {
        reportDraftCreated(
          createdSessionId,
          createSource ?? (groupedDraftTask ? "group" : "session"),
          messageId,
        );
      }
      // Bug cause: session-open telemetry measures existing sessions, but draft first-send used to pass
      // the newly created/promoted sessionId to the same hook. The prewarm lease retained the draft's startedAt
      // and empty snapshot timing, incorrectly counting hours of idle time as total/react. Mark this pane's
      // first binding at creation; clear the marker when leaving so a later explicit open measures normally.
      newlyCreatedSessionIdRef.current = createdSessionId;
      promoteComposerDraft(createdSessionId);
      // Only the accepted boundary for draft create/promote can inherit grouped placement.
      // Forks and normal task navigation still reuse onSessionCreated without changing group ordering for existing tasks.
      if (groupedDraftTask) {
        promoteGroupedDraftTask(
          workspacePath,
          createdSessionId,
          groupedDraftTask,
          workspaceIdentity,
        );
        logger.debug("[v4-pane] grouped draft 已显式提升", {
          createdSessionId,
          draftId: groupedDraftTask.draftId,
        });
      }
      onSessionCreated?.(createdSessionId);
    },
    [
      reportDraftCreated,
      onSessionCreated,
      promoteComposerDraft,
      promoteGroupedDraftTask,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const { settings: sharedSettings } = useSettings();
  const readPlanIdentitySnapshot = usePlanIdentitySnapshot(
    sharedSettings?.providerFamilyDomain,
    sharedSettings?.providerFamilyDomain
      ? sharedSettings.providerFamilyConnectionSelections?.[sharedSettings.providerFamilyDomain]
      : undefined,
    baseWorkspaceServices.usageStatsService,
  );
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const messageStreamShowReasoning = sharedSettings?.messageStreamShowReasoning ?? true;
  const messageStreamShowTodos = sharedSettings?.messageStreamShowTodos ?? false;
  const toolGroupingExploreEnabled = sharedSettings?.toolGroupingExploreEnabled ?? true;
  const toolGroupingTerminalEnabled = sharedSettings?.toolGroupingTerminalEnabled ?? true;
  const toolGroupingChangesEnabled = sharedSettings?.toolGroupingChangesEnabled ?? false;
  const snapshotSessionId = snapshot?.sessionId ?? null;
  const snapshotFollowupMode = snapshot?.config.followupMode ?? null;
  const snapshotRevision = snapshot?.revision ?? null;

  // Match PermissionDialog's injection pattern: the host reads theme/codePreviewSettings from the store
  // and passes them through a stable rowContext reference to memoized row components (MessageResponse/ToolCallBlocks).
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  // Tier 1 fork navigation: clicking a child's forkNotice switches this pane in place to the parent session,
  // reusing the same onSessionCreated path as fork completion (primary→setActiveTaskId, split view→bindPaneSession).
  // rowId is reserved for Tier 2 precise scrolling; forkNotice.parentRowId is currently a 0 placeholder, so ignore it here.
  const handleNavigateToRow = useCallback(
    (targetSessionId: string, _rowId: number) => {
      if (!targetSessionId || targetSessionId === sessionId) {
        return;
      }
      onSessionCreated?.(targetSessionId);
    },
    [onSessionCreated, sessionId],
  );
  const dispatchCommand = useCallback(
    async (
      type: CommandType,
      payload: Record<string, unknown>,
      targetSessionId: string | null,
      baseRevision?: number,
      baseLogEpoch?: string,
      telemetrySeed?: ConversationPromptTelemetrySeed,
      highspeedCard?: HighspeedCardSnapshot,
      onEnvelopeCreated?: (envelope: CommandEnvelope) => void,
      sessionCreateSource?: SessionCreateSource,
      recentSubmissionOverride?: ComposerSubmissionConfig | null,
    ): Promise<CommandAck> => {
      const submission = submissionConfigFromCommand(type, payload);
      // The accelerated-turn payload's modelSelection is replaced by the hidden acceleration
      // Provider in execution materials. Recent records the user's original Composer selection
      // (the model seed for a new-task draft), so accelerated turns must receive the submission
      // frozen before sending from the caller (spec §5.1). captureComposerRecentSubmission also
      // has a fallback guard for acceleration identity.
      const recentSubmission = recentSubmissionOverride ?? submission;
      const acceptRecent = recentSubmission
        ? captureComposerRecentSubmission(workspacePath, recentSubmission, workspaceIdentity)
        : undefined;
      const acceptSelection =
        submission && (sessionId === null || targetSessionId === sessionId)
          ? captureAcceptedModelSelection(submission.modelSelection)
          : undefined;
      const envelope = createCommandEnvelope({
        type,
        sessionId: targetSessionId,
        payload: payload as never,
        ...(baseRevision !== undefined ? { baseRevision } : {}),
        ...(baseLogEpoch ? { baseLogEpoch } : {}),
      });
      onEnvelopeCreated?.(envelope);
      // Record this before the first request so there is a queryable clue after a transport error or renderer refresh.
      const groupedDraftTask =
        type === "createSession"
          ? useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
              .groupedDraftTask
          : null;
      pendingCommandRegistry.record(
        envelope,
        type === "createSession"
          ? {
              workspace: {
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
              },
              ...(groupedDraftTask ? { groupedDraftTask } : {}),
              sessionCreateSource:
                sessionCreateSource ??
                useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
                  .draftCreateSource,
            }
          : undefined,
      );
      if (lease?.store && type !== "createSession") {
        lease.store.markCommandPending({
          commandId: envelope.commandId,
          type: envelope.type,
          issuedAt: envelope.issuedAt,
        });
      }
      let ack: CommandAck;
      try {
        if (telemetrySeed?.localTtft && !workspaceIdentity?.trim()) {
          envelope.ttft = getLocalTtftObserver()?.dispatch(
            telemetrySeed.localTtft,
            workspacePath,
            envelope.commandId,
            targetSessionId,
          );
        }
        ack = await sendCommand(envelope);
        if (telemetrySeed?.localTtft && ack.reasonCode === "guard.heldQueueConfirmationStale")
          getLocalTtftObserver()?.confirmationRetry(telemetrySeed.localTtft);
        else if (telemetrySeed?.localTtft)
          getLocalTtftObserver()?.ack(telemetrySeed.localTtft, ack.status, ack.ttftExcluded);
      } catch (error) {
        if (telemetrySeed?.localTtft)
          getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "failed");
        if (lease?.store) {
          lease.store.settleCommand(envelope.commandId);
        }
        if (isProviderNotReadyError(error)) {
          // provider_not_ready is deterministically rejected before Host getClient, so the CLI cannot have
          // admitted it. Keeping a renderer recovery record would make the reconnect query return unknown;
          // even though unknown now clears silently, a deterministic rejection should leave no stale recovery record.
          pendingCommandRegistry.settle(envelope.sessionId, envelope.commandId);
        }
        recordV4CommandAck({
          type,
          status: "transport-error",
          reasonCode: String(error),
          at: Date.now(),
        });
        // Finalize the send funnel: telemetrySeed is carried only by real user sends. Two-step createSession
        // and background tasks have no seed, so they cannot fabricate send_result events.
        if (telemetrySeed) {
          conversationTelemetry?.settleSendResult({
            seed: telemetrySeed,
            sessionId: targetSessionId,
            commandId: envelope.commandId,
            status: "fail",
            reasonCode: isProviderNotReadyError(error) ? "provider_not_ready" : "transport_error",
          });
        }
        throw error;
      }
      pendingCommandRegistry.applyAck(envelope, ack);
      if (ack.status === "accepted") {
        acceptSelection?.();
        acceptRecent?.();
      }
      if (
        lease?.store &&
        type === "sendText" &&
        (ack.status === "accepted" || ack.status === "duplicate")
      ) {
        // ACK confirms CLI admission only. If this conversation topic then goes quiet, the store watchdog
        // reuses the same owned subscription after a grace period to recover authoritative rows/queue without replaying the command.
        lease.store.expectAcceptedInputProjection(envelope.commandId);
      }
      if (ack.status === "accepted" && telemetrySeed) {
        const acceptedSessionId =
          ack.result?.type === "createSelectionSideSession"
            ? ack.result.sessionId
            : (targetSessionId ??
              (ack.result?.type === "createSession" ? ack.result.sessionId : null));
        if (acceptedSessionId) {
          conversationTelemetry?.acceptPromptSeed({
            ...telemetrySeed,
            sessionId: acceptedSessionId,
            sourceCommandId: envelope.commandId,
            memoryEnabled: ack.memoryEnabled,
          });
        }
      }
      if (ack.status === "accepted" && highspeedCard && targetSessionId) {
        recordHighspeedTurn({
          sessionId: targetSessionId,
          sourceCommandId: envelope.commandId,
          card: highspeedCard,
          createdAt: Date.now(),
        });
      }
      if (telemetrySeed) {
        // A queue re-confirmation ACK returns null (not a terminal result); finalizing it would let first-wins consume the real result.
        const outcome = resolveSendAckSettlement(ack);
        if (outcome) {
          const settledSessionId =
            ack.result?.type === "createSelectionSideSession"
              ? ack.result.sessionId
              : (targetSessionId ??
                (ack.result?.type === "createSession" ? ack.result.sessionId : null));
          if (outcome.kind === "awaitRender") {
            // ACK means only that Host accepted the command; the user's bubble is not rendered yet.
            // Finalize end-to-end timing when the projection returns a userInput row (or after 30 seconds).
            conversationTelemetry?.awaitSendRender({
              seed: telemetrySeed,
              sessionId: settledSessionId,
              commandId: envelope.commandId,
              ackStatus: outcome.ackStatus,
            });
          } else {
            conversationTelemetry?.settleSendResult({
              seed: telemetrySeed,
              sessionId: settledSessionId,
              commandId: envelope.commandId,
              status: outcome.status,
              ackStatus: outcome.ackStatus,
              reasonCode: outcome.reasonCode,
            });
          }
        }
      }
      // Renderer logs are disabled in production builds; write the ACK summary to a bounded debug buffer for E2E/on-site probes.
      recordV4CommandAck({
        type,
        status: ack.status,
        ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
        revisionAtDecision: ack.revisionAtDecision,
        at: Date.now(),
      });
      if (shouldResyncForStaleAuthority(ack)) {
        // If epoch/entity authority has changed, clearing only the optimistic overlay would still send a command
        // to the old target. Recover the same subscription first, then decide using rowId/entityId from the current generation.
        lease?.store?.recoverFromStaleAuthority();
      }
      // Without settling on rejected/stale/failed results, the optimistic overlay would remain forever.
      if (
        lease?.store &&
        type !== "createSession" &&
        ack.status !== "accepted" &&
        ack.status !== "duplicate"
      ) {
        lease.store.settleCommand(envelope.commandId);
      }
      return ack;
    },
    [
      captureAcceptedModelSelection,
      conversationTelemetry,
      lease,
      provider,
      sendCommand,
      sessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );
  dispatchCommandRef.current = dispatchCommand;

  const handleFetchFileChanges = useCallback(
    (target: ConversationRowTarget, options: ConversationFileChangesRequestOptions) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        return Promise.resolve({
          files: 0,
          additions: 0,
          deletions: 0,
          items: [],
        });
      }
      const cacheKey = JSON.stringify([
        options.cachePolicy,
        sessionId,
        current.logEpoch,
        // Rewind changes active to reverted for the same logEpoch and row/entity;
        // terminal cache keys must include this semantic version instead of reusing the full diff from before the revert.
        options.cachePolicy === "in-flight"
          ? current.revision
          : (options.fileChangesState ?? "unknown"),
        target.rowId,
        target.entityId,
      ]);
      const cachedRequest = fileChangesRequestCache.get(cacheKey);
      if (cachedRequest) {
        fileChangesRequestCache.delete(cacheKey);
        fileChangesRequestCache.set(cacheKey, cachedRequest);
        return cachedRequest;
      }

      // Virtual-row unmounting loses local state, so a remounted preview card may fetch fileChanges with the full patch again.
      // Keep the cache in SessionPane so the card and file-change panel share the same request.
      let request: Promise<V4ConversationFileChangesResult>;
      request = fileChanges({
        sessionId,
        target,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
      }).then(
        (result) => {
          // A successful result during execution may still be a partial diff for the current revision.
          // Share only the in-flight Promise, then delete it when settled so the final card cannot reuse an early result.
          if (
            options.cachePolicy === "in-flight" &&
            fileChangesRequestCache.get(cacheKey) === request
          ) {
            fileChangesRequestCache.delete(cacheKey);
          }
          return result;
        },
        (error: unknown) => {
          // A failure must not affect later retries; delete only this Promise so an old request cannot remove a newer one with the same key.
          if (fileChangesRequestCache.get(cacheKey) === request) {
            fileChangesRequestCache.delete(cacheKey);
          }
          if (shouldResyncForStaleAuthority(error)) {
            lease?.store?.recoverFromStaleAuthority();
          }
          throw error;
        },
      );
      fileChangesRequestCache.set(cacheKey, request);
      while (fileChangesRequestCache.size > MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES) {
        const oldestKey = fileChangesRequestCache.keys().next().value;
        if (oldestKey === undefined) break;
        fileChangesRequestCache.delete(oldestKey);
      }
      return request;
    },
    [fileChanges, fileChangesRequestCache, lease, sessionId],
  );

  const handlePreviewFileRewind = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        return Promise.resolve({
          canApply: false,
          safeFiles: [],
          unsafeFiles: [],
          ignoredFiles: [],
        });
      }
      return fileRewindPreview({
        sessionId,
        target,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
      }).catch((error: unknown) => {
        if (shouldResyncForStaleAuthority(error)) {
          lease?.store?.recoverFromStaleAuthority();
        }
        throw error;
      });
    },
    [fileRewindPreview, lease, sessionId],
  );

  const handleApplyFileRewind = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        throw new Error("Cannot apply file rewind without an active session revision");
      }
      return dispatchCommand(
        "applyFileRewind",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleOpenSubagentSession = useCallback(
    (request: OpenSubagentSideTabRequest) => {
      onOpenSubagentSession?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenSubagentSession, remoteSessionId, rootSessionId, workspaceIdentity, workspacePath],
  );
  const handleOpenSubagentDirectory = useCallback(
    (request: import("@/lib/workspaceSidePane.js").OpenSubagentDirectorySideTabRequest) => {
      if (compactForRemoteControl) return;
      onOpenSubagentDirectory?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [
      compactForRemoteControl,
      onOpenSubagentDirectory,
      remoteSessionId,
      rootSessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const handleOpenPlanDetail = useCallback(
    (request: OpenPlanDetailSideTabRequest) => {
      onOpenPlanDetail?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenPlanDetail, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // Mirrors plan-detail: the card sends only intent (runId + toolCallId + display name).
  // The host (here) supplies session and workspace identity; the card does not know its scope.
  const handleOpenWorkflowRun = useCallback(
    (request: OpenWorkflowRunSideTabRequest) => {
      onOpenWorkflowRun?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowRun, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // Pill to subagent transcript: like plan-detail/workflow-run, the card supplies only instance identity; scope is added here.
  const handleOpenWorkflowActorSession = useCallback(
    (request: OpenWorkflowActorSessionSideTabRequest) => {
      onOpenWorkflowActorSession?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowActorSession, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // Script pill follows the same pattern: the card supplies the run, initiating row, and phase; scope is added here.
  const handleOpenWorkflowWorkspace = useCallback(
    (request: OpenWorkflowWorkspaceSideTabRequest) => {
      onOpenWorkflowWorkspace?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowWorkspace, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // Artifact chip follows the run-details pattern: cards/notification rows send only intent; scope is added here.
  const handleOpenWorkflowArtifact = useCallback(
    (request: OpenWorkflowArtifactSideTabRequest) => {
      onOpenWorkflowArtifact?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowArtifact, remoteSessionId, workspaceIdentity, workspacePath],
  );
  // Lookup from tool cards to workflow runs. The authoritative source is each run's toolCallId in the
  // workflowRuns projection (the schema documents it as the key from a tool card to its details page).
  // In v4, the tool row's output contains only the sentence selected by formatCreateWorkflowModelContent;
  // structured fields are unavailable there.
  //
  // The value includes more than runId: active cards render status and step counts, so compute the summary
  // during this join (counting rules are in buildWorkflowRunByToolCallId; its tests cover settled/observed semantics).
  // After restart, the projection is populated because the CLI replays the journal through the same reducer.
  // Card joins read only the projection and no longer merge discovery queries. Discovery queries are now used here only for:
  //
  // `limit` and `refreshKey` serve the task-list footer row "Completed workflows · N":
  // - Use the same depth constant as the run directory page, so the footer and page count the same runs.
  // - Use the same derived trigger (run count + settled count), so footer freshness matches the directory page it opens.
  //   Connecting its `revision` to the projection turns a paginated read into a stream that follows run events.
  const workflowRunJournalSummaries = useWorkflowRunJournalSummaries({
    sessionId,
    // Root cause (reproduced 2026-08-24): nested read-only transcripts (DWF actors/subagents) also use SessionPane.
    // Sending this query indiscriminately asks a journal keyed by the parent session with a child session ID. The CLI's
    // cold-session preflight then materializes a second runtime (a ghost) for the running detached actor, double-writes
    // the event log, and freezes the live view at "worked for xx seconds". Read-only panes use neither join fallback nor task-list footer, so disable it there.
    enabled: !readOnly,
    live: state.status === "live",
    limit: WORKFLOW_RUN_DIRECTORY_LIMIT,
    refreshKey: workflowRunDirectoryRefreshKey(snapshot?.workflowRuns?.runs),
  });
  const endedWorkflowRunCount = useMemo(
    () => countEndedWorkflowRuns(workflowRunJournalSummaries),
    [workflowRunJournalSummaries],
  );
  const workflowRunByToolCallId = useMemo(
    () => buildWorkflowRunByToolCallId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // Source table keyed by runId for joining ResumeWorkflowRun tool rows. The display includes runId, while the
  // projection's toolCallId remains the original CreateWorkflow row across resume; resume rows cannot be found by toolCallId.
  const workflowRunByRunId = useMemo(
    () => buildWorkflowRunByRunId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // Initiating toolCallId to static graph: the graph belongs to the run, and all three sources of end-of-turn run cards use this table.
  // Build it once per row window and rebuild it when the window changes.
  const workflowGraphByToolCallId = useMemo(
    () => buildWorkflowGraphByToolCallId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // runId → latest completed valid script graph (docs/dynamic-workflow/presentation.md, “Holes on the timeline”):
  // run cards and the side pane use it after completion. Built once per row window and rebuilt with the window.
  const workflowFillGraphByRunId = useMemo(
    () => buildWorkflowFillGraphByRunId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // Workflow tool row to draft position: both the draft number and whether a newer draft follows
  // can be determined only from row order. Build this once per row window and rebuild it when the window changes.
  const workflowDraftByToolCallId = useMemo(
    () => buildWorkflowDraftByToolCallId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // runId → SaveWorkflow candidate claimed by the transcript (docs/dynamic-workflow/transcript-and-notifications.md,
  // “Which workflow a run is saved as”, rule 1). Built once per row window and rebuilt with the window.
  const workflowSaveCandidatesByRunId = useMemo(
    () => buildWorkflowSaveCandidatesByRunId(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  // Join table for Workflow notification manifest upgrade entries from Waiting to Answered (runId to parked question IDs).
  const workflowRunPendingQuestionsByRunId = useMemo(
    () => buildWorkflowRunPendingQuestionsByRunId(snapshot?.workflowRuns?.runs),
    [snapshot?.workflowRuns],
  );
  // Details-page entry point (a row in the panel's Workflows section). The row supplies only which run to open (runId + toolCallId);
  // session and workspace identity are added here, using the same handler as tool cards so there is only one open path.
  const handleOpenWorkflowRunFromPanel = useCallback(
    (target: ConversationStatusPanelWorkflowRunTarget) => {
      if (!sessionId) return;
      handleOpenWorkflowRun({ ...target, parentSessionId: sessionId });
    },
    [handleOpenWorkflowRun, sessionId],
  );
  // Entry point for the run directory page (the same footer row). It also adds only scope; it does not create another open path.
  const handleOpenWorkflowRunDirectoryFromPanel = useCallback(
    (request: OpenWorkflowRunDirectorySideTabRequest) => {
      onOpenWorkflowRunDirectory?.({
        ...request,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenWorkflowRunDirectory, remoteSessionId, workspaceIdentity, workspacePath],
  );
  const handleAddSelectionToCurrentTask = useCallback(
    (reference: ConversationSelectionReference) => {
      if (!sessionId) return;
      dispatchConversationSelectionAdd({
        targetSessionId: sessionId,
        workspaceKey,
        reference,
      });
    },
    [sessionId, workspaceKey],
  );
  const handleOpenSelectionSideConversation = useCallback(
    async (reference?: ConversationSelectionReference, forceNew = false) => {
      if (!sessionId || !selectionSideChatKey || !onOpenSelectionSideChat) return;
      try {
        let targetChildSessionId = reference && !forceNew ? activeSelectionSideChatSessionId : null;
        let replacesChildSessionId: string | undefined;
        if (targetChildSessionId) {
          try {
            await zcodeSessionService.readSession({
              workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              sessionId: targetChildSessionId,
              messageLimit: 1,
            });
          } catch (error) {
            if (!String(error).includes("sessionNotFound")) throw error;
            // With multiple tabs, tab IDs include the child, so the old singleton behavior of replacing
            // the same parent tab with a new child no longer removes stale entries. Pass replacesChildSessionId
            // explicitly so the host can atomically remove the old tab and open the new one.
            replacesChildSessionId = targetChildSessionId;
            clearSelectionSideChat(targetChildSessionId);
            clearConversationSelectionReferenceScope(targetChildSessionId, workspaceKey);
            targetChildSessionId = null;
          }
        }

        if (targetChildSessionId) {
          onOpenSelectionSideChat({
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(remoteSessionId ? { remoteSessionId } : {}),
            parentSessionId: sessionId,
            childSessionId: targetChildSessionId,
          });
          if (reference) {
            dispatchConversationSelectionAdd({
              targetSessionId: targetChildSessionId,
              workspaceKey,
              reference,
            });
          }
          return;
        }

        const childSessionId = await createSelectionSideChat(selectionSideChatKey, async () => {
          const ack = await dispatchCommand("createSelectionSideSession", {}, sessionId);
          if (
            (ack.status !== "accepted" && ack.status !== "duplicate") ||
            ack.result?.type !== "createSelectionSideSession"
          ) {
            throw new Error(ack.reasonCode ?? "createSelectionSideSession 被拒绝");
          }
          return ack.result.sessionId;
        });
        onOpenSelectionSideChat({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          parentSessionId: sessionId,
          childSessionId,
          ...(replacesChildSessionId ? { replacesChildSessionId } : {}),
        });
        if (reference) {
          dispatchConversationSelectionAdd({
            targetSessionId: childSessionId,
            workspaceKey,
            reference,
          });
        }
      } catch (error) {
        logger.warn("[v4-pane] 创建框选副屏会话失败", {
          error: error instanceof Error ? error.message : String(error),
          parentSessionId: sessionId,
          workspaceKey,
        });
      }
    },
    [
      activeSelectionSideChatSessionId,
      dispatchCommand,
      onOpenSelectionSideChat,
      remoteSessionId,
      selectionSideChatKey,
      sessionId,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
      zcodeSessionService,
    ],
  );

  const handleOpenSelectionSideConversationWithPrompt = useCallback(
    async (text: string, telemetrySeed?: ConversationPromptTelemetrySeed): Promise<boolean> => {
      if (!sessionId || !selectionSideChatKey || !onOpenSelectionSideChat) {
        throw new Error("selection side chat is unavailable");
      }
      const inherited = resolveSelectionSideInheritedModel(
        snapshotRef.current?.config,
        modelSelectionView,
      );
      const chosen = inherited ? await recommendStartPlan(inherited) : undefined;
      if (chosen === null) return false;
      const modelSelection = chosen && chosen !== inherited ? chosen : undefined;
      // Each parameterized command creates a new child. Retrying the same text before ACK reuses pending,
      // but different text must not merge with bare `/side` or another prompt.
      const pendingKey = `${selectionSideChatKey}\u0000prompt\u0000${text}`;
      const childSessionId = await createSelectionSideChat(pendingKey, async () => {
        const ack = await dispatchCommand(
          "createSelectionSideSession",
          { firstInput: { text, ...(modelSelection ? { modelSelection } : {}) } },
          sessionId,
          undefined,
          undefined,
          telemetrySeed,
        );
        if (
          (ack.status !== "accepted" && ack.status !== "duplicate") ||
          ack.result?.type !== "createSelectionSideSession"
        ) {
          throw new Error(ack.reasonCode ?? "createSelectionSideSession 被拒绝");
        }
        return ack.result.sessionId;
      });
      onOpenSelectionSideChat({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        parentSessionId: sessionId,
        childSessionId,
      });
      return true;
    },
    [
      dispatchCommand,
      modelSelectionView,
      recommendStartPlan,
      onOpenSelectionSideChat,
      remoteSessionId,
      selectionSideChatKey,
      sessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );

  useEffect(() => {
    if (
      !selectionSideChatKey ||
      !sessionId ||
      readOnly ||
      selectionSideChat ||
      isMobileTextInputViewport ||
      !onOpenSelectionSideChat
    ) {
      return;
    }

    // The fixed Side Pane entry point has no session Provider; register the command orchestration already owned by the main pane.
    // Keep it registered even if the parent session is blocked by Permission/AskUser, so the direct entry can still create/activate the side pane.
    return registerSelectionSideChatOpener(
      selectionSideChatKey,
      // A previous merge dropped the reference and left the Markdown entry point opening a blank side pane; reuse the existing reference routing.
      (reference) => handleOpenSelectionSideConversation(reference, !reference),
      focused,
      Boolean(blockingInteractionId) || selectionSideActionBlocked,
    );
  }, [
    blockingInteractionId,
    selectionSideActionBlocked,
    focused,
    handleOpenSelectionSideConversation,
    isMobileTextInputViewport,
    onOpenSelectionSideChat,
    readOnly,
    selectionSideChat,
    selectionSideChatKey,
    sessionId,
  ]);

  const cliSlashCommandNames = useMemo(
    () =>
      new Set(
        (slashCommands ?? []).map((command) =>
          normalizeSlashCommandValue(command.name).toLowerCase(),
        ),
      ),
    [slashCommands],
  );
  const availableSelectionSideSlashCommandNames = useMemo(
    () => ["side", "btw"].filter((name) => !cliSlashCommandNames.has(name)),
    [cliSlashCommandNames],
  );

  // App-level `/side` slash command. The CLI catalog remains authoritative; this renderer injects a local
  // command to open an auxiliary conversation on selection, subject to gates. It is unavailable in draft state
  // (no parent session for a child), inside an auxiliary conversation, in read-only views, and on mobile viewports.
  const appSlashCommands = useMemo<AppSlashCommand[] | undefined>(() => {
    if (
      !sessionId ||
      !onOpenSelectionSideChat ||
      !shouldOfferSideSlashCommand({
        isDraft: sessionId === null,
        selectionSideChat,
        readOnly,
        isMobileViewport: isMobileTextInputViewport,
      })
    ) {
      return undefined;
    }
    const openNewSelectionSideChat = () => {
      void handleOpenSelectionSideConversation(undefined, true);
    };
    // Keywords always include both English and Chinese aliases, so side/btw/辅助 can be found in any locale.
    // `/btw` is an alias for `/side` to match different input habits; each appears separately in the panel.
    const sharedKeywords = ["side", "btw", "side chat", "auxiliary", "辅助对话", "辅助", "侧边"];
    const description = intl.formatMessage({ id: "chat.slash.app.side.description" });
    return [
      { value: "side", description, keywords: sharedKeywords, run: openNewSelectionSideChat },
      { value: "btw", description, keywords: sharedKeywords, run: openNewSelectionSideChat },
    ].filter((command) => !cliSlashCommandNames.has(command.value));
  }, [
    cliSlashCommandNames,
    handleOpenSelectionSideConversation,
    intl,
    isMobileTextInputViewport,
    onOpenSelectionSideChat,
    readOnly,
    selectionSideChat,
    sessionId,
  ]);

  const chatLoadingBlockedByInteraction = hasChatLoadingBlockingInteraction(
    snapshot?.pendingInteractions ?? [],
  );
  const chatLoadingBlockedByActiveWork = hasChatLoadingBlockingActiveWork(
    snapshot?.control.activeWorks ?? [],
  );
  // Subagent detail transcripts remain read-only; file rewind restores the workspace and must be checked as a separate capability.
  const workspaceFileRewindEnabled = !readOnly || allowWorkspaceFileRewind;
  // cancelBackgroundWork is the cancel entry point for launch/background-task cards. Define it before rowContext memoization
  // so it can be bound there (onOpenWorkflowRun is also defined above the memo); omit it in read-only mode, as below.
  const handleCancelBackgroundWork = useCallback(
    (workId: string) => {
      if (!sessionId) return;
      void dispatchCommand("cancelBackgroundWork", { workId }, sessionId).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(
            `[v4-pane] cancelBackgroundWork 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`,
          );
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  // Dynamic workflow rollout snapshot: read-only store, loaded once in Root.
  // Treat it as a miss until ready, when enabled is false.
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();

  // resumeWorkflowRun is the Resume action in the tool-card footer. It uses the same v4 command as the details page,
  // carries no baseRevision, and `name` supplies the subject for the completion notification after recovery.
  const handleResumeWorkflowRun = useCallback(
    (workId: string, name?: string) => {
      if (!sessionId) return;
      void dispatchCommand(
        "resumeWorkflowRun",
        { workId, ...(name ? { name } : {}) },
        sessionId,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] resumeWorkflowRun 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  // amendWorkflowRunSettings is the run card's Configure action. Return the ACK to the dialog so rejection reasons
  // appear there rather than as a console warning. It uses the same gate as Resume.
  const handleAmendWorkflowRunSettings = useCallback(
    (workId: string, change: WorkflowRunSettingsChange): Promise<CommandAck> =>
      dispatchCommand("amendWorkflowRunSettings", { workId, ...change }, sessionId),
    [dispatchCommand, sessionId],
  );
  const workflowSessionModel = useMemo(
    () => workflowSessionModelOf(snapshot?.sessionId === sessionId ? snapshot?.config : undefined),
    [sessionId, snapshot?.config, snapshot?.sessionId],
  );

  /**
   * Send entry point for the user message “Ask ZCode to distill and save this” (docs/dynamic-workflow/transcript-and-notifications.md,
   * “The message the lead sends”): follows the same precedent as central “Promote to global”—the GUI writes and sends it automatically without another confirmation.
   *
   * Route through a ref instead of referencing `handleSendText` directly: it is defined later in
   * this file, while the rowContext memo factory runs during the **same render**, so a direct
   * reference would hit the TDZ. The ref is assigned during render and clicks happen after mount.
   */
  const sendTextRef = useRef<typeof handleSendText | null>(null);
  const handleSendWorkflowSaveRequest = useCallback(async (text: string) => {
    const send = sendTextRef.current;
    if (send === null) throw new Error("send path not mounted");
    const result = await send(text);
    // If blocked (the session is confirming something else or the queue is paused for confirmation), it was not handed to ZCode; throw back to the dialog so it stays open.
    if (result !== "sent") throw new Error(`workflow save request not sent: ${result}`);
  }, []);

  const rowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      workspacePath,
      workspaceHomePath,
      workspaceIdentity,
      workspaceRemoteSessionId: remoteSessionId ?? undefined,
      modelSelectionView,
      logEpoch: snapshot?.logEpoch,
      theme,
      codePreviewSettings,
      sessionId,
      rootSessionId: rootSessionId ?? sessionId,
      compactForRemoteControl,
      chatLoadingBlockedByActiveWork,
      chatLoadingBlockedByInteraction,
      messageStreamShowReasoning,
      messageStreamShowTodos,
      toolGroupingExploreEnabled,
      toolGroupingTerminalEnabled,
      toolGroupingChangesEnabled,
      onNavigateToRow: handleNavigateToRow,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      onAutoOpenAssistantPptx: handleAutoOpenAssistantPptx,
      assistantPreviewPptxAutoOpenTarget,
      onOpenFileLink,
      onOpenSubagentSession: onOpenSubagentSession ? handleOpenSubagentSession : undefined,
      onOpenPlanDetail: onOpenPlanDetail ? handleOpenPlanDetail : undefined,
      onOpenWorkflowRun: onOpenWorkflowRun ? handleOpenWorkflowRun : undefined,
      onOpenWorkflowActor: onOpenWorkflowActorSession ? handleOpenWorkflowActorSession : undefined,
      onOpenWorkflowWorkspace: onOpenWorkflowWorkspace ? handleOpenWorkflowWorkspace : undefined,
      onOpenWorkflowArtifact: onOpenWorkflowArtifact ? handleOpenWorkflowArtifact : undefined,
      onCancelBackgroundWork: readOnly ? undefined : handleCancelBackgroundWork,
      // This is the only point that supplies session context to Resume. Both rollout and read-only gates live in
      // resolveWorkflowResumeHandler; omitting this would remove the button from tool-card footers and summary cards.
      onResumeWorkflowRun: resolveWorkflowResumeHandler({
        readOnly,
        dynamicWorkflowEnabled,
        handler: handleResumeWorkflowRun,
      }),
      onAmendWorkflowRunSettings: sessionId
        ? resolveWorkflowResumeHandler({
            readOnly,
            dynamicWorkflowEnabled,
            handler: handleAmendWorkflowRunSettings,
          })
        : undefined,
      // Save and Resume share the same gate and source: writing the file and starting the engine
      // both belong where Resume is handled (docs/dynamic-workflow/launch.md, “Gray release”). The
      // chip does not pass through this gate; it only reports a fact.
      onSendWorkflowSaveRequest: sessionId
        ? resolveWorkflowResumeHandler({
            readOnly,
            dynamicWorkflowEnabled,
            handler: handleSendWorkflowSaveRequest,
          })
        : undefined,
      workflowSaveCandidatesByRunId,
      ...(workflowSessionModel === undefined ? {} : { workflowSessionModel }),
      workflowRunByToolCallId,
      workflowRunByRunId,
      workflowRunPendingQuestionsByRunId,
      workflowGraphByToolCallId,
      workflowFillGraphByRunId,
      workflowDraftByToolCallId,
      fetchFileChanges: handleFetchFileChanges,
      previewFileRewind: workspaceFileRewindEnabled ? handlePreviewFileRewind : undefined,
      applyFileRewind: workspaceFileRewindEnabled ? handleApplyFileRewind : undefined,
      readAttachment: attachmentRead,
      readAttachmentRange: attachmentReadRange,
    }),
    [
      workspacePath,
      workspaceHomePath,
      workspaceIdentity,
      remoteSessionId,
      modelSelectionView,
      snapshot?.logEpoch,
      theme,
      codePreviewSettings,
      sessionId,
      rootSessionId,
      compactForRemoteControl,
      chatLoadingBlockedByActiveWork,
      chatLoadingBlockedByInteraction,
      messageStreamShowReasoning,
      messageStreamShowTodos,
      toolGroupingExploreEnabled,
      toolGroupingTerminalEnabled,
      toolGroupingChangesEnabled,
      handleNavigateToRow,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      handleAutoOpenAssistantPptx,
      assistantPreviewPptxAutoOpenTarget,
      onOpenFileLink,
      onOpenSubagentSession,
      handleOpenSubagentSession,
      onOpenPlanDetail,
      handleOpenPlanDetail,
      onOpenWorkflowRun,
      handleOpenWorkflowRun,
      onOpenWorkflowActorSession,
      handleOpenWorkflowActorSession,
      onOpenWorkflowWorkspace,
      handleOpenWorkflowWorkspace,
      onOpenWorkflowArtifact,
      handleOpenWorkflowArtifact,
      readOnly,
      handleCancelBackgroundWork,
      dynamicWorkflowEnabled,
      handleResumeWorkflowRun,
      handleAmendWorkflowRunSettings,
      handleSendWorkflowSaveRequest,
      workflowSaveCandidatesByRunId,
      workflowSessionModel,
      workflowRunByToolCallId,
      workflowRunByRunId,
      workflowRunPendingQuestionsByRunId,
      workflowGraphByToolCallId,
      workflowFillGraphByRunId,
      workflowDraftByToolCallId,
      workspaceFileRewindEnabled,
      handleFetchFileChanges,
      handlePreviewFileRewind,
      handleApplyFileRewind,
      attachmentRead,
      attachmentReadRange,
    ],
  );

  // ── Draft-state v4 draft session prewarm (m5) ──
  // When the pane is not bound to a session, create a phase=draft session in the background as a prewarm carrier:
  // configuration writes go directly through CAS, and first send reuses it.
  // External binding semantics are unchanged (shell activeTaskId remains null); the prewarm session is only the pane's internal effective subscription target.
  const { binding: prewarmBinding } = useDraftSessionPrewarm({
    enabled: sessionId === null && draftAgentStartupAllowed,
    workspaceKey,
    paneId,
    invalidationVersion: draftRuntimeInvalidationVersion,
    // SessionDataLayer comes from the workspace connection registry: panes/remounts in the same transport generation
    // share an identity. A new sendCommand function created by rebuilding the provider wrapper is not a transport change.
    transportIdentity: layer,
    dispatchCommand,
    // The prewarm session consumes only the one-time initialization result from the current Root Composer Draft.
    resolveInitialConfig: resolveInitialDraftConfig,
  });
  const prewarmBindingRef = useRef(prewarmBinding);
  prewarmBindingRef.current = prewarmBinding;
  const prewarmSessionId = prewarmBinding?.sessionId ?? null;
  // Runtime replacement (for example, CUA Helper readiness or liveness recovery triggering workspace-dispose)
  // can remove a draft prewarm session before it is persisted. Block sending while rebuilding; otherwise attachments
  // may be linked to a session that no longer exists (sessionNotFound).
  const { rebuilding: draftRuntimeRebuilding } = useDraftRuntimeRebuildGate({
    enabled: sessionId === null,
    onRuntimeRestart,
    onRuntimeLifecycle,
    prewarmSessionId,
    workspaceIdentity,
    workspacePath,
  });
  const ensureDraftPrewarmConfigBeforeSendRef = useRef<(targetSessionId: string) => Promise<void>>(
    async () => undefined,
  );
  const effectiveSessionId = sessionId ?? prewarmSessionId;
  const showModelChangeNotice = useCallback(
    (sourceModel: ModelSelectionSource | null, targetModel: ModelSelectionSource) => {
      // Bug cause: the draft is not yet a real session, and its model choice is already visible in the composer.
      // Showing a switch-result notice here would misreport initialization or a prewarm fallback as an in-session switch.
      if (sessionId === null) {
        return;
      }

      const fromProviderId = sourceModel?.provider ?? "";
      const fromModelId = sourceModel?.model ?? "";
      const providerChanged = Boolean(
        fromProviderId && targetModel.provider && fromProviderId !== targetModel.provider,
      );
      if (
        !fromModelId ||
        !targetModel.model ||
        (fromModelId === targetModel.model && !providerChanged)
      ) {
        return;
      }

      const fromProvider = resolveProviderLabel(fromProviderId, modelSelectionView);
      const toProvider = resolveProviderLabel(targetModel.provider, modelSelectionView);
      const fromModel = formatModelChangeLabel(fromProviderId, fromProvider, fromModelId, intl);
      const toModel = formatModelChangeLabel(
        targetModel.provider,
        toProvider,
        targetModel.model,
        intl,
      );
      toast(intl.formatMessage({ id: "chat.modelChangeNotice.changed" }, { fromModel, toModel }));
    },
    [intl, modelSelectionView, sessionId],
  );

  const handleOnlineModelTransition = useCallback(
    (
      subscribedSessionId: string,
      _store: SessionLease["store"],
      transition: SessionModelTransition,
    ) => {
      if (!focused || subscribedSessionId !== effectiveSessionId) return;
      // Bug cause: automatic fallback notices and preference promotion used to be driven by online events and arbitrary
      // snapshot changes separately. Recovery/history projections could silently change the next draft. Both now consume
      // the same realtime online event, already deduplicated by deliveryKind in the store.
      showModelChangeNotice(transition.from, transition.to);
    },
    [
      effectiveSessionId,
      focused,
      provider,
      sessionId,
      showModelChangeNotice,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );
  const onlineModelTransitionHandlerRef = useRef(handleOnlineModelTransition);
  useLayoutEffect(() => {
    onlineModelTransitionHandlerRef.current = handleOnlineModelTransition;
  }, [handleOnlineModelTransition]);

  const recoverableCommands = usePendingCommandRecovery({
    layer,
    sessionId: effectiveSessionId,
    snapshot,
    status: state.status,
    subscriptionId: state.subscriptionId,
    workspacePath,
    workspaceIdentity,
  });

  useEffect(() => {
    if (!effectiveSessionId) {
      setLease(null);
      return;
    }
    const nextLease = layer.acquire(effectiveSessionId);
    // Bug cause: acquire starts connect immediately, and activation may release the one-time online frame before the next effect.
    // Subscribe synchronously after acquire returns; snapshot replay cannot compensate for a missed event.
    const offOnlineModelTransition = nextLease.store.onOnlineModelTransition((transition) => {
      onlineModelTransitionHandlerRef.current(effectiveSessionId, nextLease.store, transition);
    });
    setLease(nextLease);
    return () => {
      offOnlineModelTransition();
      nextLease.release();
    };
  }, [layer, effectiveSessionId]);

  useEffect(() => {
    if (!sessionId || !lease || snapshot?.sessionId !== sessionId) return;
    void lease.store.refreshPlans();
  }, [lease, sessionId, snapshot?.sessionId, state.planDirectoryRevision]);

  // If prewarm-session subscription fails (for example, the in-memory session disappeared after a CLI restart),
  // discard it and fall back to the non-prewarm path without showing an error UI.
  useEffect(() => {
    if (sessionId === null && prewarmBinding && state.status === "error") {
      logger.warn("[v4-draft-prewarm] 预热会话订阅失败，丢弃回落", {
        prewarmSessionId: prewarmBinding.sessionId,
        lastError: state.lastError ?? null,
      });
      prewarmBinding.discard();
    }
  }, [prewarmBinding, sessionId, state.lastError, state.status]);

  useEffect(() => {
    if (
      !selectionSideChat ||
      state.status !== "error" ||
      !state.lastError?.includes("sessionNotFound")
    ) {
      return;
    }
    // The side pane is a temporary UI binding. Clear the tab when its persistent child is lost; the next selection rebuilds it from the parent session.
    onSelectionSideChatUnavailable?.();
  }, [onSelectionSideChatUnavailable, selectionSideChat, state.lastError, state.status]);

  const settleCurrentQueueInputs = useCallback((targetSessionId: string) => {
    const current = snapshotRef.current;
    if (!current || current.sessionId !== targetSessionId) return;
    for (const item of current.queue.items) {
      pendingCommandRegistry.settle(targetSessionId, item.sourceCommandId);
    }
  }, []);

  const dispatchSlashCommand = useCallback(
    async (
      command: V4VisibleSlashCommand,
      targetSessionId: string,
      baseRevision: number | undefined,
      heldQueueDisposition: "clearQueueAndSend" | "keepQueueAndSend" | undefined,
      expectedHeldQueueItemIds?: readonly string[],
      submission?: ComposerSubmissionConfig,
      onAccepted?: (messageId: string) => void,
    ): Promise<boolean | "confirmationRequired"> => {
      let type: CommandType | null = null;
      let payload: Record<string, unknown> = {};
      // compact is a queueable input command and does not use CAS; resumeGoal still uses CAS.
      let withBaseRevision = false;
      const currentRoutingMode = snapshotRef.current?.inputRouting.mode;
      const compactExpectedToQueue =
        command.kind === "compact" &&
        currentRoutingMode !== undefined &&
        currentRoutingMode !== "startNow";
      switch (command.kind) {
        case "compact":
          type = "compact";
          break;
        case "sendGoalCommand":
          type = "sendGoalCommand";
          // A previous merge made /goal reread Composer after preparation, overwriting the mode frozen at click time.
          // Reuse this Submission as sendText does; later menu changes apply only to the next send.
          if (!submission) return false;
          payload = {
            text: command.objective,
            displayText: command.displayText,
            ...submission,
            ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
            ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          };
          break;
        case "resumeGoal":
          type = "resumeGoal";
          withBaseRevision = true;
          break;
        case "emptyGoal":
          logger.warn("[v4-pane] /goal 需要目标文本");
          return true;
        case "unsupportedGoal":
          logger.warn(`[v4-pane] 暂不支持 /goal ${command.action}`);
          return true;
        default:
          return false;
      }
      if (withBaseRevision && baseRevision === undefined) {
        logger.warn(`[v4-pane] slash ${command.kind} 缺少 baseRevision`);
        return true;
      }
      const ack = await dispatchCommand(
        type,
        payload,
        targetSessionId,
        withBaseRevision ? baseRevision : undefined,
      );
      if (ack.status === "accepted") onAccepted?.(ack.commandId);
      if (ack.reasonCode === "guard.heldQueueConfirmationStale") {
        return "confirmationRequired";
      }
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(
          `[v4-pane] slash ${command.kind} 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`,
        );
        if (command.kind === "compact" && ack.reasonCode === "compactOperationLock") {
          toast(intl.formatMessage({ id: "chat.compact.duplicateBlocked" }));
        } else if (command.kind === "compact" && ack.reasonCode === "activeTurn") {
          // Compatibility with older CLI versions: they may still return activeTurn, so do not silently clear the command again.
          toast(intl.formatMessage({ id: "chat.compact.runningBlocked" }));
        }
      } else if (command.kind === "compact" && compactExpectedToQueue) {
        toast(intl.formatMessage({ id: "chat.compact.queued" }));
      } else if (heldQueueDisposition === "clearQueueAndSend") {
        settleCurrentQueueInputs(targetSessionId);
      }
      return true;
    },
    [dispatchCommand, intl, settleCurrentQueueInputs],
  );

  const readGroupedDraftId = useCallback(
    () =>
      useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
        .groupedDraftTask?.draftId ?? null,
    [workspacePath, workspaceIdentity],
  );
  /**
   * Freeze this send's origin (spec §9.2). Call synchronously when sending is triggered, before
   * any pre-send await such as the config barrier, draft model readiness, Start plan recommendation,
   * or empty-session creation; otherwise the origin may read the Task switched to by the user.
   */
  const captureHighspeedPaneOrigin = useCallback(
    (): HighspeedPaneOrigin => ({
      sessionId: sessionIdRef.current,
      paneBinding: paneBindingRef.current.generation,
      draftId: sessionIdRef.current === null ? readGroupedDraftId() : null,
    }),
    [readGroupedDraftId],
  );

  const prepareHighspeedTurnFrom = useCallback(
    (origin: HighspeedPaneOrigin): HighspeedTurnPreparer =>
      async (
        taskId: string,
        submissionSelection?: ModelSelection,
      ): Promise<HighspeedPrepareTurnResult | null> => {
        // Rule 15: prepare selection and this submission must use the same source—the model the
        // user just selected must drive admission on the first send. Previously, cards were drawn
        // from the old session-projected selection, then replaced a submission using a non-Coding
        // Plan model, making it appear that acceleration ignored the selected model.
        const selection = resolveHighspeedPrepareSelection({
          submissionSelection,
          projectedConfig:
            snapshotRef.current?.sessionId === taskId ? snapshotRef.current.config : null,
          draftConfig: draftConfigRef.current,
          initialDraftConfig: resolveInitialDraftConfig(),
        });
        if (!selection) return null;
        // An acceleration card reuses the session model and must include the session's effective
        // reasoning level. Without it, the CLI reports "Reasoning level is required" for an
        // incomplete execution selection and the send fails. Prefer options from the submitted
        // selection, then fall back to thought (the effective level from the CLI projection); an
        // empty string means the model has no level and lets the service omit options.
        const { provider, model, reasoningLevel } = selection;
        try {
          const sendStartedAt = Date.now();
          const result = await highspeedCardService.prepareTurn({
            taskId,
            providerId: provider,
            model,
            ...(reasoningLevel ? { reasoningLevel } : {}),
            waitBudgetMs: HIGHSPEED_SEND_WAIT_BUDGET_MS,
          });
          if (result.kind === "accelerated") {
            // Root cause: this query only controls the time-saved display, but used to be awaited
            // synchronously after a card hit. The monitor's 15s timeout stretched the 1s send
            // budget to as much as 16s (especially visible on a new session: the empty session was
            // created while the message body remained unsent). Now wait best-effort only within
            // the remaining send budget; on timeout/failure, omit regularTps for this turn. The
            // Service continues and caches the request for the next turn (spec §3 rule 12, §9.4).
            const regularTps = await readRegularTpsWithinSendBudget({
              read: async () => {
                // Baseline TPS for time-saved comes from the Coding Plan usage health endpoint;
                // request-time auth is resolved only through account access context. Read a
                // snapshot for the currently selected Coding Plan Provider instead of subscribing
                // to the config surface (SessionPane does not need to rerender for this); do not
                // show time-saved when disconnected or ineligible.
                const providerSettingsState = getProviderSettingsSnapshot();
                const accountAccess =
                  providerSettingsState.status === "ready"
                    ? resolveEntitledAccountProviderAccess(providerSettingsState.view, provider)
                    : null;
                if (!accountAccess) return undefined;
                return readHighspeedRegularTpsFromHealth({
                  usageStatsService,
                  preferredProviderId: provider,
                  accountAccess: accountAccess.access,
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
              },
              elapsedMs: Date.now() - sendStartedAt,
              onError: (error) =>
                logger.warn("[highspeed] 读取普通 Decode TPS 失败，本轮不展示节省时间", {
                  error: error instanceof Error ? error.message : String(error),
                  provider,
                  taskId,
                }),
              onTimeout: (budgetMs) =>
                logger.info(
                  "[highspeed] 普通 Decode TPS 未在发送预算内返回，本轮不附加 regularTps",
                  {
                    budgetMs,
                    provider,
                    taskId,
                  },
                ),
            });
            const acceleratedResult: HighspeedPrepareTurnResult = regularTps
              ? { ...result, card: { ...result.card, regularTps } }
              : result;
            const cardId = acceleratedResult.card.cardId;
            // Root cause: SessionPane is reused across Tasks, and the user may switch Tasks while
            // awaiting the pre-send config barrier, plan recommendation, session creation, prepare,
            // or TPS read. Writing card state then would show an old Task's card in the new Task's
            // composer and play its activation. The origin used to be read only at prepare entry,
            // so a switch before prepare made the check ineffective; the caller now freezes it
            // synchronously when sending starts. Display the card only when the pane still shows
            // its Task, or for a draft's first send if the pane has never left that draft (the new
            // session is not yet bound to the pane). The current send still uses the card; only its
            // display in this pane is skipped. Returning to its Task restores it from the snapshot.
            const paneSessionId = sessionIdRef.current;
            const paneShowsSendTarget =
              paneSessionId === taskId ||
              (origin.sessionId === null &&
                paneSessionId === null &&
                paneBindingRef.current.generation === origin.paneBinding &&
                readGroupedDraftId() === origin.draftId);
            if (!paneShowsSendTarget) {
              return acceleratedResult;
            }
            // Root cause: restore and draw hits shared the same card-rendering path, so triggering
            // activation on card appearance replayed the animation when returning to a Task.
            // prepare also returns accelerated when reusing an existing card. Register activation
            // only when this pane displays a card for the first time.
            if (presentedHighspeedCardIdRef.current !== cardId) {
              presentedHighspeedCardIdRef.current = cardId;
              setHighspeedActivationCardId(cardId);
            }
            setActiveHighspeedCard(acceleratedResult.card);
            return acceleratedResult;
          } else if (
            !result.card ||
            result.card.taskId !== taskId ||
            result.card.expiresAt <= Date.now()
          ) {
            setActiveHighspeedCard((current) => (current?.taskId === taskId ? null : current));
          }
          return result;
        } catch (error) {
          logger.warn("[highspeed] 抽卡失败，本轮按普通模型发送", {
            error: error instanceof Error ? error.message : String(error),
            taskId,
          });
          return null;
        }
      },
    [
      draftConfigRef,
      highspeedCardService,
      readGroupedDraftId,
      resolveInitialDraftConfig,
      usageStatsService,
    ],
  );

  const dispatchSendTextAfterConfig = useCallback(
    async (
      text: string,
      options: ConversationComposerSendOptions | undefined,
      createSourceAtSend: SessionCreateSource,
      highspeedOriginAtSend: HighspeedPaneOrigin,
    ) => {
      let onAcceptedSelection: (() => void) | undefined;
      const prepareHighspeedTurn = prepareHighspeedTurnFrom(highspeedOriginAtSend);
      const dispatchSubmissionCommand = async (...args: Parameters<typeof dispatchCommand>) => {
        if (
          args[0] === "sendText" &&
          args[2] &&
          baseWorkspaceServices.genUiService &&
          typeof args[1]?.text === "string"
        ) {
          try {
            const context = buildGenUiModelContext(
              await baseWorkspaceServices.genUiService.listState({
                workspacePath,
                workspaceIdentity,
                sessionId: args[2],
              }),
            );
            if (context) args[1] = { ...args[1], text: `${args[1].text}\n\n${context}` };
          } catch {
            // This state is supplementary context; a read failure must not block the existing CommandInbox input path.
            logger.warn("[gen-ui] Widget context unavailable");
          }
        }
        const ack = await dispatchCommand(...args);
        // Persist the recommended choice at the original accepted boundary, before transferring the draft to the new Session; failures do not change user intent.
        if (ack.status === "accepted" && submissionConfigFromCommand(args[0], args[1]))
          onAcceptedSelection?.();
        return ack;
      };
      // Frozen before entering the barrier; do not reread Composer or Session while waiting for configuration/attachments.
      let submission = options?.submission ?? null;
      const heldQueueDisposition = options?.heldQueueDisposition;
      const expectedHeldQueueItemIds = options?.expectedHeldQueueItemIds;
      const readyAttachments = options?.attachments ?? [];
      const sharedContextRefs = options?.sharedContextRefs;
      const contextAttachmentCount = options?.contextAttachmentCount ?? 0;
      let slashCommand = parseV4VisibleSlashCommand(text, readyAttachments, {
        contextAttachmentCount,
      });

      // The first `/plan` version accepts plain text only. Reject attachments/context before provider readiness
      // and any command admission; otherwise `/plan ...` would degrade into a normal prompt, bypassing the product boundary and clearing the draft.
      if (slashCommand?.kind === "unsupportedPlanShortcut") {
        toast(intl.formatMessage({ id: "chat.plan.attachmentsBlocked" }));
        return "blocked" as const;
      }

      // Bare /plan behaves like the mode menu: edit only the current Composer and do not change Agent execution state early.
      if (slashCommand?.kind === "planShortcut") {
        handleDraftSwitchMode("plan");
        if (submission) submission = { ...submission, planEnabled: true };
        if (!slashCommand.task) return "sent" as const;
      }

      if (!(await ensureDraftModelReadyForSend())) {
        return "blocked" as const;
      }

      let effectiveText = text;
      if (slashCommand?.kind === "planShortcut") {
        // The command explicitly specifies the mode for this Submission; do not rely on the ordering of another CAS command.
        effectiveText = slashCommand.task;
        // The command only configures a shortcut; the follow-up must use normal sendText and must not enter the goal/compact command branches.
        slashCommand = null;
      }
      // The user may switch tasks or create another draft while create/send ACKs are pending.
      // Bind placement to the stable identity from send start; do not read the current workspace draft in the completion callback.
      const groupedDraftTaskAtSend =
        sessionId === null
          ? useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
              .groupedDraftTask
          : null;
      const selectionSideSlashCommand =
        sessionId && (appSlashCommands?.length ?? 0) > 0
          ? parseSelectionSideSlashCommand(text, readyAttachments, {
              contextAttachmentCount,
              enabledCommandNames: availableSelectionSideSlashCommandNames,
            })
          : null;
      if (sessionId && selectionSideSlashCommand) {
        const created = await handleOpenSelectionSideConversationWithPrompt(
          selectionSideSlashCommand.text,
          options?.telemetrySeed,
        );
        return created ? ("sent" as const) : ("blocked" as const);
      }
      if (
        submission?.planEnabled &&
        slashCommand !== null &&
        (slashCommand.kind === "sendGoalCommand" ||
          slashCommand.kind === "resumeGoal" ||
          slashCommand.kind === "emptyGoal" ||
          slashCommand.kind === "unsupportedGoal")
      ) {
        // Plan mode cannot create, update, or resume a goal. Reject before draft promotion/command dispatch;
        // otherwise Composer could treat the send as successful and clear user input before the CLI rejects it.
        toast(intl.formatMessage({ id: "chat.goal.planModeBlocked" }));
        return "blocked" as const;
      }
      if (!submission) {
        logger.warn("[v4-pane] Submission 缺少完整模型或模式配置");
        return "blocked" as const;
      }
      const currentRoutingMode = snapshotRef.current?.inputRouting.mode;
      if (
        currentRoutingMode === "choice" &&
        !heldQueueDisposition &&
        (slashCommand === null || slashCommand.kind === "sendGoalCommand")
      ) {
        // The UI choice applies only to normal input and `/goal <new goal>`. `/compact` appends directly to the paused queue,
        // and control commands such as resumeGoal must not be intercepted by the send-message confirmation dialog.
        return "confirmationRequired" as const;
      }
      if (slashCommand === null || slashCommand.kind === "sendGoalCommand") {
        const original = submission.modelSelection;
        const chosen = await recommendStartPlan(original);
        if (!chosen) return "blocked" as const;
        if (chosen !== original) {
          onAcceptedSelection = captureAcceptedModelSelection(chosen, original);
          submission = { ...submission, modelSelection: chosen };
        }
      }
      const prewarmTargetBeforeSend =
        sessionId === null ? prewarmBindingRef.current?.sessionId : null;
      if (prewarmTargetBeforeSend) {
        // The barrier guarantees only that already queued commands finish. If the prewarm session/snapshot was not ready
        // when configuration was clicked, the command may not have had a target. Sync the authoritative draft configuration
        // again before binding first send to the known prewarm session, so UI and runtime values cannot diverge.
        await ensureDraftPrewarmConfigBeforeSendRef.current(prewarmTargetBeforeSend);
      }
      // Slash commands take priority: consume directly in an existing session; for a draft's first /goal, create an empty session first.
      // If attachments or web-element context are present, do not consume it as a native v4 command (compact/goal have no attachment semantics); send it as text.
      if (sessionId && slashCommand) {
        const consumed = await dispatchSlashCommand(
          slashCommand,
          sessionId,
          snapshotRef.current?.revision,
          heldQueueDisposition,
          expectedHeldQueueItemIds,
          submission,
        );
        if (consumed === "confirmationRequired") return consumed;
        if (consumed) {
          onAcceptedSelection?.();
          return;
        }
      }
      const draftSlashCommand =
        slashCommand?.kind === "sendGoalCommand" ||
        slashCommand?.kind === "resumeGoal" ||
        slashCommand?.kind === "emptyGoal" ||
        slashCommand?.kind === "unsupportedGoal"
          ? slashCommand
          : null;
      if (!sessionId && draftSlashCommand) {
        if (
          draftSlashCommand.kind === "emptyGoal" ||
          draftSlashCommand.kind === "unsupportedGoal"
        ) {
          await dispatchSlashCommand(
            draftSlashCommand,
            prewarmBindingRef.current?.sessionId ?? "__draft__",
            undefined,
            heldQueueDisposition,
            expectedHeldQueueItemIds,
            submission,
          );
          return;
        }
        const prewarm = prewarmBindingRef.current;
        if (prewarm?.beginPromotion()) {
          try {
            const consumed = await dispatchSlashCommand(
              draftSlashCommand,
              prewarm.sessionId,
              0,
              heldQueueDisposition,
              expectedHeldQueueItemIds,
              submission,
              (messageId) => reportDraftCreated(prewarm.sessionId, createSourceAtSend, messageId),
            );
            if (consumed === "confirmationRequired") return consumed;
            if (consumed) {
              onAcceptedSelection?.();
              prewarm.promote();
              handleDraftSessionCreated(
                prewarm.sessionId,
                groupedDraftTaskAtSend,
                createSourceAtSend,
              );
              return;
            }
          } catch (error) {
            if (isProviderNotReadyError(error)) throw error;
            // As with a normal first send, a transport error after writing a slash command leaves admission unknown.
            // Do not discard it and retry with a different session/command.
            logger.warn(
              `[v4-draft-prewarm] 预热会话 slash 结果未知，保留原 command 禁止自动重发: ${String(error)}`,
            );
            throw error;
          }
        }
        const draftConfigPayload = buildDraftCreateConfigPayload(
          { ...draftConfigRef.current, modelSelection: submission.modelSelection },
          appFollowupMode,
        );
        const createAck = await dispatchSubmissionCommand(
          "createSession",
          { workspaceId: workspaceKey, ...draftConfigPayload },
          null,
        );
        if (createAck.status !== "accepted") {
          throw new Error(createAck.reasonCode ?? "createSession 被拒绝");
        }
        const createResult = createAck.result;
        if (!createResult || createResult.type !== "createSession") {
          throw new Error("createSession 缺少 sessionId");
        }
        const newSessionId = createResult.sessionId;
        handleDraftSessionCreated(newSessionId, groupedDraftTaskAtSend, createSourceAtSend);
        await dispatchSlashCommand(
          draftSlashCommand,
          newSessionId,
          0,
          heldQueueDisposition,
          expectedHeldQueueItemIds,
          submission,
          (messageId) => reportDraftCreated(newSessionId, createSourceAtSend, messageId),
        );
        return;
      }
      if (!sessionId) {
        // Draft attachments were pre-uploaded in Composer and bound to the prewarm session.
        // Submit only ready refs here; do not start uploads from the send click.
        const prewarm = prewarmBindingRef.current;
        if (prewarm?.beginPromotion()) {
          try {
            const highspeed = await prepareHighspeedSendContext(
              prewarm.sessionId,
              prepareHighspeedTurn,
              submission.modelSelection,
            );
            const ack = await dispatchSubmissionCommand(
              "sendText",
              {
                text: effectiveText,
                ...submission,
                ...(options?.requestedDelivery
                  ? { requestedDelivery: options.requestedDelivery }
                  : {}),
                conversationQuotes: options?.conversationQuotes,
                ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
                ...(sharedContextRefs?.length ? { context_refs: sharedContextRefs } : {}),
                ...(options?.source ? { source: options.source } : {}),
                // Expand acceleration materials last: when this turn draws a card, its Selection takes precedence over the draft selection.
                ...highspeed.override,
              },
              prewarm.sessionId,
              undefined,
              undefined,
              options?.telemetrySeed,
              highspeed.acceleratedCard,
              undefined,
              undefined,
              // Recent records the Composer's original selection before acceleration, not the payload Selection that was overridden.
              submission,
            );
            if (ack.status === "accepted") {
              prewarm.promote();
              handleDraftSessionCreated(
                prewarm.sessionId,
                groupedDraftTaskAtSend,
                createSourceAtSend,
                ack.commandId,
              );
              return;
            }
            // A failed ACK may arrive after runtime started but the TurnStarted projection commit timed out.
            // Model/tool side effects cannot be rolled back by a failed ACK, so do not rerun with a new command automatically.
            logger.warn(
              `[v4-draft-prewarm] 预热会话首发未 accepted（${ack.reasonCode ?? ack.status}），禁止自动重发`,
            );
            throw new Error(ack.reasonCode ?? "预热会话首发未 accepted");
          } catch (error) {
            if (isProviderNotReadyError(error)) throw error;
            if (readyAttachments.length > 0) throw error;
            // Bug cause: a transport error does not prove the Agent did not admit the command; a failed ACK may also
            // arrive after runtime startup and tool side effects. The old logic always discarded the prewarm session and
            // automatically called createSession(firstInput), running the same submission twice. Preserve pending lifecycle
            // and command-reconciliation clues; let Composer retain the draft on error and never auto-resend under a new command.
            logger.warn(
              `[v4-draft-prewarm] 预热会话首发未确认成功，保留原 command 禁止自动重发: ${String(error)}`,
            );
            throw error;
          }
        }
        // Fallback: create a session here when there is no prewarm session (creation failed or it was discarded).
        // Include the draft's selected config in createSession so the CLI merges it with runtime defaults and first send uses it.
        // If fallback has a prewarm projection, use the Agent's current config as the base; use the frozen initialization tuple
        // only if no projection was ever received. Otherwise, provider fallback could write the old localStorage model back.
        const draftConfigPayload = buildDraftCreateConfigPayload(
          { ...draftConfigRef.current, modelSelection: submission.modelSelection },
          appFollowupMode,
        );
        // Highspeed cards are bound to task_id by the server, so the first send must create an
        // empty session to get the real sessionId before drawing a card and sending. Calling
        // createSession(firstInput) would bypass the shared admission path where clicking Send
        // draws first, making acceleration impossible on an attachment-free first turn; therefore
        // there is no longer a firstInput special case here.
        // A local desktop localPath is zero-copy and ready without an attachment transaction; the prewarm session may not
        // have returned yet during a short window. Create an empty session first, then submit the existing ref. The send click
        // performs no upload and cannot let a non-ready attachment bypass Composer's gate.
        const createAck = await dispatchSubmissionCommand(
          "createSession",
          { workspaceId: workspaceKey, ...draftConfigPayload },
          null,
        );
        if (createAck.status !== "accepted") {
          throw new Error(createAck.reasonCode ?? "createSession 被拒绝");
        }
        const createResult = createAck.result;
        if (!createResult || createResult.type !== "createSession") {
          throw new Error("createSession 缺少 sessionId");
        }
        const newSessionId = createResult.sessionId;
        const highspeed = await prepareHighspeedSendContext(
          newSessionId,
          prepareHighspeedTurn,
          submission.modelSelection,
        );
        const sendAck = await dispatchSubmissionCommand(
          "sendText",
          {
            text: effectiveText,
            ...submission,
            ...(options?.requestedDelivery ? { requestedDelivery: options.requestedDelivery } : {}),
            ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
            ...(sharedContextRefs?.length ? { context_refs: sharedContextRefs } : {}),
            ...(options?.source ? { source: options.source } : {}),
            ...highspeed.override,
            conversationQuotes: options?.conversationQuotes,
          },
          newSessionId,
          undefined,
          undefined,
          options?.telemetrySeed,
          highspeed.acceleratedCard,
          undefined,
          undefined,
          // Recent records the Composer's original selection before acceleration, not the payload Selection that was overridden.
          submission,
        );
        if (sendAck.status !== "accepted") {
          throw new Error(sendAck.reasonCode ?? "sendText 被拒绝");
        }
        handleDraftSessionCreated(
          newSessionId,
          groupedDraftTaskAtSend,
          createSourceAtSend,
          sendAck.commandId,
        );
        return;
      }
      // Attachment refs have already completed Composer's pre-upload state machine.
      const highspeed = await prepareHighspeedSendContext(
        sessionId,
        prepareHighspeedTurn,
        submission.modelSelection,
      );
      const ack = await dispatchSubmissionCommand(
        "sendText",
        {
          text: effectiveText,
          ...submission,
          ...(options?.requestedDelivery ? { requestedDelivery: options.requestedDelivery } : {}),
          conversationQuotes: options?.conversationQuotes,
          ...(readyAttachments.length > 0 ? { attachments: readyAttachments } : {}),
          ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
          ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
          ...(sharedContextRefs?.length ? { context_refs: sharedContextRefs } : {}),
          ...(options?.source ? { source: options.source } : {}),
          ...highspeed.override,
        },
        sessionId,
        undefined,
        undefined,
        options?.telemetrySeed,
        highspeed.acceleratedCard,
        undefined,
        undefined,
        // Recent records the Composer's original selection before acceleration, not the payload Selection that was overridden.
        submission,
      );
      if (ack.reasonCode === "guard.heldQueueConfirmationStale") {
        return "confirmationRequired" as const;
      }
      if (ack.status !== "accepted") {
        throw new Error(ack.reasonCode ?? "sendText 被拒绝");
      }
      if (heldQueueDisposition === "clearQueueAndSend") {
        settleCurrentQueueInputs(sessionId);
      }
    },
    [
      dispatchCommand,
      recommendStartPlan,
      baseWorkspaceServices,
      captureAcceptedModelSelection,
      dispatchSlashCommand,
      ensureDraftModelReadyForSend,
      availableSelectionSideSlashCommandNames,
      appSlashCommands,
      appFollowupMode,
      handleDraftSessionCreated,
      reportDraftCreated,
      handleDraftSwitchMode,
      handleOpenSelectionSideConversationWithPrompt,
      intl,
      prepareHighspeedTurnFrom,
      resolveInitialDraftConfig,
      createSubmissionFromComposer,
      sessionId,
      settleCurrentQueueInputs,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );

  const dispatchSendText = useCallback(
    (text: string, options?: ConversationComposerSendOptions) => {
      const createSource = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspacePath, workspaceIdentity).draftCreateSource;
      const submissionOptions = {
        ...options,
        submission:
          options?.submission === undefined ? createSubmissionFromComposer() : options.submission,
      };
      // Freeze the Highspeed send origin before entering the config barrier; the user may switch Tasks during the barrier or later awaits.
      const highspeedOrigin = captureHighspeedPaneOrigin();
      // followupMode is still synchronized through Session CAS. Model and mode are carried in Submission,
      // so behavior no longer depends on cross-command ordering between configuration and sendText.
      return configCommandBarrier.enqueue(async () => {
        try {
          return await dispatchSendTextAfterConfig(
            text,
            submissionOptions,
            createSource,
            highspeedOrigin,
          );
        } catch (error) {
          if (sessionId === null && isProviderNotReadyError(error)) {
            // The registry can still become invalid between the UI precheck and Host getClient. If the race occurs,
            // use the same normal waiting state; do not take the error-send path or clear Composer.
            markDraftProviderNotReady();
            return "blocked" as const;
          }
          throw error;
        }
      });
    },
    [
      captureHighspeedPaneOrigin,
      configCommandBarrier,
      createSubmissionFromComposer,
      dispatchSendTextAfterConfig,
      markDraftProviderNotReady,
      sessionId,
      workspacePath,
      workspaceIdentity,
    ],
  );

  const focusTimelineToLatest = useCallback(() => {
    timelineScrollToBottomRef.current?.();
  }, []);

  const handleSendText = useCallback(
    async (
      text: string,
      options?: ConversationComposerSendOptions,
    ): Promise<ConversationComposerSendResult> => {
      // Freeze this admission expectation before sending: the projection may already be running when command ACK returns,
      // so the updated enqueue mode cannot tell whether this prompt was originally sent immediately.
      const shouldFocusLatest = shouldFocusTimelineAfterComposerSend({
        draftMode: sessionId === null,
        inputRoutingMode: snapshotRef.current?.inputRouting.mode ?? null,
        heldQueueDisposition: options?.heldQueueDisposition,
      });
      try {
        const sendResult = await dispatchSendText(text, options);
        if (sendResult === "blocked" || sendResult === "confirmationRequired") {
          return sendResult;
        }
        setSendSubmissionError(null);
        if (shouldFocusLatest) {
          focusTimelineToLatest();
        }
        return "sent";
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const runtimeModelUnavailable = detail.includes("provider.notInRegistry");
        // Before first send, switchModelConfig failures are thrown back to Composer. To preserve the draft, Composer
        // only logs them and does not set snapshot.control.lastError, so the user sees no response to the click.
        // Surface pre-admission failures in a pane-local error banner. This does not change Desktop continuous or
        // Web remote replayable send/recovery semantics; Composer retains the draft through its existing path.
        setSendSubmissionError({
          code: runtimeModelUnavailable ? "ZCODE_RUNTIME_MODEL_UNAVAILABLE" : "SEND_FAILED",
          message: runtimeModelUnavailable
            ? detail
            : intl.formatMessage({ id: "chat.error.sendFailed" }),
          detail,
          ...(sessionId ? { taskId: sessionId } : {}),
        });
        throw error;
      }
    },
    [dispatchSendText, focusTimelineToLatest, intl, sessionId],
  );
  // The only assignment point for the ref above (see handleSendWorkflowSaveRequest for context).
  sendTextRef.current = handleSendText;

  const handleComposerDraftStateChange = useCallback(
    (state: { hasContent: boolean; busy: boolean }) => {
      composerDraftStateRef.current = state;
    },
    [],
  );
  const clearQueueEditOperation = useCallback(() => {
    queueEditOperationRef.current = null;
    setQueueEditOperation(null);
  }, []);
  const handleComposerRestoreApplied = useCallback(
    (requestId: number) => {
      setComposerRestoreRequest((current) => (current?.requestId === requestId ? null : current));
      clearQueueEditOperation();
    },
    [clearQueueEditOperation],
  );
  const handleHighspeedActivationApplied = useCallback((cardId: string) => {
    // Consume by cardId so a late callback from an old card cannot clear a new card's activation request.
    setHighspeedActivationCardId((current) => (current === cardId ? null : current));
  }, []);

  const handleFork = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // forkAssistant is a CAS command; take baseRevision from the current projection revision.
      void dispatchCommand(
        "forkAssistant",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "duplicate") {
          logger.warn(`[v4-pane] fork 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          return;
        }
        if (ack.result?.type === "forkAssistant") {
          // Switch this pane in place to the child session (the same selection path as a newly created session).
          onSessionCreated?.(ack.result.sessionId);
        }
      });
    },
    [dispatchCommand, onSessionCreated, sessionId],
  );

  const handleEdit = useCallback(
    async (
      target: ConversationRowTarget,
      newText: string,
      attachments?: readonly AttachmentRef[],
      workspaceMode: "preserve" | "rewind" = "preserve",
      conversationQuotes?: import("@zcode/shared").ConversationSelectionText[],
    ) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return false;
      if (
        !newText.trim() &&
        (!attachments || attachments.length === 0) &&
        !conversationQuotes?.length
      ) {
        logger.warn("[v4-pane] edit 跳过：行内编辑内容为空且无附件");
        return false;
      }
      const highspeed = await prepareHighspeedSendContext(
        sessionId,
        prepareHighspeedTurnFrom(captureHighspeedPaneOrigin()),
      );
      const latest = snapshotRef.current;
      if (!latest || latest.sessionId !== sessionId) {
        logger.warn("[v4-pane] edit 跳过：Highspeed prepare 后 session 已切换");
        return false;
      }
      const ack = await dispatchCommand(
        "editUserQuery",
        {
          target,
          newText,
          workspaceMode,
          conversationQuotes,
          // If attachments is omitted from editUserQuery, keep the canonical original attachments.
          // Only an explicit [] lets the CLI distinguish "user removed all" from "caller did not change attachments".
          ...(attachments ? { attachments: [...attachments] } : {}),
          ...highspeed.override,
        },
        sessionId,
        latest.revision,
        latest.logEpoch,
        undefined,
        highspeed.acceleratedCard,
      );
      if (ack.status !== "accepted" && ack.status !== "duplicate") {
        logger.warn(`[v4-pane] edit 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        return false;
      }
      // fork ACK is decoded only for compatibility with the old protocol; new edits never navigate to a child. Inline conflict dialogs handle blocked results.
      return ack;
    },
    [captureHighspeedPaneOrigin, dispatchCommand, prepareHighspeedTurnFrom, sessionId],
  );

  const dispatchRetryTurn = useCallback(
    async (target: ConversationRowTarget): Promise<CommandAck> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) {
        throw new Error("retryTurn 缺少当前 session 投影");
      }
      // retryTurn is a CAS command; take baseRevision from the current projection revision.
      return dispatchCommand(
        "retryTurn",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleRetry = useCallback(
    (target: ConversationRowTarget) => {
      void dispatchRetryTurn(target)
        .then((ack) => {
          if (ack.status !== "accepted") {
            logger.warn(`[v4-pane] retry 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
        })
        .catch((error: unknown) => {
          logger.warn("[v4-pane] retry 提交失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [dispatchRetryTurn],
  );

  const handleAssistantFeedback = useCallback(
    async (
      target: ConversationRowTarget,
      feedback: "like" | "dislike" | null,
    ): Promise<boolean> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return false;
      const ack = await dispatchCommand(
        "setAssistantFeedback",
        { target, feedback },
        sessionId,
        current.revision,
        current.logEpoch,
      );
      const accepted = ack.status === "accepted" || ack.status === "duplicate";
      if (!accepted) {
        logger.warn(`[v4-pane] assistant 反馈被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
      return accepted;
    },
    [dispatchCommand, sessionId],
  );

  const handleDeleteQueueItem = useCallback(
    (queueItemId: string) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      const sourceCommandId = current.queue.items.find(
        (item) => item.queueItemId === queueItemId,
      )?.sourceCommandId;
      void dispatchCommand("deleteQueueItem", { queueItemId }, sessionId, current.revision).then(
        (ack) => {
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(`[v4-pane] deleteQueueItem 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
            return;
          }
          if (sourceCommandId) pendingCommandRegistry.settle(sessionId, sourceCommandId);
        },
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleEditQueueItem = useCallback(
    async (queueItemId: string): Promise<void> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null || queueEditOperationRef.current) return;
      if (composerDraftStateRef.current.hasContent || composerDraftStateRef.current.busy) {
        toast(intl.formatMessage({ id: "chat.queue.editDraftConflict" }));
        return;
      }
      const restoreTarget = resolveQueuedComposerRestore(current, queueItemId);
      if (!restoreTarget) {
        logger.warn(`[v4-pane] queue 撤回编辑跳过：queue item 不存在或不可编辑 ${queueItemId}`);
        return;
      }
      const operation = { queueItemId, sessionId, workspaceKey };
      queueEditOperationRef.current = operation;
      setQueueEditOperation(operation);
      try {
        const ack = await dispatchCommand(
          "deleteQueueItem",
          { queueItemId },
          sessionId,
          restoreTarget.baseRevision,
        );
        if (!shouldRestoreQueuedComposerFromAck(ack.status)) {
          logger.warn(`[v4-pane] queue 撤回编辑被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          toast(intl.formatMessage({ id: "chat.queue.editRestoreFailed" }));
          clearQueueEditOperation();
          return;
        }
        pendingCommandRegistry.settle(sessionId, restoreTarget.sourceCommandId);
        const currentBinding = composerBindingRef.current;
        if (
          currentBinding.sessionId !== sessionId ||
          currentBinding.workspaceKey !== workspaceKey
        ) {
          // The pane may switch tasks before the delete ACK returns. Directly calling setText would write
          // the old session's queue payload into the new task. Keep the authoritative deletion, but skip local restoration.
          logger.warn("[v4-pane] queue 撤回编辑未恢复：ACK 返回前 composer 已切换", {
            queueItemId,
            sessionId,
            workspaceKey,
          });
          clearQueueEditOperation();
          return;
        }
        setComposerRestoreRequest({
          requestId: nextComposerRestoreRequestIdRef.current++,
          sessionId,
          workspaceKey,
          inputKind: restoreTarget.inputKind,
          text: restoreTarget.text,
          attachments: restoreTarget.attachments,
          config: restoreTarget.config,
        });
      } catch (error) {
        logger.warn("[v4-pane] queue 撤回编辑命令失败", error);
        toast(intl.formatMessage({ id: "chat.queue.editRestoreFailed" }));
        clearQueueEditOperation();
      }
    },
    [clearQueueEditOperation, dispatchCommand, intl, sessionId, workspaceKey],
  );

  const handleSendQueuedNow = useCallback(
    (queueItemId: string) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // When the user explicitly clicks "Send now", the visual intent is equivalent to clicking "Scroll to bottom".
      // The CLI still owns the command's reserve/stop/promote lifecycle; do not put scroll state into the protocol.
      focusTimelineToLatest();
      const highspeedOrigin = captureHighspeedPaneOrigin();
      void (async () => {
        const queueItem = current.queue.items.find((item) => item.queueItemId === queueItemId);
        let highspeedOverride: HighspeedSendContext["override"] = {};
        if (queueItem?.highspeed && queueItem.highspeed.expiresAt > Date.now()) {
          const refreshed = await prepareHighspeedSendContext(
            sessionId,
            prepareHighspeedTurnFrom(highspeedOrigin),
          );
          // Root cause: the CLI's staged runtime can be missing across an async boundary; manual
          // promotion supplies a new runtime for the same card. If the service returns a different
          // card, do not silently rebind the original queue intent to it.
          if (refreshed.acceleratedCard?.cardId === queueItem.highspeed.cardId) {
            highspeedOverride = refreshed.override;
          }
        }
        const latest = snapshotRef.current;
        const latestQueueItem = latest?.queue.items.find(
          (item) => item.queueItemId === queueItemId,
        );
        if (!latest || latest.sessionId !== sessionId || !latestQueueItem) {
          logger.warn("[v4-pane] sendQueuedNow 跳过：Highspeed prepare 后队列状态已变化", {
            queueItemId,
          });
          return null;
        }
        return dispatchCommand(
          "sendQueuedNow",
          { queueItemId, ...highspeedOverride },
          sessionId,
          latest.revision,
        );
      })().then((ack) => {
        if (!ack) return;
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] sendQueuedNow 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [
      captureHighspeedPaneOrigin,
      dispatchCommand,
      focusTimelineToLatest,
      prepareHighspeedTurnFrom,
      sessionId,
    ],
  );

  const handleReorderQueueItem = useCallback(
    (queueItemId: string, beforeQueueItemId: string | null) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      void dispatchCommand(
        "reorderQueueItem",
        { queueItemId, beforeQueueItemId },
        sessionId,
        current.revision,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] reorderQueueItem 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  const handleResumeQueue = useCallback(async () => {
    const current = snapshotRef.current;
    if (!sessionId || !current || current.queue.autoDrain || current.queue.items.length === 0) {
      return;
    }
    const ack = await dispatchCommand(
      "setAutoDrain",
      { autoDrain: true },
      sessionId,
      current.revision,
    );
    if (ack.status !== "accepted" && ack.status !== "noop") {
      logger.warn(`[v4-pane] 恢复暂停队列被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
    }
  }, [dispatchCommand, sessionId]);

  // Retry stale configuration CAS commands. During sequential model → thinking-depth → mode changes, the prior command's
  // revision bump may not yet have reached the local projection, so CAS can reject the local revision as stale.
  // A stale ACK includes revisionAtDecision (the CLI's current revision); retry with it to converge (up to 3 attempts).
  // m5 target: the effective session (bound session or draft prewarm session). The projection must match the target
  // (verified by snapshot.sessionId) to avoid using the wrong revision during a prewarm switch.
  const dispatchConfigCas = useCallback(
    async (
      type: CommandType,
      payload: Record<string, unknown>,
      options?: { initialBaseRevision?: number; targetSessionId?: string },
    ): Promise<CommandAck | null> => {
      const targetSessionId =
        options?.targetSessionId ?? sessionId ?? prewarmBindingRef.current?.sessionId ?? null;
      const current = snapshotRef.current;
      if (!targetSessionId) {
        recordV4CommandAck({
          type: `ui:${type}`,
          status: "skipped",
          reasonCode: "no-session",
          at: Date.now(),
        });
        return null;
      }
      // When the draft prewarm session exists but its snapshot has not been projected yet, the old logic skipped
      // configuration CAS, so first send used the runtime build default. CAS supports stale-revision retries,
      // so starting at 0 without a snapshot still converges; do not treat "not projected" as success.
      let baseRevision =
        options?.initialBaseRevision ??
        (current?.sessionId === targetSessionId ? current.revision : 0);
      let lastAck: CommandAck | null = null;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const ack = await dispatchCommand(type, payload, targetSessionId, baseRevision);
          lastAck = ack;
          if (ack.status === "stale") {
            baseRevision = ack.revisionAtDecision;
            continue;
          }
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(`[v4-pane] ${type} 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
          return ack;
        }
        logger.warn(`[v4-pane] ${type} 连续 stale，放弃重试`);
        return lastAck;
      } catch (error) {
        if (isProviderNotReadyError(error)) {
          // If a provider-readiness race is swallowed by configuration CAS as null, first send becomes missing-ack
          // and the draft page cannot recover to model setup guidance. Propagate deterministic startup gates unchanged.
          throw error;
        }
        // Renderer logs are disabled in production; put exceptions in the ACK debug buffer so they are not silently lost.
        recordV4CommandAck({
          type: `ui:${type}`,
          status: "dispatch-error",
          reasonCode: String(error),
          at: Date.now(),
        });
        logger.warn(`[v4-pane] ${type} 失败: ${String(error)}`);
        return null;
      }
    },
    [dispatchCommand, sessionId],
  );
  const ensureDraftPrewarmConfigBeforeSend = useCallback(
    async (targetSessionId: string) => {
      // followupMode remains a Session behavior setting. Model and mode belong to this Submission and are submitted
      // atomically with sendText; do not rewrite the shared Session through CAS before sending.
      const desiredConfig = buildDraftCreateConfigPayload(
        draftConfigRef.current,
        appFollowupMode,
      ).config;
      if (!desiredConfig) return;
      const projectedConfig =
        snapshotRef.current?.sessionId === targetSessionId ? snapshotRef.current.config : null;

      const requireAcceptedConfigAck = (type: CommandType, ack: CommandAck | null) => {
        if (
          ack &&
          (ack.status === "accepted" || ack.status === "noop" || ack.status === "duplicate")
        ) {
          return;
        }
        throw new Error(
          `${type} 未在首发前收敛: ${ack?.status ?? "missing-ack"} ${ack?.reasonCode ?? ""}`,
        );
      };

      if (
        desiredConfig.followupMode &&
        desiredConfig.followupMode !== projectedConfig?.followupMode
      ) {
        const ack = await dispatchConfigCas(
          "setFollowupMode",
          { mode: desiredConfig.followupMode },
          { targetSessionId },
        );
        requireAcceptedConfigAck("setFollowupMode", ack);
      }
    },
    [appFollowupMode, dispatchConfigCas, draftConfigRef],
  );
  ensureDraftPrewarmConfigBeforeSendRef.current = ensureDraftPrewarmConfigBeforeSend;

  const followupModeSyncKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const targetSessionId = sessionId ?? prewarmSessionId;
    if (!targetSessionId || !appFollowupMode || snapshotRevision === null) return;
    if (snapshotSessionId !== targetSessionId) return;
    if (snapshotFollowupMode === appFollowupMode) {
      followupModeSyncKeyRef.current = `${targetSessionId}:${appFollowupMode}:synced`;
      return;
    }
    const syncKey = `${targetSessionId}:${appFollowupMode}:${snapshotRevision}`;
    if (followupModeSyncKeyRef.current === syncKey) return;
    followupModeSyncKeyRef.current = syncKey;
    // The app settings page is the source of truth for this interaction setting; v4 projection followupMode is only
    // the CLI/runtime sync result. Forward setting changes through the existing setFollowupMode command so Composer
    // does not expose a duplicate "append mode" entry that could make the layers diverge.
    void configCommandBarrier.enqueue(() =>
      dispatchConfigCas("setFollowupMode", { mode: appFollowupMode }),
    );
  }, [
    appFollowupMode,
    configCommandBarrier,
    dispatchConfigCas,
    prewarmSessionId,
    sessionId,
    snapshotFollowupMode,
    snapshotRevision,
    snapshotSessionId,
  ]);

  // Composer selection applies to the next submission. Clicking updates only renderer intent; CLI/Core updates
  // Session Selection when the Submission actually starts (for Guide, at the next model step).
  const handleSelectModel = useCallback(
    (modelProvider: string, model: string, sourceModel: ModelSelectionSource | null) => {
      // The acceleration card has locked Selection to its model for this turn, so the model menu
      // is unavailable. If a shortcut or race still invokes this, show a clear message instead of
      // silently changing the draft to another model.
      if (activeHighspeedCard) {
        toast(intl.formatMessage({ id: "chat.highspeed.modelLocked" }));
        return;
      }
      const resolvedProvider =
        modelProvider || draftConfigRef.current.provider || sourceModel?.provider || "";
      logger.debug("[v4-pane] onSelectModel", {
        modelProvider: resolvedProvider,
        model,
        branch: "composer-submission-intent",
      });
      handleDraftSelectModel(resolvedProvider, model);
    },
    [activeHighspeedCard, draftConfigRef, handleDraftSelectModel, intl],
  );

  const handleSelectThought = useCallback(
    (thought: string, _modelContext: { provider: string; model: string }) => {
      handleDraftSelectThought(thought);
    },
    [handleDraftSelectThought],
  );

  const handleRecoverCustomModelSelection = useCallback(
    async (value: string, sourceModel: ModelSelectionSource | null) => {
      const decoded = decodeCustomModelValue(value);
      if (!decoded?.providerId) {
        return;
      }
      const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
      let modelValue = value;
      if (!decoded.modelName) {
        const fallbackModel =
          modelSelectionView?.providers.find(
            (candidate) => candidate.providerId === decoded.providerId,
          )?.models[0]?.modelId ?? (modelSelectionView ? null : undefined);
        if (!fallbackModel) {
          logger.warn("[v4-pane] custom provider 恢复跳过：provider 没有可用模型", {
            customProviderId: decoded.providerId,
            workspacePath,
          });
          return;
        }
        modelValue = encodeCustomModelValue(decoded.providerId, fallbackModel);
      }
      const modelSelection = parseModelPickerValue(modelValue);
      // Bug cause: selecting a custom provider from a configOptions error bypasses normal onSelectModel.
      // Bound tasks still use the same notice entry point; the entry point suppresses it for drafts.
      showModelChangeNotice(sourceModel, {
        provider: modelSelection.providerId,
        model: modelSelection.modelId,
      });
      const store = useZCodeSessionStore.getState();
      store.setModelSelectionResolution(
        workspacePath,
        {
          selectedSupplierKey: buildCustomSupplierKey(decoded.providerId),
          isGhostSupplier: false,
          supplierMismatchReason: null,
        },
        workspaceIdentity,
      );
      store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
      logger.info("[v4-pane] configOptions error custom provider recovery start", {
        modelId: modelSelection.modelId,
        providerId: modelSelection.providerId,
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      });

      try {
        await zcodeTaskService.restartWorkspaceProcess({
          workspacePath,
          workspaceIdentity,
          provider: displayProvider,
          bumpRuntimeEpoch: true,
        });

        const prepareResult = await prepareWorkspaceWithZCodeSessionService({
          workspacePath,
          workspaceIdentity,
          provider: displayProvider,
          zcodeSessionService,
        });
        handleDraftSelectModel(modelSelection.providerId, modelSelection.modelId);
        store.setConfigOptions(workspacePath, prepareResult.configOptions ?? [], workspaceIdentity);
        store.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        store.setSlashCommands(workspacePath, prepareResult.slashCommands ?? [], workspaceIdentity);
        logger.info("[v4-pane] configOptions error custom provider recovery done", {
          configOptionsCount: prepareResult.configOptions?.length ?? 0,
          modelId: modelSelection.modelId,
          providerId: modelSelection.providerId,
          workspacePath,
        });
      } catch (error) {
        store.setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn("[v4-pane] configOptions error custom provider recovery failed", {
          error: error instanceof Error ? error.message : String(error),
          modelId: modelSelection.modelId,
          providerId: modelSelection.providerId,
          workspacePath,
        });
        throw error;
      }
    },
    [
      provider,
      handleDraftSelectModel,
      sessionId,
      showModelChangeNotice,
      workspaceIdentity,
      workspacePath,
      zcodeSessionService,
      zcodeTaskService,
    ],
  );

  // Like the model, mode belongs to the next Submission; selecting it updates only Composer.
  const handleSwitchMode = useCallback(
    (mode: string) => {
      handleDraftSwitchMode(mode);
    },
    [handleDraftSwitchMode],
  );

  // Compact entry point in the context-usage panel (command text is "/compact" and reuses slash parsing).
  const handleSendCompressionCommand = useCallback(
    (command: string) => {
      if (!sessionId) return;
      const parsed = parseV4VisibleSlashCommand(command);
      if (!parsed) return;
      void dispatchSlashCommand(parsed, sessionId, snapshotRef.current?.revision, undefined);
    },
    [dispatchSlashCommand, sessionId],
  );

  // Stop diagnostics must distinguish button clicks from Esc; regular info logs are disabled in production, so use lifecycle logging.
  const handleStop = useCallback(
    (source: "button" | "escape") => {
      const current = snapshotRef.current;
      if (!sessionId || !current?.control.canStop) {
        logger.lifecycle.info("[v4-pane] stop 命令被跳过（无可停执行）", {
          source,
          sessionId: sessionId ?? "",
        });
        return;
      }
      const foregroundExecutionId = current.control.activeWorks.find(
        (work) => work.foregroundExecutionId,
      )?.foregroundExecutionId;
      logger.lifecycle.info("[v4-pane] stop 命令发出", {
        source,
        sessionId,
        foregroundExecutionId: foregroundExecutionId ?? "",
      });
      void dispatchCommand(
        "stop",
        foregroundExecutionId ? { expectedForegroundExecutionId: foregroundExecutionId } : {},
        sessionId,
      ).catch((error) => {
        logger.lifecycle.warn(`[v4-pane] stop 失败: ${String(error)}`);
      });
    },
    [dispatchCommand, sessionId],
  );

  const handlePauseGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.pauseGoal.allowed) return;
    void dispatchCommand("pauseGoal", {}, sessionId, current.revision).then((ack) => {
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(`[v4-pane] pauseGoal 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
    });
  }, [dispatchCommand, sessionId]);

  const handleResumeGoal = useCallback(() => {
    const current = snapshotRef.current;
    if (!sessionId || !current?.availability.resumeGoal.allowed) return;
    void dispatchCommand("resumeGoal", {}, sessionId, current.revision).then((ack) => {
      if (ack.status !== "accepted" && ack.status !== "noop") {
        logger.warn(`[v4-pane] resumeGoal 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
    });
  }, [dispatchCommand, sessionId]);

  // Composer parity: Esc → stop, preserving the old useChatViewEffects "Escape stops generation" behavior.
  // Skip events from dialogs or with defaultPrevented; when mention/slash panels are open, Lexical already
  // calls preventDefault and this handler naturally yields. Only the focused pane listens:
  // stop and other dangerous actions always target an explicit pane; shortcuts target the focused pane.
  useEffect(() => {
    if (!focused || readOnly) return;
    if (!sessionId || !snapshot?.control.canStop) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (shouldIgnoreEscapeForStopGeneration(event)) return;
      event.preventDefault();
      handleStop("escape");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focused, handleStop, readOnly, sessionId, snapshot?.control.canStop]);

  // handleStop takes a source parameter (button/escape), but ConversationComposer is memoized.
  // Writing onStop={() => handleStop("button")} inline would create a new reference on every render and defeat memoization;
  // Composer may re-render on every keystroke. Keep a stable button callback without changing handleStop's two-entry design.
  const handleStopFromButton = useCallback(() => handleStop("button"), [handleStop]);

  const handleRetrySubscribe = useCallback(() => {
    void lease?.store.retry();
  }, [lease]);

  // Trigger loadOlder (automatic prefetch near the top); the store prevents concurrent duplicate requests.
  const handleLoadOlder = useCallback(() => {
    return lease?.store.loadOlder();
  }, [lease]);

  const handleLoadAllOlder = useCallback(() => {
    return lease
      ? lease.store.loadAllOlder()
      : Promise.resolve({
          status: "stale" as const,
          logEpoch: snapshot?.logEpoch ?? "unknown",
        });
  }, [lease, snapshot?.logEpoch]);

  useEffect(() => {
    if (!shareActive || !sessionId || !hasOlderRows(snapshot)) return;
    const key = `${sessionId}:${snapshot?.logEpoch ?? "unknown"}`;
    if (shareHydratedSessionRef.current === key) return;
    shareHydratedSessionRef.current = key;
    void handleLoadAllOlder().catch((error) => {
      shareHydratedSessionRef.current = null;
      logger.warn("[conversation-share] 补齐分享目录失败", { error });
    });
  }, [handleLoadAllOlder, sessionId, shareActive, snapshot]);

  useEffect(() => {
    if (
      !sessionId ||
      !lease?.store ||
      !shouldAutoLoadIncompleteLeadingTurn(snapshot, state.loadingOlder)
    ) {
      return;
    }
    const firstRowId = snapshot?.rows.window[0]?.rowId;
    if (firstRowId === undefined) return;
    const cursorKey = `${sessionId}:${state.subscriptionId ?? "connecting"}:${firstRowId}`;
    if (autoLoadIncompleteTurnCursorRef.current === cursorKey) return;
    autoLoadIncompleteTurnCursorRef.current = cursorKey;

    // snapshotTailWindowRows trims by row and may leave a long turn's header/user outside the window.
    // The old UI called loadOlder only when a scroll event reached the top; if content was shorter than one screen or
    // scrollTop was already 0, no event fired. Only the assistant rendered until the user scrolled down and back up.
    // Immediately fill windows when the first turn lacks a header; cursor deduplication prevents loops on empty ranges or failures.
    logger.debug("[v4-pane] 冷快照首 turn 不完整，自动补拉更早行", {
      firstRowId,
      sessionId,
      turnId: snapshot?.rows.window[0]?.turnId,
    });
    void lease.store.loadOlder();
  }, [lease, sessionId, snapshot, state.loadingOlder, state.subscriptionId]);

  // The subscribe ACK marks the store live before the initial snapshot arrives. Checking status alone would enable
  // the editor during a window with no projection. A real session must wait for its first snapshot before accepting input.
  const connecting = sessionId !== null && (state.status === "connecting" || snapshot === null);
  const queueEditActiveForCurrentComposer =
    queueEditOperation?.sessionId === sessionId && queueEditOperation.workspaceKey === workspaceKey;
  const errored = sessionId !== null && state.status === "error";
  useSessionSubscriptionErrorTelemetry({
    supervisor: conversationTelemetry,
    sessionId,
    lastError: state.lastError,
    visible: errored && telemetryVisible && conversationTelemetryForegroundEnabled,
  });
  // Retry eligibility is decided by the authoritative row projection. This only provides the command capability;
  // whether the entry is shown comes entirely from row.actions.canRetry. Do not add a second guard based on pane phase.
  const retryActionsEnabled = !readOnly && !selectionSideChat && Boolean(sessionId);
  // Fork availability is decided entirely by row.actions.canFork (projected by the CLI stable resolver); the pane only provides the command callback.
  const forkActionsEnabled = !readOnly && !selectionSideChat && Boolean(sessionId);
  // The command layer already validates editUserQuery against the latest real user query and, while running,
  // uses a stop barrier before rewind/rerun. The UI should not hide the entire entry behind a completed gate.
  const editActionsEnabled = !readOnly && !selectionSideChat && Boolean(sessionId);
  const isDraft = sessionId === null;
  // Scroll restoration must use a lease projection matching sessionId. A session-switch render and passive effect
  // do not happen at the same time. If old-lease rows reach the timeline early, the new saved position is clamped
  // to the old content height, and later target rows cannot distinguish this temporary position.
  const timelineSnapshot =
    !isDraft && (lease === null || sessionLeaseReady) && snapshot?.sessionId === sessionId
      ? snapshot
      : null;
  const shareHandoverContext =
    snapshot?.sharedContextImport && "contextId" in snapshot.sharedContextImport
      ? snapshot.sharedContextImport
      : null;
  // Imported shared conversations: read persisted public rows for the read-only block at the top of the session.
  // The share page may have expired or not launched, so read the local copy without fetching from the source.
  const [importedShare, setImportedShare] = useState<ImportedConversationShare | null>(null);
  const importedShareContextId =
    shareHandoverContext && shareHandoverContext.status !== "discarded"
      ? shareHandoverContext.contextId
      : null;
  useEffect(() => {
    if (!importedShareContextId || compactForRemoteControl) {
      setImportedShare(null);
      return;
    }
    let disposed = false;
    void conversationShareService
      .getImportedConversation({
        workspacePath,
        contextId: importedShareContextId,
      })
      .then((imported) => {
        if (disposed) return;
        setImportedShare(imported);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        // The read-only block is an enhancement; if it cannot be read, omit it without interrupting the session.
        logger.warn("[conversation-share] 读取导入的分享对话失败", { error });
        setImportedShare(null);
      });
    return () => {
      disposed = true;
    };
  }, [compactForRemoteControl, conversationShareService, importedShareContextId, workspacePath]);
  // When normalizeConversationShareMarkdown cannot find a matching name in artifactNames, it replaces the file
  // reference in the body with an empty string (removing it). Without this mapping, file references silently disappear from the read-only block.
  const importedShareArtifactNames = useMemo(
    () =>
      new Map(
        (importedShare?.artifacts ?? []).map((artifact) => [
          artifact.artifactId,
          artifact.displayName,
        ]),
      ),
    [importedShare],
  );
  const importedShareArtifactWorkspaceRelativePaths = useMemo(() => {
    const entries: Array<[string, string]> = [];
    for (const artifact of importedShare?.artifacts ?? []) {
      if (artifact.workspaceRelativePath) {
        entries.push([artifact.artifactId, artifact.workspaceRelativePath]);
      }
    }
    return new Map(entries);
  }, [importedShare]);
  useLayoutEffect(() => {
    if (
      compactForRemoteControl ||
      !timelineBottomRequest ||
      timelineBottomRequest.taskId !== sessionId ||
      !importedShare ||
      importedShare.contextId !== importedShareContextId
    ) {
      return;
    }
    // The share block mounts asynchronously. Keep the request until the target task and local copy are ready, then consume it after layout stabilizes.
    const scrollToBottom = () => {
      const action = timelineScrollToBottomRef.current;
      if (!action) return false;
      action();
      return true;
    };
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      scrollToBottom();
      secondFrame = window.requestAnimationFrame(() => {
        if (!scrollToBottom()) return;
        useZCodeSessionStore
          .getState()
          .clearTimelineBottomRequest(
            workspacePath,
            timelineBottomRequest.requestId,
            workspaceIdentity,
          );
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [
    compactForRemoteControl,
    importedShare,
    importedShareContextId,
    sessionId,
    timelineBottomRequest,
    workspaceIdentity,
    workspacePath,
  ]);
  const handleOpenImportedShareUrl = useCallback(() => {
    if (!shareHandoverContext || !onOpenBrowserUrl) return;
    // Persist the canonical /cn/share/ path; localize only when displaying/opening it based on the UI language.
    onOpenBrowserUrl(localizeConversationShareUrl(shareHandoverContext.shareUrl, locale));
  }, [locale, onOpenBrowserUrl, shareHandoverContext]);
  const initialDraftConfigForDiagnostics = isDraft ? resolveInitialDraftConfig() : undefined;
  const telemetryDraftConfig = draftConfig;
  // CLI V4 projection is the sole authority for running/count/manifest. The renderer no longer queries again after spawn
  // to build a second state, avoiding lost updates when concurrent children have in-flight refreshes.
  const subagents = snapshot?.subagents ?? EMPTY_SUBAGENT_PROJECTION;
  useEffect(() => {
    if (!sessionId || subagents.revision === 0 || !onSyncSubagentSessionTabs) return;
    onSyncSubagentSessionTabs({
      rootSessionId: rootSessionId ?? sessionId,
      parentSessionId: sessionId,
      validChildSessionIds: subagents.childSessionIds,
    });
  }, [
    onSyncSubagentSessionTabs,
    rootSessionId,
    sessionId,
    subagents.childSessionIds,
    subagents.revision,
  ]);
  useEffect(() => {
    if (!selectionSideChat || !sessionId) return;
    setSelectionSideChatBlocked(sessionId, Boolean(blockingInteractionId));
    return () => setSelectionSideChatBlocked(sessionId, false);
  }, [blockingInteractionId, selectionSideChat, sessionId]);
  const isOfficeMode = useIsOfficeMode();
  const statusPanelModel = useMemo(
    () =>
      buildConversationStatusPanelModel({
        isOfficeMode,
        workspacePath,
        gitSummary,
        gitDirtyFileCount,
        gitWorktreeChangeSummary,
        goal: selectionSideChat ? null : (snapshot?.goal ?? null),
        sessionPlans: state.sessionPlans,
        plan: snapshot?.plan ?? null,
        backgroundWorks: snapshot?.backgroundWorks ?? [],
        runningSubagents: subagents.running,
        workflowRuns: snapshot?.workflowRuns?.runs ?? [],
      }),
    [
      isOfficeMode,
      gitDirtyFileCount,
      gitSummary,
      gitWorktreeChangeSummary,
      snapshot?.backgroundWorks,
      snapshot?.goal,
      snapshot?.plan,
      snapshot?.workflowRuns,
      state.sessionPlans,
      selectionSideChat,
      subagents.running,
      workspacePath,
    ],
  );
  const runningBackgroundWorkCount =
    statusPanelModel.runningBashWorks.length +
    statusPanelModel.runningSubagentWorks.length +
    statusPanelModel.runningWorkflowRuns.length;
  const runningTerminalCount = statusPanelModel.runningBashWorks.length;
  const runningAgentCount = statusPanelModel.runningSubagentWorks.length;
  const runningWorkflowCount = statusPanelModel.runningWorkflowRuns.length;
  useEffect(() => {
    setTerminalSectionOpen(false);
    setAgentSectionOpen(false);
  }, [sessionId]);
  useEffect(() => {
    if (runningTerminalCount === 0) {
      setTerminalSectionOpen(false);
    }
  }, [runningTerminalCount]);
  // The Workflow section follows whether a live run exists (docs/dynamic-workflow/presentation.md,
  // “Other places a run appears”): expand when the running count goes from 0 to ≥1, collapse at 0,
  // and reevaluate for the session when entering it. Persist only when this boolean changes (or the
  // session changes), so a manual collapse remains collapsed while runs continue.
  // Root cause: it used to be collapsed by default like Terminal/Agents. After the capsule began
  // showing workflows by name, opening it collapsed the run just shown, so the expanded section
  // displayed less than the capsule.
  const hasLiveWorkflowRun = runningWorkflowCount > 0;
  useEffect(() => {
    setWorkflowSectionOpen(hasLiveWorkflowRun);
  }, [hasLiveWorkflowRun, sessionId]);
  useEffect(() => {
    if (runningAgentCount === 0) {
      setAgentSectionOpen(false);
    }
  }, [runningAgentCount]);
  // Composer badge shortcut: when the only running item is a workflow run with a details page,
  // clicking the badge opens its side tab directly without changing the capsule. Use the same model as the capsule;
  // do not shortcut when the host has not supplied onOpenWorkflowRun (the panel row is also not clickable then).
  const soleRunningWorkflowRunTarget = useMemo(
    () => (onOpenWorkflowRun ? resolveSoleRunningWorkflowRunTarget(statusPanelModel) : null),
    [onOpenWorkflowRun, statusPanelModel],
  );
  const handleOpenRunningBackgroundWorks = useCallback(() => {
    if (runningBackgroundWorkCount === 0) return;
    if (soleRunningWorkflowRunTarget) {
      // Reuse the panel row's handler; there is no second open path.
      handleOpenWorkflowRunFromPanel(soleRunningWorkflowRunTarget);
      return;
    }
    // Product rule: Composer is the entry point for all live activity. After splitting sections, one click still expands
    // every non-empty type, but the three sections keep independent collapsed state afterward and cannot share one open boolean.
    setTerminalSectionOpen(runningTerminalCount > 0);
    setAgentSectionOpen(runningAgentCount > 0);
    setWorkflowSectionOpen(runningWorkflowCount > 0);
    handleSummaryPanelVariantChange("panel");
  }, [
    handleOpenWorkflowRunFromPanel,
    handleSummaryPanelVariantChange,
    runningAgentCount,
    runningBackgroundWorkCount,
    runningTerminalCount,
    runningWorkflowCount,
    soleRunningWorkflowRunTarget,
  ]);
  const statusPanelVariant = resolveConversationStatusPanelVariant({
    variantOverride: effectiveSummaryPanelVariantOverride,
  });
  // If only the status panel knows its auto-expanded state while timeline/composer do not adjust layout,
  // the panel can cover content on wide screens. The outer layout must use the same expanded state.
  const shouldUseStatusPanelInlineLayout =
    !isDraft &&
    shouldUseConversationStatusPanelInlineLayout({
      hasContent: statusPanelModel.hasContent,
      variant: statusPanelVariant,
    });
  const statusPanelLayout = !shouldUseStatusPanelInlineLayout
    ? "none"
    : statusPanelVariant === "auto"
      ? "auto"
      : "inline";
  const controlLastError = snapshot?.control.lastError ?? null;
  const controlLastErrorKey = controlLastError
    ? createSessionErrorKey(snapshot?.sessionId ?? sessionId, controlLastError)
    : null;
  const projectedComposerError =
    controlLastError && controlLastErrorKey && !dismissedErrorKeys.includes(controlLastErrorKey)
      ? toComposerUiError(snapshot?.sessionId ?? sessionId, controlLastError)
      : null;
  // Official Server MCP is unavailable (quota exhausted/no Coding Plan). This fact comes from the structured tool-row marker
  // and is separate from model quota; this code only projects it.
  const mcpUnavailableNotice = useMemo(
    () => resolveMcpUnavailableNotice(snapshot?.rows.window),
    [snapshot?.rows.window],
  );
  const quotaBanner = useV4SessionQuotaBanner({
    sessionId: snapshot?.sessionId ?? sessionId,
    error: controlLastError,
    errorKey: controlLastErrorKey,
    phase: snapshot?.control.phase ?? null,
    providerId: snapshot?.config.provider ?? null,
    modelId: snapshot?.config.model ?? null,
    usageStatsService: baseWorkspaceServices.usageStatsService,
    mcpUnavailableNotice,
  });
  const composerError =
    draftModelReadinessError ??
    sendSubmissionError ??
    (quotaBanner.takesOverError ? null : projectedComposerError);
  // Resume is offered only for runtime errors (control.lastError). Send failures and
  // model-readiness errors happen before admission, so the user's message was never sent;
  // resuming them would send "Continue" on its own.
  const resumableComposerError =
    projectedComposerError !== null && composerError === projectedComposerError;
  // The guard is released when the error key changes: the next accepted turn clears
  // lastError, and a new error gets a new key. A successful ACK alone does not release it,
  // otherwise a second click before TurnStarted would send another "Continue".
  const resumePendingErrorKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const pendingKey = resumePendingErrorKeyRef.current;
    if (pendingKey !== null && pendingKey !== controlLastErrorKey) {
      resumePendingErrorKeyRef.current = null;
    }
  }, [controlLastErrorKey]);
  const handleResumeError = useCallback(() => {
    if (!controlLastErrorKey || resumePendingErrorKeyRef.current !== null) return;
    resumePendingErrorKeyRef.current = controlLastErrorKey;
    // Resume bypasses the composer submit path, so the draft and attachments stay untouched.
    void handleSendText(CHAT_ERROR_RESUME_MESSAGE)
      .then((result) => {
        if (result === "blocked" || result === "confirmationRequired") {
          resumePendingErrorKeyRef.current = null;
          toast(intl.formatMessage({ id: "chat.error.resumeBlocked" }));
        }
      })
      .catch((error: unknown) => {
        resumePendingErrorKeyRef.current = null;
        logger.warn("[v4-pane] Resume send failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [controlLastErrorKey, handleSendText, intl]);
  useEffect(() => {
    setSendSubmissionError(null);
  }, [sessionId]);
  const handleDismissComposerError = useCallback(() => {
    if (draftModelReadinessError) {
      dismissDraftModelReadinessError();
      return;
    }
    if (sendSubmissionError) {
      setSendSubmissionError(null);
      return;
    }
    if (!controlLastErrorKey) return;
    // v4 control.lastError is a projection fact; simply closing the banner does not change the projection.
    // Track the current error fingerprint so the same error does not immediately reappear on the next render; a new timestamp/message still shows.
    setDismissedErrorKeys((keys) =>
      keys.includes(controlLastErrorKey) ? keys : [...keys.slice(-19), controlLastErrorKey],
    );
  }, [
    controlLastErrorKey,
    dismissDraftModelReadinessError,
    draftModelReadinessError,
    sendSubmissionError,
  ]);
  const handleOpenModelSettings = useCallback(() => {
    setPendingSettingsSectionIntent("modelProvider");
    openSettingsTab();
  }, [openSettingsTab]);
  const handleOpenModelUpgrade = useCallback(() => {
    if (!codingPlanUpgradeDialog) return;
    const providerId =
      sharedSettings?.providerFamilyDomain === "bigmodel"
        ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    codingPlanUpgradeDialog.openCodingPlanUpgrade({ providerId });
  }, [codingPlanUpgradeDialog, sharedSettings?.providerFamilyDomain]);
  const handleOpenQuotaUpgrade = useCallback(() => {
    const providerId = quotaBanner.upgradeProviderId;
    if (!providerId || !codingPlanUpgradeDialog) return;
    const eventText = intl.formatMessage({
      id: quotaBanner.upgradeActionLabelId,
    });
    // The banner only establishes funnel context; coding_plan_upgrade_ck is still reported when the actual purchase panel opens.
    codingPlanUpgradeDialog.openCodingPlanUpgrade({
      providerId,
      funnelContext: createCodingPlanFunnelContext({
        providerId,
        upgradeSource: "session_quota_alert",
        eventRegion: "app.session",
        eventText,
        entryPlanState: resolveCodingPlanEntryPlanState({
          providerId,
          displayStatus: "purchased",
          planLevel: "start",
        }),
      }),
    });
  }, [
    codingPlanUpgradeDialog,
    intl,
    quotaBanner.upgradeActionLabelId,
    quotaBanner.upgradeProviderId,
  ]);

  const handleConfirmShareDisclosure = useCallback(async () => {
    if (!sessionId || !shareDraft || sharePublishing) return;
    const productTurnIds = getConversationShareSelectedProductTurnIds(
      useConversationShareSelectionStore.getState(),
      sessionId,
    );
    if (productTurnIds.length === 0 || !shareTitle.trim()) return;
    const attemptKey = JSON.stringify({
      title: shareTitle.trim(),
      accessMode: shareDraft.accessMode,
      productTurnIds,
      revision: snapshot?.revision ?? null,
      logEpoch: snapshot?.logEpoch ?? null,
    });
    const shareAttempt = ensureConversationShareAttempt(
      getConversationShareDockState(useConversationShareSelectionStore.getState(), sessionId)
        .attempt,
      attemptKey,
      sessionId,
      { randomUUID: () => globalThis.crypto?.randomUUID?.() },
    );
    const operationId = `share-operation-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    let activePhase = "collecting";
    let collectedWarnings: ConversationShareDisplayWarnings | null = null;
    const progressSubscription = conversationShareService.onDynamicPublishProgress(operationId)((
      progress,
    ) => {
      activePhase = progress.phase;
      updateShareDockState(sessionId, {
        progress: progress.phase === "complete" ? "checking" : progress.phase,
        completedArtifacts: progress.completedArtifacts,
        totalArtifacts: progress.totalArtifacts,
      });
      const warnings = sanitizeConversationShareWarnings(progress.warnings);
      if (warnings.length > 0) {
        collectedWarnings = {
          issues: warnings,
          issueCount: warnings.length,
          ...(progress.omittedWarningCount
            ? { omittedIssueCount: progress.omittedWarningCount }
            : {}),
        };
      }
    });
    updateShareDockState(sessionId, {
      attempt: shareAttempt,
      publishing: true,
      progress: "collecting",
      completedArtifacts: 0,
      totalArtifacts: 0,
      publishedShareUrl: null,
      error: null,
      warnings: null,
    });
    try {
      const share = await conversationShareService.publish(
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId,
          title: shareTitle.trim(),
          accessMode: shareDraft.accessMode,
          selection: { kind: "productTurns", productTurnIds },
          clientRequestId: shareAttempt.clientRequestId,
          disclosureAcceptedAt: shareAttempt.disclosureAcceptedAt,
          locale,
        },
        operationId,
      );
      const warnings = collectedWarnings as ConversationShareDisplayWarnings | null;
      updateShareDockState(sessionId, {
        publishedShareUrl: share.share_url,
        warnings,
      });
      // collectedWarnings is assigned only inside the progress callback. TypeScript control-flow analysis cannot see writes
      // across the closure and narrows it to null, so restore the actual type explicitly here.
      if (warnings) {
        toast(
          intl.formatMessage(
            { id: "conversationShare.publishSucceededWithSkips" },
            { count: warnings.issueCount },
          ),
        );
      } else {
        toast(intl.formatMessage({ id: "conversationShare.publishSucceeded" }));
      }
    } catch (error) {
      const details = getConversationShareErrorDetails(error);
      // Transport errors such as 401 usually have no server issues; do not downgrade them to generic copy for the collecting stage.
      const resolvedMessageId = resolveConversationSharePublishErrorMessageId(error);
      const messageId =
        resolvedMessageId === "conversationShare.publishFailed" ? undefined : resolvedMessageId;
      updateShareDockState(sessionId, {
        error:
          details.issues && details.issues.length > 0
            ? {
                issues: details.issues,
                issueCount: details.issueCount ?? details.issues.length,
                omittedIssueCount: details.omittedIssueCount,
                requestId: details.requestId,
                clientRequestId: details.clientRequestId,
                operationId,
                status: details.status,
                code: details.code,
              }
            : {
                issues: [
                  {
                    code: resolveConversationShareFallbackIssueCode(details),
                    scope: "transport",
                    phase: activePhase as "collecting" | "uploading" | "checking" | "complete",
                  },
                ],
                issueCount: 1,
                requestId: details.requestId,
                clientRequestId: details.clientRequestId,
                operationId,
                status: details.status,
                code: details.code,
                messageId,
              },
      });
      logger.warn("[conversation-share] 会话发布失败", {
        sessionId,
        operationId,
        phase: activePhase,
        accessMode: shareDraft.accessMode,
        selectedProductTurnCount: productTurnIds.length,
        remoteWorkspace: Boolean(workspaceIdentity || remoteSessionId),
        errorName: details.name,
        kind: details.kind,
        ...(details.reasonCode === undefined ? {} : { reasonCode: details.reasonCode }),
        ...(details.diagnostics === undefined ? {} : { diagnostics: details.diagnostics }),
        ...(details.status === undefined ? {} : { status: details.status }),
        ...(details.code === undefined ? {} : { code: details.code }),
        ...(details.requestId === undefined ? {} : { requestId: details.requestId }),
      });
    } finally {
      progressSubscription.dispose();
      updateShareDockState(sessionId, { publishing: false });
    }
  }, [
    conversationShareService,
    intl,
    remoteSessionId,
    sessionId,
    shareDraft,
    sharePublishing,
    shareTitle,
    snapshot?.logEpoch,
    snapshot?.revision,
    updateShareDockState,
    workspaceIdentity,
    workspacePath,
  ]);

  const handleCopyPublishedShare = useCallback(() => {
    if (!publishedShareUrl || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(publishedShareUrl).then(
      () => toast(intl.formatMessage({ id: "conversationShare.copySucceeded" })),
      () => toast(intl.formatMessage({ id: "conversationShare.copyFailed" })),
    );
  }, [intl, publishedShareUrl]);

  const handleOpenPublishedShare = useCallback(() => {
    if (!publishedShareUrl || !onOpenBrowserUrl) return;
    // The server stores the canonical /cn/share/ path; switch the landing-page path to the current UI language only when opening it.
    onOpenBrowserUrl(localizeConversationShareUrl(publishedShareUrl, locale));
  }, [locale, onOpenBrowserUrl, publishedShareUrl]);

  const handleCopyShareRequestId = useCallback(() => {
    const requestId = shareError?.requestId;
    if (!requestId || !navigator.clipboard?.writeText) {
      toast(intl.formatMessage({ id: "conversationShare.copyFailed" }));
      return;
    }
    void navigator.clipboard.writeText(requestId).then(
      () => toast(intl.formatMessage({ id: "conversationShare.copySucceeded" })),
      () => toast(intl.formatMessage({ id: "conversationShare.copyFailed" })),
    );
  }, [intl, shareError?.requestId]);

  const handleShareCancel = useCallback(() => {
    if (sharePublishing || !sessionId) return;
    finishShare(sessionId);
  }, [finishShare, sessionId, sharePublishing]);

  const handleShareNext = useCallback(() => {
    if (sharePublishing || !sessionId) return;
    if (
      sharePreflight.status === "idle" ||
      sharePreflight.status === "checking" ||
      sharePreflight.status === "stale" ||
      ("blockingIssues" in sharePreflight && sharePreflight.blockingIssues.length > 0)
    ) {
      return;
    }
    // Preflight warnings are already shown by the state entry in the selection Dock. shareWarnings receives only final publish results,
    // so "sharing completed" copy does not appear early during the pre-publish confirmation stage.
    updateShareDockState(sessionId, { error: null });
    goToShareConfiguration(sessionId);
  }, [goToShareConfiguration, sessionId, sharePreflight, sharePublishing, updateShareDockState]);

  const handleShareSelectAll = useCallback(() => {
    if (!sessionId) return;
    setAllShareRowsSelected(sessionId, true);
    updateShareDockState(sessionId, { disclosureAccepted: false, error: null });
  }, [sessionId, setAllShareRowsSelected, updateShareDockState]);

  const handleShareDeselectAll = useCallback(() => {
    if (!sessionId) return;
    setAllShareRowsSelected(sessionId, false);
    updateShareDockState(sessionId, { disclosureAccepted: false, error: null });
  }, [sessionId, setAllShareRowsSelected, updateShareDockState]);

  const handleDismissShareError = useCallback(() => {
    if (sessionId) updateShareDockState(sessionId, { error: null });
  }, [sessionId, updateShareDockState]);
  const handleDismissShareWarnings = useCallback(() => {
    if (sessionId) updateShareDockState(sessionId, { warnings: null });
  }, [sessionId, updateShareDockState]);

  const handleDeselectShareTurn = useCallback(
    (productTurnId: string) => {
      if (!sessionId || !productTurnId) return;
      // Remove the whole turn by product-turn identity: service issues include productTurnId.
      // Do not index the UI's per-query list by turnOrdinal; the two numbering schemes can diverge.
      deselectShareProductTurn(sessionId, productTurnId);
      updateShareDockState(sessionId, { disclosureAccepted: false, error: null });
    },
    [deselectShareProductTurn, sessionId, updateShareDockState],
  );

  const handleShareTitleChange = useCallback(
    (value: string) => {
      if (!sessionId) return;
      updateShareDockState(sessionId, {
        title: value,
        disclosureAccepted: false,
        publishedShareUrl: null,
        error: null,
        warnings: null,
      });
    },
    [sessionId, updateShareDockState],
  );

  const handleShareAccessModeChange = useCallback(
    (accessMode: ConversationShareAccessMode) => {
      if (!sessionId) return;
      setShareAccessMode(sessionId, accessMode);
      updateShareDockState(sessionId, {
        disclosureAccepted: false,
        publishedShareUrl: null,
        error: null,
        warnings: null,
      });
    },
    [sessionId, setShareAccessMode, updateShareDockState],
  );

  // Inline callbacks would re-render the memoized confirmation Dock every time. Depend on the current session to avoid writing to the old one after a switch.
  const handleShareDisclosureAcceptedChange = useCallback(
    (accepted: boolean) => {
      if (sessionId) {
        updateShareDockState(sessionId, { disclosureAccepted: accepted });
      }
    },
    [sessionId, updateShareDockState],
  );

  const handleShareBack = useCallback(() => {
    if (sharePublishing || publishedShareUrl || !sessionId) return;
    updateShareDockState(sessionId, { error: null });
    goToShareSelection(sessionId);
  }, [goToShareSelection, publishedShareUrl, sessionId, sharePublishing, updateShareDockState]);

  const handleShareConfirm = useCallback(() => {
    if (!shareDisclosureAccepted) return;
    void handleConfirmShareDisclosure();
  }, [handleConfirmShareDisclosure, shareDisclosureAccepted]);

  const handleShareSelectionToggle = useCallback(
    (rowId: number) => {
      if (sessionId) toggleShareRow(sessionId, rowId);
      if (sessionId) {
        updateShareDockState(sessionId, { disclosureAccepted: false, error: null });
      }
    },
    [sessionId, toggleShareRow, updateShareDockState],
  );

  const handleShareSelectionInspect = useCallback(
    (target: { unitIndex: number; rowId: number }) => {
      timelineScrollToQueryRef.current?.(target);
    },
    [],
  );

  const recoverableCommand = recoverableCommands[0] ?? null;
  const handleDismissPendingRecovery = useCallback(() => {
    if (!recoverableCommand) return;
    pendingCommandRegistry.dismissRecovery(
      recoverableCommand.sessionId,
      recoverableCommand.commandId,
    );
  }, [recoverableCommand]);
  const handleResendPendingCommand = useCallback(() => {
    if (!recoverableCommand) return;
    const replay = pendingCommandRegistry.consumeReplay({
      sessionId: recoverableCommand.sessionId,
      commandId: recoverableCommand.commandId,
    });
    if (!replay) return;
    void dispatchCommand(replay.type, replay.payload, replay.sessionId, replay.baseRevision)
      .then((ack) => {
        if (
          replay.type === "createSession" &&
          (ack.status === "accepted" || ack.status === "duplicate") &&
          ack.result?.type === "createSession"
        ) {
          const originWorkspace = replay.clientContext?.workspace;
          const originWorkspaceKey =
            originWorkspace?.workspaceIdentity?.trim() || originWorkspace?.workspacePath;
          if (originWorkspaceKey && originWorkspaceKey !== workspaceKey) {
            // Guard against stale UI/old closures triggering replay across workspaces; the normal entry point is already filtered by the hook.
            logger.error("[v4-pending-command] 拒绝跨 workspace 提交 createSession 恢复结果", {
              originWorkspaceKey,
              workspaceKey,
            });
            return;
          }
          handleDraftSessionCreated(
            ack.result.sessionId,
            replay.clientContext?.groupedDraftTask,
            replay.clientContext?.sessionCreateSource,
            replay.payload.firstInput ? ack.commandId : undefined,
          );
        }
      })
      .catch((error) => {
        // The new command has already been written to the registry, so reconciliation can continue on the next connection after this transport failure.
        logger.warn("[v4-pending-command] 用户确认重发失败", error);
      });
  }, [dispatchCommand, handleDraftSessionCreated, recoverableCommand, workspaceKey]);

  // The child tab on the right for a subagent is a read-only view. If ordinary SessionPane still creates a Composer,
  // users may think they can continue entering input directly into the child session.
  const composerNode = readOnly ? null : (
    <ConversationComposer
      key="conversation-composer"
      // Web remote control gets the browser-native Web Speech engine (hidden where the API is
      // missing); desktop keeps the Host whisper engine.
      voiceDictationEnabled={isDesktop || compactForRemoteControl}
      // Snapshot still provides usage, routing, and runtime state; the toolbar reads mode/model only from the Composer Draft below.
      snapshot={snapshot}
      sessionId={sessionId}
      // The draft taskId is still null, but prewarm already owns an independent AgentRuntime.
      // Pass the effective ID only to the Skill catalog so the UI does not scan for new Skills before the prewarm runtime has loaded them.
      skillCatalogSessionId={effectiveSessionId}
      draftMode={isDraft}
      draftConfig={draftConfig}
      composerDraft={composerDraft}
      replaceComposerDraft={replaceComposerDraft}
      submissionReady={composerSubmissionReady}
      updateComposerContent={updateComposerContent}
      createSubmissionFromComposer={createSubmissionFromComposer}
      telemetryDraftConfig={telemetryDraftConfig}
      contextHeader={isDraft ? draftComposerHeader : undefined}
      centered={isDraft}
      blockingRequestId={blockingInteractionId}
      listenAddToChatEvents={focused}
      externalTextInsertRequest={focused && sessionId === null ? composerTextInsertRequest : null}
      onExternalTextInsertApplied={handleExternalTextInsertApplied}
      autoFocusEnabled={focused}
      disabled={
        connecting ||
        draftRuntimeRebuilding ||
        queueEditActiveForCurrentComposer ||
        quotaBanner.state.blocksSubmit
      }
      isWebRemoteControl={compactForRemoteControl}
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId ?? undefined}
      modelSelectionView={modelSelectionView}
      modelSelectionState={modelSelectionRead.state}
      modelSelectionReload={modelSelectionRead.reload}
      attachmentSessionId={effectiveSessionId}
      attachmentPut={attachmentPut}
      onRuntimeRestart={onRuntimeRestart}
      onRuntimeLifecycle={onRuntimeLifecycle}
      provider={provider}
      telemetryVisible={telemetryVisible && conversationTelemetryForegroundEnabled}
      readPlanIdentitySnapshot={readPlanIdentitySnapshot}
      onSendText={handleSendText}
      highspeedCard={activeHighspeedCard}
      highspeedActivationCardId={highspeedActivationCardId}
      onHighspeedActivationApplied={handleHighspeedActivationApplied}
      onDraftStateChange={handleComposerDraftStateChange}
      composerRestoreRequest={composerRestoreRequest}
      onComposerRestoreApplied={handleComposerRestoreApplied}
      onStop={handleStopFromButton}
      onSelectModel={handleSelectModel}
      onSelectThought={handleSelectThought}
      onSwitchMode={handleSwitchMode}
      onOpenRunningBackgroundWorks={
        sessionId && runningBackgroundWorkCount > 0 ? handleOpenRunningBackgroundWorks : undefined
      }
      backgroundWorkOpenTarget={soleRunningWorkflowRunTarget ? "workflow-run" : "panel"}
      // After the parent turn ends, the subagents.running directory projection may briefly lag behind backgroundWorks
      // that are still running. If Composer reads the directory directly, it may hide the Agent entry too early.
      // Reuse the status panel's count after its childSessionId-specific fallback so both entry points share the same runtime truth.
      runningSubagentCount={runningAgentCount}
      onRecoverCustomModelSelection={handleRecoverCustomModelSelection}
      onSendCompressionCommand={handleSendCompressionCommand}
      error={composerError}
      onDismissError={handleDismissComposerError}
      onResumeError={resumableComposerError ? handleResumeError : undefined}
      onOpenModelSettings={handleOpenModelSettings}
      onOpenModelUpgrade={handleOpenModelUpgrade}
      onOpenCodeViewer={onOpenCodeViewer}
      suppressGoalCommands={selectionSideChat}
      appSlashCommands={appSlashCommands}
      onDropTargetControllerChange={handleDropTargetControllerChange}
    />
  );
  const pendingGuideProjection = snapshot ? projectPendingGuideQueue(snapshot.queue) : null;
  const conversationBottomDockContent = readOnly ? null : shareActive && sessionId ? (
    shareInSelectionStage ? (
      <ConversationShareSelectionDock
        selectedCount={selectedShareRowIds.size}
        totalCount={eligibleShareItems.length}
        pending={sharePublishing}
        preflight={sharePreflight}
        onCancel={handleShareCancel}
        onNext={handleShareNext}
        onSelectAll={handleShareSelectAll}
        onDeselectAll={handleShareDeselectAll}
        onDeselectTurn={handleDeselectShareTurn}
        onRetryPreflight={retrySharePreflight}
      />
    ) : publishedShareUrl ? (
      <ConversationShareSuccessDock
        title={shareTitle}
        warnings={shareWarnings}
        onOpen={handleOpenPublishedShare}
        onCopy={handleCopyPublishedShare}
        onDismiss={handleShareCancel}
      />
    ) : (
      <ConversationShareConfirmationDock
        selectedCount={selectedShareProductTurnIds.length}
        totalCount={eligibleShareProductTurnIds.length}
        title={shareTitle}
        accessMode={shareDraft?.accessMode ?? DEFAULT_CONVERSATION_SHARE_ACCESS_MODE}
        progressLabel={intl.formatMessage({
          id:
            shareProgress === "uploading"
              ? "conversationShare.progress.uploading"
              : shareProgress === "checking"
                ? "conversationShare.progress.checking"
                : "conversationShare.progress.collecting",
        })}
        progressPhase={shareProgress}
        completedArtifacts={shareCompletedArtifacts}
        totalArtifacts={shareTotalArtifacts}
        pending={sharePublishing}
        error={shareError}
        warnings={shareWarnings}
        onDismissError={handleDismissShareError}
        onDismissWarnings={handleDismissShareWarnings}
        onCopyRequestId={handleCopyShareRequestId}
        onDeselectTurn={handleDeselectShareTurn}
        onTitleChange={handleShareTitleChange}
        onAccessModeChange={handleShareAccessModeChange}
        disclosureAccepted={shareDisclosureAccepted}
        onDisclosureAcceptedChange={handleShareDisclosureAcceptedChange}
        onCancel={handleShareCancel}
        onBack={handleShareBack}
        onConfirm={handleShareConfirm}
      />
    )
  ) : (
    <>
      {quotaBanner.state.visible &&
      !quotaBanner.dismissed &&
      (!projectedComposerError || quotaBanner.takesOverError || quotaBanner.state.blocksSubmit) ? (
        <ConversationQuotaBanner
          key={`${snapshot?.sessionId ?? "session"}:${controlLastErrorKey ?? "quota-banner"}`}
          state={quotaBanner.state}
          onShown={quotaBanner.markShown}
          billingDiscountActive={billingDiscount.active}
          billingDiscountConfig={billingDiscount.config}
          upgradeActionLabelId={quotaBanner.upgradeActionLabelId}
          onUpgrade={
            quotaBanner.upgradeProviderId && codingPlanUpgradeDialog
              ? handleOpenQuotaUpgrade
              : undefined
          }
          onDismiss={quotaBanner.dismiss}
          autoContinueDefault={sharedSettings?.codingPlanLimitAutoContinueDefaultEnabled !== false}
          autoContinueReady={sharedSettings !== null}
          onAutoContinue={
            quotaBanner.state.providerLimitedResetAt !== null ? handleResumeError : undefined
          }
        />
      ) : null}
      {recoverableCommand ? (
        <PendingCommandRecoveryBanner
          entry={recoverableCommand}
          onResend={
            recoverableCommand.replay.kind === "input" ? handleResendPendingCommand : undefined
          }
          onDismiss={handleDismissPendingRecovery}
        />
      ) : null}
      {sessionId && snapshot?.workspaceHookAdmission ? (
        <WorkspaceHookPendingBanner
          sessionId={sessionId}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          admission={snapshot.workspaceHookAdmission}
        />
      ) : null}
      {sessionId && snapshot ? (
        <ConversationQueuePanel
          key="conversation-queue"
          queue={pendingGuideProjection?.visibleQueue ?? snapshot.queue}
          onDeleteItem={handleDeleteQueueItem}
          onEditItem={handleEditQueueItem}
          pendingEditQueueItemId={
            queueEditActiveForCurrentComposer ? queueEditOperation.queueItemId : null
          }
          onSendNow={handleSendQueuedNow}
          onMoveItem={handleReorderQueueItem}
          onResume={handleResumeQueue}
        />
      ) : null}
      {/* Bugfix: V4 permission and question waiting states are blocking runtime interactions and must share
          the timeline bottom dock with the composer. Rendering them outside SessionPane would
          detach them from the main column width and take up the lower half of the screen. */}
      {sessionId && snapshot ? (
        <V4InteractionDialogs
          key="conversation-interactions"
          sessionId={sessionId}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId ?? undefined}
          isWebRemoteControl={compactForRemoteControl}
          provider={provider}
          snapshot={snapshot}
          onPlanInteractionAccepted={
            compactForRemoteControl ? handleMobilePlanInteractionAccepted : undefined
          }
        />
      ) : null}
      {composerNode}
      {/* Office mode shows proactive task suggestions; coding mode keeps the existing compact
          scenario entry point. */}
      {isDraft && (!isOfficeMode || sharedSettings?.proactiveSuggestionsEnabled === true) ? (
        <ConversationDraftSuggestedPromptsContainer
          className={isOfficeMode ? "mt-4" : "mt-6"}
          proactive={isOfficeMode}
          onOpenAutomations={
            onOpenAutomationsMain && !compactForRemoteControl
              ? (automationTab) => onOpenAutomationsMain(undefined, automationTab)
              : undefined
          }
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={remoteSessionId ?? undefined}
          isWebRemoteControl={compactForRemoteControl}
          isDesktop={isDesktop}
        />
      ) : null}
    </>
  );
  // Images from plugin ui/message use the same v4 attachmentPut path as pasted screenshots; drafts without a sessionId have no plugin UI.
  const pluginUiUploadAttachment = useCallback(
    async (input: { fileName: string; mime: string; dataBase64: string }) => {
      if (!sessionId) throw new Error("Plugin UI attachments need an open session");
      const { ref } = await attachmentPut({ sessionId, ...input });
      const padding = input.dataBase64.endsWith("==") ? 2 : input.dataBase64.endsWith("=") ? 1 : 0;
      return {
        ref,
        fileName: input.fileName,
        mime: input.mime,
        bytes: Math.floor((input.dataBase64.length * 3) / 4) - padding,
      };
    },
    [attachmentPut, sessionId],
  );
  // The chat Dock and share Dock have different heights. Share one grid cell and transition vertically with a fade
  // when entering/exiting sharing, avoiding a hard jump from parent-height changes. The transition component handles prefers-reduced-motion by switching immediately.
  const conversationBottomDock = conversationBottomDockContent ? (
    <ConversationBottomDockTransition mode={shareActive && sessionId ? "confirmation" : "chat"}>
      {conversationBottomDockContent}
    </ConversationBottomDockTransition>
  ) : null;

  return (
    <PluginUiSessionProvider
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId}
      sessionId={sessionId}
      readOnly={readOnly}
      sendText={dispatchSendText}
      uploadAttachment={pluginUiUploadAttachment}
      projectionStore={sessionLeaseReady ? lease?.store : null}
    >
      <div
        data-testid={testId(TID_V4_SESSION_PANE, paneId)}
        data-session-id={sessionId ?? "draft"}
        data-initial-draft-provider={initialDraftConfigForDiagnostics?.provider ?? ""}
        data-initial-draft-model={initialDraftConfigForDiagnostics?.model ?? ""}
        data-projection-seq={snapshot?.seq ?? ""}
        data-running-subagent-ids={subagents.running.map((item) => item.childSessionId).join(",")}
        data-running-subagent-work-ids={(snapshot?.backgroundWorks ?? [])
          .filter((work) => work.kind === "subagent" && work.status === "running")
          .map((work) => work.childSessionId ?? work.workId)
          .join(",")}
        data-v4-conversation-drop-target="true"
        onDragOver={effectiveDropTargetController?.onDragOver}
        onDragLeave={effectiveDropTargetController?.onDragLeave}
        onDrop={effectiveDropTargetController?.onDrop}
        className={cn(
          "relative flex h-full min-h-0 flex-col",
          compactForRemoteControl && "min-w-0",
        )}
      >
        {effectiveDropTargetController?.active ? (
          <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-accent/55 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-full border border-border bg-accent px-4 py-2 text-ui-base text-foreground shadow-sm">
              <Hand className="size-4 text-foreground" />
              <span>
                {intl.formatMessage({
                  id:
                    effectiveDropTargetController.kind === "workspace"
                      ? "chat.composer.workspaceFileDragHint"
                      : "chat.attachments.dragHint",
                })}
              </span>
            </div>
          </div>
        ) : null}
        <ConversationHeader
          title={snapshot?.meta.title ?? ""}
          onSplitRight={onSplitRight}
          onSplitDown={onSplitDown}
          onClosePane={onClosePane}
          workspaceBadge={workspaceBadge}
        />

        <div
          ref={conversationLayoutContainerRef}
          className={cn(
            "@container/conversation relative flex min-h-0 flex-1 flex-col",
            compactForRemoteControl && "min-w-0",
          )}
        >
          <ConversationShareSelectionScrim
            visible={shareSelectionPanelVisible}
            interactive
            onBackdropClick={dismissShareSelectionPanel}
          />
          <ConversationShareSelectionPanel
            visible={shareSelectionPanelVisible}
            items={shareItems}
            selectedRowIds={selectedShareRowIds}
            onToggle={handleShareSelectionToggle}
            onInspect={handleShareSelectionInspect}
          />
          {shareActive &&
          shareInSelectionStage &&
          shareDraft?.view === "timeline" &&
          sessionId &&
          !compactForRemoteControl ? (
            <ConversationShareSelectionReopenTab
              onOpen={() => showShareSelectionPanel(sessionId)}
            />
          ) : null}
          {!isDraft ? (
            <ConversationStatusPanel
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              gitSummary={gitSummary}
              gitDirtyFileCount={gitDirtyFileCount}
              gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
              gitWorktreeChangeSummary={gitWorktreeChangeSummary}
              activeTaskChangeSummary={activeTaskChangeSummary}
              goal={selectionSideChat ? null : (snapshot?.goal ?? null)}
              sessionPlans={state.sessionPlans}
              plan={snapshot?.plan ?? null}
              backgroundWorks={snapshot?.backgroundWorks ?? []}
              runningSubagents={subagents.running}
              workflowRuns={snapshot?.workflowRuns?.runs ?? []}
              endedSubagentCount={subagents.endedTotal}
              rootSessionId={rootSessionId ?? sessionId ?? undefined}
              parentSessionId={sessionId ?? undefined}
              isWebRemoteControl={compactForRemoteControl}
              isMobileViewport={isMobileTextInputViewport}
              layoutMode={statusPanelLayout}
              summaryPanelVariantOverride={effectiveSummaryPanelVariantOverride}
              onVariantChange={handleSummaryPanelVariantChange}
              terminalSectionOpen={terminalSectionOpen}
              onTerminalSectionOpenChange={setTerminalSectionOpen}
              agentSectionOpen={agentSectionOpen}
              onAgentSectionOpenChange={setAgentSectionOpen}
              workflowSectionOpen={workflowSectionOpen}
              onWorkflowSectionOpenChange={setWorkflowSectionOpen}
              onRefreshGit={onRefreshGit}
              onOpenGitReview={onOpenGitReview}
              onPauseGoal={
                !readOnly && !selectionSideChat && snapshot?.availability.pauseGoal.allowed
                  ? handlePauseGoal
                  : undefined
              }
              onResumeGoal={
                !readOnly && !selectionSideChat && snapshot?.availability.resumeGoal.allowed
                  ? handleResumeGoal
                  : undefined
              }
              onOpenPlanDetail={onOpenPlanDetail ? handleOpenPlanDetail : undefined}
              onOpenBackgroundBash={
                onOpenBackgroundBash && sessionId
                  ? (work) =>
                      onOpenBackgroundBash({
                        workspacePath,
                        workspaceIdentity: workspaceIdentity ?? undefined,
                        remoteSessionId: remoteSessionId ?? undefined,
                        rootSessionId: rootSessionId ?? sessionId,
                        sessionId,
                        workId: work.workId,
                        title: work.title,
                      })
                  : undefined
              }
              onCancelBackgroundWork={readOnly ? undefined : handleCancelBackgroundWork}
              onOpenSubagentSession={onOpenSubagentSession ? handleOpenSubagentSession : undefined}
              onOpenSubagentDirectory={
                onOpenSubagentDirectory && !compactForRemoteControl
                  ? handleOpenSubagentDirectory
                  : undefined
              }
              onOpenWorkflowRun={
                onOpenWorkflowRun && sessionId ? handleOpenWorkflowRunFromPanel : undefined
              }
              endedWorkflowRunCount={endedWorkflowRunCount}
              onOpenWorkflowRunDirectory={
                onOpenWorkflowRunDirectory && !compactForRemoteControl
                  ? handleOpenWorkflowRunDirectoryFromPanel
                  : undefined
              }
            />
          ) : null}

          {readOnly && controlLastError ? (
            <div
              role="alert"
              data-testid="v4-subagent-readonly-error"
              className="mx-4 mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-2 text-ui-base text-[var(--color-danger)]"
            >
              {controlLastError.message}
            </div>
          ) : null}

          {errored ? (
            <SessionSubscriptionErrorPanel
              error={state.lastError ?? intl.formatMessage({ id: "chat.error.connectionLost" })}
              sessionId={sessionId}
              workspacePath={workspacePath}
              onReconnect={handleRetrySubscribe}
            />
          ) : (
            <SessionPluginReferenceIconBoundary
              enabled={pluginReferenceIconsEnabled}
              remoteSessionId={remoteSessionId}
              sessionId={sessionId}
              workspaceIdentity={workspaceIdentity}
              workspacePath={workspacePath}
            >
              <BotGroupDeliveryProvider
                taskId={sessionId}
                workspacePath={workspacePath}
                workspaceIdentity={workspaceIdentity}
              >
                <ConversationTimeline
                  compactForRemoteControl={compactForRemoteControl}
                  scrollToBottomActionRef={timelineScrollToBottomRef}
                  scrollToQueryActionRef={timelineScrollToQueryRef}
                  selectionPanelLayoutContainerRef={conversationLayoutContainerRef}
                  rows={timelineSnapshot?.rows.window ?? []}
                  pendingGuides={timelineSnapshot ? pendingGuideProjection?.pendingGuides : []}
                  apiRetry={timelineSnapshot?.control.apiRetry ?? null}
                  totalCount={timelineSnapshot?.rows.totalCount ?? 0}
                  sessionKey={sessionId ?? "draft"}
                  scrollMemoryKey={timelineScrollMemoryKey}
                  rowContext={rowContext}
                  onFork={forkActionsEnabled ? handleFork : undefined}
                  onRetry={retryActionsEnabled ? handleRetry : undefined}
                  onFeedbackChange={
                    !readOnly && !selectionSideChat && sessionId
                      ? handleAssistantFeedback
                      : undefined
                  }
                  onEdit={editActionsEnabled ? handleEdit : undefined}
                  canLoadOlder={timelineSnapshot ? hasOlderRows(timelineSnapshot) : false}
                  loadingOlder={timelineSnapshot ? state.loadingOlder : false}
                  onLoadOlder={handleLoadOlder}
                  onLoadAllOlder={handleLoadAllOlder}
                  turnNavigatorDirectoryRevision={state.turnNavigatorDirectoryRevision}
                  bottomDock={conversationBottomDock}
                  hideTurnNavigator={
                    shareActive && shareInSelectionStage && !compactForRemoteControl
                  }
                  backgroundScrollLocked={resolveConversationShareBackgroundScrollLocked({
                    partialShareActive: shareActive,
                    stage: shareDraft?.stage ?? "selection",
                    view: shareDraft?.view,
                  })}
                  headerSlot={
                    // unsupportedRowCount must also open this gate: when this build skips every row
                    // in the copy, rows is empty, but the read-only block must remain to show
                    // “Update ZCode required” instead of disappearing entirely.
                    importedShare &&
                    (importedShare.rows.length > 0 || importedShare.unsupportedRowCount > 0) ? (
                      <ConversationShareImportNotice
                        rows={importedShare.rows}
                        unsupportedRowCount={importedShare.unsupportedRowCount}
                        artifactNames={importedShareArtifactNames}
                        artifactWorkspaceRelativePaths={importedShareArtifactWorkspaceRelativePaths}
                        workspacePath={workspacePath}
                        {...(workspaceIdentity ? { workspaceIdentity } : {})}
                        {...(remoteSessionId ? { workspaceRemoteSessionId: remoteSessionId } : {})}
                        locale={locale}
                        theme={theme}
                        codePreviewSettings={codePreviewSettings}
                        onOpenShareUrl={onOpenBrowserUrl ? handleOpenImportedShareUrl : undefined}
                        onOpenFileLink={onOpenFileLink}
                        onOpenCodeViewer={onOpenCodeViewer}
                      />
                    ) : null
                  }
                  emptyState={
                    isDraft ? (
                      <div data-testid={TID_CHAT_EMPTY} className="w-full">
                        <ConversationDraftEmptyState
                          compactForRemoteControl={compactForRemoteControl}
                        />
                      </div>
                    ) : null
                  }
                  centerEmptyStateWithDock={isDraft}
                  compactEmptyStateWithDock={compactForRemoteControl}
                  summaryPanelLayout={statusPanelLayout}
                  conversationFindQuery={!isDraft && focused ? conversationFindQuery : ""}
                  conversationFindActiveIndex={
                    !isDraft && focused ? conversationFindActiveIndex : -1
                  }
                  conversationFindNavigationRequestId={
                    !isDraft && focused ? conversationFindNavigationRequestId : 0
                  }
                  onConversationFindMatchStateChange={
                    !isDraft && focused ? onConversationFindMatchStateChange : undefined
                  }
                  searchResultHighlightRequest={isDraft ? null : searchResultHighlightRequest}
                  onSearchResultHighlightDone={onSearchResultHighlightDone}
                  sessionPhase={isDraft ? undefined : snapshot?.control.phase}
                  shareSelection={
                    shareActive &&
                    shareInSelectionStage &&
                    shareDraft?.view === "timeline" &&
                    !compactForRemoteControl &&
                    sessionId
                      ? {
                          eligibleRowIds: eligibleShareRowIds,
                          selectedRowIds: selectedShareRowIds,
                          onToggle: handleShareSelectionToggle,
                        }
                      : undefined
                  }
                  selectionActions={
                    !isDraft &&
                    sessionId &&
                    !readOnly &&
                    !selectionSideChat &&
                    !isMobileTextInputViewport
                      ? {
                          enabled: resolveConversationSelectionTooltipEnabled({
                            selectionActionsEnabled: focused && !blockingInteractionId,
                            partialShareActive: shareActive,
                          }),
                          sideActionDisabled: selectionSideActionBlocked,
                          onAddToCurrentTask: handleAddSelectionToCurrentTask,
                          onAskInSideChat: handleOpenSelectionSideConversation,
                        }
                      : undefined
                  }
                />
              </BotGroupDeliveryProvider>
            </SessionPluginReferenceIconBoundary>
          )}
        </div>
      </div>
    </PluginUiSessionProvider>
  );
}
