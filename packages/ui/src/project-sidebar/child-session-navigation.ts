import type { ChildSessionSelectOptions } from "@/components/TaskChildSessionRows.js";
import type { ProjectTask, SidebarSubagentSessionTarget } from "@/project-sidebar/contract.js";

/**
 * One routing rule for child rows in every sidebar view (spec sidebar-child-conversation-counts
 * §8.2): a subagent opens in the right pane under its parent when the shell supports it; side
 * chats, the overflow row, and shells without the side pane keep the main-pane selection.
 */
export function routeChildSessionSelection(params: {
  parent: Pick<ProjectTask, "taskId" | "workspacePath" | "workspaceIdentity">;
  sessionId: string;
  options: ChildSessionSelectOptions;
  title?: string;
  openSubagentSession?: (target: SidebarSubagentSessionTarget) => void;
  selectInMainPane: () => void;
}): void {
  const { parent, sessionId, options, title, openSubagentSession, selectInMainPane } = params;
  if (options.readOnly && openSubagentSession && sessionId !== parent.taskId) {
    openSubagentSession({
      workspacePath: parent.workspacePath,
      ...(parent.workspaceIdentity ? { workspaceIdentity: parent.workspaceIdentity } : {}),
      parentSessionId: parent.taskId,
      childSessionId: sessionId,
      title: title ?? "",
    });
    return;
  }
  selectInMainPane();
}
