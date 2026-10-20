// Consolidated platform capability surface: thin service interface for Plugin Management in Settings.
//
// Background: pluginManagementStore / usePluginUninstall used to inject IZCodeAgentService directly,
// leaving 13 consumers of legacy plugins/* protocol terms scattered across the UI. With a separate thin service, the UI depends only on
// this interface; host-side consumption of plugins/* terms is centralized in pluginManagementService (the plugin source of truth
// remains in the zcode-cli process, and the service implementation still makes an agent protocol round trip. Consolidating the plugins vocabulary belongs to
// the evolution of the plugin capability surface, not the session v4 vocabulary).
// Distinguish this from the existing IPluginsService (the retired marketplace pluginStore channel):
// that interface is addressed by pluginName+marketplace and has outdated method semantics, so it is not reused to avoid signature conflicts.
import type { Event } from "@zcode/rpc";
import type {
  ZCodePluginOperationProgressNotification,
  ZCodePluginsConfigureResult,
  ZCodePluginsCancelOperationResult,
  ZCodePluginsDescribeResult,
  ZCodePluginsInstallResult,
  ZCodePluginsListResult,
  ZCodePluginsMarketplaceMutationResult,
  ZCodePluginsOverviewResult,
  ZCodePluginsReferenceCatalogResult,
  ZCodePluginsRestoreBuiltinResult,
  ZCodePluginsSetEnabledResult,
  ZCodeLspPreferences,
  ZCodeLspStatusResult,
  ZCodePluginsUninstallResult,
  ZCodePluginsValidateResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  ZCodeAgentAddPluginMarketplaceParams,
  ZCodeAgentConfigurePluginParams,
  ZCodeAgentCancelPluginOperationParams,
  ZCodeAgentDescribePluginParams,
  ZCodeAgentInstallPluginParams,
  ZCodeAgentPluginReferenceCatalogParams,
  ZCodeAgentResolveSuggestedPluginReferenceParams,
  ZCodeAgentResetPluginConfigParams,
  ZCodeAgentPluginViewParams,
  ZCodeAgentSetLspPreferencesParams,
  ZCodeAgentRemovePluginMarketplaceParams,
  ZCodeAgentRestoreBuiltinPluginParams,
  ZCodeAgentSetPluginEnabledParams,
  ZCodeAgentUninstallPluginParams,
  ZCodeAgentUpdatePluginMarketplaceParams,
  ZCodeAgentUpdatePluginParams,
  ZCodeAgentValidatePluginParams,
} from "../zcode-agent/zcodeAgentPluginParams.js";

export interface IPluginManagementService {
  listPlugins(params: ZCodeAgentPluginViewParams): Promise<ZCodePluginsListResult>;
  /**
   * Plugin conversation reference catalog:
   * with sessionId → session-owned frozen catalog; without it → the current workspace catalog.
   * The implementation routes to the workspace-level agent client, not the separate plugin management process.
   */
  getPluginReferenceCatalog(
    params: ZCodeAgentPluginReferenceCatalogParams,
  ): Promise<ZCodePluginsReferenceCatalogResult>;
  resolveSuggestedPluginReference(
    params: ZCodeAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@zcode/shared").ZCodePluginsResolveSuggestedReferenceResult>;
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<ZCodePluginOperationProgressNotification>;
  getPluginsOverview(params: ZCodeAgentPluginViewParams): Promise<ZCodePluginsOverviewResult>;
  addPluginMarketplace(
    params: ZCodeAgentAddPluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: ZCodeAgentRemovePluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: ZCodeAgentUpdatePluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  installPlugin(params: ZCodeAgentInstallPluginParams): Promise<ZCodePluginsInstallResult>;
  cancelPluginOperation(
    params: ZCodeAgentCancelPluginOperationParams,
  ): Promise<ZCodePluginsCancelOperationResult>;
  uninstallPlugin(params: ZCodeAgentUninstallPluginParams): Promise<ZCodePluginsUninstallResult>;
  updatePlugin(params: ZCodeAgentUpdatePluginParams): Promise<ZCodePluginsInstallResult>;
  restoreBuiltinPlugin(
    params: ZCodeAgentRestoreBuiltinPluginParams,
  ): Promise<ZCodePluginsRestoreBuiltinResult>;
  configurePlugin(params: ZCodeAgentConfigurePluginParams): Promise<ZCodePluginsConfigureResult>;
  resetPluginConfig(
    params: ZCodeAgentResetPluginConfigParams,
  ): Promise<ZCodePluginsConfigureResult>;
  validatePlugin(params: ZCodeAgentValidatePluginParams): Promise<ZCodePluginsValidateResult>;
  describePlugin(params: ZCodeAgentDescribePluginParams): Promise<ZCodePluginsDescribeResult>;
  setPluginEnabled(params: ZCodeAgentSetPluginEnabledParams): Promise<ZCodePluginsSetEnabledResult>;
  /** Code intelligence (LSP) global toggle and per-server diagnostics overrides, owned by the CLI runtime. */
  getLspPreferences(params: ZCodeAgentPluginViewParams): Promise<ZCodeLspPreferences>;
  setLspPreferences(params: ZCodeAgentSetLspPreferencesParams): Promise<ZCodeLspPreferences>;
  getLspStatus(params: ZCodeAgentPluginViewParams): Promise<ZCodeLspStatusResult>;
}

export const IPluginManagementService = createServiceDescriptor<IPluginManagementService>(
  ServiceChannels.PluginManagement,
);

/**
 * Attaches observation-only context to plugin mutations. The telemetry object is Host-only:
 * pluginManagementService removes it before calling the agent, so it never reaches the CLI.
 * RPC methods are provided by a Proxy; do not copy them with object spread.
 */
export function withPluginTelemetry(
  service: IPluginManagementService,
  telemetry: NonNullable<ZCodeAgentInstallPluginParams["telemetry"]>,
): IPluginManagementService {
  const mutations = new Set<PropertyKey>([
    "addPluginMarketplace",
    "removePluginMarketplace",
    "updatePluginMarketplace",
    "installPlugin",
    "uninstallPlugin",
    "updatePlugin",
    "restoreBuiltinPlugin",
    "configurePlugin",
    "resetPluginConfig",
    "setPluginEnabled",
  ]);
  return new Proxy(service, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      if (!mutations.has(property)) return method.bind(target);
      return (params: ZCodeAgentInstallPluginParams) =>
        method.call(target, { ...params, telemetry });
    },
  });
}
