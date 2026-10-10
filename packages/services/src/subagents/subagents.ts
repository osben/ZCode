import type {
  ZCodeProvider,
  AgentSummary,
  AgentsListResult,
  AgentCreateParams,
  AgentUpdateParams,
  AgentDeleteParams,
  BuiltInSubagentModelOverrideParams,
  PluginSubagentModelOverrideParams,
  SubagentsListMode,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISubagentsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    mode?: SubagentsListMode;
  }): Promise<AgentsListResult>;

  setEnabled(params: { agentId: string; enabled: boolean }): Promise<void>;

  setBuiltInModelOverride(params: BuiltInSubagentModelOverrideParams): Promise<void>;

  /** Fully replace only the user state; do not modify plugin Markdown. */
  setPluginAgentModelOverride(params: PluginSubagentModelOverrideParams): Promise<void>;

  /** User-level agent root for the current source filter (matches built-in scan order: first entry from buildUserRoots). */
  getPrimaryUserAgentsDirectory(params: { provider: ZCodeProvider }): Promise<{ path: string }>;

  /** Create a new agent file. */
  createAgent(params: AgentCreateParams): Promise<{ agent: AgentSummary }>;

  /** Update an existing agent file. */
  updateAgent(params: AgentUpdateParams): Promise<{ agent: AgentSummary }>;

  /** Delete an agent file. */
  deleteAgent(params: AgentDeleteParams): Promise<void>;
}

export const ISubagentsService = createServiceDescriptor<ISubagentsService>(
  ServiceChannels.Subagents,
);
