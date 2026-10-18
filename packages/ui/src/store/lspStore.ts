// Code intelligence (LSP) state for Settings. The CLI runtime owns the preferences sidecar and the
// server processes; this store only mirrors the lsp/status snapshot and forwards user intent.
// Global "enabled" and per-server diagnostics are written through lsp/preferences/set and then
// the snapshot is re-read, so the UI never guesses the effective state.
import { create } from "zustand";
import type { IPluginManagementService } from "@zcode/services";
import type { ZCodeLspServerStatus } from "@zcode/shared";
import { logger } from "@/logger.js";

export interface LspWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/** Pending write marker: the global switch, or one server's diagnostics switch by serverId. */
export type LspPendingKey = "enabled" | `diagnostics:${string}`;

export interface LspState {
  /** Identity key of the workspace the current snapshot belongs to; stale responses are dropped. */
  targetKey: string | null;
  /** null until the first snapshot arrives. */
  enabled: boolean | null;
  servers: ZCodeLspServerStatus[];
  loading: boolean;
  loadError: string | null;
  saveError: string | null;
  /** Which write failed, so only the matching switch row shows the error. */
  saveErrorKey: LspPendingKey | null;
  pendingKey: LspPendingKey | null;
  refresh: (pluginService: IPluginManagementService, target: LspWorkspaceTarget) => Promise<void>;
  setEnabled: (
    pluginService: IPluginManagementService,
    target: LspWorkspaceTarget,
    enabled: boolean,
  ) => Promise<boolean>;
  setDiagnosticsAfterEdit: (
    pluginService: IPluginManagementService,
    target: LspWorkspaceTarget,
    serverId: string,
    enabled: boolean,
  ) => Promise<boolean>;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Same identity rule as the rest of the Host protocol: identity when present, otherwise the path. */
export function buildLspTargetKey(target: LspWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function toViewParams(target: LspWorkspaceTarget) {
  return {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
  };
}

// Only the latest refresh may publish its snapshot; a slower earlier response is ignored.
let latestRefreshId = 0;

export const useLspStore = create<LspState>((set, get) => ({
  targetKey: null,
  enabled: null,
  servers: [],
  loading: false,
  loadError: null,
  saveError: null,
  saveErrorKey: null,
  pendingKey: null,

  async refresh(pluginService, target) {
    const refreshId = ++latestRefreshId;
    const targetKey = buildLspTargetKey(target);
    const switchingTarget = get().targetKey !== targetKey;
    set({
      targetKey,
      loading: true,
      loadError: null,
      // Do not show another workspace's servers while the new snapshot is pending.
      ...(switchingTarget ? { enabled: null, servers: [] } : {}),
    });
    try {
      const snapshot = await pluginService.getLspStatus(toViewParams(target));
      if (refreshId !== latestRefreshId) return;
      set({ enabled: snapshot.enabled, servers: snapshot.servers, loading: false });
    } catch (error) {
      if (refreshId !== latestRefreshId) return;
      logger.warn("[lsp] status refresh failed", { error: toMessage(error) });
      set({ loading: false, loadError: toMessage(error) });
    }
  },

  async setEnabled(pluginService, target, enabled) {
    return applyPatch(set, get, pluginService, target, "enabled", { enabled });
  },

  async setDiagnosticsAfterEdit(pluginService, target, serverId, enabled) {
    return applyPatch(set, get, pluginService, target, `diagnostics:${serverId}`, {
      diagnosticsAfterEdit: { [serverId]: enabled },
    });
  },
}));

async function applyPatch(
  set: (partial: Partial<LspState>) => void,
  get: () => LspState,
  pluginService: IPluginManagementService,
  target: LspWorkspaceTarget,
  pendingKey: LspPendingKey,
  patch: { enabled?: boolean; diagnosticsAfterEdit?: Record<string, boolean | null> },
): Promise<boolean> {
  if (get().pendingKey !== null) return false;
  set({ pendingKey, saveError: null, saveErrorKey: null });
  try {
    await pluginService.setLspPreferences({ ...toViewParams(target), patch });
  } catch (error) {
    logger.warn("[lsp] preferences update failed", { pendingKey, error: toMessage(error) });
    set({ pendingKey: null, saveError: toMessage(error), saveErrorKey: pendingKey });
    return false;
  }
  set({ pendingKey: null });
  // Re-read the snapshot so the switches show what the CLI actually applied.
  await get().refresh(pluginService, target);
  return true;
}
