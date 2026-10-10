import { useMemo } from "react";
import type { WorkspacePurpose } from "@zcode/shared";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { useLocalWorkspaceScopes } from "@/hooks/useLocalWorkspaceScopes.js";

interface AutomationProjectOption {
  workspacePath: string;
  label: string;
  workspacePurpose?: WorkspacePurpose;
}

export function isRemoteAutomationWorkspace(tab: WorkspaceTabState | undefined): boolean {
  return Boolean(tab?.remoteSessionId || tab?.remoteTarget || tab?.workspaceIdentity);
}

interface AutomationProjectOptionsConfig {
  includeConversationWorkspace?: boolean;
}

function resolveAutomationProjectOptions(
  workspaceTabs: WorkspaceTabState[],
  config: AutomationProjectOptionsConfig = {},
): AutomationProjectOption[] {
  const result: AutomationProjectOption[] = [];
  let conversationWorkspaceIncluded = false;

  for (const tab of workspaceTabs) {
    if (tab.availability === "unavailable-local-directory") continue;

    if (tab.workspacePurpose === "conversation") {
      if (!config.includeConversationWorkspace || conversationWorkspaceIncluded) {
        continue;
      }
      // Historical settings may retain multiple conversation backing paths, but they all represent the same logical
      // "no-project session" target. Keep purpose rather than identifying it by default label, so the menu can reuse the
      // session-side "Work outside a project" label/icon while still binding to one canonical cwd.
      conversationWorkspaceIncluded = true;
      result.push({
        workspacePath: tab.workspacePath,
        label: "default",
        workspacePurpose: "conversation",
      });
      continue;
    }

    result.push({
      workspacePath: tab.workspacePath,
      label: tab.label || workspaceBasename(tab.workspacePath),
    });
  }

  return result;
}

/**
 * Automation creation reads only usable local workspaces already open in the current window.
 * Scheduled tasks may explicitly include a logical "no-project session" target; off-peak tasks remain limited to real projects.
 *
 * Keep only usable local workspace tabs; exclude recent projects and remote tabs to avoid passing remote identity to a local
 * host or letting an off-peak task inherit a remote workspace. Both task types share these entry filters to preserve consistent project-isolation semantics.
 */
export function useAutomationProjectOptions(
  config: AutomationProjectOptionsConfig = {},
): AutomationProjectOption[] {
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const localWorkspaceTabs = useLocalWorkspaceScopes({ workspaceTabs });
  const includeConversationWorkspace = config.includeConversationWorkspace === true;

  return useMemo(
    () =>
      resolveAutomationProjectOptions(localWorkspaceTabs, {
        includeConversationWorkspace,
      }),
    [includeConversationWorkspace, localWorkspaceTabs],
  );
}

function workspaceBasename(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}
