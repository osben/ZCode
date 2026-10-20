import { sessionCreateTelemetrySchema, type RendererTelemetryEventPayload } from "@zcode/shared";
/* eslint-disable max-lines -- Web remote-control startup, error pages, and platform bridging are currently coordinated in the entry point. */
import { createRoot } from "react-dom/client";
import {
  AppErrorBoundary,
  Root,
  ZCodeIntlProvider,
  generateMobileDeviceFingerprint,
  installDocumentHiddenMotionPause,
  playTaskNotificationSound,
  setStreamClientId,
  setWebRemoteControlTerminalTransportState,
  type WebRemoteControlTerminalTransportState as UiWebRemoteControlTerminalTransportState,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import {
  connectViaProtocol,
  connectViaWebSocket,
  createAcknowledgedWebRemoteControlRelayProtocol,
  type WebSocketConnectionCloseEvent,
} from "@zcode/client";
import {
  WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
  resolveWebRemoteControlRelayWsUrl,
} from "@zcode/shared";
import { WebCallbackPage } from "./auth/WebCallbackPage.js";
import { WebLoggedInWaitingPage } from "./auth/WebLoggedInWaitingPage.js";
import { WebLoginPage } from "./auth/WebLoginPage.js";
import { createWebAuthService } from "./auth/webAuthService.js";
import { WEB_ZAI_OAUTH_CONFIG, resolveWebAuthDevReturnTo } from "./auth/webZaiOAuthConfig.js";
import { parseOAuthState, resolveSafeAppReturnTo } from "./auth/oauthStateCodec.js";
import { resolveWebCommunityUrl, resolveWebHelpConfig } from "./communityUrl.js";
import {
  ConversationShareLandingLoader,
  ConversationShareLandingStatus,
} from "./share/ConversationShareLandingPage.js";
import {
  ConversationSharePreviewClient,
  resolveConversationShareRouteLocale,
} from "./share/conversationSharePreviewClient.js";
import {
  isConversationSharePath,
  resolveConversationShareCodeFromPath,
} from "./share/conversationShareRoute.js";
import { applyTheme, readStoredThemeSelection } from "@zcode/ui/useTheme";

// Apply the color mode and palette synchronously at startup to prevent a first-screen flash. Share pages default to light without local settings; other Web pages default to dark.
import type {
  IPlatformService,
  WebRemoteControlBootstrapErrorResponse,
  WebRemoteControlFailure,
  WebRemoteControlFailureReason,
  WebRemoteControlPlatformMethod,
  WebRemoteControlPlatformMethodArgsMap,
  WebRemoteControlPlatformMethodResultMap,
  WebRemoteControlPlatformRequestPayload,
  WebRemoteControlPlatformResponsePayload,
  WebRemoteControlWindowBootstrapResult,
  WebRemoteControlWindowControlReadyEvent,
  WebRemoteControlWorkspaceBridge,
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlMobileNavigationIntent,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceSwitchOptions,
  WebRemoteControlStatus,
  WebRemoteControlAppPayload,
  WebRemoteControlExternalWorkspaceBridge,
  RemoteTarget,
  ServerRemoteInfo,
  UserInfo,
} from "@zcode/shared";
import {
  matchesWebRemoteControlRoutePath,
  parseWebRemoteControlExternalQrParams,
  resolveWebRemoteControlFailureReasonFromCloseCode,
  resolveWebRemoteControlInitialWorkspaceSelection,
  resolveWebRemoteControlWorkspaceKey,
} from "@zcode/shared";
import { createBrowserWebRemoteControlRelayAuthProvider } from "./webRemoteControlRelayAuthProvider.js";
import {
  WebRemoteControlTerminalTransport,
  type WebRemoteControlTerminalTransportDiagnostic,
  type WebRemoteControlTerminalTransportState,
  createWebRemoteControlAppPayloadRequester,
  createWebRemoteControlRelayRequestRecovery,
} from "./webRemoteControlTransport.js";
import { createWebRemoteControlLifecycleRecovery } from "./webRemoteControlLifecycle.js";
import { seedWebRemoteControlThemePreference } from "./webRemoteControlThemeSeed.js";
import {
  WebRemoteControlFailureScreen,
  resolveWebRemoteControlScreenLocale,
} from "./webRemoteControlFailureScreen.js";
import { collectWebRemoteControlMobileDeviceInfo } from "./webRemoteControlDeviceInfo.js";
import { createWebRemoteControlVersionGuard } from "./webRemoteControlVersion.js";
import { showWebRemoteControlVersionNotice } from "./webRemoteControlVersionNotice.js";
import { resolveWebRemoteControlRoutePath } from "./webRemoteControlRoute.js";
import {
  registerWebRemoteControlWorkspaceBridgeServices,
  type WebRemoteControlWorkspaceBridgeServiceRegistration,
} from "./webRemoteControlWorkspaceBridgeSession.js";
import {
  markWebRemoteControlBridgeTaskRead,
  markWebRemoteControlTaskRead,
} from "./webRemoteControlTaskRead.js";
import { openWebRemoteControlWorkspace } from "./webRemoteControlWorkspaceOpen.js";
type RootServices = Parameters<typeof Root>[0]["services"];
type ServiceMethod = (...args: any[]) => unknown;

function logWebRemoteControlTaskReadFailure(
  error: unknown,
  context: { taskId: string; workspaceKey: string },
): void {
  console.warn("[web-remote-control] 标记手机端 task 已读失败", {
    error: error instanceof Error ? error.message : String(error),
    taskId: context.taskId,
    workspaceKey: context.workspaceKey,
  });
}

async function markCurrentWebRemoteControlBridgeTaskRead({
  bridge,
  services,
  task,
}: {
  bridge: WebRemoteControlExternalWorkspaceBridge | WebRemoteControlWorkspaceBridge;
  services: RootServices;
  task: WebRemoteControlTaskTarget;
}): Promise<void> {
  const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
  if (taskWorkspaceKey !== bridge.workspaceKey) {
    // Fix rationale: remote workspaces at the same path can have different identities; do not use the current bridge to write to another connection.
    console.warn("[web-remote-control] 跳过跨 workspace 的 task 已读写入", {
      taskId: task.taskId,
      taskWorkspaceKey,
      bridgeWorkspaceKey: bridge.workspaceKey,
    });
    return;
  }
  if (typeof task.unreadAt !== "number") {
    return;
  }

  const result = await markWebRemoteControlTaskRead({
    service: services.zcodeTaskService,
    target: {
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      expectedUnreadAt: task.unreadAt,
    },
  });
  if (!result.ok) {
    logWebRemoteControlTaskReadFailure(result.error, {
      taskId: task.taskId,
      workspaceKey: taskWorkspaceKey,
    });
  }
}

async function markOpenedWebRemoteControlBridgeTaskRead({
  bridge,
  expectedUnreadAt,
  services,
}: {
  bridge: WebRemoteControlExternalWorkspaceBridge | WebRemoteControlWorkspaceBridge;
  expectedUnreadAt?: number;
  services: RootServices;
}): Promise<void> {
  const result = await markWebRemoteControlBridgeTaskRead({
    bridge,
    expectedUnreadAt,
    service: services.zcodeTaskService,
  });
  if (!result.ok) {
    logWebRemoteControlTaskReadFailure(result.error, {
      taskId: bridge.initialTaskId ?? "unknown",
      workspaceKey: bridge.workspaceKey,
    });
  }
}

// Initialize the theme: default to Zai dark, then let the useTheme hook take over.
// In system mode, query the system preference; otherwise, use the stored value directly.
{
  const selection = readStoredThemeSelection(
    isConversationSharePath(window.location.pathname) ? "light" : "dark",
  );
  applyTheme(selection.mode, selection.palette);
}

async function resolveFeedbackUrl(): Promise<string | undefined> {
  return (await resolveWebHelpConfig()).feedback_url;
}

// Disable CSS animations when the browser tab is hidden or the phone app goes to the background, so DocumentTimeline does not retain an unmounted DOM subtree.
installDocumentHiddenMotionPause();
const root = createRoot(document.getElementById("root")!);
const webAuthService = createWebAuthService();
let isPageUnloading = false;
let isSwitchingWebRemoteControlWorkspace = false;

// Initialize the Web streaming clientId so every hook uses a stable ID before the first render.
{
  setStreamClientId(generateMobileDeviceFingerprint());
}

window.addEventListener("beforeunload", () => {
  isPageUnloading = true;
});

interface WebRemoteControlProxyOptions {
  token: string;
  relayOrigin: string;
  windowControlSessionId: string;
  mobileConnectionId: string;
}

interface WebRemoteControlPlatformProxy {
  reportTelemetryEvent?: (event: RendererTelemetryEventPayload) => void;
  requestPlatformMethod<K extends WebRemoteControlPlatformMethod>(
    method: K,
    args?: WebRemoteControlPlatformMethodArgsMap[K],
  ): Promise<WebRemoteControlPlatformMethodResultMap[K]>;
}

interface WebBootstrapResult {
  wsUrl: string;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialTaskId?: string;
  restoreSession?: boolean;
  allowOpenWorkspace?: boolean;
}

type WebRemoteControlWorkspaceListUpdateListener = (
  result: WebRemoteControlWorkspaceListResult,
) => void;

function renderWebRemoteControlFailure(failure: WebRemoteControlFailure): void {
  root.render(
    <WebRemoteControlFailureScreen
      failure={failure}
      locale={resolveWebRemoteControlScreenLocale(navigator.language)}
      onReload={() => {
        window.location.reload();
      }}
    />,
  );
}

function isWebOAuthCallback(params: URLSearchParams): boolean {
  return (
    ["/web-remote/callback", "/cn/share/callback", "/share/callback"].includes(
      window.location.pathname,
    ) &&
    params.has("state") &&
    (params.has("code") || params.has("error"))
  );
}

function isWebRemoteRoute(): boolean {
  return window.location.pathname === "/web-remote" || window.location.pathname === "/web-remote/";
}

function shouldUseWebRemoteAuth(params: URLSearchParams): boolean {
  void params;
  return isWebRemoteRoute();
}

function resolveWebRemoteAppReturnTo(params: URLSearchParams): string {
  if (isWebRemoteRoute() || !params.has("remoteControlToken")) {
    return window.location.href;
  }

  const appReturnTo = new URL(window.location.href);
  appReturnTo.pathname = "/web-remote";
  return appReturnTo.toString();
}

function renderWebAuthCallbackPage(): void {
  document.title = "ZCode - Web Remote Control Sign In";
  const callbackState = parseOAuthState(
    new URLSearchParams(window.location.search).get("state") ?? "",
  );
  const safeRetryTarget = resolveSafeAppReturnTo(callbackState?.app_return_to);
  root.render(
    <WebCallbackPage
      authService={webAuthService}
      onSuccess={({ appReturnTo }) => {
        window.location.replace(appReturnTo ?? "/web-remote");
      }}
      onRetry={() => {
        window.location.replace(safeRetryTarget ?? "/web-remote");
      }}
    />,
  );
}

async function renderConversationSharePage(): Promise<void> {
  // Page language follows the path prefix: /cn/share is Chinese; bare /share is English.
  const routeLocale = resolveConversationShareRouteLocale(window.location.pathname);
  // index.html fixes lang="en"; without synchronizing this, the Chinese share page has the wrong language for accessibility and browser translation.
  document.documentElement.lang = routeLocale;
  // The share page must set a title; otherwise the browser tab shows only the generic index.html title.
  // The session title is available only after preview loads, so set a fallback in the correct language first.
  document.title = routeLocale === "zh-CN" ? "ZCode 会话分享" : "ZCode Conversation Share";
  const shareCode = resolveConversationShareCodeFromPath(window.location.pathname);
  if (!shareCode) {
    root.render(
      <ConversationShareLandingStatus
        state={{ kind: "error", error: "invalid_contract" }}
        locale={routeLocale}
      />,
    );
    return;
  }

  const endpointOrigin =
    import.meta.env.VITE_ZCODE_BASE_URL?.trim().replace(/\/+$/u, "") || window.location.origin;
  const mockMode =
    import.meta.env.DEV && import.meta.env.VITE_CONVERSATION_SHARE_PREVIEW_MOCK === "true";
  // A Share load failure needs more than a generic network message; distinguish mock, endpoint configuration, and cross-origin fetch failures.
  // Record only the runtime route and endpoint, not the full pathname, to avoid logging the share code.
  console.info("[conversation-share-web]", "preview_runtime_initialized", {
    browserOrigin: window.location.origin,
    routeKind: "canonical",
    endpointOrigin,
    transport: mockMode ? "mock" : "fetch",
  });
  const client = mockMode
    ? new (
        await import("./share/mockConversationSharePreviewClient.js")
      ).MockConversationSharePreviewClient()
    : new ConversationSharePreviewClient({ baseUrl: `${endpointOrigin}/api/v1` });
  const getMockToken = () =>
    mockMode && window.sessionStorage.getItem("zcode:share:mock-auth") === "owner"
      ? "mock-owner-token"
      : null;
  const onLogout = () => {
    if (mockMode) {
      window.sessionStorage.removeItem("zcode:share:mock-auth");
      window.location.reload();
      return;
    }
    void webAuthService.logout();
  };
  root.render(
    <ConversationShareLandingLoader
      shareCode={shareCode}
      client={client}
      getAccessToken={() => getMockToken() ?? webAuthService.getZCodeJwtToken()}
      onLogin={(provider) => {
        if (mockMode) {
          window.sessionStorage.setItem("zcode:share:mock-auth", "owner");
          window.location.reload();
          return;
        }
        webAuthService.startLogin({
          provider,
          appReturnTo: window.location.href,
          redirectUri: WEB_ZAI_OAUTH_CONFIG.shareRedirectUri,
          devReturnTo: resolveWebAuthDevReturnTo(WEB_ZAI_OAUTH_CONFIG, "share"),
        });
      }}
      onLogout={onLogout}
      locale={routeLocale}
      theme={readStoredThemeSelection("light").mode}
    />,
  );
}

function renderWebLoginPage(): void {
  document.title = "ZCode - Web Remote Control Sign In";
  root.render(
    <WebLoginPage
      onLogin={() => {
        const params = new URLSearchParams(window.location.search);
        webAuthService.startLogin({
          devReturnTo: resolveWebAuthDevReturnTo(WEB_ZAI_OAUTH_CONFIG),
          appReturnTo: resolveWebRemoteAppReturnTo(params),
        });
      }}
    />,
  );
}

function renderWebLoggedInWaitingPage(user: UserInfo): void {
  document.title = "ZCode - Web Remote Control";
  root.render(
    <WebLoggedInWaitingPage
      user={user}
      onLogout={async () => {
        await webAuthService.logout();
        window.location.replace("/web-remote");
      }}
    />,
  );
}

function toWebRemoteControlFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

function parseWebRemoteControlBootstrapError(payload: unknown): WebRemoteControlFailure | null {
  if (typeof payload !== "object" || payload == null) {
    return null;
  }

  const record = payload as Partial<WebRemoteControlBootstrapErrorResponse>;
  if (typeof record.reason !== "string") {
    return null;
  }

  return toWebRemoteControlFailure(
    record.reason as WebRemoteControlFailureReason,
    typeof record.error === "string" ? record.error : undefined,
  );
}

function mapWebRemoteControlSocketCloseToFailure(event: {
  code: number;
  reason: string;
}): WebRemoteControlFailure {
  const resolvedReason =
    resolveWebRemoteControlFailureReasonFromCloseCode(event.code) ??
    (event.reason as WebRemoteControlFailureReason | "");

  switch (resolvedReason) {
    case "session-not-found":
    case "session-expired":
    case "session-conflict":
    case "workspace-closed":
    case "desktop-disconnected":
    case "invalid-mobile-connection":
    case "desktop-bootstrap-timeout":
    case "connection-recovery-timeout":
      return toWebRemoteControlFailure(resolvedReason, event.reason || undefined);
    default:
      return toWebRemoteControlFailure(
        "relay-unavailable",
        event.reason || "Web remote control connection closed unexpectedly.",
      );
  }
}

async function requestWebRemoteControlPlatformMethod<K extends WebRemoteControlPlatformMethod>(
  proxy: WebRemoteControlProxyOptions,
  method: K,
  args?: WebRemoteControlPlatformMethodArgsMap[K],
): Promise<WebRemoteControlPlatformMethodResultMap[K]> {
  const response = await fetch(
    `${proxy.relayOrigin.replace(/\/$/, "")}/api/remote-control/platform/${proxy.token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, args }),
    },
  );
  const payload = (await response.json()) as
    | { result: WebRemoteControlPlatformMethodResultMap[K] }
    | { error?: string };

  if (!response.ok) {
    const errorMessage = "error" in payload ? payload.error : undefined;
    throw new Error(
      errorMessage || `Failed to invoke Web remote control platform method: ${method}`,
    );
  }

  if (!("result" in payload)) {
    throw new Error(`Missing Web remote control platform result: ${method}`);
  }

  return payload.result;
}

async function requestWebRemoteControlWorkspaces(
  proxy: WebRemoteControlProxyOptions,
): Promise<WebRemoteControlWorkspaceListResult> {
  const response = await fetch(
    `${proxy.relayOrigin.replace(/\/$/, "")}/api/remote-control/windows/bootstrap/${proxy.token}`,
  );
  const payload = (await response.json()) as
    | WebRemoteControlWindowBootstrapResult
    | { error?: string };

  if (!response.ok) {
    const errorMessage = "error" in payload ? payload.error : undefined;
    throw new Error(errorMessage || "Failed to list Web remote control workspaces");
  }

  if (!("workspaces" in payload)) {
    throw new Error("Missing Web remote control workspace list");
  }

  return {
    workspaces: payload.workspaces,
    tasks: payload.tasks,
    activeWorkspaceKey:
      payload.mobileViewState?.activeWorkspaceKey ?? payload.initialViewState?.activeWorkspaceKey,
    activeTaskId: payload.mobileViewState?.activeTaskId ?? payload.initialViewState?.activeTaskId,
  };
}

async function requestWebRemoteControlWorkspaceBridge(
  proxy: WebRemoteControlProxyOptions,
  workspaceKey: string,
  options?: WebRemoteControlWorkspaceSwitchOptions,
): Promise<WebRemoteControlWorkspaceBridge> {
  const response = await fetch(
    `${proxy.relayOrigin.replace(/\/$/, "")}/api/remote-control/windows/${proxy.token}/workspace-bridge`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ZCode-Mobile-Connection-Id": proxy.mobileConnectionId,
      },
      body: JSON.stringify({
        workspaceKey,
        ...(options?.taskId ? { taskId: options.taskId } : {}),
      }),
    },
  );
  const payload = (await response.json()) as
    | WebRemoteControlWorkspaceBridge
    | WebRemoteControlBootstrapErrorResponse
    | { error?: string };

  if (!response.ok) {
    const parsedFailure = parseWebRemoteControlBootstrapError(payload);
    if (parsedFailure) {
      throw parsedFailure;
    }
    const errorMessage = "error" in payload ? payload.error : undefined;
    throw new Error(errorMessage || "Failed to switch Web remote control workspace");
  }
  if (!("wsUrl" in payload)) {
    throw new Error("Missing Web remote control bridge wsUrl");
  }

  return payload;
}

async function requestWebRemoteControlWorkspaceOpen(
  proxy: WebRemoteControlProxyOptions,
  target: { workspacePath: string; workspaceIdentity?: string },
): Promise<void> {
  const response = await fetch(
    `${proxy.relayOrigin.replace(/\/$/, "")}/api/remote-control/windows/${proxy.token}/workspace-open`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ZCode-Mobile-Connection-Id": proxy.mobileConnectionId,
      },
      body: JSON.stringify({
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      }),
    },
  );
  const payload = (await response.json().catch(() => null)) as
    | { success?: boolean; error?: string }
    | WebRemoteControlBootstrapErrorResponse
    | null;

  if (!response.ok || !payload || !("success" in payload) || payload.success !== true) {
    const parsedFailure = parseWebRemoteControlBootstrapError(payload);
    if (parsedFailure) {
      throw parsedFailure;
    }
    const errorMessage =
      payload && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : "Failed to open workspace on the desktop";
    throw new Error(errorMessage);
  }
}

async function updateWebRemoteControlMobileViewState(
  proxy: WebRemoteControlProxyOptions,
  workspaceKey: string,
  taskId?: string,
): Promise<void> {
  const deviceInfo = collectWebRemoteControlMobileDeviceInfo();
  const response = await fetch(
    `${proxy.relayOrigin.replace(/\/$/, "")}/api/remote-control/windows/${proxy.token}/mobile-view-state`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ZCode-Mobile-Connection-Id": proxy.mobileConnectionId,
      },
      body: JSON.stringify({
        activeWorkspaceKey: workspaceKey,
        ...(taskId ? { activeTaskId: taskId } : {}),
        updatedAt: Date.now(),
        deviceInfo,
      }),
    },
  );
  const payload = (await response.json().catch(() => null)) as
    | WebRemoteControlBootstrapErrorResponse
    | { error?: string }
    | null;

  if (!response.ok) {
    const parsedFailure = parseWebRemoteControlBootstrapError(payload);
    if (parsedFailure) {
      throw parsedFailure;
    }
    const errorMessage = payload && "error" in payload ? payload.error : undefined;
    throw new Error(errorMessage || "Failed to update Web remote control mobile view state");
  }
}

export function createWebPlatform(options?: {
  webRemoteControlProxy?: WebRemoteControlProxyOptions;
  externalWebRemoteControlProxy?: WebRemoteControlPlatformProxy;
}): IPlatformService {
  const webRemoteControlProxy = options?.webRemoteControlProxy;
  const platformProxy = options?.externalWebRemoteControlProxy;

  return {
    canSelectFilePath: false,
    // The Web platform cannot open the system directory picker.
    selectDirectory: () => Promise.resolve(null),
    // The Web platform cannot open the system file picker.
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    getPathForFile: () => null,
    createTempTextAttachment: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("createTempTextAttachment", payload)
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(
              webRemoteControlProxy,
              "createTempTextAttachment",
              payload,
            )
          : Promise.reject(new Error("Temporary text attachments require a desktop host")),
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    onBotRemoteWorkspaceReconnected: () => () => {},
    // The Web platform does not manage multiple windows.
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    // Bug fix: Web remote-control mode reuses the Web UI, but is backed by Desktop.
    // This previously used the regular Web `/api/connect-remote` route, which could not reach Desktop main
    // or obtain the remote session MessagePort. It appeared supported, but always failed.
    // Reject this path explicitly to avoid sending users down a broken troubleshooting path; supporting it later requires a separate remote-session injection protocol.
    async connectRemote(
      options: RemoteTarget,
      _requestId?: string,
      _context?: {
        workspacePath: string;
        workspaceIdentity?: string;
        connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
      },
    ) {
      if (webRemoteControlProxy || platformProxy) {
        return {
          success: false,
          error: `Remote connect is not supported in Web remote control mode yet: ${options.kind}`,
        };
      }

      // TODO(web-remote-workspace): initially guarantee only server-local workspaces in regular Web mode.
      // This could open a new ?remote=<id> tab, but the remote WebSocket exposed only some services,
      // which did not match the complete accessor required by Root/RemoteServiceAccess, causing the project wizard or first screen to stall.
      return {
        success: false,
        error: `Remote connect is not supported in Web mode yet: ${options.kind}`,
      };
    },
    cancelPendingRemoteConnection: (_requestId?: string) => Promise.resolve(),
    // The Web platform does not initiate Web remote control; keep a no-op implementation for the shared interface.
    startWebRemoteControl: () =>
      Promise.reject(new Error("Web remote control can only be started from desktop")),
    refreshWebRemoteControlPairing: () =>
      Promise.reject(new Error("Web remote control pairing can only be refreshed from desktop")),
    stopWebRemoteControl: () => Promise.resolve(),
    getWebRemoteControlStatus: () =>
      Promise.resolve<WebRemoteControlStatus>({
        status: "idle",
      }),
    disposeRemoteSession: () => Promise.resolve(),
    isDockerAvailable: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("isDockerAvailable")
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(webRemoteControlProxy, "isDockerAvailable")
          : Promise.resolve(false),
    listWSLDistros: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("listWSLDistros")
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(webRemoteControlProxy, "listWSLDistros")
          : Promise.resolve([]),
    listDockerContainers: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("listDockerContainers")
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(webRemoteControlProxy, "listDockerContainers")
          : Promise.resolve([]),
    listSSHConfigAliases: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("listSSHConfigAliases")
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(webRemoteControlProxy, "listSSHConfigAliases")
          : Promise.resolve([]),
    loadMcpFromUserDirectory: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("loadMcpFromUserDirectory", payload)
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(
              webRemoteControlProxy,
              "loadMcpFromUserDirectory",
              payload,
            )
          : Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("saveMcpToUserDirectory", payload)
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(
              webRemoteControlProxy,
              "saveMcpToUserDirectory",
              payload,
            )
          : Promise.resolve({
              success: false,
              error: "MCP native directory management requires a desktop attachment",
            }),
    migrateLegacyCommonMcp: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("migrateLegacyCommonMcp", payload)
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(
              webRemoteControlProxy,
              "migrateLegacyCommonMcp",
              payload,
            )
          : Promise.resolve({
              servers: {},
              totalCount: 0,
              importedCount: 0,
              skippedCount: 0,
            }),
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    openFeedback: async () => {
      const feedbackUrl = await resolveFeedbackUrl();
      if (!feedbackUrl) {
        return;
      }
      window.open(feedbackUrl, "_blank", "noopener,noreferrer");
    },
    openCommunity: async () => {
      const locale = document.documentElement.lang === "en-US" ? "en-US" : "zh-CN";
      const communityUrl = await resolveWebCommunityUrl(locale);
      if (!communityUrl) {
        return;
      }
      window.open(communityUrl, "_blank", "noopener,noreferrer");
    },
    canOpenCommunity: async (locale) => {
      const communityUrl = await resolveWebCommunityUrl(locale);
      return typeof communityUrl === "string" && communityUrl.length > 0;
    },
    openInFileManager: (path) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("openInFileManager", path)
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(webRemoteControlProxy, "openInFileManager", path)
          : Promise.resolve({ success: false, error: "Not supported in web mode" }),
    openExternalFile: (path) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("openExternalFile", path)
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(webRemoteControlProxy, "openExternalFile", path)
          : Promise.resolve({ success: false, error: "Not supported in web mode" }),
    registerOAuthState: (_payload) => {},
    onOAuthCallback: () => () => {},
    onPaymentCallback: () => () => {},
    onShareImport: () => () => {},
    notifyRendererReady: () => {},
    reportTelemetryEvent: async (event) => {
      // Mobile exposes only session_create; do not also enable the existing Desktop conversation events.
      const parsed = sessionCreateTelemetrySchema.safeParse(event);
      if (parsed.success) platformProxy?.reportTelemetryEvent?.(parsed.data);
    },
    reportArmsCustomEvent: () => Promise.resolve(),
    showTaskNotification: (payload) => {
      if (document.hasFocus()) {
        return;
      }

      if (
        typeof window.Notification === "undefined" ||
        window.Notification.permission !== "granted"
      ) {
        return;
      }

      try {
        new window.Notification(payload.title, {
          body: payload.body,
          silent: true,
        });
        void playTaskNotificationSound();
      } catch {
        // Silently ignore unavailable browser notifications to avoid interrupting the main flow.
      }
    },
    // The Web platform does not need cross-window tab management.
    syncWindowTabs: () => {},
    // The Web platform has no host-level Dock / taskbar badge; keep this as a no-op for the shared platform interface.
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onCloseActiveContextRequest: () => () => {},
    onOpenBrowserUrl: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onWindowFullscreenChanged: () => () => {},
    onTaskNotificationClick: () => () => {},
    exportLogs: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    captureWindowScreenshot: () => Promise.resolve(null),
    importChromeBrowserData: (_options) =>
      Promise.resolve({
        success: false,
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: {
          originsImported: 0,
          entriesImported: 0,
          originsSkipped: 0,
          originsFailed: 0,
        },
        error: "chrome_import_not_supported" as const,
      }),
    clearEmbeddedBrowserData: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    // When IPlatformService gained update-notification support, the Web fallback did not add a matching no-op,
    // so root typecheck failed even for changes unrelated to Desktop.
    // Web currently has no desktop updater; explicitly use a no-op to keep the interface complete without changing behavior.
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () => Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),
    getInstalledEditors: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("getInstalledEditors")
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(webRemoteControlProxy, "getInstalledEditors")
          : Promise.resolve([]),
    openInEditor: (editorId, path, options) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("openInEditor", { editorId, path, options })
        : webRemoteControlProxy
          ? requestWebRemoteControlPlatformMethod(webRemoteControlProxy, "openInEditor", {
              editorId,
              path,
              options,
            })
          : Promise.resolve({ success: false, error: "Not supported in web mode" }),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: (_locale) => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    getDeviceId: () => {
      const nav = globalThis.navigator as Navigator & { platform?: string };
      const platform = nav?.platform ?? "";
      const screenWidth = globalThis.screen?.width;
      const screenHeight = globalThis.screen?.height;
      const colorDepth = globalThis.screen?.colorDepth;
      const parts = [
        platform,
        screenWidth !== undefined ? String(screenWidth) : "",
        screenHeight !== undefined ? String(screenHeight) : "",
        colorDepth !== undefined ? String(colorDepth) : "",
      ];
      return parts.filter(Boolean).join("|");
    },
  };
}

function resolveDefaultWsOrigin(): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

async function resolveWebBootstrap(): Promise<WebBootstrapResult> {
  const params = new URLSearchParams(window.location.search);
  const remoteId = params.get("remote");
  const wsUrl = remoteId
    ? `${resolveDefaultWsOrigin()}/ws/remote/${remoteId}`
    : `${resolveDefaultWsOrigin()}/ws`;

  if (remoteId) {
    return { wsUrl };
  }

  try {
    const response = await fetch("/api/server-info", {
      cache: "no-store",
    });
    if (!response.ok) {
      return { wsUrl };
    }
    const serverInfo = (await response.json()) as Partial<ServerRemoteInfo>;
    const workspace = Array.isArray(serverInfo.workspaces) ? serverInfo.workspaces[0] : undefined;
    return {
      wsUrl,
      ...(workspace?.path ? { initialWorkspaceAbsPath: workspace.path } : {}),
      ...(workspace?.workspaceIdentity
        ? { initialWorkspaceIdentity: workspace.workspaceIdentity }
        : {}),
    };
  } catch {
    return { wsUrl };
  }
}

async function requestWebRemoteControlWindowBootstrap(
  proxy: Pick<WebRemoteControlProxyOptions, "token" | "relayOrigin">,
): Promise<WebRemoteControlWindowBootstrapResult> {
  const response = await fetch(
    `${proxy.relayOrigin.replace(/\/$/, "")}/api/remote-control/windows/bootstrap/${proxy.token}`,
  );
  const payload = (await response.json()) as
    | WebRemoteControlWindowBootstrapResult
    | WebRemoteControlBootstrapErrorResponse
    | { error?: string };

  if (!response.ok) {
    throw (
      parseWebRemoteControlBootstrapError(payload) ??
      toWebRemoteControlFailure(
        "unexpected-error",
        "error" in payload ? payload.error : "Failed to bootstrap Web remote control",
      )
    );
  }
  if (!("workspaces" in payload)) {
    throw toWebRemoteControlFailure(
      "unexpected-error",
      "Missing Web remote control bootstrap workspaces",
    );
  }

  return payload;
}

function parseWindowControlReadyEvent(
  raw: MessageEvent,
): WebRemoteControlWindowControlReadyEvent | null {
  if (typeof raw.data !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(raw.data) as WebRemoteControlWindowControlReadyEvent;
    if (
      parsed?.type === "window-control-ready" &&
      typeof parsed.windowControlSessionId === "string" &&
      typeof parsed.mobileConnectionId === "string"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

async function connectWebRemoteControlWindow(
  proxy: Pick<WebRemoteControlProxyOptions, "token" | "relayOrigin">,
  onClose: (event: WebSocketConnectionCloseEvent) => void,
): Promise<{
  socket: WebSocket;
  ready: WebRemoteControlWindowControlReadyEvent;
}> {
  return await new Promise((resolve, reject) => {
    const wsOrigin = proxy.relayOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const socket = new WebSocket(
      `${wsOrigin.replace(/\/$/, "")}/ws/remote-control/window/${proxy.token}`,
    );
    let settled = false;

    const cleanup = () => {
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleCloseBeforeReady);
    };

    const handleMessage = (event: MessageEvent) => {
      const ready = parseWindowControlReadyEvent(event);
      if (!ready) {
        return;
      }

      settled = true;
      cleanup();
      socket.addEventListener("close", (closeEvent) => {
        onClose({
          code: closeEvent.code,
          reason: closeEvent.reason,
          wasClean: closeEvent.wasClean,
        });
      });
      resolve({ socket, ready });
    };

    const handleError = () => {
      cleanup();
      if (!settled) {
        reject(new Error("Web remote control window socket failed"));
      }
    };

    const handleCloseBeforeReady = (event: CloseEvent) => {
      cleanup();
      if (!settled) {
        reject(
          toWebRemoteControlFailure(
            resolveWebRemoteControlFailureReasonFromCloseCode(event.code) ?? "relay-unavailable",
            event.reason || "Web remote control window socket closed before ready",
          ),
        );
      }
    };

    socket.addEventListener("message", handleMessage);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleCloseBeforeReady);
  });
}

function selectInitialWebRemoteControlWorkspace(
  snapshot: WebRemoteControlWindowBootstrapResult,
): ReturnType<typeof resolveWebRemoteControlInitialWorkspaceSelection> {
  return resolveWebRemoteControlInitialWorkspaceSelection(snapshot);
}

function isWebRemoteControlRoute(): boolean {
  return matchesWebRemoteControlRoutePath(
    window.location.pathname,
    resolveWebRemoteControlRoutePath(import.meta.env),
  );
}

function createWebRemoteControlRequestId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function seedStableWebRemoteControlClientId(deviceSid: string): void {
  const storageKey = `zcode-web-remote-client-id:${deviceSid}`;
  try {
    const existing = globalThis.localStorage?.getItem(storageKey)?.trim();
    if (existing) {
      setStreamClientId(existing);
      return;
    }
    const nextId = globalThis.crypto?.randomUUID?.() ?? generateMobileDeviceFingerprint();
    globalThis.localStorage?.setItem(storageKey, nextId);
    setStreamClientId(nextId);
  } catch {
    // Bug fix: environments such as iOS private mode may disable localStorage.
    // Keep the physical-fingerprint fallback injected above so remote-control startup is not interrupted when clientId persistence fails.
    setStreamClientId(generateMobileDeviceFingerprint());
  }
}

function createUnsupportedHomeOnlyService<T extends object>(serviceName: string): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => async () => {
        throw new Error(
          `${serviceName}.${String(property)} is not available before a Web remote control workspace bridge is connected.`,
        );
      },
    },
  ) as T;
}

function createEmptyHomeOnlyService<T extends object>(handlers: Record<string, ServiceMethod>): T {
  return new Proxy(handlers, {
    get: (target, property) => {
      if (typeof property !== "string") {
        return undefined;
      }
      return target[property] ?? (async () => undefined);
    },
  }) as T;
}

export function createHomeOnlyWebRemoteControlServices(): RootServices {
  const unsupported = (channel: string) => async () => {
    throw new Error(
      `${channel} is not available before a Web remote control workspace bridge is connected.`,
    );
  };
  const settingService: RootServices["settingService"] = {
    get: async () => ({
      recentProjects: [],
      locale: resolveWebRemoteControlScreenLocale(navigator.language),
    }),
    update: async () => {},
    updateDataBaseDir: async () => {},
    ensureDefaultProject: async (path: string) => ({ path, created: false }),
  };

  const emptyGitSummary = (workspacePath: string) => ({
    workspacePath,
    repoRoot: workspacePath,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName: null,
    trackingBranchName: null,
    headRefType: "branch" as const,
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: false,
    isRepository: false,
  });
  // Bug fix: when mobile has only disconnected remote workspaces, do not force bridge creation just to open the task home page.
  // Provide read-only/empty-result services here to absorb Root startup initialization for OAuth, model providers, Git, skills, and other background work,
  // so the expected disconnected state is not reported as an unhandled exception; actual chat capabilities still require reconnecting and switching to bridge services.
  const homeOnlyZCodeTaskService = createEmptyHomeOnlyService<RootServices["zcodeTaskService"]>({
    initialize: async () => ({ available: false }),
    releaseWorkspacePreparation: async () => {},
    checkCodexConnectivity: async () => ({ ok: true }),
    listTasks: async () => [],
    listPinnedTaskIds: async () => [],
    listPinnedTasks: async () => [],
    listTaskList: async () => ({ items: [], total: 0, hasMore: false }),
    getTaskTokenUsage: async (params: { taskId: string }) => ({
      sessionId: params.taskId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    }),
    listArchivedTasks: async () => [],
    getTaskSnapshot: async () => null,
    getTaskSnapshotWithEtag: async () => ({ snapshot: null }),
    getTaskSnapshotBody: async () => null,
    getTaskSnapshotRef: async () => null,
    getTaskSnapshotToolCallsSlice: async () => null,
    getTaskMeta: async () => null,
  });
  return {
    fileService: {
      readdir: unsupported("fileService.readdir"),
      stat: unsupported("fileService.stat"),
      checkFilesExist: unsupported("fileService.checkFilesExist"),
      resolvePath: unsupported("fileService.resolvePath"),
      createDefaultWorkspace: unsupported("fileService.createDefaultWorkspace"),
      ensureConversationWorkspace: unsupported("fileService.ensureConversationWorkspace"),
      createScratchWorkspace: unsupported("fileService.createScratchWorkspace"),
      readTextFile: unsupported("fileService.readTextFile"),
      readMediaPreview: unsupported("fileService.readMediaPreview"),
      readFileRange: unsupported("fileService.readFileRange"),
      readBinaryPreview: unsupported("fileService.readBinaryPreview"),
      searchWorkspaceFiles: unsupported("fileService.searchWorkspaceFiles"),
      listWorkspaceFilesLength: unsupported("fileService.listWorkspaceFilesLength"),
      listWorkspaceFilesRange: unsupported("fileService.listWorkspaceFilesRange"),
      readWorkspaceFileSearchIgnore: unsupported("fileService.readWorkspaceFileSearchIgnore"),
      applyWorkspaceFileSearchIgnoreTransform: unsupported(
        "fileService.applyWorkspaceFileSearchIgnoreTransform",
      ),
      writeWorkspaceFileSearchIgnore: unsupported("fileService.writeWorkspaceFileSearchIgnore"),
    },
    mediaPreviewService:
      createUnsupportedHomeOnlyService<NonNullable<RootServices["mediaPreviewService"]>>(
        "mediaPreviewService",
      ),
    gitService: createEmptyHomeOnlyService<RootServices["gitService"]>({
      getRepositorySummary: async (params: { workspacePath: string }) =>
        emptyGitSummary(params.workspacePath),
      getWorkspaceRepositoryInfo: async () => ({ repositories: [] }),
      getLocalBranches: async () => ({ branches: [], currentBranch: null }),
      getChanges: async () => [],
      getIgnoredPaths: async () => [],
      getDiff: async () => ({ sections: [], files: [] }),
      getBranchComparison: async () => ({
        baseRef: null,
        headRef: null,
        comparisonLabel: null,
        changes: [],
      }),
      // Home-only screens have no connected workspace, so no session pull
      // requests exist yet; an explicit empty answer avoids `undefined`.
      getSessionPullRequests: async () => ({}),
      getIdentity: async () => ({
        userName: null,
        userEmail: null,
        nameSource: null,
        emailSource: null,
        scopeLabel: null,
      }),
      refresh: async () => ({ ok: true }),
    }),
    gitCheckpointService:
      createUnsupportedHomeOnlyService<RootServices["gitCheckpointService"]>(
        "gitCheckpointService",
      ),
    systemService: createUnsupportedHomeOnlyService<RootServices["systemService"]>("systemService"),
    terminalService:
      createUnsupportedHomeOnlyService<RootServices["terminalService"]>("terminalService"),
    settingService,
    credentialService: createEmptyHomeOnlyService<RootServices["credentialService"]>({
      load: async () => null,
    }),
    broadcastService: createEmptyHomeOnlyService<RootServices["broadcastService"]>({
      send: async () => {},
      onMessage: () => ({ dispose: () => {} }),
    }),
    zcodeTaskService: homeOnlyZCodeTaskService,
    zcodeAgentService: createEmptyHomeOnlyService<RootServices["zcodeAgentService"]>({
      initialize: async (params: { workspacePath: string; workspaceIdentity?: string }) => ({
        available: false,
        workspaceKey: params.workspaceIdentity?.trim() || params.workspacePath,
        reason: "ZCode agent service is not available before workspace bridge is connected.",
      }),
      disposeAll: () => {},
    }),
    zcodeSessionService: createEmptyHomeOnlyService<RootServices["zcodeSessionService"]>({
      initializeWorkspace: async (params: {
        workspacePath: string;
        workspaceIdentity?: string;
      }) => ({
        available: false,
        workspaceKey: params.workspaceIdentity?.trim() || params.workspacePath,
        reason: "ZCode session service is not available before workspace bridge is connected.",
      }),
    }),
    // The initial sharing release flow belongs only to the Desktop local host; Web home and /remote do not establish a separate publishing authority.
    conversationShareService: createUnsupportedHomeOnlyService<
      RootServices["conversationShareService"]
    >("conversationShareService"),
    promptAttachmentTransferService: createEmptyHomeOnlyService<
      RootServices["promptAttachmentTransferService"]
    >({
      stage: unsupported("promptAttachmentTransferService.stage"),
      adopt: async () => {},
      cancel: async () => {},
      cleanup: async () => {},
      onDynamicProgress: () => () => ({ dispose: () => {} }),
    }),
    botsService: createUnsupportedHomeOnlyService<RootServices["botsService"]>("botsService"),
    fileWatcherService: createEmptyHomeOnlyService<RootServices["fileWatcherService"]>({
      watch: async () => ({ dispose: () => {} }),
    }),
    oauthService: createEmptyHomeOnlyService<RootServices["oauthService"]>({
      getProviders: async () => [],
      getActiveProvider: async () => null,
      restoreCachedSession: async () => null,
      restoreCachedSessionState: async () => ({ status: "signed-out" }),
      restoreSession: async () => null,
      refreshToken: async () => {},
      logout: async () => {},
      logoutAll: async () => {},
      cancelPending: async () => {},
    }),
    providerSettingsService: createEmptyHomeOnlyService<RootServices["providerSettingsService"]>({
      getView: async () => ({ revision: 0, providers: [] }),
      refresh: async () => ({ revision: 0, providers: [] }),
      testModelConnectivity: async () => ({ results: [] }),
      onDidChange: () => ({ dispose() {} }),
    }),
    modelSelectionService: createEmptyHomeOnlyService<RootServices["modelSelectionService"]>({
      getView: async () => ({ revision: 0, providers: [] }),
      onDidChange: () => ({ dispose() {} }),
    }),
    usageStatsService:
      createUnsupportedHomeOnlyService<RootServices["usageStatsService"]>("usageStatsService"),
    codingPlanSubscriptionService: createUnsupportedHomeOnlyService<
      RootServices["codingPlanSubscriptionService"]
    >("codingPlanSubscriptionService"),
    clientConfigService: createEmptyHomeOnlyService<RootServices["clientConfigService"]>({
      getSnapshot: async () => ({ pluginStoreOrder: null, zsrcUrl: null }),
    }),
    // When mobile Web is not connected to a shared-host attachment, do not call the scenes HTTP endpoint directly; return an empty configuration so the home page remains usable.
    clientScenesService: createEmptyHomeOnlyService<RootServices["clientScenesService"]>({
      list: async () => ({ code: 0, msg: "", data: [] }),
    }),
    // Idle tasks are local Desktop only (D13); treat the Web home-only environment as unsupported.
    offPeakTaskService:
      createUnsupportedHomeOnlyService<RootServices["offPeakTaskService"]>("offPeakTaskService"),
    highspeedCardService:
      createUnsupportedHomeOnlyService<RootServices["highspeedCardService"]>(
        "highspeedCardService",
      ),
    skillsService: createEmptyHomeOnlyService<RootServices["skillsService"]>({
      list: async () => ({
        skills: [],
        capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
        diagnostics: [],
      }),
      buildPromptContext: async ({ prompt }: { prompt: string }) => ({
        prompt,
        activatedSkillNames: [],
      }),
    }),
    skillSyncService:
      createUnsupportedHomeOnlyService<RootServices["skillSyncService"]>("skillSyncService"),
    mcpSyncService:
      createUnsupportedHomeOnlyService<RootServices["mcpSyncService"]>("mcpSyncService"),
    pluginSyncService:
      createUnsupportedHomeOnlyService<RootServices["pluginSyncService"]>("pluginSyncService"),
    pluginsService: createEmptyHomeOnlyService<RootServices["pluginsService"]>({
      list: async () => [],
    }),
    // M5 ③-3: plugin management in Settings is available only on Desktop or a remote-control bridge; the Web home fallback explicitly reports it as unavailable.
    pluginManagementService:
      createUnsupportedHomeOnlyService<RootServices["pluginManagementService"]>(
        "pluginManagementService",
      ),
    subagentsService: createEmptyHomeOnlyService<RootServices["subagentsService"]>({
      list: async () => ({ agents: [], capability: { supported: false } }),
    }),
    commandsService: createEmptyHomeOnlyService<RootServices["commandsService"]>({
      list: async () => ({
        commands: [],
        userCommands: [],
        pluginCommands: [],
        capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
      }),
      setCommandEnabled: async () => undefined,
    }),
    hooksService: createEmptyHomeOnlyService<RootServices["hooksService"]>({
      loadHooks: async () => ({ hooks: [], hooksEnabled: false }),
      saveHooks: async () => undefined,
    }),
    memoryService: createEmptyHomeOnlyService<RootServices["memoryService"]>({
      loadMemory: async () => ({ memory: null }),
      listProjectMemories: async () => [],
    }),
    outputStyleService: createEmptyHomeOnlyService<RootServices["outputStyleService"]>({
      listStyles: async () => ({ styles: [] }),
      getUserStylesDirectory: async () => ({ path: "" }),
    }),
    // Web remote-control home has no local system-prompt overrides; the desktop host owns them.
    systemPromptService:
      createUnsupportedHomeOnlyService<RootServices["systemPromptService"]>("systemPromptService"),
    // Global instructions belong to the target host; when the Web remote-control home has no bridge, report unavailable explicitly and do not provide a local substitute.
    userInstructionsService:
      createUnsupportedHomeOnlyService<RootServices["userInstructionsService"]>(
        "userInstructionsService",
      ),
    // Bug fix: after feedbackService became a shared service interface, the Web remote-control home fallback also needed an implementation.
    // Report unavailable explicitly when the bridge is disconnected, rather than passing types and returning empty feedback data at runtime.
    feedbackService:
      createUnsupportedHomeOnlyService<RootServices["feedbackService"]>("feedbackService"),
    settingsSyncService:
      createUnsupportedHomeOnlyService<RootServices["settingsSyncService"]>("settingsSyncService"),
  };
}

function resolveExternalRelayWsUrl(): string {
  const endpointOrigin =
    import.meta.env.VITE_ZCODE_BASE_URL?.trim() ||
    import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN?.trim();
  return resolveWebRemoteControlRelayWsUrl({
    endpointOrigin,
    overrideUrl: import.meta.env.VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL,
  });
}

function isZhLocale(): boolean {
  return /^zh\b/i.test(navigator.language);
}

function resolveWebRemoteControlLoadingCopy(state: WebRemoteControlTerminalTransportState): {
  title: string;
  description: string;
  steps: string[];
} {
  const zh = isZhLocale();
  const steps = zh
    ? ["连接中转服务", "设备鉴权", "等待桌面端配对", "同步工作区"]
    : [
        "Connect to relay service",
        "Authenticate device",
        "Wait for desktop pairing",
        "Sync workspace",
      ];

  switch (state) {
    case "connecting":
      return {
        title: zh ? "正在连接中转服务…" : "Connecting relay service…",
        description: zh
          ? "正在建立手机与远控中转服务的连接。"
          : "Establishing a connection between your phone and the relay.",
        steps,
      };
    case "authenticating":
      return {
        title: zh ? "正在认证设备…" : "Authenticating device…",
        description: zh
          ? "已连接中转服务，正在完成远控身份校验。"
          : "Relay connected. Verifying your remote-control identity.",
        steps,
      };
    case "waiting":
      return {
        title: zh ? "等待桌面端确认配对…" : "Waiting for desktop pairing…",
        description: zh
          ? "手机端已就绪，等待桌面端会话匹配当前连接。"
          : "Phone is ready. Waiting for desktop to match this connection.",
        steps,
      };
    case "reconnecting":
      return {
        title: zh ? "连接中断，正在重连…" : "Connection interrupted, reconnecting…",
        description: zh
          ? "网络或休眠恢复后会自动重连，请稍候。"
          : "Auto-reconnecting after network or wake-up changes.",
        steps,
      };
    case "paired":
      return {
        title: zh ? "已配对，正在加载工作区…" : "Paired. Loading workspace…",
        description: zh
          ? "连接已建立，正在同步桌面端工作区和任务。"
          : "Connection established. Syncing workspace and tasks.",
        steps,
      };
    case "suspended":
      return {
        title: zh ? "页面在后台，等待恢复…" : "Page is in background, waiting to recover…",
        description: zh
          ? "回到前台后会自动恢复连接。"
          : "Connection will recover automatically when back in foreground.",
        steps,
      };
    default:
      return {
        title: zh ? "正在准备远程控制…" : "Preparing remote control…",
        description: zh
          ? "正在初始化手机端远程控制会话。"
          : "Initializing mobile remote-control session.",
        steps,
      };
  }
}

function WebRemoteControlLoadingScreen({
  state,
}: {
  state: WebRemoteControlTerminalTransportState;
}) {
  const copy = resolveWebRemoteControlLoadingCopy(state);
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 rounded-full bg-warning animate-pulse" />
            <h1 className="text-ui-xs font-medium">{copy.title}</h1>
          </div>
          <p className="mt-2 text-ui-xs/relaxed text-foreground-subtle">{copy.description}</p>
          <div className="mt-4 grid gap-2">
            {copy.steps.map((step, index) => (
              <div
                key={step}
                className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle"
              >
                {`${index + 1}. ${step}`}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function renderWebRemoteControlLoading(state: WebRemoteControlTerminalTransportState): void {
  document.title = "ZCode - Web Remote Control";
  root.render(<WebRemoteControlLoadingScreen state={state} />);
}

async function bootstrapExternalRelayWebRemoteControl(params: URLSearchParams): Promise<void> {
  const relayParams = parseWebRemoteControlExternalQrParams(params);
  if (!relayParams) {
    renderWebRemoteControlFailure(
      toWebRemoteControlFailure(
        "invalid-mobile-connection",
        "Missing or invalid Web remote control relay parameters.",
      ),
    );
    return;
  }

  seedWebRemoteControlThemePreference(relayParams.theme);
  seedStableWebRemoteControlClientId(relayParams.deviceSid);

  let bootstrapping = false;
  let recovering = false;
  let ready = false;
  let terminated = false;
  let terminalTransportState: UiWebRemoteControlTerminalTransportState = "idle";
  let currentWorkspaceKey: string | undefined;
  let currentTaskId: string | undefined;
  let currentRecoveryId: string | undefined;
  let nextBridgeGeneration = 0;
  const checkVersionOnRecovery = window.location.pathname.replace(/\/+$/, "") === "/remote/v4";
  let disposeVersionNotice: (() => void) | undefined;
  const versionGuard = createWebRemoteControlVersionGuard({
    requestBootstrap: () => requestBootstrap(),
    getUrl: () => window.location.href,
    isPageReady: () => ready,
    navigate: (url) => window.location.replace(url),
    onMismatch: (version) => {
      disposeVersionNotice = showWebRemoteControlVersionNotice(version, () =>
        versionGuard.confirm(),
      );
    },
  });
  // Register this shortcut before Root’s global capture phase; a native modal can isolate background elements but cannot isolate window listeners.
  const blockVersionMismatchShortcuts = (event: KeyboardEvent) => {
    if (versionGuard.isBlocked()) event.stopImmediatePropagation();
  };
  window.addEventListener("keydown", blockVersionMismatchShortcuts, true);
  const disposeVersionInputGuard = () =>
    window.removeEventListener("keydown", blockVersionMismatchShortcuts, true);
  let activeRelayProtocol:
    | ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>
    | undefined;
  let activeBridgeServiceRegistration:
    | WebRemoteControlWorkspaceBridgeServiceRegistration
    | undefined;
  let sendMobileDiagnosticPayload:
    | ((payload: WebRemoteControlAppPayload & { zcode_type: "mobile-diagnostic" }) => void)
    | undefined;
  const workspaceListUpdateListeners = new Set<WebRemoteControlWorkspaceListUpdateListener>();

  const subscribeWorkspaceListUpdates = (listener: WebRemoteControlWorkspaceListUpdateListener) => {
    workspaceListUpdateListeners.add(listener);
    return () => {
      workspaceListUpdateListeners.delete(listener);
    };
  };

  const normalizeWorkspaceListResult = (
    result: WebRemoteControlWorkspaceListResult,
  ): WebRemoteControlWorkspaceListResult => ({
    ...result,
    activeWorkspaceKey: result.activeWorkspaceKey ?? currentWorkspaceKey,
    activeTaskId: result.activeTaskId ?? currentTaskId,
  });

  const applyWorkspaceListUpdated = (result: WebRemoteControlWorkspaceListResult) => {
    const normalized = normalizeWorkspaceListResult(result);
    for (const listener of workspaceListUpdateListeners) {
      listener(normalized);
    }
  };

  const sendMobileDiagnostic = (diagnostic: WebRemoteControlTerminalTransportDiagnostic) => {
    if (diagnostic.type === "socket-extensions") {
      return;
    }
    sendMobileDiagnosticPayload?.({
      zcode_type: "mobile-diagnostic",
      event: diagnostic.type,
      timestamp: diagnostic.timestamp,
      state: diagnostic.state,
      previousState: "previousState" in diagnostic ? diagnostic.previousState : undefined,
      pairStatus: "pairStatus" in diagnostic ? diagnostic.pairStatus : undefined,
      closeCode: "code" in diagnostic ? diagnostic.code : undefined,
      closeReason: "reason" in diagnostic ? diagnostic.reason : undefined,
      wasClean: "wasClean" in diagnostic ? diagnostic.wasClean : undefined,
      wasPaired: "wasPaired" in diagnostic ? diagnostic.wasPaired : undefined,
      visibilityState: diagnostic.visibilityState,
      online: diagnostic.online,
      hiddenDurationMs: diagnostic.hiddenDurationMs,
    });
  };

  const sendMobileFailureDiagnostic = (failure: WebRemoteControlFailure) => {
    sendMobileDiagnosticPayload?.({
      zcode_type: "mobile-diagnostic",
      event: "failure",
      timestamp: Date.now(),
      state: terminalTransportState,
      failureReason: failure.reason,
      failureMessage: failure.message,
      visibilityState: document.visibilityState,
      online: navigator.onLine,
    });
  };

  const mapBootstrapUnknownErrorToFailure = (error: unknown): WebRemoteControlFailure => {
    if (error && typeof error === "object" && "reason" in error) {
      return error as WebRemoteControlFailure;
    }
    if (
      error instanceof Error &&
      error.message === "Web remote control relay did not recover before timeout."
    ) {
      // Bug fix: after a long Desktop sleep leaves a “phantom connection,” mobile recoverConnection may time out and first enter unknown,
      // then the waiting timer triggers invalid-mobile, showing the user two conflicting error pages.
      // Map recovery timeouts directly to desktop-disconnected and stop the transport immediately on failure,
      // so the error state is singular and stable.
      return toWebRemoteControlFailure(
        "desktop-disconnected",
        "Desktop did not recover the Web remote control session in time.",
      );
    }
    return toWebRemoteControlFailure(
      "unexpected-error",
      error instanceof Error ? error.message : String(error),
    );
  };

  const renderBootstrapFailure = (failure: WebRemoteControlFailure) => {
    if (terminated || versionGuard.isBlocked()) {
      return;
    }
    sendMobileFailureDiagnostic(failure);
    terminated = true;
    versionGuard.dispose();
    disposeVersionInputGuard();
    activeBridgeServiceRegistration?.dispose();
    activeBridgeServiceRegistration = undefined;
    activeRelayProtocol?.dispose();
    activeRelayProtocol = undefined;
    requester.dispose();
    transport.dispose();
    renderWebRemoteControlFailure(failure);
  };

  const renderBootstrapError = (error: unknown) => {
    renderBootstrapFailure(mapBootstrapUnknownErrorToFailure(error));
  };

  let bootstrapPairedSession:
    | ((options?: { preferredWorkspaceKey?: string; preferredTaskId?: string }) => Promise<void>)
    | undefined;

  const isLifecycleRecoveryReason = (reason: string): boolean =>
    reason === "visible" || reason === "pageshow" || reason === "online" || reason === "resume";

  const recoverVisibleSession = async (reason: string): Promise<void> => {
    if (recovering || isPageUnloading || terminated || versionGuard.isBlocked()) {
      return;
    }
    recovering = true;
    const preferredWorkspaceKey = currentWorkspaceKey;
    const preferredTaskId = currentTaskId;
    currentRecoveryId = createWebRemoteControlRequestId("recovery");
    const requiresBridgeRebuild =
      !isLifecycleRecoveryReason(reason) || activeRelayProtocol?.isDegraded() === true;
    if (requiresBridgeRebuild) {
      activeRelayProtocol?.markDegraded();
    }
    bootstrapping = true;
    try {
      if (!import.meta.env.PROD) {
        console.info("[web-remote-control] recover terminal session", {
          reason,
          recoveryId: currentRecoveryId,
          currentWorkspaceKey: preferredWorkspaceKey,
          currentTaskId: preferredTaskId,
        });
      }
      await transport.recoverConnection();
      if (!requiresBridgeRebuild && activeRelayProtocol && !activeRelayProtocol.isDegraded()) {
        if (checkVersionOnRecovery) {
          try {
            await checkDesktopVersion();
          } catch (error) {
            // A bridge that becomes invalid while validation is pending must still go through the bootstrap below, which revalidates the version and preserves the existing error handling.
            if (!activeRelayProtocol.isDegraded()) throw error;
          }
        }
        // Bug fix: briefly backgrounding the mobile app pauses JavaScript/heartbeats but does not mean the shared-host bridge has failed.
        // The old logic rebuilt the bridge and Root every time the app returned to the foreground, making “Paired, loading workspace…” flash again.
        // Rebuild the bridge only when Desktop reports bridge-degraded or a local frame gap occurs, rather than inferring failure from background duration.
        // Version validation is asynchronous; reread the bridge state afterward so a concurrent degradation event is not missed.
        if (!activeRelayProtocol.isDegraded()) {
          currentRecoveryId = undefined;
          return;
        }
      }
      await bootstrapPairedSession?.({
        preferredWorkspaceKey,
        preferredTaskId,
      });
    } catch (error) {
      if (!import.meta.env.PROD) {
        console.warn(
          "[web-remote-control] terminal recover timed out, keeping current page for retry",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!terminated && !isPageUnloading) {
        // Bug fix: after mobile stays in the background for a long time, recoverConnection may exceed a single wait window.
        // This does not mean Desktop is offline and should not unmount the current React page; otherwise, an error page interrupts the input draft.
        // Keep the current page and input state, and let the transport reconnect state machine recover automatically.
        transport.recoverInBackground();
      }
    } finally {
      recovering = false;
      bootstrapping = false;
    }
  };

  renderWebRemoteControlLoading("connecting");

  const transport = new WebRemoteControlTerminalTransport({
    relayWsUrl: resolveExternalRelayWsUrl(),
    deviceSid: relayParams.deviceSid,
    passHash: relayParams.passHash,
    deviceMid: relayParams.deviceMid,
    appVersion: relayParams.appVersion,
    authProvider: createBrowserWebRemoteControlRelayAuthProvider(),
    onRawTransportPayload: (payload) => activeRelayProtocol?.acceptPayload(payload) ?? false,
    onRawTransportFault: (reasonCode) => {
      activeRelayProtocol?.markDegraded(reasonCode);
    },
    onPayload: (payload) => {
      if (terminated) {
        return;
      }
      if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack") {
        activeRelayProtocol?.acceptPayload(payload);
        return;
      }
      if (requester.acceptPayload(payload)) {
        return;
      }
      if (payload.zcode_type === "workspace-list-updated") {
        applyWorkspaceListUpdated(payload.result);
        return;
      }
      if (payload.zcode_type === "bridge-degraded") {
        if (payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()) {
          activeRelayProtocol?.markDegraded();
          void recoverVisibleSession(payload.reason);
        }
        return;
      }
      if (payload.zcode_type === "workspace-bridge-error") {
        if (payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()) {
          // Bug fix: closing a remote session asynchronously invalidates the current bridge and does not correspond to any pending request.
          // Rebuild the view through hard recovery so the disconnected remote workspace returns to the home-only/reconnect state.
          activeRelayProtocol?.markDegraded();
          void recoverVisibleSession(payload.reason);
        }
        return;
      }
      if (payload.zcode_type === "app-error") {
        renderBootstrapFailure(toWebRemoteControlFailure(payload.reason, payload.error));
      }
    },
    onStateChange: (state) => {
      if (terminated || versionGuard.isBlocked()) {
        return;
      }
      terminalTransportState = state;
      if (state !== "paired") versionGuard.invalidate();
      setWebRemoteControlTerminalTransportState(state);
      if (!ready) {
        renderWebRemoteControlLoading(state);
      }
      if (state !== "paired") {
        return;
      }
      // An existing validation operation consumes its own retry across reconnects; a pairing event must not start another recovery owner.
      if (bootstrapping && pendingVersionCheck) return;
      // A healthy bridge or in-flight initialization must not create another bridge concurrently, but a new pairing must still check the Desktop version.
      if ((activeRelayProtocol && !activeRelayProtocol.isDegraded()) || bootstrapping) {
        if (!checkVersionOnRecovery) return;
        void checkDesktopVersion().catch((error) => {
          // If reading the version fails, use the recovery path without unmounting the current page or draft.
          if (!terminated && !versionGuard.isBlocked()) {
            void recoverVisibleSession("visible");
            if (!import.meta.env.PROD)
              console.warn("[web-remote-control] version check failed", error);
          }
        });
        return;
      }
      if (!bootstrapPairedSession) {
        return;
      }
      bootstrapping = true;
      void bootstrapPairedSession()
        .catch((error) => {
          renderBootstrapError(error);
        })
        .finally(() => {
          bootstrapping = false;
        });
    },
    onFailure: (failure) => {
      renderBootstrapFailure(failure);
    },
    onError: (error) => {
      if (!import.meta.env.PROD) {
        console.warn("[web-remote-control] terminal transport error", error.message);
      }
    },
    onDiagnostic: (diagnostic) => {
      if (!import.meta.env.PROD) {
        console.info("[web-remote-control] terminal diagnostic", diagnostic);
      }
      sendMobileDiagnostic(diagnostic);
    },
    onSendReady: () => {
      if (versionGuard.isBlocked()) return;
      if (activeRelayProtocol?.isDegraded()) return;
      // Bug fix: same-socket matched means only that the relay is reachable again; the Desktop peer may have changed,
      // or only lost the previous batch of data/ACKs. Replay the unacknowledged batch on the same bridge and deduplicate by messageSeq;
      // the adapter retains the original 45-second age so heartbeats cannot keep an unrecoverable link alive indefinitely.
      activeRelayProtocol?.replayUnacknowledged();
    },
    reloadPage: () => {
      window.location.reload();
    },
  });
  sendMobileDiagnosticPayload = (payload) => transport.sendPayload(payload);
  const requester = createWebRemoteControlAppPayloadRequester({
    sendPayload: (payload) => !versionGuard.isBlocked() && transport.sendPayload(payload),
  });

  const requestAppPayload = requester.requestAppPayload;
  const requestWithRelayRecovery = createWebRemoteControlRelayRequestRecovery(() =>
    transport.recoverConnection(),
  );

  const requestBootstrap = async (): Promise<WebRemoteControlWindowBootstrapResult> => {
    const requestId = createWebRemoteControlRequestId("bootstrap");
    const response = await requestAppPayload(
      { zcode_type: "bootstrap-request", requestId },
      (
        payload,
      ): payload is Extract<WebRemoteControlAppPayload, { zcode_type: "bootstrap-response" }> =>
        payload.zcode_type === "bootstrap-response" && payload.requestId === requestId,
    );
    return response.result;
  };

  let pendingVersionCheck: Promise<WebRemoteControlWindowBootstrapResult | undefined> | undefined;
  const checkDesktopVersion = (): Promise<WebRemoteControlWindowBootstrapResult | undefined> => {
    if (pendingVersionCheck) return pendingVersionCheck;
    const readCurrentVersion = async () => {
      let result = await versionGuard.check();
      // Pairing may change while the old bootstrap is waiting; after invalidating the old response, read again through the current connection.
      while (
        !result &&
        !terminated &&
        !versionGuard.isBlocked() &&
        terminalTransportState === "paired"
      ) {
        result = await versionGuard.check();
      }
      return result;
    };
    const request = requestWithRelayRecovery(readCurrentVersion, { recoverTimeout: true }).finally(
      () => {
        if (pendingVersionCheck === request) pendingVersionCheck = undefined;
      },
    );
    pendingVersionCheck = request;
    return request;
  };

  const requestPlatformMethod = async <K extends WebRemoteControlPlatformMethod>(
    method: K,
    args?: WebRemoteControlPlatformMethodArgsMap[K],
  ): Promise<WebRemoteControlPlatformMethodResultMap[K]> => {
    const response = await requestWithRelayRecovery(() => {
      const requestId = createWebRemoteControlRequestId("platform");
      const request = {
        zcode_type: "platform-request",
        requestId,
        method,
        args,
      } as WebRemoteControlPlatformRequestPayload;
      return requestAppPayload(
        request,
        (
          payload,
        ): payload is Extract<
          WebRemoteControlPlatformResponsePayload,
          { zcode_type: "platform-response" }
        > =>
          payload.zcode_type === "platform-response" &&
          payload.requestId === requestId &&
          payload.method === method,
      );
    });
    const platformResponse = response as WebRemoteControlPlatformResponsePayload;
    if (!platformResponse.success) {
      throw new Error(platformResponse.error);
    }
    return platformResponse.result as WebRemoteControlPlatformMethodResultMap[K];
  };
  const listWorkspaces = async (): Promise<WebRemoteControlWorkspaceListResult> => {
    const requestWorkspaceList = async () => {
      const requestId = createWebRemoteControlRequestId("workspace-list");
      return requestAppPayload(
        { zcode_type: "workspace-list-request", requestId },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-list-response" }
        > => payload.zcode_type === "workspace-list-response" && payload.requestId === requestId,
      );
    };
    const response = await requestWithRelayRecovery(() => requestWorkspaceList(), {
      // Bug fix: the external relay may occasionally retain only a mobile-to-Desktop one-way path, or a request may not be sent during a reconnect/suspect window.
      // The home-page list request is idempotent; after failure, rebuilding the terminal socket and retrying once is safer than showing zero tasks.
      recoverTimeout: true,
    });
    return normalizeWorkspaceListResult(response.result);
  };

  const updateMobileViewState = async (workspaceKey: string, taskId?: string): Promise<void> => {
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    transport.sendPayload({
      zcode_type: "mobile-view-state-update",
      viewState: {
        activeWorkspaceKey: workspaceKey,
        ...(taskId ? { activeTaskId: taskId } : {}),
        updatedAt: Date.now(),
      },
      deviceInfo: collectWebRemoteControlMobileDeviceInfo({
        appVersion: relayParams.appVersion,
      }),
    });
  };

  const reconnectWorkspace = async (workspaceKey: string): Promise<void> => {
    const response = await requestWithRelayRecovery(() => {
      const requestId = createWebRemoteControlRequestId("workspace-reconnect");
      return requestAppPayload(
        {
          zcode_type: "workspace-reconnect-request",
          requestId,
          workspaceKey,
        },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-reconnect-response" }
        > =>
          payload.zcode_type === "workspace-reconnect-response" &&
          payload.requestId === requestId &&
          payload.workspaceKey === workspaceKey,
        {
          // Remote reconnection starts or deploys the host, and the first Docker/SSH connection may exceed 10 seconds; allow more time here to avoid a false mobile timeout after Desktop succeeds.
          timeoutMs: WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
        },
      );
    });
    if (!response.success) {
      throw new Error(response.error);
    }
  };

  const requestWorkspaceOpen = async (target: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void> => {
    const requestId = createWebRemoteControlRequestId("workspace-open");
    const response = await requestWithRelayRecovery(() =>
      requestAppPayload(
        {
          zcode_type: "workspace-open-request",
          requestId,
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-open-response" }
        > => payload.zcode_type === "workspace-open-response" && payload.requestId === requestId,
      ),
    );
    if (!response.success) {
      throw new Error(response.error);
    }
  };

  const openWorkspaceBridge = async (
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions,
  ): Promise<{
    bridge: WebRemoteControlExternalWorkspaceBridge;
    services: Awaited<ReturnType<typeof connectViaProtocol>>;
    relayProtocol: ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>;
  }> => {
    isSwitchingWebRemoteControlWorkspace = true;
    try {
      const bridgeSessionId = createWebRemoteControlRequestId("bridge");
      const bridgeGeneration = ++nextBridgeGeneration;
      const response = await requestWithRelayRecovery(() =>
        requestAppPayload(
          {
            zcode_type: "workspace-bridge-open",
            requestId: createWebRemoteControlRequestId("workspace-bridge"),
            bridgeSessionId,
            bridgeGeneration,
            ...(currentRecoveryId ? { recoveryId: currentRecoveryId } : {}),
            workspaceKey,
            ...(options?.taskId ? { taskId: options.taskId } : {}),
          },
          (
            payload,
          ): payload is Extract<
            WebRemoteControlAppPayload,
            { zcode_type: "workspace-bridge-ready" }
          > =>
            payload.zcode_type === "workspace-bridge-ready" &&
            payload.bridgeSessionId === bridgeSessionId,
        ),
      );
      currentRecoveryId = undefined;
      if (terminated || versionGuard.isBlocked()) {
        throw new Error(
          "Web remote control version changed before the workspace bridge was ready.",
        );
      }
      const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
        bridgeSessionId: response.bridge.bridgeSessionId,
        bridgeGeneration: response.bridge.bridgeGeneration,
        recoveryId: response.bridge.recoveryId,
        measureFrameBytes: (frame) => transport.measurePayloadBytes(frame),
        sendFrame: (frame) => {
          if (versionGuard.isBlocked()) return false;
          const result = transport.sendPayloadResult(frame);
          if (result.kind === "oversize") {
            throw new Error("remote.rpcFrame.envelopeTooLarge");
          }
          return result.kind === "sent";
        },
      });
      relayProtocol.onDegraded((fault) => {
        if (activeRelayProtocol !== relayProtocol) return;
        if (!import.meta.env.PROD) {
          console.warn("[web-remote-control] raw relay bridge degraded", {
            bridgeSessionId: relayProtocol.getBridgeSessionId(),
            reasonCode: fault.reasonCode,
          });
        }
        void recoverVisibleSession(fault.reasonCode);
      });
      const services = connectViaProtocol(relayProtocol.protocol);
      const bridgeServiceRegistration = registerWebRemoteControlWorkspaceBridgeServices({
        bridge: response.bridge,
        services,
      });
      // Marking a task as read is a side effect of opening it; do not wait for completion, so slow disk or remote I/O cannot block bridge switching.
      void markOpenedWebRemoteControlBridgeTaskRead({
        bridge: response.bridge,
        expectedUnreadAt: options?.markTaskReadExpectedUnreadAt,
        services,
      });
      const previousRelayProtocol = activeRelayProtocol;
      const previousBridgeServiceRegistration = activeBridgeServiceRegistration;
      activeRelayProtocol = relayProtocol;
      activeBridgeServiceRegistration = bridgeServiceRegistration;
      previousRelayProtocol?.dispose();
      previousBridgeServiceRegistration?.dispose();
      currentWorkspaceKey = response.bridge.workspaceKey;
      currentTaskId = response.bridge.initialTaskId;
      await updateMobileViewState(response.bridge.workspaceKey, response.bridge.initialTaskId);
      return { bridge: response.bridge, services, relayProtocol };
    } finally {
      isSwitchingWebRemoteControlWorkspace = false;
    }
  };

  const renderExternalRelayRoot = (
    services: Awaited<ReturnType<typeof connectViaProtocol>>,
    bridge: WebRemoteControlExternalWorkspaceBridge,
    initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
  ) => {
    if (terminated || versionGuard.isBlocked()) return;
    ready = true;
    document.title = "ZCode - Web Remote Control";
    root.render(
      <AppErrorBoundary key={bridge.bridgeSessionId}>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
          preferSettingServiceLocale
        >
          <Root
            services={services}
            platform={createWebPlatform({
              externalWebRemoteControlProxy: {
                requestPlatformMethod,
                reportTelemetryEvent: (event) => {
                  const parsed = sessionCreateTelemetrySchema.safeParse(event);
                  if (parsed.success)
                    transport.sendPayload({ zcode_type: "telemetry-report", event: parsed.data });
                },
              },
            })}
            // Bug cause: mobile reuses persisted Assistant rows from the Desktop Host, but Root disables
            // code-comment projection by default, causing replay hydration to expose raw directives. This flag only changes presentation,
            // and does not affect the relay, Host, or replayable state.
            assistantCodeCommentCardsEnabled
            initialWorkspaceAbsPath={bridge.workspacePath}
            initialWorkspaceIdentity={
              bridge.kind === "remote" ? bridge.workspaceIdentity : undefined
            }
            initialTaskId={bridge.initialTaskId}
            initialWebRemoteControlMobileNavigationIntent={initialNavigationIntent}
            webRemoteControlTerminalTransportState={terminalTransportState}
            initialWorkspaceLoadingFallback={<WebRemoteControlLoadingScreen state="paired" />}
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              listWorkspaces,
              onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
              switchWorkspace: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(workspaceKey, options);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              markTaskRead: (task) =>
                markCurrentWebRemoteControlBridgeTaskRead({
                  bridge,
                  services,
                  task,
                }),
              startDraft: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(workspaceKey, undefined);
                await updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              reconnectWorkspace,
              openWorkspace: async (target) => {
                // Same contract as the HTTP relay: the desktop opens the workspace, this client
                // waits for the refreshed list and attaches through the workspace bridge.
                await openWebRemoteControlWorkspace({
                  target,
                  deps: {
                    requestWorkspaceOpen,
                    listWorkspaces,
                    switchWorkspace: async (workspaceKey) => {
                      const result = await openWorkspaceBridge(workspaceKey);
                      renderExternalRelayRoot(result.services, result.bridge, undefined);
                    },
                    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                  },
                });
              },
              updateMobileViewState,
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  const renderExternalRelayHomeOnlyRoot = async (
    workspaceKey: string,
    taskId?: string,
  ): Promise<void> => {
    if (terminated || versionGuard.isBlocked()) return;
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    await updateMobileViewState(workspaceKey, taskId);
    document.title = "ZCode - Web Remote Control";
    const initialResult = await listWorkspaces();
    if (terminated || versionGuard.isBlocked()) return;
    ready = true;
    root.render(
      <AppErrorBoundary key={`home-only-${workspaceKey}`}>
        <ZCodeIntlProvider>
          <Root
            services={createHomeOnlyWebRemoteControlServices()}
            platform={createWebPlatform({
              externalWebRemoteControlProxy: {
                requestPlatformMethod,
                reportTelemetryEvent: (event) => {
                  const parsed = sessionCreateTelemetrySchema.safeParse(event);
                  if (parsed.success)
                    transport.sendPayload({ zcode_type: "telemetry-report", event: parsed.data });
                },
              },
            })}
            initialWorkspaceAbsPath={workspaceKey}
            initialTaskId={taskId}
            initialWebRemoteControlMobileNavigationIntent={undefined}
            webRemoteControlTerminalTransportState={terminalTransportState}
            initialWorkspaceLoadingFallback={<WebRemoteControlLoadingScreen state="paired" />}
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              listWorkspaces: async () => ({
                ...(await listWorkspaces()),
                activeWorkspaceKey: currentWorkspaceKey,
                activeTaskId: currentTaskId,
              }),
              onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
              switchWorkspace: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(nextWorkspaceKey, options);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              startDraft: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(nextWorkspaceKey, undefined);
                await updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              reconnectWorkspace,
              updateMobileViewState,
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
            initialWebRemoteControlWorkspaceList={initialResult}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  bootstrapPairedSession = async (options?: {
    preferredWorkspaceKey?: string;
    preferredTaskId?: string;
  }) => {
    const bootstrapResult = await checkDesktopVersion();
    if (!bootstrapResult || terminated || versionGuard.isBlocked()) return;
    const preferredWorkspace = options?.preferredWorkspaceKey
      ? bootstrapResult.workspaces.find(
          (workspace) =>
            resolveWebRemoteControlWorkspaceKey(workspace) === options.preferredWorkspaceKey,
        )
      : undefined;
    const selectedWorkspace = preferredWorkspace
      ? {
          workspaceKey: resolveWebRemoteControlWorkspaceKey(preferredWorkspace),
          taskId: options?.preferredTaskId,
          canBridge:
            preferredWorkspace.kind !== "remote" ||
            Boolean(preferredWorkspace.workspaceIdentity && preferredWorkspace.remoteSessionId),
        }
      : selectInitialWebRemoteControlWorkspace(bootstrapResult);
    if (!selectedWorkspace) {
      throw toWebRemoteControlFailure(
        "workspace-closed",
        "No opened desktop workspace is available for Web remote control.",
      );
    }
    if (!selectedWorkspace.canBridge) {
      await renderExternalRelayHomeOnlyRoot(
        selectedWorkspace.workspaceKey,
        selectedWorkspace.taskId,
      );
      return;
    }

    const result = await openWorkspaceBridge(selectedWorkspace.workspaceKey, {
      taskId: selectedWorkspace.taskId,
    });
    renderExternalRelayRoot(result.services, result.bridge);
  };

  const lifecycle = createWebRemoteControlLifecycleRecovery({
    documentTarget: document,
    windowTarget: window,
    onSuspend: () => {
      // Bug fix: after mobile hidden/pagehide, the system may pause JavaScript timers and WebSockets.
      // Only save the current workspace/task and pause heartbeats here; do not refresh. Reconnect and bootstrap again when the app returns to the foreground.
      transport.suspend();
    },
    onRecover: (reason) => {
      void recoverVisibleSession(reason);
    },
  });
  window.addEventListener(
    "beforeunload",
    () => {
      terminated = true;
      versionGuard.dispose();
      disposeVersionInputGuard();
      disposeVersionNotice?.();
      activeBridgeServiceRegistration?.dispose();
      activeBridgeServiceRegistration = undefined;
      lifecycle.dispose();
    },
    { once: true },
  );
  transport.start();
}

async function bootstrapWebRemoteControlByToken(params: URLSearchParams): Promise<void> {
  const remoteControlToken = params.get("remoteControlToken")?.trim();
  if (!remoteControlToken) {
    return;
  }

  const relayOrigin = params.get("relayOrigin")?.trim() || window.location.origin;
  let activeBridgeSocket: WebSocket | null = null;
  let activeBridgeServiceRegistration:
    | WebRemoteControlWorkspaceBridgeServiceRegistration
    | undefined;
  let currentWorkspaceKey: string | undefined;
  let currentTaskId: string | undefined;
  let pendingMobileNavigationIntent: WebRemoteControlMobileNavigationIntent | undefined;
  let webRemoteControlCloseFailure: WebRemoteControlFailure | null = null;

  const renderFailure = (failure: WebRemoteControlFailure) => {
    webRemoteControlCloseFailure = failure;
    activeBridgeServiceRegistration?.dispose();
    activeBridgeServiceRegistration = undefined;
    renderWebRemoteControlFailure(failure);
  };

  const bootstrapProxy = { token: remoteControlToken, relayOrigin };
  const snapshot = await requestWebRemoteControlWindowBootstrap(bootstrapProxy);
  const windowConnection = await connectWebRemoteControlWindow(bootstrapProxy, (event) => {
    if (isPageUnloading) {
      return;
    }
    renderFailure(mapWebRemoteControlSocketCloseToFailure(event));
  });
  const proxy: WebRemoteControlProxyOptions = {
    token: remoteControlToken,
    relayOrigin,
    windowControlSessionId: windowConnection.ready.windowControlSessionId,
    mobileConnectionId: windowConnection.ready.mobileConnectionId,
  };

  const renderBridgeRoot = (
    services: Awaited<ReturnType<typeof connectViaWebSocket>>,
    bridge: WebRemoteControlWorkspaceBridge,
    initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
  ) => {
    const initialWorkspaceIdentity =
      bridge.kind === "remote" ? bridge.workspaceIdentity : undefined;
    document.title = "ZCode - Web Remote Control";
    root.render(
      <AppErrorBoundary key={bridge.bridgeSessionId}>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
          preferSettingServiceLocale
        >
          <Root
            services={services}
            platform={createWebPlatform({ webRemoteControlProxy: proxy })}
            // Keep the same Renderer projection as the external relay; regular Web Server Root continues to use the disabled default.
            assistantCodeCommentCardsEnabled
            initialWorkspaceAbsPath={bridge.workspacePath}
            initialWorkspaceIdentity={initialWorkspaceIdentity}
            initialTaskId={bridge.initialTaskId}
            initialWebRemoteControlMobileNavigationIntent={initialNavigationIntent}
            initialWorkspaceLoadingFallback={<WebRemoteControlLoadingScreen state="paired" />}
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              listWorkspaces: () =>
                requestWebRemoteControlWorkspaces(proxy).then((result) => ({
                  ...result,
                  activeWorkspaceKey: result.activeWorkspaceKey ?? currentWorkspaceKey,
                  activeTaskId: result.activeTaskId ?? currentTaskId,
                })),
              switchWorkspace: async (workspaceKey, options) => {
                await openWorkspaceBridge(workspaceKey, options);
              },
              markTaskRead: (task) =>
                markCurrentWebRemoteControlBridgeTaskRead({
                  bridge,
                  services,
                  task,
                }),
              startDraft: async (workspaceKey, options) => {
                pendingMobileNavigationIntent = options?.mobileNavigationIntent;
                await openWorkspaceBridge(workspaceKey, undefined);
              },
              openWorkspace: async (target) => {
                // The worktree flow is the single sanctioned open path: the DESKTOP opens the
                // workspace (its window Host owns local workspaces); this client only attaches
                // through the existing workspace bridge afterwards.
                await openWebRemoteControlWorkspace({
                  target,
                  deps: {
                    requestWorkspaceOpen: (openTarget) =>
                      requestWebRemoteControlWorkspaceOpen(proxy, openTarget),
                    listWorkspaces: () => requestWebRemoteControlWorkspaces(proxy),
                    switchWorkspace: (workspaceKey) => openWorkspaceBridge(workspaceKey),
                    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                  },
                });
              },
              updateMobileViewState: async (workspaceKey, taskId) => {
                currentWorkspaceKey = workspaceKey;
                currentTaskId = taskId;
                await updateWebRemoteControlMobileViewState(proxy, workspaceKey, taskId);
              },
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  const openWorkspaceBridge = async (
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions,
  ): Promise<void> => {
    isSwitchingWebRemoteControlWorkspace = true;
    pendingMobileNavigationIntent = options?.mobileNavigationIntent;
    let bridgeSocket: WebSocket | null = null;
    try {
      const bridge = await requestWebRemoteControlWorkspaceBridge(proxy, workspaceKey, options);
      const services = await connectViaWebSocket(bridge.wsUrl, {
        onOpenSocket: (socket) => {
          bridgeSocket = socket;
        },
        onClose: (event) => {
          if (
            isPageUnloading ||
            isSwitchingWebRemoteControlWorkspace ||
            bridgeSocket !== activeBridgeSocket
          ) {
            return;
          }

          renderFailure(mapWebRemoteControlSocketCloseToFailure(event));
        },
      });
      const bridgeServiceRegistration = registerWebRemoteControlWorkspaceBridgeServices({
        bridge,
        services,
      });
      // The helper records a failure to mark as read; navigation continues with the target bridge that is already established.
      void markOpenedWebRemoteControlBridgeTaskRead({
        bridge,
        expectedUnreadAt: options?.markTaskReadExpectedUnreadAt,
        services,
      });

      const previousBridgeSocket = activeBridgeSocket;
      const previousBridgeServiceRegistration = activeBridgeServiceRegistration;
      activeBridgeSocket = bridgeSocket;
      activeBridgeServiceRegistration = bridgeServiceRegistration;
      previousBridgeSocket?.close();
      previousBridgeServiceRegistration?.dispose();
      currentWorkspaceKey = bridge.workspaceKey;
      currentTaskId = bridge.initialTaskId;
      await updateWebRemoteControlMobileViewState(proxy, bridge.workspaceKey, bridge.initialTaskId);
      const initialNavigationIntent = pendingMobileNavigationIntent;
      pendingMobileNavigationIntent = undefined;
      renderBridgeRoot(services, bridge, initialNavigationIntent);
    } finally {
      pendingMobileNavigationIntent = undefined;
      isSwitchingWebRemoteControlWorkspace = false;
    }
  };

  const selectedWorkspace = selectInitialWebRemoteControlWorkspace(snapshot);
  if (!selectedWorkspace) {
    throw toWebRemoteControlFailure(
      "workspace-closed",
      "No opened desktop workspace is available for Web remote control.",
    );
  }

  try {
    await openWorkspaceBridge(selectedWorkspace.workspaceKey, {
      taskId: selectedWorkspace.taskId,
    });
  } catch (error) {
    windowConnection.socket.close();
    throw error;
  }

  if (webRemoteControlCloseFailure) {
    windowConnection.socket.close();
  }
}

async function bootstrapWebApp() {
  const params = new URLSearchParams(window.location.search);
  if (isWebOAuthCallback(params)) {
    renderWebAuthCallbackPage();
    return;
  }

  if (isConversationSharePath(window.location.pathname)) {
    await renderConversationSharePage();
    return;
  }

  if (isWebRemoteControlRoute()) {
    await bootstrapExternalRelayWebRemoteControl(params);
    return;
  }

  if (params.has("remoteControlToken")) {
    try {
      await bootstrapWebRemoteControlByToken(params);
    } catch (error) {
      renderWebRemoteControlFailure(
        error && typeof error === "object" && "reason" in error
          ? (error as WebRemoteControlFailure)
          : toWebRemoteControlFailure(
              "unexpected-error",
              error instanceof Error ? error.message : String(error),
            ),
      );
    }
    return;
  }

  if (shouldUseWebRemoteAuth(params)) {
    const auth = await webAuthService.restoreCachedSession();
    if (!auth) {
      renderWebLoginPage();
      return;
    }

    renderWebLoggedInWaitingPage(auth);
    return;
  }

  let bootstrap: WebBootstrapResult;
  try {
    bootstrap = await resolveWebBootstrap();
  } catch (error) {
    renderWebRemoteControlFailure(
      error && typeof error === "object" && "reason" in error
        ? (error as WebRemoteControlFailure)
        : toWebRemoteControlFailure(
            "unexpected-error",
            error instanceof Error ? error.message : String(error),
          ),
    );
    return;
  }

  try {
    const services = await connectViaWebSocket(bootstrap.wsUrl, {
      onClose: () => {},
    });
    const platform = createWebPlatform();
    document.title = "ZCode - Web + Server";

    root.render(
      <AppErrorBoundary>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
        >
          <Root
            services={services}
            platform={platform}
            initialWorkspaceAbsPath={bootstrap.initialWorkspaceAbsPath}
            initialWorkspaceIdentity={bootstrap.initialWorkspaceIdentity}
            initialTaskId={bootstrap.initialTaskId}
            restoreSession={bootstrap.restoreSession}
            allowOpenWorkspace={bootstrap.allowOpenWorkspace}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  } catch (error) {
    renderWebRemoteControlFailure(
      error && typeof error === "object" && "reason" in error
        ? (error as WebRemoteControlFailure)
        : toWebRemoteControlFailure(
            "unexpected-error",
            error instanceof Error ? error.message : String(error),
          ),
    );
  }
}

void bootstrapWebApp();
