import { useEffect, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";

/**
 * The exported return type of useWorkspaceActiveTaskState indirectly references this interface,
 * so declaration generation requires it to be exported.
 * @lintignore
 */
export interface TaskNativeSessionLogFileState {
  provider: ZCodeProvider | null;
  path: string | null;
  exists: boolean;
  loading: boolean;
  error: string | null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

const INITIAL_STATE: TaskNativeSessionLogFileState = {
  provider: null,
  path: null,
  exists: false,
  loading: false,
  error: null,
};

function supportsTaskNativeSessionLogFile(_provider: ZCodeProvider | null | undefined): boolean {
  // Only the glm provider remains, and it always supports reading native session logs.
  return true;
}

/**
 * Read the native session log path for the current task.
 *
 * Resolve the path through zcodeTaskService so the UI does not guess the provider's directory structure.
 */
export function useTaskNativeSessionLogFile(
  workspacePath: string,
  taskId: string | null,
  providerHint?: ZCodeProvider | null,
  workspaceIdentity?: string,
  options: { enabled?: boolean } = {},
) {
  const zcodeTaskService = useZCodeTaskService(workspacePath, undefined, workspaceIdentity);
  const [state, setState] = useState<TaskNativeSessionLogFileState>(INITIAL_STATE);
  const requestVersionRef = useRef(0);
  const enabled = options.enabled ?? true;

  useEffect(() => {
    let disposed = false;

    if (!enabled || !workspacePath || !taskId) {
      requestVersionRef.current += 1;
      // The native log path is only used by a menu action; do not have every row issue a path RPC during dragging.
      setState(INITIAL_STATE);
      return () => {
        disposed = true;
      };
    }

    if (!supportsTaskNativeSessionLogFile(providerHint)) {
      requestVersionRef.current += 1;
      setState({
        provider: providerHint ?? null,
        path: null,
        exists: false,
        loading: false,
        error: null,
      });
      return () => {
        disposed = true;
      };
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    setState({
      provider: providerHint ?? null,
      path: null,
      exists: false,
      loading: true,
      error: null,
    });

    void zcodeTaskService
      .getTaskNativeSessionLogFile({
        taskId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then((result) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        setState({
          provider: result.provider ?? providerHint ?? null,
          path: result.path,
          exists: result.exists,
          loading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        const message = getErrorMessage(error);
        logger.warn("[useTaskNativeSessionLogFile] 读取 task 原生日志路径失败", {
          workspacePath,
          taskId,
          providerHint,
          workspaceIdentity,
          error: message,
        });
        setState({
          provider: providerHint ?? null,
          path: null,
          exists: false,
          loading: false,
          error: message,
        });
      });

    return () => {
      disposed = true;
    };
  }, [enabled, zcodeTaskService, providerHint, taskId, workspaceIdentity, workspacePath]);

  return state;
}
