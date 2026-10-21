import type {
  WebRemoteControlExternalWorkspaceBridge,
  WebRemoteControlWorkspaceBridge,
} from "@zcode/shared";
import {
  connectViaProtocol,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
} from "@zcode/client";
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

export function replayWebRemoteControlWorkspaceBridgeFrames(params: {
  activeRelayProtocol?: AcknowledgedWebRemoteControlRelayProtocolAdapter;
  pendingRelayProtocol?: AcknowledgedWebRemoteControlRelayProtocolAdapter;
}): void {
  // While capability validation is incomplete, the new bridge is still pending; replaying only active would leave dropped-frame requests waiting until degradation.
  // Restore pending first, so a degraded old active does not block the new bridge; replay is still deduplicated and time-limited by each adapter.
  params.pendingRelayProtocol?.replayUnacknowledged();
  if (params.activeRelayProtocol?.isDegraded()) return;
  // A same-socket matched may also have lost only the previous batch of data/ACK; replay using the original sequence-number dedup and the original 45-second deadline.
  params.activeRelayProtocol?.replayUnacknowledged();
}

/** Attach the inbound-frame path for a bridge that is not ready yet first; the caller publishes the service only after capabilities are verified. */
export async function connectWebRemoteControlWorkspaceBridgeServices(params: {
  relayProtocol: AcknowledgedWebRemoteControlRelayProtocolAdapter;
  windowProjectDirectory: boolean;
  activateTransport(): () => void;
  isCurrent(): boolean;
  signal?: AbortSignal;
}) {
  const superseded = () => new Error("Workspace bridge request was superseded.");
  if (params.signal?.aborted || !params.isCurrent()) {
    params.relayProtocol.dispose();
    throw superseded();
  }
  const releaseTransport = params.activateTransport();
  let interrupt!: (error: Error) => void;
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = reject;
  });
  const onAbort = () => interrupt(superseded());
  params.signal?.addEventListener("abort", onAbort, { once: true });
  const degraded = params.relayProtocol.onDegraded(() =>
    interrupt(new Error("Workspace bridge degraded before directory readiness.")),
  );
  try {
    const services = connectViaProtocol(params.relayProtocol.protocol, {
      windowProjectDirectory: params.windowProjectDirectory,
    });
    // The event listener has no ready reply. If we wait for RPC before attaching the inbound-frame path, the reply lands on the old bridge and waits forever.
    // A new navigation or connection termination cancels the wait at the same time; a late reply must not revive the old service or fall back to the Source directory.
    const capability = services.windowProjectDirectory
      ? services.windowProjectDirectory.changesService.getCapabilities().then((result) => {
          if (result?.version !== 1) throw new Error("window-project-directory.unsupported");
        })
      : Promise.resolve();
    await Promise.race([capability, interrupted]);
    if (!params.isCurrent() || params.signal?.aborted) throw superseded();
    return services;
  } catch (error) {
    releaseTransport();
    params.relayProtocol.dispose();
    throw error;
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
    degraded.dispose();
  }
}

export function registerWebRemoteControlWorkspaceBridgeServices(params: {
  bridge: WebRemoteControlBridgeWithRemoteSession;
  services: RemoteWorkspaceSession["services"];
}): WebRemoteControlWorkspaceBridgeServiceRegistration {
  const { bridge, services } = params;
  if (bridge.kind !== "remote") {
    return { dispose: () => {} };
  }

  // Bugfix: the remote bridge of the phone web relay had already connected to the host, but it was not written to the remote session store.
  // As a result, hooks could not resolve the session by workspaceIdentity, fell back to the disconnected proxy, and reported ZCODE_REMOTE_WORKSPACE_DISCONNECTED.
  registerRemoteWorkspaceSession({
    sessionId: bridge.remoteSessionId,
    services,
  });
  bindRemoteWorkspaceIdentity(bridge.workspaceIdentity, bridge.remoteSessionId);
  bindRemoteWorkspacePath(bridge.workspacePath, bridge.remoteSessionId);

  return {
    dispose: () => {
      // Bugfix: a phone hard recovery recreates the bridge for the same SSH session, and remoteSessionId may stay the same.
      // When the old bridge's dispose runs after the new bridge has registered, cleanup must not key only on sessionId, otherwise the new services
      // and identity/path mappings get deleted, and hooks then misjudge the state as ZCODE_REMOTE_WORKSPACE_DISCONNECTED.
      if (getRemoteWorkspaceSession(bridge.remoteSessionId)?.services !== services) {
        return;
      }
      unregisterRemoteWorkspaceSession(bridge.remoteSessionId);
    },
  };
}
