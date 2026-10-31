import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  McpDataSyncPayload,
  SaveCliMcpToUserDirectoryRequest,
  ZCodeAgentMcpServer,
  ZCodeMcpListMode,
  ZCodeMcpListResult,
  WorkspaceMcpTrustDecision,
  ZCodeWorkspaceMcpTrustResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { IDataSyncCategoryService } from "../data-sync/contract.js";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * MCP channel: settings-page config read/write + data sync (IDataSyncCategoryService, docs/remote/data-sync.md "MCP servers").
 */
export interface IMcpSyncService extends IDataSyncCategoryService<McpDataSyncPayload> {
  loadMcpFromUserDirectory(
    request?: LoadCliMcpFromUserDirectoryRequest,
  ): Promise<LoadCliMcpFromUserDirectoryResult>;
  /**
   * List runtime states for workspace MCP servers (formerly UI called
   * zcodeAgentService's mcp/list directly). Actual connect/listTools checks must run in the agent process (where PATH/cwd
   * reflect the workspace environment). This service is only the UI injection point; it centralizes host consumption of mcp/list.
   */
  listWorkspaceMcpServerStatuses(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    mcpServers?: ZCodeAgentMcpServer[];
    mode?: ZCodeMcpListMode;
  }): Promise<ZCodeMcpListResult>;
  setWorkspaceMcpTrust?(params: WorkspaceMcpTrustDecision): Promise<ZCodeWorkspaceMcpTrustResult>;
  saveMcpToUserDirectory(payload: SaveCliMcpToUserDirectoryRequest): Promise<void>;
}

export const IMcpSyncService = createServiceDescriptor<IMcpSyncService>(ServiceChannels.McpSync);
