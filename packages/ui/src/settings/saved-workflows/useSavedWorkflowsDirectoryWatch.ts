import { useEffect } from "react";
import type { IFileWatcherService } from "@zcode/services";
import { logger } from "@/logger.js";

const WATCH_DEBOUNCE_MS = 300;

/** workspacePath may be a Windows path; use its own separator when joining the subdirectory, rather than mixing `/` into a `\\` path. */
function savedWorkflowsDirectoryPath(workspacePath: string): string {
  const separator = workspacePath.includes("\\") && !workspacePath.includes("/") ? "\\" : "/";
  const trimmed = workspacePath.replace(/[\\/]+$/u, "");
  return `${trimmed}${separator}.zcode${separator}workflows`;
}

/**
 * Watch the directory so the central list updates after SaveWorkflow writes a workflow from a conversation.
 * If the directory does not exist, watch fails; this is normal for most projects that have not saved a workflow. Skip quietly and catch up on tab change or manual
 * refresh. The watcher is non-recursive and observes only this level (recursive fs.watch has known issues on Linux). When the service instance changes (for example, after a remote reconnect),
 * effect dependencies dispose of the old watcher and create a new one without leaking the old host ID.
 *
 * Project groups pass `workspacePath` (to build `<ws>/.zcode/workflows`); global groups pass `directory` (the
 * absolute directory returned by the protocol list, namely `~/.zcode/workflows`). Pass one or the other; `directory` takes precedence.
 */
export function useSavedWorkflowsDirectoryWatch({
  fileWatcherService,
  workspacePath,
  directory,
  enabled,
  refresh,
}: {
  fileWatcherService: IFileWatcherService;
  workspacePath?: string | null | undefined;
  directory?: string | null | undefined;
  enabled: boolean;
  refresh: (options: { bypassCache?: boolean }) => Promise<void>;
}): void {
  const resolvedDirectory =
    directory ?? (workspacePath ? savedWorkflowsDirectoryPath(workspacePath) : null);
  useEffect(() => {
    if (!enabled || !resolvedDirectory) return;
    let disposed = false;
    let watchId: string | null = null;
    let subscription: { dispose: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const directoryPath = resolvedDirectory;
    void fileWatcherService
      .watch({ path: directoryPath })
      .then(({ id }) => {
        if (disposed) {
          void fileWatcherService.unwatch({ id });
          return;
        }
        watchId = id;
        subscription = fileWatcherService.onDynamicChange(id)(() => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            void refresh({ bypassCache: true });
          }, WATCH_DEBOUNCE_MS);
        });
      })
      .catch((error: unknown) => {
        logger.debug("[SavedWorkflows] 监听 .zcode/workflows 失败（目录可能尚不存在）", {
          path: directoryPath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      subscription?.dispose();
      if (watchId) void fileWatcherService.unwatch({ id: watchId });
    };
  }, [enabled, fileWatcherService, refresh, resolvedDirectory]);
}
