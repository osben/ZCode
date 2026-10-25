import { useCallback, useEffect, useRef, useState } from "react";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { logger } from "@/logger.js";
import type { ZCodeModelTrajectoryV2 } from "../contract.js";

export type TrajectoryV2LoadStatus = "loading" | "ready" | "refreshing" | "error";

export interface TrajectoryV2LoadState {
  status: TrajectoryV2LoadStatus;
  data: ZCodeModelTrajectoryV2 | null;
  error: string | null;
}

const LOADING: TrajectoryV2LoadState = { status: "loading", data: null, error: null };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

/**
 * Load a task's v2 trajectory through the Host. Refresh keeps the previous data visible ("refreshing"); a response
 * that arrives after a newer request or after unmount is dropped. A task change starts over from "loading".
 */
export function useModelTrajectoryV2(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): TrajectoryV2LoadState & { refresh: () => void } {
  const service = useZCodeTaskService(workspacePath, undefined, workspaceIdentity);
  const [state, setState] = useState<TrajectoryV2LoadState>(LOADING);
  const [reloadToken, setReloadToken] = useState(0);
  const versionRef = useRef(0);
  const loadedTaskRef = useRef<string | null>(null);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let disposed = false;
    const version = versionRef.current + 1;
    versionRef.current = version;
    const sameTask = loadedTaskRef.current === taskId;
    setState((previous) =>
      sameTask && previous.data
        ? { status: "refreshing", data: previous.data, error: null }
        : LOADING,
    );

    void service
      .getModelTrajectoryV2({ taskId })
      .then((data) => {
        if (disposed || versionRef.current !== version) return;
        loadedTaskRef.current = taskId;
        setState({ status: "ready", data, error: null });
      })
      .catch((error: unknown) => {
        if (disposed || versionRef.current !== version) return;
        const message = errorMessage(error);
        logger.warn("[useModelTrajectoryV2] failed to read trajectory", { taskId, error: message });
        setState((previous) => ({
          status: "error",
          data: loadedTaskRef.current === taskId ? previous.data : null,
          error: message,
        }));
      });

    return () => {
      disposed = true;
    };
  }, [service, taskId, reloadToken]);

  return { ...state, refresh };
}
