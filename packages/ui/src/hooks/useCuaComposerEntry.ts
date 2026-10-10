/** Data orchestration for the always-visible CUA entry in the input. It does three things: gathers three data sources, gates permission queries, and passes the result to a pure state-derivation function. All decision rules live in lib/cuaComposerEntryState.ts; do not duplicate branches here. */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { isRemoteWorkspaceIdentity, ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useCuaPermissionStatus } from "@/hooks/useCuaPermissionStatus.js";
import {
  resolveCuaComposerEntryView,
  type CuaComposerEntryView,
} from "@/lib/cuaComposerEntryState.js";
import {
  supportsLocalMacCuaPermissionOnboarding,
  supportsLocalWindowsCuaEntry,
} from "@/lib/cuaPlatform.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { getVisibleTaskMetas, getWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";

/** Same definition as isRunningStatus in zcodeSessionStoreTaskSlice. */
const RUNNING_TASK_STATUSES = new Set(["creating", "restoring", "streaming"]);

export interface UseCuaComposerEntryParams {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  /** Mobile Web remote-control shell; under remote-control restrictions, do not render the local CUA entry. */
  /** v4 snapshot.control.canStop for the current composer, used as a low-latency authority for runtime state. */
  currentSessionBusy?: boolean;
}

interface CuaComposerEntryController {
  view: CuaComposerEntryView;
  /** Button click; side effects occur only when view.clickAction === "open-settings". */
  onActivate: () => void;
}

export function useCuaComposerEntry({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  currentSessionBusy = false,
}: UseCuaComposerEntryParams): CuaComposerEntryController {
  const platform = usePlatform();
  const services = useServices();
  const { settings } = useSettings();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);

  const macLocalDesktop = supportsLocalMacCuaPermissionOnboarding(platform);
  const windowsLocalDesktop = supportsLocalWindowsCuaEntry(platform);
  // Same local-workspace check as ComputerUseSection: CUA in a remote workspace would control
  // the remote machine’s screen, which the product does not support.
  const isLocalWorkspace =
    !remoteSessionId &&
    !(workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim()));

  // Hidden by default; show only when false was explicitly saved.
  // Use !== false rather than === true: if Settings has not loaded (null) or an older user lacks this field, treat it as hidden.
  // Otherwise a new user briefly sees the button before it disappears, and an unnecessary permission query runs in the background.
  const hiddenBySettings = settings?.computerUseComposerEntryHidden !== false;

  const plugins = usePluginManagementStore((state) => state.plugins);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const pluginStoreError = usePluginManagementStore((state) => state.error);
  // store.error is shared by the plugin area (marketplace/validate/load/any plugin setEnabled failure writes it).
  // Map an error to this button only when the failed operation targeted zcode-cua.
  // The store records ownership in lastFailedPluginId.
  const lastFailedPluginId = usePluginManagementStore((state) => state.lastFailedPluginId);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const cuaPlugin = plugins.find((plugin) => plugin.id === ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  const pluginEnabled = cuaPlugin?.enabled === true;

  const pluginManagementService = services.pluginManagementService;
  const platformSupported = (macLocalDesktop || windowsLocalDesktop) && isLocalWorkspace;
  // The plugin list is a required input to button state. The store is a singleton and initialize deduplicates in-flight work
  // and reuses cached results by workspaceKey, so sharing initialization with Settings does not multiply plugins/list requests.
  const initializedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!platformSupported || hiddenBySettings || !workspacePath || !pluginManagementService) {
      return;
    }
    const key = `${workspacePath}\0${workspaceIdentity ?? ""}`;
    if (initializedKeyRef.current === key) return;
    initializedKeyRef.current = key;
    void initializePlugins({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      pluginService: pluginManagementService,
    });
  }, [
    hiddenBySettings,
    initializePlugins,
    platformSupported,
    pluginManagementService,
    workspaceIdentity,
    workspacePath,
  ]);

  // The composer entry has no status display (no indicator and a fixed link to settings), so it does not query
  // permissions at all. Permission checks can start the Helper through getStatus; checking on mount would start
  // it whenever the app opens and violate lazy startup. A visible button, macOS, and an enabled plugin do not
  // change that: enabling the plugin does not mean the user wants to pay the Helper startup cost now. Read the
  // permission state only in settings (when opened) and during an explicit authorization flow.
  // permissionStatus stays null; resolveUiState treats null as neutral idle, not an error.
  const { status: permissionStatus } = useCuaPermissionStatus(null, workspaceIdentity);

  // Determine session-busy state per workspace: toggling a plugin changes the tool set and invalidates prompt
  // caches for every session in that workspace, so the affected and disabled scopes must match. Do not check
  // only the current task. Reuse getWorkspaceState's identity→path fallback instead of duplicating workspaceKey rules.
  const workspaceSessionBusy = useZCodeSessionStore((state) => {
    const workspaceState = getWorkspaceState(state, workspacePath, workspaceIdentity);
    const runtimeBusy = Object.values(workspaceState.taskRuntimeByTaskId ?? {}).some(
      (runtime) =>
        RUNNING_TASK_STATUSES.has(runtime.status) || Boolean(runtime.activeInputId?.trim()),
    );
    if (runtimeBusy) return true;
    // A V4 snapshot can enter a stoppable model turn while the workspace runtime projection briefly returns to
    // ready; the task index still authoritatively records persist status=running. Checking runtime alone would
    // leave the CUA entry clickable during real execution. Combine both existing sources and lock if either is running.
    return getVisibleTaskMetas(workspaceState).some((task) => task.status === "running");
  });
  // The current pane's snapshot.control.canStop arrives before the workspace projection. OR-ing both locks this
  // composer immediately while preserving the shared lock for other composers in the same workspace.
  const sessionBusy = currentSessionBusy || workspaceSessionBusy;

  const view = useMemo(
    () =>
      resolveCuaComposerEntryView({
        macLocalDesktop: macLocalDesktop && isLocalWorkspace,
        windowsLocalDesktop: windowsLocalDesktop && isLocalWorkspace,
        hiddenBySettings,
        permissionServiceAvailable: Boolean(services.cuaPermissionService),
        pluginEnabled,
        pluginToggling: togglingPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID,
        pluginError:
          Boolean(pluginStoreError) && lastFailedPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID,
        permissionStatus: permissionStatus ?? null,
        sessionBusy,
      }),
    [
      cuaPlugin,
      hiddenBySettings,
      lastFailedPluginId,
      isLocalWorkspace,
      macLocalDesktop,
      permissionStatus,
      pluginEnabled,
      pluginStoreError,
      sessionBusy,
      services.cuaPermissionService,
      togglingPluginId,
      windowsLocalDesktop,
    ],
  );

  const onActivate = useCallback(() => {
    if (!view.visible || view.clickAction !== "open-settings") return;
    setPendingSettingsSectionIntent("computerUse");
    openSettingsTab();
  }, [openSettingsTab, view]);

  return { view, onActivate };
}
