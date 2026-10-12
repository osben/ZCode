interface DeferredWebRemoteControlTaskSnapshotLogOptions {
  archivedLoading: boolean;
  pinnedLoading: boolean;
  timelineLoading: boolean;
}

export function shouldSyncWebRemoteControlTaskSnapshot({
  archivedLoading,
  enabled,
  pinnedLoading,
  timelineLoading,
}: {
  archivedLoading: boolean;
  enabled: boolean;
  pinnedLoading: boolean;
  timelineLoading: boolean;
}): boolean {
  if (!enabled) {
    return false;
  }

  // Bugfix: syncWebRemoteControlTasks is a whole-snapshot replacement in the main process.
  // useGlobalTaskList publishes partial shard results first, and even a non-empty array may hold
  // only part of the tasks. Defer syncing until loading finishes so the phone does not treat a
  // task-less partial as the authoritative list.
  if (archivedLoading || pinnedLoading || timelineLoading) {
    return false;
  }

  return true;
}

export function logDeferredWebRemoteControlTaskSnapshot(
  logger: {
    debug: (message: string, details: DeferredWebRemoteControlTaskSnapshotLogOptions) => void;
  },
  details: DeferredWebRemoteControlTaskSnapshotLogOptions,
): void {
  // Bugfix: what is deferred during loading may be a non-empty partial snapshot, not an "empty
  // task snapshot". Such logs repeat with every partial list refresh; demote to debug to keep
  // them from flooding production info logs.
  logger.debug("[Root] 暂缓同步 Web 远控任务快照，等待任务列表加载完成", details);
}
