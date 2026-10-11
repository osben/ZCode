import type { IPluginManagementService } from "@zcode/services";
import type { ZCodePluginScope } from "@zcode/shared";
import { logger } from "@/logger.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildWorkspaceKey(workspacePath: string, workspaceIdentity: string | null): string {
  return workspaceIdentity?.trim() || workspacePath;
}

const inFlightLoads = new Map<string, Promise<void>>();

export async function runWorkspaceOperation(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  pluginService: IPluginManagementService,
  operationId: string,
  operation: (workspace: { workspacePath: string; workspaceIdentity?: string }) => Promise<void>,
): Promise<boolean> {
  const { workspacePath, workspaceIdentity, configScope } = get();
  if (!workspacePath) return false;
  const operationVersion = get().operationVersion + 1;
  set({ operationId, operationVersion, error: null, lastFailedPluginId: null });
  const isCurrentContext = (): boolean => {
    const current = get();
    return (
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === workspaceIdentity &&
      current.configScope === configScope
    );
  };
  const ownsVisibleOperation = (): boolean =>
    isCurrentContext() && get().operationId === operationId;
  try {
    await operation({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
    // operationId is only a shared UI busy indicator. An automatic refresh may replace it before the current operation completes,
    // but that must not cause an add/install operation already persisted successfully to be reported as failed, or the caller will keep the dialog open.
    if (!isCurrentContext()) return false;
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      configScope,
      pluginService,
    });
    return isCurrentContext();
  } catch (error) {
    // Generic operation failure such as marketplace add/update: no plugin target, so clear the association.
    logger.error("[plugins] operation failed", { operationId, error: toMessage(error) });
    // An old operation must not overwrite the error state of a newer operation in the same config layer; write back only if it still owns the visible operationId.
    if (ownsVisibleOperation()) {
      set({ error: toMessage(error), lastFailedPluginId: null });
    }
    return false;
  } finally {
    // Prevent an old operation from clearing the busy state of a later operation when it finishes.
    // After a Scope/workspace switch, the current context may have changed, so do not use isCurrentContext to decide;
    // clear it as long as the operationId still belongs to the operation that just ended. Otherwise, if the user switches to User
    // settings after saving config but before the refresh finishes, the new view will remain read-only due to the old operation.
    if (get().operationId === operationId && get().operationVersion === operationVersion) {
      set({ operationId: null });
    }
  }
}

export async function loadInto(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  params: {
    workspacePath: string;
    workspaceIdentity: string | null;
    configScope: ZCodePluginScope | null;
    pluginService: IPluginManagementService;
  },
): Promise<void> {
  const workspaceKey = buildWorkspaceKey(params.workspacePath, params.workspaceIdentity);
  const loadKey = `${workspaceKey}\u0000${params.configScope ?? "effective"}`;
  const existing = inFlightLoads.get(loadKey);
  if (existing) {
    logger.debug("[plugins] join in-flight list", {
      configScope: params.configScope,
      workspaceKey,
    });
    await existing;
    return;
  }
  const loadTask = runLoadInto(set, get, { ...params, workspaceKey });
  inFlightLoads.set(loadKey, loadTask);
  try {
    await loadTask;
  } finally {
    if (inFlightLoads.get(loadKey) === loadTask) {
      inFlightLoads.delete(loadKey);
    }
  }
}

async function runLoadInto(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  params: {
    workspacePath: string;
    workspaceIdentity: string | null;
    configScope: ZCodePluginScope | null;
    workspaceKey: string;
    pluginService: IPluginManagementService;
  },
): Promise<void> {
  const setIfCurrent = (partial: Partial<PluginManagementState>): void => {
    const current = get();
    if (
      current.workspacePath !== params.workspacePath ||
      current.workspaceIdentity !== params.workspaceIdentity ||
      current.configScope !== params.configScope
    ) {
      return;
    }
    set(partial);
  };
  try {
    // React StrictMode, settings service reference refreshes, or rapid settings-page switches
    // can trigger concurrent initialize calls for the same workspace. Separate plugins/list requests would queue up multiple 30s timeouts
    // when the agent is already stale. Reuse in-flight requests by workspaceKey and write results only if that workspace is still current,
    // preventing stale responses from overwriting the current settings page.
    const [listResult, overviewResult] = await Promise.all([
      params.pluginService.listPlugins({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
      params.pluginService.getPluginsOverview({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      }),
    ]);
    const diagnostics = [...listResult.diagnostics, ...overviewResult.diagnostics];
    setIfCurrent({
      plugins: listResult.plugins,
      marketplaces: overviewResult.marketplaces,
      marketplaceAvailabilityKnown: true,
      availablePlugins: overviewResult.availablePlugins,
      installedPlugins: overviewResult.installedPlugins,
      restorableBuiltins: overviewResult.restorableBuiltins,
      diagnostics,
      loading: false,
    });
  } catch (error) {
    logger.error("[plugins] overview/list failed", {
      workspacePath: params.workspacePath,
      workspaceKey: params.workspaceKey,
      lastFailedPluginId: null,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      const result = await params.pluginService.listPlugins({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.configScope ? { configScope: params.configScope } : {}),
      });
      setIfCurrent({
        plugins: result.plugins,
        marketplaces: [],
        // An empty array after overview failure means "source state unknown," not "all sources removed."
        // Preserve this boundary so official/cache plugins returned by list fallback are not all misclassified as orphaned installs.
        marketplaceAvailabilityKnown: false,
        availablePlugins: [],
        installedPlugins: [],
        restorableBuiltins: [],
        diagnostics: result.diagnostics,
        loading: false,
      });
      return;
    } catch (listError) {
      logger.error("[plugins] list fallback failed", {
        workspacePath: params.workspacePath,
        workspaceKey: params.workspaceKey,
        lastFailedPluginId: null,
        error: listError instanceof Error ? listError.message : String(listError),
      });
      setIfCurrent({
        loading: false,
        marketplaceAvailabilityKnown: false,
        lastFailedPluginId: null,
        error: listError instanceof Error ? listError.message : String(listError),
      });
    }
  }
}
