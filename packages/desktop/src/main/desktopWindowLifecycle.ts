import { getDatabaseStartupPortPayload } from "./databaseStartupRelay.js";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, Menu, MessageChannelMain } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes, InternalChannels, PlatformChannels, type Locale } from "@zcode/shared";
import { scheduleArmsBrowserPerfLoadNudge } from "./armsBrowserPerfLoadNudge.js";
import { createBrowserWindow } from "./desktopWindowChrome.js";
import type { HostInitMessage, WindowBootstrapOptions } from "./desktopHostProcess.js";
import type { StartupWorkspaceWarmupTarget } from "./startupWorkspace.js";
import { handleDarwinWindowCloseRequest } from "./desktopDarwinCloseBehavior.js";
import {
  parseWindowUnreadCount,
  sumWindowUnreadCounts,
  syncAppUnreadBadge,
} from "./unreadBadge.js";
import { attachDesktopWindowSizePersistence, type DesktopWindowSize } from "./desktopWindowSize.js";
import {
  registerMainApplicationWindow,
  unregisterMainApplicationWindow,
} from "./resourceManagerWindow.js";

const DEFAULT_RUNTIME_PROCESS_ENV_WAIT_TIMEOUT_MS = 4_500;

export function createWindow(options: {
  iconPath: string;
  preloadPath: string;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  forceQuitRef: { current: boolean };
  handleBeforeClose?: (win: BrowserWindow, label: string) => boolean;
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  spawnHostProcess: (
    win: BrowserWindow,
    label: string,
    initMessage: HostInitMessage,
  ) => ElectronUtilityProcess;
  disposeHostProcess: (
    child: ElectronUtilityProcess,
    label: string,
    forceKillDelayMs?: number,
  ) => void;
  syncAutoUpdaterStateToWindow: (win: BrowserWindow) => void;
  syncReadyUpdateToWindow: (win: BrowserWindow) => void;
  syncPostUpdateReleaseNotesToWindow: (win: BrowserWindow) => void;
  disposeRemoteWorkspaceSessionsForWindow: (windowId: number, reason: string) => void;
  reattachRemoteWorkspaceSessionsForWindow: (win: BrowserWindow, reason: string) => void;
  bootstrap?: WindowBootstrapOptions;
  agentWarmupTargets?: readonly StartupWorkspaceWarmupTarget[];
  agentSpawnFallbackCwd: string;
  deviceMid: string;
  initialDesktopZoomLevel?: number;
  initialWindowSize?: DesktopWindowSize;
  currentApplicationLocale?: () => Locale;
  persistWindowSize?: (state: DesktopWindowSize) => Promise<void>;
  /** Asynchronous environment collection started during Main module initialization; usually completes before renderer dom-ready. */
  runtimeProcessEnvPatchPromise?: Promise<Record<string, string>>;
  /** Complete fallback patch that can be computed without executing a shell; inject it into Local Host if warmup fails/times out. */
  runtimeProcessEnvFallbackPatch: Record<string, string>;
  /** Injected only for startup gating and tests; after this time, fail open and create Local Host. */
  runtimeProcessEnvWaitTimeoutMs?: number;
  /**
   * Bounded rollout decision gate before creating the first Local Host.
   *
   * When omitted (undefined), do not await at all; the dom-ready handler runs synchronously, keeping
   * existing callers and tests unchanged. Only desktop main injects this: await one rollout decision
   * before spawnLocalHost so a cold-start snapshot of { enabled:false } is not frozen into the first
   * Host environment and made impossible to override with a later successful result.
   */
  awaitFirstHostSpawnDecision?: () => Promise<void>;
  /** Local Host map insertion completed; presentation facts can now be replayed safely. */
  onHostProcessReady?: (windowKey: number) => void;
  resolveBrowserViewOwner?: Parameters<typeof createBrowserWindow>[0]["resolveBrowserViewOwner"];
}) {
  const win = createBrowserWindow({
    iconPath: options.iconPath,
    preloadPath: options.preloadPath,
    bootstrap: {
      restoreSession: options.bootstrap?.restoreSession ?? true,
      supportsSettings: options.bootstrap?.supportsSettings ?? true,
      initialWorkspacePath: options.bootstrap?.initialWorkspacePath,
      initialWorkspacePurpose: options.bootstrap?.initialWorkspacePurpose,
      unavailableWorkspacePath: options.bootstrap?.unavailableWorkspacePath,
    },
    logger: options.logger,
    deviceMid: options.deviceMid,
    initialDesktopZoomLevel: options.initialDesktopZoomLevel,
    initialWindowSize: options.initialWindowSize,
    currentApplicationLocale: options.currentApplicationLocale,
    resolveBrowserViewOwner: options.resolveBrowserViewOwner,
  });
  const label = `local-${win.webContents.id}`;

  if (options.persistWindowSize) {
    attachDesktopWindowSizePersistence(win, options.persistWindowSize, (error) => {
      options.logger.warn("[desktop-window] failed to persist main window size", error);
    });
  }

  if (process.platform === "darwin") {
    win.on("close", (event) => {
      if (
        handleDarwinWindowCloseRequest({
          win,
          forceQuit: options.forceQuitRef.current,
          label,
          logger: options.logger,
        })
      ) {
        event.preventDefault();
      }
    });
  } else if (options.handleBeforeClose) {
    win.on("close", (event) => {
      if (options.handleBeforeClose?.(win, label)) {
        event.preventDefault();
      }
    });
  }

  const wcId = win.webContents.id;
  const browserWindowId = win.id;
  // Resource telemetry uses this to classify the main-window renderer as renderer_main and auxiliary windows/DevTools as chromium_other.
  registerMainApplicationWindow(wcId);
  let domReadyGeneration = 0;
  let cancelRuntimeProcessEnvWait: (() => void) | null = null;
  scheduleArmsBrowserPerfLoadNudge(win.webContents);
  win.webContents.on("dom-ready", async () => {
    cancelRuntimeProcessEnvWait?.();
    cancelRuntimeProcessEnvWait = null;
    const currentDomReadyGeneration = ++domReadyGeneration;
    options.logger.info(`[createWindow] dom-ready fired (${label})`);

    if (process.platform === "win32" && !win.isDestroyed()) {
      win.show();
      win.focus();
    }

    const oldChild = options.windowHostProcessMap.get(wcId);
    // Renderer reload used to unconditionally kill and recreate the Host process, also killing the
    // CLI Agent and losing active sessions. That was the root cause of unstable session identity.
    // Host/CLI lifetimes belong to the window, not the renderer load cycle: on reload, attach a new
    // RPC MessagePort to the existing Host (reusing the web remote-control AttachServicePort channel)
    // and let the renderer resubscribe to restore its projection. The old ChannelServer closes and
    // cleans itself up when the renderer context is destroyed.
    if (oldChild && oldChild.pid !== undefined) {
      try {
        const startupPayload = getDatabaseStartupPortPayload(oldChild);
        if (!startupPayload) throw new Error("Previous Host startup binding is unavailable");
        const { port1, port2 } = new MessageChannelMain();
        oldChild.postMessage(
          {
            type: HostMessageTypes.AttachServicePort,
            requestId: randomUUID(),
            attachmentId: randomUUID(),
            clientMode: "desktop-continuous",
            scope: { kind: "local" },
          },
          [port2],
        );
        win.webContents.postMessage(InternalChannels.ServicePort, startupPayload, [port1]);
        options.logger.info(
          `[createWindow] renderer reloaded, reattached to existing host (${label}), pid=${oldChild.pid}`,
        );
        options.syncAutoUpdaterStateToWindow(win);
        options.syncReadyUpdateToWindow(win);
        options.syncPostUpdateReleaseNotesToWindow(win);
        options.reattachRemoteWorkspaceSessionsForWindow(win, `${label}:renderer-reload`);
        return;
      } catch (error) {
        options.logger.warn(
          `[createWindow] reattach to existing host failed (${label}), falling back to respawn:`,
          error,
        );
      }
    }
    if (oldChild) {
      options.logger.info(
        `[createWindow] killing previous host process for (${label}), pid=${oldChild.pid ?? "unknown"}`,
      );
      options.disposeHostProcess(oldChild, `${label}:reload`, 150);
    }

    // Bounded rollout decision gate before creating the first Local Host. Use an `if` guard instead
    // of `await cb?.()` so a missing callback causes no await and the async handler completes
    // synchronously, preserving existing callers and tests. Wait only when spawning a new Host; the
    // reattach path returns above and does not trigger this gate.
    if (options.awaitFirstHostSpawnDecision) {
      await options.awaitFirstHostSpawnDecision();
    }

    const spawnLocalHost = (runtimeProcessEnvPatch: Record<string, string>) => {
      if (currentDomReadyGeneration !== domReadyGeneration || win.isDestroyed()) {
        return;
      }
      const primaryWarmupTarget = options.agentWarmupTargets?.[0];
      const child = options.spawnHostProcess(win, label, {
        type: HostMessageTypes.InitLocal,
        deviceMid: options.deviceMid,
        workspacePath: primaryWarmupTarget?.workspacePath,
        workspaceIdentity: primaryWarmupTarget?.workspaceIdentity,
        ...(options.agentWarmupTargets && options.agentWarmupTargets.length > 0
          ? { agentWarmupTargets: [...options.agentWarmupTargets] }
          : {}),
        runtimeProcessEnvPatch,
        // The same window indexes every restored workspace in the background, not just the active
        // workspace at startup. The fallback must live for the Local Host's lifetime; otherwise,
        // deleting a non-active historical directory could cause repeated spawns with a stale cwd.
        agentSpawnFallbackCwd: options.agentSpawnFallbackCwd,
      });
      options.windowHostProcessMap.set(wcId, child);
      options.onHostProcessReady?.(wcId);
      options.syncAutoUpdaterStateToWindow(win);
      options.syncReadyUpdateToWindow(win);
      options.syncPostUpdateReleaseNotesToWindow(win);
      options.reattachRemoteWorkspaceSessionsForWindow(win, `${label}:renderer-ready`);
    };

    if (!options.runtimeProcessEnvPatchPromise) {
      spawnLocalHost(options.runtimeProcessEnvFallbackPatch);
      return;
    }
    let settled = false;
    const waitTimeoutMs =
      options.runtimeProcessEnvWaitTimeoutMs ?? DEFAULT_RUNTIME_PROCESS_ENV_WAIT_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cancelWait = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
    };
    const completeWait = (runtimeProcessEnvPatch: Record<string, string>) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (cancelRuntimeProcessEnvWait === cancelWait) {
        cancelRuntimeProcessEnvWait = null;
      }
      spawnLocalHost(runtimeProcessEnvPatch);
    };
    cancelRuntimeProcessEnvWait = cancelWait;
    timeout = setTimeout(() => {
      options.logger.warn(
        `[createWindow] runtime env prewarm exceeded ${waitTimeoutMs}ms after dom-ready (${label}), using shell-free fallback`,
      );
      completeWait(options.runtimeProcessEnvFallbackPatch);
    }, waitTimeoutMs);
    void options.runtimeProcessEnvPatchPromise.then(completeWait, (error) => {
      options.logger.warn(
        `[createWindow] runtime env prewarm failed (${label}), using shell-free fallback:`,
        error,
      );
      // The old rejection branch passed undefined, causing Host to synchronously run the same login
      // shell and possibly move a Main white screen into a Host hang. The Main path always passes a
      // precomputed fallback patch.
      completeWait(options.runtimeProcessEnvFallbackPatch);
    });
  });

  win.on("closed", () => {
    unregisterMainApplicationWindow(wcId);
    cancelRuntimeProcessEnvWait?.();
    cancelRuntimeProcessEnvWait = null;
    options.logger.info(`[createWindow] window closed, killing host process (${label})`);
    const child = options.windowHostProcessMap.get(wcId);
    if (child) {
      options.disposeHostProcess(child, `${label}:window-closed`);
      options.windowHostProcessMap.delete(wcId);
    }
    options.disposeRemoteWorkspaceSessionsForWindow(wcId, `${label}:window-closed`);
  });

  return win;
}

export function showCurrentWindowFromDock(primaryWindowCoordinator: {
  ensurePrimaryWindow(reason: string): Promise<void>;
}) {
  if (process.platform === "darwin") {
    app.show();
  }

  void primaryWindowCoordinator.ensurePrimaryWindow("dock-show-current-window");
}

export function focusWorkspaceInExistingWindow(
  path: string,
  windowWorkspaceMap: Map<number, Set<string>>,
  options?: { skipWindowId?: number },
): { activated: boolean; winId?: number } {
  for (const [winId, pathSet] of windowWorkspaceMap) {
    if (options?.skipWindowId === winId) {
      continue;
    }
    if (!pathSet.has(path)) {
      continue;
    }

    const existingWin = BrowserWindow.fromId(winId);
    if (existingWin && !existingWin.isDestroyed()) {
      if (existingWin.isMinimized()) {
        existingWin.restore();
      }
      existingWin.focus();
      existingWin.webContents.send(PlatformChannels.FocusTab, path);
      return { activated: true, winId };
    }

    windowWorkspaceMap.delete(winId);
  }

  return { activated: false };
}

export function syncApplicationUnreadBadge(windowUnreadCountMap: Map<number, number>) {
  syncAppUnreadBadge({
    platform: process.platform,
    totalUnreadCount: sumWindowUnreadCounts(windowUnreadCountMap),
    setBadgeCount: (count) => {
      app.setBadgeCount(count);
    },
  });
}

export function handleWindowUnreadCountSync(
  win: BrowserWindow | null,
  payload: unknown,
  windowUnreadCountMap: Map<number, number>,
  logger: { warn: (...args: unknown[]) => void },
) {
  const unreadCount = parseWindowUnreadCount(payload);
  if (unreadCount == null) {
    logger.warn("[sync-window-unread-count] invalid payload:", payload);
    return false;
  }

  if (!win) {
    return false;
  }

  if (unreadCount === 0) {
    windowUnreadCountMap.delete(win.id);
  } else {
    windowUnreadCountMap.set(win.id, unreadCount);
  }
  syncApplicationUnreadBadge(windowUnreadCountMap);
  return true;
}

export function configureDockMenu(getLabel: () => string, onShowCurrentWindow: () => void) {
  if (process.platform !== "darwin" || app.dock == null) {
    return;
  }

  const dockMenu = Menu.buildFromTemplate([
    {
      label: getLabel(),
      click: onShowCurrentWindow,
    },
  ]);

  app.dock.setMenu(dockMenu);
}

export function handleDesktopWindowCloseRequest(options: {
  platform: NodeJS.Platform;
  forceQuit: boolean;
  explicitQuitRequested?: boolean;
  closeToTrayOnWindows?: boolean;
  isLastWindow: boolean;
  label: string;
  logger: { info: (...args: unknown[]) => void };
  shouldConfirmQuit?: boolean;
  confirmQuit: () => boolean;
  requestQuit: () => void;
  hideWindow?: () => void;
}) {
  if (
    options.platform === "win32" &&
    options.closeToTrayOnWindows &&
    !options.forceQuit &&
    !options.explicitQuitRequested
  ) {
    options.logger.info(`[createWindow] window close hidden to tray (${options.label})`);
    options.hideWindow?.();
    return true;
  }

  if (options.platform === "darwin" || options.forceQuit || !options.isLastWindow) {
    return false;
  }

  if (options.shouldConfirmQuit === false) {
    options.logger.info(
      `[createWindow] last window close skipped confirmation, quitting app (${options.label})`,
    );
    options.requestQuit();
    return true;
  }

  if (!options.confirmQuit()) {
    options.logger.info(`[createWindow] last window close canceled by user (${options.label})`);
    return true;
  }

  options.logger.info(
    `[createWindow] last window close confirmed, quitting app (${options.label})`,
  );
  options.requestQuit();
  return true;
}
