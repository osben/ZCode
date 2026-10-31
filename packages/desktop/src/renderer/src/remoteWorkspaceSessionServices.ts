import type { IHighspeedCardService, IServiceAccessor } from "@zcode/services";
import type { RemoteTarget } from "@zcode/shared";

/**
 * Highspeed cards and off-peak tasks take effect only locally (product decision 2026-10-21); remote workspaces must never route them to the remote side.
 *
 * Bug cause: since 3.16, remote workspaces of a recognized Source use the full remote service set, but the remote contract
 * has no highspeed-card / off-peak-task channels. Awaiting prepareTurn before a send waited for the Host ChannelServer's
 * 1000ms unknown-channel timeout; the off-peak notification poll also timed out every 30s.
 * Fix: inject a highspeed-card implementation that never draws, so sends go straight to the normal model; off-peak tasks
 * belong only to local projects and always use the local service.
 */
const remoteUnsupportedHighspeedCardService: IHighspeedCardService = {
  prepareTurn: async () => ({ kind: "fallback", reason: "unavailable", nextDrawAt: null }),
  getSnapshot: async () => ({ card: null, nextDrawAt: null, drawing: false }),
  invalidateCard: async () => false,
  healthy: async () => {
    throw new Error("highspeed.remote-unsupported");
  },
};

function withLocalOnlyAccountServices(
  baseServices: IServiceAccessor,
  services: IServiceAccessor,
): IServiceAccessor {
  return {
    ...services,
    highspeedCardService: remoteUnsupportedHighspeedCardService,
    offPeakTaskService: baseServices.offPeakTaskService,
  };
}

export function buildRemoteWorkspaceSessionServices(
  baseServices: IServiceAccessor,
  remoteServices: IServiceAccessor,
): IServiceAccessor {
  return withLocalOnlyAccountServices(baseServices, {
    ...baseServices,
    fileService: remoteServices.fileService,
    // Root cause: without this override, remote HTML would be validated against the local output root, so valid files were rejected as out of bounds.
    // File reads go through the execution host; useGenUi state and sandbox still come from the desktop base services.
    genUiService: remoteServices.genUiService,
    mediaPreviewService: remoteServices.mediaPreviewService,
    gitService: remoteServices.gitService,
    gitCheckpointService: remoteServices.gitCheckpointService,
    systemService: remoteServices.systemService,
    terminalService: remoteServices.terminalService,
    // Upload remote attachments through the current workspace host and rewrite their paths. Reusing the
    // local service would pass the desktop's absolute path to the CLI in SSH/WSL/Docker, where it cannot
    // read the attachment.
    promptAttachmentTransferService: remoteServices.promptAttachmentTransferService,
    // MCP/plugin status checks use the control-plane app-server through zcodeAgentService.
    // If an SSH remote reuses the local base service, it checks remote MCP config in the local app-server,
    // whose PATH/cwd are not from the remote environment. The UI then reports `spawn npx ENOENT` even
    // after synchronization.
    zcodeAgentService: remoteServices.zcodeAgentService,
    zcodeTaskService: remoteServices.zcodeTaskService,
    zcodeSessionService: remoteServices.zcodeSessionService,
    // Sharing uses the local login/API, but rows and files must be bound to the current remote connection scope.
    conversationShareService: remoteServices.conversationShareService,
    fileWatcherService: remoteServices.fileWatcherService,
    // Provider/model facts belong to the target Environment; do not fall back to local values because a
    // merge expanded baseServices first.
    modelSelectionService: remoteServices.modelSelectionService,
    providerSettingsService: remoteServices.providerSettingsService,
    // The skills/plugins/commands directories for SSH/Docker projects are on the remote filesystem.
    // Reusing local base services scanned the remote workspacePath on the local machine, making project
    // capabilities unavailable.
    skillsService: remoteServices.skillsService,
    // Previews must read definitions from the same host that discovered them.
    definitionPreviewService: remoteServices.definitionPreviewService,
    // Imports for remote skill synchronization must be written to ~/.zcode/skills on the SSH host.
    // Reusing the base service would make the UI report success while writing to the local user's directory.
    skillSyncService: remoteServices.skillSyncService,
    // Imports for remote MCP synchronization must be written to ~/.zcode/cli/config.json on the SSH host.
    // Use the remote service, as skillSyncService does, to avoid writing remote config to the local user's directory.
    mcpSyncService: remoteServices.mcpSyncService,
    // Remote plugin synchronization writes to ~/.zcode/plugins and plugins.dirs on the SSH host.
    // Use the remote service as with skills/MCP instead of the local base service.
    pluginSyncService: remoteServices.pluginSyncService,
    // Syncing subagents / commands / hooks writes to the remote user directory, so it likewise must not reuse the local base service.
    userConfigSyncService: remoteServices.userConfigSyncService,
    pluginsService: remoteServices.pluginsService,
    // Plugin management in Settings must use the remote service as well; the plugin directory is on the remote filesystem.
    pluginManagementService: remoteServices.pluginManagementService,
    commandsService: remoteServices.commandsService,
    // Hook declarations, trust state, and pending reviews for SSH/Docker workspaces are on the remote
    // filesystem. hooksService must override the local service in baseServices; otherwise it scans a
    // remote path on the local filesystem and cannot read pending remote hooks.
    // Hook reads/writes (loadHooks/saveHooks) and grantWorkspaceHookTrust must all go to the remote host.
    hooksService: remoteServices.hooksService,
    // The global-instructions editor reads and writes ~/.zcode/AGENTS.md on the target host.
    // Without this override, a remote workspace silently edits the same-named file on the desktop machine.
    userInstructionsService: remoteServices.userInstructionsService,
    // Output styles live in ~/.zcode/output-styles on the target host, next to AGENTS.md;
    // the same override is required so a remote workspace does not edit desktop-local styles.
    outputStyleService: remoteServices.outputStyleService,
    // System-prompt overrides live in ~/.zcode/system-prompt on the target host; without this
    // override a remote workspace would silently edit the desktop machine's override files.
    systemPromptService: remoteServices.systemPromptService,
  });
}

export function buildServerRemoteWorkspaceSessionServices(
  baseServices: IServiceAccessor,
  remoteServices: IServiceAccessor,
): IServiceAccessor {
  // A server remote connects to a fully running ZCode server; state such as
  // workspace/runtime/model-provider is owned by the server, and the local renderer keeps only
  // window and UI shell state.
  return withLocalOnlyAccountServices(baseServices, remoteServices);
}

export function buildRemoteWorkspaceSessionServicesForRegistration(params: {
  baseServices: IServiceAccessor;
  remoteServices: IServiceAccessor;
  targetKind: RemoteTarget["kind"];
  sourceServerId?: string;
}): IServiceAccessor {
  // Bug cause: a Source Server can be reached through an SSH/WSL/Docker transport, while target.kind still describes
  // the transport rather than service authority. After the Host injects sourceServerId, the full remote service set must
  // be used; only a legacy attachment not yet recognized as a Source keeps the desktop-attached mixed services.
  return params.targetKind === "server" || params.sourceServerId?.trim()
    ? buildServerRemoteWorkspaceSessionServices(params.baseServices, params.remoteServices)
    : buildRemoteWorkspaceSessionServices(params.baseServices, params.remoteServices);
}
