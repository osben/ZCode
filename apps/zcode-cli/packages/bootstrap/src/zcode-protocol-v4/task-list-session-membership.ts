import type { SessionTaskType } from "@zcode/contracts";

/**
 * Session-type projection for the task list in the left sidebar.
 *
 * Do not derive list visibility from the `parent_id is null` hierarchy query: explicit forks and
 * other primary tasks with a parent would be filtered out of the cold-start seed after a CLI restart.
 * Visibility must be based on taskType, while auxiliary conversations, subagents, and workflow
 * children continue to use their dedicated projections.
 */
export const TASK_LIST_SESSION_TYPES = [
  "interactive",
  "fork",
  "workflow_parent",
] as const satisfies readonly SessionTaskType[];

const TASK_LIST_SESSION_TYPE_SET = new Set<SessionTaskType>(
  TASK_LIST_SESSION_TYPES,
);

export function isTaskListSessionType(
  taskType: SessionTaskType | undefined,
): boolean {
  return TASK_LIST_SESSION_TYPE_SET.has(taskType ?? "interactive");
}
