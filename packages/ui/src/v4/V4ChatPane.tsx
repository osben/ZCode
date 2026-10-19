import type { ReactNode } from "react";
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
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { V4ConversationProvider } from "@/v4/V4ConversationContext.js";
import { SessionPane } from "@/v4/SessionPane.js";
import type { SessionOpenTrigger } from "@/lib/sessionOpenArmsTelemetry.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";

export interface V4ChatPaneProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Prompt-template telemetry currently covers Desktop only. */
  isDesktop?: boolean;
  readOnly?: boolean;
  selectionSideChat?: boolean;
  compactForRemoteControl?: boolean;
  /** CLI session ID; null = first send from a draft. */
  sessionId: string | null;
  /** Open a path through the app's existing workspace + draft flow. */
  onCreateTaskInWorkspace?: (workspacePath: string) => void | Promise<void>;
  /** Open entry point for the current workspace's primary pane; count as sidebar when not provided. */
  openTrigger?: SessionOpenTrigger;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string) => void;
  /** deleteSession: return to draft after deleting the current session. */
  onSessionDeleted?: () => void;
  /** Draft-mode composer contextHeader (m5, constructed and passed by the shell). */
  draftComposerHeader?: ReactNode;
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
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
  onSyncSubagentSessionTabs?: (request: SyncSubagentSessionTabsRequest) => void;
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
 * Vertically split chat area: minimal replacement entry point for ChatView.
 * The outer layer wraps V4ConversationProvider per workspace; single-pane paneId is fixed to workspace-main.
 */
export function V4ChatPane({
  workspacePath,
  workspaceIdentity,
  isDesktop = false,
  readOnly = false,
  selectionSideChat = false,
  compactForRemoteControl = false,
  sessionId,
  onCreateTaskInWorkspace,
  openTrigger = "sidebar",
  provider,
  onSessionCreated,
  onSessionDeleted,
  draftComposerHeader,
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
}: V4ChatPaneProps) {
  return (
    <V4ConversationProvider workspacePath={workspacePath} workspaceIdentity={workspaceIdentity}>
      <SessionPane
        paneId="workspace-main"
        readOnly={readOnly}
        selectionSideChat={selectionSideChat}
        sessionId={sessionId}
        onCreateTaskInWorkspace={onCreateTaskInWorkspace}
        openTrigger={openTrigger}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        isDesktop={isDesktop}
        compactForRemoteControl={compactForRemoteControl}
        provider={provider}
        onSessionCreated={onSessionCreated}
        onSessionDeleted={onSessionDeleted}
        draftComposerHeader={draftComposerHeader}
        gitSummary={gitSummary}
        gitDirtyFileCount={gitDirtyFileCount}
        gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
        gitWorktreeChangeSummary={gitWorktreeChangeSummary}
        activeTaskChangeSummary={activeTaskChangeSummary}
        summaryPanelVariantOverride={summaryPanelVariantOverride}
        onSummaryPanelVariantOverrideChange={onSummaryPanelVariantOverrideChange}
        onRefreshGit={onRefreshGit}
        onOpenGitReview={onOpenGitReview}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenAutomationsMain={onOpenAutomationsMain}
        onOpenCodeViewer={onOpenCodeViewer}
        onAutoOpenAssistantPptx={onAutoOpenAssistantPptx}
        onOpenFileLink={onOpenFileLink}
        onOpenSubagentSession={onOpenSubagentSession}
        onOpenBackgroundBash={onOpenBackgroundBash}
        onOpenSubagentDirectory={onOpenSubagentDirectory}
        onSyncSubagentSessionTabs={onSyncSubagentSessionTabs}
        onOpenPlanDetail={onOpenPlanDetail}
        onOpenWorkflowRun={onOpenWorkflowRun}
        onOpenWorkflowArtifact={onOpenWorkflowArtifact}
        onOpenWorkflowRunDirectory={onOpenWorkflowRunDirectory}
        onOpenWorkflowActorSession={onOpenWorkflowActorSession}
        onOpenWorkflowWorkspace={onOpenWorkflowWorkspace}
        conversationFindQuery={conversationFindQuery}
        conversationFindActiveIndex={conversationFindActiveIndex}
        conversationFindNavigationRequestId={conversationFindNavigationRequestId}
        onConversationFindMatchStateChange={onConversationFindMatchStateChange}
        searchResultHighlightRequest={searchResultHighlightRequest}
        onSearchResultHighlightDone={onSearchResultHighlightDone}
      />
    </V4ConversationProvider>
  );
}
