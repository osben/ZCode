import { decorateRequestSecurityLogArgs } from "./request-security-edition/index.js";
/* eslint-disable max-lines -- Desktop platform IPC is assembled centrally because splitting it would make permission boundaries harder to audit; this file grows with platform capabilities. */
import { BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { readZCodeStdioTapDevState } from "@zcode/services/node";
import {
  DesktopCommandIds,
  appSettingsPatchSchema,
  forkAppSettingsPatchSchema,
  formatZodError,
  localeSchema,
  nonEmptyStringSchema,
  PlatformChannels,
  rendererLogPayloadSchema,
  stringArraySchema,
  webRemoteControlTaskTargetsSchema,
  webRemoteControlWorkspaceTargetsSchema,
  type DesktopCommandId,
  type ApplicationIconRequest,
  type Locale,
  type LoadCliMcpFromUserDirectoryRequest,
  type MigrateLegacyCommonMcpRequest,
  type OpenInEditorOptions,
  type SaveCliMcpToUserDirectoryRequest,
  type CreateTempTextAttachmentRequest,
  type MaterializeWorkflowArtifactFileRequest,
  type UpdateStatePayload,
  type WebRemoteControlTaskTarget,
  type WebRemoteControlWorkspaceTarget,
  type WindowControlsOverlayReadyPayload,
} from "@zcode/shared";
import { getInstalledEditors } from "./editors.js";
import { getApplicationIcon } from "./applicationIcons.js";
import { exportLogs } from "./exportLogs.js";
import { resolveCommunityUrl } from "./desktopCommandHandlers.js";
import { openInEditor } from "./openInEditor.js";
import {
  openResourceManager,
  getResourceUsageSnapshot,
  setResourceUsageSamplingActive,
} from "./resourceManagerWindow.js";
import { registerResourceManagerStorageIpc } from "./resourceManagerStorage.js";
import { registerResourceManagerNetworkIpc } from "./resourceManagerNetwork.js";
import { applyWindowsTitleBarTheme, getWindowOverlayTheme } from "./desktopWindowChrome.js";
import { syncWindowControlsOverlayForZoomLevel } from "./desktopWindowButtonPosition.js";
import { resolveDesktopZoomLevelFromFactor } from "./desktopZoom.js";
import { resolveDesktopWindowChromeState } from "./desktopWindowChromeState.js";
import { handleWindowUnreadCountSync } from "./desktopWindowLifecycle.js";
import { captureWindowScreenshot, openPathInFileManager } from "./desktopMainIpcHelpers.js";
import { registerCuaPermissionIpcHandlers } from "./desktopCuaPermissionIpc.js";
import {
  registerDesktopBrowserIpcHandlers,
  type AttachBrowserGuest,
  type ReportBrowserScreenshotSurfaceReady,
  type UpdateBrowserGuestViewport,
  type BrowserViewResidencyIpcHandlers,
} from "./desktopBrowserViewIpc.js";
import {
  loadCliMcpFromUserDirectory,
  migrateLegacyCommonMcp,
  saveCliMcpToUserDirectory,
} from "./mcpUserDirectory/index.js";
import { createTempTextAttachment } from "./tempTextAttachment.js";
import { materializeWorkflowArtifactFile } from "./workflowArtifactFile.js";
import { registerDesktopSaveFileIpcHandler } from "./desktopSaveFile.js";
import { registerDesktopPrintToPdfIpcHandler } from "./desktopPrintToPdf.js";
import { registerDesktopDictationSystemAudioIpc } from "./desktopDictationSystemAudio.js";
import { registerCuaPipActiveSessionIpc } from "./desktopCuaPipIpc.js";

// appSettingsPatchSchema strips fork-only keys; main reacts to this one live, so admit exactly it
// (specs/resource-telemetry-toggle.md). Without it the switch would persist but never reach main.
const appSettingsSyncPatchSchema = appSettingsPatchSchema.extend({
  resourceTelemetryEnabled: forkAppSettingsPatchSchema.shape.resourceTelemetryEnabled,
});

export function registerPlatformIpcHandlers(options: {
  fetchHelpConfig?: () => Promise<unknown>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  applyApplicationLocale: (locale: Locale) => Promise<void>;
  resolveSystemLocale: () => Locale;
  focusWorkspaceInExistingWindow: (
    path: string,
    extra?: { skipWindowId?: number },
  ) => { activated: boolean; winId?: number };
  windowWorkspaceMap: Map<number, Set<string>>;
  windowUnreadCountMap: Map<number, number>;
  currentApplicationLocale: () => Locale;
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  acknowledgePostUpdateReleaseNotes: (version: string) => Promise<void>;
  syncActiveTaskSession: (windowId: number, sessionId: string | null) => void;
  syncTaskRealtimeWorkspaceKeys: (windowId: number, workspaceKeys: Iterable<string>) => void;
  restorePreviouslyEnabledWebRemoteControl: (
    windowId: number,
    contexts: Array<{ workspacePath: string }>,
  ) => void;
  getUpdateState: () => UpdateStatePayload;
  openUpdateStatusWindow: () => void;
  syncWebRemoteControlWorkspaces: (
    windowId: number,
    workspaces: WebRemoteControlWorkspaceTarget[],
  ) => void;
  syncWebRemoteControlTasks: (windowId: number, tasks: WebRemoteControlTaskTarget[]) => void;
  getDesktopSessionActivity: () => {
    runningAgentSessionCount: number;
  };
  getAutoUpdatePreferences: () => Promise<{
    autoDownloadAndInstallUpdates: boolean;
  }>;
  setAutoDownloadAndInstallUpdates: (enabled: boolean) => Promise<void>;
  syncAppSettings: (patch: unknown) => void;
  /** Close-to-tray capability query (spec: docs/desktop/linux-close-to-tray.md); delegates to the monitor's refresh. */
  refreshCloseToTrayCapability: () => Promise<import("@zcode/shared").DesktopCloseToTrayCapability>;
  /** Shortcut-settings recording toggle: when true, main rebuilds the menu without configurable accelerators (see shortcut-settings-spec §7). */
  setShortcutRecordingActive?: (active: boolean, ownerWebContentsId?: number | null) => void;
  /** Desktop device identifier (SHA-256 based on the userData path). */
  deviceMid: string;
  /** CDP-on-guest pivot: renderer reports the guest webContentsId for a `<webview>` so main can attach. */
  attachBrowserGuest?: AttachBrowserGuest;
  /** Renderer free-size changes → controlled tab belonging to the current window. */
  updateBrowserGuestViewport?: UpdateBrowserGuestViewport;
  /** Background screenshot-surface ready signal reported by the trusted owner renderer. */
  reportBrowserScreenshotSurfaceReady?: ReportBrowserScreenshotSurfaceReady;
  /** IPC for closing, suspending, and restoring browser tabs and their cross-restart shells. */
  browserViewResidencyHandlers?: BrowserViewResidencyIpcHandlers;
}) {
  ipcMain.handle(PlatformChannels.SelectDirectory, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // Pure path computation for the worktree location mode "global"; the directory itself is
  // created by `git worktree add`, not here.
  ipcMain.handle(PlatformChannels.GetAppWorktreesDir, () => join(homedir(), ".zcode", "worktrees"));

  ipcMain.handle(PlatformChannels.SelectFile, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(PlatformChannels.SelectFiles, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }
    return result.filePaths;
  });

  registerDesktopSaveFileIpcHandler(options.logger);
  registerDesktopPrintToPdfIpcHandler(options.logger);
  registerDesktopDictationSystemAudioIpc({ logger: options.logger });

  ipcMain.handle(
    PlatformChannels.CreateTempTextAttachment,
    async (_event, payload: CreateTempTextAttachmentRequest) => {
      return createTempTextAttachment(payload);
    },
  );

  ipcMain.handle(
    PlatformChannels.MaterializeWorkflowArtifactFile,
    async (_event, payload: MaterializeWorkflowArtifactFileRequest) => {
      return materializeWorkflowArtifactFile(payload);
    },
  );

  registerDesktopBrowserIpcHandlers(
    options.attachBrowserGuest,
    options.updateBrowserGuestViewport,
    options.logger,
    options.reportBrowserScreenshotSurfaceReady,
    options.browserViewResidencyHandlers,
  );

  ipcMain.handle(PlatformChannels.ActivateOrSetWorkspace, (event, path: string) => {
    const validatedPath = nonEmptyStringSchema.parse(path);
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    const activated = options.focusWorkspaceInExistingWindow(validatedPath, {
      skipWindowId: senderWin?.id,
    });
    if (activated.activated) {
      return { activated: true };
    }

    if (senderWin) {
      let pathSet = options.windowWorkspaceMap.get(senderWin.id);
      if (!pathSet) {
        pathSet = new Set();
        options.windowWorkspaceMap.set(senderWin.id, pathSet);
        senderWin.on("closed", () => options.windowWorkspaceMap.delete(senderWin.id));
      }
      pathSet.add(validatedPath);
      options.syncTaskRealtimeWorkspaceKeys(senderWin.id, pathSet);
    }
    return { activated: false };
  });

  ipcMain.handle(PlatformChannels.GetResourceUsageSnapshot, (event) =>
    getResourceUsageSnapshot(event.sender.id),
  );
  // Entry point for the settings page's Linux grey-out check; the monitor caches stale results, so
  // reopening the settings page after installing the extension clears the grey-out.
  ipcMain.handle(PlatformChannels.GetCloseToTrayCapability, () =>
    options.refreshCloseToTrayCapability(),
  );
  ipcMain.on(PlatformChannels.SetResourceUsageSamplingActive, (event, active: unknown) => {
    if (typeof active === "boolean") setResourceUsageSamplingActive(event.sender.id, active);
  });
  registerResourceManagerStorageIpc();
  registerResourceManagerNetworkIpc();
  ipcMain.handle(PlatformChannels.GetZCodeStdioTapDevState, () => readZCodeStdioTapDevState());
  ipcMain.on(PlatformChannels.OpenResourceManager, () => {
    openResourceManager();
  });

  ipcMain.handle(
    PlatformChannels.LoadMcpFromUserDirectory,
    async (_event, payload?: LoadCliMcpFromUserDirectoryRequest) => {
      return loadCliMcpFromUserDirectory(payload);
    },
  );

  ipcMain.handle(
    PlatformChannels.SaveMcpToUserDirectory,
    async (_event, payload: SaveCliMcpToUserDirectoryRequest) => {
      try {
        await saveCliMcpToUserDirectory(payload);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn("[mcp-user-directory] save failed", message);
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    PlatformChannels.MigrateLegacyCommonMcp,
    async (_event, payload?: MigrateLegacyCommonMcpRequest) => {
      return migrateLegacyCommonMcp(payload);
    },
  );

  ipcMain.handle(PlatformChannels.SetTitleBarTheme, (event, theme: string) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow) {
      return;
    }

    if (theme !== "light" && theme !== "dark" && theme !== "system") {
      options.logger.warn("[title-bar-theme] invalid theme:", theme);
      return;
    }

    nativeTheme.themeSource = theme;
    applyWindowsTitleBarTheme(senderWindow, theme === "system" ? getWindowOverlayTheme() : theme);
  });

  ipcMain.handle(PlatformChannels.SetApplicationLocale, (_event, locale: unknown) => {
    const result = localeSchema.safeParse(locale);
    if (!result.success) {
      options.logger.warn("[application-locale] invalid locale:", formatZodError(result.error));
      return;
    }

    return options.applyApplicationLocale(result.data);
  });

  ipcMain.handle(PlatformChannels.GetSystemLocale, () => options.resolveSystemLocale());

  ipcMain.on(PlatformChannels.SyncWindowTabs, (event, paths: string[]) => {
    const result = stringArraySchema.safeParse(paths);
    if (!result.success) {
      options.logger.warn("[sync-window-tabs] invalid payload:", formatZodError(result.error));
      return;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      options.windowWorkspaceMap.set(win.id, new Set(result.data));
      options.syncTaskRealtimeWorkspaceKeys(win.id, result.data);
      options.restorePreviouslyEnabledWebRemoteControl(
        win.id,
        result.data.map((workspacePath) => ({ workspacePath })),
      );
    }
  });

  ipcMain.on(PlatformChannels.SyncWebRemoteControlWorkspaces, (event, payload: unknown) => {
    const result = webRemoteControlWorkspaceTargetsSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[sync-web-remote-control-workspaces] invalid payload:",
        formatZodError(result.error),
      );
      return;
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }

    options.syncWebRemoteControlWorkspaces(win.id, result.data);
  });

  ipcMain.on(PlatformChannels.SyncWebRemoteControlTasks, (event, payload: unknown) => {
    const result = webRemoteControlTaskTargetsSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[sync-web-remote-control-tasks] invalid payload:",
        formatZodError(result.error),
      );
      return;
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }

    options.syncWebRemoteControlTasks(win.id, result.data);
  });

  ipcMain.on(PlatformChannels.SyncWindowUnreadCount, (event, payload: unknown) => {
    handleWindowUnreadCountSync(
      BrowserWindow.fromWebContents(event.sender),
      payload,
      options.windowUnreadCountMap,
      options.logger,
    );
  });
  registerCuaPipActiveSessionIpc({
    syncActiveTaskSession: options.syncActiveTaskSession,
    warn: (message) => options.logger.warn(message),
  });
  ipcMain.on(
    PlatformChannels.WindowControlsOverlayReady,
    (event, payload: WindowControlsOverlayReadyPayload) => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      if (!senderWindow || !Number.isFinite(payload.zoomLevel)) {
        return;
      }

      // The preload runs before the React page. Use its synchronized zoom level to adjust the macOS
      // traffic lights first, rather than waiting until RootStartupLoading switches to the App page.
      syncWindowControlsOverlayForZoomLevel(senderWindow, payload.zoomLevel);
    },
  );

  ipcMain.on(PlatformChannels.SyncAppSettings, (_event, payload: unknown) => {
    const result = appSettingsSyncPatchSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[settings] invalid app settings sync payload:",
        formatZodError(result.error),
      );
      return;
    }

    options.syncAppSettings(result.data);
  });

  // Shortcut recording state: the renderer notifies main when the settings page enters/exits
  // recording. On macOS, the system menu consumes keys before the renderer, so recording commands
  // must first remove configurable accelerators or the key will trigger the original command.
  // Include the originating webContents ID so main can reset the state if that window is destroyed (see index.ts).
  ipcMain.on(PlatformChannels.SetShortcutRecordingActive, (event, payload: unknown) => {
    if (typeof payload !== "boolean") {
      options.logger.warn("[shortcuts] invalid recording-active payload:", payload);
      return;
    }
    options.setShortcutRecordingActive?.(payload, event.sender.id);
  });

  ipcMain.on(PlatformChannels.Log, (event, payload: unknown) => {
    const result = rendererLogPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn("[renderer-log] invalid payload:", formatZodError(result.error));
      return;
    }
    (
      options.logger as unknown as { fromRenderer(level: string, args: unknown[]): void }
    ).fromRenderer?.(
      result.data.level,
      decorateRequestSecurityLogArgs(result.data.args, event.sender.id),
    );
  });

  ipcMain.handle(PlatformChannels.OpenInFileManager, async (_event, rawPath: string) =>
    openPathInFileManager(rawPath, options.logger),
  );

  registerCuaPermissionIpcHandlers({
    logger: options.logger,
    currentApplicationLocale: options.currentApplicationLocale,
  });

  ipcMain.handle(PlatformChannels.CanOpenCommunity, async (_event, locale: unknown) => {
    const result = localeSchema.safeParse(locale);
    if (!result.success) {
      options.logger.warn("[community] invalid locale:", formatZodError(result.error));
      return false;
    }

    const communityUrl = await resolveCommunityUrl({
      locale: result.data,
      fetchRemoteConfig: options.fetchHelpConfig,
      logger: options.logger,
    });

    return typeof communityUrl === "string" && communityUrl.length > 0;
  });

  ipcMain.handle(
    PlatformChannels.AcknowledgePostUpdateReleaseNotes,
    async (_event, version: string) => {
      const validatedVersion = nonEmptyStringSchema.parse(version);
      await options.acknowledgePostUpdateReleaseNotes(validatedVersion);
    },
  );

  ipcMain.handle(PlatformChannels.GetUpdateState, () => options.getUpdateState());
  ipcMain.handle(PlatformChannels.OpenUpdateStatusWindow, () => {
    options.openUpdateStatusWindow();
  });
  ipcMain.handle(PlatformChannels.GetAutoUpdatePreferences, () =>
    options.getAutoUpdatePreferences(),
  );
  ipcMain.handle(
    PlatformChannels.SetAutoDownloadAndInstallUpdates,
    async (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        return;
      }
      await options.setAutoDownloadAndInstallUpdates(enabled);
    },
  );
  ipcMain.handle(PlatformChannels.GetDesktopSessionActivity, () =>
    options.getDesktopSessionActivity(),
  );
  ipcMain.handle(PlatformChannels.GetDesktopZoomLevel, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) {
      return { zoomLevel: 0 };
    }

    return {
      zoomLevel: resolveDesktopZoomLevelFromFactor(senderWindow.webContents.getZoomFactor()),
    };
  });
  ipcMain.handle(PlatformChannels.GetDesktopWindowChromeState, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return resolveDesktopWindowChromeState(senderWindow?.isMaximized() ?? false);
  });
  ipcMain.handle(PlatformChannels.GetInstalledEditors, () => getInstalledEditors());
  ipcMain.handle(
    PlatformChannels.GetApplicationIcon,
    (_event, request: string | ApplicationIconRequest) => getApplicationIcon(request),
  );
  ipcMain.handle(PlatformChannels.GetDeviceId, () => options.deviceMid);
  ipcMain.handle(PlatformChannels.ExportLogs, () => exportLogs());
  ipcMain.handle(PlatformChannels.CaptureWindowScreenshot, async (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return captureWindowScreenshot(senderWindow);
  });
  ipcMain.handle(
    PlatformChannels.OpenInEditor,
    (_event, payload: { editorId: string; path: string; options?: OpenInEditorOptions }) =>
      openInEditor(payload.editorId, payload.path, payload.options),
  );

  ipcMain.handle(PlatformChannels.ExecuteDesktopCommand, async (event, command: string) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const isKnownCommand = (Object.values(DesktopCommandIds) as string[]).includes(command);
    if (!isKnownCommand) {
      options.logger.warn("[desktop-command] invalid command:", command);
      return;
    }

    // Return the renderer's executeDesktopCommand promise directly (GetCuaOsSupport relies on this behavior).
    return await options.executeDesktopCommand(command as DesktopCommandId, senderWindow);
  });
}
