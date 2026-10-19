/* oxlint-disable eslint(max-lines) -- Keep deep-link protocol validation and dispatch atomic within the same module. */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import type { WebContents } from "electron";
import {
  type Locale,
  type OAuthProviderId,
  type OAuthStateRegistration,
  PlatformChannels,
} from "@zcode/shared";
import {
  extractTaskNewRequest,
  extractWorkspaceOpenPath,
  extractShareImportCode,
  isOAuthCallbackUrl,
  isPaymentCallbackUrl,
  isWorkspaceOpenUrl,
  isShareImportUrl,
  isTaskNewUrl,
} from "./desktopDeepLinkUrl.js";
import {
  buildTaskDraftPreview,
  resolveTaskDraftDialogCopy,
  resolveTaskDraftText,
  type TaskDraftDialogCopy,
} from "./desktopTaskDraftDeepLink.js";
import { registerLinuxDeepLinkProtocol } from "./desktopLinuxDeepLinkRegistration.js";

interface DeepLinkWorkspaceGateOptions {
  canOpenWorkspace?: (workspacePath: string) => boolean;
  confirmationCopy?: ExternalWorkspaceOpenDialogCopy;
  /** Copy for `zcode://task/new`; defaults to en-US. */
  taskDraftConfirmationCopy?: TaskDraftDialogCopy;
  onWorkspaceOpenBlocked?: (workspacePath: string) => void;
  /** Business-window resolver; must exclude Main auxiliary windows such as the CUA indicator. */
  resolveApplicationWindow?: () => BrowserWindow | null;
}

export interface ExternalWorkspaceOpenDialogCopy {
  buttons: [string, string];
  title: string;
  message: string;
  detail: (path: string) => string;
}

interface OAuthRouteTarget {
  windowId: number;
  provider?: OAuthProviderId;
}

const oauthStateToWindow = new Map<string, OAuthRouteTarget>();
const rendererReadyWebContentsIds = new Set<number>();
let pendingDeepLinkUrl: string | null = null;
let pendingPaymentDeepLinkUrl: string | null = null;
let pendingOpenWorkspaceRequest: {
  path: string;
  targetWebContentsId?: number;
} | null = null;
const pendingShareImports: { shareCode: string; targetWebContentsId?: number }[] = [];
const MAX_PENDING_SHARE_IMPORTS = 8;
interface PendingTaskDraft {
  path: string;
  text: string;
  targetWebContentsId?: number;
}
const pendingTaskDrafts: PendingTaskDraft[] = [];
const MAX_PENDING_TASK_DRAFTS = 8;

function enqueuePendingTaskDraft(draft: PendingTaskDraft): void {
  pendingTaskDrafts.push(draft);
  if (pendingTaskDrafts.length > MAX_PENDING_TASK_DRAFTS) {
    pendingTaskDrafts.shift();
  }
}

function enqueuePendingShareImport(
  payload: { shareCode: string },
  targetWebContentsId?: number,
): void {
  if (
    pendingShareImports.some(
      (item) =>
        item.shareCode === payload.shareCode && item.targetWebContentsId === targetWebContentsId,
    )
  ) {
    return;
  }
  pendingShareImports.push(
    targetWebContentsId === undefined ? { ...payload } : { ...payload, targetWebContentsId },
  );
  if (pendingShareImports.length > MAX_PENDING_SHARE_IMPORTS) {
    pendingShareImports.shift();
  }
}

export function parseOAuthStateRegistration(payload: unknown): OAuthStateRegistration | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as {
    state?: unknown;
    provider?: unknown;
  };

  if (typeof candidate.state !== "string" || candidate.state.trim() === "") {
    return null;
  }

  if (candidate.provider != null && typeof candidate.provider !== "string") {
    return null;
  }

  return {
    state: candidate.state.trim(),
    ...(typeof candidate.provider === "string" ? { provider: candidate.provider } : {}),
  };
}

function focusDeepLinkTargetWindow(targetWindow: BrowserWindow): void {
  // macOS open-url callbacks deliver the URL to the current instance but do not bring its window to
  // the foreground. Previously this only forwarded IPC, leaving users in the external app after
  // OAuth or opening a folder from a system service. Activate and focus the target window after
  // successful routing for a consistent cross-platform return flow.
  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }

  if (!targetWindow.isVisible()) {
    targetWindow.show();
  }

  if (process.platform === "darwin") {
    app.show();
  }

  targetWindow.focus();
}

function hasOAuthAuthorizationCode(parsedUrl: URL): boolean {
  return parsedUrl.searchParams.has("code") || parsedUrl.searchParams.has("authCode");
}

export function isValidLocalWorkspaceDirectory(path: string): boolean {
  if (!path || path.includes("\0") || isNetworkWorkspacePath(path) || !isAbsolute(path)) {
    return false;
  }

  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isNetworkWorkspacePath(path: string): boolean {
  // After normalization, only paths originally starting with // or \\ start with \\;
  // a Unix absolute path starting with a single / is not misclassified as a UNC network path.
  const normalized = path.replace(/\//gu, "\\");
  return normalized.startsWith("\\\\") || /^\\\\\?\\UNC\\/iu.test(normalized);
}

// Use a complete Record<Locale, ...> so adding a language requires copy at compile time instead of silently falling back to English.
const EXTERNAL_WORKSPACE_OPEN_DIALOG_COPY: Record<Locale, ExternalWorkspaceOpenDialogCopy> = {
  "zh-CN": {
    buttons: ["打开文件夹", "取消"],
    title: "打开外部 ZCode 链接？",
    message: "是否在 ZCode 中打开此文件夹？",
    detail: (path) => `${path}\n\n只打开你信任来源的文件夹。项目设置可能影响 agent runtime。`,
  },
  "en-US": {
    buttons: ["Open folder", "Cancel"],
    title: "Open external ZCode link?",
    message: "Open this folder in ZCode?",
    detail: (path) =>
      `${path}\n\nOnly open folders from sources you trust. Project settings may affect the agent runtime.`,
  },
  "uk-UA": {
    buttons: ["Відкрити папку", "Скасувати"],
    title: "Відкрити зовнішнє посилання ZCode?",
    message: "Відкрити цю папку в ZCode?",
    detail: (path) =>
      `${path}\n\nВідкривайте лише папки з джерел, яким довіряєте. Налаштування проєкту можуть впливати на agent runtime.`,
  },
};

export function resolveExternalWorkspaceOpenDialogCopy(
  locale: Locale,
): ExternalWorkspaceOpenDialogCopy {
  return (
    EXTERNAL_WORKSPACE_OPEN_DIALOG_COPY[locale] ?? EXTERNAL_WORKSPACE_OPEN_DIALOG_COPY["en-US"]
  );
}

export function confirmExternalWorkspaceOpen(
  path: string,
  logger: { warn: (...args: unknown[]) => void },
  parentWindow: BrowserWindow | null,
  copy: ExternalWorkspaceOpenDialogCopy = resolveExternalWorkspaceOpenDialogCopy("en-US"),
): boolean {
  const options = {
    type: "warning" as const,
    buttons: copy.buttons,
    defaultId: 1,
    cancelId: 1,
    title: copy.title,
    message: copy.message,
    detail: copy.detail(path),
    noLink: true,
  };
  const response = parentWindow
    ? dialog.showMessageBoxSync(parentWindow, options)
    : dialog.showMessageBoxSync(options);
  const confirmed = response === 0;
  if (!confirmed) {
    logger.warn("[deep-link] 用户取消打开外部链接工作区", { path });
  }
  return confirmed;
}

export function handleOpenWorkspacePath(
  path: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  options: {
    allowWithoutReadyWindow?: boolean;
    resolveApplicationWindow?: () => BrowserWindow | null;
  } = {},
): boolean {
  if (!isValidLocalWorkspaceDirectory(path)) {
    logger.warn("[deep-link] 打开工作区路径无效，已忽略", { path });
    return false;
  }

  const targetWindow = options.resolveApplicationWindow
    ? options.resolveApplicationWindow()
    : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
  if (targetWindow) {
    const targetWebContentsId = targetWindow.webContents.id;
    if (!rendererReadyWebContentsIds.has(targetWebContentsId)) {
      pendingOpenWorkspaceRequest = {
        path,
        targetWebContentsId,
      };
      focusDeepLinkTargetWindow(targetWindow);
      // A cold-start argv deep link may arrive after the main window is created but before the
      // renderer registers onOpenWorkspacePath. Calling webContents.send then would lose the IPC;
      // wait for the renderer to report ready before dispatching the directory path.
      logger.warn("[deep-link] 工作区打开请求命中未就绪窗口，先缓存等待 renderer ready", {
        windowId: targetWebContentsId,
        path,
      });
      return true;
    }

    targetWindow.webContents.send(PlatformChannels.OpenWorkspacePath, path);
    focusDeepLinkTargetWindow(targetWindow);
    logger.info("[deep-link] 工作区打开请求路由成功", {
      windowId: targetWebContentsId,
      path,
    });
    return true;
  }

  if (!options.allowWithoutReadyWindow) {
    logger.warn("[deep-link] 工作区打开请求暂未命中窗口，已忽略", { path });
    return false;
  }

  pendingOpenWorkspaceRequest = { path };
  logger.warn("[deep-link] 工作区打开请求暂未命中窗口，先缓存等待 renderer ready", { path });
  return false;
}

/**
 * `zcode://task/new`: validate, read the prompt in main, confirm with a preview, then deliver a draft payload.
 * Owner of validation and file reading is Main; the renderer only inserts text into a fresh draft and never sends it.
 */
export async function handleTaskNewDeepLink(
  url: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  options: DeepLinkWorkspaceGateOptions = {},
): Promise<boolean> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    logger.warn("[deep-link] 无法解析 task/new URL");
    return false;
  }

  const request = extractTaskNewRequest(parsedUrl);
  if (!request) {
    logger.warn("[deep-link] task/new 参数无效，已忽略", { reason: "invalid_params" });
    return false;
  }

  // Reject network paths before any filesystem probe: a UNC path can trigger SMB authentication.
  if (isNetworkWorkspacePath(request.path)) {
    logger.warn("[deep-link] 网络工作区路径已拒绝", { path: request.path });
    return false;
  }
  if (request.promptFile !== undefined && isNetworkWorkspacePath(request.promptFile)) {
    logger.warn("[deep-link] task/new promptFile 网络路径已拒绝", {
      reason: "network_prompt_file",
    });
    return false;
  }

  if (options.canOpenWorkspace && !options.canOpenWorkspace(request.path)) {
    logger.warn("[deep-link] task/new 被当前启动 gate 阻止", { path: request.path });
    options.onWorkspaceOpenBlocked?.(request.path);
    return true;
  }

  if (!isValidLocalWorkspaceDirectory(request.path)) {
    logger.warn("[deep-link] task/new 工作区路径无效，已忽略", { path: request.path });
    return false;
  }

  const resolved = await resolveTaskDraftText({
    projectPath: request.path,
    ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
    ...(request.promptFile !== undefined ? { promptFile: request.promptFile } : {}),
  });
  if (!resolved.ok) {
    logger.warn("[deep-link] task/new 任务文本无效，已忽略", {
      path: request.path,
      reason: resolved.reason,
    });
    return false;
  }

  const targetWindow = options.resolveApplicationWindow
    ? options.resolveApplicationWindow()
    : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
  const dialogCopy = options.taskDraftConfirmationCopy ?? resolveTaskDraftDialogCopy("en-US");
  const preview = buildTaskDraftPreview(resolved.text);
  if (
    !confirmExternalWorkspaceOpen(request.path, logger, targetWindow, {
      buttons: dialogCopy.buttons,
      title: dialogCopy.title,
      message: dialogCopy.message,
      detail: (path) => dialogCopy.detail(path, preview),
    })
  ) {
    return true;
  }

  const draft = { path: request.path, text: resolved.text };
  const logFields = {
    path: request.path,
    textLength: resolved.text.length,
    source: request.promptFile !== undefined ? "file" : "inline",
  };
  if (!targetWindow) {
    enqueuePendingTaskDraft(draft);
    logger.info("[deep-link] task/new 等待主窗口", logFields);
    return true;
  }

  const targetWebContentsId = targetWindow.webContents.id;
  if (!rendererReadyWebContentsIds.has(targetWebContentsId)) {
    // Bind to the target window: in a multi-window setup another ready renderer must not receive the draft.
    enqueuePendingTaskDraft({ ...draft, targetWebContentsId });
    focusDeepLinkTargetWindow(targetWindow);
    logger.info("[deep-link] task/new 等待 renderer ready", {
      ...logFields,
      windowId: targetWebContentsId,
    });
    return true;
  }

  targetWindow.webContents.send(PlatformChannels.OpenTaskDraft, draft);
  focusDeepLinkTargetWindow(targetWindow);
  logger.info("[deep-link] task/new 路由成功", { ...logFields, windowId: targetWebContentsId });
  return true;
}

export function handleDeepLink(
  url: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  options: DeepLinkWorkspaceGateOptions = {},
): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    logger.warn("[deep-link] 无法解析 URL:", url);
    return false;
  }

  if (isWorkspaceOpenUrl(parsedUrl)) {
    const workspacePath = extractWorkspaceOpenPath(parsedUrl);
    if (!workspacePath) {
      logger.warn("[deep-link] 工作区打开请求缺少 path，已忽略", {
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return false;
    }

    if (isNetworkWorkspacePath(workspacePath)) {
      // A Windows UNC path can trigger SMB authentication during statSync validation.
      // Deep links are external input; reject network paths before any filesystem probe.
      logger.warn("[deep-link] 网络工作区路径已拒绝", { path: workspacePath });
      return false;
    }

    if (options.canOpenWorkspace && !options.canOpenWorkspace(workspacePath)) {
      // A forced update is a process-level gate; workspace deep links must not enter the cache/dispatch path first.
      logger.warn("[deep-link] 工作区打开请求被当前启动 gate 阻止", { path: workspacePath });
      options.onWorkspaceOpenBlocked?.(workspacePath);
      return true;
    }

    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    // zcode://workspace/open comes from an external app such as a browser/IM and is not equivalent
    // to a user selecting a directory inside ZCode. Confirm before statSync so project configuration
    // is not silently trusted.
    if (
      !confirmExternalWorkspaceOpen(workspacePath, logger, targetWindow, options.confirmationCopy)
    ) {
      return true;
    }

    return handleOpenWorkspacePath(workspacePath, logger, {
      allowWithoutReadyWindow: true,
      resolveApplicationWindow: options.resolveApplicationWindow,
    });
  }

  if (isTaskNewUrl(parsedUrl)) {
    // The route reads files and shows a blocking dialog, so it runs async; the caller only needs to know
    // the URL was recognized and consumed.
    void handleTaskNewDeepLink(url, logger, options).catch((error: unknown) => {
      logger.warn("[deep-link] task/new 处理失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }

  if (isPaymentCallbackUrl(parsedUrl)) {
    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    if (targetWindow) {
      targetWindow.webContents.send(PlatformChannels.PaymentCallback, url);
      focusDeepLinkTargetWindow(targetWindow);
      logger.info("[deep-link] 支付回调路由成功", {
        windowId: targetWindow.webContents.id,
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return true;
    }

    pendingPaymentDeepLinkUrl = url;
    logger.warn("[deep-link] 支付回调暂未命中窗口，先缓存等待 renderer ready", {
      host: parsedUrl.hostname,
      path: parsedUrl.pathname,
    });
    return false;
  }

  if (isShareImportUrl(parsedUrl)) {
    const shareCode = extractShareImportCode(parsedUrl);
    if (!shareCode) {
      logger.warn("[deep-link] share import code 无效，已忽略", {
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return false;
    }
    const payload = { shareCode };
    // The share branch must also use resolveApplicationWindow. The focus fallback
    // getAllWindows()[0] may select an auxiliary window such as the CUA indicator. Bind the pending
    // queue to its target window; otherwise, in a multi-window setup, the first ready renderer could
    // receive the import and write .zcode-share into the wrong workspace.
    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    if (targetWindow) {
      if (!rendererReadyWebContentsIds.has(targetWindow.webContents.id)) {
        enqueuePendingShareImport(payload, targetWindow.webContents.id);
        focusDeepLinkTargetWindow(targetWindow);
        logger.info("[deep-link] share import 等待 renderer ready", {
          windowId: targetWindow.webContents.id,
        });
        return true;
      }
      targetWindow.webContents.send(PlatformChannels.ShareImport, payload);
      focusDeepLinkTargetWindow(targetWindow);
      logger.info("[deep-link] share import 路由成功", {
        windowId: targetWindow.webContents.id,
      });
      return true;
    }
    enqueuePendingShareImport(payload);
    logger.info("[deep-link] share import 等待主窗口");
    return false;
  }

  if (!isOAuthCallbackUrl(parsedUrl)) {
    return false;
  }

  const state = parsedUrl.searchParams.get("state");
  if (!state) {
    logger.warn("[deep-link] OAuth 回调缺少 state，忽略此次回调", {
      protocol: parsedUrl.protocol,
      host: parsedUrl.hostname,
      path: parsedUrl.pathname,
    });
    return false;
  }

  const routeTarget = oauthStateToWindow.get(state);
  const targetWindow = routeTarget
    ? BrowserWindow.getAllWindows().find((window) => window.webContents.id === routeTarget.windowId)
    : null;
  const shouldCompleteOAuthRoute = hasOAuthAuthorizationCode(parsedUrl);

  if (targetWindow) {
    targetWindow.webContents.send(PlatformChannels.OAuthCallback, url);
    if (shouldCompleteOAuthRoute) {
      oauthStateToWindow.delete(state);
    }
    focusDeepLinkTargetWindow(targetWindow);
    logger.info("[deep-link] OAuth 回调路由成功", {
      state,
      windowId: targetWindow.webContents.id,
      provider: routeTarget?.provider,
      completed: shouldCompleteOAuthRoute,
    });
    return true;
  }

  pendingDeepLinkUrl = url;
  logger.warn("[deep-link] OAuth 回调未命中目标窗口，先缓存等待 renderer ready", {
    state,
    hasRouteTarget: Boolean(routeTarget),
  });
  return false;
}

export function registerDeepLinkProtocol(
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  options: { iconPath?: string } = {},
) {
  const scheme = "zcode";

  // The external URL must sit after --; otherwise Windows quote splitting can turn URL
  // content into Electron launch arguments. The inspector starts before app JS and the
  // single-instance lock, so it cannot rely on later handleDeepLink validation to block it.
  if (process.defaultApp && process.argv.length >= 2) {
    const entry = resolve(process.argv[1]!);
    const args = process.platform === "win32" ? [entry, "--"] : [entry];
    const ok = app.setAsDefaultProtocolClient(scheme, process.execPath, args);
    if (!ok) {
      logger.warn("[deep-link] 注册协议失败（defaultApp）", {
        scheme,
        execPath: process.execPath,
        entry: process.argv[1],
      });
    } else {
      logger.info("[deep-link] 注册协议成功（defaultApp）", {
        scheme,
        execPath: process.execPath,
        entry: process.argv[1],
      });
    }
    return;
  }

  const ok =
    process.platform === "win32"
      ? app.setAsDefaultProtocolClient(scheme, process.execPath, ["--"])
      : app.setAsDefaultProtocolClient(scheme);
  if (!ok) {
    logger.warn("[deep-link] 注册协议失败", { scheme });
  } else {
    logger.info("[deep-link] 注册协议成功", { scheme });
  }

  if (process.platform === "linux" && app.isPackaged) {
    registerLinuxDeepLinkProtocol({
      executablePath: process.execPath,
      homeDir: app.getPath("home"),
      productName: app.name,
      iconSourcePath: options.iconPath,
      env: process.env,
      argv: process.argv,
      logger,
    });
  }
}

export function registerOAuthState(windowId: number, registration: OAuthStateRegistration): void {
  oauthStateToWindow.set(registration.state, {
    windowId,
    provider: registration.provider,
  });

  setTimeout(() => oauthStateToWindow.delete(registration.state), 5 * 60 * 1000);
}

export function deliverPendingDeepLink(webContents: WebContents): boolean {
  rendererReadyWebContentsIds.add(webContents.id);

  const hasPendingOAuthCallback = pendingDeepLinkUrl != null;
  // After a pending share import is bound to a target window, dispatch only to that window (or to an
  // unbound entry during cold start). Keep the entry when a non-target window becomes ready, or the
  // import could be written to the wrong workspace.
  const undeliveredShareImports: typeof pendingShareImports = [];
  for (const pending of pendingShareImports.splice(0)) {
    if (pending.targetWebContentsId == null || pending.targetWebContentsId === webContents.id) {
      webContents.send(PlatformChannels.ShareImport, { shareCode: pending.shareCode });
    } else {
      undeliveredShareImports.push(pending);
    }
  }
  pendingShareImports.push(...undeliveredShareImports);
  const undeliveredTaskDrafts: PendingTaskDraft[] = [];
  for (const pending of pendingTaskDrafts.splice(0)) {
    if (pending.targetWebContentsId == null || pending.targetWebContentsId === webContents.id) {
      webContents.send(PlatformChannels.OpenTaskDraft, { path: pending.path, text: pending.text });
    } else {
      undeliveredTaskDrafts.push(pending);
    }
  }
  pendingTaskDrafts.push(...undeliveredTaskDrafts);
  if (hasPendingOAuthCallback) {
    webContents.send(PlatformChannels.OAuthCallback, pendingDeepLinkUrl);
    pendingDeepLinkUrl = null;
  }
  if (pendingPaymentDeepLinkUrl) {
    webContents.send(PlatformChannels.PaymentCallback, pendingPaymentDeepLinkUrl);
    pendingPaymentDeepLinkUrl = null;
  }
  if (
    pendingOpenWorkspaceRequest &&
    (pendingOpenWorkspaceRequest.targetWebContentsId == null ||
      pendingOpenWorkspaceRequest.targetWebContentsId === webContents.id)
  ) {
    webContents.send(PlatformChannels.OpenWorkspacePath, pendingOpenWorkspaceRequest.path);
    pendingOpenWorkspaceRequest = null;
  }
  return hasPendingOAuthCallback;
}

export function clearOAuthRoutesForWindow(windowId: number): void {
  rendererReadyWebContentsIds.delete(windowId);
  if (pendingOpenWorkspaceRequest?.targetWebContentsId === windowId) {
    pendingOpenWorkspaceRequest = null;
  }
  // Once a pending share import is bound to a target window, synchronously clear it when that window
  // closes; otherwise the entry never expires and could be dispatched to another window that becomes
  // ready later, writing into the wrong workspace.
  for (let index = pendingShareImports.length - 1; index >= 0; index -= 1) {
    if (pendingShareImports[index]!.targetWebContentsId === windowId) {
      pendingShareImports.splice(index, 1);
    }
  }

  for (let index = pendingTaskDrafts.length - 1; index >= 0; index -= 1) {
    if (pendingTaskDrafts[index]!.targetWebContentsId === windowId) {
      pendingTaskDrafts.splice(index, 1);
    }
  }

  for (const [state, routeTarget] of oauthStateToWindow) {
    if (routeTarget.windowId === windowId) {
      oauthStateToWindow.delete(state);
    }
  }
}
