import { ServiceChannels } from "@zcode/shared";
import type { McpAppsAppToolCallResult, McpAppsAppToolDescriptor } from "@zcode/shared/mcp-apps";
import { createServiceDescriptor } from "../descriptors.js";
import type { PluginUiPluginScope } from "./contract.js";

/**
 * Renderer → agent channel for App-Provided Tools. Page instance identity = session + sandbox scope + generation
 * (the same triple as resource subscriptions). Registration replaces the instance as a whole; model calls reach the
 * renderer through the instance mailbox (`pluginUi.appToolCall` live deltas), and claim/return is idempotent by callId.
 * The registry, exposed set, and pending calls are owned solely by the agent; this service holds no state.
 */
export interface PluginUiAppToolInstanceParams extends PluginUiPluginScope {
  scopeId: string;
  generation: number;
}
export interface PluginUiRegisterAppToolsParams extends PluginUiAppToolInstanceParams {
  tools: McpAppsAppToolDescriptor[];
}
export interface PluginUiRegisterAppToolsResult {
  tools: Array<{ name: string; modelName: string }>;
}
export interface PluginUiAppToolCallParams extends PluginUiAppToolInstanceParams {
  callId: string;
}
export interface PluginUiResolveAppToolCallParams extends PluginUiAppToolCallParams {
  result?: McpAppsAppToolCallResult;
  error?: { message: string };
}
export interface PluginUiAppToolAcceptedResult {
  accepted: boolean;
}

export interface IPluginUiAppToolsService {
  /** The page's `tools/list` result wholesale-replaces this instance's registration; returns the names actually exposed to the model. Throws unavailable when dependencies are missing (web / remote). */
  registerAppTools(params: PluginUiRegisterAppToolsParams): Promise<PluginUiRegisterAppToolsResult>;
  /** Unregisters on instance teardown; returns `{ removed: 0 }` when there is no agent or the session is closed. */
  unregisterAppTools(params: PluginUiAppToolInstanceParams): Promise<{ removed: number }>;
  /** Claims a pending call from the mailbox; only the first claim succeeds, after which tools/call is sent to the page. */
  claimAppToolCall(params: PluginUiAppToolCallParams): Promise<PluginUiAppToolAcceptedResult>;
  /** Returns the page's result or error; unclaimed or already-finished calls get `{ accepted: false }`. */
  resolveAppToolCall(
    params: PluginUiResolveAppToolCallParams,
  ): Promise<PluginUiAppToolAcceptedResult>;
}

export const IPluginUiAppToolsService = createServiceDescriptor<IPluginUiAppToolsService>(
  ServiceChannels.PluginUiAppTools,
);
