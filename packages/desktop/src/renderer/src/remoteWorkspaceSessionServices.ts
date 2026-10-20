import type { IServiceAccessor } from "@zcode/services";
import type { RemoteTarget } from "@zcode/shared";

export function buildRemoteWorkspaceSessionServices(
  baseServices: IServiceAccessor,
  remoteServices: IServiceAccessor,
): IServiceAccessor {
  return {
    ...baseServices,
    fileService: remoteServices.fileService,
    // 根因：遗漏此覆盖会用本机输出根目录校验远端 HTML，合法文件也被判越界。
    // 文件读取走执行端；useGenUi 的状态与沙箱仍取 desktop base services。
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
    // Imports for remote skill synchronization must be written to ~/.zcode/skills on the SSH host.
    // Reusing the base service would make the UI report success while writing to the local user's directory.
    skillSyncService: remoteServices.skillSyncService,
    // Imports for remote MCP synchronization must be written to ~/.zcode/cli/config.json on the SSH host.
    // Use the remote service, as skillSyncService does, to avoid writing remote config to the local user's directory.
    mcpSyncService: remoteServices.mcpSyncService,
    // Remote plugin synchronization writes to ~/.zcode/plugins and plugins.dirs on the SSH host.
    // Use the remote service as with skills/MCP instead of the local base service.
    pluginSyncService: remoteServices.pluginSyncService,
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
  };
}

export function buildServerRemoteWorkspaceSessionServices(
  _baseServices: IServiceAccessor,
  remoteServices: IServiceAccessor,
): IServiceAccessor {
  // A server remote connects to a fully running ZCode server; state such as
  // workspace/runtime/model-provider is owned by the server, and the local renderer keeps only
  // window and UI shell state.
  return remoteServices;
}

export function buildRemoteWorkspaceSessionServicesForRegistration(params: {
  baseServices: IServiceAccessor;
  remoteServices: IServiceAccessor;
  targetKind: RemoteTarget["kind"];
  sourceServerId?: string;
}): IServiceAccessor {
  // Bug 根因：Source Server 可以通过 SSH/WSL/Docker transport 到达，target.kind 仍描述
  // 线路而不是服务权威。Host 注入 sourceServerId 后必须使用完整远端服务集合；只有尚未
  // 识别为 Source 的 legacy attachment 才保留 desktop-attached mixed services。
  return params.targetKind === "server" || params.sourceServerId?.trim()
    ? buildServerRemoteWorkspaceSessionServices(params.baseServices, params.remoteServices)
    : buildRemoteWorkspaceSessionServices(params.baseServices, params.remoteServices);
}
