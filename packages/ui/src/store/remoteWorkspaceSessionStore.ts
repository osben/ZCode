import { create } from "zustand";
import type { RemoteTarget, WorkspacePurpose } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { createRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";

export interface RemoteWorkspaceSession {
  sessionId: string;
  sourceServerId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
  /** Desktop bind 返回的旧 route tab rekey 提示；不参与 remote session 路由。 */
  previousWorkspaceIdentity?: string;
  target?: RemoteTarget;
  services: IServiceAccessor;
  dispose?: (reason?: Error) => void;
}

export type RemoteWorkspaceConnectionOverlay = "disconnected" | "reconnecting";

interface RemoteWorkspaceSessionState {
  baseServices: IServiceAccessor | null;
  sessionsById: Record<string, RemoteWorkspaceSession>;
  sessionIdByWorkspacePath: Record<string, string>;
  // Previously indexed only by workspacePath, so different remotes using the same path could overwrite each other.
  // Add a workspaceIdentity → session mapping here so remote sessions are uniquely bound by "host + path."
  sessionIdByWorkspaceIdentity: Record<string, string>;
  connectionOverlayByWorkspaceKey: Record<string, RemoteWorkspaceConnectionOverlay>;
  registerBaseServices: (services: IServiceAccessor) => void;
  registerSession: (session: RemoteWorkspaceSession) => void;
  unregisterSession: (sessionId: string) => void;
  bindWorkspacePath: (workspacePath: string, sessionId: string) => void;
  unbindWorkspacePath: (workspacePath: string) => void;
  bindWorkspaceIdentity: (workspaceIdentity: string, sessionId: string) => void;
  unbindWorkspaceIdentity: (workspaceIdentity: string) => void;
  setConnectionOverlay: (workspaceKey: string, state: RemoteWorkspaceConnectionOverlay) => void;
  clearConnectionOverlay: (workspaceKey: string) => void;
}

export const useRemoteWorkspaceSessionStore = create<RemoteWorkspaceSessionState>()((set) => ({
  baseServices: null,
  sessionsById: {},
  sessionIdByWorkspacePath: {},
  sessionIdByWorkspaceIdentity: {},
  connectionOverlayByWorkspaceKey: {},
  registerBaseServices: (services) =>
    set({
      baseServices: services,
    }),
  registerSession: (session) =>
    set((state) => ({
      sessionsById: {
        ...state.sessionsById,
        [session.sessionId]: session,
      },
    })),
  unregisterSession: (sessionId) =>
    set((state) => {
      const nextSessionsById = { ...state.sessionsById };
      delete nextSessionsById[sessionId];

      const nextSessionIdByWorkspacePath = Object.fromEntries(
        Object.entries(state.sessionIdByWorkspacePath).filter(
          ([, currentSessionId]) => currentSessionId !== sessionId,
        ),
      );

      const nextSessionIdByWorkspaceIdentity = Object.fromEntries(
        Object.entries(state.sessionIdByWorkspaceIdentity).filter(
          ([, currentSessionId]) => currentSessionId !== sessionId,
        ),
      );

      return {
        sessionsById: nextSessionsById,
        sessionIdByWorkspacePath: nextSessionIdByWorkspacePath,
        sessionIdByWorkspaceIdentity: nextSessionIdByWorkspaceIdentity,
      };
    }),
  bindWorkspacePath: (workspacePath, sessionId) =>
    set((state) => ({
      sessionIdByWorkspacePath: {
        ...state.sessionIdByWorkspacePath,
        [workspacePath]: sessionId,
      },
    })),
  unbindWorkspacePath: (workspacePath) =>
    set((state) => {
      if (!(workspacePath in state.sessionIdByWorkspacePath)) {
        return state;
      }

      const nextSessionIdByWorkspacePath = {
        ...state.sessionIdByWorkspacePath,
      };
      delete nextSessionIdByWorkspacePath[workspacePath];

      return {
        ...state,
        sessionIdByWorkspacePath: nextSessionIdByWorkspacePath,
      };
    }),
  bindWorkspaceIdentity: (workspaceIdentity, sessionId) =>
    set((state) => ({
      sessionIdByWorkspaceIdentity: {
        ...state.sessionIdByWorkspaceIdentity,
        [workspaceIdentity]: sessionId,
      },
    })),
  unbindWorkspaceIdentity: (workspaceIdentity) =>
    set((state) => {
      if (!(workspaceIdentity in state.sessionIdByWorkspaceIdentity)) {
        return state;
      }

      const nextSessionIdByWorkspaceIdentity = {
        ...state.sessionIdByWorkspaceIdentity,
      };
      delete nextSessionIdByWorkspaceIdentity[workspaceIdentity];

      return {
        ...state,
        sessionIdByWorkspaceIdentity: nextSessionIdByWorkspaceIdentity,
      };
    }),
  setConnectionOverlay: (workspaceKey, overlay) =>
    set((state) => ({
      connectionOverlayByWorkspaceKey: {
        ...state.connectionOverlayByWorkspaceKey,
        [workspaceKey]: overlay,
      },
    })),
  clearConnectionOverlay: (workspaceKey) =>
    set((state) => {
      if (!(workspaceKey in state.connectionOverlayByWorkspaceKey)) {
        return state;
      }
      const next = { ...state.connectionOverlayByWorkspaceKey };
      delete next[workspaceKey];
      return { connectionOverlayByWorkspaceKey: next };
    }),
}));

export function registerRemoteWorkspaceSession(session: RemoteWorkspaceSession): void {
  // A proxy for the same remoteSessionId can change generations repeatedly, and effects from different React consumers
  // may commit out of order. Session registration is the authoritative generation order, so allocate the monotonically increasing
  // generation in the shared generation module first, preventing a late intermediate proxy from switching transport back from the latest generation.
  // A Web/test fallback accessor may not provide agent transport yet; when it becomes subscribable, the registry still
  // assigns a generation on first observation, so do not break this compatibility shape for pre-registration.
  if (session.services.zcodeAgentService) {
    remoteAgentServiceGeneration(session.services.zcodeAgentService);
  }
  const previousSession = useRemoteWorkspaceSessionStore.getState().sessionsById[session.sessionId];
  if (previousSession && previousSession !== session) {
    // When an attachment for the same remoteSessionId changes generation, the old MessagePort may still have pending RPCs.
    // Finalize the old transport first so provider-sync in-flight Promises do not remain pending across generations forever.
    previousSession.dispose?.(createRemoteWorkspaceDisconnectedError());
  }
  useRemoteWorkspaceSessionStore.getState().registerSession(session);
}

export function registerBaseWorkspaceServices(services: IServiceAccessor): void {
  useRemoteWorkspaceSessionStore.getState().registerBaseServices(services);
}

export function unregisterRemoteWorkspaceSession(sessionId: string): void {
  const session = useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId];
  useRemoteWorkspaceSessionStore.getState().unregisterSession(sessionId);
  // Synchronization may happen before workspace binding, so the index alone cannot clean up in-flight work.
  // The injected disposer finalizes the attachment directly, making ChannelClient fail closed for pending RPCs.
  session?.dispose?.(createRemoteWorkspaceDisconnectedError());
}

export function bindRemoteWorkspacePath(workspacePath: string, sessionId: string): void {
  useRemoteWorkspaceSessionStore.getState().bindWorkspacePath(workspacePath, sessionId);
}

export function unbindRemoteWorkspacePath(workspacePath: string): void {
  useRemoteWorkspaceSessionStore.getState().unbindWorkspacePath(workspacePath);
}

export function bindRemoteWorkspaceIdentity(workspaceIdentity: string, sessionId: string): void {
  useRemoteWorkspaceSessionStore.getState().bindWorkspaceIdentity(workspaceIdentity, sessionId);
}

export function unbindRemoteWorkspaceIdentity(workspaceIdentity: string): void {
  useRemoteWorkspaceSessionStore.getState().unbindWorkspaceIdentity(workspaceIdentity);
}

export function setRemoteWorkspaceConnectionState(
  workspaceKey: string,
  state: RemoteWorkspaceConnectionOverlay,
): void {
  useRemoteWorkspaceSessionStore.getState().setConnectionOverlay(workspaceKey, state);
}

export function clearRemoteWorkspaceConnectionState(workspaceKey: string): void {
  useRemoteWorkspaceSessionStore.getState().clearConnectionOverlay(workspaceKey);
}

export function getRemoteWorkspaceConnectionState(
  workspaceKey: string,
): RemoteWorkspaceConnectionOverlay | undefined {
  return useRemoteWorkspaceSessionStore.getState().connectionOverlayByWorkspaceKey[workspaceKey];
}

export function getRemoteWorkspaceSession(sessionId: string): RemoteWorkspaceSession | null {
  return useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId] ?? null;
}

/** Remote session identity of the currently registered proxy; proxies from old generations do not match. Used only for scope diagnostics. */
export function findRemoteWorkspaceSessionIdForAgentService(agentService: object): string | null {
  for (const session of Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById)) {
    if (session.services.zcodeAgentService === agentService) {
      return session.sessionId;
    }
  }
  return null;
}

export function getRemoteWorkspaceServicesForPath(workspacePath: string): IServiceAccessor | null {
  const state = useRemoteWorkspaceSessionStore.getState();
  const sessionId = state.sessionIdByWorkspacePath[workspacePath];
  if (!sessionId) {
    return null;
  }

  return state.sessionsById[sessionId]?.services ?? null;
}

export function getRemoteWorkspaceServicesForIdentity(
  workspaceIdentity: string,
): IServiceAccessor | null {
  const state = useRemoteWorkspaceSessionStore.getState();
  const sessionId = state.sessionIdByWorkspaceIdentity[workspaceIdentity];
  if (!sessionId) {
    return null;
  }

  return state.sessionsById[sessionId]?.services ?? null;
}

export function getRegisteredBaseWorkspaceServices(): IServiceAccessor | null {
  return useRemoteWorkspaceSessionStore.getState().baseServices;
}

export function resolveRegisteredWorkspaceServices(params: {
  workspacePath?: string;
  workspaceIdentity?: string;
}): IServiceAccessor | null {
  if (params.workspaceIdentity?.trim()) {
    return (
      getRemoteWorkspaceServicesForIdentity(params.workspaceIdentity) ??
      getRegisteredBaseWorkspaceServices()
    );
  }

  if (params.workspacePath?.trim()) {
    return (
      getRemoteWorkspaceServicesForPath(params.workspacePath) ??
      getRegisteredBaseWorkspaceServices()
    );
  }

  return getRegisteredBaseWorkspaceServices();
}
