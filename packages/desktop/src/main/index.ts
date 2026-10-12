import { installRequestSecurityDiagnostics } from "./request-security-edition/index.js";
import { createLocalTtftExporter } from "./localTtftExporter.js";
/* eslint-disable max-lines */
import "./desktopEarlyDataBaseDirBootstrap.js";
import "./desktopEarlyChromiumHardwareAccelerationBootstrap.js";
import { powerMonitor, powerSaveBlocker } from "electron";
import { crashCapturePaths } from "./appCrashCaptureBootstrap.js";
import { armsInitPromise } from "./appARMSBootstrap.js";
import {
  onLocalDatabaseStartupReady,
  configureDatabaseStartupQuit,
} from "./databaseStartupRelay.js";
import armsRum from "@arms/rum-electron";
import { createArmsUserIdentitySync } from "./armsUserIdentity.js";
import { ensureDesktopDeviceMidSync } from "./desktopDeviceMid.js";
import {
  createDesktopContextPromptRollout,
  createElectronDesktopContextPromptConfigFetcher,
} from "./desktopContextPromptRollout.js";
import { buildBrowserViewCloseTabNotification } from "./browserView/browserCloseTabNotification.js";
import { BrowserGuestManager } from "./browserView/browserGuestManager.js";
import { createElectronBrowserWebmRecorder } from "./browserView/electronBrowserWebmRecorder.js";
import { installBrowserRestoreBootstrapProtocol } from "./browserView/browserRestoreBootstrapProtocol.js";
import {
  createLocalMediaPreviewPathRegistry,
  installLocalMediaPreviewProtocol,
  registerLocalMediaPreviewScheme,
} from "./localMediaPreviewProtocol.js";
import { createDesktopBrowserScreenshotSurfaceCoordinator } from "./browserView/browserScreenshotSurfaceCoordinatorWiring.js";
import { EMBEDDED_BROWSER_PARTITION } from "./browserDataManager.js";
import { EmbeddedBrowserJavaScriptDialogController } from "./embeddedBrowserJavaScriptDialog.js";
import {
  browserOperationResetsResizeBaseline,
  resolveBrowserOperationTabId,
} from "./browserView/browserOperationIndicator.js";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  net,
  protocol,
  session,
  webContents,
} from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import {
  createCredentialService,
  createSettingService,
  createTelemetryCore,
  createTelemetryMarketingParamsLoader,
  createTelemetryUserIdLoader,
  createTelemetryAuthorizationLoader,
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  getConversationWorkspaceDir,
  getDataBaseDir,
  getZCodeDataRootDir,
  normalizeRuntimeProcessEnv,
  setDataBaseDir,
} from "@zcode/services/node";
import {
  desktopMenuMessageIds,
  type Locale,
  type AppSettings,
  PlatformChannels,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  ZCODE_AUTO_UPDATE_ENABLED,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  DEFAULT_LOCALE,
  TEST_ZCODE_ENDPOINT_ORIGIN,
  ZCODE_VERSION,
  ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL_DEFAULT,
  ZCODE_WEB_REMOTE_CONTROL_URL_DEFAULT,
  buildZCodeEndpointUrls,
  resolveWebRemoteControlRelayWsUrl,
  resolveZCodeEndpointOrigin,
  shouldEnableE2ETestBridge,
  type UpdateStatePayload,
  type TelemetryEventPayload,
  HostMessageTypes,
} from "@zcode/shared";
import { logger, webRemoteControlRelayLogger } from "./logger.js";
import { markMainLaunchAppReady } from "./desktopLaunchMarks.js";
import { createCuaPipFocusRouter, resolveCuaPipWindowKey } from "./cuaPipFocusRouter.js";
import { createDesktopTelemetryFetch } from "./desktopTelemetryFetch.js";
import {
  acknowledgePostUpdateReleaseNotes,
  getAutoUpdaterState,
  hydratePendingPostUpdateReleaseNotes,
  initAutoUpdater,
  onAutoUpdaterStateChanged,
  refreshAutoUpdaterReleaseChannel,
  resolveUpdateFeedSourceFromStartupConfig,
  syncAutoUpdaterStateToWindow,
  syncPostUpdateReleaseNotesToWindow,
  syncReadyUpdateToWindow,
} from "./autoUpdater.js";
import { BroadcastHub } from "./broadcastHub.js";
import { TaskRealtimeBus } from "./taskRealtimeBus.js";
import { createAppLaunchGate } from "./appLaunchGate.js";
import { createAppLaunchCoordinator } from "./appLaunchCoordinator.js";
import { createAppTelemetryRuntime } from "./appTelemetryRuntime.js";
import { createRendererActionTraceBroker } from "./rendererActionTraceBroker.js";
import { createRendererActionTraceExporter } from "./rendererActionTraceExporter.js";
import { registerRendererActionTraceIpc } from "./rendererActionTraceIpc.js";
import { createRendererActionTraceRollout } from "./rendererActionTraceRollout.js";
import {
  resolveAppShutdownPolicy,
  selectAppShutdownPolicy,
  type AppShutdownKind,
} from "./appShutdownPolicy.js";
import { createPrimaryWindowCoordinator } from "./primaryWindowCoordinator.js";
import { createTempTextAttachment } from "./tempTextAttachment.js";
import { flushMainE2ECoverage } from "./e2eCoverage.js";
import { resolveStartupWindowBootstrap, type StartupWindowBootstrap } from "./startupWorkspace.js";
import {
  createStartupDeepLinkConsumptionGate,
  type ExplicitStartupWorkspaceRequest,
  resolveExplicitStartupWorkspaceBootstrap,
} from "./startupWorkspaceDeepLinkGate.js";
import { createWebRemoteControlManager } from "./webRemoteControlManager.js";
import { createNodeWebRemoteControlRelayAuthProvider } from "./webRemoteControlRelayAuthProvider.js";
import { createWebRemoteControlRelayAuthStorageProvider } from "./webRemoteControlRelayAuthStorageProvider.js";
import { createWebRemoteControlFeatureGate } from "./webRemoteControlFeatureGate.js";
import { reconnectWebRemoteControlWorkspaceInRenderer } from "./webRemoteControlRendererReconnect.js";
import { sendWebRemoteControlStatusChangedToWindow } from "./webRemoteControlStatusEvents.js";
import { executeDesktopCommand } from "./desktopCommandHandlers.js";
import { clampDesktopZoomLevel, resolveDesktopZoomLevelFromFactor } from "./desktopZoom.js";
import {
  getDesktopMenuLabel as getDesktopMenuLabelByLocale,
  rebuildApplicationMenu,
  resolveSystemApplicationLocale,
  updateZCodeStdioTapDevMenuState,
} from "./desktopApplicationMenu.js";
import { applyAppIcon } from "./desktopWindowChrome.js";
import { resolveWindowsAppUserModelIdForFlavor } from "../../scripts/desktop-product-identity.mjs";
import type { DesktopWindowSize } from "./desktopWindowSize.js";
import { maybeWarnArchitectureMismatch } from "./desktopArchitectureGuard.js";
import { maybeBlockStartupForForceUpdate } from "./forceUpdateGuard.js";
import { createDesktopTray, updateWindowsDesktopTrayMenu } from "./desktopTray.js";
import {
  createCloseToTrayCapabilityMonitor,
  resolveCloseToTrayBootstrapValue,
  resolveCloseToTrayRuntimeValue,
  resolveCloseToTraySupported,
} from "./desktopTraySupport.js";
import { createWindowsCuaOperationIndicator } from "./windowsCuaOperationIndicator.js";
import {
  configureDockMenu,
  createWindow,
  focusWorkspaceInExistingWindow,
  showCurrentWindowFromDock,
  syncApplicationUnreadBadge,
  handleDesktopWindowCloseRequest,
} from "./desktopWindowLifecycle.js";
import { resolveZCodeBuiltinProviderConfigFilePath } from "./desktopProviderConfig.js";
import {
  getCredentialsDir,
  isDockerDaemonAvailable,
  listSSHConfigAliases,
  listAvailableDockerContainers,
  listAvailableWSLDistros,
  loadHostProcessEnvFromLocalFiles,
  resolveBundledGlmBinaryPath,
  resolveRemoteAssetDirs,
  resolveZCodeEndpointEnvBaseOrigin,
  desktopRuntimeEnv,
  runtimeApplicationName,
  runtimeHomePath,
  runtimeSessionDataPath,
  runtimeUserDataPath,
  shouldUseElectronDefaultUserDataPath,
} from "./desktopRuntimeEnv.js";
import {
  disposeHostProcess,
  disposeHostProcessAndWait,
  listDisposingHostProcesses,
  loadWindow,
  spawnHostProcess,
} from "./desktopHostProcess.js";
import { spawnCronScheduler, type CronSchedulerHandle } from "./desktopCronScheduler.js";
import {
  clearOAuthRoutesForWindow,
  handleDeepLink,
  handleOpenWorkspacePath,
  registerDeepLinkProtocol,
  resolveExternalWorkspaceOpenDialogCopy,
} from "./desktopOAuthDeepLink.js";
import { handleSecondInstanceWorkspaceRequest } from "./desktopSecondInstanceDeepLink.js";
import { installFinderOpenFolderWorkflow } from "./desktopFinderOpenFolderWorkflow.js";
import { installWindowsOpenFolderContextMenu } from "./desktopWindowsOpenFolderContextMenu.js";
import {
  createDeepLinkSingleInstanceData,
  extractWorkspaceOpenPath,
  extractDeepLinkUrlFromArgs,
  extractOpenWorkspacePathFromArgs,
  isWorkspaceOpenUrl,
} from "./desktopDeepLinkUrl.js";
import { createRemoteWorkspaceSessionManager } from "./desktopRemoteSessions.js";
import {
  reportRemoteConnectionStateChangedToArms,
  reportRemoteDisconnectToArms,
  stopRemoteUsageArmsPeriodicSampling,
} from "./desktopRemoteUsageArmsTelemetry.js";
import { resolveCanonicalWslTarget } from "./desktopWslTargetResolver.js";
import {
  listRegisteredHostAgentProcessIds,
  setBrowserUseGuestWebContentsIdsProvider,
} from "./resourceManagerWindow.js";
import { createWebRemoteControlSharedHostAttachments } from "./webRemoteControlSharedHostAttachments.js";
import { createDesktopHelpConfigReader } from "./desktopHelpConfig.js";
import { registerPlatformIpcHandlers } from "./desktopMainIpcPlatform.js";
import {
  loadCliMcpFromUserDirectory,
  migrateLegacyCommonMcp,
  saveCliMcpToUserDirectory,
} from "./mcpUserDirectory/index.js";
import { registerRemoteIpcHandlers } from "./desktopMainIpcRemote.js";
import {
  configureDesktopStabilityTelemetry,
  getStabilityLifecycleScene,
  notifyStabilityAppExit,
  notifyStabilityLifecycle,
  reportAgentProcessExitToArms,
  reportAgentProcessReadyToArms,
  reportAgentProcessStartToArms,
  reportAgentProcessSpawnErrorToArms,
  reportAgentProcessExceptionToArms,
  registerDesktopStabilityMonitors,
  registerStabilityMainWindow,
  scheduleReportPerfAppStartAfterMainViewReady,
} from "./desktopStabilityTelemetry.js";
import {
  configureDesktopResourceTelemetry,
  registerDesktopResourceTelemetry,
  resolveResourceUsageScene,
  stopDesktopResourceTelemetry,
} from "./desktopResourceTelemetry.js";
import { registerRendererHeapSampleIpc } from "./processResourceRendererHeapSource.js";
import {
  registerDesktopZCodeDataSizeTelemetry,
  stopDesktopZCodeDataSizeTelemetry,
} from "./desktopZCodeDataSizeTelemetry.js";
import { configureDesktopMcpTelemetry, reportMcpTelemetryToArms } from "./desktopMcpTelemetry.js";
import {
  configureDesktopNetworkTelemetry,
  registerDesktopNetworkTelemetry,
  stopDesktopNetworkTelemetry,
} from "./desktopNetworkTelemetry.js";
import { applyDesktopChromiumNetworkPolicies } from "./desktopNetworkPolicy.js";
import { applyEmbeddedBrowserPermissionPolicy } from "./embeddedBrowserPermissionPolicy.js";
import { createEmbeddedBrowserSitePermissionStore } from "./embeddedBrowserSitePermissionStore.js";
import {
  createEmbeddedBrowserPermissionUiBridge,
  setActiveEmbeddedBrowserPermissionUiBridge,
} from "./embeddedBrowserPermissionUiBridge.js";
import { mapZCodeEnvToArmsRumEnv } from "@zcode/shared";
import {
  findWindowsProcessesReferencingResourceMarkers,
  probeWindowsPackagedResourceWritable,
  resolveWindowsPackagedResourceLockMarkers,
  runWindowsUpdateProcessCleanup,
  snapshotWindowsPackagedResources,
  WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS,
} from "./windowsInstallResourceLocks.js";
import { mainMemoryDiagnosticsRegistry } from "./mainMemoryDiagnostics.js";
import {
  PLUGIN_SANDBOX_PRIVILEGED_SCHEME,
  getPluginSandboxHost,
  installPluginSandboxHost,
} from "./pluginSandbox/index.js";

registerLocalMediaPreviewScheme(protocol, [PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
const localMediaPreviewPathRegistry = createLocalMediaPreviewPathRegistry();

// E2E lets ChromeDriver manage the remote debugging port. Keeping it fixed at 9229 here would conflict with an already
// running ZCode Dev instance and leave a white screen before the WebDriver session is created.
// Enable the port by default only in local development, and let E2E hand it over to ChromeDriver through an environment variable.
if (!app.isPackaged && process.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT !== "1") {
  app.commandLine.appendSwitch("remote-debugging-port", "9229");
}

app.setName(runtimeApplicationName);
if (runtimeHomePath) {
  app.setPath("home", runtimeHomePath);
}
if (!shouldUseElectronDefaultUserDataPath) {
  if (!runtimeUserDataPath || !runtimeSessionDataPath) {
    throw new Error(
      "Desktop runtime data paths are required when Electron default userData is disabled",
    );
  }
  app.setPath("userData", runtimeUserDataPath);
  app.setPath("sessionData", runtimeSessionDataPath);
}
process.title = runtimeApplicationName;

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection:", reason);
});

const iconPath =
  process.platform === "win32"
    ? app.isPackaged
      ? join(process.resourcesPath, "icon_windows.png")
      : join(import.meta.dirname, "../../build/icon_windows.png")
    : app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(import.meta.dirname, "../../build/icon.png");
const linuxDesktopIntegrationIconPath =
  process.platform === "linux"
    ? app.isPackaged
      ? join(process.resourcesPath, "icon_512x512.png")
      : join(import.meta.dirname, "../../build/icons/512x512.png")
    : iconPath;
let currentApplicationLocale: Locale = DEFAULT_LOCALE;
let closeToTrayOnWindows = true;
// CR-01: tray creation result (module-level, read by the window-close branch). Passing the DBus capability probe does not guarantee that Electron
// successfully created a Tray; confirm the user's entry point exists before hiding the window, or the user will be stranded.
let desktopTrayReady = false;
// Close-to-tray capability monitor (spec: docs/desktop/linux-close-to-tray.md).
// The Linux close handler is synchronous and can only read cached state; default safely to "unavailable" until the first startup probe completes.
const closeToTrayCapabilityMonitor = createCloseToTrayCapabilityMonitor({
  platform: process.platform,
});
// keep-awake: global keepAwakeWhileRunning switch. When enabled, main holds
// powerSaveBlocker("prevent-app-suspension") to prevent idle system sleep (it cannot prevent lid-close/manual sleep).
// It is no longer tied to idle-task activity; the Settings > General page and Automations entry mirror the same setting.
let keepAwakeWhileRunning = false;
let powerSaveBlockerId: number | null = null;
function reconcileKeepAwakeBlocker(): void {
  const shouldBlock = keepAwakeWhileRunning;
  if (shouldBlock && powerSaveBlockerId === null) {
    powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    logger.info(`[keep-awake] powerSaveBlocker started id=${powerSaveBlockerId}`);
  } else if (!shouldBlock && powerSaveBlockerId !== null) {
    try {
      powerSaveBlocker.stop(powerSaveBlockerId);
    } catch {
      // Ignore: the ID may no longer be valid.
    }
    logger.info(`[keep-awake] powerSaveBlocker stopped id=${powerSaveBlockerId}`);
    powerSaveBlockerId = null;
  }
}

const embeddedBrowserDialogController = new EmbeddedBrowserJavaScriptDialogController({
  iconPath,
  getLocale: () => currentApplicationLocale,
  logger,
});
ipcMain.on(PlatformChannels.EmbeddedBrowserJavaScriptDialog, (event, payload: unknown) => {
  event.returnValue = embeddedBrowserDialogController.handleDialogRequest(
    event.sender.id,
    event.senderFrame?.url ?? "",
    payload,
  );
});
// browser-use CDP-on-guest pivot: main manages each `<webview>` guest's webContents + CDP by key and provides a
// ControlledView to the executor. All execute/attach paths go through this manager.
// Although BrowserGuestManager is a main singleton, each tab owner carries window/workspace/session/generation; create/close
// are sent only to the owner window, preventing the old all-window broadcast from attaching across windows.
const browserScreenshotSurfaceCoordinator = createDesktopBrowserScreenshotSurfaceCoordinator({
  fromId: (windowId) => BrowserWindow.fromId(windowId),
  fromWebContentsId: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  log: (message) => logger.debug(message),
  warn: (message) => logger.warn(message),
});
const browserGuestManager = new BrowserGuestManager(
  (msg) => logger.debug(msg),
  undefined,
  (tabId, owner) => {
    const win = owner ? BrowserWindow.fromId(owner.windowId) : null;
    if (win && !win.isDestroyed()) {
      win.webContents.send(
        PlatformChannels.BrowserViewCloseTab,
        buildBrowserViewCloseTabNotification(tabId, owner),
      );
    }
  },
  (tabId, owner) => {
    const win = BrowserWindow.fromId(owner.windowId);
    if (win && !win.isDestroyed()) {
      win.webContents.send(PlatformChannels.BrowserViewReady, {
        workspaceKey: owner.workspaceKey,
        ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
        sessionId: owner.sessionId,
        tabId,
        browserId: owner.browserId,
        browserGeneration: owner.browserGeneration,
      });
    }
  },
  (visible, owner, tabId) => {
    const win = BrowserWindow.fromId(owner.windowId);
    if (win && !win.isDestroyed()) {
      win.webContents.send(PlatformChannels.BrowserViewVisibility, {
        visible,
        workspaceKey: owner.workspaceKey,
        remoteSessionId: owner.remoteSessionId,
        sessionId: owner.sessionId,
        ...(tabId ? { tabId } : {}),
        browserId: owner.browserId,
        browserGeneration: owner.browserGeneration,
      });
    }
  },
  (viewport, owner, tabId) => {
    const win = BrowserWindow.fromId(owner.windowId);
    if (win && !win.isDestroyed()) {
      win.webContents.send(PlatformChannels.BrowserViewViewportChanged, {
        workspaceKey: owner.workspaceKey,
        ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
        sessionId: owner.sessionId,
        tabId,
        browserId: owner.browserId,
        browserGeneration: owner.browserGeneration,
        viewport,
      });
    }
  },
  (base64Png, target) => {
    const source = nativeImage.createFromBuffer(Buffer.from(base64Png, "base64"));
    if (source.isEmpty()) return undefined;
    const resized = source.resize({
      width: target.width,
      height: target.height,
      quality: "best",
    });
    if (resized.isEmpty()) return undefined;
    return resized.toPNG().toString("base64");
  },
  browserScreenshotSurfaceCoordinator,
  {
    // Do not restore Browser shell/pageState across processes, preserving the semantics that a full exit clears state and
    // preventing a restored shell from attaching twice to a new webview. Therefore, do not inject recoveryStore; retain
    // in-process residency events for compatibility with the existing IPC layer.
    onSuspendTabRequested: (payload) => {
      const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewSuspend, payload);
      }
    },
    onRestoreTabRequested: (payload) => {
      const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewRestore, payload);
      }
    },
    onResidencyChanged: (payload) => {
      const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewRestore, payload);
      }
    },
    onRecoveryOrphanCloseRequested: ({ tabId, reason }) => {
      const tabOwner = browserGuestManager.getTabOwner(tabId);
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(PlatformChannels.BrowserViewCloseTab, {
          tabId,
          reason,
        });
      }
    },
    warn: (message) => logger.warn(message),
    recording: {
      createRecorder: (input) =>
        createElectronBrowserWebmRecorder(input, (message) => logger.debug(message)),
    },
  },
  // Transparent presentation for hidden-window screenshots: use showInactive + opacity 0 to request frames during capture.
  (windowId) => BrowserWindow.fromId(windowId),
);
setBrowserUseGuestWebContentsIdsProvider(() => browserGuestManager.listGuestWebContentsIds());

// browser-use: execute browser commands with diagnostic logs (shared by both spawnHostProcess wiring sites).
// Log entry/exit to help locate stalls (such as a hanging navigate loadURL or CDP error).
// CDP-on-guest pivot: execute through browserGuestManager; no need to pass win because attachGuest already associates the guest.
async function runBrowserCommandOnView(params: {
  win: BrowserWindow;
  requestId: string;
  browserId?: string;
  browserGeneration?: number;
  sessionId: string;
  turnId?: string;
  workspaceKey?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  sessionContext?: "live" | "cached";
  command: unknown;
}): Promise<{ ok: boolean; [k: string]: unknown }> {
  const endDialogAutomation = embeddedBrowserDialogController.beginAutomation(params.win.id);
  const command = params.command as { method?: string; tabId?: unknown } | null;
  const method = command?.method ?? "?";
  const workspaceKey =
    params.workspaceIdentity?.trim() ||
    params.workspaceKey ||
    params.workspacePath ||
    params.sessionId;
  const requestedTabId = resolveBrowserOperationTabId(command);
  const resetsResizeBaseline = browserOperationResetsResizeBaseline(command);
  const sendOperation = (tabId: string) => {
    if (params.win.isDestroyed()) return;
    params.win.webContents.send(PlatformChannels.BrowserViewOperation, {
      workspaceKey,
      ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
      sessionId: params.sessionId,
      tabId,
      browserId: params.browserId ?? "legacy-iab",
      browserGeneration: params.browserGeneration ?? 0,
      resetsResizeBaseline,
    });
  };
  // Interaction note: most Tab APIs carry tabId explicitly, so the operation icon can light up before command execution.
  // Compatible newTab/default-tab calls must wait for the manager's actual meta.tabId rather than guessing the tab identity.
  if (requestedTabId) sendOperation(requestedTabId);
  logger.debug(
    `[browser-use] execute start browserId=${params.browserId ?? "legacy-iab"} sessionId=${params.sessionId} method=${method}`,
  );
  try {
    const result = await browserGuestManager.execute(
      {
        requestId: params.requestId,
        browserId: params.browserId ?? "legacy-iab",
        browserGeneration: params.browserGeneration ?? 0,
        windowId: params.win.id,
        workspaceKey,
        sessionId: params.sessionId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
        clientMode: params.clientMode ?? "desktop-continuous",
      },
      params.command as Parameters<typeof browserGuestManager.execute>[1],
    );
    logger.debug(
      `[browser-use] execute done sessionId=${params.sessionId} method=${method} ok=${result.ok} elapsedMs=${(result as { elapsedMs?: number }).elapsedMs ?? "?"}`,
    );
    if (!requestedTabId) {
      const resolvedTabId = resolveBrowserOperationTabId(command, result);
      if (resolvedTabId) sendOperation(resolvedTabId);
    }
    return result;
  } catch (error) {
    logger.error(
      `[browser-use] execute threw sessionId=${params.sessionId} method=${method}:`,
      error,
    );
    throw error;
  } finally {
    endDialogAutomation();
  }
}
let currentDesktopZoomLevel = 0;
let currentDesktopWindowSize: DesktopWindowSize | undefined;
const preloadPath = join(import.meta.dirname, "../preload/index.cjs");
const settingsFile = join(homedir(), ".zcode", "v2", "setting.json");
let activeAppShutdownPolicy = resolveAppShutdownPolicy("normal", process.platform);
let activeAppShutdownKind: AppShutdownKind | null = null;
const WINDOWS_AGENT_FORCE_KILL_TIMEOUT_MS = 2_000;

const broadcastHub = new BroadcastHub();
const taskRealtimeBus = new TaskRealtimeBus({ logger });
// Memory diagnostic counters: desktopResourceTelemetry collects and writes to the main log every 60s.
// The will-download listener count helps detect listeners left on defaultSession after windows close.
mainMemoryDiagnosticsRegistry.register("taskBus", () => taskRealtimeBus.collectMemoryDiagnostics());
mainMemoryDiagnosticsRegistry.register("broadcast", () => broadcastHub.collectMemoryDiagnostics());
mainMemoryDiagnosticsRegistry.register("guest", () =>
  browserGuestManager.collectMemoryDiagnostics(),
);
mainMemoryDiagnosticsRegistry.register("app", () => ({
  windows: BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length,
  willDownloadListeners: session.defaultSession.listenerCount("will-download"),
}));
const hostProcessLocalEnv = loadHostProcessEnvFromLocalFiles();
interface RuntimeProcessEnvPreparation {
  patchPromise: Promise<Record<string, string>>;
  fallbackPatch: Record<string, string>;
}

let runtimeProcessEnvPrewarmSequence = 0;
function createRuntimeProcessEnvPreparation(): RuntimeProcessEnvPreparation {
  const prewarmId = ++runtimeProcessEnvPrewarmSequence;
  const startedAt = Date.now();
  // Windows process.env preserves Path's original casing, but a plain object is no longer case-insensitive.
  // Merge dotenv first and the real process environment second, then normalize to one PATH to preserve the old Host inheritance precedence.
  const baseEnv = normalizeRuntimeProcessEnv(
    {
      ...hostProcessLocalEnv,
      ...process.env,
    },
    process.platform,
  );
  const fallbackPatch = buildRuntimeProcessEnvPatch(baseEnv, null, {
    platform: process.platform,
  });
  const patchPromise = captureLoginShellEnvSnapshot({
    baseEnv,
    platform: process.platform,
  }).then(
    (snapshot) => {
      const patch = buildRuntimeProcessEnvPatch(baseEnv, snapshot, {
        platform: process.platform,
      });
      if (process.platform !== "win32" && !snapshot) {
        logger.warn(
          `[startup] login shell env unavailable id=${prewarmId}; using shell-free fallback after ${Date.now() - startedAt}ms`,
        );
        return patch;
      }
      logger.info(
        `[startup] runtime process env prepared asynchronously id=${prewarmId} in ${Date.now() - startedAt}ms`,
      );
      return patch;
    },
    (error) => {
      logger.warn(
        `[startup] runtime process env prewarm failed id=${prewarmId}; using shell-free fallback`,
        error,
      );
      return fallbackPatch;
    },
  );
  return { patchPromise, fallbackPatch };
}

// Start collecting for the first window when Main is imported; refresh separately for later windows instead of reusing
// the shell snapshot from process startup forever.
let initialRuntimeProcessEnvPreparation: RuntimeProcessEnvPreparation | null =
  createRuntimeProcessEnvPreparation();
function takeRuntimeProcessEnvPreparation(): RuntimeProcessEnvPreparation {
  const initialPreparation = initialRuntimeProcessEnvPreparation;
  if (initialPreparation) {
    initialRuntimeProcessEnvPreparation = null;
    return initialPreparation;
  }
  return createRuntimeProcessEnvPreparation();
}
const forceQuitRef = { current: false };
const explicitQuitRef = { current: false };
let appQuitPreparationInFlight: Promise<void> | null = null;
let hasPreparedAppQuit = false;
const windowWorkspaceMap = new Map<number, Set<string>>();
const windowTaskRealtimeHostIdMap = new Map<number, string>();
const windowUnreadCountMap = new Map<number, number>();
const windowHostProcessMap = new Map<number, ElectronUtilityProcess>();
const cuaPipFocusRouter = createCuaPipFocusRouter({
  send: (windowId, event) => {
    windowHostProcessMap.get(windowId)?.postMessage({
      type: HostMessageTypes.CuaPipFocusChanged,
      event,
    });
  },
});
const hostRunningTaskCountMap = new Map<ElectronUtilityProcess, number>();
const windowsCuaOperationIndicator = createWindowsCuaOperationIndicator({
  platform: process.platform,
  getLocale: () => currentApplicationLocale,
  logger,
});

// Handle for the persistent cron scheduler process; start after app ready and destroy before exit.
let cronScheduler: CronSchedulerHandle | null = null;
// Forward scheduled-task dispatch results from host → main to the scheduler for settlement. The module variable avoids coupling to spawn order.
function forwardCronRunResult(
  result: Parameters<CronSchedulerHandle["handleCronRunResult"]>[0],
): void {
  cronScheduler?.handleCronRunResult(result);
}
function forwardOffPeakRunResult(
  result: Parameters<CronSchedulerHandle["handleOffPeakRunResult"]>[0],
): void {
  cronScheduler?.handleOffPeakRunResult(result);
}
function wakeCronScheduler(automationId: string): void {
  cronScheduler?.wake(automationId);
}
function wakeOffPeakScheduler(offPeakTaskId?: string): void {
  // Reuse the scheduler-wake channel (a tick covers both cron and off-peak branches); only the log label differs.
  cronScheduler?.wake(`offpeak:${offPeakTaskId ?? "sync"}`);
}
// Select a local host for dispatch: for this release, a local workspace starts/reuses an agent by path through any local window host's createTask.
function resolveCronDispatchHost(): ElectronUtilityProcess | null {
  const first = windowHostProcessMap.values().next();
  return first.done ? null : first.value;
}
const disposingHostProcessTimers = new WeakMap<
  ElectronUtilityProcess,
  ReturnType<typeof setTimeout>
>();
const webRemoteControlManagerRef = {
  current: null as ReturnType<typeof createWebRemoteControlManager> | null,
};
let updateStatusWindow: BrowserWindow | null = null;
const UPDATE_STATUS_WINDOW_WIDTH = 512;
const UPDATE_STATUS_WINDOW_COMPACT_HEIGHT = 205;
const UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT = 224;
const UPDATE_STATUS_WINDOW_READY_HEIGHT = UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT - 54;
const UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION = { x: 10, y: 10 } as const;
const mainSettingService = createSettingService();
const webRemoteControlCredentialService = createCredentialService();
const appLaunchGate = createAppLaunchGate();
const appLaunchCoordinator = createAppLaunchCoordinator(appLaunchGate);
const appTelemetryCredentialService = createCredentialService();
async function resolveCurrentZCodeEndpointOrigin() {
  return resolveZCodeEndpointOrigin({
    env: ZCODE_ENV,
    envBaseOrigin: resolveZCodeEndpointEnvBaseOrigin(hostProcessLocalEnv),
    overrideOrigin: (await mainSettingService.get()).zcodeEndpointOrigin,
  });
}
let desktopContextPromptRollout: ReturnType<typeof createDesktopContextPromptRollout> | undefined;
function resolveDesktopContextPromptEnabledForHost(): boolean {
  const rollout = desktopContextPromptRollout;
  if (!rollout) {
    return false;
  }
  // Host creation also triggers stale-data refresh, but reads only the current snapshot; a network request must not block Local/Remote Host.
  void rollout.refresh();
  return rollout.getSnapshot().enabled;
}

// Bounded rollout decision gate before the first Host is created. Host/Agent presentation surfaces are frozen at process
// startup (top-level const in services/node.ts + CLI --surface), while the rollout request is out-of-band and does not block Host.
// If the first Host forks before the request resolves, enabled:true cannot reach the already-frozen Host/Agent.
// Give a successful result a bounded path to take effect: await the decision once before the first Host fork (≤2s), then
// continue with the current snapshot on failure/timeout (desktopContextPrompt fails open). A permanent first-only latch
// means later Host forks await an already-resolved promise (nearly 0ms), and each resolve*ForHost() synchronously reads the refreshed live snapshot.
const DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS = 2_000;
let firstHostSpawnDecisionPromise: Promise<void> | null = null;
function awaitFirstHostSpawnDecision(): Promise<void> {
  if (firstHostSpawnDecisionPromise) {
    return firstHostSpawnDecisionPromise;
  }
  firstHostSpawnDecisionPromise = (async () => {
    const rollout = desktopContextPromptRollout;
    if (!rollout) {
      return;
    }
    try {
      const decision = await rollout.awaitFirstDecision(
        DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS,
      );
      logger.info("[desktop-context-prompt] first host spawn decision resolved", {
        enabled: decision.enabled,
        configVersion: decision.configVersion,
      });
    } catch (error) {
      // awaitFirstDecision never rejects (refresh catches internally and falls back to a snapshot on timeout); this is only a safeguard.
      logger.warn("[desktop-context-prompt] first host spawn decision failed, fail-open", {
        error,
      });
    }
  })();
  return firstHostSpawnDecisionPromise;
}
const appTelemetryCore = createTelemetryCore({
  loadUserId: createTelemetryUserIdLoader(appTelemetryCredentialService),
  loadAuthorization: createTelemetryAuthorizationLoader(appTelemetryCredentialService),
  loadMarketingParams: createTelemetryMarketingParamsLoader(appTelemetryCredentialService),
  resolveZCodeEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
  fetchImpl: createDesktopTelemetryFetch(net),
});
const appTelemetryRuntime = createAppTelemetryRuntime({
  telemetryCore: appTelemetryCore,
  appLaunchCoordinator,
});

function reportRemoteUsageEventForRenderer(rendererId: number, event: TelemetryEventPayload): void {
  const context =
    appTelemetryRuntime.getRendererContext(rendererId) ??
    appTelemetryRuntime.getLatestRendererContext();
  if (!context) {
    logger.warn("[remote-usage-telemetry] renderer context unavailable", {
      elementName: event.elementName,
      rendererId,
    });
    return;
  }
  // TelemetryCore records one redacted warning for the final failure; this only isolates the remote connection's primary path.
  void appTelemetryCore.reportEvent({ context, ...event }).catch(() => {});
}

function syncAppTelemetryInteractiveState(): void {
  appTelemetryRuntime.setInteractive(
    getApplicationWindowsExcludingCuaIndicator().some(
      (win) => !win.isDestroyed() && win.isVisible() && win.isFocused(),
    ),
  );
  // Logout/account switching happens in the host child process, with no immediate signal to main; refresh ARMS user.name as a fallback when a window gains focus.
  void armsUserIdentitySync.refresh();
}

app.on("browser-window-focus", (_event, win) => {
  syncAppTelemetryInteractiveState();
  rebuildMenu();
  // ZCode windows without a Host, such as Settings/Update, also count as foreground. The router first clears the old
  // workspace Host to null, then silently discards the new no-Host window, preventing PiP from continuing to show the old session.
  cuaPipFocusRouter.focusWindow(resolveCuaPipWindowKey(win));
});
app.on("browser-window-blur", (_event, win) => {
  syncAppTelemetryInteractiveState();
  cuaPipFocusRouter.blurWindow(resolveCuaPipWindowKey(win));
});
app.on("browser-window-created", (_event, win) => {
  const windowKey = resolveCuaPipWindowKey(win);
  win.once("closed", () => cuaPipFocusRouter.removeWindow(windowKey));
});

const remoteSessionManager = createRemoteWorkspaceSessionManager({
  logger,
  windowHostProcessMap,
  resolveRemoteAssetDirs: () =>
    resolveRemoteAssetDirs({ locale: currentApplicationLocale }, hostProcessLocalEnv),
  resolveWslTarget: resolveCanonicalWslTarget,
  reportRemoteConnectionStateChanged: reportRemoteConnectionStateChangedToArms,
  reportRemoteDisconnect: reportRemoteDisconnectToArms,
  webRemoteControlManagerRef,
});

const webRemoteControlAuthProvider = createNodeWebRemoteControlRelayAuthProvider();
const webRemoteControlSharedHostAttachments = createWebRemoteControlSharedHostAttachments({
  windowHostProcessMap,
  attachRemoteWorkspaceSessionHost: remoteSessionManager.attachRemoteWorkspaceSessionHost,
  logger,
});
const deviceMid = ensureDesktopDeviceMidSync();
// Help configuration is publicly readable and must not reuse the rollout response cache that includes account authentication.
const readHelpConfig = createDesktopHelpConfigReader({
  appVersion: ZCODE_VERSION || app.getVersion(),
  deviceMid,
  resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
});
// Both rollouts share the same /api/v1/client/configs fetcher (request parameters and authentication are identical;
// each has its own cache/deduplication, and the server distinguishes features by data.configs.<key>).
const electronClientConfigsFetcher = createElectronDesktopContextPromptConfigFetcher({
  appVersion: ZCODE_VERSION || app.getVersion(),
  deviceMid,
  resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
});
desktopContextPromptRollout = createDesktopContextPromptRollout({
  fetchConfig: electronClientConfigsFetcher,
  logger,
});
const rendererActionTraceRollout = createRendererActionTraceRollout({
  fetchConfig: electronClientConfigsFetcher,
  logger,
});
const localTtftExporter = createLocalTtftExporter({
  env: { ...hostProcessLocalEnv, ...process.env },
  version: ZCODE_VERSION || app.getVersion(),
  logger,
});
ipcMain.on(PlatformChannels.ReportLocalTtftBatch, (_event, batch: unknown) =>
  localTtftExporter.enqueue(batch),
);
const rendererActionTraceBroker = createRendererActionTraceBroker({
  exporter: createRendererActionTraceExporter({
    ...hostProcessLocalEnv,
    ...process.env,
  }),
  logger,
});
let disposeRendererActionTraceIpc: (() => void) | undefined;
const armsUserIdentitySync = createArmsUserIdentitySync({
  deviceMid,
  setUser: (user) => armsRum.setConfig("user", user),
});
const webRemoteControlAppVersion = ZCODE_VERSION || app.getVersion();
const defaultZCodeEndpointUrls = buildZCodeEndpointUrls(DEFAULT_ZCODE_ENDPOINT_ORIGIN, {
  appVersion: webRemoteControlAppVersion,
});
const webRemoteControlRelayWsEnvOverride =
  process.env["ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL"]?.trim();
const webRemoteControlUrlEnvOverride = process.env["ZCODE_WEB_REMOTE_CONTROL_URL"]?.trim();
// Fork release builds bake public self-hosted defaults at build time so an app launched from
// Finder/Explorer reaches its own relay without shell env; an explicit runtime env still wins,
// keeping local repointing of a release build possible.
const webRemoteControlReleaseRelayWsUrl = ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL_DEFAULT || null;
const webRemoteControlReleaseWebUrl = ZCODE_WEB_REMOTE_CONTROL_URL_DEFAULT || null;

function extractOpenWorkspacePathFromDeepLinkUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    return isWorkspaceOpenUrl(parsedUrl) ? extractWorkspaceOpenPath(parsedUrl) : null;
  } catch {
    return null;
  }
}

const startupOpenWorkspaceArgPath = extractOpenWorkspacePathFromArgs(process.argv);
const startupProtocolUrl = extractDeepLinkUrlFromArgs(process.argv);
const startupDeepLinkWorkspacePath = startupOpenWorkspaceArgPath
  ? null
  : extractOpenWorkspacePathFromDeepLinkUrl(startupProtocolUrl ?? "");
const startupDeepLinkConsumptionGate = createStartupDeepLinkConsumptionGate(startupProtocolUrl);
let startupOpenWorkspaceRequest: ExplicitStartupWorkspaceRequest | null =
  startupOpenWorkspaceArgPath
    ? { path: startupOpenWorkspaceArgPath, source: "open-workspace-arg" }
    : startupDeepLinkWorkspacePath
      ? { path: startupDeepLinkWorkspacePath, source: "deep-link" }
      : null;

const webRemoteControlManager = createWebRemoteControlManager({
  getEndpointUrls: async () => {
    const derived = buildZCodeEndpointUrls(await resolveCurrentZCodeEndpointOrigin(), {
      appVersion: webRemoteControlAppVersion,
    });
    return {
      ...derived,
      relayWsUrl: resolveWebRemoteControlRelayWsUrl({
        endpointOrigin: derived.origin,
        overrideUrl: webRemoteControlRelayWsEnvOverride,
        defaultUrl: webRemoteControlReleaseRelayWsUrl,
      }),
      remoteUrl:
        webRemoteControlUrlEnvOverride || webRemoteControlReleaseWebUrl || derived.remoteUrl,
    };
  },
  relayWsUrl: resolveWebRemoteControlRelayWsUrl({
    endpointOrigin: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
    overrideUrl: webRemoteControlRelayWsEnvOverride,
    defaultUrl: webRemoteControlReleaseRelayWsUrl,
  }),
  mobileRemoteControlUrl:
    webRemoteControlUrlEnvOverride ||
    webRemoteControlReleaseWebUrl ||
    defaultZCodeEndpointUrls.remoteUrl,
  deviceMid,
  deviceName: hostname(),
  appVersion: webRemoteControlAppVersion,
  authProvider: webRemoteControlAuthProvider,
  authStorageProvider: createWebRemoteControlRelayAuthStorageProvider({
    credentialService: webRemoteControlCredentialService,
    loadSettings: () => mainSettingService.get(),
    patchSettings: (patch) => mainSettingService.update(patch),
    logger,
  }),
  startupRestoreStorageProvider: {
    load: async () => (await mainSettingService.get()).webRemoteControlLastEnabledContext,
    save: async (context) => {
      await mainSettingService.update({
        webRemoteControlLastEnabledContext: {
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          initialTaskId: context.initialTaskId,
        },
      });
    },
    clear: async () => {
      await mainSettingService.update({
        webRemoteControlLastEnabledContext: undefined,
      });
    },
  },
  featureGate: createWebRemoteControlFeatureGate(),
  logger,
  relayMessageLogger: webRemoteControlRelayLogger,
  platformHandlers: {
    isDockerAvailable: () => isDockerDaemonAvailable(),
    listWSLDistros: () => listAvailableWSLDistros(),
    listDockerContainers: () => listAvailableDockerContainers(),
    listSSHConfigAliases: () => listSSHConfigAliases(),
    createTempTextAttachment: (payload) => createTempTextAttachment(payload),
    loadMcpFromUserDirectory: (payload) => loadCliMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: async (payload) => {
      try {
        await saveCliMcpToUserDirectory(payload);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[web-remote-control] MCP save failed", message);
        return { success: false, error: message };
      }
    },
    migrateLegacyCommonMcp: (payload) => migrateLegacyCommonMcp(payload),
  },
  reconnectWorkspace: reconnectWebRemoteControlWorkspaceInRenderer,
  reportRendererTelemetryEvent: (event) => {
    void appTelemetryCore.reportEvent(event).catch(() => {});
  },
  reportRemoteUsageEvent: (windowId, event) => {
    const win = BrowserWindow.fromId(windowId);
    if (!win || win.webContents.isDestroyed()) {
      return;
    }
    reportRemoteUsageEventForRenderer(win.webContents.id, event);
  },
  onStatusChanged: (windowId, status) => {
    sendWebRemoteControlStatusChangedToWindow(BrowserWindow.fromId(windowId), status);
  },
  attachWorkspaceHost: webRemoteControlSharedHostAttachments.attachWorkspaceHost,
  releaseWorkspaceHostAttachment: webRemoteControlSharedHostAttachments.releaseAttachment,
  disposeWorkspaceHostAttachmentsForWindow: (windowId) =>
    webRemoteControlSharedHostAttachments.disposeWindow(windowId),
  disposeWorkspaceHostAttachmentsForRemoteSession: (remoteSessionId) =>
    webRemoteControlSharedHostAttachments.disposeRemoteSession(remoteSessionId),
});
webRemoteControlManagerRef.current = webRemoteControlManager;

let forceUpdateMainWindowCreationBlocked = false;

function resolveExternalWorkspaceConfirmationCopy() {
  const effectiveLocale =
    currentApplicationLocale === DEFAULT_LOCALE && app.isReady()
      ? resolveSystemApplicationLocale()
      : currentApplicationLocale;
  return resolveExternalWorkspaceOpenDialogCopy(effectiveLocale);
}

function focusForceUpdateGateWindow() {
  const gateWindow = getApplicationWindowsExcludingCuaIndicator()[0];
  if (!gateWindow) {
    return;
  }

  if (gateWindow.isMinimized()) {
    gateWindow.restore();
  }
  if (!gateWindow.isVisible()) {
    gateWindow.show();
  }
  gateWindow.focus();
}

const primaryWindowCoordinator = createPrimaryWindowCoordinator({
  listWindows: getApplicationWindowsExcludingCuaIndicator,
  resolveStartupWindowBootstrap: () => {
    if (startupOpenWorkspaceRequest) {
      const request = startupOpenWorkspaceRequest;
      startupOpenWorkspaceRequest = null;
      startupDeepLinkConsumptionGate.markStartupRequestConsumed(request);
      const explicitBootstrap = resolveExplicitStartupWorkspaceBootstrap(request, {
        confirmationCopy: resolveExternalWorkspaceConfirmationCopy(),
        logger,
      });
      if (explicitBootstrap) {
        return Promise.resolve(explicitBootstrap);
      }
    }

    return resolveStartupWindowBootstrap({
      settingsFile,
      // dataBaseDir may be overridden during bootstrap settings, so read it when resolving the startup workspace.
      conversationWorkspaceDir: getConversationWorkspaceDir(),
      logger,
    });
  },
  createWindow: (startupBootstrap) => {
    createWindowInstance(startupBootstrap);
  },
  canCreateWindow: (reason) => {
    if (!forceUpdateMainWindowCreationBlocked) {
      return true;
    }

    // Once a forced upgrade is required, Dock/tray/activate/deep links must not bypass the app-ready gate and create the old main window.
    logger.warn(`[force-update] 已阻止主窗口创建入口：${reason}`);
    focusForceUpdateGateWindow();
    return false;
  },
  logger,
});

function markForceQuit(reason: string) {
  if (forceQuitRef.current) {
    return;
  }

  forceQuitRef.current = true;
  logger.info(`[app-quit] forceQuit enabled (${reason})`);
}

function markExplicitQuit(reason: string) {
  explicitQuitRef.current = true;
  logger.info(`[app-quit] explicit quit requested (${reason})`);
}

function syncCloseToTrayOnWindows(value: unknown) {
  if (typeof value !== "boolean") {
    return;
  }

  closeToTrayOnWindows = value;
  logger.info(`[settings] closeToTrayOnWindows=${value}`);
}

function syncImmediateAppSettings(patch: Partial<AppSettings>) {
  syncCloseToTrayOnWindows(patch.closeToTrayOnWindows);

  if (typeof patch.keepAwakeWhileRunning === "boolean") {
    keepAwakeWhileRunning = patch.keepAwakeWhileRunning;
    reconcileKeepAwakeBlocker();
  }

  if (typeof patch.receivePreviewUpdates === "boolean") {
    // receivePreviewUpdates is written to setting.json by the renderer host.
    // The main-process updater does not subscribe to host setting changes, so refresh the manifest channel through the immediate syncAppSettings path.
    refreshAutoUpdaterReleaseChannel(
      patch.receivePreviewUpdates,
      "settings receivePreviewUpdates changed",
    );
  }

  if (patch.shortcutBindings !== undefined) {
    // Shortcut rebinding:
    // persistence is complete (useSettings.update awaits settingService.update before entering this channel).
    // Rebuild application-menu accelerators and notify every window to refresh its settings snapshot, so other windows'
    // useAppKeyboard bindings and Settings pages update too. This follows the setAutoDownloadAndInstallUpdates broadcast pattern.
    rebuildMenu();
    for (const win of getApplicationWindowsExcludingCuaIndicator()) {
      if (!win.isDestroyed()) {
        win.webContents.send(PlatformChannels.SettingsChanged);
      }
    }
  }
}

async function getAutoUpdatePreferences() {
  const settings = await mainSettingService.get();
  return {
    autoDownloadAndInstallUpdates: settings.autoDownloadAndInstallUpdates ?? false,
  };
}

async function setAutoDownloadAndInstallUpdates(enabled: boolean) {
  await mainSettingService.update({
    autoDownloadAndInstallUpdates: enabled,
  });
  syncImmediateAppSettings({
    autoDownloadAndInstallUpdates: enabled,
  });
  for (const win of getApplicationWindowsExcludingCuaIndicator()) {
    if (!win.isDestroyed()) {
      win.webContents.send(PlatformChannels.SettingsChanged);
    }
  }
}

async function prepareAppQuit(reason: string, kind: AppShutdownKind = "normal"): Promise<void> {
  const selection = selectAppShutdownPolicy(activeAppShutdownKind, kind, process.platform);
  activeAppShutdownKind = selection.kind;
  activeAppShutdownPolicy = selection.policy;
  if (selection.upgraded && (hasPreparedAppQuit || appQuitPreparationInFlight)) {
    // An update request may arrive after the ordinary exit barrier. Changing the global policy cannot extend an existing 4s timer;
    // explicitly preserve its budget and let the update continue to fail-open resource scanning and the installer.
    logger.warn(
      `[app-quit] update install joined an existing normal shutdown barrier (${reason}); existing timers keep their original budget`,
    );
  }
  if (hasPreparedAppQuit) {
    return;
  }
  if (appQuitPreparationInFlight) {
    await appQuitPreparationInFlight;
    return;
  }

  markForceQuit(reason);
  windowsCuaOperationIndicator.dispose();
  browserScreenshotSurfaceCoordinator.dispose();
  // Bug cause: after resource samples changed to a five-minute window, stopping directly on exit discarded incomplete windows.
  // On exit, flush only existing role/Agent memory windows; do not start new sampling, directory scans, or external probes.
  stopDesktopResourceTelemetry({ flushPendingWindows: true });
  stopDesktopZCodeDataSizeTelemetry();
  stopDesktopNetworkTelemetry();
  stopRemoteUsageArmsPeriodicSampling();
  disposeRendererActionTraceIpc?.();
  disposeRendererActionTraceIpc = undefined;
  notifyStabilityAppExit(
    getStabilityLifecycleScene() === "update_install" ? "update_install" : "app_quit",
    logger,
    { exitCode: 0, exitKind: "normal" },
  );

  const cronSchedulerToDispose = cronScheduler;
  cronScheduler = null;

  const hostProcesses = [
    ...new Set([...windowHostProcessMap.values(), ...listDisposingHostProcesses()]),
  ];
  logger.info(
    `[app-quit] waiting for host process cleanup (${reason}), kind=${activeAppShutdownKind}, hosts=${hostProcesses.length}, forceKillDelayMs=${activeAppShutdownPolicy.forceKillDelayMs}, waitTimeoutMs=${activeAppShutdownPolicy.waitTimeoutMs}`,
  );

  appQuitPreparationInFlight = Promise.all([
    // Starting window-size writes after the exit barrier may leave setting.json.lock before app.exit.
    // Size is saved during resize debounce or maximize-state changes, so the exit barrier must not start another write.
    // Fix cause: Main used to exit without waiting for an in-flight /event/report, dropping events during normal shutdown.
    // Enter the existing barrier in parallel with other owners and wait at most 2 seconds, avoiding serial telemetry delay.
    appTelemetryCore.flushPendingReports({ timeoutMs: 2_000 }),
    localTtftExporter.shutdown(),
    rendererActionTraceBroker.shutdown().catch((error) => {
      logger.warn(`[app-quit] renderer action trace shutdown failed (${reason}):`, error);
    }),
    // The old flow waited for Cron's 1.5s deadline before starting the Host timer, serially exceeding the declared
    // 4.5s/9s total exit budget. These owners have no shutdown dependency, so enter the same barrier in parallel.
    (async () => {
      try {
        await cronSchedulerToDispose?.dispose();
      } catch (error) {
        logger.warn(`[app-quit] cron scheduler dispose failed (${reason}):`, error);
      }
    })(),
    // Window Hosts own remote sessions, attachments, and transports. First clear Main's request associations here, then
    // the per-window Host shutdown barriers below release the actual connections and Agents.
    remoteSessionManager.disposeAllAndWaitForAppShutdown(reason),
    ...hostProcesses.map((child, index) =>
      disposeHostProcessAndWait(
        child,
        `${reason}-${index + 1}`,
        disposingHostProcessTimers,
        logger,
        {
          forceKillDelayMs: activeAppShutdownPolicy.forceKillDelayMs,
          waitTimeoutMs: activeAppShutdownPolicy.waitTimeoutMs,
        },
      ),
    ),
  ])
    .then(() => {
      logger.info(`[app-quit] host process cleanup completed (${reason})`);
    })
    .catch((error) => {
      logger.error(`[app-quit] host process cleanup failed (${reason}):`, error);
    })
    .finally(() => {
      // before-quit is synchronous. If main exits after sending only Dispose, host may be killed before the Agent process
      // tree finishes its SIGTERM/SIGKILL fallback, leaving zcode-cli orphaned under init.
      // Intercept the first exit, wait for host cleanup, then allow a second app.quit.
      hasPreparedAppQuit = true;
      appQuitPreparationInFlight = null;
    });

  await appQuitPreparationInFlight;
}

function exitPreparedApp(reason: string): never | void {
  logger.info(`[app-quit] exiting prepared app (${reason})`);
  if (process.env.ZCODE_E2E_RUN_ID?.trim()) {
    flushMainE2ECoverage((error) => {
      logger.warn("[e2e-coverage] main coverage flush failed", error);
    });
    // While ChromeDriver runs deleteSession, Electron may swallow app.exit(0) and in-process process.kill during its lifecycle.
    // Only when E2E run identity is explicit and prepareAppQuit has reclaimed hosts/agents, start an independent system
    // command to terminate this PID. Do not scan by process name or affect product exits or the next session.
    const killer =
      process.platform === "win32"
        ? spawn("taskkill", ["/PID", String(process.pid), "/F"], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          })
        : spawn("kill", ["-9", String(process.pid)], {
            detached: true,
            stdio: "ignore",
          });
    killer.unref();
    return;
  }
  app.exit(0);
}

function getRunningAgentSessionCount() {
  return [...hostRunningTaskCountMap.values()].reduce((total, count) => total + count, 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(ms, 0));
    timer.unref?.();
  });
}

async function execWithTimeout(
  file: string,
  args: string[],
  timeoutMs: number,
  spawnOptions: { windowsHide?: boolean; encoding?: BufferEncoding } = {},
): Promise<{
  timedOut: boolean;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = execFile(file, args, {
      windowsHide: spawnOptions.windowsHide,
      encoding: spawnOptions.encoding,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {
        // The process may have exited on its own; ignore it.
      }
    }, timeoutMs);
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut, code, signal });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut, error: error.message });
    });
  });
}

async function forceTerminateWindowsAgentProcesses(pids: number[]): Promise<
  Array<{
    pid: number;
    timedOut: boolean;
    code?: number | null;
    signal?: NodeJS.Signals | null;
    error?: string;
  }>
> {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  return Promise.all(
    uniquePids.map((pid) =>
      execWithTimeout(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        WINDOWS_AGENT_FORCE_KILL_TIMEOUT_MS,
        {
          windowsHide: true,
        },
      ).then((result) => ({ pid, ...result })),
    ),
  );
}

function logWindowsPackagedResourceSnapshot(stage: string) {
  logger.info(
    `[auto-update] Windows packaged resources snapshot (${stage}): ${JSON.stringify(
      snapshotWindowsPackagedResources(process.resourcesPath),
    )}`,
  );
}

function logWindowsPackagedResourceWritableProbe(stage: string) {
  const probes = probeWindowsPackagedResourceWritable(process.resourcesPath);
  const failed = probes.filter((probe) => probe.exists && !probe.writable);
  logger.info(
    `[auto-update] Windows packaged resources writable probe (${stage}): ${JSON.stringify(probes)}`,
  );
  if (failed.length > 0) {
    logger.warn(
      `[auto-update] Windows packaged resource dirs are not writable (${stage}): ${JSON.stringify(
        failed,
      )}`,
    );
  }
}

function logWindowsBundledRuntimeIntegrityDiagnostic() {
  if (process.platform !== "win32" || !app.isPackaged) {
    return;
  }

  const binaryPaths = {
    glm: resolveBundledGlmBinaryPath(),
  };
  const missingProviders = Object.entries(binaryPaths)
    .filter(([, binaryPath]) => !binaryPath)
    .map(([provider]) => provider);
  if (missingProviders.length === 0) {
    return;
  }

  // A missing bundled runtime may not affect the user's current provider, so only log it quietly during startup.
  // This records possible installation damage for the next user log without blocking startup for an unused provider.
  logger.warn(
    `[startup] Windows bundled runtime missing providers: ${missingProviders.join(", ")} resources=${JSON.stringify(
      snapshotWindowsPackagedResources(process.resourcesPath),
    )}`,
  );
}

async function prepareWindowsProcessesForUpdateInstall() {
  const trackedAgentCount = listRegisteredHostAgentProcessIds().length;

  logger.info(`[auto-update] preparing Windows update install: trackedAgent=${trackedAgentCount}`);
  logWindowsPackagedResourceSnapshot("before-dispose");

  const resourceLockMarkers = resolveWindowsPackagedResourceLockMarkers(process.resourcesPath);
  // prepareAppQuit already reclaims each window's single Host through the same barrier, force-killing at 7.5 seconds and
  // converging at 9 seconds. The Windows-specific phase must not add another wait or kill Host/Agent PIDs recorded before
  // exit, because they may have been reused. Clean only runtime processes that a live scan still shows referencing bundled
  // resources; updater and NSIS handle final exit of the current main/renderer.
  const cleanup = await runWindowsUpdateProcessCleanup({
    resourceLockMarkers,
    lockReleaseGraceMs: WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS,
    scan: findWindowsProcessesReferencingResourceMarkers,
    terminate: forceTerminateWindowsAgentProcesses,
    delay,
  });

  logger.info(
    `[auto-update] Windows resource lock scan: matches=${cleanup.initialLockProcesses.length} trackedAgent=${trackedAgentCount} details=${JSON.stringify(
      cleanup.initialLockProcesses,
    )}`,
  );
  for (const error of cleanup.errors) {
    logger.warn(`[auto-update] Windows process cleanup degraded: ${error}`);
  }

  if (cleanup.terminationPids.length === 0) {
    logWindowsPackagedResourceWritableProbe("no-lock-processes");
    return;
  }

  // Some Windows users have missing bundled agent files in the install directory after an update.
  // This is usually because old agent/helper processes or antivirus-triggered leftovers still hold handles while NSIS replaces
  // resources/glm directories. Killing only agent PIDs reported by hosts misses unregistered or detached descendants.
  // Before updating, scan command lines for install-resource paths again and force-clean process trees that still reference
  // bundled resources, reducing the chance of environment damage from a partial update.
  logger.info(
    `[auto-update] Windows taskkill results: ${JSON.stringify(cleanup.terminationResults)}`,
  );
  logger.info(
    `[auto-update] Windows resource lock release grace elapsed: ${WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS}ms`,
  );

  if (cleanup.remainingLockProcesses.length > 0) {
    logger.warn(
      `[auto-update] Windows resource lock processes still alive after taskkill: ${JSON.stringify(
        cleanup.remainingLockProcesses,
      )}`,
    );
  }
  logWindowsPackagedResourceWritableProbe("after-taskkill");
}

function shouldConfirmAppQuit() {
  // Ordinary development sessions often need to restart Electron; intercept only in production to avoid disrupting debugging.
  return ZCODE_ENV === "production" && getRunningAgentSessionCount() > 0;
}

const APP_QUIT_CONFIRMATION_COPY: Record<
  Locale,
  {
    runningSessions: (count: number) => string;
    quit: string;
    cancel: string;
    title: string;
    message: string;
  }
> = {
  "zh-CN": {
    runningSessions: (count) => `正在进行的会话：${count} 个，退出后会被中断。`,
    quit: "退出",
    cancel: "取消",
    title: "退出确认",
    message: "确认退出 Z Code?",
  },
  "en-US": {
    runningSessions: (count) =>
      `In-progress sessions: ${count}. They will be interrupted after quitting.`,
    quit: "Quit",
    cancel: "Cancel",
    title: "Confirm Quit",
    message: "Quit Z Code?",
  },
  "uk-UA": {
    // Use the colon form "Активних сесій: N" to avoid inflecting for 1/2/5.
    runningSessions: (count) => `Активних сеансів: ${count}. Після виходу їх буде перервано.`,
    quit: "Вийти",
    cancel: "Скасувати",
    title: "Підтвердження виходу",
    message: "Вийти із Z Code?",
  },
};

function confirmAppQuit(originWindow?: BrowserWindow | null) {
  if (!shouldConfirmAppQuit()) {
    logger.info(`[app-quit] quit confirmation skipped in ${ZCODE_ENV}`);
    return true;
  }

  const copy = APP_QUIT_CONFIRMATION_COPY[currentApplicationLocale];
  const runningAgentSessionCount = getRunningAgentSessionCount();
  const detailLines = [
    runningAgentSessionCount > 0 ? copy.runningSessions(runningAgentSessionCount) : null,
  ].filter((line): line is string => line !== null);
  const targetWindow =
    originWindow && !originWindow.isDestroyed()
      ? originWindow
      : (BrowserWindow.getFocusedWindow() ??
        getApplicationWindowsExcludingCuaIndicator()[0] ??
        null);
  const dialogOptions = {
    type: "question" as const,
    buttons: [copy.quit, copy.cancel],
    defaultId: 1,
    cancelId: 1,
    title: copy.title,
    message: copy.message,
    detail: detailLines.join("\n"),
    icon: nativeImage.createFromPath(iconPath),
  };

  const result = targetWindow
    ? dialog.showMessageBoxSync(targetWindow, dialogOptions)
    : dialog.showMessageBoxSync(dialogOptions);
  return result === 0;
}

async function executeDesktopCommandForApp(
  command: Parameters<typeof executeDesktopCommand>[0]["command"],
  senderWindow?: BrowserWindow | null,
) {
  return executeDesktopCommand({
    fetchHelpConfig: readHelpConfig,
    command,
    senderWindow,
    logger,
    updateZCodeStdioTapDevMenuState,
    onDesktopZoomChanged: (zoomLevel) => {
      currentDesktopZoomLevel = clampDesktopZoomLevel(zoomLevel);
      rebuildMenu();
    },
    settingService: mainSettingService,
    onZCodeEndpointChanged: handleZCodeEndpointChanged,
    zcodeEndpointEnvBaseOrigin: resolveZCodeEndpointEnvBaseOrigin(hostProcessLocalEnv),
    onRelaunchApp: async () => {
      await prepareAppQuit("desktop-command-relaunch");
      app.relaunch();
      app.quit();
    },
    credentialsDir: getCredentialsDir(),
    currentApplicationLocale,
  });
}

async function resolveZCodeEndpointSelection(): Promise<"production" | "test" | "custom"> {
  if (ZCODE_ENV === "production") {
    return "production";
  }
  const origin = await resolveCurrentZCodeEndpointOrigin();
  if (origin === DEFAULT_ZCODE_ENDPOINT_ORIGIN) {
    return "production";
  }
  if (origin === TEST_ZCODE_ENDPOINT_ORIGIN) {
    return "test";
  }
  return "custom";
}

async function handleZCodeEndpointChanged() {
  rebuildMenu();
  for (const win of getApplicationWindowsExcludingCuaIndicator()) {
    await webRemoteControlManagerRef.current?.suspend(win.id, "endpoint-changed");
  }
}

/** Shortcut-recording state from the Settings page (renderer syncs via SetShortcutRecordingActive); remove configurable menu accelerators while true. */
let shortcutRecordingActive = false;
/** webContents ID that started recording; the renderer cannot send reset IPC after window close/crash, so main uses this to converge state. */
let shortcutRecordingOwnerWebContentsId: number | null = null;

function setShortcutRecordingActive(active: boolean, ownerWebContentsId: number | null = null) {
  if (active) {
    shortcutRecordingOwnerWebContentsId = ownerWebContentsId;
  }
  if (shortcutRecordingActive === active) {
    return;
  }
  shortcutRecordingActive = active;
  if (!active) {
    shortcutRecordingOwnerWebContentsId = null;
  }
  rebuildMenu();
}

/**
 * Recording is temporary global state across processes, so convergence cannot depend on renderer cooperation. If a window
 * closes or its renderer crashes during recording, neither React cleanup nor reset IPC runs; the flag would remain true
 * forever, and every later rebuildMenu (language/zoom/settings sync) would create menus without accelerators for all windows.
 * Reset it by the initiating webContents during existing window-destruction cleanup.
 */
function resetShortcutRecordingForWebContents(webContentsId: number) {
  if (!shortcutRecordingActive || shortcutRecordingOwnerWebContentsId !== webContentsId) {
    return;
  }
  shortcutRecordingOwnerWebContentsId = null;
  shortcutRecordingActive = false;
  rebuildMenu();
}

function rebuildMenu() {
  void Promise.all([resolveZCodeEndpointSelection(), mainSettingService.get()]).then(
    ([zcodeEndpointSelection, settings]) => {
      rebuildApplicationMenu({
        currentApplicationLocale,
        zcodeEndpointSelection,
        executeDesktopCommand: executeDesktopCommandForApp,
        currentZoomLevel: resolveFocusedDesktopZoomLevel(),
        // Menu accelerators follow user shortcut settings (shortcutBindings overrides).
        shortcutBindings: settings.shortcutBindings,
        // While recording shortcuts, remove configurable accelerators so pressing a key for a menu-channel command does not
        // trigger the original command (macOS system menus consume keys before the renderer, so renderer preventDefault cannot stop it).
        disableShortcutAccelerators: shortcutRecordingActive,
      });
    },
  );
  updateWindowsDesktopTrayMenu();
}

function resolveFocusedDesktopZoomLevel(): number {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow || focusedWindow.isDestroyed()) {
    return 0;
  }
  return resolveDesktopZoomLevelFromFactor(focusedWindow.webContents.getZoomFactor());
}

function getApplicationWindowsExcludingCuaIndicator(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && !windowsCuaOperationIndicator.ownsWindow(win),
  );
}

function getMainApplicationWindows(): BrowserWindow[] {
  return getApplicationWindowsExcludingCuaIndicator().filter((win) => win !== updateStatusWindow);
}

function isUpdateStatusWindowCloseLocked(state: UpdateStatePayload) {
  return state.kind === "download-progress" || state.kind === "update-downloaded";
}

function syncUpdateStatusWindowClosePolicy(win: BrowserWindow) {
  if (win.isDestroyed()) {
    return;
  }
  const closeLocked = isUpdateStatusWindowCloseLocked(getAutoUpdaterState());
  win.setClosable(!closeLocked || forceQuitRef.current);
  win.setMinimizable(true);
}

function syncUpdateStatusWindowChrome(win: BrowserWindow) {
  if (win.isDestroyed() || process.platform !== "darwin") {
    return;
  }
  // Do not rely only on BrowserWindow constructor options for the standalone update window's traffic-light position.
  // macOS may keep the hidden-titlebar default coordinates after show/resize, so explicitly set a higher button position on each layout sync.
  win.setWindowButtonPosition(UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION);
}

function resolveUpdateStatusWindowHeight(state: UpdateStatePayload) {
  if (state.kind === "download-progress") {
    return UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT;
  }
  if (state.kind === "update-downloaded") {
    return UPDATE_STATUS_WINDOW_READY_HEIGHT;
  }
  return UPDATE_STATUS_WINDOW_COMPACT_HEIGHT;
}

function shouldUseUpdateStatusWindowContentSize(): boolean {
  return process.platform === "linux";
}

function syncUpdateStatusWindowLayout(win: BrowserWindow) {
  if (win.isDestroyed()) {
    return;
  }
  const state = getAutoUpdaterState();
  const height = resolveUpdateStatusWindowHeight(state);
  const bounds = shouldUseUpdateStatusWindowContentSize()
    ? win.getContentBounds()
    : win.getBounds();
  if (!shouldUseUpdateStatusWindowContentSize()) {
    win.setMinimumSize(UPDATE_STATUS_WINDOW_WIDTH, height);
    win.setMaximumSize(UPDATE_STATUS_WINDOW_WIDTH, height);
  }
  if (bounds.width !== UPDATE_STATUS_WINDOW_WIDTH || bounds.height !== height) {
    // After the standalone update window reused the in-page Dialog's 240px height, ordinary states had only two lines of
    // content and the footer consumed the remaining grid rows as a large blank area. Tighten the window by state to fit content density.
    // Cancelling a download returns from download-progress to update-available; sync min/max before setSize so macOS does
    // not keep the download-state height on a non-resizable BrowserWindow and leave the dialog expanded.
    if (shouldUseUpdateStatusWindowContentSize()) {
      // Linux's system title bar occupies part of the BrowserWindow frame height.
      // Locking the outer frame with setSize would reduce the actual WebContents height and clip the bottom buttons.
      win.setContentSize(UPDATE_STATUS_WINDOW_WIDTH, height);
    } else {
      win.setSize(UPDATE_STATUS_WINDOW_WIDTH, height);
    }
  }
  syncUpdateStatusWindowChrome(win);
}

function openUpdateStatusWindow() {
  if (updateStatusWindow && !updateStatusWindow.isDestroyed()) {
    if (updateStatusWindow.isMinimized()) {
      updateStatusWindow.restore();
    }
    updateStatusWindow.show();
    updateStatusWindow.focus();
    syncAutoUpdaterStateToWindow(updateStatusWindow);
    syncReadyUpdateToWindow(updateStatusWindow);
    syncPostUpdateReleaseNotesToWindow(updateStatusWindow);
    syncUpdateStatusWindowClosePolicy(updateStatusWindow);
    syncUpdateStatusWindowLayout(updateStatusWindow);
    return;
  }

  const parentWindow =
    getMainApplicationWindows().find((candidate) => candidate.isFocused()) ??
    getMainApplicationWindows()[0] ??
    undefined;
  const win = new BrowserWindow({
    width: UPDATE_STATUS_WINDOW_WIDTH,
    height: resolveUpdateStatusWindowHeight(getAutoUpdaterState()),
    useContentSize: shouldUseUpdateStatusWindowContentSize(),
    ...(shouldUseUpdateStatusWindowContentSize()
      ? {}
      : {
          minWidth: UPDATE_STATUS_WINDOW_WIDTH,
          minHeight: UPDATE_STATUS_WINDOW_READY_HEIGHT,
          maxWidth: UPDATE_STATUS_WINDOW_WIDTH,
          maxHeight: UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT,
        }),
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    // Update status now uses a standalone BrowserWindow instead of an in-page Dialog.
    // Keep system window controls; do not reuse the frameless transparent configuration from the in-page dialog.
    frame: true,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION,
        }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden" as const,
            titleBarOverlay: true,
          }
        : {}),
    transparent: false,
    backgroundColor: "#ffffff",
    title: "",
    icon: iconPath,
    parent: parentWindow,
    modal: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      additionalArguments: [`--device-id=${deviceMid}`],
    },
  });
  // Keep system window controls in the update window, but do not allow resizing or fullscreen.
  // Lock this explicitly in addition to constructor options because platforms differ in their default title-bar control behavior.
  win.setResizable(false);
  win.setMinimizable(true);
  win.setMaximizable(false);
  win.setFullScreenable(false);
  if (process.platform === "darwin") {
    syncUpdateStatusWindowChrome(win);
  }
  syncUpdateStatusWindowClosePolicy(win);
  syncUpdateStatusWindowLayout(win);

  updateStatusWindow = win;
  const disposeAutoUpdaterStateListener = onAutoUpdaterStateChanged(() => {
    syncUpdateStatusWindowClosePolicy(win);
    syncUpdateStatusWindowLayout(win);
  });
  const showUpdateStatusWindow = () => {
    if (win.isDestroyed()) {
      return;
    }
    if (!win.isVisible()) {
      win.center();
      syncUpdateStatusWindowChrome(win);
      win.show();
      syncUpdateStatusWindowChrome(win);
    }
    win.moveTop();
    win.focus();
    win.setAlwaysOnTop(true, "floating");
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.setAlwaysOnTop(false);
      }
    }, 250);
    logger.info(
      `[auto-update] update status window shown visible=${win.isVisible()} focused=${win.isFocused()} bounds=${JSON.stringify(win.getBounds())}`,
    );
  };
  win.webContents.on("dom-ready", () => {
    logger.info("[auto-update] update status window dom-ready");
    syncAutoUpdaterStateToWindow(win);
    syncReadyUpdateToWindow(win);
    syncPostUpdateReleaseNotesToWindow(win);
    // In development or some macOS rendering paths, the update window may not reliably emit ready-to-show.
    // Also try to show after loading completes so a loaded but hidden window does not make the update entry look unresponsive.
    setTimeout(showUpdateStatusWindow, 0);
  });
  win.once("ready-to-show", () => {
    showUpdateStatusWindow();
  });
  win.on("close", (event) => {
    if (forceQuitRef.current || !isUpdateStatusWindowCloseLocked(getAutoUpdaterState())) {
      return;
    }
    // After download starts, the update window reports installation progress. The user may minimize it but must not close it accidentally.
    // The close event also intercepts native close/shortcut paths; setClosable(false) only controls the system button state.
    event.preventDefault();
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
  });
  win.on("closed", () => {
    disposeAutoUpdaterStateListener();
    if (updateStatusWindow === win) {
      updateStatusWindow = null;
    }
  });

  loadWindow(win, "index", {
    restoreSession: false,
    supportsSettings: false,
    windowKind: "update-status",
    locale: currentApplicationLocale,
  });
}

function createWindowInstance(startupBootstrap: StartupWindowBootstrap = {}) {
  const runtimeProcessEnvPreparation = takeRuntimeProcessEnvPreparation();
  const win = createWindow({
    iconPath,
    preloadPath,
    logger,
    forceQuitRef,
    handleBeforeClose: (win, label) =>
      handleDesktopWindowCloseRequest({
        platform: process.platform,
        forceQuit: forceQuitRef.current,
        explicitQuitRequested: explicitQuitRef.current,
        closeToTray: closeToTrayOnWindows,
        // Treat an empty cache as unavailable and confirm the tray can render before hiding, preventing silent GNOME failure from stranding the user.
        // CR-01: hide only when both DBus detection and successful Tray creation pass; otherwise treat it as unavailable and ask before quitting.
        closeToTraySupported: resolveCloseToTraySupported({
          platform: process.platform,
          desktopTrayReady,
          capabilitySupported: closeToTrayCapabilityMonitor.getSync()?.supported,
        }),
        isLastWindow: getMainApplicationWindows().length === 1,
        label,
        logger,
        shouldConfirmQuit: shouldConfirmAppQuit(),
        confirmQuit: () => confirmAppQuit(win),
        requestQuit: () => {
          markForceQuit(`last-window-close:${label}`);
          app.quit();
        },
        hideWindow: () => win.hide(),
      }),
    windowHostProcessMap,
    onHostProcessReady: (windowKey) => cuaPipFocusRouter.refreshWindow(windowKey),
    awaitFirstHostSpawnDecision,
    spawnHostProcess: (win, label, initMessage) =>
      spawnHostProcess(
        win,
        label,
        {
          ...initMessage,
          zcodeBuiltinProviderConfigFilePath: resolveZCodeBuiltinProviderConfigFilePath(),
        },
        {
          hostProcessLocalEnv,
          desktopContextPromptEnabled: resolveDesktopContextPromptEnabledForHost,
          logger,
          broadcastHub,
          taskRealtimeBus,
          windowHostProcessMap,
          hostRunningTaskCountMap,
          onCuaOperationStateChanged: (source, event) =>
            windowsCuaOperationIndicator.handleState(source, event),
          onCuaOperationStateSourceExited: (source) =>
            windowsCuaOperationIndicator.clearSource(source),
          onAgentProcessExited: (event) => reportAgentProcessExitToArms(event, logger),
          onAgentProcessError: (event) => reportAgentProcessSpawnErrorToArms(event, logger),
          onAgentProcessException: (event) => reportAgentProcessExceptionToArms(event, logger),
          onAgentProcessReady: (event) => reportAgentProcessReadyToArms(event, logger),
          onAgentProcessSpawned: (event) => reportAgentProcessStartToArms(event, logger),
          onMcpTelemetry: (message) =>
            reportMcpTelemetryToArms(message.event, message.runtimeSurface),
          onSessionCreateTelemetry: (message) => {
            void appTelemetryCore.reportEvent(message.event).catch(() => {});
          },
          onCronRunResult: forwardCronRunResult,
          onOffPeakRunResult: forwardOffPeakRunResult,
          onCronSchedulerWakeRequested: wakeCronScheduler,
          onOffPeakSchedulerWakeRequested: wakeOffPeakScheduler,
          authorizeLocalMediaPreviewPath: localMediaPreviewPathRegistry.authorize,
          registerPluginSandbox: (input) => {
            const host = getPluginSandboxHost();
            if (!host) throw new Error("Plugin UI sandbox host is not installed.");
            const { requestId: _requestId, ...registerInput } = input;
            return host.registerFromHost(registerInput);
          },
          // Bugfix: bot service runs in the local window host, so /reconnect must let that host ask main to create a remote session.
          handleBotRemoteWorkspaceReconnectRequest: async ({
            win,
            requestId,
            workspacePath,
            workspaceIdentity,
            target,
          }) => {
            try {
              const sessionId = await remoteSessionManager.reconnectBotRemoteWorkspaceSession(win, {
                target,
                workspacePath,
                workspaceIdentity,
                requestId,
              });
              if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
                win.webContents.send(PlatformChannels.BotRemoteWorkspaceReconnected, {
                  sessionId,
                  workspacePath,
                  workspaceIdentity,
                  target,
                });
              }
              return { ok: true, sessionId };
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
          handleBotRemoteWorkspaceConnectionStatusRequest: async ({
            win,
            target,
            workspacePath,
            workspaceIdentity,
          }) => ({
            ok: true,
            // Bugfix: isolate Bot remote connection state by workspaceIdentity/workspacePath.
            // Checking only the SSH target would mistake another directory on the same machine for the connected workspace.
            connected: remoteSessionManager.hasRemoteWorkspaceSessionForTarget(win, target, {
              workspacePath,
              workspaceIdentity,
            }),
          }),
          handleBotRemoteWorkspaceRuntimePortRequest: async ({
            win,
            requestId,
            workspacePath,
            workspaceIdentity,
            target,
          }) => {
            try {
              const port = await remoteSessionManager.createBotRemoteWorkspaceRuntimePort(
                win,
                {
                  target,
                  workspacePath,
                  workspaceIdentity,
                },
                requestId,
              );
              return { ok: true, port };
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
          // browser-use: main executes commands with WebContentsView + CDP.
          handleBrowserExecuteRequest: ({ win: browserWin, ...request }) =>
            runBrowserCommandOnView({ win: browserWin, ...request }),
        },
        {
          taskRealtime: {
            workspaceKeys: windowWorkspaceMap.get(win.id) ?? [],
            onHostId: (hostId) => {
              windowTaskRealtimeHostIdMap.set(win.id, hostId);
            },
          },
        },
      ),
    disposeHostProcess: (child, label, forceKillDelayMs) =>
      disposeHostProcess(
        child,
        label,
        disposingHostProcessTimers,
        logger,
        label.includes("window-closed")
          ? activeAppShutdownPolicy.forceKillDelayMs
          : forceKillDelayMs,
      ),
    syncAutoUpdaterStateToWindow,
    syncReadyUpdateToWindow,
    syncPostUpdateReleaseNotesToWindow,
    webRemoteControlManager,
    disposeRemoteWorkspaceSessionsForWindow:
      remoteSessionManager.disposeRemoteWorkspaceSessionsForWindow,
    reattachRemoteWorkspaceSessionsForWindow:
      remoteSessionManager.reattachRemoteWorkspaceSessionsForWindow,
    bootstrap: {
      restoreSession: startupBootstrap.restoreSession,
      initialWorkspacePath: startupBootstrap.initialWorkspacePath,
      initialWorkspacePurpose: startupBootstrap.initialWorkspacePurpose,
      unavailableWorkspacePath: startupBootstrap.unavailableWorkspacePath,
    },
    agentWarmupTargets: startupBootstrap.agentWarmupTargets,
    // startupBootstrap marks only whether the active workspace is unavailable, while Local Host builds background indexes
    // for every restored workspace. Always inject the canonical fallback to cover deleted historical directories that are not active.
    agentSpawnFallbackCwd: getConversationWorkspaceDir(),
    deviceMid,
    runtimeProcessEnvPatchPromise: runtimeProcessEnvPreparation.patchPromise,
    runtimeProcessEnvFallbackPatch: runtimeProcessEnvPreparation.fallbackPatch,
    initialDesktopZoomLevel: currentDesktopZoomLevel,
    initialWindowSize: currentDesktopWindowSize,
    currentApplicationLocale: () => currentApplicationLocale,
    resolveBrowserViewOwner: (webContentsId) =>
      browserGuestManager.getTabOwnerByWebContentsId(webContentsId),
    persistWindowSize: async (state) => {
      currentDesktopWindowSize = state;
      await mainSettingService.update({ desktopWindowSize: state });
    },
  });
  registerStabilityMainWindow(win);
  return win;
}

registerDeepLinkProtocol(logger, { iconPath: linuxDesktopIntegrationIconPath });
app.on("open-url", (event, url) => {
  event.preventDefault();
  const workspacePath = extractOpenWorkspacePathFromDeepLinkUrl(url);
  if (workspacePath && forceUpdateMainWindowCreationBlocked) {
    logger.warn("[force-update] 已忽略强制升级期间的 open-url workspace 请求");
    focusForceUpdateGateWindow();
    return;
  }
  if (workspacePath && getApplicationWindowsExcludingCuaIndicator().length === 0) {
    // On macOS cold start, Finder Service may trigger open-url before creating the first window.
    // Record the target directory as a deep-link source so it still passes the confirmation gate before first-window bootstrap.
    startupOpenWorkspaceRequest = { path: workspacePath, source: "deep-link" };
    if (app.isReady()) {
      void primaryWindowCoordinator.ensurePrimaryWindow("open-url-workspace");
    }
    return;
  }
  handleDeepLink(url, logger, {
    confirmationCopy: resolveExternalWorkspaceConfirmationCopy(),
    resolveApplicationWindow: () => getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
  });
});
const gotTheLock = app.requestSingleInstanceLock(createDeepLinkSingleInstanceData(process.argv));
if (!gotTheLock) {
  app.quit();
}
app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
  if (
    handleSecondInstanceWorkspaceRequest({
      additionalData,
      argv,
      focusForceUpdateGateWindow,
      forceUpdateBlocked: forceUpdateMainWindowCreationBlocked,
      handleDeepLink: (url, options) => handleDeepLink(url, logger, options),
      handleOpenWorkspacePath: (path, options) =>
        handleOpenWorkspacePath(path, logger, {
          allowWithoutReadyWindow: true,
          ...options,
          resolveApplicationWindow:
            options?.resolveApplicationWindow ??
            (() => getApplicationWindowsExcludingCuaIndicator()[0] ?? null),
        }),
      resolveApplicationWindow: () => getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
      logger,
      workspaceConfirmationCopy: resolveExternalWorkspaceConfirmationCopy(),
    })
  ) {
    return;
  }

  const win = getApplicationWindowsExcludingCuaIndicator()[0];
  if (win) {
    if (win.isMinimized()) {
      win.restore();
    }
    if (!win.isVisible()) {
      win.show();
    }
    win.focus();
  }
});

app.whenReady().then(async () => {
  markMainLaunchAppReady();
  installRequestSecurityDiagnostics(session.defaultSession.webRequest, logger);
  installLocalMediaPreviewProtocol(session.defaultSession.protocol, {
    isPathAuthorized: localMediaPreviewPathRegistry.isAuthorized,
  });
  // Plugin UI sandbox: registry + renderer-callable IPC; the scheme's privileged registration completed with zcode-media before ready.
  installPluginSandboxHost({
    preloadPath: join(import.meta.dirname, "../preload/pluginSandbox.cjs"),
    rendererDir: join(import.meta.dirname, "../renderer"),
    aliasDir: join(import.meta.dirname, "../plugin-sandbox"),
    // In development, out/renderer has no shell artifact; proxy through the renderer dev server (same approach as cua-permission-panel).
    ...(!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]
      ? { devServerUrl: process.env["ELECTRON_RENDERER_URL"] }
      : {}),
    logger: console,
    // E2E L05 (quota): allow a smaller registry capacity only during an E2E run.
    ...(process.env.ZCODE_E2E_RUN_ID?.trim() &&
    Number.isInteger(Number(process.env.ZCODE_E2E_PLUGIN_SANDBOX_MAX_ENTRIES)) &&
    Number(process.env.ZCODE_E2E_PLUGIN_SANDBOX_MAX_ENTRIES) > 0
      ? { registryMaxEntries: Number(process.env.ZCODE_E2E_PLUGIN_SANDBOX_MAX_ENTRIES) }
      : {}),
  });
  // Electron net.request is available only after app ready; rollout requests remain out-of-band prewarming and do not block the first Host.
  void desktopContextPromptRollout?.refresh();
  installBrowserRestoreBootstrapProtocol(
    session.fromPartition(EMBEDDED_BROWSER_PARTITION).protocol,
  );
  // Bootstrap: read the custom data directory from settings before starting any host process.
  let loadedBootstrapLocale = false;
  let bootstrapSettings: AppSettings | undefined;
  try {
    bootstrapSettings = await mainSettingService.get();
    if (bootstrapSettings.dataBaseDir) {
      setDataBaseDir(bootstrapSettings.dataBaseDir);
    }
    if (bootstrapSettings.locale) {
      loadedBootstrapLocale = true;
      currentApplicationLocale = bootstrapSettings.locale;
    }
    // Linux default-value migration (spec: docs/desktop/linux-close-to-tray.md): shared migration has no platform concept
    // and previously treated existing Linux users as true. Linux had no setting before, so an existing true value was not an explicit
    // user choice. On first startup, restore the default-off value and persist the migration marker; respect user choices afterward.
    const closeToTrayBootstrap = resolveCloseToTrayBootstrapValue({
      platform: process.platform,
      stored: bootstrapSettings.closeToTrayOnWindows,
      linuxMigrationInitialized: bootstrapSettings.closeToTrayLinuxMigrationInitialized,
    });
    // CR-02: await persistence before continuing startup so the renderer settings page does not read the old file value.
    // A write failure must not block startup; revert the in-memory value to the current file value (resolveCloseToTrayRuntimeValue).
    // If persistence is unavailable, the file remains the only trusted source, avoiding conflicting values where main uses false
    // but the settings page shows true. Retry the migration on the next startup; keep the pre-migration behavior while it remains incomplete.
    let closeToTrayMigrationPersisted = true;
    if (closeToTrayBootstrap.needsLinuxMigration) {
      try {
        await mainSettingService.update({
          closeToTrayOnWindows: false,
          closeToTrayLinuxMigrationInitialized: true,
        });
      } catch (error) {
        closeToTrayMigrationPersisted = false;
        logger.warn("[settings] failed to persist linux close-to-tray default migration", error);
      }
    }
    closeToTrayOnWindows = resolveCloseToTrayRuntimeValue({
      platform: process.platform,
      stored: bootstrapSettings.closeToTrayOnWindows,
      linuxMigrationInitialized: bootstrapSettings.closeToTrayLinuxMigrationInitialized,
      migrationPersisted: closeToTrayMigrationPersisted,
    });
    keepAwakeWhileRunning = bootstrapSettings.keepAwakeWhileRunning ?? false;
    currentDesktopZoomLevel = clampDesktopZoomLevel(bootstrapSettings.desktopZoomLevel ?? 0);
    currentDesktopWindowSize = bootstrapSettings.desktopWindowSize;
    // Global keep-awake: if enabled in settings at startup, hold powerSaveBlocker immediately instead of waiting for a settings-change event.
    reconcileKeepAwakeBlocker();
  } catch {
    // A read failure does not block startup; use the default homedir.
  }

  // The scheduler also opens tasks-index; wait for Host's shared preparation to finish to avoid migrating before the startup page appears.
  configureDatabaseStartupQuit(() => {
    markExplicitQuit("database-startup-exit");
    app.quit();
  });
  onLocalDatabaseStartupReady(() => {
    try {
      cronScheduler = spawnCronScheduler({
        hostProcessLocalEnv,
        logger,
        resolveDispatchHost: resolveCronDispatchHost,
        // keep-awake is now driven only by settings; keep count reporting for future diagnostics/quota use without linking it to the blocker.
        onOffPeakActiveCountChanged: () => {},
      });
    } catch (error) {
      logger.error("[cron-scheduler] failed to spawn scheduler process:", error);
    }
  });

  if (process.platform === "win32") {
    // Packaged builds must use the same AUMID as the NSIS shortcut, or the Shell treats them as different applications.
    // Use build-time product identity rather than the user's machine environment; keep development identity separate.
    app.setAppUserModelId(
      resolveWindowsAppUserModelIdForFlavor(ZCODE_PRODUCT_FLAVOR, { isPackaged: app.isPackaged }),
    );
  }

  applyAppIcon(iconPath);
  if (!loadedBootstrapLocale) {
    currentApplicationLocale = resolveSystemApplicationLocale();
  }
  installFinderOpenFolderWorkflow({
    platform: process.platform,
    locale: currentApplicationLocale,
    homeDir: app.getPath("home"),
    logger,
  });
  await installWindowsOpenFolderContextMenu({
    platform: process.platform,
    executablePath: process.execPath,
    argv: process.argv,
    isDefaultApp: Boolean(process.defaultApp),
    locale: currentApplicationLocale,
    logger,
  });
  try {
    await applyDesktopChromiumNetworkPolicies(session, bootstrapSettings ?? {}, logger);
  } catch (error) {
    logger.warn("[desktop-network] Chromium network policy bootstrap failed:", error);
  }

  // Embedded browser permission gate (CNVD unauthorized-access fix): register it before any guest attaches.
  // The dialog bridge connects policy decisions to the main-window UI; the store persists site-consent records for "Allow/Block when visiting this site."
  const embeddedBrowserPermissionUiBridge = createEmbeddedBrowserPermissionUiBridge({ logger });
  embeddedBrowserPermissionUiBridge.registerResolveListener();
  setActiveEmbeddedBrowserPermissionUiBridge(embeddedBrowserPermissionUiBridge);
  try {
    await applyEmbeddedBrowserPermissionPolicy(session.fromPartition(EMBEDDED_BROWSER_PARTITION), {
      logger,
      prompt: embeddedBrowserPermissionUiBridge.promptPermission,
      devicePicker: embeddedBrowserPermissionUiBridge.devicePicker,
      onDisplayMediaRequest: embeddedBrowserPermissionUiBridge.onDisplayMediaRequest,
      store: createEmbeddedBrowserSitePermissionStore(
        join(app.getPath("userData"), "embedded-browser-site-permissions.json"),
      ),
    });
  } catch (error) {
    logger.warn("[embedded-browser-permission] policy bootstrap failed:", error);
  }

  await hydratePendingPostUpdateReleaseNotes(mainSettingService);
  logWindowsBundledRuntimeIntegrityDiagnostic();

  // Start the automatic update check in the background without blocking the main interface.
  // Preview builds do not update automatically against any backend: the stable feed distributes only production ZCode installers,
  // and updates are not offered to the Preview channel. Updates are also disabled when not enabled at build time
  // (see docs/desktop/build-time-optional-capabilities.md).
  void initAutoUpdater({
    enabled: ZCODE_PRODUCT_FLAVOR === "production" && ZCODE_AUTO_UPDATE_ENABLED,
    onBeforeQuitAndInstall: async () => {
      notifyStabilityLifecycle("update_install");
      await prepareAppQuit("auto-update quitAndInstall", "update-install");
      if (process.platform === "win32") {
        await prepareWindowsProcessesForUpdateInstall();
      }
    },
    settingService: mainSettingService,
    locale: currentApplicationLocale,
    deviceMid,
    resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
    updateFeedSource: resolveUpdateFeedSourceFromStartupConfig({
      argv: process.argv,
      env: process.env,
    }),
  });

  if (process.platform === "darwin" || process.platform === "win32") {
    app.clearRecentDocuments();
  }

  rebuildMenu();
  configureDockMenu(
    () =>
      getDesktopMenuLabelByLocale(
        currentApplicationLocale,
        desktopMenuMessageIds.dockShowCurrentWindow,
      ),
    () => showCurrentWindowFromDock(primaryWindowCoordinator),
  );
  const desktopTrayOptions = {
    getLocale: () => currentApplicationLocale,
    showCurrentWindow: () =>
      primaryWindowCoordinator.ensurePrimaryWindow("tray-show-current-window"),
    executeDesktopCommand: executeDesktopCommandForApp,
    quitApp: () => {
      markExplicitQuit("tray-quit");
      app.quit();
    },
    logger,
  };
  // CR-01: successful tray creation must be part of the hide-window capability. A DBus watcher only proves that the desktop
  // may have a host; new Tray() can still throw if the icon is missing or the session is not ready. Hiding then would remove the user's
  // only entry point. Set trayReady from the creation result; both window-close and settings capability queries read it.
  if (process.platform === "win32") {
    desktopTrayReady = createDesktopTray(desktopTrayOptions) !== null;
  }

  const ensureLinuxDesktopTray = async (): Promise<void> => {
    if (process.platform !== "linux" || desktopTrayReady) {
      return;
    }
    // Linux tray creation follows capability, not the setting toggle (spec: docs/desktop/linux-close-to-tray.md):
    // on desktops without StatusNotifierWatcher (GNOME by default), new Tray() silently fails, so registering an unrendered
    // DBus name is useless. Create the tray only after the capability probe succeeds. A settings query after extension installation also creates it here.
    const capability = await closeToTrayCapabilityMonitor.refresh();
    if (capability.supported) {
      desktopTrayReady = createDesktopTray({ ...desktopTrayOptions, platform: "linux" }) !== null;
    }
  };
  if (process.platform === "linux") {
    void ensureLinuxDesktopTray().catch((error: unknown) => {
      logger.warn("[desktop-tray] linux tray capability probe failed", error);
    });
  }

  registerPlatformIpcHandlers({
    fetchHelpConfig: readHelpConfig,
    logger,
    // CDP-on-guest pivot: renderer reports guest webContentsId on `<webview>` dom-ready → attach.
    attachBrowserGuest: (key, webContentsId, options) => {
      const result = browserGuestManager.attachGuest(key, webContentsId, options);
      if (result.ok && options?.windowId !== undefined) {
        embeddedBrowserDialogController.bindGuest(key, webContentsId, options.windowId);
      }
      return result;
    },
    updateBrowserGuestViewport: (tabId, viewport, windowId, desktopZoomFactor) =>
      browserGuestManager.updateViewportFromRenderer(tabId, viewport, windowId, desktopZoomFactor),
    reportBrowserScreenshotSurfaceReady: (windowId, senderWebContentsId, payload) => {
      logger.debug("[browser-screenshot-surface] renderer ready", {
        windowId,
        senderWebContentsId,
        requestId: payload.requestId,
        tabId: payload.tabId,
        webContentsId: payload.webContentsId,
        viewport: payload.viewport,
        surfaceScale: payload.surfaceScale,
      });
      browserScreenshotSurfaceCoordinator.handleReady({
        windowId,
        senderWebContentsId,
        payload,
      });
    },
    browserViewResidencyHandlers: {
      detachBrowserGuest: (key, webContentsId, windowId) =>
        browserGuestManager.detachGuestBeforeReplacement(key, webContentsId, windowId),
      closeBrowserTab: (payload) => browserGuestManager.closeTabFromRenderer(payload),
      reportBrowserTabResidency: (payload) => browserGuestManager.reportResidency(payload),
      acknowledgeBrowserTabSuspend: (payload) => browserGuestManager.acknowledgeSuspend(payload),
      ensureBrowserTabResident: (payload) =>
        browserGuestManager.ensureResidentFromRenderer(payload),
      restoreBrowserTabs: (payload) => browserGuestManager.restoreTabs(payload),
    },
    applyApplicationLocale: async (locale) => {
      currentApplicationLocale = locale;
      windowsCuaOperationIndicator.refreshContent();
      rebuildMenu();
      for (const win of getApplicationWindowsExcludingCuaIndicator()) {
        if (!win.isDestroyed()) {
          win.webContents.send(PlatformChannels.ApplicationLocaleChanged, currentApplicationLocale);
        }
      }
      installFinderOpenFolderWorkflow({
        platform: process.platform,
        locale: currentApplicationLocale,
        homeDir: app.getPath("home"),
        logger,
      });
      // Windows Explorer context menus are persistent registry entries and do not refresh when the renderer changes language.
      // As with the macOS Finder Service, rewrite the menu labels when locale changes so they do not remain in the old language.
      await installWindowsOpenFolderContextMenu({
        platform: process.platform,
        executablePath: process.execPath,
        argv: process.argv,
        isDefaultApp: Boolean(process.defaultApp),
        locale: currentApplicationLocale,
        logger,
      });
      configureDockMenu(
        () =>
          getDesktopMenuLabelByLocale(
            currentApplicationLocale,
            desktopMenuMessageIds.dockShowCurrentWindow,
          ),
        () => showCurrentWindowFromDock(primaryWindowCoordinator),
      );
    },
    focusWorkspaceInExistingWindow: (path, extra) =>
      focusWorkspaceInExistingWindow(path, windowWorkspaceMap, extra),
    windowWorkspaceMap,
    windowUnreadCountMap,
    resolveSystemLocale: resolveSystemApplicationLocale,
    currentApplicationLocale: () => currentApplicationLocale,
    executeDesktopCommand: executeDesktopCommandForApp,
    acknowledgePostUpdateReleaseNotes: (version) =>
      acknowledgePostUpdateReleaseNotes(version, mainSettingService),
    syncActiveTaskSession: (windowId, sessionId) =>
      cuaPipFocusRouter.updateActiveSession(windowId, sessionId),
    syncTaskRealtimeWorkspaceKeys: (windowId, workspaceKeys) => {
      const hostId = windowTaskRealtimeHostIdMap.get(windowId);
      if (hostId) {
        taskRealtimeBus.updateHostWorkspaceKeys(hostId, workspaceKeys);
      }
    },
    restorePreviouslyEnabledWebRemoteControl: (windowId, contexts) => {
      void webRemoteControlManager.restorePreviouslyEnabled(windowId, contexts);
    },
    getUpdateState: getAutoUpdaterState,
    openUpdateStatusWindow,
    getAutoUpdatePreferences,
    setAutoDownloadAndInstallUpdates,
    getDesktopSessionActivity: () => ({
      runningAgentSessionCount: getRunningAgentSessionCount(),
    }),
    syncWebRemoteControlWorkspaces: (windowId, workspaces) => {
      webRemoteControlManager.syncAvailableWorkspaces(windowId, workspaces);
      void webRemoteControlManager.restorePreviouslyEnabled(windowId, workspaces);
    },
    syncWebRemoteControlTasks: (windowId, tasks) =>
      webRemoteControlManager.syncAvailableTasks(windowId, tasks),
    syncAppSettings: syncImmediateAppSettings,
    // Settings disabled-state query: the monitor uses a stale cache, so reopening settings after installing the AppIndicator extension refreshes it.
    // First ensure the tray instance is ready (the first query after extension installation creates it), then return final capability including
    // trayReady. This prevents settings from showing the feature as available while window close actually asks for confirmation (CR-01).
    refreshCloseToTrayCapability: async () => {
      await ensureLinuxDesktopTray();
      const capability = await closeToTrayCapabilityMonitor.refresh();
      return {
        supported: resolveCloseToTraySupported({
          platform: process.platform,
          desktopTrayReady,
          capabilitySupported: capability.supported,
        }),
        gnomeLikeWithoutTray: capability.gnomeLikeWithoutTray,
      };
    },
    setShortcutRecordingActive,
    deviceMid,
  });

  disposeRendererActionTraceIpc = registerRendererActionTraceIpc({
    rollout: rendererActionTraceRollout,
    broker: rendererActionTraceBroker,
    env: process.env,
    logger,
  });

  registerRemoteIpcHandlers({
    logger,
    appTelemetryRuntime,
    onOAuthCallbackHandledSideEffect: () => {
      void armsUserIdentitySync.refresh();
    },
    appTelemetryCore,
    reportRemoteUsageEvent: reportRemoteUsageEventForRenderer,
    armsCustomContext: {
      deviceMid,
      platform: process.platform,
      appVersion: ZCODE_VERSION,
      armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
    },
    finalArmsCustomEventE2EEnabled: shouldEnableE2ETestBridge(process.env),
    webRemoteControlManager,
    createRemoteWorkspaceSession: remoteSessionManager.createRemoteWorkspaceSession,
    getRemoteConnectionStats: remoteSessionManager.getRemoteConnectionStats,
    disposeRemoteWorkspaceSession: remoteSessionManager.disposeRemoteWorkspaceSession,
    cancelPendingRemoteWorkspaceSessionsForWindow:
      remoteSessionManager.cancelPendingRemoteWorkspaceSessionsForWindow,
    bindRemoteWorkspaceSessionContext: remoteSessionManager.bindRemoteWorkspaceSessionContext,
    confirmRendererAttachmentReady: remoteSessionManager.confirmRendererAttachmentReady,
    isDockerDaemonAvailable,
    listAvailableWSLDistros,
    listAvailableDockerContainers,
    listSSHConfigAliases,
  });

  // Wait for ARMS initialization (including renderer-injection listeners) so the first window's dom-ready does not precede SDK registration and lose reports.
  await armsInitPromise;

  // Write user.name (device_mid) for the first time after ARMS initialization.
  void armsUserIdentitySync.refresh();

  configureDesktopStabilityTelemetry({
    deviceMid,
    platform: process.platform,
    appVersion: ZCODE_VERSION,
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  configureDesktopResourceTelemetry({
    deviceMid,
    platform: process.platform,
    appVersion: ZCODE_VERSION,
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  configureDesktopMcpTelemetry({
    deviceMid,
    appVersion: ZCODE_VERSION,
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  configureDesktopNetworkTelemetry({
    deviceMid,
    platform: process.platform,
    appVersion: ZCODE_VERSION,
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  registerDesktopStabilityMonitors(logger, crashCapturePaths);
  registerDesktopResourceTelemetry(logger);
  // Entry point for 60-second heap samples from the main-window renderer; lives for the App lifetime and registers once.
  registerRendererHeapSampleIpc();
  const defaultDataBaseDir = process.env.HOME?.trim() || homedir();
  registerDesktopZCodeDataSizeTelemetry({
    context: {
      appVersion: ZCODE_VERSION,
      armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
      dataRootKind:
        resolve(getDataBaseDir()) === resolve(defaultDataBaseDir) ? "default" : "custom",
      deviceMid,
      platform: process.platform,
    },
    getSystemIdleTimeSeconds: () => powerMonitor.getSystemIdleTime(),
    isAppBackground: () => resolveResourceUsageScene() === "background",
    isZCodeBusy: () => getRunningAgentSessionCount() > 0,
    logger,
    rootPath: getZCodeDataRootDir(),
    stateFile: join(app.getPath("userData"), "zcode-data-size-telemetry.json"),
  });
  registerDesktopNetworkTelemetry(logger);

  // Local unpackaged dev builds (app.isPackaged === false) must skip the remote forced-upgrade gate.
  // Cause: the force-update gate checks only ZCODE_ENV === "production", but a dev build (such as dev:desktop:cua
  // used to test computer use against the real backend) can point at the production backend while its version lags behind
  // the online release (feature branches do not bump versions). The release minimalVersion then incorrectly forces an
  // upgrade and immediately exits. This gate protects packaged release clients and has no purpose for unpackaged dev
  // runtime. Packaged builds have app.isPackaged === true, so the gate still applies and real users are unaffected.
  const skipForceUpdateForLocalDevRuntime = !app.isPackaged;
  const forceUpdateGuardResult =
    ZCODE_PRODUCT_FLAVOR === "production" && !skipForceUpdateForLocalDevRuntime
      ? await maybeBlockStartupForForceUpdate({
          locale: currentApplicationLocale,
          logger,
          endpointOrigin: await resolveCurrentZCodeEndpointOrigin(),
          onBlocked: () => {
            forceUpdateMainWindowCreationBlocked = true;
          },
        })
      : { blocked: false };
  if (ZCODE_PRODUCT_FLAVOR !== "production") {
    logger.info("[force-update] Preview 跳过远端强制升级检查");
  } else if (skipForceUpdateForLocalDevRuntime) {
    logger.info("[force-update] 本地 dev 构建（未打包）跳过远端强制升级检查");
  }
  if (forceUpdateGuardResult.blocked) {
    return;
  }

  logger.info("[startup] 创建主窗口");
  await primaryWindowCoordinator.ensurePrimaryWindow("app-ready");

  const primaryWindow = getApplicationWindowsExcludingCuaIndicator()[0];
  if (primaryWindow) {
    scheduleReportPerfAppStartAfterMainViewReady(primaryWindow.webContents, logger);
  }

  // After startup, check whether the CPU architecture matches (for example, an x64 build running through Rosetta on Apple silicon).
  // If it does not match, asynchronously prompt the user to install the native-architecture build without blocking the main UI.
  void maybeWarnArchitectureMismatch({
    locale: currentApplicationLocale,
    logger,
    parentWindow: getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
    icon: nativeImage.createFromPath(iconPath),
  }).catch((error) => {
    logger.warn("[architecture] 架构检测弹框失败:", error);
  });

  const protocolUrl = extractDeepLinkUrlFromArgs(process.argv);
  if (startupDeepLinkConsumptionGate.shouldHandleReadyProtocolUrl(protocolUrl)) {
    handleDeepLink(protocolUrl, logger, {
      confirmationCopy: resolveExternalWorkspaceConfirmationCopy(),
      resolveApplicationWindow: () => getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
    });
  }
});

app.on("browser-window-created", (_, win) => {
  const windowWebContentsId = win.webContents.id;
  win.on("closed", () => {
    browserScreenshotSurfaceCoordinator.handleWindowDestroyed(win.id);
    browserGuestManager.closeWindow(win.id);
    windowWorkspaceMap.delete(win.id);
    windowTaskRealtimeHostIdMap.delete(win.id);
    if (windowUnreadCountMap.delete(win.id)) {
      syncApplicationUnreadBadge(windowUnreadCountMap);
    }
    // When Electron enters the closed callback, win.webContents may already be destroyed.
    // Previously reading win.webContents.id here threw "Object has been destroyed" during window cleanup.
    // Cache the webContents ID at window creation so OAuth-route cleanup does not access a destroyed object.
    clearOAuthRoutesForWindow(windowWebContentsId);
    // If the window closes/crashes during recording, the renderer cannot send reset IPC; use the initiating webContents
    // to reset recording state here and prevent menu accelerators from being removed permanently.
    resetShortcutRecordingForWebContents(windowWebContentsId);
  });
  // If the renderer crashes while the window remains open, closed does not fire. Reset by owner on the crash path too
  // (a non-matching owner is naturally idempotent).
  win.webContents.on("render-process-gone", () => {
    resetShortcutRecordingForWebContents(windowWebContentsId);
  });
});
app.on("window-all-closed", () => {
  if (process.platform === "darwin") {
    // macOS: keep app running when all windows are closed
    return;
  }

  app.quit();
});
app.on("before-quit", (event) => {
  // Closing the last window on Windows confirms early during close and marks forceQuit.
  // macOS Cmd+Q/menu exit does not use that window-close confirmation, so keep an app-level confirmation fallback in before-quit.
  if (!forceQuitRef.current && shouldConfirmAppQuit() && !confirmAppQuit()) {
    event.preventDefault();
    // If an explicit exit such as tray quit is cancelled by the confirmation dialog, clear explicitQuit.
    // Otherwise the next Windows close-button click would bypass the "hide to tray" setting and trigger a full exit.
    explicitQuitRef.current = false;
    return;
  }

  if (!hasPreparedAppQuit) {
    localMediaPreviewPathRegistry.clear();
    event.preventDefault();
    void prepareAppQuit("app-before-quit").finally(() => {
      const remainingWindows = getApplicationWindowsExcludingCuaIndicator();
      logger.info(
        `[app-quit] preparation finished, resuming quit with windows=${remainingWindows.length}`,
      );
      // If ChromeDriver triggers app.quit only after closing the last renderer, the first before-quit is intercepted by
      // asynchronous host cleanup. When cleanup finishes, the window may still be closing, and Electron ignores the
      // reentrant app.quit; ChromeDriver then waits about 70 seconds. Bind the final exit to the actual closed event
      // instead of guessing with a timeout.
      if (remainingWindows.length === 0) {
        exitPreparedApp("no-windows-after-preparation");
        return;
      }

      let exitRequested = false;
      const exitAfterLastWindowClosed = () => {
        if (exitRequested || getApplicationWindowsExcludingCuaIndicator().length > 0) {
          return;
        }
        exitRequested = true;
        logger.info("[app-quit] all windows closed after preparation, exiting app");
        exitPreparedApp("all-windows-closed-after-preparation");
      };
      for (const win of remainingWindows) {
        win.once("closed", exitAfterLastWindowClosed);
      }
      app.quit();
    });
  }
});
app.on("activate", () => {
  void primaryWindowCoordinator.ensurePrimaryWindow("app-activate");
});
