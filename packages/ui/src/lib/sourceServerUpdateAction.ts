import {
  compareSemverVersions,
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
} from "@zcode/shared";
import type { SourceServerManagementSnapshot, SourceServerUpdateTarget } from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";
import type { RemoteConnectionStatus } from "@/lib/remoteConnectionPresentation.js";

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Management error code when the Host cannot silently obtain connection credentials (for example an unsaved SSH password while the device is offline). */
export function isSourceServerCredentialsRequiredError(error: unknown): boolean {
  return getErrorCode(error) === "credentials-required";
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
  confirmForce: () => Promise<boolean>;
}): Promise<SourceServerManagementSnapshot | null> {
  try {
    return await options.management.updateSource({
      profileId: options.profileId,
      ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
      force: false,
    });
  } catch (error) {
    if (getErrorCode(error) !== SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE) {
      throw error;
    }
    // Bug 原因：版本 required 过去直接等价为 force update，会绕过运行中 Task guard。
    // 先受 guard 拒绝，再由用户明确确认中断，才能发送 force=true。
    if (!(await options.confirmForce())) return null;
    return await options.management.updateSource({
      profileId: options.profileId,
      ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
      force: true,
    });
  }
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
      ? tasks.map((task) => `${task.sessionId} — ${task.workspacePath}`).join("\n")
      : formatMessage("remote.runningTasksUnavailable"))
  );
}
