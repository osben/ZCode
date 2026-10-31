import type {
  RemoteConnectionFeedbackOptions,
  RemoteConnectionOpenPreference,
} from "@/app-shell/types.js";
export { requestRemoteProjectConnection } from "@/remote-connection-flow/requestRemoteProjectConnection.js";
import { type RemoteTarget, type RemoteWorkspaceSessionEntry } from "@zcode/shared";

export interface RemoteConnectionFlowOptions {
  /** A new explicit entry; card recovery does not change this identifier. */
  openIntentId?: number;
  completion?: RemoteConnectionOpenPreference["completion"];
  /** Device-management connection succeeded; navigation is the entry point's job, no project is created. */
  onDeviceConnected?: (
    sourceServerId: string | undefined,
    canDeliver?: () => boolean,
  ) => void | Promise<void>;
  /** Fires only on an explicit user cancel; successful close and background collapse do not fire it. */
  onCancelled?: (background?: boolean) => void;
  initialFailure?: RemoteConnectionOpenPreference["initialFailure"];
  onConnect: (
    options: RemoteTarget,
    requestId?: string,
    context?: { confirmSourceServerInstall?: boolean },
    feedback?: RemoteConnectionFeedbackOptions,
  ) => Promise<string>;
  /** The project wizard takes over directory selection after the connection completes; no session is prepared. */
  onConnectionReady?: (sessionId: string) => Promise<void>;
  onSelectProject: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
    workspacePurpose?: "project" | "conversation",
  ) => Promise<void>;
  onCancelSession: (sessionId: string) => Promise<void>;
  localWorkspacePath?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  isWindowsDesktop?: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  onFlowActiveChange?: (active: boolean) => void;
  onFlowRequestIdChange?: (requestId: string | null) => void;
  onFlowTargetChange?: (target: RemoteTarget | null) => void;
  preferredKind?: RemoteTarget["kind"];
  preferredWslDistro?: string;
  preferredSourceServerId?: string;
  preferredProfileId?: string;
  preferredDirectoryPath?: string;
  preferredTarget?: RemoteTarget;
  /** After the user picks a different route or creates a new connection, releases Root's recovery mutex on the original project. */
  onProjectIntentCleared?: () => void;
}

export interface RemoteConnectionCompletionIntent {
  preferredDirectoryPath?: string;
  options?: {
    directToDirectory?: boolean;
    localWorkspacePath?: string;
    announceReusedConnection?: boolean;
  };
}

export function normalizeRemoteConnectionOptions({
  openIntentId,
  completion,
  onDeviceConnected,
  onCancelled,
  onConnect,
  onConnectionReady,
  onSelectProject,
  onCancelSession,
  localWorkspacePath,
  open: controlledOpen,
  onOpenChange,
  isWindowsDesktop = false,
  remoteWorkspaceSessions = [],
  onFlowActiveChange,
  onFlowRequestIdChange,
  onFlowTargetChange,
  preferredKind,
  preferredWslDistro,
  preferredSourceServerId,
  preferredProfileId,
  preferredDirectoryPath,
  preferredTarget,
  onProjectIntentCleared,
  initialFailure,
}: RemoteConnectionFlowOptions) {
  return {
    openIntentId,
    completion,
    onDeviceConnected,
    onCancelled,
    onConnect,
    onConnectionReady,
    onSelectProject,
    onCancelSession,
    localWorkspacePath,
    controlledOpen,
    onOpenChange,
    isWindowsDesktop,
    remoteWorkspaceSessions,
    onFlowActiveChange,
    onFlowRequestIdChange,
    onFlowTargetChange,
    preferredKind,
    preferredWslDistro,
    preferredSourceServerId,
    preferredProfileId,
    preferredDirectoryPath,
    preferredTarget,
    onProjectIntentCleared,
    initialFailure,
  };
}
export type RemoteConnectionOptions = ReturnType<typeof normalizeRemoteConnectionOptions>;

/** Read-only UI projection of the single Root flow; holds no credentials and persists no connection facts. */
export interface RemoteConnectionProgress {
  operationId: string;
  view: import("@/RemoteConnectionWizardChrome.js").RemoteWizardStep;
  cancelled: boolean;
  target: RemoteTarget | null;
  sourceServerId?: string;
  profileId?: string;
  name?: string;
  logs: import("@/hooks/useRemoteConnectionLogs.js").RemoteConnectionLogEntry[];
  /** The project folder this connection opens; when set, the flow gains an extra "Open project folder" step, matching the connection screen. */
  workspacePath?: string;
  error: string;
  reason: string;
  waiting: boolean;
  ready: boolean;
  onResume(): void;
  onCancel(): void;
}
