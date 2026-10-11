// v4 workspace-config carries only workspace presentation. Model candidates and preferences come
// from the target Host's ModelSelectionView; do not derive a second model catalog from live Session settings.
import { getZCodeAgentModeSelectOptions, normalizeAvailableZCodeMode } from "@zcode/shared";
import type { ZCodeSessionSettingsState, ZCodeSlashCommand } from "@zcode/shared";
import type { WorkspaceConfigState } from "@zcode/shared/zcode-protocol-v4";
import { mapSessionSettings } from "./mapper.js";
import { listProtocolSlashCommands } from "./slash-commands.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** Project only non-model workspace mode and slash commands from Session settings. */
export function toV4WorkspaceConfigState(
  settings: ZCodeSessionSettingsState,
  slashCommands: readonly ZCodeSlashCommand[],
): WorkspaceConfigState {
  return {
    configOptions: [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: normalizeAvailableZCodeMode(settings.mode.current),
        options: getZCodeAgentModeSelectOptions(),
      },
    ],
    slashCommands: slashCommands.map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.inputHint !== undefined ? { inputHint: command.inputHint } : {}),
      ...(command.source !== undefined ? { source: command.source } : {}),
    })),
  };
}

/**
 * Seed value on subscription: use only the live-session fast path (mapSessionSettings reads a
 * registered app directly). Deliberately do not create a temporary app: if host startup warmup reads
 * workspace presentation before any active session exists, creating a temporary app can let MCP
 * shutdown block the protocol channel (see the desktop warmUpZCodeAgent comment). Return null (empty
 * catalog seed) when there is no registered session. The Host's process Registry View provides the
 * model selection catalog; this session protocol publishes task-level configuration only after a
 * live session exists.
 */
export async function buildLiveWorkspaceConfigStateV4(
  context: ZCodeProtocolAgentServerContext,
  workspaceId: string,
): Promise<WorkspaceConfigState | null> {
  const record = Array.from(context.sessions.values()).find(
    (candidate) => candidate.workspace.workspaceKey === workspaceId,
  );
  if (!record) return null;
  const settings = await mapSessionSettings(record.app);
  const slashCommands = await listProtocolSlashCommands({
    // The rollout gate is a Host-determined workspace-level fact; catalog assembly reads the process cache.
    dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
    env: context.deps.env,
    logger: context.logger,
    workingDirectory: record.workspace.workspacePath,
  });
  return toV4WorkspaceConfigState(settings, slashCommands);
}
