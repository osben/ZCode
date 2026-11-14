// Thin service implementation for plugin management in Settings—the only host-side consumer of legacy plugins/* protocol terms.
// The zcode-cli process is the source of truth for plugin installation, marketplace, and enablement (it reads/writes the ~/.zcode plugin directory and hot-updates
// runtime state). The host has no copy, so this implementation keeps the agent protocol round trip. Its purpose is to stop the UI from calling
// IZCodeAgentService directly and centralize consumption of these terms in this file.
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IPluginManagementService } from "./pluginManagement.js";

/** 插件管理变更成功的信号（Window Host 侧）。action 与遥测的动作名相同。 */
export interface PluginMutationSucceededEvent {
  /** install、uninstall、update、restore、configure、reset_config、enable、disable、source_* 等。 */
  action: string;
  pluginId?: string;
  scope?: "user" | "workspace";
}

export interface PluginManagementServiceDependencies {
  /**
   * Window Host signal that the plugin manifest changed: called after a successful install, uninstall, enable/disable, or configuration change.
   * The extension process re-reads the plugin manifest on this signal (docs/plugins/extension-host.md §3.4, §13); configuration and reset also notify the plugin's
   * settings.onDidChange (§16.7). dryRun does not trigger it.
   */
  onMutationSucceeded?: (event: PluginMutationSucceededEvent) => void;
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
  type MutationObservation = {
    telemetry?: import("../zcode-agent/zcodeAgentPluginParams.js").ZCodePluginMutationTelemetry;
    pluginId?: string;
    marketplace?: string;
    scope?: "user" | "workspace";
    dryRun?: boolean;
  };
  type Result = {
    diagnostics?: Array<{ severity?: string; code?: string }>;
    installedPlugins?: Array<{
      id: string;
      marketplace: string;
      version?: string;
      scope: string;
      listing?: { publisherType?: string };
    }>;
    removedPlugin?: { id: string; marketplace: string; version?: string };
    pluginId?: string;
    marketplaces?: unknown[];
    marketplace?: { id: string };
    plugin?: { id: string; marketplace: string; source: string; version?: string };
  };
  // Host-only telemetry was removed in the fork; only the mutation notification remains. A notifier failure never changes a successful result.
  const observe = async <P extends MutationObservation, T extends Result>(
    action: string,
    params: P,
    invoke: (clean: P) => Promise<T>,
  ): Promise<T> => {
    const result = await invoke(withoutTelemetry(params));
    if (!params.dryRun) {
      try {
        dependencies.onMutationSucceeded?.({
          action,
          ...(params.pluginId ? { pluginId: params.pluginId } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
        });
      } catch {
        /* The observer records its own errors. */
      }
    }
    return result;
  };
  return {
    listPlugins: (params) => agent.listPlugins(params),
    getPluginReferenceCatalog: (params) => agent.getPluginReferenceCatalog(params),
    resolveSuggestedPluginReference: (params) => agent.resolveSuggestedPluginReference(params),
    onDynamicPluginOperationProgress: (operationId) =>
      agent.onDynamicPluginOperationProgress(operationId),
    getPluginsOverview: (params) => agent.getPluginsOverview(params),
    addPluginMarketplace: (params) =>
      observe("source_add", params, (clean) => agent.addPluginMarketplace(clean)),
    removePluginMarketplace: (params) =>
      observe("source_remove", params, (clean) => agent.removePluginMarketplace(clean)),
    updatePluginMarketplace: (params) =>
      observe("source_update", params, (clean) => agent.updatePluginMarketplace(clean)),
    installPlugin: (params) => observe("install", params, (clean) => agent.installPlugin(clean)),
    cancelPluginOperation: (params) => agent.cancelPluginOperation(params),
    uninstallPlugin: (params) =>
      observe("uninstall", params, (clean) => agent.uninstallPlugin(clean)),
    updatePlugin: (params) => observe("update", params, (clean) => agent.updatePlugin(clean)),
    restoreBuiltinPlugin: (params) =>
      observe("restore", params, (clean) => agent.restoreBuiltinPlugin(clean)),
    configurePlugin: (params) =>
      observe("configure", params, (clean) => agent.configurePlugin(clean)),
    resetPluginConfig: (params) =>
      observe("reset_config", params, (clean) => agent.resetPluginConfig(clean)),
    validatePlugin: (params) => agent.validatePlugin(params),
    describePlugin: (params) => agent.describePlugin(params),
    setPluginEnabled: (params) =>
      observe(params.enabled ? "enable" : "disable", params, (clean) =>
        agent.setPluginEnabled(clean),
      ),
    getLspPreferences: (params) => agent.getLspPreferences(params),
    setLspPreferences: (params) => agent.setLspPreferences(params),
    getLspStatus: (params) => agent.getLspStatus(params),
  };
}
