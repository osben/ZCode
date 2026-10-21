export interface WebRemoteControlTaskReadTarget {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  expectedUnreadAt: number;
}

export interface WebRemoteControlTaskReadService {
  setTaskUnread(params: WebRemoteControlTaskReadTarget & { unread: false }): Promise<unknown>;
}

export interface WebRemoteControlTaskReadBridge {
  kind: "local" | "remote";
  workspacePath: string;
  workspaceIdentity?: string;
  initialTaskId?: string;
}

export type WebRemoteControlTaskReadResult = { ok: true } | { ok: false; error: unknown };

/**
 * The unreadAt of the phone task home comes from the desktop snapshot and is not guaranteed to exist in the current Root's query cache.
 * Therefore, read-state writes must directly use the task service of the current shared-host bridge and the exact workspace identity.
 */
export async function markWebRemoteControlTaskRead({
  service,
  target,
}: {
  service: WebRemoteControlTaskReadService;
  target: WebRemoteControlTaskReadTarget;
}): Promise<WebRemoteControlTaskReadResult> {
  try {
    await service.setTaskUnread({
      ...target,
      unread: false,
    });
    return { ok: true };
  } catch (error) {
    // An unread write is a companion action; on failure, keep the authoritative unreadAt and do not block the user from opening the task.
    return { ok: false, error };
  }
}

export async function markWebRemoteControlBridgeTaskRead({
  bridge,
  expectedUnreadAt,
  service,
}: {
  bridge: WebRemoteControlTaskReadBridge;
  expectedUnreadAt?: number;
  service: WebRemoteControlTaskReadService;
}): Promise<WebRemoteControlTaskReadResult> {
  if (typeof expectedUnreadAt !== "number" || !bridge.initialTaskId) {
    return { ok: true };
  }

  return markWebRemoteControlTaskRead({
    service,
    target: {
      taskId: bridge.initialTaskId,
      workspacePath: bridge.workspacePath,
      ...(bridge.kind === "remote" && bridge.workspaceIdentity
        ? { workspaceIdentity: bridge.workspaceIdentity }
        : {}),
      expectedUnreadAt,
    },
  });
}
