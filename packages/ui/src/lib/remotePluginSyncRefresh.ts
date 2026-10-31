import type { ICommandsService, ISkillsService, IZCodeAgentService } from "@zcode/services";
import { logger } from "@/logger.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { mergeSlashCommandsAfterCommandRefresh } from "@/settings/pluginSlashCommandRefresh.js";
import { useCommandsStore } from "@/store/commandsStore.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { notifyPluginManagementChange } from "@/store/pluginManagementStoreLoading.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-fetch commands for the remote workspace and write them back to commandsStore and the input `/` panel (shared after plugin/command pushes). */
export async function refreshSlashCommandsAfterRemoteSync(params: {
  commandsService: ICommandsService;
  reason: string;
  workspacePath: string;
  workspaceIdentity: string | null;
}): Promise<void> {
  const { commandsService, reason, workspacePath, workspaceIdentity } = params;
  const workspaceIdentityParam = workspaceIdentity ?? undefined;

  try {
    const result = await commandsService.list({
      workspacePath,
      ...(workspaceIdentityParam ? { workspaceIdentity: workspaceIdentityParam } : {}),
    });

    const commandsStore = useCommandsStore.getState();
    // This refreshes the project scope (no authority); if the store points at the remote "user" of the same path, that is a different target — do not write back.
    if (
      commandsStore.workspacePath === workspacePath &&
      commandsStore.workspaceIdentity === workspaceIdentity &&
      commandsStore.authorityKey === null
    ) {
      useCommandsStore.setState({
        commands: result.commands,
        userCommands: result.userCommands,
        pluginCommands: result.pluginCommands,
        capability: result.capability,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentity,
        loadedAuthorityKey: null,
        loading: false,
        error: null,
      });
    }

    const zcodeSessionStore = useZCodeSessionStore.getState();
    const currentSlashCommands = zcodeSessionStore.getWorkspaceState(
      workspacePath,
      workspaceIdentityParam,
    ).slashCommands;
    // Remote plugin sync may run before the command settings page has opened, so commandsStore may not be initialized.
    // The input's `/` panel reads zcodeSessionStore.slashCommands, so after syncing, fetch commands from the current remote workspace
    // and write them to slashCommands directly; refreshing only the settings-page store is insufficient.
    zcodeSessionStore.setSlashCommands(
      workspacePath,
      mergeSlashCommandsAfterCommandRefresh(currentSlashCommands, result.commands),
      workspaceIdentityParam,
    );
  } catch (error) {
    const commandsStore = useCommandsStore.getState();
    if (
      commandsStore.workspacePath === workspacePath &&
      commandsStore.workspaceIdentity === workspaceIdentity &&
      commandsStore.authorityKey === null
    ) {
      useCommandsStore.setState({
        loading: false,
        error: toMessage(error),
      });
    }
    logger.warn("[plugins] refresh slash commands after remote plugin sync failed", {
      reason,
      workspaceIdentity,
      workspacePath,
      error: toMessage(error),
    });
  }
}

/**
 * The MCP store is a global singleton tracking a single current project: reload it only while it points at this workspace.
 * Bug cause: after a data-sync plugin push, ensureLoadedForWorkspace was called for every project open on the
 * device; it switched the store to the last refreshed project, clobbering the MCP list of the project the user
 * was viewing. Fix: do not switch the current project; workspaces that are not current pick up the new config
 * through the normal load on project switch.
 *
 * Bug cause: once the store's directory service is bound together with its target, passing the push-time
 * source-settings service here rebinds the current project to it, and subsequent reads/writes for that project
 * bypass the project's own service. Fix: only re-read the already-bound target, pass no service.
 */
export async function reloadMcpStoreIfCurrentWorkspace(params: {
  workspacePath: string;
  workspaceIdentity?: string | null;
}): Promise<void> {
  const { currentProjectPath, currentWorkspaceIdentity } = useMcpStore.getState();
  const workspaceIdentity = params.workspaceIdentity?.trim() || undefined;
  if (
    params.workspacePath !== currentProjectPath ||
    workspaceIdentity !== currentWorkspaceIdentity
  ) {
    return;
  }
  await useMcpStore.getState().loadMcpFromUserDirectory();
}

export async function refreshWorkspacePluginCapabilitiesAfterRemoteSync(params: {
  commandsService: ICommandsService;
  reason: string;
  skillsService: ISkillsService;
  workspaceIdentity?: string | null;
  workspacePath?: string | null;
  zcodeAgentService: IZCodeAgentService;
}): Promise<void> {
  const workspacePath = params.workspacePath;
  if (!workspacePath) {
    return;
  }
  const workspaceIdentity = params.workspaceIdentity?.trim() || null;
  const workspaceIdentityParam = workspaceIdentity ?? undefined;
  await invalidateDeferredDraftSessionForSkillChange({
    workspacePath,
    workspaceIdentity: workspaceIdentityParam,
    reason: params.reason,
  });
  await refreshSharedSkillStoreForWorkspace({
    workspacePath,
    workspaceIdentity: workspaceIdentityParam,
    skillsService: params.skillsService,
  });
  await refreshSlashCommandsAfterRemoteSync({
    commandsService: params.commandsService,
    reason: params.reason,
    workspacePath,
    workspaceIdentity,
  });
  await reloadMcpStoreIfCurrentWorkspace({
    workspacePath,
    workspaceIdentity,
  });
  // The sync entry may run with global settings unopened; notify all mounted projections with the real target.
  notifyPluginManagementChange({
    workspacePath,
    workspaceIdentity,
    authorityKey: null,
    scope: "user",
  });
}
