import type { Event } from "@zcode/rpc";
import type { FileWatchEvent } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * File-system watcher service
 *
 * Manage watcher instances by path. The UI uses non-recursive watch() when expanding a directory;
 * workspace-level state such as Git can use recursive watch(). Events stream through RPC via onDynamicChange.
 */
export interface IFileWatcherService {
  /** Start watching a path. Returns watcherId for unwatching and subscribing to events. */
  watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }>;
  /** Stop watching and release the watcher and related resources. */
  unwatch(params: { id: string }): Promise<void>;
  /** Stop all watchers. Used during host shutdown to release underlying fs.watch handles. */
  disposeAll(): void;
  /** Subscribe to change events by watcherId (onDynamic* pattern; RPC routes automatically). */
  onDynamicChange(id: string): Event<FileWatchEvent>;
}

export const IFileWatcherService = createServiceDescriptor<IFileWatcherService>(
  ServiceChannels.FileWatcher,
);
