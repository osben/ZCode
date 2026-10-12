import type {
  WebRemoteControlExternalWorkspaceBridge,
  WebRemoteControlWorkspaceBridge,
} from "@zcode/shared";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  getRemoteWorkspaceSession,
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
  type RemoteWorkspaceSession,
} from "@zcode/ui/remote-workspace-session-store";

type WebRemoteControlBridgeWithRemoteSession =
  | WebRemoteControlExternalWorkspaceBridge
  | WebRemoteControlWorkspaceBridge;

export interface WebRemoteControlWorkspaceBridgeServiceRegistration {
  dispose: () => void;
}

export function registerWebRemoteControlWorkspaceBridgeServices(params: {
  bridge: WebRemoteControlBridgeWithRemoteSession;
  services: RemoteWorkspaceSession["services"];
}): WebRemoteControlWorkspaceBridgeServiceRegistration {
  const { bridge, services } = params;
  if (bridge.kind !== "remote") {
    return { dispose: () => {} };
  }

  // Bugfix: the mobile web relay's remote bridge was already connected to the
  // host but was never written into the remote session store. Hooks then could
  // not resolve a session by workspaceIdentity and fell back to the disconnect
  // proxy, reporting ZCODE_REMOTE_WORKSPACE_DISCONNECTED.
  registerRemoteWorkspaceSession({
    sessionId: bridge.remoteSessionId,
    services,
  });
  bindRemoteWorkspaceIdentity(bridge.workspaceIdentity, bridge.remoteSessionId);
  bindRemoteWorkspacePath(bridge.workspacePath, bridge.remoteSessionId);

  return {
    dispose: () => {
      // Bugfix: a hard mobile recovery recreates the bridge for the same SSH
      // session, so remoteSessionId may be unchanged. When the old bridge's
      // dispose runs after the new bridge registered, cleanup must not rely on
      // sessionId alone, otherwise it would delete the new services and
      // identity/path mappings and hooks would then misread
      // ZCODE_REMOTE_WORKSPACE_DISCONNECTED.
      if (getRemoteWorkspaceSession(bridge.remoteSessionId)?.services !== services) {
        return;
      }
      unregisterRemoteWorkspaceSession(bridge.remoteSessionId);
    },
  };
}
