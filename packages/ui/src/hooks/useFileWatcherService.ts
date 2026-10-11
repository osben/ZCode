/**
 * useFileWatcherService — filesystem-watcher hooks
 *
 * Adds an fs.watch subscription on top of useReaddir.
 * Automatically refreshes when directory contents change.
 */
import { useState, useEffect, useCallback } from "react";
import type { FileEntry } from "@zcode/shared";
import type { IDisposable } from "@zcode/rpc";
import { useServices } from "./useServices.js";
import { logger } from "@/logger.js";

/**
 * Directory-reading hook with filesystem watching.
 *
 * Uses the same interface as useReaddir, but automatically watches the directory on mount,
 * refreshes when it receives a change event, and unwatches on unmount.
 */
export function useWatchedReaddir(path: string) {
  const { fileService, fileWatcherService } = useServices();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fileService.readdir({ path });
      setEntries(result);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [fileService, path]);

  // Initial read
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Filesystem watch: watch on mount and unwatch on unmount
  useEffect(() => {
    let cancelled = false;
    let watcherId: string | null = null;
    const disposables: IDisposable[] = [];

    // Store the refresh callback in a ref to avoid a stale event-handler closure.
    const refreshRef = { current: refresh };

    fileWatcherService
      .watch({ path })
      .then(({ id }) => {
        if (cancelled) {
          // The component has unmounted; release the watcher immediately.
          fileWatcherService.unwatch({ id });
          return;
        }
        watcherId = id;

        // Subscribe to change events and automatically refresh the directory listing.
        const sub = fileWatcherService.onDynamicChange(id)(() => {
          logger.info(`[FileWatcher] 目录变更，自动刷新 path=${path}`);
          refreshRef.current();
        });
        disposables.push(sub);
      })
      .catch((err) => {
        // A watch failure does not affect basic functionality (readdir still works); log it only.
        if (!cancelled) {
          logger.warn(`[FileWatcher] 监视目录失败 path=${path}:`, err);
        }
      });

    return () => {
      cancelled = true;
      for (const d of disposables) d.dispose();
      if (watcherId) fileWatcherService.unwatch({ id: watcherId });
    };
  }, [fileWatcherService, path, refresh]);

  return { entries, loading, error, refresh };
}
