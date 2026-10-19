/* oxlint-disable eslint(max-lines) -- V4WorkspaceChatArea hosts the split-pane workbench and centrally manages pane layout/focus/session binding; splitting it would make store actions and shell binding jump across files. */
import { useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type {
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenSelectionSideChatRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  effectiveFocusedPaneId,
  MAX_WORKBENCH_PANES,
  paneWorkspaceKey,
  PRIMARY_LEAF,
  usePaneLayoutStore,
  V4_PRIMARY_PANE_ID,
  type PaneSplitSide,
  type PaneWorkspaceScope,
} from "@/v4/paneLayoutStore.js";
import { collectWorkbenchLayout, dividerStyle, SPLIT_VAR_PREFIX } from "@/v4/workbenchLayout.js";
import { WorkbenchLeafPane, type WorkbenchShellBinding } from "@/v4/WorkbenchPane.js";
import { WorkbenchSplitDivider } from "@/v4/WorkbenchSplitDivider.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import {
  closeWorkbenchGroupPane,
  selectWorkbenchGroupActiveBinding,
  selectWorkbenchGroupPaneBinding,
  useWorkbenchGroupStore,
  type WorkbenchSessionBinding,
} from "@/v4/workbenchGroupStore.js";
import type { WorkbenchSessionDragPayload } from "@/v4/workbenchDragDrop.js";
import {
  canPlaceWorkbenchSessionInSplit,
  placeWorkbenchSessionInSplit,
  type WorkbenchSessionTarget,
} from "@/v4/workbenchSessionPlacement.js";

function dragPayloadSessionTarget(payload: WorkbenchSessionDragPayload): WorkbenchSessionTarget {
  return {
    workspacePath: payload.workspacePath,
    ...(payload.workspaceIdentity?.trim() ? { workspaceIdentity: payload.workspaceIdentity } : {}),
    ...(payload.remoteSessionId ? { remoteSessionId: payload.remoteSessionId } : {}),
    sessionId: payload.sessionId,
  };
}

export interface V4WorkspaceChatAreaProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Prompt-template telemetry currently covers Desktop only; Web/mobile remote control keeps the UI behavior but does not emit this event. */
  isDesktop?: boolean;
  readOnly?: boolean;
  readOnlySessionId?: string | null;
  selectionSideChatSessionId?: string | null;
  /** False when an overlay such as Settings is open; hidden panes must not consume one-time Composer requests. */
  foregroundEnabled?: boolean;
  remoteSessionId?: string;
  compactForRemoteControl?: boolean;
  /** CLI session bound to the primary pane (the existing activeTaskId selection); null means draft. */
  sessionId: string | null;
  activeSelectionSideChatSessionId?: string | null;
  provider?: ZCodeProvider;
  /** Route the primary pane through the existing selection path (handleSelectTask) after createSession/fork. */
  onSessionCreated?: (sessionId: string) => void;
  /** Return the primary pane to draft after its session is deleted (the shell starts a new draft). */
  onSessionDeleted?: () => void;
  /**
   * Composer contextHeader for draft state (m5: workspace menu + Git branch),
   * passed only to the primary pane—drafts in other panes do not handle shell-level workspace switching.
   */
  draftComposerHeader?: ReactNode;
  /** The lightweight desktop draft title bar reuses the primary draft composer's drop controller. */
  onPrimaryDraftDropTargetControllerChange?: (
    controller: ConversationDropTargetController | null,
  ) => void;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  summaryPanelVariantOverride?: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
  onRefreshGit?: () => void;
  onOpenGitReview?: (
    sourceId?: GitChangeSourceId,
    executionWorkspacePath?: string,
    executionSessionId?: string,
  ) => void;
  onPaneActiveSessionChange?: (
    scope: PaneWorkspaceScope,
    sessionId: string,
    capabilities?: { selectionSideChat?: boolean },
  ) => void;
  onOpenBrowserUrl?: (url: string) => void;
  /** Opens a created worktree through the shared workspace + draft flow; forwarded to every pane through the shell binding. */
  onCreateTaskInWorkspace?: (
    workspacePath: string,
    workspaceIdentity?: string,
  ) => void | Promise<void>;
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
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}

/**
 * Main chat area for split-workspace mode: a multi-pane workbench across workspaces.
 *
 * - Layout: the binary split tree in paneLayoutStore → absolutely positioned rects (CSS variables drive proportions);
 *   render leaves flat (key = paneId) so splitting/closing does not remount any surviving pane.
 * - Data: one V4PaneConversationProvider per pane; connections are reference-counted and reused by
 *   workspaceConnectionRegistry using endpoint+workspaceKey (panes in the same workspace share one transport + SessionDataLayer).
 * - Primary pane binding continues to use activeTaskId (shell props, switched with workspace tabs);
 *   other pane bindings belong to paneLayoutStore, carry their own workspaceScope, and persist across tabs.
 * - Focus: keyboard shortcuts (Esc stop)/add-to-chat route only to the focused pane.
 * - Restore guard: each restoredUnvalidated pane validates through its scope's sessions-index.
 */
export function V4WorkspaceChatArea({
  workspacePath,
  workspaceIdentity,
  isDesktop = false,
  readOnly = false,
  readOnlySessionId = null,
  selectionSideChatSessionId = null,
  foregroundEnabled = true,
  remoteSessionId,
  compactForRemoteControl = false,
  sessionId,
  activeSelectionSideChatSessionId = null,
  provider,
  onSessionCreated,
  onSessionDeleted,
  draftComposerHeader,
  onPrimaryDraftDropTargetControllerChange,
  gitSummary,
  gitDirtyFileCount,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeTaskChangeSummary,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  onRefreshGit,
  onOpenGitReview,
  onPaneActiveSessionChange,
  onOpenBrowserUrl,
  onCreateTaskInWorkspace,
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
}: V4WorkspaceChatAreaProps) {
  const shellWorkspaceKey = workspaceIdentity?.trim() || workspacePath;
  // Selectors return existing store references/derived primitives, avoiding rerenders when values are unchanged.
  const paneRoot = usePaneLayoutStore((state) => state.root);
  const paneBindings = usePaneLayoutStore((state) => state.panes);
  const paneFocusedPaneId = usePaneLayoutStore((state) => effectiveFocusedPaneId(state));
  // Zustand action references are stable.
  const splitPaneAction = usePaneLayoutStore((state) => state.splitPane);
  const closePaneAction = usePaneLayoutStore((state) => state.closePane);
  const confirmRestoredPaneSessionAction = usePaneLayoutStore(
    (state) => state.confirmRestoredPaneSession,
  );
  const focusPaneAction = usePaneLayoutStore((state) => state.focusPane);
  const bindPaneSessionAction = usePaneLayoutStore((state) => state.bindPaneSession);
  const setSplitRatioAction = usePaneLayoutStore((state) => state.setSplitRatio);
  const resetPaneLayoutAction = usePaneLayoutStore((state) => state.resetToPrimaryPane);
  const activeGroup = useWorkbenchGroupStore((state) =>
    compactForRemoteControl || !state.activeGroupId
      ? null
      : (state.groups[state.activeGroupId] ?? null),
  );
  const focusGroupPaneAction = useWorkbenchGroupStore((state) => state.focusPane);
  const closeGroupPaneAction = useWorkbenchGroupStore((state) => state.closePane);
  const confirmRestoredGroupPaneSessionAction = useWorkbenchGroupStore(
    (state) => state.confirmRestoredPaneSession,
  );
  const bindGroupPaneSessionAction = useWorkbenchGroupStore((state) => state.bindPaneSession);
  const setGroupSplitRatioAction = useWorkbenchGroupStore((state) => state.setSplitRatio);
  const promotePaneLayoutToGroupAction = useWorkbenchGroupStore(
    (state) => state.promotePaneLayoutToGroup,
  );

  const containerRef = useRef<HTMLDivElement | null>(null);

  const root = compactForRemoteControl ? PRIMARY_LEAF : (activeGroup?.root ?? paneRoot);
  const panes = compactForRemoteControl ? {} : (activeGroup?.panes ?? paneBindings);
  const focusedPaneId = compactForRemoteControl
    ? V4_PRIMARY_PANE_ID
    : (activeGroup?.focusedPaneId ?? paneFocusedPaneId);
  const layout = useMemo(() => collectWorkbenchLayout(root), [root]);
  const shellSessionOwnedBySplitPane = useMemo(() => {
    if (compactForRemoteControl || activeGroup || !sessionId) {
      return false;
    }
    return Object.values(paneBindings).some(
      (binding) =>
        binding.sessionId === sessionId &&
        paneWorkspaceKey(binding.workspaceScope) === shellWorkspaceKey,
    );
  }, [activeGroup, compactForRemoteControl, paneBindings, sessionId, shellWorkspaceKey]);
  // Reason for the fix: The primary draft has no sessionId of its own; when a session is dragged in, the shell’s active
  // may already point to the right pane's session; do not pass that sessionId to the primary pane.
  const primaryPaneSessionId = shellSessionOwnedBySplitPane ? null : sessionId;

  // Proportion wiring: the store changes only on commit (pointerup/restore); during dragging, the divider writes CSS variables directly.
  const containerStyle = useMemo<CSSProperties>(() => {
    const style: Record<string, string> = {};
    for (const divider of layout.dividers) {
      style[`${SPLIT_VAR_PREFIX}${divider.splitId}`] = String(divider.ratio);
    }
    return style as CSSProperties;
  }, [layout]);

  const paneCount = layout.leaves.length;
  const showFocusIndicator = paneCount > 1;
  const canSplit = paneCount < MAX_WORKBENCH_PANES;

  const shellScope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, workspacePath, workspaceIdentity],
  );
  const primarySessionBinding = useMemo<WorkbenchSessionBinding | null>(
    () =>
      primaryPaneSessionId
        ? {
            workspaceScope: shellScope,
            sessionId: primaryPaneSessionId,
            ...(primaryPaneSessionId === readOnlySessionId ? { readOnly: true } : {}),
            ...(primaryPaneSessionId === selectionSideChatSessionId
              ? { selectionSideChat: true }
              : {}),
          }
        : null,
    [primaryPaneSessionId, readOnlySessionId, selectionSideChatSessionId, shellScope],
  );
  const placementShellBinding = useMemo<WorkbenchSessionBinding | null>(
    () => primarySessionBinding,
    [primarySessionBinding],
  );

  const shell = useMemo<WorkbenchShellBinding>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      onCreateTaskInWorkspace,
      isDesktop,
      compactForRemoteControl,
      readOnlySessionId,
      selectionSideChatSessionId,
      readOnly,
      sessionId: primaryPaneSessionId,
      // primaryPaneSessionId is deliberately cleared when the active task is taken over by split panes;
      // selection-to-chat routing still needs the shell's actual active task id.
      activeSessionId: sessionId,
      activeSelectionSideChatSessionId,
      provider,
      onSessionCreated,
      onSessionDeleted,
      draftComposerHeader,
      onPrimaryDraftDropTargetControllerChange,
      gitSummary,
      gitDirtyFileCount,
      gitWorktreeReviewSourceId,
      gitWorktreeChangeSummary,
      activeTaskChangeSummary: primaryPaneSessionId ? activeTaskChangeSummary : null,
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
      conversationFindQuery,
      conversationFindActiveIndex,
      conversationFindNavigationRequestId,
      onConversationFindMatchStateChange,
      searchResultHighlightRequest,
      onSearchResultHighlightDone,
    }),
    [
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      onCreateTaskInWorkspace,
      isDesktop,
      compactForRemoteControl,
      readOnlySessionId,
      readOnly,
      primaryPaneSessionId,
      activeSelectionSideChatSessionId,
      provider,
      onSessionCreated,
      onSessionDeleted,
      draftComposerHeader,
      onPrimaryDraftDropTargetControllerChange,
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
      conversationFindQuery,
      conversationFindActiveIndex,
      conversationFindNavigationRequestId,
      onConversationFindMatchStateChange,
      searchResultHighlightRequest,
      onSearchResultHighlightDone,
    ],
  );

  const resolvePaneSessionBinding = useMemo(
    () =>
      (paneId: string): WorkbenchSessionBinding | null => {
        if (activeGroup) {
          return selectWorkbenchGroupPaneBinding(activeGroup, paneId);
        }
        if (paneId === V4_PRIMARY_PANE_ID) {
          return primarySessionBinding;
        }
        const binding = paneBindings[paneId];
        return binding?.sessionId
          ? {
              workspaceScope: binding.workspaceScope,
              sessionId: binding.sessionId,
              ...(binding.readOnly ? { readOnly: true } : {}),
              ...(binding.selectionSideChat ? { selectionSideChat: true } : {}),
            }
          : null;
      },
    [activeGroup, paneBindings, primarySessionBinding],
  );

  const syncShellActiveSession = useCallback(
    (binding: WorkbenchSessionBinding | null) => {
      if (!binding || binding.readOnly) {
        return;
      }
      // A read-only subagent pane is an observation view inside the workbench, not a left-side
      // task-navigation target. Writing back shell activeTaskId would incorrectly move the sidebar highlight/optimistic task to the child.
      if (binding.selectionSideChat) {
        onPaneActiveSessionChange?.(binding.workspaceScope, binding.sessionId, {
          selectionSideChat: true,
        });
      } else {
        onPaneActiveSessionChange?.(binding.workspaceScope, binding.sessionId);
      }
    },
    [onPaneActiveSessionChange],
  );

  const handleFocusRequest = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        focusGroupPaneAction(activeGroup.id, paneId);
      } else {
        focusPaneAction(paneId);
      }
      syncShellActiveSession(resolvePaneSessionBinding(paneId));
    },
    [
      activeGroup,
      focusGroupPaneAction,
      focusPaneAction,
      resolvePaneSessionBinding,
      syncShellActiveSession,
    ],
  );

  const handleClosePane = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        const nextGroup = closeWorkbenchGroupPane(activeGroup, paneId);
        const nextActiveBinding =
          activeGroup.focusedPaneId === paneId
            ? nextGroup
              ? selectWorkbenchGroupActiveBinding(nextGroup)
              : paneId === V4_PRIMARY_PANE_ID
                ? null
                : activeGroup.primaryBinding
            : null;
        closeGroupPaneAction(activeGroup.id, paneId);
        // The close store handles layout collapse only. If the closed pane was focused,
        // shell activeTaskId must return to a navigable session after closing rather than remaining on the closed session.
        syncShellActiveSession(nextActiveBinding);
      } else {
        const nextActiveBinding = focusedPaneId === paneId ? primarySessionBinding : null;
        closePaneAction(paneId);
        syncShellActiveSession(nextActiveBinding);
      }
    },
    [
      activeGroup,
      closeGroupPaneAction,
      closePaneAction,
      focusedPaneId,
      primarySessionBinding,
      syncShellActiveSession,
    ],
  );

  const handleConfirmRestoredSession = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        confirmRestoredGroupPaneSessionAction(activeGroup.id, paneId);
      } else {
        confirmRestoredPaneSessionAction(paneId);
      }
    },
    [activeGroup, confirmRestoredGroupPaneSessionAction, confirmRestoredPaneSessionAction],
  );

  const handleCommitSplitRatio = useMemo(
    () => (splitId: string, ratio: number) => {
      if (activeGroup) {
        setGroupSplitRatioAction(activeGroup.id, splitId, ratio);
      } else {
        setSplitRatioAction(splitId, ratio);
      }
    },
    [activeGroup, setGroupSplitRatioAction, setSplitRatioAction],
  );

  const handleBindSession = useMemo(
    () => (paneId: string, createdSessionId: string) => {
      if (activeGroup) {
        bindGroupPaneSessionAction(activeGroup.id, paneId, createdSessionId);
        return true;
      }
      if (paneId === V4_PRIMARY_PANE_ID) {
        const sourceLayout = usePaneLayoutStore.getState();
        if (Object.keys(sourceLayout.panes).length > 0) {
          // The draft primary is not in paneLayout.panes. After the first send is accepted, if only
          // the shell remembers the new session, focus on a bound secondary overwrites shell activeTaskId,
          // and the primary loses its identity and returns to draft. First atomically promote the visible layout with the new session as primaryBinding,
          // then let the parent sync shell active so both panes have stable owners.
          const promoted = promotePaneLayoutToGroupAction(
            { workspaceScope: shellScope, sessionId: createdSessionId },
            sourceLayout,
          );
          if (promoted) {
            resetPaneLayoutAction();
            logger.info("[v4-workbench] primary draft promoted to session group", {
              createdSessionId,
              workspaceKey: paneWorkspaceKey(shellScope),
            });
          }
        }
        return true;
      }
      bindPaneSessionAction(paneId, createdSessionId);
      if (!sessionId) {
        return false;
      }
      // A non-primary draft creates a new session on first send. If we immediately
      // write back shell activeTaskId, the primary pane is still driven by shell.sessionId
      // and will show the new session from the right pane. First promote the current paneLayout to a group,
      // fix the original session with primaryBinding, and then allow shell active to follow the new pane.
      const promoted = promotePaneLayoutToGroupAction(
        { workspaceScope: shellScope, sessionId },
        usePaneLayoutStore.getState(),
      );
      if (promoted) {
        // Promotion transfers layout ownership; it does not copy and double-write. Once the group owns the full
        // workspace scope/binding, consume the source immediately so an old split cannot reappear after refresh or group GC.
        resetPaneLayoutAction();
      }
      return promoted;
    },
    [
      activeGroup,
      bindGroupPaneSessionAction,
      bindPaneSessionAction,
      promotePaneLayoutToGroupAction,
      resetPaneLayoutAction,
      sessionId,
      shellScope,
    ],
  );

  const canDropSession = useCallback(
    (payload: WorkbenchSessionDragPayload) => {
      return canPlaceWorkbenchSessionInSplit(
        placementShellBinding,
        dragPayloadSessionTarget(payload),
        { mode: "drag", side: "right" },
      );
    },
    [placementShellBinding],
  );

  const handleDropSession = useCallback(
    (paneId: string, side: PaneSplitSide, payload: WorkbenchSessionDragPayload) => {
      placeWorkbenchSessionInSplit(placementShellBinding, dragPayloadSessionTarget(payload), {
        anchorPaneId: paneId,
        mode: "drag",
        side,
      });
    },
    [placementShellBinding],
  );

  return (
    <div ref={containerRef} style={containerStyle} className="relative h-full min-h-0 w-full">
      {layout.leaves.map((leaf) => (
        <WorkbenchLeafPane
          key={leaf.paneId}
          paneId={leaf.paneId}
          rect={leaf.rect}
          // Settings only makes the workspace inert; Pane previously retained focused=true
          // and consumed a one-time Plugin trial prefill while hidden. Include visibility in focus so only the Composer that is interactive
          // after returning to the workspace consumes the request.
          focused={foregroundEnabled && focusedPaneId === leaf.paneId}
          showFocusIndicator={showFocusIndicator}
          canSplit={canSplit}
          shellWorkspaceKey={shellWorkspaceKey}
          binding={leaf.paneId === V4_PRIMARY_PANE_ID ? null : (panes[leaf.paneId] ?? null)}
          primaryBinding={
            leaf.paneId === V4_PRIMARY_PANE_ID ? (activeGroup?.primaryBinding ?? null) : null
          }
          shell={shell}
          onFocusRequest={handleFocusRequest}
          onSplit={compactForRemoteControl || activeGroup ? undefined : splitPaneAction}
          onClosePane={handleClosePane}
          onConfirmRestoredSession={handleConfirmRestoredSession}
          onBindSession={handleBindSession}
          onPaneActiveSessionChange={onPaneActiveSessionChange}
          canDropSession={compactForRemoteControl ? undefined : canDropSession}
          onDropSession={compactForRemoteControl ? undefined : handleDropSession}
        />
      ))}
      {layout.dividers.map((divider) => (
        <WorkbenchSplitDivider
          key={divider.splitId}
          containerRef={containerRef}
          splitId={divider.splitId}
          direction={divider.direction}
          ratio={divider.ratio}
          regionFraction={divider.regionFraction}
          style={dividerStyle(divider)}
          onCommitRatio={handleCommitSplitRatio}
        />
      ))}
    </div>
  );
}
