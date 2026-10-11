import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { Emitter, Event, type Event as RpcEvent } from "@zcode/rpc";
import type { FileWatchEvent } from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IFileWatcherService } from "./fileWatcher.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

/** Debounce interval (ms) to avoid frequent refreshes during batch file changes (such as git checkout). */
const DEBOUNCE_MS = 150;

interface WatcherInstance {
  path: string;
  watcher: FSWatcher;
  changeEmitter: Emitter<FileWatchEvent>;
  /** Debounce timer. */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Pass through only when the same debounce window contains one explicit path, so target file events in the same batch are not filtered out. */
  pendingChangedPaths: Set<string>;
  hasUnknownChangedPath: boolean;
}

export function resolveFileWatchChangedPath(
  watchedDirectoryPath: string,
  fileName: string | Buffer | null,
): string | undefined {
  if (fileName === null) {
    return undefined;
  }
  const normalizedFileName = fileName.toString().trim();
  return normalizedFileName ? resolve(watchedDirectoryPath, normalizedFileName) : undefined;
}

export function createFileWatcherService(options?: {
  logger?: ServiceLogger;
}): IFileWatcherService {
  const log = options?.logger ?? createServiceLogger("file-watcher");
  const watchers = new Map<string, WatcherInstance>();
  let nextId = 0;
  // Memory diagnostic counter: this only increases if a client disconnects without disposing its watcher.
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("fileWatcher", () => ({
    open: watchers.size,
  }));

  function cleanup(id: string): void {
    const w = watchers.get(id);
    if (!w) return;
    if (w.debounceTimer) clearTimeout(w.debounceTimer);
    w.watcher.close();
    w.changeEmitter.dispose();
    watchers.delete(id);
  }

  return {
    async watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }> {
      const id = String(nextId++);
      const changeEmitter = new Emitter<FileWatchEvent>();
      const recursive = params.recursive ?? false;

      let fsWatcher: FSWatcher;
      try {
        // Watch a single directory non-recursively by default; workspace-wide signals such as Git status explicitly enable recursive mode.
        fsWatcher = watch(params.path, { recursive }, (_eventType, fileName) => {
          const instance = watchers.get(id);
          if (!instance) return;

          const changedPath = resolveFileWatchChangedPath(instance.path, fileName);
          if (changedPath) {
            instance.pendingChangedPaths.add(changedPath);
          } else {
            instance.hasUnknownChangedPath = true;
          }

          // Debounce: a sequence of changes triggers only one refresh.
          if (instance.debounceTimer) clearTimeout(instance.debounceTimer);
          instance.debounceTimer = setTimeout(() => {
            instance.debounceTimer = null;
            const onlyChangedPath =
              !instance.hasUnknownChangedPath && instance.pendingChangedPaths.size === 1
                ? instance.pendingChangedPaths.values().next().value
                : undefined;
            instance.pendingChangedPaths.clear();
            instance.hasUnknownChangedPath = false;
            instance.changeEmitter.fire({
              dirPath: instance.path,
              ...(onlyChangedPath ? { changedPath: onlyChangedPath } : {}),
            });
          }, DEBOUNCE_MS);
        });
      } catch (error) {
        changeEmitter.dispose();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`无法监视目录 '${params.path}': ${message}`);
      }

      // Send a final event and clean up when the watched directory is deleted or renamed.
      fsWatcher.on("error", (error) => {
        const instance = watchers.get(id);
        if (instance) {
          log.warn(undefined, "文件监听器异常，清理 watcher", {
            id,
            path: instance.path,
            error: error instanceof Error ? error.message : String(error),
          });
          instance.changeEmitter.fire({ dirPath: instance.path });
          cleanup(id);
        }
      });

      watchers.set(id, {
        path: params.path,
        watcher: fsWatcher,
        changeEmitter,
        debounceTimer: null,
        pendingChangedPaths: new Set(),
        hasUnknownChangedPath: false,
      });

      return { id };
    },

    async unwatch(params: { id: string }): Promise<void> {
      cleanup(params.id);
    },

    disposeAll(): void {
      memoryDiagnostics.dispose();
      const ids = Array.from(watchers.keys());
      for (const id of ids) {
        cleanup(id);
      }
    },

    onDynamicChange(id: string): RpcEvent<FileWatchEvent> {
      const watcher = watchers.get(id);
      if (!watcher) {
        // After watch() returns successfully but before the renderer subscribes to onDynamicChange, the underlying fs.watch
        // may still trigger cleanup due to directory deletion/rename or a platform watcher error. A stale watcher ID
        // is recoverable state and must not be thrown into the RPC event subscription path, which could terminate the host process.
        log.warn(undefined, "忽略已失效的文件监听订阅", { id });
        return Event.None;
      }
      return watcher.changeEmitter.event;
    },
  };
}
