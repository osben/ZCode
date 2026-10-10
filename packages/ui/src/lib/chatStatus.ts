import type { ZCodeTaskRuntimeStatus } from "@zcode/shared";

export function isChatTaskRunning(taskStatus: ZCodeTaskRuntimeStatus) {
  // ChatView previously inferred “thinking” from displayedStatus and the role of the last message,
  // so when a task was still creating/restoring/streaming, the shimmer disappeared early if the message list lagged behind.
  // Use the task runtime-state check directly here and match the “running” states of the Task StatusBadge at the top.
  return taskStatus === "creating" || taskStatus === "restoring" || taskStatus === "streaming";
}
