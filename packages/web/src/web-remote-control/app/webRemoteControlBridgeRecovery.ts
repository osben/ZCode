const WEB_REMOTE_CONTROL_BRIDGE_RECOVERY_RETRY_DELAYS_MS = [1_000, 2_000, 5_000] as const;

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
