import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import type {
  ExternalSessionSource,
  ExternalSessionsListResult,
  IExternalSessionsService,
} from "./contract.js";

export interface UseExternalSessionsParams {
  /** False hides the panel entirely (web, web remote control). */
  enabled: boolean;
  workspacePath?: string;
  search: string;
  sources: readonly ExternalSessionSource[];
}

export interface UseExternalSessionsState {
  supported: boolean;
  loading: boolean;
  error: string | null;
  result: ExternalSessionsListResult | null;
  refresh: () => void;
  service: IExternalSessionsService | null;
}

/** Lists external sessions through the local Host; the service owns the cache, this hook only re-queries. */
export function useExternalSessions(params: UseExternalSessionsParams): UseExternalSessionsState {
  const service = useOptionalBaseWorkspaceServices()?.externalSessionsService ?? null;
  const supported = params.enabled && service !== null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExternalSessionsListResult | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const requestSeq = useRef(0);
  const sourcesKey = params.sources.join(",");

  useEffect(() => {
    if (!supported || !service) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    const sources = sourcesKey ? (sourcesKey.split(",") as ExternalSessionSource[]) : undefined;
    void service
      .listExternalSessions({
        ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
        ...(sources?.length ? { sources } : {}),
        ...(params.search.trim() ? { search: params.search.trim() } : {}),
        ...(refreshNonce > 0 ? { refresh: true } : {}),
      })
      .then((next) => {
        if (seq !== requestSeq.current) return;
        setResult(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (seq !== requestSeq.current) return;
        logger.warn("[external-sessions] list failed", cause);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  }, [supported, service, params.workspacePath, params.search, sourcesKey, refreshNonce]);

  const refresh = useCallback(() => setRefreshNonce((value) => value + 1), []);

  return useMemo(
    () => ({ supported, loading, error, result, refresh, service }),
    [supported, loading, error, result, refresh, service],
  );
}
