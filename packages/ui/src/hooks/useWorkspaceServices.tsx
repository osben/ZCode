import type { IServiceAccessor } from "@zcode/services";
import { Event, ProxyChannel, type IChannel } from "@zcode/rpc";
import { useMemo } from "react";
import { useOptionalServices, useServices } from "@/hooks/useServices.js";
import {
  useRemoteWorkspaceSessionStore,
  type RemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE } from "@/lib/remoteWorkspaceServiceError.js";

let disconnectedRemoteServices: IServiceAccessor | null = null;

interface WorkspaceServiceTargetTab {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
}

function createDisconnectedRemoteServices(): IServiceAccessor {
  const createDisconnectedError = () => {
    const error = new Error(REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE) as Error & {
      code: string;
    };
    error.code = REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
    return error;
  };
  const disconnectedChannel: IChannel = {
    call: () => Promise.reject(createDisconnectedError()),
    listen: () => Event.None,
  };
  // The disconnected proxy maintained its own ordinary-event allowlist. After onAgentRuntimeRestarted was added, it was misclassified as
  // an RPC method and returned a Promise, causing Promise.dispose to crash during unsubscribe. Reuse the real RPC proxy’s
  // event classification contract: explicitly reject commands and return empty subscriptions for ordinary/dynamic events, avoiding drift between two rule sets.
  const serviceProxy = ProxyChannel.toService<object>(disconnectedChannel);

  return new Proxy(Object.create(null), {
    get() {
      return serviceProxy;
    },
  }) as IServiceAccessor;
}

export function getDisconnectedRemoteServices(): IServiceAccessor {
  if (!disconnectedRemoteServices) {
    disconnectedRemoteServices = createDisconnectedRemoteServices();
  }
  return disconnectedRemoteServices;
}

export function resolveWorkspaceServicesForTarget(params: {
  currentContextServices: IServiceAccessor;
  resolvedRemoteSessionId: string | null;
  baseServices: IServiceAccessor | null;
  sessionsById: Record<string, Pick<RemoteWorkspaceSession, "services">>;
  isRemoteTarget: boolean;
}): IServiceAccessor {
  const resolvedServices = params.resolvedRemoteSessionId
    ? (params.sessionsById[params.resolvedRemoteSessionId]?.services ?? null)
    : params.isRemoteTarget
      ? getDisconnectedRemoteServices()
      : params.baseServices;

  if (params.isRemoteTarget && !resolvedServices) {
    return getDisconnectedRemoteServices();
  }

  return resolvedServices ?? params.currentContextServices;
}

export function resolveBaseWorkspaceServices(
  contextServices: IServiceAccessor,
  registeredBaseServices: IServiceAccessor | null,
): IServiceAccessor {
  return registeredBaseServices ?? contextServices;
}

function hasRemoteWorkspaceMetadata(tab: WorkspaceServiceTargetTab | null | undefined): boolean {
  return Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteSessionId?.trim() || tab?.remoteTarget,
  );
}

export function resolveWorkspaceServiceIsRemoteTarget(params: {
  workspacePath: string | null | undefined;
  workspaceIdentity?: string | null;
  preferredRemoteSessionId?: string | null;
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  activeTab?: WorkspaceServiceTargetTab | null;
  workspaceTabs?: readonly WorkspaceServiceTargetTab[];
}): boolean {
  if (params.workspaceIdentity?.trim() || params.preferredRemoteSessionId?.trim()) {
    return true;
  }

  const workspacePath = params.workspacePath?.trim();
  if (!workspacePath) {
    return false;
  }

  if (params.activeWorkspacePath === params.workspacePath) {
    if (params.activeWorkspaceIdentity?.trim()) {
      return true;
    }

    // Logs showed that a recovered remote SSH workspace was already a tab, but the draft-prewarm entry point sometimes received only
    // workspacePath, causing /mnt/... to be treated as local, use base services, and spawn a local agent on Windows.
    // Use the current tab’s remote metadata to guard path-only calls so remote targets do not accidentally fall back to the local host.
    if (
      params.activeTab?.workspacePath === params.workspacePath &&
      hasRemoteWorkspaceMetadata(params.activeTab)
    ) {
      return true;
    }
  }

  const matchingTabs = (params.workspaceTabs ?? []).filter(
    (tab) => tab.workspacePath === params.workspacePath,
  );
  return matchingTabs.length === 1 && hasRemoteWorkspaceMetadata(matchingTabs[0]);
}

export function useBaseWorkspaceServices(): IServiceAccessor {
  const contextServices = useServices();
  const registeredBaseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);

  // App wraps the currently active workspace in another ServiceProvider.
  // After activating a remote tab, useServices() resolves to the remote host; but local shards for cross-workspace queries such as timeline/search/workspace
  // must continue querying the local host.
  // Prefer the root services registered at renderer startup so a remote connection cannot contaminate the local task list.
  return resolveBaseWorkspaceServices(contextServices, registeredBaseServices);
}

export function useOptionalBaseWorkspaceServices(): IServiceAccessor | null {
  const contextServices = useOptionalServices();
  const registeredBaseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);

  // App-global capabilities such as usage entitlement previously read services from the active workspace ServiceProvider.
  // A remote tab could receive a disconnected proxy before its attachment was ready and issue invalid RPCs. The base host is
  // authoritative for app-global services; when Web/SSR has no registered base services, retain the existing context/null fallback behavior.
  return registeredBaseServices ?? contextServices;
}

export interface WorkspaceServicesResolution {
  services: IServiceAccessor;
  remoteSessionId: string | null;
  isRemoteTarget: boolean;
  connectionKind: "local-ready" | "remote-waiting" | "remote-ready";
  rpcReady: boolean;
}

export function useWorkspaceServicesResolution(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
): WorkspaceServicesResolution {
  const currentContextServices = useServices();
  const resolvedRemoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const isRemoteTarget = useTabStore((state) =>
    resolveWorkspaceServiceIsRemoteTarget({
      workspacePath,
      workspaceIdentity,
      preferredRemoteSessionId,
      activeWorkspacePath: state.activeWorkspacePath,
      activeWorkspaceIdentity: state.activeWorkspaceIdentity,
      activeTab: (() => {
        const activeTab = state.activeTabId
          ? state.tabs.find((tab) => tab.id === state.activeTabId)
          : null;
        return activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
      })(),
      workspaceTabs: state.tabs.filter(isWorkspaceTab),
    }),
  );
  const resolvedServices = useRemoteWorkspaceSessionStore((state) =>
    resolveWorkspaceServicesForTarget({
      currentContextServices,
      resolvedRemoteSessionId,
      baseServices: state.baseServices,
      sessionsById: state.sessionsById,
      isRemoteTarget,
    }),
  );
  const connectionKind = isRemoteTarget
    ? resolvedRemoteSessionId
      ? "remote-ready"
      : "remote-waiting"
    : "local-ready";

  // After a remote SSH host disconnects, falling back to baseServices while resolvedRemoteSessionId is empty
  // makes remote tasks such as /root be queried on the local host and fail with “task not found.” Keep remote targets disconnected when the session is missing,
  // letting the disconnected proxy return a recoverable error instead of routing the request to the local workspace.
  // During reconnect startup, having only tab metadata before real remote services are registered is the remote-waiting state.
  // Callers must pause workspace RPCs; keep the disconnected proxy only as a final boundary guard and do not treat the expected wait as a retryable failure.
  return useMemo(
    () => ({
      services: resolvedServices,
      remoteSessionId: resolvedRemoteSessionId,
      isRemoteTarget,
      connectionKind,
      rpcReady: connectionKind !== "remote-waiting",
    }),
    [connectionKind, isRemoteTarget, resolvedRemoteSessionId, resolvedServices],
  );
}

export function useWorkspaceServices(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
): IServiceAccessor {
  return useWorkspaceServicesResolution(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  ).services;
}
