// Pure logic for the global workflow group. Kept separate from the component to stay under the 400-line max-lines rule
// and make these React-free decisions easy to test.
import { resolveWorkspaceKey, type ZCodeSavedWorkflowRun } from "@zcode/shared";
import type { ZCodeAgentSavedWorkflowTarget } from "@zcode/services";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import type { SavedWorkflowProjectTarget } from "@/settings/saved-workflows/savedWorkflowContract.js";
import type { SavedWorkflowRunProject } from "@/settings/saved-workflows/SavedWorkflowRunHistoryPanel.js";

/** RPC carrier constant for global workflows: no workspace; the services layer selects the local runtime. */
export const GLOBAL_SAVED_WORKFLOW_TARGET: ZCodeAgentSavedWorkflowTarget = { scope: "global" };

/** Get the final path segment (supporting both `/` and `\\`) as a fallback label for run rows whose project is not open. */
function basenameOfPath(path: string): string {
  return (
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .filter(Boolean)
      .pop() ?? path
  );
}

/** Target for “Revise” / “Create via conversation”: active local project, or first local project if it is not a candidate; null if none exist. */
export function resolveGlobalActionTarget(
  localProjects: readonly AutomationWorkspaceOption[],
  activeProjectKey: string | null,
): SavedWorkflowProjectTarget | null {
  const active = localProjects.find((project) => resolveWorkspaceKey(project) === activeProjectKey);
  const target = active ?? localProjects[0];
  if (!target) return null;
  return {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
}

/** Find which open local project matches the run row's cwd (compared as absolute paths, verbatim). */
export function findProjectByCwd(
  localProjects: readonly AutomationWorkspaceOption[],
  cwd: string | undefined,
): AutomationWorkspaceOption | null {
  if (!cwd) return null;
  return localProjects.find((project) => project.workspacePath === cwd) ?? null;
}

/**
 * Project column for each run-history row on the detail page (global workflows spanning cwd values): if cwd matches an open project → use its label and allow “View instance”;
 * otherwise fall back to `basename(cwd)`, attach the full path as title, and disable “View instance”; legacy rows without cwd have no project column.
 */
export function buildGlobalRunProjectResolver(
  localProjects: readonly AutomationWorkspaceOption[],
): (run: ZCodeSavedWorkflowRun) => SavedWorkflowRunProject | null {
  return (run) => {
    if (!run.cwd) return null;
    const project = findProjectByCwd(localProjects, run.cwd);
    if (project) {
      return { label: project.label, title: run.cwd, canOpen: true };
    }
    return { label: basenameOfPath(run.cwd), title: run.cwd, canOpen: false };
  };
}
