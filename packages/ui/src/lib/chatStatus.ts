import type { ZCodeTaskRuntimeStatus, ZCodeWorkspaceInitStatus } from "@zcode/shared";

type ChatComposerStatus = "idle" | "submitting" | "streaming" | "error";

export function deriveChatComposerStatusFromTaskRuntime(
  taskStatus: ZCodeTaskRuntimeStatus,
): ChatComposerStatus {
  switch (taskStatus) {
    case "creating":
    case "restoring":
      return "submitting";
    case "streaming":
      return "streaming";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

export function isChatComposerEditingDisabled(status: ChatComposerStatus) {
  // Bugfix: users must be able to continue drafting the next message during “Preparing.” Treating
  // submitting as an editing lock previously disabled the input for the entire time task creation
  // or restore took. Keep editing enabled and let submissionBlocked control whether another submit is allowed.
  return false;
}

export function isChatComposerSubmissionBlocked(status: ChatComposerStatus) {
  // Bugfix: the next message can now be added to an in-memory queue while the previous turn is
  // streaming. If streaming remains a submission lock here, the UI blocks both the button and
  // Enter, so the queue is never reached. Block submission only while actually creating/restoring
  // a task or submitting an RPC.
  return status === "submitting";
}

export function shouldShowChatSubmitSpinner(status: ChatComposerStatus) {
  // Bugfix: sending again after a task failure first enters a submitting state while resumeTask or
  // resubmission runs. The button previously kept showing the send arrow, making it look as though
  // loading had not started. Expose a separate check for showing the submitting spinner so ChatView
  // stays consistent with the state semantics.
  return status === "submitting";
}

export function isChatTaskRunning(taskStatus: ZCodeTaskRuntimeStatus) {
  // ChatView previously inferred “thinking” from displayedStatus and the role of the last message,
  // so when a task was still creating/restoring/streaming, the shimmer disappeared early if the message list lagged behind.
  // Use the task runtime-state check directly here and match the “running” states of the Task StatusBadge at the top.
  return taskStatus === "creating" || taskStatus === "restoring" || taskStatus === "streaming";
}

export function deriveChatTaskStatusForMainActivity(
  taskStatus: ZCodeTaskRuntimeStatus,
  isMainActive: boolean,
): ZCodeTaskRuntimeStatus {
  if (taskStatus === "streaming" && !isMainActive) {
    return "completed";
  }
  return taskStatus;
}

export function canForkFromTaskRuntimeStatus(taskStatus: ZCodeTaskRuntimeStatus) {
  // Product semantics: failed/error partial is not a stable history boundary and cannot be forked
  // like an interrupted completed turn. Keep running-state logic centralized in isChatTaskRunning
  // instead of maintaining a duplicate active-turn check.
  return taskStatus !== "notReady" && taskStatus !== "failed" && !isChatTaskRunning(taskStatus);
}

export function shouldShowChatThinkingShimmer(taskStatus: ZCodeTaskRuntimeStatus) {
  // Bugfix: restoring means the session is being restored; it does not mean the model has started
  // thinking. Separate “task is running” from “show the thinking shimmer” to avoid a misleading
  // thinking indicator when restoring a historical task.
  return taskStatus === "creating" || taskStatus === "streaming";
}

export function getChatSubmitLabelId(
  status: ChatComposerStatus,
  workspaceInitStatus: ZCodeWorkspaceInitStatus,
  taskStatus: ZCodeTaskRuntimeStatus,
) {
  if (status !== "submitting") {
    return "chat.send";
  }

  // Bugfix: show “Preparing...” throughout the submitting phase. The UI previously distinguished
  // “Preparing” from “Thinking,” but after resumeTask completes it should transition directly to
  // streaming and show the “Stop generating” button. “Thinking” should not appear during submitting.
  return "chat.preparing";
}
