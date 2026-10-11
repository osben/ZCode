import { useEffect, useRef, useState } from "react";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";

/**
 * The exported return type of useWorkspaceActiveTaskState indirectly references this interface,
 * so declaration generation requires it to be exported.
 * @lintignore
 */
export interface TaskSessionFilePathState {
  path: string | null;
  exists: boolean;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: TaskSessionFilePathState = {
  path: null,
  exists: false,
  loading: false,
  error: null,
};

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

/**
 * Read the persisted snapshot file path for the current task.
 *
 * The UI previously accessed crypto.subtle in the browser to calculate the workspace hash.
 * In insecure contexts such as HTTP previews or remote access, subtle may be unavailable and throw
 * during the effect. Resolve the final path through zcodeTaskService instead, so the UI does not guess
 * directory rules and remote workspaces can use the remote home directory.
 */
export function useTaskSessionFilePath(
  workspacePath: string,
  taskId: string | null,
  workspaceIdentity?: string,
  options: { enabled?: boolean } = {},
) {
  const zcodeTaskService = useZCodeTaskService(workspacePath, undefined, workspaceIdentity);
  const [state, setState] = useState<TaskSessionFilePathState>(INITIAL_STATE);
  const requestVersionRef = useRef(0);
  const enabled = options.enabled ?? true;

  useEffect(() => {
    let disposed = false;

    if (!enabled || !workspacePath || !taskId) {
      requestVersionRef.current += 1;
      // The task path is only used by the context menu. Avoid RPCs while the menu is closed,
      // so drag-and-drop reordering does not trigger a storm of path queries.
      setState(INITIAL_STATE);
      return () => {
        disposed = true;
      };
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;

    setState({
      path: null,
      exists: false,
      loading: true,
      error: null,
    });

    void zcodeTaskService
      .getTaskSessionFilePath({
        workspacePath,
        taskId,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then((result) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        setState({
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
        logger.warn("[useTaskSessionFilePath] 读取 task 快照路径失败", {
          workspacePath,
          taskId,
          workspaceIdentity,
          error: message,
        });
        setState({
          path: null,
          exists: false,
          loading: false,
          error: message,
        });
      });

    return () => {
      disposed = true;
    };
  }, [enabled, zcodeTaskService, taskId, workspaceIdentity, workspacePath]);

  return state;
}
