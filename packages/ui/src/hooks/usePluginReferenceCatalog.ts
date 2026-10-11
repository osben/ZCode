import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ZCodePluginReferenceCatalogEntry,
  ZCodePluginsReferenceCatalogResult,
} from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export interface PluginReferenceCatalogState {
  entries: ZCodePluginReferenceCatalogEntry[];
  authority: "session" | "workspace" | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: PluginReferenceCatalogState = {
  entries: [],
  authority: null,
  loading: false,
  error: null,
};

interface ScopedPluginReferenceCatalogState {
  scope: object | null;
  value: PluginReferenceCatalogState;
}

const EMPTY_SCOPED_STATE: ScopedPluginReferenceCatalogState = {
  scope: null,
  value: EMPTY_STATE,
};

export interface PluginReferenceCatalogOptions {
  preferredRemoteSessionId?: string;
  /** Explicit retry generation; reopening the menu refetches, while closing it does not clear a loaded catalog. */
  refreshRevision?: number;
  /** Coalesce only unsettled requests for the same Session in the current runtime; release immediately after settlement. */
  dedupeSessionRequest?: boolean;
  suppressErrorLog?: boolean;
}

let sessionCatalogRequests = new WeakMap<
  object,
  Map<string, Promise<ZCodePluginsReferenceCatalogResult>>
>();

export function clearPluginReferenceCatalogCacheForTest(): void {
  sessionCatalogRequests = new WeakMap();
}

function releaseSessionCatalogRequest(
  services: object,
  serviceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>>,
  requestKey: string,
  request: Promise<ZCodePluginsReferenceCatalogResult>,
): void {
  // A successful promise used to remain cached forever and impersonate Session authority in a newer Agent runtime.
  // Cache only in-flight work during mount; when an old request settles or unmounts, it must not delete a replacement request with the same key.
  if (serviceCache.get(requestKey) !== request) return;
  serviceCache.delete(requestKey);
  if (serviceCache.size === 0) {
    sessionCatalogRequests.delete(services);
  }
}

function releaseSessionCatalogRequestWhenSettled(
  services: object,
  serviceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>>,
  requestKey: string,
  request: Promise<ZCodePluginsReferenceCatalogResult>,
): void {
  const release = () => releaseSessionCatalogRequest(services, serviceCache, requestKey, request);
  void request.then(release, release);
}

/**
 * Plugin conversation-reference catalog.
 * Authority is determined by sessionId: null (new draft) → current workspace catalog;
 * non-null (existing Session) → the session-owned catalog frozen when that Session was created.
 * Validate async results by `workspaceKey + sessionId + runtime restart generation + request sequence`. Discard returns
 * from an old workspace/session/process generation after the key changes or a newer request starts; never apply them to a new target.
 */
export function usePluginReferenceCatalog(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  enabled: boolean,
  options?: PluginReferenceCatalogOptions,
): PluginReferenceCatalogState {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    options?.preferredRemoteSessionId,
    workspaceIdentity,
  );
  const [scopedState, setScopedState] =
    useState<ScopedPluginReferenceCatalogState>(EMPTY_SCOPED_STATE);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const requestSeqRef = useRef(0);
  // Standardize identity/isolation semantics as workspaceKey = workspaceIdentity?.trim() || workspacePath.
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const remoteSessionId =
    resolution.remoteSessionId ?? options?.preferredRemoteSessionId ?? undefined;
  // Remote attachment is also an authority boundary. Do not reuse a catalog promise frozen by an old process when the same workspace/session switches remote runtime.
  const requestKey = `${workspaceKey}|${remoteSessionId ?? "local"}|${sessionId ?? "draft"}|runtime:${runtimeRevision}|refresh:${options?.refreshRevision ?? 0}`;
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;

  useEffect(() => {
    if (!enabled || !workspacePath || !sessionId || !rpcReady) return;
    const subscription = services.zcodeAgentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      // Workspace/session/attachment may all remain unchanged after runtime restart. Advance the generation explicitly
      // so the old authority's first frame is invalidated and the new runtime must issue RPC again.
      setRuntimeRevision((current) => current + 1);
    });
    return () => subscription.dispose();
  }, [enabled, rpcReady, services, sessionId, workspaceKey, workspacePath]);
  // Create a new request identity whenever Picker reopens, workspace/session/remote attachment changes, or the services
  // instance reconnects. Rendering accepts results only for the same scope, so the first frame before the effect issues a
  // new request cannot briefly expose the previous authority's catalog.
  const requestScope = useMemo(
    () => ({}),
    [enabled, remoteSessionId, requestKey, rpcReady, services, workspacePath],
  );

  useEffect(() => {
    if (!enabled || !workspacePath || !rpcReady) {
      return;
    }
    const seq = ++requestSeqRef.current;
    let cancelled = false;
    setScopedState({
      scope: requestScope,
      value: { entries: [], authority: null, loading: true, error: null },
    });
    const params = {
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    let request: Promise<ZCodePluginsReferenceCatalogResult>;
    let requestServiceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>> | undefined;
    if (options?.dedupeSessionRequest && sessionId) {
      let serviceCache = sessionCatalogRequests.get(services);
      if (!serviceCache) {
        serviceCache = new Map();
        sessionCatalogRequests.set(services, serviceCache);
      }
      const cached = serviceCache.get(requestKey);
      request = cached ?? services.pluginManagementService.getPluginReferenceCatalog(params);
      requestServiceCache = serviceCache;
      if (!cached) {
        serviceCache.set(requestKey, request);
        releaseSessionCatalogRequestWhenSettled(services, serviceCache, requestKey, request);
      }
    } else {
      request = services.pluginManagementService.getPluginReferenceCatalog(params);
    }
    request
      .then((result) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        setScopedState({
          scope: requestScope,
          value: {
            entries: result.plugins,
            authority: result.authority,
            loading: false,
            error: null,
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        // Fail closed: on query failure, Picker shows an error state instead of falling back to another authority's data.
        if (!options?.suppressErrorLog) {
          logger.warn("[usePluginReferenceCatalog] 拉取 Plugin 引用 catalog 失败", {
            error: message,
            requestKey,
          });
        }
        setScopedState({
          scope: requestScope,
          value: {
            entries: [],
            authority: null,
            loading: false,
            error: message,
          },
        });
      });
    return () => {
      cancelled = true;
      if (requestServiceCache) {
        releaseSessionCatalogRequest(services, requestServiceCache, requestKey, request);
      }
    };
    // requestKey already covers changes to the workspaceKey/sessionId combination.
  }, [
    enabled,
    options?.dedupeSessionRequest,
    options?.suppressErrorLog,
    remoteSessionId,
    requestKey,
    requestScope,
    rpcReady,
    services,
    sessionId,
    workspaceIdentity,
    workspacePath,
  ]);

  if (!enabled || !workspacePath || !rpcReady || scopedState.scope !== requestScope) {
    return EMPTY_STATE;
  }
  return scopedState.value;
}
