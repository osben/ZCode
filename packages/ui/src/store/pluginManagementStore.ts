import { create } from "zustand";
import type {
  ZCodeAvailablePluginSummary,
  ZCodeInstalledPluginSummary,
  ZCodePluginDiagnostic,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
  ZCodePluginScope,
  ZCodePluginsDescribeResult,
} from "@zcode/shared";
import type { IPluginManagementService } from "@zcode/services";
import { logger } from "@/logger.js";
import { loadInto, runWorkspaceOperation } from "@/store/pluginManagementStoreLoading.js";
import { setPluginEnabledOptimistically } from "@/store/pluginManagementStoreEnabled.js";

// On-demand cache for component lists in marketplace details: stores loading/data/error by pluginId to avoid duplicate requests and flicker while switching.
export interface PluginDescribeEntry {
  status: "loading" | "loaded" | "error";
  data?: ZCodePluginsDescribeResult;
  error?: string;
}

// Data source for Settings "Plugin management": provided by zcode-cli through the IPluginManagementService facade (list + enable/disable).
// The UI no longer calls IZCodeAgentService directly; consumption of legacy plugins/* protocol terms is centralized in the service implementation.
// Unrelated to the retired marketplace pluginStore, so this uses a separate, minimal store.
export interface PluginManagementState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  configScope: ZCodePluginScope | null;
  plugins: ZCodePluginInfo[];
  marketplaces: ZCodePluginMarketplaceSummary[];
  /** Whether the most recent overview succeeded; false means source existence is unknown and does not imply an orphaned state. */
  marketplaceAvailabilityKnown: boolean;
  availablePlugins: ZCodeAvailablePluginSummary[];
  installedPlugins: ZCodeInstalledPluginSummary[];
  restorableBuiltins: ZCodeAvailablePluginSummary[];
  diagnostics: ZCodePluginDiagnostic[];
  loading: boolean;
  error: string | null;
  /**
   * Plugin associated with the most recent failed operation: operations with a pluginId (such as setEnabled) write that
   * id on failure; operations without a plugin target (marketplace add/update/validate, list loading, refresh) write null.
   * Consumers (such as CUA input buttons) should treat an error as their own only when "the target is this plugin," so the shared
   * error field does not incorrectly map an unrelated failure to their own error state.
   */
  lastFailedPluginId: string | null;
  togglingPluginId: string | null;
  operationId: string | null;
  operationVersion: number;
  describeCache: Record<string, PluginDescribeEntry>;
  initialize: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    configScope?: ZCodePluginScope;
    pluginService: IPluginManagementService;
  }) => Promise<void>;
  refresh: (pluginService: IPluginManagementService) => Promise<void>;
  addMarketplace: (source: string, pluginService: IPluginManagementService) => Promise<boolean>;
  updateMarketplace: (
    marketplace: string | null,
    pluginService: IPluginManagementService,
  ) => Promise<boolean>;
  removeMarketplace: (
    marketplace: string,
    pluginService: IPluginManagementService,
  ) => Promise<void>;
  installPlugin: (
    pluginName: string,
    marketplace: string,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<void>;
  uninstallPlugin: (
    pluginId: string,
    pluginService: IPluginManagementService,
    removeCache?: boolean,
  ) => Promise<void>;
  updatePlugin: (pluginId: string, pluginService: IPluginManagementService) => Promise<void>;
  restoreBuiltin: (pluginId: string, pluginService: IPluginManagementService) => Promise<void>;
  configurePlugin: (
    pluginId: string,
    options: Record<string, string | number | boolean>,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
    clearOptionKeys?: string[],
  ) => Promise<boolean>;
  resetPluginConfig: (
    pluginId: string,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<boolean>;
  validateSource: (source: string, pluginService: IPluginManagementService) => Promise<void>;
  setEnabled: (
    pluginId: string,
    enabled: boolean,
    pluginService: IPluginManagementService,
    scope?: ZCodePluginScope,
  ) => Promise<boolean>;
  // Fetches a plugin component list (name + description) on demand; force bypasses the cache for a retry.
  describePlugin: (
    pluginId: string,
    pluginName: string,
    marketplace: string,
    pluginService: IPluginManagementService,
    force?: boolean,
  ) => Promise<void>;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwForErrorDiagnostic(diagnostics: ZCodePluginDiagnostic[]): void {
  const blockingDiagnostic = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (blockingDiagnostic) {
    throw new Error(blockingDiagnostic.message);
  }
}

export const usePluginManagementStore = create<PluginManagementState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  configScope: null,
  plugins: [],
  marketplaces: [],
  marketplaceAvailabilityKnown: false,
  availablePlugins: [],
  installedPlugins: [],
  restorableBuiltins: [],
  diagnostics: [],
  loading: false,
  error: null,
  lastFailedPluginId: null,
  togglingPluginId: null,
  operationId: null,
  operationVersion: 0,
  describeCache: {},

  async initialize({ workspacePath, workspaceIdentity, configScope, pluginService }) {
    const normalizedIdentity = workspaceIdentity?.trim() || null;
    const normalizedConfigScope = configScope ?? null;
    const current = get();
    const contextChanged =
      current.workspacePath !== workspacePath ||
      current.workspaceIdentity !== normalizedIdentity ||
      current.configScope !== normalizedConfigScope;
    const hasCache =
      current.plugins.length > 0 &&
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === normalizedIdentity &&
      current.configScope === normalizedConfigScope;
    set({
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      configScope: normalizedConfigScope,
      // When cached data exists, refresh in the background and preserve the list to avoid flicker on workspace switches; show blocking loading only without a cache.
      loading: !hasCache,
      marketplaceAvailabilityKnown: hasCache ? current.marketplaceAvailabilityKnown : false,
      error: null,
      lastFailedPluginId: null,
      // The overview refresh after saving config may still be running after the user has switched to another configuration view;
      // an operationId from the old view must not keep the new view's input controls disabled. When the old operation finishes, a version check prevents it from
      // accidentally clearing a same-named operation later started by the new view.
      ...(contextChanged ? { operationId: null } : {}),
    });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      configScope: normalizedConfigScope,
      pluginService,
    });
  },

  async refresh(pluginService) {
    const { workspacePath, workspaceIdentity, configScope } = get();
    if (!workspacePath) {
      return;
    }
    set({ error: null, lastFailedPluginId: null });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      configScope,
      pluginService,
    });
  },

  async addMarketplace(source, pluginService) {
    return runWorkspaceOperation(
      set,
      get,
      pluginService,
      `marketplace:add:${source}`,
      async (workspace) => {
        await pluginService.addPluginMarketplace({
          ...workspace,
          source,
        });
      },
    );
  },

  async updateMarketplace(marketplace, pluginService) {
    let refreshError: string | null = null;
    const succeeded = await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `marketplace:update:${marketplace ?? "__all__"}`,
      async (workspace) => {
        const result = await pluginService.updatePluginMarketplace({
          ...workspace,
          ...(marketplace ? { marketplace } : {}),
        });
        // Refresh allows partial success, so reload the overview to retain successful sources. But warning and returning true
        // would make Desktop and mobile Web report the stale snapshot as a successful refresh. Save the error first, then after reload
        // write the visible error state shared by the store and return false so all entry points have consistent partial-failure semantics.
        const blockingDiagnostic = result.diagnostics?.find(
          (diagnostic) => diagnostic.severity === "error",
        );
        if (blockingDiagnostic) {
          refreshError = blockingDiagnostic.message;
          logger.warn("[plugins] marketplace refresh partially failed", {
            diagnostics: result.diagnostics,
          });
        }
      },
    );
    if (succeeded && refreshError) {
      // A list refresh failure has no plugin target; clear the attribution so it does not point to any plugin.
      set({ error: refreshError, lastFailedPluginId: null });
      return false;
    }
    return succeeded;
  },

  async removeMarketplace(marketplace, pluginService) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `marketplace:remove:${marketplace}`,
      async (workspace) => {
        await pluginService.removePluginMarketplace({
          ...workspace,
          marketplace,
        });
      },
    );
  },

  async installPlugin(pluginName, marketplace, pluginService, scope = "user") {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:install:${pluginName}@${marketplace}`,
      async (workspace) => {
        const result = await pluginService.installPlugin({
          ...workspace,
          pluginName,
          marketplace,
          scope,
        });
        // To preserve structured diagnostics, the CLI returns a successful RPC envelope on install failure
        // and puts the actual error in diagnostics. The old UI ignored the result and continued refreshing, making the button seem unresponsive
        // with no error or retry path; map error diagnostics to the existing operation error state here.
        throwForErrorDiagnostic(result.diagnostics);
      },
    );
  },

  async uninstallPlugin(pluginId, pluginService, removeCache = true) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:uninstall:${pluginId}`,
      async (workspace) => {
        await pluginService.uninstallPlugin({
          ...workspace,
          pluginId,
          removeCache,
        });
      },
    );
  },

  async updatePlugin(pluginId, pluginService) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:update:${pluginId}`,
      async (workspace) => {
        const result = await pluginService.updatePlugin({ ...workspace, pluginId });
        // update and install share the same diagnostic-based failure contract. Throwing into runWorkspaceOperation does not
        // overwrite the current overview, so the old version and update badge remain until the user retries successfully.
        throwForErrorDiagnostic(result.diagnostics);
      },
    );
  },

  async restoreBuiltin(pluginId, pluginService) {
    await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:restore:${pluginId}`,
      async (workspace) => {
        await pluginService.restoreBuiltinPlugin({ ...workspace, pluginId });
      },
    );
  },

  async configurePlugin(pluginId, options, pluginService, scope = "user", clearOptionKeys = []) {
    return await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:configure:${pluginId}`,
      async (workspace) => {
        await pluginService.configurePlugin({
          ...workspace,
          pluginId,
          options,
          scope,
          ...(clearOptionKeys.length > 0 ? { clearOptionKeys } : {}),
        });
      },
    );
  },

  async resetPluginConfig(pluginId, pluginService, scope = "workspace") {
    return await runWorkspaceOperation(
      set,
      get,
      pluginService,
      `plugin:reset-config:${pluginId}`,
      async (workspace) => {
        await pluginService.resetPluginConfig({
          ...workspace,
          pluginId,
          scope,
        });
      },
    );
  },

  async validateSource(source, pluginService) {
    const { workspacePath, workspaceIdentity } = get();
    if (!workspacePath) return;
    set({ operationId: `marketplace:validate:${source}`, error: null });
    try {
      const result = await pluginService.validatePlugin({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        source,
      });
      set({ diagnostics: result.diagnostics });
    } catch (error) {
      logger.error("[plugins] validate source failed", { source, error: toMessage(error) });
      set({ error: toMessage(error), lastFailedPluginId: null });
    } finally {
      set({ operationId: null });
    }
  },

  async setEnabled(pluginId, enabled, pluginService, scope = "user") {
    return setPluginEnabledOptimistically(set, get, pluginId, enabled, pluginService, scope);
  },

  async describePlugin(pluginId, pluginName, marketplace, pluginService, force = false) {
    const { workspacePath, workspaceIdentity, describeCache } = get();
    if (!workspacePath) return;
    const cached = describeCache[pluginId];
    // Use the cache when data is loaded or loading; do not duplicate the request. With force, retry unconditionally.
    if (!force && cached && cached.status !== "error") return;
    set({
      describeCache: { ...get().describeCache, [pluginId]: { status: "loading" } },
    });
    try {
      const data = await pluginService.describePlugin({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        marketplace,
        pluginName,
      });
      const blockingDiagnostic = data.diagnostics?.find(
        (diagnostic) => diagnostic.severity === "error",
      );
      if (data.components.length === 0 && blockingDiagnostic) {
        // CLI describe returns diagnostics instead of an RPC rejection for unparseable sources.
        // The old UI cached that response as loaded, leaving a blank detail view with no retry path; map error diagnostics without a component
        // to a recoverable error state while preserving normal partial-success responses.
        set({
          describeCache: {
            ...get().describeCache,
            [pluginId]: { status: "error", error: blockingDiagnostic.message },
          },
        });
        return;
      }
      set({
        describeCache: {
          ...get().describeCache,
          [pluginId]: { status: "loaded", data },
        },
      });
    } catch (error) {
      logger.error("[plugins] describe failed", {
        pluginId,
        marketplace,
        error: toMessage(error),
      });
      set({
        describeCache: {
          ...get().describeCache,
          [pluginId]: { status: "error", error: toMessage(error) },
        },
      });
    }
  },
}));
