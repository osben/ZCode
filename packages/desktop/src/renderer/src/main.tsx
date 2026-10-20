/* eslint-disable max-lines -- Desktop renderer bridge 聚合平台、远端 attachment 与启动编排契约。 */
import { DatabaseStartupAdmission } from "./databaseStartupAdmission.js";
import { initializeDesktopLocalTtft } from "./localTtftBootstrap.js";
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import {
  AppErrorBoundary,
  Root,
  GlobalDatabaseStartupLoading,
  UpdateStatusWindowRoot,
  ZCodeIntlProvider,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  createRemoteWorkspaceDisconnectedError,
  installDocumentHiddenMotionPause,
  playTaskNotificationSound,
  setStreamClientId,
  setReactErrorArmsReporter,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import {
  applyTheme,
  migrateThemeSelection,
  THEME_PALETTE_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "@zcode/ui/useTheme";
import { connectViaMessagePort, createMessagePortServiceConnection } from "@zcode/client";
import {
  InternalChannels,
  databaseStartupStateSchema,
  type DatabaseStartupControl,
  collectTelemetryRendererContext,
  parseLaunchMarks,
  LAUNCH_MARKS_QUERY_KEY,
  type LaunchMarks,
  DEFAULT_LOCALE,
  isLocale,
} from "@zcode/shared";
import type { Locale } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { syncAppTelemetryContext } from "../appTelemetryBridge.js";
import { createDesktopPlatform } from "./desktopPlatform.js";
import { startPerformanceTimelineCleanup } from "./performanceTimelineCleanup.js";
import { initializeDesktopUserActionTrace } from "./userActionTraceBootstrap.js";
import { buildRemoteWorkspaceSessionServicesForRegistration } from "./remoteWorkspaceSessionServices.js";
import { handleSourceSettingsServicePortMessage } from "./sourceSettingsServicePortBridge.js";
import {
  notifyRemoteWorkspaceServicePortReady,
  parseRemoteWorkspaceServicePortMessage,
  type RemoteWorkspaceServicePortRegistration,
} from "./remoteWorkspaceServicePortBridge.js";

type DesktopRendererImportMetaEnv = {
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
};

startPerformanceTimelineCleanup();

// T4: renderer bundle execution begins. Also parse T0-T3 injected by main from the loadURL query.
const rendererStartedAt = Date.now();
const launchMarks: LaunchMarks | null = parseLaunchMarks(
  new URLSearchParams(window.location.search).get(LAUNCH_MARKS_QUERY_KEY),
);
(
  window as Window & {
    __ZCODE_RENDERER_START__?: number;
    __ZCODE_LAUNCH_MARKS__?: LaunchMarks | null;
  }
).__ZCODE_RENDERER_START__ = rendererStartedAt;
(window as Window & { __ZCODE_LAUNCH_MARKS__?: LaunchMarks | null }).__ZCODE_LAUNCH_MARKS__ =
  launchMarks;
registerE2EStoreBridgesIfEnabled();

function registerE2EStoreBridgesIfEnabled() {
  const env = ((import.meta as ImportMeta & { env?: DesktopRendererImportMetaEnv }).env ??
    {}) as DesktopRendererImportMetaEnv;
  if (env.VITE_ZCODE_E2E_STORE_BRIDGE !== "1") {
    return;
  }

  void import("@zcode/ui/e2e-store-bridge").then(({ registerE2EStoreBridges }) => {
    registerE2EStoreBridges();
  });
}

// Apply the saved theme and color scheme before the first screen to prevent a flash; the store takes
// over afterward.
{
  const { mode, palette } = migrateThemeSelection(
    localStorage.getItem(THEME_STORAGE_KEY),
    localStorage.getItem(THEME_PALETTE_STORAGE_KEY),
  );
  applyTheme(mode, palette);
}

const isMacDesktop = navigator.userAgent.includes("Mac");
const isWindowsDesktop = navigator.userAgent.includes("Windows");
const isLinuxDesktop = !isMacDesktop && !isWindowsDesktop;
// The hidden native title bar on macOS still participates in mouse-drag hit testing, so deep overlays
// need a platform marker to avoid its height.
document.documentElement.classList.toggle("platform-mac-desktop", isMacDesktop);
// Windows' native titleBarOverlay shares the upper-right corner with the renderer. If a deep overlay
// cannot read Root's isWindowsDesktop prop, it may place the close button in the native window-control
// hit area. The root platform marker describes only Desktop chrome, so regular Windows Web does not use
// the title-bar safe area.
document.documentElement.classList.toggle("platform-windows-desktop", isWindowsDesktop);
// Linux window title bars are drawn by the renderer. If an in-app Dialog overlay covers the whole
// webContents, it also intercepts the title-bar click area. Mark the desktop Linux root so UI overlays
// can avoid the title bar only on Linux.
document.documentElement.classList.toggle("platform-linux-desktop", isLinuxDesktop);
const isLocalDevelopmentRuntime =
  (
    globalThis as typeof globalThis & {
      __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__?: boolean;
    }
  ).__ZCODE_LOCAL_DEVELOPMENT_RUNTIME__ === true;

function readBooleanFlag(name: string, defaultValue: boolean): boolean {
  const value = new URLSearchParams(window.location.search).get(name);
  if (value == null) return defaultValue;
  return value !== "false" && value !== "0";
}

function readStringFlag(name: string): string | undefined {
  const value = new URLSearchParams(window.location.search).get(name);
  return value == null || value.trim() === "" ? undefined : value;
}

const restoreSession = readBooleanFlag("restoreSession", true);
const supportsSettings = readBooleanFlag("supportsSettings", true);
const initialWorkspaceAbsPath = readStringFlag("initialWorkspacePath");
const initialWorkspacePurpose = readStringFlag("initialWorkspacePurpose");
const unavailableWorkspacePath = readStringFlag("unavailableWorkspacePath");
const windowKind = readStringFlag("windowKind");
const initialLocaleFlag = readStringFlag("locale");
const initialLocale: Locale = isLocale(initialLocaleFlag) ? initialLocaleFlag : DEFAULT_LOCALE;
let baseServicesForRemoteSessions: IServiceAccessor | null = null;
const pendingRemoteWorkspaceServicePorts: RemoteWorkspaceServicePortRegistration[] = [];

const desktopPlatform = createDesktopPlatform({ isLocalDevelopmentRuntime });
initializeDesktopLocalTtft(desktopPlatform);
initializeDesktopUserActionTrace({
  platform: desktopPlatform,
  isLocalDevelopmentRuntime,
});

/**
 * Wait for preload to forward the MessagePort through window.postMessage.
 *
 * A MessagePort cannot pass through contextBridge because it loses native methods. Preload uses
 * window.postMessage + transfer to pass the port unchanged to the renderer.
 * The port comes from utilityProcess for local windows and the same way for remote windows, so the
 * renderer does not need to distinguish them.
 */
// Previously, an anonymous function registered addEventListener("message") again on reload/HMR,
// causing createRoot to mount multiple times on the same DOM node. Use a flag to prevent reinitialization.
// Disable CSS animations while the window is hidden so DocumentTimeline does not retain unloaded DOM subtrees.
installDocumentHiddenMotionPause();
let appInitialized = false;
const databaseStartupAdmission = new DatabaseStartupAdmission();
const appRoot =
  windowKind === "update-status" ? null : createRoot(document.getElementById("root")!);
const sendStartupControl = (control: DatabaseStartupControl) =>
  window.postMessage({ type: InternalChannels.DatabaseStartupControl, control }, "*");
function renderDatabaseStartup(): void {
  appRoot?.render(
    <AppErrorBoundary isDesktop isMacDesktop={isMacDesktop} isWindowsDesktop={isWindowsDesktop}>
      <ZCodeIntlProvider
        initialLocale={initialLocaleFlag ? initialLocale : undefined}
        resolveSystemLocale={desktopPlatform.getSystemLocale}
      >
        <StartupReadyNotifier />
        <GlobalDatabaseStartupLoading
          state={databaseStartupAdmission.state}
          onRetry={() => {
            if (databaseStartupAdmission.state)
              sendStartupControl({
                action: "retry",
                attemptId: databaseStartupAdmission.state.attemptId,
              });
          }}
          onCopy={(details) => navigator.clipboard.writeText(details)}
          onExit={() => sendStartupControl({ action: "exit" })}
        />
      </ZCodeIntlProvider>
    </AppErrorBoundary>,
  );
}
function enterAppIfPrepared(): void {
  if (appInitialized) return;
  const port = databaseStartupAdmission.takeReadyPort();
  if (port) initializeBusinessRoot(port);
}
const firstStartupStateTimer =
  windowKind === "update-status"
    ? undefined
    : setTimeout(() => {
        if (databaseStartupAdmission.state) return;
        const now = Date.now();
        databaseStartupAdmission.state = {
          schemaVersion: 1,
          startupId: "unavailable",
          attemptId: "startup-channel-unavailable",
          sequence: 0,
          startedAt: rendererStartedAt,
          updatedAt: now,
          phase: "failed",
          errorCode: "startup_status_timeout",
          disk: [],
        };
        renderDatabaseStartup();
      }, 30_000);

function registerRemoteWorkspaceServicePort(params: RemoteWorkspaceServicePortRegistration) {
  if (!baseServicesForRemoteSessions) {
    return;
  }

  const remoteConnection = createMessagePortServiceConnection(params.port);
  const remoteServices = remoteConnection.services;
  const services = buildRemoteWorkspaceSessionServicesForRegistration({
    baseServices: baseServicesForRemoteSessions,
    remoteServices,
    targetKind: params.target.kind,
    sourceServerId: params.sourceServerId,
  });
  registerRemoteWorkspaceSession({
    sessionId: params.sessionId,
    ...(params.sourceServerId ? { sourceServerId: params.sourceServerId } : {}),
    ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    ...(params.workspacePurpose ? { workspacePurpose: params.workspacePurpose } : {}),
    target: params.target,
    services,
    dispose: (reason) =>
      remoteConnection.dispose(reason ?? createRemoteWorkspaceDisconnectedError()),
  });
  // Canonical workspace binding replaces the remote-scoped port.
  // Report ready only after the store registers the new services, so callers can reload and use the new
  // generation after the bind IPC returns.
  notifyRemoteWorkspaceServicePortReady(params);
}

function flushPendingRemoteWorkspaceServicePorts(): void {
  if (!baseServicesForRemoteSessions || pendingRemoteWorkspaceServicePorts.length === 0) {
    return;
  }

  const pending = pendingRemoteWorkspaceServicePorts.splice(0);
  for (const entry of pending) {
    registerRemoteWorkspaceServicePort(entry);
  }
}

function StartupReadyNotifier() {
  useEffect(() => {
    // T5: first React commit, used to calculate the react_commit stage of startup duration.
    (window as Window & { __ZCODE_REACT_COMMIT_AT__?: number }).__ZCODE_REACT_COMMIT_AT__ =
      Date.now();
    // React's first screen may not have committed when the HTML startup shell animation ends, so removing
    // the shell immediately would expose a blank screen. Notify index.html after the React commit; the
    // shell then waits for both animation completion and React readiness before exiting.
    window.dispatchEvent(new Event("zcode-react-startup-ready"));
  }, []);

  return null;
}

function handleServicePortMessage(event: MessageEvent): void {
  if (event.source === window && event.data?.type === InternalChannels.DatabaseStartupState) {
    const result = databaseStartupStateSchema.safeParse(event.data.state);
    if (!result.success || appInitialized) return;
    const next = result.data;
    if (!databaseStartupAdmission.acceptState(next)) return;
    if (firstStartupStateTimer) clearTimeout(firstStartupStateTimer);
    renderDatabaseStartup();
    enterAppIfPrepared();
    return;
  }

  if (event.data === InternalChannels.TaskNotificationSound) {
    void playTaskNotificationSound();
    return;
  }

  if (handleSourceSettingsServicePortMessage(event)) return;

  const remoteWorkspacePort = parseRemoteWorkspaceServicePortMessage(event);
  if (remoteWorkspacePort) {
    if (!baseServicesForRemoteSessions) {
      // During renderer reload, main may restore the remote port before sending the local ServicePort.
      // Do not discard an early remote port; the SSH host may still be alive while the UI enters a
      // disconnected proxy state.
      pendingRemoteWorkspaceServicePorts.push(remoteWorkspacePort);
      return;
    }

    registerRemoteWorkspaceServicePort(remoteWorkspacePort);
    return;
  }

  if (
    event.source !== window ||
    event.data?.type !== InternalChannels.ServicePort ||
    appInitialized
  )
    return;
  const port = event.ports[0];
  if (!port) return;
  databaseStartupAdmission.acceptPort({ databaseStartupId: event.data.databaseStartupId }, port);
  enterAppIfPrepared();
}

function initializeBusinessRoot(port: MessagePort): void {
  appInitialized = true;
  const services = connectViaMessagePort(port, {
    sourceServerManagementService: true,
  });
  baseServicesForRemoteSessions = services;
  registerBaseWorkspaceServices(services);
  flushPendingRemoteWorkspaceServicePorts();
  const settingService = supportsSettings ? services.settingService : undefined;

  syncAppTelemetryContext({
    bridge: {
      syncTelemetryContext: (context) => window.zcode.syncTelemetryContext(context),
    },
    createRendererContext: collectTelemetryRendererContext,
  });

  // Initialize the stable device ID so every hook uses the correct value before the first render.
  setStreamClientId(desktopPlatform.getDeviceId());

  // Exceptions caught by React error boundaries do not bubble to window.onerror, so the RUM Browser SDK
  // does not receive them by default. Inject the reporter before createRoot: the root AppErrorBoundary
  // catches crashes while rendering Root itself, and a reporter installed by a Root effect would miss
  // a crash on the first frame.
  setReactErrorArmsReporter(desktopPlatform);

  appRoot?.render(
    <AppErrorBoundary isDesktop isMacDesktop={isMacDesktop} isWindowsDesktop={isWindowsDesktop}>
      <ZCodeIntlProvider
        settingService={settingService}
        broadcastService={services.broadcastService}
        resolveSystemLocale={desktopPlatform.getSystemLocale}
      >
        <StartupReadyNotifier />
        <Root
          services={services}
          platform={desktopPlatform}
          isDesktop
          assistantCodeCommentCardsEnabled
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
          restoreSession={restoreSession}
          supportsSettings={supportsSettings}
          initialWorkspaceAbsPath={initialWorkspaceAbsPath}
          initialWorkspacePurpose={
            initialWorkspacePurpose === "conversation" ? "conversation" : "project"
          }
          unavailableWorkspacePath={unavailableWorkspacePath}
        />
      </ZCodeIntlProvider>
    </AppErrorBoundary>,
  );
}

window.addEventListener("message", handleServicePortMessage);
if (windowKind !== "update-status") {
  renderDatabaseStartup();
  sendStartupControl({ action: "snapshot" });
}

if (windowKind === "update-status") {
  createRoot(document.getElementById("root")!).render(
    <AppErrorBoundary isDesktop isMacDesktop={isMacDesktop} isWindowsDesktop={isWindowsDesktop}>
      <StartupReadyNotifier />
      <UpdateStatusWindowRoot
        platform={desktopPlatform}
        initialLocale={initialLocale}
        onRequestClose={() => window.close()}
      />
    </AppErrorBoundary>,
  );
}
