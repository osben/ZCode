import { stat } from "node:fs/promises";

export interface ExecutionWorktreeGuardFact {
  path: string;
  missing?: boolean;
}

const WORKSPACE_READ_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "ListSavedWorkflows",
  "ListWorkflowRuns",
  "GetWorkflowRun",
]);

/** Reject tools that can inspect or change workspace state when their isolated cwd is unavailable. */
export async function getMissingExecutionWorktreeToolError(
  worktree: ExecutionWorktreeGuardFact | undefined,
  sideEffectScope: string | undefined,
  toolName: string,
  isDirectory: (path: string) => Promise<boolean> = async (path) => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
): Promise<string | undefined> {
  if (!worktree) return undefined;
  const requiresWorkspace =
    sideEffectScope === "workspace" ||
    sideEffectScope === "git" ||
    sideEffectScope === "system" ||
    (sideEffectScope === "none" && WORKSPACE_READ_TOOLS.has(toolName));
  if (!requiresWorkspace) return undefined;
  if (await isDirectory(worktree.path)) return undefined;
  return `Execution worktree is missing or unavailable: ${worktree.path}. Workspace and terminal actions are blocked until it is restored.`;
}
