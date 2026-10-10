import type { IPlatformService, UserInfo } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { ReactNode } from "react";
import type { CreateTaskRequest } from "@/app-shell/types.js";

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
  /** Loading content shown before injecting the initial workspace for non-Desktop entry points; unused on Desktop. */
  initialWorkspaceLoadingFallback?: ReactNode;
  /** Assistant code-comment card rollout; disabled by default, retaining the original directive when off. */
  assistantCodeCommentCardsEnabled?: boolean;
}

export interface WorkspaceSettingsLayerProps {
  workspaceScopedServices?: IServiceAccessor;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
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
