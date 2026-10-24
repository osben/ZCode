import { useMemo } from "react";
import type {
  ProjectSidebarProps,
  SidebarSubagentSessionTarget,
} from "@/project-sidebar/contract.js";

/**
 * Subagent rows go through the parent navigation (useProjectTaskNavigation) so a remote workspace
 * whose tab is closed is attached before the shell selects the parent (spec
 * sidebar-child-conversation-counts §8.2).
 */
export function useSidebarSubagentOpen(
  onSelectTask: ProjectSidebarProps["onSelectTask"],
  shellOpen: ProjectSidebarProps["onOpenSubagentSession"],
): ProjectSidebarProps["onOpenSubagentSession"] {
  const enabled = Boolean(shellOpen);
  return useMemo(
    () =>
      enabled
        ? (target: SidebarSubagentSessionTarget) =>
            onSelectTask(
              target.workspacePath,
              target.parentSessionId,
              target.workspaceIdentity,
              undefined,
              undefined,
              { subagentTarget: target },
            )
        : undefined,
    [enabled, onSelectTask],
  );
}
