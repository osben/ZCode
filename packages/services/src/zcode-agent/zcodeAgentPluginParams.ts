import type {
  ModelSelection,
  ZCodeAgentMcpServer,
  ZCodeAutomationScheduleRule,
  ZCodeMcpListMode,
} from "@zcode/shared";
import type { McpAppsAppToolCallResult, McpAppsAppToolDescriptor } from "@zcode/shared/mcp-apps";

export interface ZCodeAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Runtime session identity for a remote workspace; used only for isolation/routing and cannot replace workspacePath. */
  remoteSessionId?: string;
}

export interface ZCodeAgentPluginViewParams extends ZCodeAgentWorkspaceTarget {
  configScope?: "user" | "workspace";
}

export interface ZCodeAgentListMcpServerStatusesParams extends ZCodeAgentWorkspaceTarget {
  mcpServers?: ZCodeAgentMcpServer[];
  mode?: ZCodeMcpListMode;
}

export interface ZCodeAgentAddPluginMarketplaceParams extends ZCodeAgentWorkspaceTarget {
  dryRun?: boolean;
  operationId?: string;
  source: string;
}

export interface ZCodeAgentRemovePluginMarketplaceParams extends ZCodeAgentWorkspaceTarget {
  marketplace: string;
}

export interface ZCodeAgentUpdatePluginMarketplaceParams extends ZCodeAgentWorkspaceTarget {
  marketplace?: string;
  operationId?: string;
}

export interface ZCodeAgentInstallPluginParams extends ZCodeAgentWorkspaceTarget {
  dryRun?: boolean;
  marketplace: string;
  operationId?: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface ZCodeAgentCancelPluginOperationParams {
  operationId: string;
}

export interface ZCodeAgentUninstallPluginParams extends ZCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginId?: string;
  pluginName?: string;
  removeCache?: boolean;
}

export interface ZCodeAgentUpdatePluginParams extends ZCodeAgentWorkspaceTarget {
  pluginId?: string;
  marketplace?: string;
}

export interface ZCodeAgentRestoreBuiltinPluginParams extends ZCodeAgentWorkspaceTarget {
  pluginId: string;
}

export interface ZCodeAgentConfigurePluginParams extends ZCodeAgentWorkspaceTarget {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ZCodeAgentResetPluginConfigParams extends ZCodeAgentWorkspaceTarget {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ZCodeAgentValidatePluginParams extends ZCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface ZCodeAgentDescribePluginParams extends ZCodeAgentWorkspaceTarget {
  marketplace: string;
  pluginName: string;
}

export interface ZCodeAgentSetPluginEnabledParams extends ZCodeAgentWorkspaceTarget {
  enabled: boolean;
  operationId?: string;
  pluginId: string;
  scope?: "user" | "workspace";
}

// Plugin conversation reference catalog:
// with sessionId → session-owned frozen catalog (must route to the workspace client that owns the session);
// without it → current workspace catalog (new draft Picker).
export interface ZCodeAgentPluginReferenceCatalogParams extends ZCodeAgentWorkspaceTarget {
  sessionId?: string;
}

// Composer Skill catalog: like Plugin references, sessionId distinguishes the current workspace directory from
// the resident Session runtime snapshot; it does not use the directory managed by Settings.
export interface ZCodeAgentSkillReferenceCatalogParams extends ZCodeAgentWorkspaceTarget {
  sessionId?: string;
}

/** Plugin UI: a `ui://` resource read initiated by the UI. */
export interface ZCodeAgentReadMcpResourceParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  uri: string;
}

/** `resources/read` initiated from a plugin UI page; parameters mirror readMcpResource, and results are bounded by the 8 MiB limit and the mimeType allowlist. */
export type ZCodeAgentReadMcpResourceForUiParams = ZCodeAgentReadMcpResourceParams;

/** Plugin UI: the UI calls back into this plugin's tools; no approval flow, and ownership fails closed via the agent-side catalog. */
export interface ZCodeAgentCallMcpToolForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  /** Host-generated call id, paired with cancelMcpToolCallForUi. */
  callId: string;
}
/** resources/list, resources/templates/list, subscribe, and unsubscribe initiated from a plugin UI page. */
export interface ZCodeAgentListMcpResourcesForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  cursor?: string;
}
/** App-Provided Tools: instance identity = session + sandbox scope + generation. */
export interface ZCodeAgentAppToolInstanceForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  generation: number;
}
export interface ZCodeAgentRegisterAppToolsForUiParams extends ZCodeAgentAppToolInstanceForUiParams {
  tools: McpAppsAppToolDescriptor[];
}
export interface ZCodeAgentAppToolCallForUiParams extends ZCodeAgentAppToolInstanceForUiParams {
  callId: string;
}
export interface ZCodeAgentResolveAppToolCallForUiParams extends ZCodeAgentAppToolCallForUiParams {
  result?: McpAppsAppToolCallResult;
  error?: { message: string };
}
export interface ZCodeAgentMcpResourceSubscriptionForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  generation: number;
  uri: string;
}
export interface ZCodeAgentCancelMcpToolCallForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  callId: string;
}
export interface ZCodeAgentResolveSuggestedPluginReferenceParams extends ZCodeAgentWorkspaceTarget {
  stableId: string;
  operationId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryKind: "desktop-continuous" | "web-remote-replayable";
}

// ---- Scheduled task (automation) management parameters ----

export interface ZCodeAgentCreateAutomationParams extends ZCodeAgentWorkspaceTarget {
  title: string;
  cronExpr: string;
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
}

export interface ZCodeAgentUpdateAutomationParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

export interface ZCodeAgentAutomationIdParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
}

export interface ZCodeAgentSetAutomationEnabledParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
  enabled: boolean;
}

export interface ZCodeAgentDeleteAutomationRunParams extends ZCodeAgentWorkspaceTarget {
  runId: string;
}
