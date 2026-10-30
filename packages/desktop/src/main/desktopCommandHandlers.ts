import { getPluginSandboxHost } from "./pluginSandbox/index.js";
/* eslint-disable max-lines -- Desktop command dispatch shares window/platform context; keeping it together makes behavior easier to keep consistent. */
import { readZCodeStdioTapDevState, setZCodeStdioTapDevEnabled } from "@zcode/services/node";
import {
  buildZCodeEndpointUrls,
  DEFAULT_LOCALE,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  DesktopCommandIds,
  REWARDS_PARTITION,
  getCommunityUrlFromConfigs,
  getFeedbackUrlFromConfig,
  normalizeZCodeEndpointOrigin,
  PlatformChannels,
  resolveHelpAppConfig,
  resolveZCodeEndpointOrigin,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  type AppSettings,
  type DesktopCommandId,
  type Locale,
} from "@zcode/shared";
import type { MessageBoxOptions } from "electron";
import { app, BrowserWindow, dialog, session, shell } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { showAboutDialog } from "./about.js";
import { restoreDictationSystemMuteForShutdown } from "./desktopDictationSystemAudio.js";
import { checkForUpdateMenuClick } from "./autoUpdater.js";
import { resolveCuaOsSupport } from "./cuaOsSupport.js";
import { syncWindowControlsOverlayForZoomLevel } from "./desktopWindowButtonPosition.js";
import {
  DEFAULT_DESKTOP_WINDOW_HEIGHT,
  DEFAULT_DESKTOP_WINDOW_WIDTH,
} from "./desktopWindowSize.js";
import {
  clampDesktopZoomLevel,
  resolveDesktopZoomFactorForLevel,
  resolveDesktopZoomLevelFromFactor,
} from "./desktopZoom.js";
import { exportLogs } from "./exportLogs.js";
import { openResourceManager } from "./resourceManagerWindow.js";

export const HELP_TOGGLE_DEV_TOOLS_MENU_ID = "help.toggle-dev-tools";
export const HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID = "help.toggle-zcode-stdio-tap";
const ZCODE_ENDPOINT_PROMPT_WIDTH = 460;
const ZCODE_ENDPOINT_PROMPT_HEIGHT = 210;
const CODING_PLAN_WEBVIEW_PARTITION = "persist:zcode-coding-plan";

function resolveTargetWindow(senderWindow?: BrowserWindow | null) {
  if (senderWindow && !senderWindow.isDestroyed()) {
    return senderWindow;
  }

  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}
export function updateDesktopZoomLevel(
  targetWindow: BrowserWindow | null | undefined,
  action: "reset" | "in" | "out",
) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  const currentLevel = resolveDesktopZoomLevelFromFactor(targetWindow.webContents.getZoomFactor());
  const nextLevel =
    action === "reset" ? 0 : clampDesktopZoomLevel(currentLevel + (action === "in" ? 1 : -1));

  // System zoom shortcuts should work without allowing unbounded zoom in either direction.
  // Electron zoomLevel uses a real scale of 1.2^level; use zoomFactor here so each step is consistently 1.1.
  targetWindow.webContents.setZoomFactor(resolveDesktopZoomFactorForLevel(nextLevel));
  syncWindowControlsOverlayForZoomLevel(targetWindow, nextLevel);
  targetWindow.webContents.send(PlatformChannels.DesktopZoomLevelChanged, { zoomLevel: nextLevel });
  return nextLevel;
}

function showMessageBoxWithOptionalParent(
  parentWindow: BrowserWindow | null | undefined,
  options: MessageBoxOptions,
) {
  return parentWindow
    ? dialog.showMessageBox(parentWindow, options)
    : dialog.showMessageBox(options);
}
const CLEAR_ALL_DATA_MESSAGES: Record<
  Locale,
  { title: string; message: string; detail: string; cancelLabel: string; confirmLabel: string }
> = {
  "zh-CN": {
    title: "清除所有数据",
    message: "确定要清除所有数据吗？",
    detail:
      "将删除 ~/.zcode/v2（配置、凭据、日志）和浏览器缓存（localStorage）。操作不可恢复，清除后应用将自动重启。",
    cancelLabel: "取消",
    confirmLabel: "全部清除",
  },
  "en-US": {
    title: "Clear All Data",
    message: "Clear all data?",
    detail:
      "This deletes ~/.zcode/v2 (settings, credentials, logs) and the browser cache (localStorage). It cannot be undone. The app restarts afterwards.",
    cancelLabel: "Cancel",
    confirmLabel: "Clear All",
  },
  "uk-UA": {
    title: "Очистити всі дані",
    message: "Очистити всі дані?",
    detail:
      "Буде видалено ~/.zcode/v2 (налаштування, облікові дані, журнали) і кеш браузера (localStorage). Цю дію не можна скасувати. Після очищення застосунок перезапуститься.",
    cancelLabel: "Скасувати",
    confirmLabel: "Очистити все",
  },
};

async function clearAllDataAndRelaunch(options: {
  credentialsDir: string;
  locale: Locale;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}) {
  const messages =
    CLEAR_ALL_DATA_MESSAGES[options.locale] ?? CLEAR_ALL_DATA_MESSAGES[DEFAULT_LOCALE];
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: [messages.cancelLabel, messages.confirmLabel],
    defaultId: 0,
    cancelId: 0,
    title: messages.title,
    message: messages.message,
    detail: messages.detail,
  });
  if (response !== 1) {
    return;
  }

  // Cleared only after confirmation: clearing these partitions signs the user out of Coding Plan.
  await clearCodingPlanWebviewStorage({ logger: options.logger });
  await getPluginSandboxHost()?.clearBrowserData();
  const { rm } = await import("node:fs/promises");
  try {
    await rm(options.credentialsDir, { recursive: true, force: true });
    options.logger.info("[clear-all-data] deleted ~/.zcode/v2");
  } catch (error) {
    options.logger.error("[clear-all-data] failed to delete ~/.zcode/v2:", error);
  }

  for (const win of BrowserWindow.getAllWindows()) {
    try {
      await win.webContents.executeJavaScript("localStorage.clear()");
    } catch {
      // The window may already be destroyed; ignore it.
    }
  }

  try {
    const session = BrowserWindow.getAllWindows()[0]?.webContents.session;
    if (session) {
      await session.clearStorageData();
      options.logger.info("[clear-all-data] cleared session storage data");
    }
  } catch (error) {
    options.logger.error("[clear-all-data] failed to clear session data:", error);
  }

  // Clear All exits outside exitPreparedApp, so the dictation system mute must be released here
  // or a restart during a recording would leave the OS muted into the relaunched app.
  await restoreDictationSystemMuteForShutdown();
  app.relaunch();
  app.exit(0);
}

export async function clearCodingPlanWebviewStorage(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}) {
  try {
    // The Coding Plan webview uses a separate persistent partition, which is not covered by the
    // default window's session.clearStorageData(). Explicitly clear it on logout/data cleanup so the
    // next visit to the official site cannot read an old account token.
    await session.fromPartition(CODING_PLAN_WEBVIEW_PARTITION).clearStorageData();
    await session.fromPartition(REWARDS_PARTITION).clearStorageData();
    options.logger.info("[coding-plan-webview] cleared persistent partition storage");
  } catch (error) {
    options.logger.warn(
      "[coding-plan-webview] failed to clear persistent partition storage:",
      error,
    );
  }
}

async function fetchRemoteAppConfig(fetchRemoteConfig?: () => Promise<unknown>): Promise<unknown> {
  if (!fetchRemoteConfig) throw new Error("Help config reader is unavailable");
  return fetchRemoteConfig();
}

export function resolveLocalAppConfigPath(options?: {
  appPath?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
}): string {
  const isPackaged = options?.isPackaged ?? app.isPackaged;
  if (isPackaged) {
    // In production, app.getAppPath() points to resources/app.asar; walking up two levels would
    // incorrectly read Contents/config. electron-builder places bundled config in resources/config,
    // so resolve it from resourcesPath.
    return join(options?.resourcesPath ?? process.resourcesPath, "config/default.json");
  }
  return join(options?.appPath ?? app.getAppPath(), "../../config/default.json");
}

async function readLocalAppConfig(readLocalConfig?: () => unknown): Promise<unknown> {
  const localConfigPath = resolveLocalAppConfigPath();
  return readLocalConfig?.() ?? JSON.parse(await readFile(localConfigPath, "utf-8"));
}

async function resolveRemoteAppConfigValue(options: {
  fetchRemoteConfig?: () => Promise<unknown>;
  readLocalConfig?: () => unknown;
  resolveFromConfig: (config: unknown) => string | undefined;
  logPrefix: "feedback" | "community";
  logger: {
    warn: (...args: unknown[]) => void;
  };
}): Promise<string | undefined> {
  try {
    const remoteConfig = await fetchRemoteAppConfig(options.fetchRemoteConfig);
    const remoteResolvedValue = options.resolveFromConfig(remoteConfig);
    if (remoteResolvedValue) {
      return remoteResolvedValue;
    }
  } catch (error) {
    options.logger.warn(`[${options.logPrefix}] failed to fetch remote config:`, error);
  }

  try {
    const localConfig = await readLocalAppConfig(options.readLocalConfig);
    const localResolvedValue = options.resolveFromConfig(localConfig);
    if (localResolvedValue) {
      return localResolvedValue;
    }
  } catch (error) {
    options.logger.warn(`[${options.logPrefix}] failed to read local config:`, error);
  }

  return undefined;
}

export async function resolveFeedbackUrl(options: {
  fetchRemoteConfig?: () => Promise<unknown>;
  readLocalConfig?: () => unknown;
  logger: {
    warn: (...args: unknown[]) => void;
  };
}): Promise<string | undefined> {
  return resolveRemoteAppConfigValue({
    ...options,
    logPrefix: "feedback",
    resolveFromConfig: getFeedbackUrlFromConfig,
  });
}

export async function resolveCommunityUrl(options: {
  locale: Locale;
  fetchRemoteConfig?: () => Promise<unknown>;
  readLocalConfig?: () => unknown;
  logger: {
    warn: (...args: unknown[]) => void;
  };
}): Promise<string | undefined> {
  let remoteConfig: unknown;
  try {
    remoteConfig = await fetchRemoteAppConfig(options.fetchRemoteConfig);
  } catch (error) {
    options.logger.warn("[community] failed to fetch remote config:", error);
  }

  let localConfig: unknown;
  try {
    localConfig = await readLocalAppConfig(options.readLocalConfig);
  } catch (error) {
    options.logger.warn("[community] failed to read local config:", error);
  }

  return getCommunityUrlFromConfigs(remoteConfig, localConfig, options.locale);
}

async function openFeedback(
  logger: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
  targetWindow?: BrowserWindow | null,
  fetchRemoteConfig?: () => Promise<unknown>,
) {
  let remoteConfig: unknown;
  let localConfig: unknown;
  try {
    remoteConfig = await fetchRemoteAppConfig(fetchRemoteConfig);
  } catch (error) {
    logger.warn("[feedback] failed to fetch remote config:", error);
  }
  try {
    localConfig = await readLocalAppConfig();
  } catch (error) {
    logger.warn("[feedback] failed to read local config:", error);
  }
  const config = resolveHelpAppConfig(remoteConfig, localConfig);
  if (!config.feedback_use_external_form) {
    resolveTargetWindow(targetWindow)?.webContents.send(PlatformChannels.OpenFeedbackDialog);
    return;
  }
  if (config.feedback_url) await shell.openExternal(config.feedback_url);
}

async function openCommunity(
  locale: Locale,
  logger: {
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  },
  fetchRemoteConfig?: () => Promise<unknown>,
) {
  const communityUrl = await resolveCommunityUrl({ locale, logger, fetchRemoteConfig });
  if (!communityUrl) {
    logger.warn("[community] community_urls is missing from both remote and local config");
    return;
  }
  await shell.openExternal(communityUrl);
}

async function promptCustomZCodeEndpoint(
  targetWindow: BrowserWindow | null | undefined,
  currentValue: string,
): Promise<string | undefined> {
  return showZCodeEndpointPromptWindow({
    currentValue,
    parentWindow: targetWindow && !targetWindow.isDestroyed() ? targetWindow : undefined,
  });
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildZCodeEndpointPromptHtml(currentValue: string): string {
  const value = escapeHtmlAttribute(currentValue);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>ZCode Endpoint</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 600; }
      input { box-sizing: border-box; width: 100%; height: 34px; padding: 6px 8px; font: inherit; }
      .hint { margin-top: 8px; color: #6b7280; font-size: 12px; }
      .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
      button { min-width: 78px; height: 30px; font: inherit; }
    </style>
  </head>
  <body>
    <form id="form">
      <label for="endpoint">ZCode endpoint origin</label>
      <input id="endpoint" value="${value}" placeholder="https://zcode.z.ai" spellcheck="false" />
      <div class="hint">Use an http or https origin, for example https://zcode.z.ai.</div>
      <div class="actions">
        <button id="cancel" type="button">Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>
    <script>
      const input = document.getElementById("endpoint");
      const submit = (value) => { document.title = "zcode-endpoint-submit:" + encodeURIComponent(value); };
      document.getElementById("form").addEventListener("submit", (event) => {
        event.preventDefault();
        submit(input.value);
      });
      document.getElementById("cancel").addEventListener("click", () => {
        document.title = "zcode-endpoint-cancel";
      });
      input.focus();
      input.select();
    </script>
  </body>
</html>`;
}

function showZCodeEndpointPromptWindow(options: {
  currentValue: string;
  parentWindow?: BrowserWindow;
}): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const promptWindow = new BrowserWindow({
      width: ZCODE_ENDPOINT_PROMPT_WIDTH,
      height: ZCODE_ENDPOINT_PROMPT_HEIGHT,
      parent: options.parentWindow,
      modal: Boolean(options.parentWindow),
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: "ZCode Endpoint",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const finish = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
      if (!promptWindow.isDestroyed()) {
        promptWindow.close();
      }
    };

    promptWindow.on("closed", () => finish(undefined));
    promptWindow.on("page-title-updated", (event, title) => {
      if (title === "zcode-endpoint-cancel") {
        event.preventDefault();
        finish(undefined);
        return;
      }
      if (!title.startsWith("zcode-endpoint-submit:")) {
        return;
      }
      event.preventDefault();
      finish(decodeURIComponent(title.slice("zcode-endpoint-submit:".length)));
    });

    // Electron menu commands run in main; calling renderer window.prompt may be disabled or unfocused,
    // making the click appear to do nothing. Create a controlled modal input window in main so
    // Custom... always has a visible interaction path.
    void promptWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        buildZCodeEndpointPromptHtml(options.currentValue),
      )}`,
    );
  });
}

async function setZCodeEndpointOverride(options: {
  value: string | undefined;
  settingService: { update(patch: { zcodeEndpointOrigin?: string | undefined }): Promise<void> };
  onZCodeEndpointChanged: () => Promise<void> | void;
  logger: { warn: (...args: unknown[]) => void };
}) {
  if (ZCODE_ENV === "production") {
    return;
  }
  const normalized = options.value ? normalizeZCodeEndpointOrigin(options.value) : undefined;
  await options.settingService.update({ zcodeEndpointOrigin: normalized });
  await options.onZCodeEndpointChanged();
}

async function persistDesktopZoomLevel(options: {
  zoomLevel: number;
  logger: { warn: (...args: unknown[]) => void };
  settingService: { update(patch: Pick<AppSettings, "desktopZoomLevel">): Promise<void> };
}) {
  try {
    // The desktop zoom command previously changed only the current BrowserWindow, with no source to
    // restore the setting after restart. Persist the clamped level to setting.json on success so
    // keyboard shortcuts, the View menu, and the sidebar menu share one source of truth.
    await options.settingService.update({ desktopZoomLevel: options.zoomLevel });
  } catch (error) {
    options.logger.warn("[desktop-zoom] persist zoom level failed:", error);
  }
}

function toggleZCodeStdioTapDevProxy(options: {
  logger: { info: (...args: unknown[]) => void };
  updateZCodeStdioTapDevMenuState: () => void;
}) {
  const current = readZCodeStdioTapDevState();
  const next = setZCodeStdioTapDevEnabled(!current.enabled);
  options.updateZCodeStdioTapDevMenuState();
  options.logger.info("[stdio-tap] dev proxy toggled", {
    enabled: next.enabled,
    visible: next.visible,
    logDir: next.logDir,
  });
}

function resolveChangelogUrl(
  locale: Locale,
  endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN,
): string {
  // The Help menu's external link used a fixed English URL, so the changelog remained in English
  // after switching the interface to Chinese. Route it through main using the current app language
  // to avoid adding inconsistent branches to menu templates.
  const origin = buildZCodeEndpointUrls(endpointOrigin).origin;
  return locale === "zh-CN" ? `${origin}/cn/changelog` : `${origin}/en/changelog`;
}

export async function openChangelog(
  locale: Locale,
  endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN,
) {
  await shell.openExternal(resolveChangelogUrl(locale, endpointOrigin));
}

async function resolveCurrentZCodeEndpointOrigin(settingService: {
  get(): Promise<{ zcodeEndpointOrigin?: string }>;
  envBaseOrigin?: string | null;
}): Promise<string> {
  const settings = await settingService.get();
  return resolveZCodeEndpointOrigin({
    env: ZCODE_ENV,
    envBaseOrigin: settingService.envBaseOrigin,
    overrideOrigin: settings.zcodeEndpointOrigin,
  });
}

export async function executeDesktopCommand(options: {
  command: DesktopCommandId;
  fetchHelpConfig?: () => Promise<unknown>;
  senderWindow?: BrowserWindow | null;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  updateZCodeStdioTapDevMenuState: () => void;
  onDesktopZoomChanged?: (zoomLevel: number) => Promise<void> | void;
  onZCodeEndpointChanged: () => Promise<void> | void;
  onRelaunchApp: () => Promise<void>;
  settingService: {
    get(): Promise<Pick<AppSettings, "zcodeEndpointOrigin" | "desktopZoomLevel">>;
    update(
      patch: Partial<Pick<AppSettings, "zcodeEndpointOrigin" | "desktopZoomLevel">>,
    ): Promise<void>;
  };
  zcodeEndpointEnvBaseOrigin?: string | null;
  /** Distinct test origin for the endpoint menu; undefined when none is configured (spec: specs/zcode-test-endpoint-menu.md). */
  zcodeTestEndpointOrigin?: string;
  credentialsDir: string;
  currentApplicationLocale: Locale;
}) {
  const targetWindow = resolveTargetWindow(options.senderWindow);
  options.logger.info(
    `[desktop-command] execute ${options.command} windowId=${targetWindow?.id ?? "<none>"}`,
  );

  switch (options.command) {
    case DesktopCommandIds.NewTask:
      targetWindow?.webContents.send(PlatformChannels.NewTask);
      return;
    case DesktopCommandIds.OpenWorkspace:
      targetWindow?.webContents.send(PlatformChannels.OpenWorkspace);
      return;
    case DesktopCommandIds.CloseActiveContext:
      targetWindow?.webContents.send(PlatformChannels.CloseActiveContextRequest);
      return;
    case DesktopCommandIds.CloseWindow:
      targetWindow?.close();
      return;
    case DesktopCommandIds.MinimizeWindow:
      targetWindow?.minimize();
      return;
    case DesktopCommandIds.ToggleMaximizeWindow:
      if (targetWindow?.isMaximized()) {
        targetWindow.unmaximize();
      } else {
        targetWindow?.maximize();
      }
      return;
    case DesktopCommandIds.ToggleFullScreen:
      if (targetWindow) {
        targetWindow.setFullScreen(!targetWindow.isFullScreen());
      }
      return;
    case DesktopCommandIds.ResetWindowSize:
      if (targetWindow) {
        if (targetWindow.isFullScreen()) targetWindow.setFullScreen(false);
        if (targetWindow.isMaximized()) targetWindow.unmaximize();
        targetWindow.setSize(DEFAULT_DESKTOP_WINDOW_WIDTH, DEFAULT_DESKTOP_WINDOW_HEIGHT, true);
      }
      return;
    case DesktopCommandIds.ResetZoom:
      {
        const nextZoomLevel = updateDesktopZoomLevel(targetWindow, "reset");
        if (nextZoomLevel !== undefined) {
          await persistDesktopZoomLevel({
            zoomLevel: nextZoomLevel,
            logger: options.logger,
            settingService: options.settingService,
          });
          await options.onDesktopZoomChanged?.(nextZoomLevel);
        }
      }
      return;
    case DesktopCommandIds.ZoomIn:
      {
        const nextZoomLevel = updateDesktopZoomLevel(targetWindow, "in");
        if (nextZoomLevel !== undefined) {
          await persistDesktopZoomLevel({
            zoomLevel: nextZoomLevel,
            logger: options.logger,
            settingService: options.settingService,
          });
          await options.onDesktopZoomChanged?.(nextZoomLevel);
        }
      }
      return;
    case DesktopCommandIds.ZoomOut:
      {
        const nextZoomLevel = updateDesktopZoomLevel(targetWindow, "out");
        if (nextZoomLevel !== undefined) {
          await persistDesktopZoomLevel({
            zoomLevel: nextZoomLevel,
            logger: options.logger,
            settingService: options.settingService,
          });
          await options.onDesktopZoomChanged?.(nextZoomLevel);
        }
      }
      return;
    case DesktopCommandIds.ShowAbout:
      await showAboutDialog(targetWindow ?? undefined, options.currentApplicationLocale);
      return;
    case DesktopCommandIds.OpenChangelog:
      await openChangelog(
        options.currentApplicationLocale,
        await resolveCurrentZCodeEndpointOrigin({
          ...options.settingService,
          envBaseOrigin: options.zcodeEndpointEnvBaseOrigin,
        }),
      );
      return;
    case DesktopCommandIds.CheckForUpdates:
      // Gate by product identity rather than backend environment: Preview also has no updater when using the production backend.
      if (ZCODE_PRODUCT_FLAVOR === "production") {
        checkForUpdateMenuClick(targetWindow);
      } else {
        options.logger.info("[auto-update] Preview 已禁用手动更新检查");
      }
      return;
    case DesktopCommandIds.RelaunchApp:
      await options.onRelaunchApp();
      return;
    case DesktopCommandIds.OpenFeedback:
      await openFeedback(options.logger, targetWindow, options.fetchHelpConfig);
      return;
    case DesktopCommandIds.OpenCommunity:
      await openCommunity(
        options.currentApplicationLocale,
        options.logger,
        options.fetchHelpConfig,
      );
      return;
    case DesktopCommandIds.ExportLogs:
      await exportLogs();
      return;
    case DesktopCommandIds.ToggleDevTools:
      targetWindow?.webContents.toggleDevTools();
      return;
    case DesktopCommandIds.OpenResourceManager:
      openResourceManager();
      return;
    case DesktopCommandIds.ToggleZCodeStdioTapDevProxy:
      toggleZCodeStdioTapDevProxy({
        logger: options.logger,
        updateZCodeStdioTapDevMenuState: options.updateZCodeStdioTapDevMenuState,
      });
      return;
    case DesktopCommandIds.SetZCodeEndpointProduction:
      await setZCodeEndpointOverride({
        value: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
        settingService: options.settingService,
        onZCodeEndpointChanged: options.onZCodeEndpointChanged,
        logger: options.logger,
      });
      return;
    case DesktopCommandIds.SetZCodeEndpointTest:
      // TEST_ZCODE_ENDPOINT_ORIGIN equals production since the open-source import; saving it as
      // "test" made the menu snap back to Production, so only a distinct configured origin is saved.
      if (!options.zcodeTestEndpointOrigin) {
        options.logger.warn(
          "[desktop-command] test endpoint unavailable: ZCODE_TEST_BASE_URL is not set to a non-production origin",
        );
        return;
      }
      await setZCodeEndpointOverride({
        value: options.zcodeTestEndpointOrigin,
        settingService: options.settingService,
        onZCodeEndpointChanged: options.onZCodeEndpointChanged,
        logger: options.logger,
      });
      return;
    case DesktopCommandIds.SetZCodeEndpointCustom: {
      const current =
        (await options.settingService.get()).zcodeEndpointOrigin ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN;
      const value = await promptCustomZCodeEndpoint(targetWindow, current);
      if (!value) {
        return;
      }
      try {
        await setZCodeEndpointOverride({
          value,
          settingService: options.settingService,
          onZCodeEndpointChanged: options.onZCodeEndpointChanged,
          logger: options.logger,
        });
      } catch (error) {
        await showMessageBoxWithOptionalParent(targetWindow, {
          type: "error",
          title: "ZCode Endpoint",
          message: "Endpoint 无效",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    case DesktopCommandIds.ResetZCodeEndpoint:
      await setZCodeEndpointOverride({
        value: undefined,
        settingService: options.settingService,
        onZCodeEndpointChanged: options.onZCodeEndpointChanged,
        logger: options.logger,
      });
      return;
    case DesktopCommandIds.ClearAllData:
      await clearAllDataAndRelaunch({
        credentialsDir: options.credentialsDir,
        locale: options.currentApplicationLocale,
        logger: options.logger,
      });
      return;
    case DesktopCommandIds.ClearCodingPlanWebviewStorage:
      await clearCodingPlanWebviewStorage({ logger: options.logger });
      return;
    case DesktopCommandIds.GetCuaOsSupport:
      return resolveCuaOsSupport();
  }
}
