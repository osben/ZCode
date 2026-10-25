import type { ZCodeTaskPersistStatus, ZCodeTaskRuntimeStatus } from "@zcode/shared";

interface TaskRestoreTimestampedMessageLike {
  role: "user" | "assistant";
  timestamp: number;
}

interface ResolveTaskRuntimeStatusAfterRestoreOptions {
  persistedStatus?: ZCodeTaskPersistStatus;
  persistedUpdatedAt?: number;
  latestUserMessageTimestamp?: number | null;
  runtimeMainActive?: boolean;
}

interface ShouldShowTaskConfigLoadingOnSwitchParams {
  previousTaskId: string | null;
  nextTaskId: string | null;
}

export function shouldKeepTaskStreamingDuringRestore(taskStatus: ZCodeTaskRuntimeStatus): boolean {
  // Bugfix: when a task goes to background and comes back while it is actually still streaming
  // output, the restore path must not first knock it back to restoring/ready. Otherwise ChatView
  // would think generation finished and the "thinking" animation would vanish right after
  // switching back.
  return taskStatus === "streaming";
}

export function shouldShowTaskConfigLoadingOnSwitch(
  params: ShouldShowTaskConfigLoadingOnSwitchParams,
): boolean {
  const nextTaskId = params.nextTaskId?.trim() ?? "";
  if (!nextTaskId) {
    return false;
  }

  const previousTaskId = params.previousTaskId?.trim() ?? "";
  // Bugfix: during a task switch, reusing the previous task's configOptions from the workspace
  // briefly shows the old model in the toolbar until the resume/config_option_update response
  // corrects it. Enter loading based on the taskId change so the placeholder period no longer
  // echoes the previous task's model.
  return previousTaskId !== nextTaskId;
}

export function getLatestTaskUserMessageTimestamp(
  messages: readonly TaskRestoreTimestampedMessageLike[],
): number | null {
  let latestTimestamp: number | null = null;
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    latestTimestamp =
      latestTimestamp === null ? message.timestamp : Math.max(latestTimestamp, message.timestamp);
  }
  return latestTimestamp;
}

function toTerminalRuntimeStatus(status: ZCodeTaskPersistStatus): ZCodeTaskRuntimeStatus {
  if (status === "running") {
    return "streaming";
  }
  return status === "error" ? "failed" : "completed";
}

export function resolveTaskRuntimeStatusAfterRestore(
  taskStatus: ZCodeTaskRuntimeStatus,
  hasRestoredSession: boolean,
  options?: ResolveTaskRuntimeStatusAfterRestoreOptions,
): ZCodeTaskRuntimeStatus {
  if (!hasRestoredSession) {
    return "notReady";
  }

  const persistedStatus = options?.persistedStatus;
  const persistedUpdatedAt = options?.persistedUpdatedAt;
  const latestUserMessageTimestamp = options?.latestUserMessageTimestamp ?? null;

  if (
    persistedStatus &&
    persistedStatus !== "running" &&
    typeof persistedUpdatedAt === "number" &&
    (latestUserMessageTimestamp === null || persistedUpdatedAt >= latestUserMessageTimestamp)
  ) {
    // Bugfix: when restoring a historical task, the store may still hold a stale streaming state
    // from the previous frame. If the host has already settled this round (completed/error) into
    // meta.status, keeping the old streaming state makes the UI show "generating" forever. Require
    // the persisted terminal state to at least cover the latest user message before using it to
    // settle the runtime state, avoiding applying a "previous round completed snapshot" to a new
    // round still running.
    return toTerminalRuntimeStatus(persistedStatus);
  }

  if (options?.runtimeMainActive === true) {
    // Fix reason: the mainActive snapshot is the runtime fact that the agent/session is still in
    // its main turn. But it may only restore runtime.status first; the real UI mainActive flag is
    // written after status=streaming.
    return "streaming";
  }

  return shouldKeepTaskStreamingDuringRestore(taskStatus) ? "streaming" : "ready";
}
