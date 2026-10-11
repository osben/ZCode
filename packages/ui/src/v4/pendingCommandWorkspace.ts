import type { SessionCreateSource } from "@zcode/shared";
import type { GroupedDraftTaskState } from "@/store/zcodeSessionStoreTypes.js";

export interface PendingCommandClientContext {
  workspace?: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
  groupedDraftTask?: GroupedDraftTaskState;
  sessionCreateSource?: SessionCreateSource;
}

interface WorkspaceScopedPendingCommand {
  clientContext?: PendingCommandClientContext;
  replay: {
    kind: "input" | "sensitiveDigest";
    type: string;
    payload?: Record<string, unknown>;
  };
}

export function resolvePendingCommandWorkspaceKey(
  entry: WorkspaceScopedPendingCommand,
): string | null {
  const workspace = entry.clientContext?.workspace;
  if (workspace) {
    return workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  }
  if (entry.replay.kind !== "input" || entry.replay.type !== "createSession") {
    return null;
  }
  // Support createSession recovery hints persisted before the upgrade: workspaceId in the protocol payload
  // is itself the originating workspaceKey, so do not display it across workspaces just because the new clientContext is missing.
  const workspaceId = entry.replay.payload?.workspaceId;
  return typeof workspaceId === "string" && workspaceId.trim() ? workspaceId.trim() : null;
}

export function isPendingCommandForWorkspace(
  entry: WorkspaceScopedPendingCommand,
  workspacePath: string,
  workspaceIdentity?: string,
): boolean {
  return resolvePendingCommandWorkspaceKey(entry) === (workspaceIdentity?.trim() || workspacePath);
}
