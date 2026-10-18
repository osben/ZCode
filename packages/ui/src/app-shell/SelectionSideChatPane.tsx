import { memo, useCallback, useMemo } from "react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type {
  OpenBackgroundBashSideTabRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenScopedSubagentSideTabRequest,
  SelectionSideChatPaneTab,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

export const SelectionSideChatPane = memo(function SelectionSideChatPane({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenPlanDetail,
  onOpenSubagentSession,
  onOpenSubagentDirectory,
  onSyncSubagentSessionTabs,
  onOpenBackgroundBash,
  onUnavailable,
}: {
  tab: SelectionSideChatPaneTab;
  focused: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenPlanDetail?: (request: OpenScopedPlanDetailSideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
  onSyncSubagentSessionTabs?: (request: SyncSubagentSessionTabsRequest) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onUnavailable: (tabId: string) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  // The parent tabs.map previously created an inline closure for each memoized pane, so any parent render
  // changed the onUnavailable reference. Let the leaf component close over the stable tab ID instead.
  const handleUnavailable = useCallback(() => onUnavailable(tab.id), [onUnavailable, tab.id]);
  const handleOpenPlanDetail = useCallback(
    (request: OpenScopedPlanDetailSideTabRequest) =>
      onOpenPlanDetail?.({ ...request, rootSessionId: tab.parentSessionId }),
    [onOpenPlanDetail, tab.parentSessionId],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <SessionPane
        paneId={tab.id}
        sessionId={tab.childSessionId}
        // Subagents spawned inside this side chat belong to the main task, not to the side chat session.
        // Passing the tab's parent as the group root keeps the opened child tab visible under that task.
        rootSessionId={tab.parentSessionId}
        openTrigger="selection"
        selectionSideChat
        focused={focused}
        telemetryVisible={focused}
        workspacePath={tab.workspacePath}
        workspaceIdentity={tab.workspaceIdentity}
        remoteSessionId={tab.remoteSessionId}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
        onOpenPlanDetail={handleOpenPlanDetail}
        onOpenSubagentSession={onOpenSubagentSession}
        onOpenSubagentDirectory={onOpenSubagentDirectory}
        onSyncSubagentSessionTabs={onSyncSubagentSessionTabs}
        onOpenBackgroundBash={onOpenBackgroundBash}
        onSelectionSideChatUnavailable={handleUnavailable}
      />
    </V4PaneConversationProvider>
  );
});
