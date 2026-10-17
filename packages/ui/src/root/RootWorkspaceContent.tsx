import { memo, useEffect } from "react";
import { App } from "@/App.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { WorkspaceSettingsLayer } from "@/root/WorkspaceSettingsLayer.js";
import { SessionManagerLayer } from "@/session-manager/SessionManagerLayer.js";
import type { AppProps } from "@/app-shell/types.js";
import type { RootProps } from "@/root/types.js";
import type { IFeedbackService, IServiceAccessor } from "@zcode/services";
import { ConversationTelemetryWorkspaceAttachment } from "@/v4/telemetry/ConversationTelemetryAttachment.js";

const StableWorkspaceApp = memo(App);

interface RootWorkspaceContentProps {
  workspaceScopedServices: IServiceAccessor;
  baseFeedbackService: IFeedbackService;
  workspaceShellPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeWorkspacePath: string | null;
  isSettingsTabActive: boolean;
  isSessionManagerTabActive: boolean;
  handleConnectRemote: AppProps["onConnectRemote"];
  handleSelectRemoteProject: AppProps["onSelectRemoteProject"];
  handleCancelRemoteProject: AppProps["onCancelRemoteProject"];
  handleReconnectRemoteWorkspace: AppProps["onReconnectRemoteWorkspace"];
  handleCreateTask: AppProps["onCreateTask"];
  handleCreateConversationTask: NonNullable<AppProps["onCreateConversationTask"]>;
  handleResolveConversationWorkspace: NonNullable<AppProps["onResolveConversationWorkspace"]>;
  handleOpenWorkspace: AppProps["onOpenWorkspace"];
  handleOpenFolderFromWorkspaceMenu: AppProps["onOpenFolderFromWorkspaceMenu"];
  handleOpenRemoteWorkspace?: AppProps["onOpenRemoteWorkspace"];
  handleCreateScratchWorkspace: AppProps["onCreateScratchWorkspace"];
  remoteConnectionInProgress?: AppProps["remoteConnectionInProgress"];
  remoteWorkspaceSessions: NonNullable<AppProps["remoteWorkspaceSessions"]>;
  allowRemoteWorkspace: NonNullable<RootProps["allowRemoteWorkspace"]>;
  handleBackFromSettings: () => void;
  handleLogout?: () => void;
  onLogin?: () => void;
  user: AppProps["user"];
  reconnectingRemoteWorkspaceKeys: AppProps["reconnectingRemoteWorkspaceKeys"];
  remoteWorkspaceErrorByWorkspaceKey: AppProps["remoteWorkspaceErrorByWorkspaceKey"];
  reconnectingRemoteWorkspaceLogsByWorkspaceKey: AppProps["reconnectingRemoteWorkspaceLogsByWorkspaceKey"];
  remoteConnectionLogs?: AppProps["remoteConnectionLogs"];
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  webRemoteControlWorkspaceSwitcher?: RootProps["webRemoteControlWorkspaceSwitcher"];
  initialWebRemoteControlMobileNavigationIntent?: RootProps["initialWebRemoteControlMobileNavigationIntent"];
  initialWebRemoteControlWorkspaceList?: RootProps["initialWebRemoteControlWorkspaceList"];
  webRemoteControlTerminalTransportState?: RootProps["webRemoteControlTerminalTransportState"];
  isDesktop?: RootProps["isDesktop"];
  isMacDesktop?: RootProps["isMacDesktop"];
  isWindowsDesktop?: RootProps["isWindowsDesktop"];
  supportsEmbeddedBrowser: NonNullable<RootProps["supportsEmbeddedBrowser"]>;
  windowsWindowControlsRightPaddingPx?: number;
}

export function RootWorkspaceContent({
  workspaceScopedServices,
  baseFeedbackService,
  workspaceShellPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeWorkspacePath,
  isSettingsTabActive,
  isSessionManagerTabActive,
  handleConnectRemote,
  handleSelectRemoteProject,
  handleCancelRemoteProject,
  handleReconnectRemoteWorkspace,
  handleCreateTask,
  handleCreateConversationTask,
  handleResolveConversationWorkspace,
  handleOpenWorkspace,
  handleOpenFolderFromWorkspaceMenu,
  handleOpenRemoteWorkspace,
  handleCreateScratchWorkspace,
  remoteConnectionInProgress,
  remoteWorkspaceSessions,
  allowRemoteWorkspace,
  handleBackFromSettings,
  handleLogout,
  onLogin,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey,
  remoteConnectionLogs,
  allowOpenWorkspace,
  webRemoteControlWorkspaceSwitcher,
  initialWebRemoteControlMobileNavigationIntent,
  initialWebRemoteControlWorkspaceList,
  webRemoteControlTerminalTransportState,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  supportsEmbeddedBrowser,
  windowsWindowControlsRightPaddingPx,
}: RootWorkspaceContentProps) {
  const workspaceKey = workspaceIdentity?.trim() || workspaceShellPath;
  // Settings and the sessions manager are both full-area overlays: the workspace shell stays
  // mounted and inert under either one (same rationale as the settings-only bugfix comments below).
  const overlaySurfaceActive = isSettingsTabActive || isSessionManagerTabActive;

  useEffect(() => {
    logger.info("[RootWorkspaceContent] settings layer visibility changed", {
      isSettingsTabActive,
      isSessionManagerTabActive,
      workspaceShellPath,
      workspaceHiddenByLayout: false,
    });
  }, [isSessionManagerTabActive, isSettingsTabActive, workspaceShellPath]);

  return (
    <>
      <div
        className={overlaySurfaceActive ? "h-full opacity-0 pointer-events-none" : "h-full"}
        aria-hidden={overlaySurfaceActive}
        data-root-workspace-surface={overlaySurfaceActive ? "inert" : "interactive"}
        inert={overlaySurfaceActive ? true : undefined}
      >
        {/* Bugfix: Previously, a conditional branch replaced the entire App with the settings page, unmounting and rebuilding the whole main tree when settings closed.
            Local UI state in the chat area, terminal, and elsewhere was therefore treated as if the workspace had been entered again.
            Keep the workspace shell mounted and overlay only the settings page.
            Adding a workspacePath-based key also unmounted and rebuilt the sidebar and task list when switching tasks across workspaces,
            causing visible list flicker and many mount/unmount logs.
            Keep the App instance continuous and synchronize only the workspace-local state that needs it, avoiding full-tree remounts when closing settings or switching workspaces.
            Also, do not use hidden to set the underlying workspace shell to display:none while switching to settings.
            The sidebar settings entry hosts a Radix DropdownMenu; if its anchor suddenly leaves layout during the menu's closing animation,
            Floating UI briefly loses its positioning reference, making the menu flash in the top-left corner before disappearing.
            We previously used invisible, which preserves geometry, but on some platforms the frame where the whole workspace shell becomes visibility:hidden
            appears to the sidebar as an abrupt visibility change, causing a brief left-side flash when opening settings.
            Use opacity-0 + pointer-events-none instead: layout and the menu anchor remain in place, preserving the DropdownMenu reference,
            while the layer transition becomes a stable transparent overlay and reduces sidebar flicker.
            Fix reason: Using hidden here would also make the quickpick overlay inherit display:none even though the workspace subtree remains mounted,
            so Cmd/Ctrl+K in settings would open quickpick state without making it visible. Preserve layout while disabling interaction instead.
            Fix reason: Opacity and pointer-events alone still let autofocus from underlying permission/AskUserQuestion cards
            steal focus from the settings form; mark the whole workspace inert while settings overlays it, then restore interaction when the user explicitly returns. */}
        <ConversationTelemetryWorkspaceAttachment
          enabled={isDesktop === true}
          foregroundEnabled={!overlaySurfaceActive}
          services={workspaceScopedServices}
          workspacePath={workspaceShellPath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={workspaceRemoteSessionId}
        >
          <ServiceProvider services={workspaceScopedServices}>
            <ScopedErrorBoundary
              scope="workspace-app"
              resetKeys={[workspaceKey]}
              variant="panel"
              className="h-full"
            >
              <StableWorkspaceApp
                services={workspaceScopedServices}
                baseFeedbackService={baseFeedbackService}
                onConnectRemote={handleConnectRemote}
                onSelectRemoteProject={handleSelectRemoteProject}
                onCancelRemoteProject={handleCancelRemoteProject}
                onReconnectRemoteWorkspace={handleReconnectRemoteWorkspace}
                onLogout={handleLogout}
                onLogin={onLogin}
                user={user}
                reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
                remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
                reconnectingRemoteWorkspaceLogsByWorkspaceKey={
                  reconnectingRemoteWorkspaceLogsByWorkspaceKey
                }
                remoteConnectionLogs={remoteConnectionLogs}
                workspaceAbsPath={workspaceShellPath}
                workspaceRemoteSessionId={workspaceRemoteSessionId}
                workspaceIdentity={workspaceIdentity}
                onCreateTask={handleCreateTask}
                onCreateConversationTask={handleCreateConversationTask}
                onResolveConversationWorkspace={handleResolveConversationWorkspace}
                onOpenWorkspace={handleOpenWorkspace}
                onOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
                onOpenRemoteWorkspace={handleOpenRemoteWorkspace}
                onCreateScratchWorkspace={handleCreateScratchWorkspace}
                remoteConnectionInProgress={remoteConnectionInProgress}
                onReturnToWorkspace={handleBackFromSettings}
                allowOpenWorkspace={allowOpenWorkspace}
                webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
                initialWebRemoteControlMobileNavigationIntent={
                  initialWebRemoteControlMobileNavigationIntent
                }
                initialWebRemoteControlWorkspaceList={initialWebRemoteControlWorkspaceList}
                webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
                allowRemoteWorkspace={allowRemoteWorkspace}
                remoteWorkspaceSessions={remoteWorkspaceSessions}
                isWorkspaceVisible={!overlaySurfaceActive}
                isDesktop={isDesktop}
                isMacDesktop={isMacDesktop}
                isWindowsDesktop={isWindowsDesktop}
                supportsEmbeddedBrowser={supportsEmbeddedBrowser}
              />
            </ScopedErrorBoundary>
          </ServiceProvider>
        </ConversationTelemetryWorkspaceAttachment>
      </div>

      {isSettingsTabActive ? (
        <ScopedErrorBoundary
          scope="workspace-settings-layer"
          resetKeys={[workspaceKey, isSettingsTabActive]}
          variant="panel"
          className="absolute inset-0 z-10"
        >
          <WorkspaceSettingsLayer
            workspaceScopedServices={workspaceScopedServices}
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            captionWorkspacePath={activeWorkspacePath}
            onBack={activeWorkspacePath ? handleBackFromSettings : undefined}
            onCreateTask={handleCreateTask}
            onOpenWorkspace={handleOpenWorkspace}
            allowOpenWorkspace={allowOpenWorkspace}
            onLogin={onLogin}
            onLogout={handleLogout}
            user={user}
          />
        </ScopedErrorBoundary>
      ) : null}

      {isSessionManagerTabActive ? (
        <ScopedErrorBoundary
          scope="session-manager-layer"
          resetKeys={[workspaceKey, isSessionManagerTabActive]}
          variant="panel"
          className="absolute inset-0 z-10"
        >
          <SessionManagerLayer />
        </ScopedErrorBoundary>
      ) : null}
    </>
  );
}
