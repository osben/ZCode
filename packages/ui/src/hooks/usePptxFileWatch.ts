import { useEffect, useState } from "react";
import type { IDisposable } from "@zcode/rpc";
import type { IFileWatcherService } from "@zcode/services";
import type { FileWatchEvent } from "@zcode/shared";
import { logger } from "@/logger.js";
import { getContainingDirectoryPath } from "@/lib/path.js";

interface PptxFileWatchSnapshot {
  filePath: string | null;
  fileWatcherService: IFileWatcherService | null;
  ready: boolean;
  reloadGeneration: number;
}

function normalizeFileWatchPathForCompare(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

export function shouldReloadPptxPreviewForWatchEvent(
  event: FileWatchEvent,
  filePath: string,
): boolean {
  if (!event.changedPath) {
    return true;
  }
  return (
    normalizeFileWatchPathForCompare(event.changedPath) ===
    normalizeFileWatchPathForCompare(filePath)
  );
}

export function usePptxFileWatch({
  filePath,
  fileWatcherService,
}: {
  filePath: string | null;
  fileWatcherService: IFileWatcherService;
}): { ready: boolean; reloadGeneration: number } {
  const [snapshot, setSnapshot] = useState<PptxFileWatchSnapshot>({
    filePath: null,
    fileWatcherService: null,
    ready: false,
    reloadGeneration: 0,
  });

  useEffect(() => {
    let cancelled = false;
    let watcherId: string | null = null;
    let subscription: IDisposable | null = null;

    setSnapshot({
      filePath,
      fileWatcherService,
      ready: false,
      reloadGeneration: 0,
    });
    if (!filePath) {
      return () => {
        cancelled = true;
      };
    }

    const directoryPath = getContainingDirectoryPath(filePath);
    if (!directoryPath) {
      setSnapshot({
        filePath,
        fileWatcherService,
        ready: true,
        reloadGeneration: 0,
      });
      return () => {
        cancelled = true;
      };
    }

    void fileWatcherService
      .watch({ path: directoryPath })
      .then(({ id }) => {
        if (cancelled) {
          void fileWatcherService.unwatch({ id });
          return;
        }
        watcherId = id;
        subscription = fileWatcherService.onDynamicChange(id)((event) => {
          if (!shouldReloadPptxPreviewForWatchEvent(event, filePath)) {
            return;
          }
          logger.debug("[PptxFileWatch] 源文件发生变化，刷新已打开预览", {
            path: filePath,
            changedPath: event.changedPath,
          });
          setSnapshot((current) =>
            current.filePath === filePath && current.fileWatcherService === fileWatcherService
              ? {
                  ...current,
                  ready: true,
                  reloadGeneration: current.reloadGeneration + 1,
                }
              : current,
          );
        });
        setSnapshot((current) =>
          current.filePath === filePath && current.fileWatcherService === fileWatcherService
            ? { ...current, ready: true }
            : current,
        );
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        // Watching only provides automatic refresh; if registration fails, the initial read and manual reopen still work.
        logger.warn("[PptxFileWatch] 监听 PPTX 所在目录失败", {
          path: filePath,
          directoryPath,
          error: error instanceof Error ? error.message : String(error),
        });
        setSnapshot((current) =>
          current.filePath === filePath && current.fileWatcherService === fileWatcherService
            ? { ...current, ready: true }
            : current,
        );
      });

    return () => {
      cancelled = true;
      subscription?.dispose();
      if (watcherId) {
        void fileWatcherService.unwatch({ id: watcherId }).catch((error: unknown) => {
          logger.warn("[PptxFileWatch] 停止监听 PPTX 所在目录失败", {
            path: filePath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    };
  }, [filePath, fileWatcherService]);

  // A remote reconnect or Host replacement can switch the workspace service while the source path stays the same.
  // ready must belong to the current watcher service; do not reuse subscription state from the old service before the effect cleans it up.
  return snapshot.filePath === filePath && snapshot.fileWatcherService === fileWatcherService
    ? {
        ready: snapshot.ready,
        reloadGeneration: snapshot.reloadGeneration,
      }
    : { ready: false, reloadGeneration: 0 };
}
