// Fork: the helper's plugin resolution cache (specs/fork-rust-node-helper.md F3, "Session open and close").
import type { PluginLoadOutcome } from "@zcode/contracts";
import { type HelperWorkspace, workspaceKeyOf } from "./f3-protocol.js";

/**
 * One resolution per workspace key and directory: Node resolves a session's plugins in its working directory
 * (an execution worktree, or the workspace), so each worktree is its own entry. A failed resolution is retried.
 */
export class PluginOutcomes {
  private readonly outcomes = new Map<string, Promise<PluginLoadOutcome>>();

  constructor(private readonly resolve: (workspace: HelperWorkspace) => Promise<PluginLoadOutcome>) {}

  get(workspace: HelperWorkspace, directory = workspace.workspacePath): Promise<PluginLoadOutcome> {
    const key = JSON.stringify([workspaceKeyOf(workspace), directory]);
    let outcome = this.outcomes.get(key);
    if (!outcome) {
      outcome = this.resolve({ ...workspace, workspacePath: directory }).catch((error: unknown) => {
        if (this.outcomes.get(key) === outcome) this.outcomes.delete(key);
        throw error;
      });
      this.outcomes.set(key, outcome);
    }
    return outcome;
  }
}
