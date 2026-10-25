import type { ZCodeProvider } from "@zcode/shared";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStore.js";

interface ResolveWorkspaceSwitchDraftProviderOptions {
  currentSelectedProvider: ZCodeProvider;
  targetWorkspacePath: string;
  targetWorkspaceIdentity?: string;
  workspaces: Record<string, WorkspaceZCodeUIState | undefined>;
}

export function resolveWorkspaceSwitchDraftProvider({
  currentSelectedProvider,
  targetWorkspacePath,
  targetWorkspaceIdentity,
  workspaces,
}: ResolveWorkspaceSwitchDraftProviderOptions): ZCodeProvider {
  const workspaceKey = targetWorkspaceIdentity?.trim() || targetWorkspacePath;
  const targetWorkspaceState = workspaces[workspaceKey] ?? workspaces[targetWorkspacePath];

  // When switching workspaces from the empty state and immediately creating a draft, the app previously forced the source
  // workspace's selected Agent onto the target workspace, overwriting the Agent recently used by that project.
  // Prefer the provider remembered by the target workspace; inherit the current selection only if the target has no UI state yet.
  return targetWorkspaceState?.selectedProvider ?? currentSelectedProvider;
}
