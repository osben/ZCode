import { resolveWorkspaceKey, type RemoteTarget, type WorkspacePurpose } from "@zcode/shared";
import { isWorkspaceTab, isWorkspaceTabReadOnly, type WindowTabState } from "@/store/tabStore.js";

export interface AutomationWorkspaceOption {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  label: string;
  workspacePurpose?: WorkspacePurpose;
}

export function resolveAutomationWorkspaceSelectionKey(
  workspace: Pick<AutomationWorkspaceOption, "workspacePath" | "workspaceIdentity">,
): string {
  return resolveWorkspaceKey(workspace);
}

export function findAutomationWorkspaceOptionByKey(
  options: readonly AutomationWorkspaceOption[],
  workspaceKey: string | null,
): AutomationWorkspaceOption | undefined {
  return options.find((option) => resolveAutomationWorkspaceSelectionKey(option) === workspaceKey);
}

/**
 * Project selection in a create form must use a currently valid candidate.
 * When candidates change, keep a still-valid selection; otherwise fall back to the valid default project, first valid project, or null in that order.
 */
export function reconcileAutomationWorkspaceSelectionKey(
  options: readonly AutomationWorkspaceOption[],
  currentWorkspaceKey: string | null,
  preferredWorkspace?: Pick<AutomationWorkspaceOption, "workspacePath" | "workspaceIdentity">,
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
