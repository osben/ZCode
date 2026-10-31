import {
  compareSemverVersions,
  SOURCE_SERVER_LIFECYCLE_CONTROL_MIN_VERSION,
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
} from "@zcode/shared";
import type {
  SourceServerConnectionStateSnapshot,
  SourceServerManagementSnapshot,
  SourceServerRunningTask,
  SourceServerRunningTasksResult,
  SourceServerUpdateTarget,
} from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";
import type { RemoteConnectionStatus } from "@/lib/remoteConnectionPresentation.js";
import { logger } from "@/logger.js";

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Management error code when the Host cannot silently obtain connection credentials (for example an unsaved SSH password while the device is offline). */
export function isSourceServerCredentialsRequiredError(error: unknown): boolean {
  return getErrorCode(error) === "credentials-required";
}

export type SourceServerLifecycleActionAvailability =
  | { visible: false }
  | { visible: true; enabled: boolean; requiresRemoteUpdate: boolean };

/**
 * Shared availability of the remote service lifecycle actions (restart and stop) in the device card "More" menu (RDLC-01):
 * hidden while the device needs attention (five-state pending); disabled with an update hint when the last seen remote
 * version is below the first supported version or unknown; disabled while connecting, updating, or while the device has
 * another action in progress; available when connected, disconnected, or failed to connect.
 */
export function resolveSourceServerLifecycleActionAvailability(input: {
  status: RemoteConnectionStatus;
  deviceBusy: boolean;
  lastSeenVersion?: string;
}): SourceServerLifecycleActionAvailability {
  if (input.status === "pending") return { visible: false };
  // Do not probe capability by sending a command: an old CLI hands unknown commands to the TUI and hangs,
  // or treats `stop --wait` as an ack-style stop.
  const comparison = input.lastSeenVersion
    ? compareSemverVersions(input.lastSeenVersion, SOURCE_SERVER_LIFECYCLE_CONTROL_MIN_VERSION)
    : null;
  const requiresRemoteUpdate = comparison === null || comparison < 0;
  return {
    visible: true,
    requiresRemoteUpdate,
    enabled: !requiresRemoteUpdate && !input.deviceBusy && input.status !== "connecting",
  };
}

export type SourceServerReinstallAvailability =
  | { visible: false }
  | { visible: true; enabled: boolean };

/**
 * Availability of "Reinstall remote service" (RDRI-01), shared by the device card "More" menu, the
 * device card error bar, and the connection wizard failure page. Reinstall is executed by the CLI
 * bundled in the local archive, so it sets no minimum remote version. Hidden while the device needs
 * attention (five-state pending) or is uninstalled: the former has its own primary action and the
 * latter already offers "Reinstall and connect". Hidden when the last seen remote version is newer
 * than the local one: that entry would actually be a downgrade, and downgrades keep their own
 * confirmation; the real guard remains the remote CLI's downgrade check.
 */
export function resolveSourceServerReinstallAvailability(input: {
  status: RemoteConnectionStatus;
  deviceBusy: boolean;
  installState?: "installed" | "uninstalled";
  lastSeenVersion?: string;
  localVersion: string;
}): SourceServerReinstallAvailability {
  if (input.status === "pending" || input.installState === "uninstalled") return { visible: false };
  const comparison = input.lastSeenVersion
    ? compareSemverVersions(input.lastSeenVersion, input.localVersion)
    : null;
  if (comparison !== null && comparison > 0) return { visible: false };
  return { visible: true, enabled: !input.deviceBusy && input.status !== "connecting" };
}

/** Reinstall confirmation shared by the device card and the connection wizard; not destructive — running tasks are covered by the update chain's force confirmation. */
export function getSourceServerReinstallConfirmation(input: {
  source: string;
  version: string;
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
}) {
  return {
    title: input.formatMessage({ id: "settings.source.reinstallRemoteServiceTitle" }),
    description: input.formatMessage(
      { id: "settings.source.reinstallRemoteServiceDescription" },
      { source: input.source, version: input.version.replace(/^v/iu, "") },
    ),
    confirmLabel: input.formatMessage({ id: "settings.source.reinstallRemoteServiceConfirm" }),
    intent: "source-server-reinstall",
  };
}

export async function runSourceServerUpdate(options: {
  management: ISourceServerManagementService;
  profileId: string;
  expectedTarget?: SourceServerUpdateTarget;
  /** The user confirmed switching a newer remote to this machine's Desktop version. */
  allowDowngrade?: boolean;
  confirmForce: () => Promise<boolean>;
}): Promise<SourceServerManagementSnapshot | null> {
  const request = {
    profileId: options.profileId,
    ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
  };
  const intent = options.allowDowngrade ? { allowDowngrade: true } : {};
  try {
    return await options.management.updateSource({ ...request, force: false, ...intent });
  } catch (error) {
    if (getErrorCode(error) !== SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE) {
      throw error;
    }
    // Bug 原因：版本 required 过去直接等价为 force update，会绕过运行中 Task guard。
    // 先受 guard 拒绝，再由用户明确确认中断，才能发送 force=true。
    if (!(await options.confirmForce())) return null;
    return await options.management.updateSource({ ...request, force: true, ...intent });
  }
}

/** Downgrade second confirmation shared by the wizard and the device card; versions come from the Host snapshot, the Renderer does not compare them. */
export function getSourceServerDowngradeConfirmation(
  state: Pick<SourceServerConnectionStateSnapshot, "currentVersion" | "availableVersion">,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
) {
  const values = {
    version: state.currentVersion?.replace(/^v/iu, "") ?? "",
    current: state.availableVersion?.replace(/^v/iu, "") ?? "",
  };
  return {
    title: formatMessage({ id: "remote.downgradeConfirmTitle" }, values),
    description: formatMessage({ id: "remote.downgradeConfirmDescription" }, values),
    confirmLabel: formatMessage({ id: "remote.downgradeConfirm" }),
    cancelLabel: formatMessage({ id: "common.cancel" }),
  };
}

/** guard 拒绝后读取 Host 的活动投影；旧远端不支持时明确告知清单不可用。 */
export async function getSourceServerForceUpdateDescription(
  management: ISourceServerManagementService,
  profileId: string,
  formatMessage: (id: string) => string,
): Promise<string> {
  const snapshot = await management.getSnapshot();
  const tasks = snapshot.states.find((state) => state.profileId === profileId)?.runningTasks;
  return (
    formatMessage("settings.source.forceUpdateDescription") +
    "\n\n" +
    (tasks?.length
      ? formatSourceServerRunningTasks(tasks)
      : formatMessage("remote.runningTasksUnavailable"))
  );
}

/** Display of the running-task list (shared by forced update and stop/restart of the remote service): one `sessionId — workspacePath` per line. */
export function formatSourceServerRunningTasks(tasks: readonly SourceServerRunningTask[]): string {
  return tasks.map((task) => `${task.sessionId} — ${task.workspacePath}`).join("\n");
}

/**
 * Reads the running tasks on the device before a stop/restart confirmation (RDLC-01). When credentials cannot be obtained silently the error is rethrown as-is, and the caller shows a credentials prompt without opening the confirmation;
 * other read failures must not be treated as "no tasks"; the confirmation continues with the list marked unavailable.
 */
export async function readSourceServerRunningTasksForConfirmation(
  management: ISourceServerManagementService,
  sourceServerId: string,
): Promise<SourceServerRunningTasksResult> {
  try {
    return await management.getSourceRunningTasks(sourceServerId);
  } catch (error) {
    if (isSourceServerCredentialsRequiredError(error)) throw error;
    logger.warn(
      "[SourceServerLifecycle] running tasks read failed; showing the list as unavailable",
      {
        sourceServerId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return { available: false };
  }
}

/**
 * Danger confirmation text for stopping/restarting the remote service (RDLC-01), in order: the interruption notice; the task list (when unavailable, notes that the device did not provide it;
 * when empty, notes that no task is running); ZCode on other computers may restart the remote service; when only stopping and "reconnect on startup"
 * is enabled, the next ZCode launch restarts the remote service.
 */
export function getRemoteServiceLifecycleDescription(input: {
  action: "restart" | "stop";
  runningTasks: SourceServerRunningTasksResult;
  startupAutoReconnect: boolean;
  formatMessage: (id: string) => string;
}): string {
  const { runningTasks, formatMessage } = input;
  const taskSection = !runningTasks.available
    ? formatMessage("settings.source.remoteServiceRunningTasksUnavailable")
    : runningTasks.tasks.length > 0
      ? formatSourceServerRunningTasks(runningTasks.tasks)
      : formatMessage("settings.source.remoteServiceNoRunningTasks");
  return [
    formatMessage("settings.source.remoteServiceInterruptionDescription"),
    taskSection,
    formatMessage("settings.source.remoteServiceOtherClientsNotice"),
    ...(input.action === "stop" && input.startupAutoReconnect
      ? [formatMessage("settings.source.stopRemoteServiceStartupReconnectNotice")]
      : []),
  ].join("\n\n");
}
