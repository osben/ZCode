import type {
  IPlatformService,
  UserInfo,
  WebRemoteControlMobileNavigationIntent,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlWorkspaceSwitchOptions,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { ReactNode } from "react";
import type { CreateTaskRequest } from "@/app-shell/types.js";

export type WebRemoteControlTerminalTransportState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting"
  | "paired"
  | "reconnecting"
  | "suspended"
  | "kicked"
  | "error";

export interface WebRemoteControlWorkspaceSwitcherApi {
  listWorkspaces(): Promise<WebRemoteControlWorkspaceListResult>;
  onWorkspaceListUpdated?(
    listener: (result: WebRemoteControlWorkspaceListResult) => void,
  ): () => void;
  switchWorkspace(
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions,
  ): Promise<void>;
  /** Mobile task home confirms the user viewed an unread task in the current bridge; unused by the desktop task-selection flow. */
  markTaskRead?(task: WebRemoteControlTaskTarget): Promise<void>;
  updateMobileViewState?(workspaceKey: string, taskId?: string): Promise<void>;
  reconnectWorkspace?(workspaceKey: string): Promise<void>;
  startDraft?(
    workspaceKey: string,
    options?: { mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent },
  ): Promise<void>;
}

export interface RootProps {
  services: IServiceAccessor;
  platform: IPlatformService;
  /** Skip the project selection page when passed from the main process. */
  initialWorkspaceAbsPath?: string;
  /** Display category for an app-owned workspace; defaults to a real project. */
  initialWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  /** The exact active local workspace is unavailable at desktop startup; only applies to this renderer lifecycle. */
  unavailableWorkspacePath?: string;
  /** Identity-isolation key for the initial workspace; remote workspaces must pass it through. */
  initialWorkspaceIdentity?: string;
  /** Initial task to open, passed when entering from the global task list. */
  initialTaskId?: string;
  /** Electron renderer passes true to enable the custom title bar. */
  isDesktop?: boolean;
  /** Reserve a safe area for traffic-light buttons on macOS Desktop. */
  isMacDesktop?: boolean;
  /** Show more accurate File Explorer wording on Windows Desktop. */
  isWindowsDesktop?: boolean;
  /** Whether to restore tabs from the previous close; true for the first window, false for new windows. */
  restoreSession?: boolean;
  /** Whether local settings service access is allowed; false for remote windows. */
  supportsSettings?: boolean;
  /** Whether switching to/opening a workspace is allowed in the current shell. */
  allowOpenWorkspace?: boolean;
  /** Whether to prefer the server-side directory browser; regular Web mode cannot depend on the system directory picker. */
  preferDirectoryBrowser?: boolean;
  /** Whether an Electron embedded-browser side pane is supported; by default, only Desktop supports it. */
  supportsEmbeddedBrowser?: boolean;
  /** Whether remote-workspace features are enabled; regular Web mode initially supports only local server workspaces. */
  allowRemoteWorkspace?: boolean;
  /** Open workspace-switch entry point in Web remote-control mode. */
  webRemoteControlWorkspaceSwitcher?: WebRemoteControlWorkspaceSwitcherApi;
  /** One-shot mobile destination after selecting a task across workspaces in Web remote-control mode. */
  initialWebRemoteControlMobileNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  /** Workspace/task list preloaded by mobile home when Web remote control has no workspace to bridge. */
  initialWebRemoteControlWorkspaceList?: WebRemoteControlWorkspaceListResult;
  /** Relay terminal transport state on mobile Web remote control, used for lightweight recovery notices after entering the page. */
  webRemoteControlTerminalTransportState?: WebRemoteControlTerminalTransportState;
  /** Keep showing entry-point loading on mobile Web remote control until the initial workspace is injected; unused on desktop. */
  initialWorkspaceLoadingFallback?: ReactNode;
  /** Feature flag for the Web remote-control entry point; enabled only in development by default. */
  webRemoteControlFeatureEnabled?: boolean;
  /** Assistant code-comment card rollout; disabled by default, retaining the original directive when off. */
  assistantCodeCommentCardsEnabled?: boolean;
}

export interface WorkspaceSettingsLayerProps {
  workspaceScopedServices?: IServiceAccessor;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isWebRemoteControl?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  captionWorkspacePath?: string | null;
  onBack?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenWorkspace?: () => void;
  allowOpenWorkspace?: RootProps["allowOpenWorkspace"];
  onLogin?: () => void;
  onLogout?: () => void;
  user?: UserInfo | null;
}
