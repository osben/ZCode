import {
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlWorkspaceListResult,
} from "@zcode/shared";

export interface WebRemoteControlWorkspaceOpenTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface WebRemoteControlWorkspaceOpenDeps {
  /** POST the workspace-open window-control request; resolves only on a successful desktop response. */
  requestWorkspaceOpen(target: WebRemoteControlWorkspaceOpenTarget): Promise<void>;
  /** Refresh the desktop workspace list (GET bootstrap); used to wait for the newly opened workspace to sync. */
  listWorkspaces(): Promise<WebRemoteControlWorkspaceListResult>;
  /** Existing switch path: workspace-bridge reconnect into the target workspace. */
  switchWorkspace(workspaceKey: string): Promise<void>;
  /** Injectable delay between list refresh attempts while waiting for the desktop workspace sync. */
  delay(ms: number): Promise<void>;
}

/**
 * The desktop open response only means Main dispatched the open to the window renderer; the
 * renderer pushes the updated workspace snapshot to Main afterwards. Bounded refresh loop so the
 * bridge request is sent only after the new workspace key is actually listed.
 */
export const WEB_REMOTE_CONTROL_WORKSPACE_OPEN_LIST_ATTEMPTS = 10;
export const WEB_REMOTE_CONTROL_WORKSPACE_OPEN_LIST_RETRY_DELAY_MS = 500;

function hasWorkspaceWithKey(
  result: WebRemoteControlWorkspaceListResult,
  workspaceKey: string,
): boolean {
  return result.workspaces.some(
    (workspace) => resolveWebRemoteControlWorkspaceKey(workspace) === workspaceKey,
  );
}

/**
 * Web remote-control workspace open: ask the DESKTOP to open (or reuse) the local workspace, wait
 * for the new workspace to appear in the refreshed list, then attach through the existing
 * workspace-bridge switch. The web client never creates its own Host for the opened workspace.
 * Identity rule: the key is `workspaceIdentity?.trim() || workspacePath`.
 */
export async function openWebRemoteControlWorkspace({
  target,
  deps,
  listAttempts = WEB_REMOTE_CONTROL_WORKSPACE_OPEN_LIST_ATTEMPTS,
  retryDelayMs = WEB_REMOTE_CONTROL_WORKSPACE_OPEN_LIST_RETRY_DELAY_MS,
}: {
  target: WebRemoteControlWorkspaceOpenTarget;
  deps: WebRemoteControlWorkspaceOpenDeps;
  listAttempts?: number;
  retryDelayMs?: number;
}): Promise<void> {
  await deps.requestWorkspaceOpen(target);

  const workspaceKey = resolveWebRemoteControlWorkspaceKey(target);
  for (let attempt = 1; attempt <= listAttempts; attempt += 1) {
    const list = await deps.listWorkspaces();
    if (hasWorkspaceWithKey(list, workspaceKey)) {
      await deps.switchWorkspace(workspaceKey);
      return;
    }
    if (attempt < listAttempts) {
      await deps.delay(retryDelayMs);
    }
  }

  throw new Error(
    `Opened workspace did not appear in the Web remote control workspace list: ${workspaceKey}`,
  );
}
