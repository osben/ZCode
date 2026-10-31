import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Emitter, Event, type Event as RpcEvent } from "@zcode/rpc";
import type { FileWatchEvent } from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IFileWatcherService } from "./fileWatcher.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

/** Debounce interval (ms) to avoid frequent refreshes during batch file changes (such as git checkout). */
const DEBOUNCE_MS = 150;
const MAX_WAIT_MS = 1_000;

interface PendingChange {
  changedPaths: Set<string>;
  hasUnknownChangedPath: boolean;
  sawRename: boolean;
}

interface WatcherInstance {
  path: string;
  watcher: FSWatcher;
  changeEmitter: Emitter<FileWatchEvent>;
  /** Debounce timer. */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Pass through only when the same debounce window contains one explicit path, so target file events in the same batch are not filtered out. */
  pendingChangedPaths: Set<string>;
  hasUnknownChangedPath: boolean;
  /** Max-wait timer guaranteeing eventual visibility during continuous writes */
  maxWaitTimer: ReturnType<typeof setTimeout> | null;
  /** A rename event occurred in this settle window; identity validation is deferred and done once at settle time */
  sawRename: boolean;
  flushing: boolean;
  flushRequested: boolean;
  /** Directory identity at creation. stat semantics (following symlinks) match the resolved target fs.watch bound to */
  targetIdentity: { dev: number; ino: number; isDirectory: boolean };
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
  watchFactory?: typeof watch;
  statPath?: typeof stat;
  debounceMs?: number;
  maxWaitMs?: number;
}): IFileWatcherService {
  const log = options?.logger ?? createServiceLogger("file-watcher");
  const watchFactory = options?.watchFactory ?? watch;
  const statPath = options?.statPath ?? stat;
  const debounceMs = options?.debounceMs ?? DEBOUNCE_MS;
  const maxWaitMs = options?.maxWaitMs ?? MAX_WAIT_MS;
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
    if (w.maxWaitTimer) clearTimeout(w.maxWaitTimer);
    w.watcher.close();
    w.changeEmitter.dispose();
    watchers.delete(id);
  }

  function emitChange(instance: WatcherInstance, change: PendingChange): void {
    const onlyChangedPath =
      !change.hasUnknownChangedPath && change.changedPaths.size === 1
        ? change.changedPaths.values().next().value
        : undefined;
    instance.changeEmitter.fire({
      dirPath: instance.path,
      ...(onlyChangedPath ? { changedPath: onlyChangedPath } : {}),
    });
  }

  function takePendingChange(instance: WatcherInstance): PendingChange {
    const change = {
      changedPaths: instance.pendingChangedPaths,
      hasUnknownChangedPath: instance.hasUnknownChangedPath,
      sawRename: instance.sawRename,
    };
    instance.pendingChangedPaths = new Set();
    instance.hasUnknownChangedPath = false;
    instance.sawRename = false;
    return change;
  }

  function clearFlushTimers(instance: WatcherInstance): void {
    if (instance.debounceTimer) {
      clearTimeout(instance.debounceTimer);
      instance.debounceTimer = null;
    }
    if (instance.maxWaitTimer) {
      clearTimeout(instance.maxWaitTimer);
      instance.maxWaitTimer = null;
    }
  }

  function scheduleChange(id: string, instance: WatcherInstance): void {
    if (instance.debounceTimer) {
      clearTimeout(instance.debounceTimer);
    }
    instance.debounceTimer = setTimeout(() => void flushChange(id, instance), debounceMs);
    if (!instance.maxWaitTimer) {
      // Bugfix: with trailing debounce alone, continuous writes spaced below the debounce
      // interval would postpone the flush forever. The independent max-wait is not reset by
      // events, ensuring subscribers still get periodic notifications during long writes.
      instance.maxWaitTimer = setTimeout(() => void flushChange(id, instance), maxWaitMs);
    }
  }

  async function flushChange(id: string, instance: WatcherInstance): Promise<void> {
    clearFlushTimers(instance);
    if (instance.flushing || watchers.get(id) !== instance) {
      instance.flushRequested = true;
      return;
    }

    instance.flushing = true;
    const change = takePendingChange(instance);
    if (change.sawRename) {
      // Validate the rename batch once; new events arriving during the wait enter the next batch and are not cleared by this check.
      let identityValid: boolean;
      try {
        const current = await statPath(instance.path);
        // fs.watch binds the resolved target, so stat must follow symlinks and compare against the directory identity from creation.
        identityValid =
          current.dev === instance.targetIdentity.dev &&
          current.ino === instance.targetIdentity.ino &&
          current.isDirectory() === instance.targetIdentity.isDirectory;
      } catch {
        identityValid = false;
      }
      if (watchers.get(id) !== instance) return;
      if (!identityValid) {
        // Bug cause: fs.watch stays bound to the moved-away inode; on invalidation, merge the
        // events seen during the check, emit one final flush and close the watcher — old-directory
        // events must not keep masquerading as events for the original path.
        log.warn(undefined, "监视目录身份变化，发送最终事件并关闭 watcher", {
          path: instance.path,
        });
        emitChange(instance, {
          changedPaths: new Set(),
          hasUnknownChangedPath: true,
          sawRename: false,
        });
        cleanup(id);
        return;
      }
    }

    if (watchers.get(id) !== instance) return;
    emitChange(instance, change);
    instance.flushing = false;
    if (instance.flushRequested) {
      instance.flushRequested = false;
      void flushChange(id, instance);
    }
  }

  return {
    async watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }> {
      const id = String(nextId++);
      const changeEmitter = new Emitter<FileWatchEvent>();
      const recursive = params.recursive ?? false;

      let fsWatcher: FSWatcher;
      try {
        const targetStat = await statPath(params.path);
        // Watch a single directory non-recursively by default; workspace-wide signals such as Git status explicitly enable recursive mode.
        fsWatcher = watchFactory(params.path, { recursive }, (eventType, fileName) => {
          const instance = watchers.get(id);
          if (!instance) return;

          const changedPath = resolveFileWatchChangedPath(instance.path, fileName);
          if (changedPath) {
            instance.pendingChangedPaths.add(changedPath);
          } else {
            instance.hasUnknownChangedPath = true;
          }

          if (eventType === "rename") {
            // SG-01: rename only sets the flag; identity validation happens once at settle time.
            // Enter debounce scheduling immediately so the validation delay does not first emit
            // an empty event that lost its changedPath.
            instance.sawRename = true;
          }
          scheduleChange(id, instance);
        });

        watchers.set(id, {
          path: params.path,
          watcher: fsWatcher,
          changeEmitter,
          debounceTimer: null,
          pendingChangedPaths: new Set(),
          hasUnknownChangedPath: false,
          maxWaitTimer: null,
          sawRename: false,
          flushing: false,
          flushRequested: false,
          targetIdentity: {
            dev: targetStat.dev,
            ino: targetStat.ino,
            isDirectory: targetStat.isDirectory(),
          },
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
