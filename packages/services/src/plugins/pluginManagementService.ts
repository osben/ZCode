// Thin service implementation for plugin management in Settings—the only host-side consumer of legacy plugins/* protocol terms.
// The zcode-cli process is the source of truth for plugin installation, marketplace, and enablement (it reads/writes the ~/.zcode plugin directory and hot-updates
// runtime state). The host has no copy, so this implementation keeps the agent protocol round trip. Its purpose is to stop the UI from calling
// IZCodeAgentService directly and centralize consumption of these terms in this file.
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IPluginManagementService } from "./pluginManagement.js";

export interface PluginManagementServiceDependencies {
  zcodeAgentService: Pick<
    IZCodeAgentService,
    | "listPlugins"
    | "getPluginReferenceCatalog"
    | "resolveSuggestedPluginReference"
    | "onDynamicPluginOperationProgress"
    | "getPluginsOverview"
    | "addPluginMarketplace"
    | "removePluginMarketplace"
    | "updatePluginMarketplace"
    | "installPlugin"
    | "cancelPluginOperation"
    | "uninstallPlugin"
    | "updatePlugin"
    | "restoreBuiltinPlugin"
    | "configurePlugin"
    | "resetPluginConfig"
    | "validatePlugin"
    | "describePlugin"
    | "setPluginEnabled"
    | "getLspPreferences"
    | "setLspPreferences"
    | "getLspStatus"
  >;
}

// Host-only telemetry (withPluginTelemetry) must not reach the CLI. Returns the same object when no telemetry is attached.
function withoutTelemetry<T extends object>(params: T): T {
  if (!("telemetry" in params)) return params;
  const { telemetry: _telemetry, ...rest } = params as T & { telemetry?: unknown };
  return rest as T;
}

export function createPluginManagementService(
  dependencies: PluginManagementServiceDependencies,
): IPluginManagementService {
  const agent = dependencies.zcodeAgentService;
  return {
    listPlugins: (params) => agent.listPlugins(params),
    getPluginReferenceCatalog: (params) => agent.getPluginReferenceCatalog(params),
    resolveSuggestedPluginReference: (params) => agent.resolveSuggestedPluginReference(params),
    onDynamicPluginOperationProgress: (operationId) =>
      agent.onDynamicPluginOperationProgress(operationId),
    getPluginsOverview: (params) => agent.getPluginsOverview(params),
    addPluginMarketplace: (params) => agent.addPluginMarketplace(withoutTelemetry(params)),
    removePluginMarketplace: (params) => agent.removePluginMarketplace(withoutTelemetry(params)),
    updatePluginMarketplace: (params) => agent.updatePluginMarketplace(withoutTelemetry(params)),
    installPlugin: (params) => agent.installPlugin(withoutTelemetry(params)),
    cancelPluginOperation: (params) => agent.cancelPluginOperation(params),
    uninstallPlugin: (params) => agent.uninstallPlugin(withoutTelemetry(params)),
    updatePlugin: (params) => agent.updatePlugin(withoutTelemetry(params)),
    restoreBuiltinPlugin: (params) => agent.restoreBuiltinPlugin(withoutTelemetry(params)),
    configurePlugin: (params) => agent.configurePlugin(withoutTelemetry(params)),
    resetPluginConfig: (params) => agent.resetPluginConfig(withoutTelemetry(params)),
    validatePlugin: (params) => agent.validatePlugin(params),
    describePlugin: (params) => agent.describePlugin(params),
    setPluginEnabled: (params) => agent.setPluginEnabled(withoutTelemetry(params)),
    getLspPreferences: (params) => agent.getLspPreferences(params),
    setLspPreferences: (params) => agent.setLspPreferences(params),
    getLspStatus: (params) => agent.getLspStatus(params),
  };
}
