import type { IServiceAccessor } from "@zcode/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

interface WorkspaceServiceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: unknown;
}

export interface WorkspaceServiceResolverState<TServices = IServiceAccessor> {
  sessionsById: Record<string, { services: TServices }>;
  sessionIdByWorkspaceIdentity: Record<string, string>;
  sessionIdByWorkspacePath: Record<string, string>;
}

interface ResolvedWorkspaceServices {
  services: IServiceAccessor;
  remoteSessionId?: string;
  isRemoteWorkspace: boolean;
}

export function resolveWorkspaceRemoteSessionId<TServices>(
  target: WorkspaceServiceTarget,
  state: WorkspaceServiceResolverState<TServices>,
): string | undefined {
  const workspaceIdentity = target.workspaceIdentity?.trim();
  const candidateSessionIds = [
    target.remoteSessionId,
    workspaceIdentity ? state.sessionIdByWorkspaceIdentity[workspaceIdentity] : undefined,
    // The same path may exist on multiple SSH/WSL/Docker endpoints. When identity exists but the exact binding has not yet been restored,
    // falling back by path would borrow services from another endpoint and send sessions-index,
    // provider, and task RPCs to the wrong Host. If identity is missing, stay remote-waiting; use path-based compatibility restoration only for legacy remote tabs without
    // identity.
    !workspaceIdentity && target.remoteTarget
      ? state.sessionIdByWorkspacePath[target.workspacePath]
      : undefined,
  ];

  return candidateSessionIds.find((sessionId): sessionId is string =>
    Boolean(sessionId && state.sessionsById[sessionId]),
  );
}

export function isRemoteWorkspaceTarget(
  target: WorkspaceServiceTarget,
  resolvedRemoteSessionId?: string,
): boolean {
  return Boolean(target.workspaceIdentity || target.remoteTarget || resolvedRemoteSessionId);
}

export function resolveWorkspaceServices(
  target: WorkspaceServiceTarget,
  baseServices: IServiceAccessor,
  state: WorkspaceServiceResolverState,
): ResolvedWorkspaceServices | null {
  const remoteSessionId = resolveWorkspaceRemoteSessionId(target, state);
  const isRemoteWorkspace = isRemoteWorkspaceTarget(target, remoteSessionId);

  // During remote history restoration, a tab may initially have only workspaceIdentity, with remoteSessionId filled in later.
  // Do not fall back to baseServices in this state; it would query the remote workspace using local SQLite and cache an empty result.
  // Require remote targets to resolve to a remote session before returning services.
  if (isRemoteWorkspace) {
    const services = remoteSessionId ? state.sessionsById[remoteSessionId]?.services : undefined;
    return services
      ? {
          services,
          remoteSessionId,
          isRemoteWorkspace,
        }
      : null;
  }

  return {
    services: baseServices,
    isRemoteWorkspace,
  };
}

export function buildWorkspaceServiceLookup(
  workspaceTabs: WorkspaceServiceTarget[],
  baseServices: IServiceAccessor,
  state: WorkspaceServiceResolverState,
): Map<string, ResolvedWorkspaceServices> {
  const lookup = new Map<string, ResolvedWorkspaceServices>();

  for (const tab of workspaceTabs) {
    const resolved = resolveWorkspaceServices(tab, baseServices, state);
    if (!resolved) {
      continue;
    }

    lookup.set(buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity), resolved);
  }

  return lookup;
}
