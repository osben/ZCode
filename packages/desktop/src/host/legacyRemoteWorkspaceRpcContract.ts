import type { IServiceAccessor } from "@zcode/services";

/**
 * Move only the existing remote RPC client into the window Host; do not change the zcode-server wire.
 * This narrow type fixes the legacy channel actually needed by mixed remote workspaces and validates completeness before services are composed.
 */
const LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS = [
  "fileService",
  "gitService",
  "gitCheckpointService",
  "systemService",
  "terminalService",
  "zcodeTaskService",
  "zcodeAgentService",
  "zcodeSessionService",
  "fileWatcherService",
  "skillsService",
  "skillSyncService",
  "mcpSyncService",
  "pluginSyncService",
  "pluginsService",
  "pluginManagementService",
  "commandsService",
  "hooksService",
  "modelSelectionService",
  "providerSettingsService",
] as const satisfies readonly (keyof IServiceAccessor)[];

type LegacyRemoteWorkspaceRpcContract = Pick<
  IServiceAccessor,
  (typeof LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS)[number]
>;

export function assertLegacyRemoteWorkspaceRpcContract(
  value: Partial<IServiceAccessor>,
): asserts value is Partial<IServiceAccessor> & LegacyRemoteWorkspaceRpcContract {
  const missing = LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS.filter((channel) => {
    const service = value[channel];
    return (typeof service !== "object" || service === null) && typeof service !== "function";
  });
  if (missing.length > 0) {
    throw new Error(`Legacy remote workspace RPC channel 不完整: ${missing.join(", ")}`);
  }
}
