import type { AcknowledgedWebRemoteControlRelayProtocolAdapter } from "@zcode/client";
import {
  isWebRemoteControlBridgeableWorkspaceTarget,
  remoteHostIdFromWorkspaceIdentity,
  resolveWebRemoteControlInitialWorkspaceSelection,
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlWindowBootstrapResult,
} from "@zcode/shared";

const WEB_REMOTE_CONTROL_BRIDGE_RECOVERY_RETRY_DELAYS_MS = [1_000, 2_000, 5_000] as const;

/** Invalidation notifications may be re-sent with heartbeats; only the raw adapter's first state transition starts recovery. */
export function acceptWebRemoteControlBridgeInvalidation(
  protocol: AcknowledgedWebRemoteControlRelayProtocolAdapter | undefined,
  bridgeSessionId: string | undefined,
  reason: string,
): void {
  if (!protocol || protocol.getBridgeSessionId() !== bridgeSessionId || protocol.isDegraded())
    return;
  protocol.markDegraded(reason);
}

export function resolveWebRemoteControlRecoveryTarget(
  snapshot: WebRemoteControlWindowBootstrapResult,
  preferred?: { preferredWorkspaceKey?: string; preferredTaskId?: string },
):
  | (NonNullable<ReturnType<typeof resolveWebRemoteControlInitialWorkspaceSelection>> & {
      taskHostId?: string;
    })
  | null {
  // Cold starts once misapplied the hard recovery rule, letting stale navigation block loading of a usable workspace.
  // Keep the original target only when explicitly recovering the current page; first load and full refresh reuse the initial selection rule.
  if (!preferred?.preferredWorkspaceKey)
    return resolveWebRemoteControlInitialWorkspaceSelection(snapshot);
  const view = {
    activeWorkspaceKey: preferred.preferredWorkspaceKey,
    activeTaskId: preferred.preferredTaskId,
  };
  const workspace = snapshot.workspaces.find(
    (target) => resolveWebRemoteControlWorkspaceKey(target) === view.activeWorkspaceKey,
  );
  if (workspace) {
    return {
      workspaceKey: view.activeWorkspaceKey,
      ...(view.activeTaskId ? { taskId: view.activeTaskId } : {}),
      canBridge: isWebRemoteControlBridgeableWorkspaceTarget(workspace),
    };
  }
  if (view.activeTaskId) {
    // Projects opened standalone on mobile are only added as candidates by the legacy bridge; attachment release does not mean the task is gone.
    // Re-validate the directory and session through existing Host task navigation; do not cache the old remoteSessionId and do not jump to the default.
    return {
      workspaceKey: view.activeWorkspaceKey,
      taskId: view.activeTaskId,
      taskHostId: remoteHostIdFromWorkspaceIdentity(view.activeWorkspaceKey) ?? "local",
      canBridge: true,
    };
  }
  return resolveWebRemoteControlInitialWorkspaceSelection(snapshot);
}

export function getWebRemoteControlBridgeRecoveryRetryDelay(attempt: number): number | null {
  return WEB_REMOTE_CONTROL_BRIDGE_RECOVERY_RETRY_DELAYS_MS[attempt] ?? null;
}

/** The same recovery owner rebuilds the bridge serially; after a successful reconnect, the target must be verified and restored only after the old offline snapshot has closed out. */
export function createWebRemoteControlBridgeRecoveryRunner(
  recover: (reason: string) => Promise<void>,
) {
  let flight: Promise<void> | undefined;
  return async (reason: string, shouldRecoverAfterCurrent?: () => boolean): Promise<void> => {
    if (flight) {
      await flight;
      if (!shouldRecoverAfterCurrent) return;
    }
    if (shouldRecoverAfterCurrent && !shouldRecoverAfterCurrent()) return;
    if (!flight) {
      // Register the flight before calling recover, so that a synchronous markDegraded callback does not re-enter recovery.
      const next = Promise.resolve()
        .then(() => recover(reason))
        .finally(() => {
          if (flight === next) flight = undefined;
        });
      flight = next;
    }
    await flight;
  };
}
