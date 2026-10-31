import { SOURCE_SERVER_STOP_FAILED_ERROR_CODE } from "@zcode/shared";
import { SERVER_STOP_WAIT_TIMEOUT_MS, type ServerStatus } from "../contracts.js";
import { isControlEndpointUnavailable, requestControl } from "../ipc/controlClient.js";
import { DataRootLock } from "./lock.js";
import type { ServerLayout } from "./paths.js";
import { readPersistedStatusDetailed } from "./statusSnapshot.js";
import { describeLockInspection } from "./uninstallGuard.js";

/**
 * stop-failed as written to the status snapshot: the Supervisor failed to stop Core, keeps
 * holding the lock, and will not stop itself again. The failure fact comes from the status
 * file, not a control reply, so it does not reuse `ControlRequestError`; `code` remains a
 * public error code the CLI top level reads structurally and passes through to the desktop.
 */
class ServerStopFailedError extends Error {
  public readonly code = SOURCE_SERVER_STOP_FAILED_ERROR_CODE;

  public constructor(lastExitReason: string | null) {
    super(`Server stop failed${lastExitReason ? `: ${lastExitReason}` : ""}`);
    this.name = "ServerStopFailedError";
  }
}

/** Whether the snapshot means the Supervisor has finished stopping; uninstalled is the stopped state within the uninstall flow. */
export function isStoppedServerStatus(status: ServerStatus | null | undefined): boolean {
  return status?.state === "stopped" || status?.state === "uninstalled";
}

export async function waitForServerStopped(
  layout: ServerLayout,
  minUpdatedAt = 0,
  requireFreshSnapshot = false,
): Promise<void> {
  // Bug cause: the old 6s cap was shorter than the Supervisor's 5s grace period + kill wait;
  // when Core takes the SIGKILL path the Supervisor still reaches stopped normally, but the
  // waiter times out first, so update handoff falsely reported failure.
  const deadline = Date.now() + SERVER_STOP_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const persisted = await readPersistedStatusDetailed(layout);
    if (persisted.state === "invalid" || persisted.state === "unreadable") {
      throw new Error("Cannot verify Server shutdown status");
    }
    const lockInspection = await new DataRootLock(layout.lockFile).inspect();
    if (lockInspection.state === "invalid" || lockInspection.state === "unreadable") {
      throw new Error(`Cannot verify Server shutdown (${describeLockInspection(lockInspection)})`);
    }
    const lockReleased = lockInspection.state === "missing" || lockInspection.state === "stale";
    const stopped = isStoppedServerStatus(persisted.status);
    const freshSnapshot = persisted.status !== null && persisted.status.updatedAt > minUpdatedAt;
    // A stop-failed written after this stop is terminal: the Supervisor keeps the lock and
    // will not stop itself again; polling on would only stretch a definite failure into a
    // 20-second timeout.
    if (requireFreshSnapshot && freshSnapshot && persisted.status?.state === "stop-failed") {
      throw new ServerStopFailedError(persisted.status.lastExitReason);
    }
    // The stopped snapshot is persisted before lock.release, so a stale stopped snapshot is not sufficient to register a new service immediately.
    // Migration must confirm both the new snapshot and lock release; only offline uninstallation with no snapshot may proceed based on the missing lock alone.
    if (
      lockReleased &&
      ((stopped && (!requireFreshSnapshot || freshSnapshot)) ||
        (!requireFreshSnapshot && persisted.state === "missing"))
    )
      return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Server shutdown (${layout.statusFile})`);
}

/**
 * Fallback for a repeated stop while control is unreachable; the CLI's single implementation
 * (shared by the ack-style `stop` and the stop wait).
 *
 * The Supervisor's shutdown order is "persist stopped → close control → release the lock".
 * If control is already unreachable and the snapshot is stopped/uninstalled, another stop has
 * completed or is finishing, so a repeated stop must not be reported as failed just because
 * the socket vanished. Returns the current snapshot; returns null when no snapshot exists
 * (status was never written). Otherwise rethrows the control error as-is.
 */
export async function readStatusForStopWithoutControl(
  layout: ServerLayout,
  controlError: unknown,
): Promise<ServerStatus | null> {
  if (!isControlEndpointUnavailable(controlError)) throw controlError;
  const persisted = await readPersistedStatusDetailed(layout);
  if (persisted.state === "invalid" || persisted.state === "unreadable") throw controlError;
  if (persisted.status !== null && !isStoppedServerStatus(persisted.status)) throw controlError;
  return persisted.status;
}

/**
 * Stop the existing Supervisor and wait for the stop to complete; the CLI's single
 * "stop and wait" implementation.
 *
 * Read the pre-stop status as a baseline → treat a missing or stale lock as already stopped
 * → send stop to control → wait until the data-root lock is released and status is a stopped
 * newer than the baseline. `operation` is used only in error messages.
 */
export async function stopSupervisorAndWait(
  layout: ServerLayout,
  operation: string,
): Promise<void> {
  const persisted = await readPersistedStatusDetailed(layout);
  if (persisted.state === "invalid" || persisted.state === "unreadable") {
    throw new Error(`Cannot verify Server status before ${operation}`);
  }
  const baselineUpdatedAt = persisted.status?.updatedAt ?? 0;
  const lockInspection = await new DataRootLock(layout.lockFile).inspect();
  if (lockInspection.state === "invalid" || lockInspection.state === "unreadable") {
    throw new Error(
      `Cannot verify Server lock before ${operation} (${describeLockInspection(lockInspection)})`,
    );
  }
  // No live lock holder means no Supervisor to stop; a leftover control socket is cleaned up by the next Supervisor.
  if (lockInspection.state === "missing" || lockInspection.state === "stale") return;
  try {
    await requestControl(layout.controlEndpoint, { command: "stop" });
  } catch (error) {
    // Lock still held by a live process but no snapshot at all: the Supervisor is still in its
    // first startup (lock first, then control listener, then persist), not winding down a stop,
    // so fail with the original control error. If another stop is finishing, just wait for the
    // lock to be released.
    if ((await readStatusForStopWithoutControl(layout, error)) === null) throw error;
    await waitForServerStopped(layout);
    return;
  }
  await waitForServerStopped(layout, baselineUpdatedAt, true);
}
