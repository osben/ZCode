import { resolveWorkspaceKey, type RemoteTarget, type WorkspacePurpose } from "@zcode/shared";
import { isWorkspaceTab, isWorkspaceTabReadOnly, type WindowTabState } from "@/store/tabStore.js";

export interface AutomationWorkspaceOption {
  projectId?: string | null;
  hostId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  label: string;
  workspacePurpose?: WorkspacePurpose;
}

export function resolveAutomationWorkspaceSelectionKey(
  workspace: Pick<
    AutomationWorkspaceOption,
    "workspacePath" | "workspaceIdentity" | "projectId" | "hostId"
  >,
): string {
  return workspace.projectId
    ? JSON.stringify([workspace.hostId ?? "local", workspace.projectId])
    : resolveWorkspaceKey(workspace);
}

export function findAutomationWorkspaceOptionByKey(
  options: readonly AutomationWorkspaceOption[],
  workspaceKey: string | null,
): AutomationWorkspaceOption | undefined {
  return options.find((option) => resolveAutomationWorkspaceSelectionKey(option) === workspaceKey);
}

/**
 * 新建表单的项目选择只能落在当前有效候选中。
 * 候选变化时保留仍有效的选择，否则依次回落到有效默认项目、首个有效项目或 null。
 */
export function reconcileAutomationWorkspaceSelectionKey(
  options: readonly AutomationWorkspaceOption[],
  currentWorkspaceKey: string | null,
  preferredWorkspace?: Pick<
    AutomationWorkspaceOption,
    "workspacePath" | "workspaceIdentity" | "projectId" | "hostId"
  >,
): string | null {
  const current = findAutomationWorkspaceOptionByKey(options, currentWorkspaceKey);
  if (current) return resolveAutomationWorkspaceSelectionKey(current);

  const preferredKey = preferredWorkspace
    ? resolveAutomationWorkspaceSelectionKey(preferredWorkspace)
    : null;
  const preferred = findAutomationWorkspaceOptionByKey(options, preferredKey);
  if (preferred) return resolveAutomationWorkspaceSelectionKey(preferred);

  const first = options[0];
  return first ? resolveAutomationWorkspaceSelectionKey(first) : null;
}

// Fork port (UI-1): restored from the fork; used by WorkflowRunSaveControls.
function workspaceLabelFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

/**
 * Build project-only candidates for boundaries that do not allow a "no project session."
 * The single "no project session" target additionally shown by the scheduled-task form is explicitly combined by useAutomationProjectOptions;
 * recentProjects, conversation backing, and invalid directories must not be mixed in as ordinary projects here.
 */
export function buildAutomationWorkspaceOptions(
  tabs: readonly WindowTabState[],
): AutomationWorkspaceOption[] {
  const byKey = new Map<string, AutomationWorkspaceOption>();
  for (const tab of tabs) {
    if (
      !isWorkspaceTab(tab) ||
      tab.workspacePurpose === "conversation" ||
      isWorkspaceTabReadOnly(tab)
    ) {
      continue;
    }
    const key = resolveWorkspaceKey({
      workspacePath: tab.workspacePath,
      workspaceIdentity: tab.workspaceIdentity,
    });
    if (byKey.has(key)) continue;
    byKey.set(key, {
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      ...(tab.remoteTarget ? { remoteTarget: tab.remoteTarget } : {}),
      label: tab.label || workspaceLabelFromPath(tab.workspacePath),
    });
  }
  return [...byKey.values()];
}
