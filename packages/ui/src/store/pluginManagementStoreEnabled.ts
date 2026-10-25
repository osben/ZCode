import type { IPluginManagementService } from "@zcode/services";
import type { ZCodePluginScope } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  buildWorkspaceKey,
  loadInto,
  notifyPluginManagementChange,
} from "@/store/pluginManagementStoreLoading.js";
import type { PluginManagementState } from "@/store/pluginManagementStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let nextToggleRequestId = 0;
const requestsByStore = new WeakMap<() => PluginManagementState, Map<string, number>>();

function buildToggleRequestKey(input: {
  workspacePath: string;
  workspaceIdentity: string | null;
  authorityKey: string | null;
  configScope: ZCodePluginScope | null;
  pluginId: string;
}): string {
  const workspaceKey = buildWorkspaceKey(
    input.workspacePath,
    input.workspaceIdentity,
    input.authorityKey,
  );
  return `${workspaceKey}\u0000${input.configScope ?? "effective"}\u0000${input.pluginId}`;
}

export async function setPluginEnabledOptimistically(
  set: (partial: Partial<PluginManagementState>) => void,
  get: () => PluginManagementState,
  pluginId: string,
  enabled: boolean,
  pluginService: IPluginManagementService,
  scope: ZCodePluginScope = "user",
): Promise<boolean> {
  const { workspacePath, workspaceIdentity, authorityKey, configScope } = get();
  if (!workspacePath) return false;
  let activeToggleRequests = requestsByStore.get(get);
  if (!activeToggleRequests) {
    activeToggleRequests = new Map();
    requestsByStore.set(get, activeToggleRequests);
  }

  const requestKey = buildToggleRequestKey({
    workspacePath,
    workspaceIdentity,
    authorityKey,
    configScope,
    pluginId,
  });
  const requestId = ++nextToggleRequestId;
  activeToggleRequests.set(requestKey, requestId);
  const isCurrentRequest = (): boolean => {
    const current = get();
    return (
      activeToggleRequests.get(requestKey) === requestId &&
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === workspaceIdentity &&
      current.authorityKey === authorityKey &&
      current.configScope === configScope &&
      current.togglingPluginId === pluginId
    );
  };

  const previousPlugin = get().plugins.find((plugin) => plugin.id === pluginId);
  // Enable/disable RPCs and the subsequent list refresh have noticeable latency. Project the final state first so the toggle responds immediately;
  // restore the snapshot in catch on failure so users do not mistake a normal async write for an unresponsive click.
  set({
    togglingPluginId: pluginId,
    error: null,
    lastFailedPluginId: null,
    ...(previousPlugin
      ? {
          plugins: get().plugins.map((plugin) =>
            plugin.id === pluginId ? { ...plugin, enabled, enabledSource: scope } : plugin,
          ),
        }
      : {}),
  });

  try {
    const result = await pluginService.setPluginEnabled({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      pluginId,
      enabled,
      scope,
    });
    if (!isCurrentRequest()) {
      notifyPluginManagementChange({
        owner: get,
        workspacePath,
        workspaceIdentity,
        authorityKey,
        scope,
      });
      return false;
    }
    set({
      plugins: get().plugins.map((plugin) =>
        plugin.id === pluginId ? { ...plugin, ...result.plugin, enabled: result.enabled } : plugin,
      ),
    });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      authorityKey,
      configScope,
      pluginService,
      fresh: true,
    });
    notifyPluginManagementChange({
      owner: get,
      workspacePath,
      workspaceIdentity,
      authorityKey,
      scope,
    });
    return isCurrentRequest();
  } catch (error) {
    // On enable/disable failure, return false and restore the optimistic projection so callers do not
    // continue refreshing other capabilities or report the failed toggle as successful.
    logger.error("[plugins] setEnabled failed", { pluginId, enabled, error: toMessage(error) });
    if (isCurrentRequest()) {
      set({
        error: toMessage(error),
        lastFailedPluginId: pluginId,
        ...(previousPlugin
          ? {
              plugins: get().plugins.map((plugin) =>
                plugin.id === pluginId ? previousPlugin : plugin,
              ),
            }
          : {}),
      });
    }
    return false;
  } finally {
    if (isCurrentRequest()) {
      set({ togglingPluginId: null });
    }
    if (activeToggleRequests.get(requestKey) === requestId) {
      activeToggleRequests.delete(requestKey);
    }
  }
}
