import type { ZCodeTaskRuntimeStatus } from "@zcode/shared";

type ChatPlaceholderMessageKey =
  | "chat.placeholder.newTask"
  | "chat.placeholder.newTaskMobile"
  | "chat.placeholder.followUpAsk"
  | "chat.placeholder.followUpQueue";

export function resolveChatPlaceholderKey(options: {
  hasHistoryMessages: boolean;
  isTaskProcessing: boolean;
  compactNewTask?: boolean;
}): ChatPlaceholderMessageKey {
  const { compactNewTask = false, hasHistoryMessages, isTaskProcessing } = options;

  // Still processing while the first submission is committed but its message projection has not arrived; empty history must not flash back to the new-task hint.
  if (isTaskProcessing) return "chat.placeholder.followUpQueue";
  if (!hasHistoryMessages) {
    return compactNewTask ? "chat.placeholder.newTaskMobile" : "chat.placeholder.newTask";
  }

  return "chat.placeholder.followUpAsk";
}

export function shouldDeferChatPlaceholder(options: {
  hasBoundTask: boolean;
  taskStatus: ZCodeTaskRuntimeStatus;
}): boolean {
  const { hasBoundTask, taskStatus } = options;

  // Bugfix: Switching to a historical task first passes through creating/restoring before its messages and runtime state are ready.
  // Rendering the placeholder during this transition causes a “follow-up -> new task -> follow-up” flicker.
  // Hide the placeholder until the task becomes interactive, then show it once the runtime is ready.
  return hasBoundTask && (taskStatus === "creating" || taskStatus === "restoring");
}
