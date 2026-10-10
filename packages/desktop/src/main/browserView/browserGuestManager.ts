/* eslint-disable max-lines -- Keep the IAB owner registry, ready/abort lifecycle, and guest CDP state atomic in one state machine; splitting them would reintroduce cross-scope races. */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { webContents, type WebFrameMain } from "electron";
import {
  BROWSER_VIEWPORT_LIMITS,
  DEFAULT_AGENT_BROWSER_VIEWPORT,
  type BrowserClientMode,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserGuestAttachRejectReason,
  type BrowserGuestAttachResult,
  type BrowserDialog,
  type BrowserRecordingAction,
  type BrowserRecordingJob,
  type BrowserRecordingOptions,
  type BrowserResponseMeta,
  type BrowserTabSummary,
  type BrowserUserTabInfo,
  type BrowserViewCloseTabRequest,
  type BrowserViewResidencyReportPayload,
  type BrowserViewResidencyTransitionPayload,
  type BrowserViewRestoredTabShell,
  type BrowserViewportSize,
} from "@zcode/shared";
import { executeBrowserCommandOnView, type ControlledView } from "./browserCommandExecutor.js";
import { executeIabPlaywrightLocator } from "./browserPlaywrightLocatorExecutor.js";
import { recordBrowserVideo, type BrowserWebmRecorderFactory } from "./browserVideoRecorder.js";
import { normalizePlaywrightTimeout } from "./browserPlaywrightTimeout.js";
import type {
  BrowserScreenshotSurfaceCoordinator,
  BrowserScreenshotSurfaceLease,
} from "./browserScreenshotSurfaceCoordinator.js";
import {
  startBrowserScreenshotTransparentWindowBootstrap,
  TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
  type BrowserWindowForTransparentBootstrap,
  type TransparentWindowBootstrap,
} from "./browserTransparentWindowBootstrap.js";
import {
  BrowserTabResidencyCoordinator,
  type BrowserTabResidencyRecord,
} from "./browserTabResidencyCoordinator.js";
import type {
  BrowserTabPageStateRecord,
  BrowserTabRecoveryStore,
  BrowserTabShellRecord,
} from "./browserTabRecoveryStore.js";

interface GuestWebContents {
  readonly id: number;
  readonly hostWebContents?: { getZoomFactor(): number } | null;
  readonly mainFrame: WebFrameMain;
  getType(): string;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  reload(): void;
  stop(): void;
  capturePage(): Promise<{ toPNG(): Buffer }>;
  executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;
  navigationHistory: {
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
    getAllEntries(): Array<{ url: string; title?: string; pageState?: string }>;
    getActiveIndex(): number;
    restore(options: {
      entries: Array<{ url: string; title?: string; pageState?: string }>;
      index: number;
    }): Promise<void>;
  };
  close(options?: { waitForBeforeUnload?: boolean }): void;
  isCurrentlyAudible?(): boolean;
  isBeingCaptured?(): boolean;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    detach(): void;
    sendCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
    on(event: "message", listener: (event: unknown, method: string, params: unknown) => void): void;
    removeListener(
      event: "message",
      listener: (event: unknown, method: string, params: unknown) => void,
    ): void;
  };
  once(event: "destroyed", listener: () => void): void;
  session?: {
    on(
      event: "will-download",
      listener: (event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => void,
    ): void;
    removeListener(
      event: "will-download",
      listener: (event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => void,
    ): void;
  };
}

interface GuestDownloadItem {
  getSavePath(): string;
  once(event: "done", listener: (event: unknown, state: string) => void): void;
}

export interface BrowserGuestExecutionContext {
  requestId: string;
  browserId: string;
  browserGeneration: number;
  windowId: number;
  workspaceKey: string;
  sessionId: string;
  turnId?: string;
  remoteSessionId?: string;
  clientMode: BrowserClientMode;
}

interface InternalExecutionContext extends BrowserGuestExecutionContext {
  legacy?: boolean;
}

type TabLifecycle = "active" | "deliverable" | "handoff" | "closed";
type GuestBindingLifecycle = "detached" | "attached" | "detaching" | "destroyed";
type GuestRecoveryReason = BrowserGuestAttachRejectReason | "guest-destroyed" | "attach-timeout";

const TAB_CONTEXT_RECOVERY_HINT =
  "This is pre-action stale-binding recovery, not post-action popup observation. " +
  "Keep the existing browser binding; call browser.tabs.list(), then browser.tabs.get(info.id). " +
  "If the controlled list is empty, inspect browser.user.openTabs() and use browser.user.claimTab(info) " +
  "before creating a new tab.";

interface ManagedTab {
  tabId: string;
  owner: InternalExecutionContext;
  guest?: GuestWebContents;
  /** Guest replacement generation used to reject stale guests before command dispatch. */
  guestGeneration: number;
  /** Whether a guest was ever bound successfully; distinguishes a new tab's initial wait from recovery of an existing tab. */
  hasAttachedGuest: boolean;
  attachFailure?: GuestRecoveryReason;
  rebindRequested: boolean;
  cdpAttached: boolean;
  /** Guest's native CDP lifecycle; it must pass through detaching before the DOM is destroyed. */
  guestLifecycle: GuestBindingLifecycle;
  /** Number of unsettled debugger.sendCommand calls; teardown waits for zero or a timeout. */
  pendingCdpCommands: number;
  /** Timer for releasing an idle command stream; reset after each CDP command and cleared by detachGuest. */
  guestCdpIdleTimer?: ReturnType<typeof setTimeout>;
  /** In-flight session-state restoration after re-attach; business commands must await it before dispatch (a serial barrier). */
  guestCdpRestoreFlight?: Promise<void>;
  /** Whether this currently holds the viewport critical section; replay directly after CDP reconnect instead of queueing behind itself. */
  insideViewportMutation?: boolean;
  /** Allow only one replacement teardown per guest; duplicate ACKs share its result. */
  guestTeardownFlight?: Promise<boolean>;
  lifecycle: TabLifecycle;
  origin: "agent" | "user";
  /** A human IAB tab can be discovered by any session before its first operation in the same window/workspace. */
  claimable: boolean;
  /** Restore a claimed user tab as a user tab on finalize/closeSession; do not close it like an agent tab. */
  userOwner?: InternalExecutionContext;
  active: boolean;
  /** Per-tab CSS viewport set by Agent/UI; undefined follows the host's natural size. */
  viewportOverride?: BrowserViewportSize;
  /** Corrects the guest's native raster when Desktop page zoom is above 1; does not change the CSS viewport. */
  desktopZoomFactor?: number;
  /** Scale successfully applied to Chromium; input must not use a target scale still queued for the viewport. */
  appliedViewportScale?: number;
  /** Used only for background execution while the pane is hidden at 0×0; clear it when the pane becomes visible again. */
  backgroundViewportFallback?: BrowserViewportSize;
  /** Serializes transient clears with explicit set/reset operations so the latest user/Agent setting wins. */
  viewportMutation?: Promise<void>;
  downloadCleanup?: () => void;
  activityCleanup?: () => void;
  /**
   * Unregister the debugger's "message" listener. After guest replacement, the old listener should not remain attached:
   * every event would require a lookup and a current.guest !== guest check to discard it, which is a pure leak.
   * This only cleans up the JS layer; debugger.detach() is still required to disconnect the native CDP channel.
   */
  cdpMessageCleanup?: () => void;
  /**
   * Unregister the render-process-gone listener. It proactively disconnects CDP when the guest renderer is killed
   * while its WebContents still exists; this is the only opportunity to prevent api::Debugger from being implicitly destroyed.
   */
  crashGuardCleanup?: () => void;
  loading: boolean;
  mediaActive: boolean;
  cachedUrl: string;
  cachedTitle: string;
  cachedFaviconUrl: string | null;
  openedAt: number;
  restoredFromStore?: boolean;
}

interface PendingWaiter {
  resolve: (guest: GuestWebContents | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface RunningRequest {
  context: InternalExecutionContext;
  controller: AbortController;
  dispatched: boolean;
  tabId?: string;
}

interface InFlightScreenshot {
  execution: Promise<BrowserCommandResult>;
  requestId: string;
  startedAt: number;
}

interface BrowserRecordingEntry {
  id: string;
  context: InternalExecutionContext;
  tabId: string;
  controller: AbortController;
  status: BrowserRecordingJob["status"];
  phase: BrowserRecordingJob["phase"];
  progress: number;
  startedAt: number;
  updatedAt: number;
  artifact?: BrowserRecordingJob["artifact"];
  error?: string;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

interface DownloadRecord {
  tabId: string;
  path: string | null;
  state: "pending" | "completed" | "cancelled" | "interrupted";
}

interface DownloadWaiter {
  resolve: (downloadId: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
}

const DEFAULT_ATTACH_TIMEOUT_MS = 10_000;
// Hard limit for a full capture once the transparent presentation is ready; normally it should finish within a few hundred ms.
const HIDDEN_WINDOW_CAPTURE_DEADLINE_MS = 5_000;
// Hard limit for captures on one tab whose callers stopped waiting while the underlying CDP capture is still unsettled.
// CDP screenshots have no per-request cancellation API, so retries leave pending commands in Chromium. If the compositor
// remains unavailable, an unlimited number would accumulate (they drain together when frames resume, but
// pendingCdpCommands would not reach zero and detach would time out). Once the limit is reached, screenshots on that tab
// fail quickly with a prompt to reopen it; a slot is reclaimed when the old capture actually settles.
const MAX_ABANDONED_SCREENSHOT_CAPTURES = 3;
/** Maximum time teardown waits for in-flight CDP commands to settle; native detach is still attempted on timeout. */
const DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS = 1_000;
// Idle-release threshold for the CDP command stream: covers the observed crash window (0.4–9s gaps within a turn)
// without interrupting dense agent operation streams (command gaps are usually much shorter).
const DEFAULT_GUEST_CDP_IDLE_RELEASE_MS = 1_500;
const RECORDING_RESULT_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_BACKGROUND_BROWSER_VIEWPORT: BrowserViewportSize = {
  width: 800,
  height: 600,
};

type BrowserTabRecoveryStorePort = Pick<
  BrowserTabRecoveryStore,
  "upsert" | "upsertPageState" | "getPageState" | "removePageState" | "remove" | "listShells"
> &
  Partial<Pick<BrowserTabRecoveryStore, "whenIdle">>;

interface BrowserGuestManagerResidencyOptions {
  tabLimit?: number;
  suspendAckTimeoutMs?: number;
  now?: () => number;
  recoveryStore?: BrowserTabRecoveryStorePort;
  onSuspendTabRequested?(payload: BrowserViewResidencyTransitionPayload): void;
  onRestoreTabRequested?(payload: BrowserViewResidencyTransitionPayload): void;
  onResidencyChanged?(payload: BrowserViewResidencyTransitionPayload): void;
  onRecoveryOrphanCloseRequested?(payload: { tabId: string; reason: "recovery-orphan" }): void;
  warn?(message: string): void;
  recording?: {
    tempRoot?: string;
    createRecorder?: BrowserWebmRecorderFactory;
    now?: () => number;
  };
}
function normalizeDesktopZoomMetricsScale(desktopZoomFactor: number | undefined): number {
  return Number.isFinite(desktopZoomFactor) && (desktopZoomFactor ?? 1) > 1
    ? (desktopZoomFactor ?? 1)
    : 1;
}

function buildViewportMetricsOverride(
  viewport: BrowserViewportSize,
  desktopZoomFactor?: number,
): Record<string, unknown> {
  const metricsScale = normalizeDesktopZoomMetricsScale(desktopZoomFactor);
  return {
    width: viewport.width,
    height: viewport.height,
    // By default, CDP lets page metrics with DPR=1 also control visible size, allocating only a 1x native surface on
    // Retina displays. The DOM bounds remain correct, but the page covers only the frame's upper-left corner. Keep the
    // visible surface managed by the Electron <webview>'s actual bounds; CDP only controls the CSS viewport and screenshot DPR.
    deviceScaleFactor: 1,
    mobile: false,
    dontSetVisibleSize: true,
    // When Desktop page zoom is above 1, a screenshot of the Electron guest target already contains only 1 / zoom of the
    // frame; an outer CSS transform cannot restore the native raster. Use CDP scale to correct the visible surface only
    // when zoomed in. Keep the default 1 when zoomed out to avoid shrinking the content again.
    ...(metricsScale > 1 ? { scale: metricsScale } : {}),
  };
}

function scopeKey(context: InternalExecutionContext): string {
  if (context.legacy) return "legacy";
  return [
    context.browserId,
    String(context.browserGeneration),
    String(context.windowId),
    context.workspaceKey,
    context.remoteSessionId ?? "",
    context.sessionId,
    context.clientMode,
  ].join("\u0000");
}

function sameScope(left: InternalExecutionContext, right: InternalExecutionContext): boolean {
  return (left.legacy === true && right.legacy === true) || scopeKey(left) === scopeKey(right);
}

function normalizeLegacyContext(defaultKey: string): InternalExecutionContext {
  return {
    requestId: `legacy:${randomUUID()}`,
    browserId: "legacy-iab",
    browserGeneration: 0,
    windowId: 0,
    workspaceKey: defaultKey,
    sessionId: defaultKey,
    clientMode: "desktop-continuous",
    legacy: true,
  };
}

function suspendAckKey(tabId: string, generation: number): string {
  return `${tabId}\u0000${generation}`;
}

function toRestoredShell(
  record: BrowserTabShellRecord,
  owner: InternalExecutionContext,
): BrowserViewRestoredTabShell {
  return {
    tabId: record.tabId,
    workspaceKey: record.workspaceKey,
    ...(record.remoteSessionId ? { remoteSessionId: record.remoteSessionId } : {}),
    sessionId: record.sessionId,
    browserId: owner.browserId,
    browserGeneration: owner.browserGeneration,
    origin: record.origin,
    restoreUrl: record.restoreUrl,
    title: record.title,
    faviconUrl: record.faviconUrl,
    openedAt: record.openedAt,
    lastSelectedAt: record.lastSelectedAt,
  };
}

function isSideEffecting(command: BrowserCommand): boolean {
  if (command.method === "playwright" && command.action.name === "locator") {
    return [
      "click",
      "dblclick",
      "downloadMedia",
      "fill",
      "press",
      "selectOption",
      "setChecked",
    ].includes(command.action.operation);
  }
  if (command.method === "playwright" && command.action.name === "evaluate") return true;
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "cuaKeypress",
    "scroll",
    "cuaScroll",
    "domCuaScroll",
    "hover",
    "select",
    "check",
    "drag",
    "cuaDrag",
    "recordingStart",
    "recordingCancel",
    "handleDialog",
    "close",
    "evaluate",
    "finalize",
    "finalizeTabs",
    "claimTab",
    "activateTab",
    "markDeliverable",
    "markHandoff",
    "newTab",
  ].includes(command.method);
}

/**
 * IAB guest registry. Production paths are strictly isolated by BrowserGuestExecutionContext; string arguments remain
 * only for compatibility with old renderers/tests and must not be used by new callers.
 */
function safeNumber(read: () => number | undefined): number | undefined {
  try {
    const value = read();
    return typeof value === "number" ? value : undefined;
  } catch {
    // Accessing id throws after the guest is destroyed; the resource manager can simply skip this tab.
    return undefined;
  }
}

export class BrowserGuestManager {
  private readonly tabs = new Map<string, ManagedTab>();

  /** Resource manager: IDs of currently live browser guest webContents, used to associate their renderers with the built-in browser-use plugin. */
  listGuestWebContentsIds(): number[] {
    const ids: number[] = [];
    for (const tab of this.tabs.values()) {
      if (tab.lifecycle === "closed" || !tab.guest) continue;
      const id = safeNumber(() => tab.guest?.id);
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }
  /** After close, retain only an opaque ID tombstone to reject late renderer attaches; do not retain the owner/guest. */
  private readonly closedTabIds = new Set<string>();
  private readonly activeTabByScope = new Map<string, string>();
  private readonly defaultTabByScope = new Map<string, string>();
  private readonly waiters = new Map<string, PendingWaiter[]>();
  private readonly pendingDialogs = new Map<string, BrowserDialog>();
  private readonly runningRequests = new Map<string, RunningRequest>();
  /**
   * CDP Page.captureScreenshot has no per-request cancellation API. After an outer timeout/cancel, the promise may still
   * be running in Chromium. Settle the request immediately on abort/deadline and release the barrier so the same tab can
   * retry at once. Any overlap is transient and self-draining: the next screenshot's transparent presentation resumes
   * frame production, allowing the old capture to settle. Each result stays on its own promise chain, so late results
   * cannot attach to a new request (clearTrackedScreenshot is idempotent by entry identity). The old approach of holding
   * the barrier until actual settlement could deadlock screenshots on a tab when a capture never settled (production
   * observations showed pendingMs above 120s); it has been removed. A hard limit on abandonedScreenshotCaptures bounds accumulation.
   */
  private readonly inFlightScreenshots = new Map<string, InFlightScreenshot>();
  /** See MAX_ABANDONED_SCREENSHOT_CAPTURES; keyed by tabId. */
  private readonly abandonedScreenshotCaptures = new Map<string, number>();
  private readonly recordings = new Map<string, BrowserRecordingEntry>();
  private readonly downloads = new Map<string, DownloadRecord>();
  private readonly queuedDownloads = new Map<string, string[]>();
  private readonly downloadWaiters = new Map<string, DownloadWaiter[]>();
  private readonly sessionNames = new Map<string, string>();
  private readonly visibilityByScope = new Map<string, boolean>();
  private readonly naturalViewportByWindow = new Map<number, BrowserViewportSize>();
  private readonly residencyCoordinator: BrowserTabResidencyCoordinator;
  private readonly suspendAckWaiters = new Map<string, () => void>();
  private readonly suspendFlights = new Map<string, Promise<void>>();
  private readonly restoreFlights = new Map<string, Promise<GuestWebContents | null>>();
  /** When rebinding after a guest is destroyed, the replacement must restore the original page before receiving browser commands. */
  private readonly guestRecoveryFlights = new Map<string, Promise<GuestWebContents | null>>();
  /** Allow only one attach/rebind flight per tab to prevent concurrent commands from rebuilding the webview independently. */
  private readonly guestAttachFlights = new Map<string, Promise<GuestWebContents | null>>();
  private readonly restoredTabClaims = new Map<string, number>();

  constructor(
    private readonly log?: (msg: string) => void,
    private readonly attachTimeoutMs: number = DEFAULT_ATTACH_TIMEOUT_MS,
    private readonly onCloseTabRequested?: (
      tabId: string,
      owner?: BrowserGuestExecutionContext,
    ) => void,
    private readonly onOpenTabRequested?: (
      tabId: string,
      owner: BrowserGuestExecutionContext,
    ) => void,
    private readonly onVisibilityChanged?: (
      visible: boolean,
      owner: BrowserGuestExecutionContext,
      tabId?: string,
    ) => void,
    private readonly onViewportChanged?: (
      viewport: BrowserViewportSize | null,
      owner: BrowserGuestExecutionContext,
      tabId: string,
    ) => void,
    // The seventh position is already used for screenshot CSS-pixel normalization; append new gate dependencies to preserve existing main/test calls.
    private readonly resizeScreenshotToCssPixels?: ControlledView["resizeScreenshotToCssPixels"],
    private readonly screenshotSurfaceCoordinator?: BrowserScreenshotSurfaceCoordinator,
    private readonly residencyOptions: BrowserGuestManagerResidencyOptions = {},
    // Transparent presentation for screenshots in a hidden window depends on the owner BrowserWindow. Tests inject a stub;
    // production gets BrowserWindow.fromId from index.ts. If it is not injected, disable this capability entirely to match prior behavior.
    private readonly resolveOwnerWindow?: (
      windowId: number,
    ) => BrowserWindowForTransparentBootstrap | null,
    // How long the CDP command stream may remain idle before proactive release (detach). If Chromium kills the guest
    // renderer without delivering render-process-gone to main, destroyed can arrive while CDP is attached and cause a
    // main-process UAF. The observed crash window is the 0.4–9s gap between commands in a turn; command-level idle release narrows it.
    private readonly cdpIdleReleaseMs: number = DEFAULT_GUEST_CDP_IDLE_RELEASE_MS,
  ) {
    this.residencyCoordinator = new BrowserTabResidencyCoordinator({
      tabLimit: residencyOptions.tabLimit,
      now: residencyOptions.now,
      onEvict: (record) => this.closeTabForLimit(record),
    });
  }

  attachGuest(
    tabId: string,
    webContentsId: number,
    options?: {
      active?: boolean;
      windowId?: number;
      workspaceKey?: string;
      remoteSessionId?: string;
      sessionId?: string;
      residencyGeneration?: number;
    },
  ): BrowserGuestAttachResult {
    let tab = this.tabs.get(tabId);
    const guest = webContents.fromId(webContentsId) as GuestWebContents | undefined;
    if (!guest || guest.isDestroyed()) {
      const recoveryRequested =
        tab && tab.lifecycle !== "closed"
          ? this.requestGuestRebind(tab, guest ? "destroyed" : "not-found")
          : false;
      this.log?.(
        `[browser-use] attachGuest skip tabId=${tabId} id=${webContentsId} reason=${guest ? "destroyed" : "not-found"}`,
      );
      return {
        ok: false,
        reason: guest ? "destroyed" : "not-found",
        recoveryRequested,
      };
    }
    if (guest.getType() !== "webview") {
      // fromId accepts any WebContents ID in the process. If a renderer passes the main-window ID by mistake, later
      // CDP/Runtime input would operate the ZCode composer directly. IAB accepts only real <webview> guests and fails closed.
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} id=${webContentsId} reason=not-webview type=${guest.getType()}`,
      );
      return { ok: false, reason: "not-webview", recoveryRequested: false };
    }

    if (this.closedTabIds.has(tabId)) {
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`);
      return { ok: false, reason: "closed", recoveryRequested: false };
    }
    // Compatibility for old renderers: keys without a create request enter only the legacy scope.
    if (!tab) {
      const owner = options?.workspaceKey
        ? {
            requestId: `unclaimed:${randomUUID()}`,
            browserId: "unclaimed-iab",
            browserGeneration: 0,
            windowId: options.windowId ?? 0,
            workspaceKey: options.workspaceKey,
            // Human tabs used to be globally unclaimed by workspace, so any new conversation could enumerate and claim
            // them through user.openTabs(). ownerTaskId is now frozen at attach; if an old renderer omits sessionId,
            // retain an unclaimable sentinel. Hiding the tab is preferable to leaking it across conversations.
            sessionId: options.sessionId?.trim() || "unscoped",
            ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
            clientMode: "desktop-continuous" as const,
          }
        : normalizeLegacyContext(tabId);
      if (options?.windowId !== undefined) owner.windowId = options.windowId;
      tab = {
        tabId,
        owner,
        cdpAttached: false,
        guestLifecycle: "detached",
        pendingCdpCommands: 0,
        guestGeneration: 0,
        hasAttachedGuest: false,
        rebindRequested: false,
        lifecycle: "active",
        origin: options?.workspaceKey ? "user" : "agent",
        claimable: Boolean(options?.workspaceKey && options.sessionId?.trim()),
        ...(options?.workspaceKey ? { userOwner: { ...owner } } : {}),
        active: false,
        loading: false,
        mediaActive: false,
        cachedUrl: "",
        cachedTitle: "",
        cachedFaviconUrl: null,
        openedAt: this.now(),
      };
      this.tabs.set(tabId, tab);
      this.registerTabResidency(tab, options?.active === true);
    }
    if (tab.lifecycle === "closed") {
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`);
      return { ok: false, reason: "closed", recoveryRequested: false };
    }
    if (options?.windowId !== undefined && tab.owner.windowId !== options.windowId) {
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=window-mismatch expected=${tab.owner.windowId} actual=${options.windowId}`,
      );
      return { ok: false, reason: "window-mismatch", recoveryRequested: false };
    }
    if (options?.workspaceKey && tab.owner.workspaceKey !== options.workspaceKey) {
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=workspace-mismatch`);
      return this.rejectGuestAttach(tab, guest, "workspace-mismatch");
    }
    if (options?.sessionId && tab.owner.sessionId !== options.sessionId) {
      // A late renderer dom-ready must not reuse an existing tabId under another conversation's ownership.
      // Reject it even when the window/workspace match, preventing a guest replacement across conversations from bypassing openTabs isolation.
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=session-mismatch`);
      return this.rejectGuestAttach(tab, guest, "session-mismatch");
    }
    if ((tab.owner.remoteSessionId ?? "") !== (options?.remoteSessionId ?? "")) {
      // Remote ownership used to be checked only when the renderer supplied remoteSessionId, so a missing value failed open;
      // an old tab could then be attached by a new runtime after remote reconnection.
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=remote-session-mismatch`,
      );
      return this.rejectGuestAttach(tab, guest, "remote-session-mismatch");
    }

    const residency = this.residencyCoordinator.get(tabId);
    const rejectsNewGuest =
      tab.guest !== guest &&
      (residency?.residency === "suspended" || residency?.residency === "suspend-pending");
    if (rejectsNewGuest) {
      // After a restore timeout rolled back, a late guest from an old generation could still bypass the restoring check
      // and reclaim the tab. suspended/pending accepts repeated reports only from the current old guest, never a new attach.
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=residency-${residency.residency}`,
      );
      this.closeGuestWebContents(tab, guest);
      return {
        ok: false,
        reason: "residency-suspended",
        recoveryRequested: false,
      };
    }
    if (
      residency?.residency === "restoring" &&
      !this.residencyCoordinator.markAttached(
        tabId,
        options?.active === true,
        options?.residencyGeneration,
      )
    ) {
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=residency-generation-mismatch expected=${residency.generation} actual=${options?.residencyGeneration ?? "missing"}`,
      );
      this.closeGuestWebContents(tab, guest);
      return {
        ok: false,
        reason: "residency-generation-mismatch",
        recoveryRequested: false,
      };
    }
    const isSameGuest = tab.guest === guest;
    if (residency?.residency === "restoring") {
      // During restore, src uses a deferred protocol that does not commit a document. After scope/generation validation,
      // terminate the provisional request so restoreGuestState creates the only initial valid navigation.
      try {
        guest.stop();
      } catch (error) {
        this.warn(`browser tab provisional navigation stop failed tabId=${tabId}`, error);
      }
    }
    if (tab.guest && !isSameGuest) this.detachGuest(tab);
    if (!isSameGuest) this.guestRecoveryFlights.delete(tab.tabId);

    // detachGuest reads the last URL from the still-live old guest. Make the restore decision after it, so navigation
    // that just occurred is not mistaken for having no recoverable state before the renderer reports residency.
    const rebindReason = tab.attachFailure;
    const shouldRestoreAfterRebind =
      tab.hasAttachedGuest &&
      !isSameGuest &&
      rebindReason !== undefined &&
      rebindReason !== "residency-suspended" &&
      rebindReason !== "residency-generation-mismatch" &&
      tab.cachedUrl.trim() !== "" &&
      tab.cachedUrl !== "about:blank";

    let cdpAttached = false;
    try {
      if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
      cdpAttached = guest.debugger.isAttached();
    } catch {
      cdpAttached = safeBool(() => guest.debugger.isAttached(), false);
    }
    tab.guest = guest;
    tab.cdpAttached = cdpAttached;
    tab.guestLifecycle = "attached";
    tab.guestTeardownFlight = undefined;
    if (!isSameGuest) tab.guestGeneration += 1;
    tab.hasAttachedGuest = true;
    tab.attachFailure = undefined;
    tab.rebindRequested = false;
    if (cdpAttached) this.scheduleGuestCdpIdleRelease(tab);
    // A new guest starts at about:blank during restore. Overwriting the logical cache before consuming pageState/restoreUrl
    // could make a corrupt snapshot fall back to a blank page and prevent detection of an orphan missing all three facts.
    if (residency?.residency !== "restoring" && !shouldRestoreAfterRebind) {
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    }
    if (options?.active === true) {
      tab.active = true;
      if (!tab.claimable) this.selectTab(tab, false);
      this.restoreNaturalViewportAfterBackground(tab);
    } else if (options?.active === false) {
      tab.active = false;
      this.residencyCoordinator.report(tab.tabId, {
        selected: false,
        visible: false,
      });
      if (this.activeTabByScope.get(scopeKey(tab.owner)) === tabId) {
        this.activeTabByScope.delete(scopeKey(tab.owner));
      }
    }
    this.log?.(
      `[browser-use] attachGuest tabId=${tabId} windowId=${tab.owner.windowId} cdp=${cdpAttached}`,
    );

    guest.once("destroyed", () => {
      const current = this.tabs.get(tabId);
      if (current?.guest === guest) {
        this.detachGuest(current);
        this.requestGuestRebind(current, "guest-destroyed");
      }
    });
    // Install this before other listeners: later setup may synchronously throw for a destroyed guest and skip remaining
    // listeners. This is the only listener that closes the UAF window, so unrelated setup must not prevent it.
    if (!isSameGuest) this.setupCdpCrashGuard(tab, guest);
    if (!isSameGuest) this.setupDialogTracking(tab, guest);
    if (!isSameGuest) this.setupDownloadTracking(tab, guest);
    if (!isSameGuest) this.setupActivityTracking(tab, guest);
    if (!isSameGuest) this.applyViewportOverride(tab);
    if (tab.viewportOverride) {
      // The Agent may emit a viewport event before the renderer finishes opening automatically. Replay it after guest attach
      // so a newly mounted free-size UI does not miss the one-time main → renderer synchronization.
      this.onViewportChanged?.({ ...tab.viewportOverride }, tab.owner, tab.tabId);
    }
    if (options?.active !== false && this.visibilityByScope.get(scopeKey(tab.owner)) === true) {
      // visibilityByScope describes visibility of the entire browser scope, not whether this attached tab is selected.
      // Replaying visible=true for an inactive guest would reactivate an old tab after the user switches away; a late event
      // after close could also revive its tab shell. Only non-inactive attaches inherit scope visibility. Explicit selection
      // is still reported by selectTab/browserVisibilitySet.
      this.onVisibilityChanged?.(true, tab.owner, tab.tabId);
    }
    if (shouldRestoreAfterRebind) {
      // When replaying Ready after guest-destroyed, the new guest starts at about:blank. Marking it usable directly would
      // leave the right pane blank because the renderer would not consume the already-applied initialUrl again. Reuse the
      // existing pageState → restoreUrl recovery logic and serialize later commands behind a tab-level flight.
      const recoveryFlight = this.restoreReboundGuest(tab, guest);
      this.guestRecoveryFlights.set(tab.tabId, recoveryFlight);
      const clearRecoveryFlight = () => {
        if (this.guestRecoveryFlights.get(tab.tabId) === recoveryFlight) {
          this.guestRecoveryFlights.delete(tab.tabId);
        }
      };
      void recoveryFlight.then(clearRecoveryFlight, clearRecoveryFlight);
    }
    this.resolveWaiters(tabId, guest);
    if (residency?.residency !== "restoring") {
      this.residencyCoordinator.markAttached(tabId, options?.active === true);
    }
    void this.persistShell(tab);
    return { ok: true, guestGeneration: tab.guestGeneration };
  }

  /** Renderer free-size interaction update; IPC binds the sender window so it cannot modify tabs in another window. */
  async updateViewportFromRenderer(
    tabId: string,
    viewport: BrowserViewportSize | null,
    windowId: number,
    desktopZoomFactor = 1,
  ): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.lifecycle === "closed" || tab.owner.windowId !== windowId) {
      throw new Error(`browser tab '${tabId}' is unavailable for viewport update`);
    }
    if (viewport) {
      assertViewportOverride(viewport);
      tab.desktopZoomFactor = normalizeDesktopZoomMetricsScale(desktopZoomFactor);
      await this.setTabViewport(tab, viewport);
      return;
    }
    await this.resetTabViewport(tab);
  }

  getTabOwner(tabId: string): BrowserGuestExecutionContext | null {
    const owner = this.tabs.get(tabId)?.owner;
    return owner ? { ...owner } : null;
  }

  /** Look up the controlled tab by guest WebContents to preserve its original session scope for webview popup events. */
  getTabOwnerByWebContentsId(
    webContentsId: number,
  ): (BrowserGuestExecutionContext & { tabId: string }) | null {
    for (const tab of this.tabs.values()) {
      if (tab.guest?.id === webContentsId && tab.lifecycle !== "closed") {
        return { ...tab.owner, tabId: tab.tabId };
      }
    }
    return null;
  }

  async reportResidency(
    payload: BrowserViewResidencyReportPayload & { windowId: number },
  ): Promise<void> {
    const tab = this.requireRendererOwnedTab(payload);
    tab.cachedUrl = payload.restoreUrl?.trim() || tab.cachedUrl;
    if (payload.title !== undefined) tab.cachedTitle = payload.title ?? "";
    if (payload.faviconUrl !== undefined) tab.cachedFaviconUrl = payload.faviconUrl;
    tab.loading = payload.loading;
    this.residencyCoordinator.report(tab.tabId, {
      selected: payload.selected,
      visible: payload.visible,
      currentTask: payload.currentTask,
      loading: payload.loading,
      audible: safeBool(() => tab.guest?.isCurrentlyAudible?.() ?? false, false),
      mediaActive: tab.mediaActive,
      operationActive: this.hasRunningRequestForTab(tab.tabId),
      captureActive: this.isTabCaptureActive(tab),
      downloadActive: this.hasPendingDownloadForTab(tab.tabId),
    });
    if (payload.selected) {
      tab.active = true;
      if (!tab.claimable) this.selectTab(tab, false);
      // A renderer foreground report reflects what the user is actually viewing (pane expanded/tab selected). It is
      // independent of claimable and must trigger recovery separately from selectTab.
      this.maybeRestoreBackgroundViewport(tab);
    } else {
      tab.active = false;
      const key = scopeKey(tab.owner);
      if (this.activeTabByScope.get(key) === tab.tabId) this.activeTabByScope.delete(key);
    }
    await this.persistShell(tab);
    await this.residencyCoordinator.whenIdle();
  }

  acknowledgeSuspend(payload: { tabId: string; generation: number; windowId: number }): void {
    const tab = this.tabs.get(payload.tabId);
    if (!tab || tab.owner.windowId !== payload.windowId) return;
    const key = suspendAckKey(payload.tabId, payload.generation);
    this.suspendAckWaiters.get(key)?.();
  }

  async closeTabFromRenderer(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> {
    // Agent close already removed the logical tab from main, but the BrowserViewCloseTab notification may have been
    // discarded by a renderer outside the active workspace, leaving a shell in the UI. If the user clicks × here, throwing
    // "unavailable for renderer scope" would leave the renderer without authorization to remove it, making the tab impossible
    // to close. Since main no longer has this logical tab, it is safe and necessary to let the renderer converge its shell:
    // allow the operation idempotently and add a tombstone to block late attaches. Scope checks still apply to live tabs;
    // unauthorized closes across windows/workspaces remain rejected.
    const existing = this.tabs.get(payload.tabId);
    if (!existing || existing.lifecycle === "closed") {
      this.closedTabIds.add(payload.tabId);
      return;
    }
    // Close is a convergence operation: remoteSessionId's reconnect protection applies only to attach (see
    // attachGuest's remote-session-mismatch). The attach renderer has workspaceRemoteSessionId as a fallback for this
    // field; close does not. Strict comparison would make remote human tabs impossible to close. Closing a tab visible to
    // the renderer is not an escalation; window/workspace/session are still checked strictly, and cross-scope closes remain rejected.
    const tab = this.requireRendererOwnedTab(payload, { skipRemoteSession: true });
    await this.closeTabDurably(tab, false);
  }

  async whenRecoveryIdle(): Promise<void> {
    await this.residencyOptions.recoveryStore?.whenIdle?.();
  }

  async ensureResidentFromRenderer(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> {
    const tab = this.requireRendererOwnedTab(payload);
    const guest = await this.ensureGuest(tab, new AbortController().signal);
    if (!guest) throw new Error(`browser tab '${tab.tabId}' restore failed`);
  }

  async restoreTabs(payload: {
    windowId: number;
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId?: string;
  }): Promise<BrowserViewRestoredTabShell[]> {
    const records =
      (await this.residencyOptions.recoveryStore?.listShells({
        workspaceKey: payload.workspaceKey,
        ...(payload.remoteSessionId ? { remoteSessionId: payload.remoteSessionId } : {}),
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      })) ?? [];
    this.log?.(
      `[browser-use] restoreTabs windowId=${payload.windowId} workspaceKey=${payload.workspaceKey} remoteSessionId=${payload.remoteSessionId ?? "<local>"} sessionId=${payload.sessionId ?? "<all>"} records=${records.length}`,
    );
    const restored: BrowserViewRestoredTabShell[] = [];
    for (const record of records) {
      if (this.closedTabIds.has(record.tabId)) continue;
      const claimedWindowId = this.restoredTabClaims.get(record.tabId);
      if (claimedWindowId !== undefined && claimedWindowId !== payload.windowId) continue;
      this.restoredTabClaims.set(record.tabId, payload.windowId);

      let tab = this.tabs.get(record.tabId);
      if (!tab) {
        const owner: InternalExecutionContext = {
          requestId: `restore:${randomUUID()}`,
          browserId:
            record.browserId ?? (record.origin === "user" ? "unclaimed-iab" : "restored-iab"),
          browserGeneration: record.browserGeneration ?? 0,
          windowId: payload.windowId,
          workspaceKey: record.workspaceKey,
          ...(record.remoteSessionId ? { remoteSessionId: record.remoteSessionId } : {}),
          sessionId: record.sessionId,
          clientMode: "desktop-continuous",
        };
        tab = {
          tabId: record.tabId,
          owner,
          cdpAttached: false,
          guestLifecycle: "detached",
          pendingCdpCommands: 0,
          guestGeneration: 0,
          hasAttachedGuest: false,
          rebindRequested: false,
          lifecycle: record.lifecycle,
          origin: record.origin,
          claimable: record.origin === "user",
          ...(record.origin === "user" ? { userOwner: { ...owner } } : {}),
          active: false,
          ...(record.viewport ? { viewportOverride: { ...record.viewport } } : {}),
          loading: false,
          mediaActive: false,
          cachedUrl: record.restoreUrl ?? "",
          cachedTitle: record.title ?? "",
          cachedFaviconUrl: record.faviconUrl,
          openedAt: record.openedAt,
          restoredFromStore: true,
        };
        this.tabs.set(record.tabId, tab);
        this.registerTabResidency(tab, false, "suspended", record.lastSelectedAt);
      } else if (tab.owner.windowId !== payload.windowId) {
        continue;
      }
      restored.push(toRestoredShell(record, tab.owner));
    }
    return restored;
  }

  async execute(
    contextOrKey: BrowserGuestExecutionContext | string,
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    const context =
      typeof contextOrKey === "string" ? normalizeLegacyContext(contextOrKey) : contextOrKey;
    this.log?.(
      `[browser-use] execute requestId=${context.requestId} browserId=${context.browserId} generation=${context.browserGeneration} windowId=${context.windowId} sessionId=${context.sessionId} method=${command.method}`,
    );

    if (this.runningRequests.has(context.requestId)) {
      // requestId is the correlation key for cancellation and lifecycle cleanup. Reusing a key could cancel the wrong
      // scope, and the old finally block could delete a newer entry that is still running. Reject duplicates before dispatch.
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "duplicate_request_id",
            message: `browser requestId '${context.requestId}' is already running`,
            sideEffect: "none",
          },
          elapsedMs: 0,
        },
        context,
      );
    }

    if (command.method === "cancelRequest") {
      const cancelled = this.abortRequest(command.requestId, context);
      return this.withMeta({ ok: true, value: { cancelled }, elapsedMs: 0 }, context);
    }
    if (command.method === "turnEnded") {
      this.endTurn(context, command.turnId ?? context.turnId);
      return this.withMeta({ ok: true, elapsedMs: 0 }, context);
    }
    if (command.method === "closeSession") {
      this.closeSession(context);
      return this.withMeta({ ok: true, elapsedMs: 0 }, context);
    }

    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    const running: RunningRequest = { context, controller, dispatched: false };
    this.runningRequests.set(context.requestId, running);
    try {
      return await this.executeInScope(context, command, running);
    } finally {
      unlink();
      // Cleanup must be tied to entry identity so an old request cannot delete newer state even if another entry point later reuses the key.
      if (this.runningRequests.get(context.requestId) === running) {
        this.runningRequests.delete(context.requestId);
      }
      if (running.tabId) this.refreshRuntimeProtection(running.tabId);
    }
  }

  private async executeInScope(
    context: InternalExecutionContext,
    command: BrowserCommand,
    running: RunningRequest,
  ): Promise<BrowserCommandResult> {
    const startedAt = Date.now();
    if (running.controller.signal.aborted) {
      return this.cancelledResult(context, false, startedAt);
    }

    if (command.method === "list") {
      const tabs = await Promise.all(this.ownedTabs(context).map((tab) => this.summary(tab)));
      return this.withMeta({ ok: true, tabs, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "listUserTabs") {
      const userTabs = this.openUserTabs(context).map((tab) => this.userTabInfo(tab));
      return this.withMeta({ ok: true, userTabs, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "nameSession") {
      this.sessionNames.set(scopeKey(context), command.name);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "browserVisibilityGet") {
      return this.withMeta(
        {
          ok: true,
          value: this.visibilityByScope.get(scopeKey(context)) === true,
          elapsedMs: Date.now() - startedAt,
        },
        context,
      );
    }

    if (command.method === "browserVisibilitySet") {
      const key = scopeKey(context);
      this.visibilityByScope.set(key, command.visible);
      const active = this.activeTabByScope.get(key);
      const selected = active ? this.tabs.get(active) : this.ownedTabs(context).at(-1);
      this.onVisibilityChanged?.(command.visible, context, selected?.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, selected);
    }

    if (command.method === "browserViewportSet") {
      const tab = this.resolveTab(context, command.tabId);
      if (!tab) return this.unavailableTabResult(context, command.tabId, startedAt);
      const viewport = { width: command.width, height: command.height };
      await this.setTabViewport(tab, viewport);
      this.selectTab(tab, true);
      this.onViewportChanged?.(viewport, tab.owner, tab.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }

    if (command.method === "browserViewportReset") {
      const tab = this.resolveTab(context, command.tabId);
      if (!tab) return this.unavailableTabResult(context, command.tabId, startedAt);
      await this.resetTabViewport(tab);
      this.onViewportChanged?.(null, tab.owner, tab.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }

    if (command.method === "recordingStatus" || command.method === "recordingCancel") {
      const entry = this.recordings.get(command.recordingId);
      if (!entry || !sameScope(entry.context, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser recording '${command.recordingId}' is unavailable in this context`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      if ("tabId" in command && command.tabId && command.tabId !== entry.tabId) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser recording '${command.recordingId}' does not belong to tab '${command.tabId}'`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      if (command.method === "recordingCancel" && entry.status === "running") {
        entry.controller.abort(new DOMException("recording cancelled", "AbortError"));
        this.setRecordingTerminal(entry, "cancelled");
      }
      return this.withMeta(
        {
          ok: true,
          recording: this.snapshotRecording(entry),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        this.tabs.get(entry.tabId),
      );
    }

    if (command.method === "activateTab") {
      const tab = this.tabs.get(command.tabId);
      if (!tab || tab.lifecycle === "closed" || !sameScope(tab.owner, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser tab '${command.tabId}' is unavailable for activation. ${TAB_CONTEXT_RECOVERY_HINT}`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      running.tabId = tab.tabId;
      this.refreshRuntimeProtection(tab.tabId);
      const guest = await this.ensureGuest(tab, running.controller.signal);
      if (!guest || safeBool(() => guest.isDestroyed(), true)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser tab '${command.tabId}' could not be restored for activation`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      // The old tabs.get created a Tab binding only inside the agent, while the renderer could still show another page.
      // Activation must atomically update main's selected state before notifying the origin renderer. The renderer expands
      // the view only when that scope is foreground; a background conversation may record activation but cannot steal the user's current session.
      this.selectTab(tab, true);
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "claimTab") {
      const candidate = this.tabs.get(command.tabId);
      if (!candidate || !this.canClaimUserTab(candidate, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `user browser tab '${command.tabId}' is unavailable or already claimed`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      const tab = this.claimTab(candidate, context);
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "finalizeTabs") {
      const keep = new Map(command.keep.map((item) => [item.tabId, item.status]));
      const unknown = [...keep.keys()].filter(
        (tabId) => !this.ownedTabs(context).some((tab) => tab.tabId === tabId),
      );
      if (unknown.length > 0) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `cannot finalize unknown tab(s): ${unknown.join(", ")}`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      this.finalizeTabs(context, keep);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context);
    }

    if (command.method === "newTab") {
      const tab = this.createTab(context);
      running.tabId = tab.tabId;
      this.refreshRuntimeProtection(tab.tabId);
      const guest = await this.ensureGuest(tab, running.controller.signal);
      if (!guest) {
        const result = this.cancelledOrUnavailable(context, running, startedAt, tab);
        // If newTab fails before the ready ACK, do not leave a provisional tab without a guest; later list/attach calls
        // would mistake the cancelled creation for a live tab. close also asks the renderer to unmount and leaves a tombstone.
        await this.closeTabDurably(tab);
        return this.withMeta(result, context, tab, "closed");
      }
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    const tab = this.resolveTab(context, "tabId" in command ? command.tabId : undefined);
    if (!tab) {
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "backend_unavailable",
            message:
              "tabId" in command && command.tabId
                ? `browser tab '${command.tabId}' is not visible in the current context. ${TAB_CONTEXT_RECOVERY_HINT}`
                : "browser tab is unavailable",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
      );
    }
    running.tabId = tab.tabId;
    this.refreshRuntimeProtection(tab.tabId);

    if (command.method === "recordingStart") {
      const active = [...this.recordings.values()].find(
        (entry) => entry.tabId === tab.tabId && entry.status === "running",
      );
      if (active) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "execution_error",
              message: `browser tab '${tab.tabId}' already has active recording '${active.id}'`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      const entry = this.createRecordingEntry(context, tab);
      this.recordings.set(entry.id, entry);
      this.refreshRuntimeProtection(tab.tabId);
      void this.runRecording(entry, tab, command.options).catch((error: unknown) => {
        if (entry.status !== "running") return;
        if (
          entry.controller.signal.aborted &&
          entry.controller.signal.reason instanceof DOMException &&
          entry.controller.signal.reason.name === "TimeoutError"
        ) {
          this.setRecordingTerminal(entry, "failed", entry.controller.signal.reason.message);
        } else if (entry.controller.signal.aborted) {
          this.setRecordingTerminal(entry, "cancelled");
        } else {
          this.setRecordingTerminal(
            entry,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      return this.withMeta(
        {
          ok: true,
          recording: this.snapshotRecording(entry),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "getDialog") {
      return this.withMeta(
        {
          ok: true,
          dialog: this.pendingDialogs.get(tab.tabId) ?? null,
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if (command.method === "close") {
      await this.closeTabDurably(tab);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab, "closed");
    }
    if (command.method === "finalize") {
      tab.lifecycle = command.deliverable === false ? "active" : "deliverable";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (command.method === "markDeliverable") {
      tab.lifecycle = "deliverable";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (command.method === "markHandoff") {
      tab.lifecycle = "handoff";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (command.method === "playwrightWaitForTimeout") {
      // Validate the tab before a fixed wait; waiting itself does not touch the page or require an attached guest/CDP.
      // Turn/session/request abort must stop the timer early so a cancelled sleep does not retain lifecycle resources.
      const completed = await waitForDelay(command.timeoutMs, running.controller.signal);
      if (!completed) {
        return this.withMeta(this.cancelledResult(context, false, startedAt), context, tab);
      }
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    if (
      command.method === "playwright" &&
      (command.action.name === "fileChooserSetFiles" ||
        (command.action.name === "waitForEvent" && command.action.event === "filechooser"))
    ) {
      // The IAB backend does not support filechooser; do not fake success or treat it as a regular DOM fill.
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "capability_unsupported",
            message: "File uploads are not supported by iab",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if (command.method === "playwright" && command.action.name === "downloadPath") {
      const record = this.downloads.get(command.action.downloadId);
      if (!record || record.tabId !== tab.tabId) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "download is unavailable for this tab",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      const status = await waitForCondition(
        // Playwright's download.path() returns only after the download completes. A savePath at the will-download stage
        // does not mean the file is safe to read, so do not resolve early.
        () => record.state !== "pending",
        command.action.timeoutMs ?? 30_000,
        running.controller.signal,
      );
      if (status === "cancelled") {
        return this.withMeta(this.cancelledResult(context, false, startedAt), context, tab);
      }
      if (status === "timeout") {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "timeout",
              message: "Timeout waiting for download path",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      if (record.state !== "completed") {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "execution_error",
              message: `download ${record.state}`,
              sideEffect: "uncertain",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      return this.withMeta(
        { ok: true, value: record.path, elapsedMs: Date.now() - startedAt },
        context,
        tab,
      );
    }

    const guest = await this.ensureGuest(tab, running.controller.signal);
    if (!guest) return this.cancelledOrUnavailable(context, running, startedAt, tab);
    if (safeBool(() => guest.isDestroyed(), false)) {
      this.detachGuest(tab);
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "browser guest destroyed",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if ((tab.viewportOverride || tab.backgroundViewportFallback) && guest.getZoomFactor() !== 1)
      guest.setZoomFactor(1);
    const guestGeneration = tab.guestGeneration;
    const assertCurrentGuest = (): void => {
      if (tab.guestLifecycle === "detaching") {
        throw new Error("browser guest is detaching");
      }
      if (
        tab.guest !== guest ||
        tab.guestGeneration !== guestGeneration ||
        safeBool(() => guest.isDestroyed(), true)
      ) {
        throw new Error("browser guest changed before command dispatch");
      }
    };
    const sendCdpCommand = (method: string, params?: unknown, sessionId?: string) =>
      this.sendGuestCdpCommand(tab, guest, method, params, sessionId, assertCurrentGuest);

    if (
      command.method === "playwright" &&
      command.action.name === "waitForEvent" &&
      command.action.event === "download"
    ) {
      const downloadId = await this.waitForDownload(
        tab.tabId,
        // Download events wait 3s by default, but callers may explicitly extend this to at most 120s for real downloads.
        normalizePlaywrightTimeout(command.action.timeoutMs, 120_000),
        running.controller.signal,
      );
      if (!downloadId) {
        const result = running.controller.signal.aborted
          ? this.cancelledResult(context, false, startedAt)
          : {
              ok: false as const,
              error: {
                code: "timeout" as const,
                message: "Timeout waiting for download",
              },
              elapsedMs: Date.now() - startedAt,
            };
        return this.withMeta(result, context, tab);
      }
      return this.withMeta(
        {
          ok: true,
          value: { id: downloadId },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    if (command.method === "handleDialog") {
      try {
        assertCurrentGuest();
      } catch {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "browser guest changed before command dispatch",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      running.dispatched = true;
      const execution = sendCdpCommand("Page.handleJavaScriptDialog", {
        accept: command.accept,
        ...(command.promptText !== undefined ? { promptText: command.promptText } : {}),
      })
        .then<BrowserCommandResult>(() => ({
          ok: true,
          elapsedMs: Date.now() - startedAt,
        }))
        .catch<BrowserCommandResult>((error: unknown) => ({
          ok: false,
          error: {
            code: "execution_error",
            message: error instanceof Error ? error.message : String(error),
          },
          elapsedMs: Date.now() - startedAt,
        }));
      const result = await raceBackendExecution(
        execution,
        running.controller.signal,
        command,
        startedAt,
      );
      if (result.ok) {
        this.pendingDialogs.delete(tab.tabId);
      }
      return this.withMeta(result, context, tab);
    }

    const screenshotCommand = isScreenshotCommand(command);
    const previousScreenshot = screenshotCommand
      ? this.inFlightScreenshots.get(tab.tabId)
      : undefined;
    if (previousScreenshot && this.isInFlightScreenshotAlive(previousScreenshot)) {
      const elapsedMs = Date.now() - previousScreenshot.startedAt;
      this.log?.(
        `[browser-use] screenshot rejected tabId=${tab.tabId} requestId=${context.requestId} pendingRequestId=${previousScreenshot.requestId} pendingMs=${elapsedMs}`,
      );
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "timeout",
            message:
              "A previous screenshot for this browser tab is still completing after timeout. " +
              "Wait before retrying, or reopen the tab if it does not recover.",
            sideEffect: "none",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    const abandonedCaptures = screenshotCommand
      ? (this.abandonedScreenshotCaptures.get(tab.tabId) ?? 0)
      : 0;
    if (screenshotCommand && abandonedCaptures >= MAX_ABANDONED_SCREENSHOT_CAPTURES) {
      // The hard limit for unsettled underlying captures has been reached. Do not add another pending CDP command; fail
      // quickly and prompt the user to reopen the tab. A slot is reclaimed when an old capture settles, restoring operation automatically.
      this.log?.(
        `[browser-use] screenshot rejected tabId=${tab.tabId} requestId=${context.requestId} abandonedCaptures=${abandonedCaptures}`,
      );
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "timeout",
            message:
              `${abandonedCaptures} previous screenshot captures for this browser tab are still ` +
              "stuck in the backend after timeout. Reopen the tab to recover.",
            sideEffect: "none",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    if (previousScreenshot) {
      // When a full capture waits for frames in a hidden window, the 30s watchdog may mark it dead while the underlying
      // execution never settles. The tracker then cannot be cleared, and every later screenshot on that tab is rejected
      // immediately until the tab closes (production logs showed pendingMs up to 120s). Treat a pending capture as dead
      // once its command returned or was aborted, and let a new request replace it. Cleanup is idempotent by entry identity,
      // so a late settlement cannot delete the newer request.
      this.log?.(
        `[browser-use] screenshot superseded stale pending tabId=${tab.tabId} requestId=${context.requestId} pendingRequestId=${previousScreenshot.requestId} pendingMs=${Date.now() - previousScreenshot.startedAt}`,
      );
    }

    const execution = screenshotCommand
      ? this.executeScreenshotWithPreparedSurface(
          context,
          tab,
          guest,
          command,
          running,
          startedAt,
          assertCurrentGuest,
          sendCdpCommand,
        )
      : executeBrowserCommandOnView(
          this.toControlledView(
            guest,
            Boolean(tab.viewportOverride || tab.backgroundViewportFallback),
            undefined,
            assertCurrentGuest,
            sendCdpCommand,
          ),
          command,
          { signal: running.controller.signal },
        );
    if (!screenshotCommand) running.dispatched = true;
    if (screenshotCommand) {
      const tracked: InFlightScreenshot = {
        execution,
        requestId: context.requestId,
        startedAt: Date.now(),
      };
      this.inFlightScreenshots.set(tab.tabId, tracked);
      this.refreshRuntimeProtection(tab.tabId);
      const clearTrackedScreenshot = () => {
        if (this.inFlightScreenshots.get(tab.tabId) !== tracked) return;
        this.inFlightScreenshots.delete(tab.tabId);
        this.refreshRuntimeProtection(tab.tabId);
        this.log?.(
          `[browser-use] screenshot backend settled tabId=${tab.tabId} requestId=${context.requestId} elapsedMs=${Date.now() - tracked.startedAt}`,
        );
      };
      // Provide both fulfilled and rejected handlers to avoid an unhandled derived rejection from calling finally alone.
      void execution.then(clearTrackedScreenshot, clearTrackedScreenshot);
    }
    const result = await raceBackendExecution(
      execution,
      running.controller.signal,
      command,
      startedAt,
    );
    return this.withMeta(result, context, tab);
  }

  /**
   * Renderer logical viewport readiness proves only that the CSS coordinate system is correct. With negative Windows
   * scaling, a Fit preview may still have only an 800×450 raster, which CDP tiles to 1280×720. Main reads the composited
   * guest surface directly and normalizes it to the logical viewport. This avoids the renderer `<webview>.capturePage()`
   * call that once triggered a V8 FATAL, and does not change page layout, DPR, or interactive metrics.
   */
  private async executeScreenshotWithPreparedSurface(
    context: InternalExecutionContext,
    tab: ManagedTab,
    guest: GuestWebContents,
    command: BrowserCommand,
    running: RunningRequest,
    startedAt: number,
    assertCurrentGuest: () => void,
    sendCdpCommand: ControlledView["cdp"]["send"],
  ): Promise<BrowserCommandResult> {
    let lease: BrowserScreenshotSurfaceLease | undefined;
    try {
      const screenshotSurfaceCoordinator = this.screenshotSurfaceCoordinator;
      if (!screenshotSurfaceCoordinator) {
        throw new Error("browser screenshot surface coordinator is unavailable");
      }
      const viewport = await this.readTabViewport(tab);
      let result: BrowserCommandResult | undefined;

      // Do not acquire activity and then queue the viewport mutation: if an earlier resize/CDP call is stuck, owner and
      // guest captures can run back-to-back outside the queue for up to 35s. Start surface preparation only after this
      // request reaches the viewport critical section, so activity covers the actual prepare + raster lifecycle.
      await this.enqueueViewportMutation(tab, async () => {
        lease = await screenshotSurfaceCoordinator.prepare({
          requestId: context.requestId,
          windowId: context.windowId,
          workspaceKey: context.workspaceKey,
          sessionId: context.sessionId,
          browserId: context.browserId,
          browserGeneration: context.browserGeneration,
          tabId: tab.tabId,
          webContentsId: guest.id,
          viewport,
          // A natural viewport has no metrics installed; do not let the renderer's temporary Fit expand the guest layout and trigger page reflow.
          viewportMode:
            tab.viewportOverride || tab.backgroundViewportFallback ? "emulated" : "natural",
          signal: running.controller.signal,
        });
        if (
          running.controller.signal.aborted ||
          tab.guest !== guest ||
          guest.isDestroyed() ||
          lease.webContentsId !== guest.id
        ) {
          throw new Error("browser guest changed while preparing screenshot surface");
        }
        const invalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
        if (invalidationError) throw invalidationError;
        // The ordinary fallback also uses a temporary responsive surface, so it must compensate for the host's enlarged native raster.
        // Normal mode does not write back the viewport; sync a live zoom change in the same mutation instead of waiting only for an idle reconnect.
        if (tab.backgroundViewportFallback) {
          const desktopZoom = guest.hostWebContents?.getZoomFactor();
          if (
            !guest.debugger.isAttached() ||
            tab.guestCdpRestoreFlight ||
            (tab.appliedViewportScale ?? 1) !== normalizeDesktopZoomMetricsScale(desktopZoom)
          ) {
            await this.sendGuestCdpCommand(
              tab,
              guest,
              "Emulation.setDeviceMetricsOverride",
              buildViewportMetricsOverride(tab.backgroundViewportFallback, desktopZoom),
            );
          }
        }
        const normalizedScreenshot = Boolean(
          tab.viewportOverride || tab.backgroundViewportFallback,
        );
        // With 125% Windows display scaling and 110% Desktop zoom, CDP can still tile a smaller native raster to the target
        // size even when the renderer reports surfaceScale=1. A screenshot of the zoom-compensated viewport must also read
        // the actual surface, then normalize it consistently to CSS pixels.
        const captureViewportScreenshot =
          normalizedScreenshot &&
          (lease.surfaceScale < 0.999 ||
            (tab.appliedViewportScale ?? tab.desktopZoomFactor ?? 1) > 1)
            ? async (): Promise<string | undefined> => {
                if (!this.resizeScreenshotToCssPixels) {
                  throw new Error("browser screenshot CSS pixel normalizer is unavailable");
                }
                const surface = await guest.capturePage();
                const surfacePng = surface.toPNG();
                if (surfacePng.byteLength === 0) return undefined;
                return this.resizeScreenshotToCssPixels(surfacePng.toString("base64"), viewport);
              }
            : undefined;
        running.dispatched = true;
        // When the owner window is hidden (minimized to tray), the Windows compositor stops compositing guest frames.
        // The transparent bootstrap from prepare is released as soon as the renderer is ready, so a full capture gets no
        // frame until the user reopens the window (logs showed completion only about 140ms after tray-show; all others hit
        // the 30s watchdog). Hold a transparent presentation for the capture lifetime (showInactive + opacity 0, invisible
        // to the user) to request frames. Capture settlement must also race against abort/a bounded deadline: a hung
        // execution would stall both the viewport mutation queue and the in-flight slot, so the mutation must not outlive its request.
        const capturePresentation = this.startHiddenWindowCapturePresentation(context, guest);
        try {
          // Same constraint as the activity pump: reading in the same turn after showInactive but before the Viz surface
          // exists throws UnknownVizError. Wait for the shared bounded presentation grace before capturing. The guest.capturePage()
          // normalization path (background tab) is subject to the same behavior.
          if (
            capturePresentation &&
            !(await waitForDelay(
              TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
              running.controller.signal,
            ))
          ) {
            throw new Error("browser screenshot capture cancelled during presentation grace");
          }
          // Native capture does not use sendCdpCommand, but must still wait for metrics restoration after an idle detach.
          if (!guest.debugger.isAttached() || tab.guestCdpRestoreFlight) {
            await this.ensureGuestCdpAttached(tab, guest);
          }
          const captureExecution = executeBrowserCommandOnView(
            this.toControlledView(
              guest,
              normalizedScreenshot,
              captureViewportScreenshot,
              assertCurrentGuest,
              sendCdpCommand,
            ),
            command,
            { signal: running.controller.signal },
          );
          result = await this.settleScreenshotCapture(
            captureExecution,
            running.controller.signal,
            context,
            startedAt,
            tab.tabId,
            capturePresentation ? HIDDEN_WINDOW_CAPTURE_DEADLINE_MS : undefined,
          );
        } finally {
          capturePresentation?.release();
        }
        const lateInvalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
        if (lateInvalidationError) throw lateInvalidationError;
      });
      if (!result) throw new Error("browser screenshot did not produce a result");
      return result;
    } catch (error) {
      const cancelled = running.controller.signal.aborted;
      return {
        ok: false,
        error: {
          code: cancelled ? "cancelled" : "backend_unavailable",
          message: cancelled
            ? "browser screenshot surface preparation cancelled"
            : error instanceof Error
              ? error.message
              : String(error),
          sideEffect: "none",
        },
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      lease?.release();
    }
  }

  /** Create a one-shot transparent presentation for a full capture when the window is hidden; no-op if visible or unsupported. */
  private startHiddenWindowCapturePresentation(
    context: InternalExecutionContext,
    guest: GuestWebContents,
  ): TransparentWindowBootstrap | undefined {
    if (!this.resolveOwnerWindow) return undefined;
    const win = this.resolveOwnerWindow(context.windowId);
    if (!win) return undefined;
    return (
      startBrowserScreenshotTransparentWindowBootstrap({
        win,
        enabled: true,
        windowId: context.windowId,
        webContentsId: guest.id,
        requestId: context.requestId,
        hideTaskbarDuringBootstrap: process.platform === "win32",
        log: this.log,
      }) || undefined
    );
  }

  /**
   * Shared settlement point for captures: whichever comes first among execution, request abort, and an optional bounded deadline wins.
   * In cases such as waiting for frames in a hidden window or an upstream 30s cancelRequest, execution may never settle.
   * Do not wait for it; release the viewport mutation queue and in-flight slot with the request. If abort/deadline wins,
   * the underlying CDP command remains pending in Chromium and counts toward the abandonedScreenshotCaptures hard limit.
   */
  private async settleScreenshotCapture(
    execution: Promise<BrowserCommandResult>,
    signal: AbortSignal,
    context: InternalExecutionContext,
    startedAt: number,
    tabId: string,
    deadlineMs?: number,
  ): Promise<BrowserCommandResult> {
    return await new Promise<BrowserCommandResult>((resolve) => {
      let settled = false;
      const finish = (result: BrowserCommandResult): boolean => {
        if (settled) return false;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
        return true;
      };
      const onAbort = () => {
        if (
          finish({
            ok: false,
            error: {
              code: "cancelled",
              message: "browser screenshot capture cancelled",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          })
        ) {
          this.abandonBackendCapture(tabId, execution);
        }
      };
      const timer =
        deadlineMs !== undefined
          ? setTimeout(() => {
              this.log?.(
                `[browser-use] hidden window capture deadline exceeded requestId=${context.requestId} windowId=${context.windowId} deadlineMs=${deadlineMs}`,
              );
              if (
                finish({
                  ok: false,
                  error: {
                    code: "timeout",
                    message: `browser screenshot capture timed out after ${deadlineMs}ms while the window was hidden`,
                    sideEffect: "none",
                  },
                  elapsedMs: Date.now() - startedAt,
                })
              ) {
                this.abandonBackendCapture(tabId, execution);
              }
            }, deadlineMs)
          : undefined;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      execution.then(finish, (error: unknown) =>
        finish({
          ok: false,
          error: {
            code: "execution_error",
            message: error instanceof Error ? error.message : String(error),
          },
          elapsedMs: Date.now() - startedAt,
        }),
      );
    });
  }

  /** Track a capture whose caller stopped waiting while the underlying operation continues; reclaim its slot on actual settlement. */
  private abandonBackendCapture(tabId: string, execution: Promise<BrowserCommandResult>): void {
    this.abandonedScreenshotCaptures.set(
      tabId,
      (this.abandonedScreenshotCaptures.get(tabId) ?? 0) + 1,
    );
    execution.then(
      () => this.releaseAbandonedBackendCapture(tabId),
      () => this.releaseAbandonedBackendCapture(tabId),
    );
  }

  private releaseAbandonedBackendCapture(tabId: string): void {
    const count = this.abandonedScreenshotCaptures.get(tabId);
    if (count === undefined) return;
    if (count <= 1) this.abandonedScreenshotCaptures.delete(tabId);
    else this.abandonedScreenshotCaptures.set(tabId, count - 1);
  }

  private recordingNow(): number {
    return this.residencyOptions.recording?.now?.() ?? Date.now();
  }

  /**
   * Whether a pending screenshot is still live: its command is still running (runningRequests has a non-aborted entry).
   * If the entry is gone, the command already returned (typically after the 30s watchdog) while execution remains hung—a dead slot.
   */
  private isInFlightScreenshotAlive(tracked: InFlightScreenshot): boolean {
    const running = this.runningRequests.get(tracked.requestId);
    return Boolean(running) && !running.controller.signal.aborted;
  }

  private createRecordingEntry(
    context: InternalExecutionContext,
    tab: ManagedTab,
  ): BrowserRecordingEntry {
    const now = this.recordingNow();
    return {
      id: `iab-recording:${randomUUID()}`,
      context: { ...context },
      tabId: tab.tabId,
      controller: new AbortController(),
      status: "running",
      phase: "preparing",
      progress: 0,
      startedAt: now,
      updatedAt: now,
    };
  }

  private snapshotRecording(entry: BrowserRecordingEntry): BrowserRecordingJob {
    return {
      id: entry.id,
      status: entry.status,
      phase: entry.phase,
      progress: entry.progress,
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      ...(entry.artifact ? { artifact: { ...entry.artifact } } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  private setRecordingPhase(
    entry: BrowserRecordingEntry,
    phase: Extract<BrowserRecordingJob["phase"], "capturing" | "finalizing">,
  ): void {
    if (entry.status !== "running") return;
    entry.phase = phase;
    entry.progress = phase === "capturing" ? 0.1 : 0.9;
    entry.updatedAt = this.recordingNow();
    this.refreshRuntimeProtection(entry.tabId);
  }

  private setRecordingTerminal(
    entry: BrowserRecordingEntry,
    status: Extract<BrowserRecordingJob["status"], "completed" | "failed" | "cancelled">,
    error?: string,
  ): void {
    entry.status = status;
    entry.phase = status;
    entry.progress = status === "completed" ? 1 : entry.progress;
    entry.updatedAt = this.recordingNow();
    if (error) entry.error = error;
    else delete entry.error;
    if (!entry.cleanupTimer) {
      entry.cleanupTimer = setTimeout(() => {
        this.recordings.delete(entry.id);
        if (entry.artifact?.path) {
          void rm(entry.artifact.path, { force: true }).catch(() => undefined);
        }
      }, RECORDING_RESULT_TTL_MS);
      entry.cleanupTimer.unref?.();
    }
    this.refreshRuntimeProtection(entry.tabId);
  }

  private abortRecordings(
    predicate: (entry: BrowserRecordingEntry) => boolean,
    reason: string,
  ): void {
    for (const entry of this.recordings.values()) {
      if (entry.status !== "running" || !predicate(entry)) continue;
      entry.controller.abort(new DOMException(reason, "AbortError"));
      this.setRecordingTerminal(entry, "cancelled");
    }
  }

  private async runRecording(
    entry: BrowserRecordingEntry,
    tab: ManagedTab,
    rawOptions?: BrowserRecordingOptions,
  ): Promise<void> {
    const signal = entry.controller.signal;
    const options = rawOptions ?? {};
    const viewport = options.viewport ?? DEFAULT_AGENT_BROWSER_VIEWPORT;
    const fps = options.fps ?? 25;
    const maxDurationMs = options.maxDurationMs ?? 60_000;
    const settleMs = options.settleMs ?? 300;
    assertViewportOverride(viewport);

    const guest = await this.ensureGuest(tab, signal);
    if (!guest || guest.isDestroyed()) throw new Error("browser guest unavailable for recording");
    // Recording temporarily changes the tab viewport override to obtain a 100% surface; save the previous value first.
    const previousViewport = tab.viewportOverride ? { ...tab.viewportOverride } : undefined;
    let lease: BrowserScreenshotSurfaceLease | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.setTabViewport(tab, viewport);
      // Changing only CDP metrics does not update the free-size frame that hosts the WebView in the renderer. A custom
      // recording viewport would keep the old DOM bounds, causing prepare to time out or enlarging a reduced surface and blurring it.
      this.onViewportChanged?.(viewport, tab.owner, tab.tabId);
      const coordinator = this.screenshotSurfaceCoordinator;
      if (!coordinator) throw new Error("browser recording surface coordinator is unavailable");
      lease = await coordinator.prepare({
        requestId: `recording:${entry.id}`,
        windowId: entry.context.windowId,
        workspaceKey: entry.context.workspaceKey,
        sessionId: entry.context.sessionId,
        browserId: entry.context.browserId,
        browserGeneration: entry.context.browserGeneration,
        tabId: tab.tabId,
        webContentsId: guest.id,
        viewport,
        surfaceScaleMode: "unscaled",
        signal,
        activityTimeoutMs: maxDurationMs + 30_000,
      });
      if (!lease || lease.webContentsId !== guest.id) {
        throw new Error("browser guest changed while preparing recording surface");
      }
      const invalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
      if (invalidationError) throw invalidationError;
      const invalidateRecording = () =>
        entry.controller.abort(
          lease?.invalidated?.reason instanceof Error
            ? lease.invalidated.reason
            : new Error("browser recording surface invalidated"),
        );
      lease.invalidated?.addEventListener("abort", invalidateRecording, { once: true });
      timeout = setTimeout(
        () =>
          entry.controller.abort(new DOMException("browser recording timed out", "TimeoutError")),
        maxDurationMs,
      );
      const guestGeneration = tab.guestGeneration;
      const assertCurrentGuest = (): void => {
        if (tab.guestLifecycle === "detaching") {
          throw new Error("browser guest is detaching");
        }
        if (
          tab.guest !== guest ||
          tab.guestGeneration !== guestGeneration ||
          safeBool(() => guest.isDestroyed(), true)
        ) {
          throw new Error("browser guest changed before recording dispatch");
        }
      };
      const view = this.toControlledView(
        guest,
        true,
        undefined,
        assertCurrentGuest,
        (method, params, sessionId) =>
          this.sendGuestCdpCommand(tab, guest, method, params, sessionId, assertCurrentGuest),
      );
      if (options.showCursor !== false) await this.installRecordingCursorOverlay(guest);
      const createRecorder = this.residencyOptions.recording?.createRecorder;
      if (!createRecorder) throw new Error("browser WebM recorder is unavailable");
      entry.artifact = await recordBrowserVideo({
        targetFrame: guest.mainFrame,
        tempRoot: this.residencyOptions.recording?.tempRoot ?? tmpdir(),
        recordingId: entry.id.replace(/[^A-Za-z0-9._-]/gu, "-"),
        viewport,
        fps,
        signal,
        onPhase: (phase) => this.setRecordingPhase(entry, phase),
        onCaptureComplete: () => {
          // maxDurationMs limits page capture only; encoding is finalization and must not discard a video that was fully recorded.
          if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          lease?.release();
        },
        executeScenario: async () => {
          if (settleMs > 0 && !(await waitForDelay(settleMs, signal))) throw abortError();
          await this.executeRecordingActions(view, options.actions ?? [], signal, viewport);
        },
        createRecorder,
      });
      this.setRecordingTerminal(entry, "completed");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (options.showCursor !== false) await this.removeRecordingCursorOverlay(guest);
      // lease.release() restores only the transient surface scale; the tab's own viewport override would remain at the
      // recording size, affecting later previews and screenshots. Recording borrows it temporarily, so restore it.
      await this.restoreRecordingViewport(tab, previousViewport).catch(() => undefined);
      lease?.release();
    }
  }

  /** Restore the tab viewport that was temporarily changed during recording. */
  private async restoreRecordingViewport(
    tab: ManagedTab,
    previous: BrowserViewportSize | undefined,
  ): Promise<void> {
    if (tab.lifecycle === "closed") return;
    if (previous) {
      await this.setTabViewport(tab, previous);
      this.onViewportChanged?.(previous, tab.owner, tab.tabId);
      return;
    }
    await this.resetTabViewport(tab);
    this.onViewportChanged?.(null, tab.owner, tab.tabId);
  }

  private async executeRecordingActions(
    view: ControlledView,
    actions: BrowserRecordingAction[],
    signal: AbortSignal,
    viewport: BrowserViewportSize,
  ): Promise<void> {
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    for (const action of actions) {
      if (signal.aborted) throw abortError();
      await this.executeRecordingAction(view, action, signal, pointer);
      const delayAfterMs = "delayAfterMs" in action ? action.delayAfterMs : undefined;
      if (delayAfterMs && !(await waitForDelay(delayAfterMs, signal))) throw abortError();
    }
  }

  private async executeRecordingAction(
    view: ControlledView,
    action: BrowserRecordingAction,
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void> {
    if (action.type === "wait") {
      if (!(await waitForDelay(action.durationMs, signal))) throw abortError();
      return;
    }
    if (action.type === "click" || action.type === "type" || action.type === "waitFor") {
      const locatorAction =
        action.type === "click"
          ? action.selector
            ? {
                name: "locator" as const,
                selector: action.selector,
                operation: action.doubleClick ? ("dblclick" as const) : ("click" as const),
                ...(action.button ? { button: action.button } : {}),
              }
            : undefined
          : action.type === "type"
            ? {
                name: "locator" as const,
                selector: action.selector,
                operation: "fill" as const,
                value: action.text,
              }
            : {
                name: "locator" as const,
                selector: action.selector,
                operation: "waitFor" as const,
                state: action.state ?? "visible",
              };
      if (locatorAction) {
        const result = await executeIabPlaywrightLocator(
          view,
          locatorAction,
          action.type === "waitFor" ? (action.timeoutMs ?? 3_000) : 3_000,
          signal,
        );
        if (result.kind === "cancelled") throw abortError();
        if (result.kind === "timeout")
          throw new Error(`recording action timed out: ${result.reason}`);
        return;
      }
      if (typeof action.x !== "number" || typeof action.y !== "number") {
        throw new Error("recording click requires selector or (x,y)");
      }
      await this.executeRecordingBrowserCommand(view, {
        method: "click",
        x: action.x,
        y: action.y,
        ...(action.button ? { button: action.button } : {}),
        ...(action.doubleClick !== undefined ? { doubleClick: action.doubleClick } : {}),
      });
      pointer.x = action.x;
      pointer.y = action.y;
      return;
    }
    if (action.type === "hover") {
      if (action.selector) {
        const point = await this.resolveRecordingSelectorPoint(view, action.selector, signal);
        await this.moveRecordingPointer(
          view,
          point.x,
          point.y,
          action.durationMs ?? 0,
          signal,
          pointer,
        );
      } else if (typeof action.x === "number" && typeof action.y === "number") {
        await this.moveRecordingPointer(
          view,
          action.x,
          action.y,
          action.durationMs ?? 0,
          signal,
          pointer,
        );
      } else {
        throw new Error("recording hover requires selector or (x,y)");
      }
      return;
    }
    if (action.type === "move") {
      await this.moveRecordingPointer(
        view,
        action.x,
        action.y,
        action.durationMs ?? 0,
        signal,
        pointer,
      );
      return;
    }
    if (action.type === "scroll") {
      await this.animateRecordingScroll(
        view,
        action.deltaX ?? 0,
        action.deltaY,
        action.durationMs ?? 0,
        signal,
      );
      return;
    }
    if (action.type === "scrollTo") {
      const current = (await view.webContents.executeJavaScript(
        "({ x: window.scrollX, y: window.scrollY })",
      )) as { x?: unknown; y?: unknown };
      const target = action.selector
        ? await this.resolveRecordingSelectorScrollTarget(view, action.selector, signal)
        : { x: action.x ?? Number(current.x ?? 0), y: action.y ?? Number(current.y ?? 0) };
      await this.animateRecordingScroll(
        view,
        target.x - Number(current.x ?? 0),
        target.y - Number(current.y ?? 0),
        action.durationMs ?? 0,
        signal,
      );
      return;
    }
    if (action.type === "wheel") {
      const times = action.times ?? 1;
      for (let index = 0; index < times; index += 1) {
        await this.executeRecordingBrowserCommand(view, {
          method: "scroll",
          x: action.deltaX ?? 0,
          y: action.deltaY,
        });
        if (action.intervalMs && !(await waitForDelay(action.intervalMs, signal)))
          throw abortError();
      }
      return;
    }
    if (action.type === "drag") {
      const steps = Math.max(1, action.path.length - 1);
      const intervalMs = Math.floor((action.durationMs ?? 0) / steps);
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: action.path[0]!.x,
        y: action.path[0]!.y,
      });
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: action.path[0]!.x,
        y: action.path[0]!.y,
        button: "left",
        clickCount: 1,
      });
      for (const point of action.path.slice(1)) {
        await view.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 1,
        });
        if (intervalMs > 0 && !(await waitForDelay(intervalMs, signal))) throw abortError();
      }
      const last = action.path.at(-1)!;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: last.x,
        y: last.y,
        button: "left",
        clickCount: 1,
      });
      pointer.x = last.x;
      pointer.y = last.y;
    }
  }

  private async executeRecordingBrowserCommand(
    view: ControlledView,
    command: BrowserCommand,
  ): Promise<void> {
    const result = await executeBrowserCommandOnView(view, command);
    if (!result.ok)
      throw new Error(result.error?.message ?? `recording action ${command.method} failed`);
  }

  private async resolveRecordingSelectorPoint(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const result = await executeIabPlaywrightLocator(
      view,
      {
        name: "locator",
        selector,
        operation: "evaluate",
        expressionKind: "function",
        expression:
          "(element) => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }",
      },
      3_000,
      signal,
    );
    if (result.kind !== "done" || !isBrowserPointValue(result.value)) {
      throw new Error(`recording selector '${selector}' has no visible point`);
    }
    return result.value;
  }

  private async resolveRecordingSelectorScrollTarget(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const result = await executeIabPlaywrightLocator(
      view,
      {
        name: "locator",
        selector,
        operation: "evaluate",
        expressionKind: "function",
        expression:
          "(element) => { const rect = element.getBoundingClientRect(); return { x: window.scrollX + rect.left, y: window.scrollY + rect.top }; }",
      },
      3_000,
      signal,
    );
    if (result.kind !== "done" || !isBrowserPointValue(result.value)) {
      throw new Error(`recording selector '${selector}' has no scroll target`);
    }
    return result.value;
  }

  private async moveRecordingPointer(
    view: ControlledView,
    x: number,
    y: number,
    durationMs: number,
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void> {
    const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)));
    const startX = pointer.x;
    const startY = pointer.y;
    for (let index = 1; index <= steps; index += 1) {
      if (signal.aborted) throw abortError();
      const progress = index / steps;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: startX + (x - startX) * progress,
        y: startY + (y - startY) * progress,
      });
      if (durationMs > 0 && index < steps && !(await waitForDelay(durationMs / steps, signal))) {
        throw abortError();
      }
    }
    pointer.x = x;
    pointer.y = y;
  }

  private async installRecordingCursorOverlay(guest: GuestWebContents): Promise<void> {
    await guest.executeJavaScript(`(() => {
      const id = "__zcode_browser_recording_cursor";
      document.getElementById(id)?.remove();
      const cursor = document.createElement("div");
      cursor.id = id;
      cursor.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;border-radius:50%;background:#ff4d4f;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);opacity:0;transition:opacity 80ms linear";
      document.documentElement.appendChild(cursor);
      const move = (event) => {
        cursor.style.left = event.clientX + "px";
        cursor.style.top = event.clientY + "px";
        cursor.style.opacity = "1";
      };
      const down = () => {
        cursor.style.transform = "translate(-50%,-50%) scale(.72)";
      };
      const up = () => {
        cursor.style.transform = "translate(-50%,-50%) scale(1)";
      };
      window["__zcodeBrowserRecordingCursorCleanup"]?.();
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mousedown", down, true);
      window.addEventListener("mouseup", up, true);
      window["__zcodeBrowserRecordingCursorCleanup"] = () => {
        window.removeEventListener("mousemove", move, true);
        window.removeEventListener("mousedown", down, true);
        window.removeEventListener("mouseup", up, true);
        cursor.remove();
        delete window["__zcodeBrowserRecordingCursorCleanup"];
      };
    })()`);
  }

  private async removeRecordingCursorOverlay(guest: GuestWebContents): Promise<void> {
    if (guest.isDestroyed()) return;
    await guest
      .executeJavaScript('window["__zcodeBrowserRecordingCursorCleanup"]?.()')
      .catch(() => undefined);
  }

  private async animateRecordingScroll(
    view: ControlledView,
    deltaX: number,
    deltaY: number,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)));
    for (let index = 0; index < steps; index += 1) {
      await this.executeRecordingBrowserCommand(view, {
        method: "scroll",
        x: deltaX / steps,
        y: deltaY / steps,
      });
      if (
        durationMs > 0 &&
        index + 1 < steps &&
        !(await waitForDelay(durationMs / steps, signal))
      ) {
        throw abortError();
      }
    }
  }

  private resolveTab(
    context: InternalExecutionContext,
    explicitTabId?: string,
  ): ManagedTab | undefined {
    if (explicitTabId) {
      const explicit = this.tabs.get(explicitTabId);
      if (!explicit || explicit.lifecycle === "closed" || !sameScope(explicit.owner, context)) {
        return undefined;
      }
      return explicit;
    }
    const key = scopeKey(context);
    const activeId = this.activeTabByScope.get(key);
    const active = activeId ? this.tabs.get(activeId) : undefined;
    if (active && active.lifecycle !== "closed" && sameScope(active.owner, context)) return active;
    const defaultId = this.defaultTabByScope.get(key);
    const existingDefault = defaultId ? this.tabs.get(defaultId) : undefined;
    if (
      existingDefault &&
      existingDefault.lifecycle !== "closed" &&
      sameScope(existingDefault.owner, context)
    ) {
      return existingDefault;
    }
    // For a background session (renderer reports only active:false) with a tab created by explicit newTab, both
    // activeTabByScope and defaultTabByScope are empty. Reuse the most recent live tab in that scope; otherwise a command
    // without tabId would open an empty tab and tabs.list() would disagree with the actual command target.
    const recent = this.ownedTabs(context).at(-1);
    if (recent) return recent;
    return this.createTab(context, context.legacy ? context.sessionId : undefined, true);
  }

  private createTab(
    context: InternalExecutionContext,
    preferredTabId?: string,
    makeDefault = false,
  ): ManagedTab {
    const tabId = preferredTabId ?? `iab-tab:${randomUUID()}`;
    const existing = this.tabs.get(tabId);
    if (existing && existing.lifecycle !== "closed" && sameScope(existing.owner, context)) {
      return existing;
    }
    const tab: ManagedTab = {
      tabId,
      owner: { ...context },
      cdpAttached: false,
      guestLifecycle: "detached",
      pendingCdpCommands: 0,
      guestGeneration: 0,
      hasAttachedGuest: false,
      rebindRequested: false,
      lifecycle: "active",
      origin: "agent",
      claimable: false,
      active: false,
      loading: false,
      mediaActive: false,
      cachedUrl: "",
      cachedTitle: "",
      cachedFaviconUrl: null,
      openedAt: this.now(),
      // Model-created tabs (explicit newTab and implicit creation when no tab exists) default to the desktop free-size viewport.
      // The viewport is part of tab creation; claim, activate, and navigate reuse an existing tab and must not apply the default again.
      viewportOverride: { ...DEFAULT_AGENT_BROWSER_VIEWPORT },
    };
    this.tabs.set(tabId, tab);
    this.registerTabResidency(tab, false);
    void this.persistShell(tab);
    if (makeDefault) this.defaultTabByScope.set(scopeKey(context), tabId);
    return tab;
  }

  private async ensureGuest(
    tab: ManagedTab,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    if (signal.aborted) return null;
    const suspendFlight = this.suspendFlights.get(tab.tabId);
    if (suspendFlight) {
      // The guard can cancel the coordinator generation, but cannot immediately prove the renderer has not unmounted.
      // Browser commands must wait for snapshot/ack and any required recovery to converge; do not reuse a guest about to be destroyed.
      const settled = await waitForPromiseWithSignal(suspendFlight, signal);
      if (!settled.completed) return null;
    }
    const residency = this.residencyCoordinator.get(tab.tabId);
    if (residency?.residency === "suspended" || residency?.residency === "restoring") {
      return await this.restoreSuspendedGuest(tab, signal);
    }
    if (tab.guest && !safeBool(() => tab.guest!.isDestroyed(), true)) {
      return await this.waitForGuestRecovery(tab, tab.guest, signal);
    }
    if (tab.guest) {
      this.detachGuest(tab);
    }

    const existingFlight = this.guestAttachFlights.get(tab.tabId);
    let flight = existingFlight;
    if (!flight) {
      flight = this.runGuestAttachFlight(tab);
      this.guestAttachFlights.set(tab.tabId, flight);
      const clearFlight = () => {
        if (this.guestAttachFlights.get(tab.tabId) === flight) {
          this.guestAttachFlights.delete(tab.tabId);
        }
      };
      void flight.then(clearFlight, clearFlight);
    }
    const settled = await waitForPromiseWithSignal(flight, signal);
    if (!settled.completed || !settled.value) return null;
    return await this.waitForGuestRecovery(tab, settled.value, signal);
  }

  private async waitForGuestRecovery(
    tab: ManagedTab,
    guest: GuestWebContents,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    const flight = this.guestRecoveryFlights.get(tab.tabId);
    if (!flight) return guest;
    const settled = await waitForPromiseWithSignal(flight, signal);
    return settled.completed && settled.value === guest ? guest : null;
  }

  private async runGuestAttachFlight(tab: ManagedTab): Promise<GuestWebContents | null> {
    // Wait only once for a new tab's initial ready; allow one bounded replay for an existing guest or an explicit rejection.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (tab.lifecycle === "closed") return null;
      // create/ready is replayable state; after a lost event or guest crash, request one bounded replay.
      // If destroyed/mismatch already started a rebind, reuse that request to avoid creating duplicate webviews for one tab.
      if (!tab.rebindRequested) this.onOpenTabRequested?.(tab.tabId, tab.owner);
      // Some tests/old renderers attach synchronously inside the Ready callback; do not register a waiter after attach has already succeeded.
      if (tab.guest && !safeBool(() => tab.guest.isDestroyed(), true)) return tab.guest;
      const guest = await this.waitForGuest(tab.tabId);
      if (guest && !safeBool(() => guest.isDestroyed(), true)) return guest;
      if (attempt === 0 && !tab.hasAttachedGuest && !tab.attachFailure) return null;
      if (attempt === 1) return null;
      this.requestGuestRebind(tab, tab.attachFailure ?? "attach-timeout");
    }
    return null;
  }

  private ownedTabs(context: InternalExecutionContext): ManagedTab[] {
    return [...this.tabs.values()].filter(
      (tab) => tab.lifecycle !== "closed" && sameScope(tab.owner, context),
    );
  }

  private canClaimUserTab(tab: ManagedTab, context: InternalExecutionContext): boolean {
    return (
      tab.origin === "user" &&
      tab.claimable &&
      tab.lifecycle !== "closed" &&
      tab.owner.windowId === context.windowId &&
      tab.owner.workspaceKey === context.workspaceKey &&
      (tab.owner.remoteSessionId ?? "") === (context.remoteSessionId ?? "") &&
      tab.owner.sessionId === context.sessionId
    );
  }

  private openUserTabs(context: InternalExecutionContext): ManagedTab[] {
    return [...this.tabs.values()]
      .filter((tab) => this.canClaimUserTab(tab, context) && this.hasDiscoverableUserPage(tab))
      .sort((left, right) => Number(right.active) - Number(left.active));
  }

  private hasDiscoverableUserPage(tab: ManagedTab): boolean {
    const url = tab.guest
      ? safeStr(() => tab.guest!.getURL(), tab.cachedUrl).trim()
      : tab.cachedUrl.trim();
    // A mounted human webview becomes ready with about:blank/an empty URL before its first navigation.
    // This is only a UI placeholder, not a user page an agent can claim; controlled tabs.list() is not affected by this filter.
    return url.length > 0 && url !== "about:blank";
  }

  private claimTab(tab: ManagedTab, context: InternalExecutionContext): ManagedTab {
    if (!this.canClaimUserTab(tab, context)) return tab;
    tab.owner = { ...context };
    tab.claimable = false;
    // Claim used to take ownership without changing activation. An inactive human tab webview produces no frames, so the
    // screenshot prepare handshake timed out after 3s when claimed (renderer ready never arrived). Claim also activates,
    // using the same selectTab(tab, true) semantics as activateTab: expand the view for a foreground scope, or record
    // activation for a background scope without stealing focus from the user's current session.
    this.selectTab(tab, true);
    this.log?.(
      `[browser-use] claim human tab tabId=${tab.tabId} windowId=${context.windowId} sessionId=${context.sessionId}`,
    );
    return tab;
  }

  private selectTab(tab: ManagedTab, notifyRenderer: boolean): void {
    const key = scopeKey(tab.owner);
    // A browser scope may have at most one active tab. The old attach path marked the new tab active without clearing
    // the previous tab.active, so tabs.list() could return multiple active=true entries.
    for (const candidate of this.tabs.values()) {
      if (!sameScope(candidate.owner, tab.owner)) continue;
      candidate.active = candidate.tabId === tab.tabId;
      this.residencyCoordinator.report(candidate.tabId, {
        selected: candidate.tabId === tab.tabId,
      });
    }
    this.activeTabByScope.set(key, tab.tabId);
    if (!notifyRenderer) return;
    this.visibilityByScope.set(key, true);
    this.onVisibilityChanged?.(true, tab.owner, tab.tabId);
    // activateTab and claim both converge through selectTab(tab, true). The attach path uses notifyRenderer=false and
    // already triggers recovery itself, so it will not run twice.
    this.maybeRestoreBackgroundViewport(tab);
  }

  private releaseToUser(tab: ManagedTab): void {
    if (tab.claimable) return;
    if (!tab.userOwner) {
      tab.userOwner = {
        ...tab.owner,
        requestId: `unclaimed:${randomUUID()}`,
        // After release, remove the tab from its controlled browser scope; otherwise tabs.list() in the same session
        // would still treat the user tab as controlled. Keep sessionId/workspaceKey so the owner session can explicitly claim it again.
        browserId: "unclaimed-iab",
        browserGeneration: 0,
        turnId: undefined,
      };
    }
    const claimedScope = scopeKey(tab.owner);
    if (this.activeTabByScope.get(claimedScope) === tab.tabId) {
      this.activeTabByScope.delete(claimedScope);
    }
    if (this.defaultTabByScope.get(claimedScope) === tab.tabId) {
      this.defaultTabByScope.delete(claimedScope);
    }
    tab.owner = { ...tab.userOwner };
    tab.origin = "user";
    tab.claimable = true;
    tab.lifecycle = "active";
  }

  private finalizeTabs(
    context: InternalExecutionContext,
    keep: Map<string, "handoff" | "deliverable">,
  ): void {
    // Product semantics: IAB tabs persist by default within the current ZCode process. keep is a set of state markers,
    // not a cleanup allowlist; do not close an unlisted tab as temporary, or user pages would disappear at turn end unless the model explicitly closed them.
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      const status = keep.get(tab.tabId);
      if (status === "handoff") tab.lifecycle = status;
      else if (status === "deliverable") {
        tab.lifecycle = status;
        this.releaseToUser(tab);
      }
    }
  }

  /**
   * The single source of truth for active in tabs.list(). It means "which tab a command without tabId targets," aligned
   * with resolveTab, not "whether the UI is currently visible"; visibility has a separate browserVisibilitySet/Get channel.
   *
   * A fallback is required: while a session runs in the background, renderer isVisible is always false and it reports
   * only attachGuest({active:false}). No tab in that scope reports active, and activeTabByScope is empty. The CLI's
   * turn-end auto-screenshot searches with tabs.find(t => t.active === true) and has no fallback, so it silently skips
   * screenshots; users see no screenshot when a background session ends. Falling back to the most recent live tab in the
   * scope (matching browserVisibilitySet and the CLI tabs.selected() at(-1) fallback) aligns the reported active tab with the command target.
   */
  private effectiveActiveTabId(owner: InternalExecutionContext): string | undefined {
    const key = scopeKey(owner);
    const activeId = this.activeTabByScope.get(key);
    const activeTab = activeId ? this.tabs.get(activeId) : undefined;
    if (activeTab && activeTab.lifecycle !== "closed") return activeId;
    // Before claim, a human tab sets tab.active but is not added to activeTabByScope. This explicit active state takes
    // precedence over the fallback, and returning immediately ensures only one active=true per scope.
    for (const tab of this.tabs.values()) {
      if (tab.active && tab.lifecycle !== "closed" && sameScope(tab.owner, owner)) return tab.tabId;
    }
    return this.ownedTabs(owner).at(-1)?.tabId;
  }

  private async summary(tab: ManagedTab): Promise<BrowserTabSummary> {
    // While recovery after guest rebind is unfinished, the replacement guest may still report about:blank. Every state
    // read must preserve the logical cache so a temporary guest URL does not overwrite recoverable state.
    if (tab.guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      tab.cachedUrl = safeStr(() => tab.guest!.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => tab.guest!.getTitle(), tab.cachedTitle);
    }
    return {
      tabId: tab.tabId,
      url: tab.cachedUrl,
      title: tab.cachedTitle,
      viewport: await this.readTabViewport(tab),
      ...(this.effectiveActiveTabId(tab.owner) === tab.tabId ? { active: true } : {}),
      ...(tab.lifecycle !== "active" ? { lifecycle: tab.lifecycle } : {}),
    };
  }

  private async readTabViewport(tab: ManagedTab): Promise<BrowserViewportSize> {
    if (tab.viewportOverride) return { ...tab.viewportOverride };
    if (tab.backgroundViewportFallback) {
      // A foreground tab must not remain at the background fallback size. readTabViewport's "return if fallback exists"
      // would reinforce the stale value, pinning the page to the background size and ignoring window resize/fullscreen.
      // Even if both foreground signals (selectTab/reportResidency) are lost, the next viewport read for a foreground tab
      // must self-heal. Return the fallback for this read; recovery completes afterward in the mutation queue.
      if (tab.active) {
        this.maybeRestoreBackgroundViewport(tab);
      }
      return { ...tab.backgroundViewportFallback };
    }
    if (!tab.guest || safeBool(() => tab.guest!.isDestroyed(), true)) {
      return { ...DEFAULT_BACKGROUND_BROWSER_VIEWPORT };
    }
    const value = await tab.guest.executeJavaScript(
      "({ width: window.innerWidth, height: window.innerHeight })",
    );
    if (isBrowserViewportSize(value)) {
      this.naturalViewportByWindow.set(tab.owner.windowId, { ...value });
      return value;
    }

    // A background session keeps the guest but hides the Browser pane with display:none. The first tabs.new() still gets
    // dom-ready/attach but sees only a 0×0 viewport. Hidden is a presentation state and must not block background Browser
    // execution; temporarily reuse the most recent natural size in the same window, then clear the CDP override when foregrounded again.
    const fallback = normalizeBackgroundViewport(
      this.naturalViewportByWindow.get(tab.owner.windowId) ?? DEFAULT_BACKGROUND_BROWSER_VIEWPORT,
    );
    await this.applyBackgroundViewportFallback(tab, fallback);
    this.log?.(
      `[browser-use] applied background viewport fallback tabId=${tab.tabId} width=${fallback.width} height=${fallback.height}`,
    );
    return { ...fallback };
  }

  private userTabInfo(tab: ManagedTab): BrowserUserTabInfo {
    if (tab.guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      tab.cachedUrl = safeStr(() => tab.guest!.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => tab.guest!.getTitle(), tab.cachedTitle);
    }
    return {
      id: tab.tabId,
      ...(tab.cachedUrl ? { url: tab.cachedUrl } : {}),
      ...(tab.cachedTitle ? { title: tab.cachedTitle } : {}),
    };
  }

  private withMeta(
    result: BrowserCommandResult,
    context: InternalExecutionContext,
    tab?: ManagedTab,
    lifecycleOverride?: BrowserResponseMeta["lifecycle"],
  ): BrowserCommandResult {
    const openTabs = this.ownedTabs(context);
    const currentUrl = tab
      ? sanitizeBrowserMetaUrl(
          tab.guest ? safeStr(() => tab.guest!.getURL(), tab.cachedUrl) : tab.cachedUrl,
        )
      : undefined;
    const meta: BrowserResponseMeta = {
      browserUse: true,
      backendType: "iab",
      browserId: context.browserId,
      browserGeneration: context.browserGeneration,
      openTabIds: openTabs.map((candidate) => candidate.tabId),
      ...(tab ? { tabId: tab.tabId } : {}),
      ...(currentUrl ? { currentUrl } : {}),
      ...(lifecycleOverride
        ? { lifecycle: lifecycleOverride }
        : tab
          ? { lifecycle: tab.lifecycle }
          : {}),
    };
    return { ...result, meta };
  }

  private cancelledOrUnavailable(
    context: InternalExecutionContext,
    running: RunningRequest,
    startedAt: number,
    tab: ManagedTab,
  ): BrowserCommandResult {
    if (running.controller.signal.aborted) {
      return this.withMeta(
        this.cancelledResult(context, running.dispatched, startedAt),
        context,
        tab,
      );
    }
    return this.withMeta(
      {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: "browser guest not attached (webview not ready)",
        },
        elapsedMs: Date.now() - startedAt,
      },
      context,
      tab,
    );
  }

  private unavailableTabResult(
    context: InternalExecutionContext,
    tabId: string | undefined,
    startedAt: number,
  ): BrowserCommandResult {
    return this.withMeta(
      {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: tabId
            ? `browser tab '${tabId}' is not visible in the current context. ${TAB_CONTEXT_RECOVERY_HINT}`
            : "browser tab is unavailable",
        },
        elapsedMs: Date.now() - startedAt,
      },
      context,
    );
  }

  private cancelledResult(
    _context: InternalExecutionContext,
    dispatched: boolean,
    startedAt: number,
  ): BrowserCommandResult {
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: dispatched
          ? "browser request cancelled after backend dispatch; side effects may have occurred"
          : "browser request cancelled before backend dispatch",
        sideEffect: dispatched ? "uncertain" : "none",
      },
      elapsedMs: Date.now() - startedAt,
    };
  }

  private abortRequest(requestId: string, context: InternalExecutionContext): boolean {
    const request = this.runningRequests.get(requestId);
    // requestId is a correlation ID, not an authorization credential; cancellation must also enforce the full IAB scope.
    if (!request || !sameScope(request.context, context)) return false;
    request.controller.abort(new DOMException("aborted", "AbortError"));
    return true;
  }

  endTurn(context: InternalExecutionContext, turnId?: string): void {
    this.abortRecordings(
      (entry) =>
        sameScope(entry.context, context) &&
        (turnId === undefined || entry.context.turnId === turnId),
      "turn ended",
    );
    for (const request of this.runningRequests.values()) {
      if (
        sameScope(request.context, context) &&
        (turnId === undefined || request.context.turnId === turnId)
      ) {
        request.controller.abort(new DOMException("turn ended", "AbortError"));
      }
    }
    // Turn end ends requests, not tabs. The old "keep only the final active page" fallback automatically closed later
    // tabs after a handoff, making page survival depend on the model remembering to write finalize JS. Active/handoff tabs
    // are now kept as-is. Deliverable and claimed user tabs still release control according to their explicit lifecycle contract, but the view stays open.
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      if (tab.lifecycle === "handoff") continue;
      if (tab.lifecycle === "deliverable" || tab.origin === "user") this.releaseToUser(tab);
    }
    // Destroying guest WebContents while CDP is still attached (destroyed can arrive directly through many paths,
    // including React unmounting the webview or system behavior) can implicitly destroy DevToolsSession while an in-flight
    // notification causes a main-process UAF. The agent stops operating at turn end, so proactively detach then; this
    // narrows CDP exposure from the tab's entire lifetime to commands in flight during a turn. The next command lazily reattaches via sendGuestCdpCommand.
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      this.releaseGuestCdpAfterIdle(tab, "turn ended");
    }
  }

  private releaseGuestCdpAfterIdle(tab: ManagedTab, reason: string): void {
    const guest = tab.guest;
    if (!guest || tab.guestLifecycle !== "attached") return;
    void (async () => {
      // Detach after in-flight CDP commands (playwright cdp.send / viewport override / dialog handling) finish, avoiding
      // tearing down a pipeline in use. The timeout fallback shares the budget with runGuestTeardown.
      const settled = await this.waitForGuestCdpIdle(tab, DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS);
      if (!settled) {
        this.warn(
          `browser guest cdp release pending timeout tabId=${tab.tabId} ` +
            `pending=${tab.pendingCdpCommands} reason=${reason}`,
        );
      }
      // The tab may be replaced, closed, or receive new commands while waiting; abandon this release attempt in that case.
      if (this.tabs.get(tab.tabId) !== tab || tab.guest !== guest) return;
      if (tab.guestLifecycle !== "attached") return;
      if (tab.pendingCdpCommands > 0) return;
      if (safeBool(() => guest.isDestroyed(), true)) return;
      try {
        if (!guest.debugger.isAttached()) {
          tab.cdpAttached = false;
          return;
        }
        guest.debugger.detach();
        tab.cdpAttached = false;
        this.log?.(`[browser-use] cdp released after ${reason} tabId=${tab.tabId}`);
      } catch (error) {
        this.warn(`browser guest cdp release failed tabId=${tab.tabId} reason=${reason}`, error);
      }
    })();
  }

  /**
   * Command-level idle release: reset the timer after every CDP command and proactively detach when no new command arrives
   * for cdpIdleReleaseMs. The crash window where Chromium kills the guest renderer and render-process-gone is lost (a known
   * Electron gap; observed direct destroyed + CDP attached → main-process UAF) is concentrated between commands in a turn,
   * which turnEnded-level release cannot cover. Dense command streams have gaps far below the threshold and are not interrupted.
   */
  private scheduleGuestCdpIdleRelease(tab: ManagedTab): void {
    if (tab.guestCdpIdleTimer) clearTimeout(tab.guestCdpIdleTimer);
    tab.guestCdpIdleTimer = setTimeout(() => {
      tab.guestCdpIdleTimer = undefined;
      this.releaseGuestCdpAfterIdle(tab, "cdp idle");
    }, this.cdpIdleReleaseMs);
  }

  private clearGuestCdpIdleRelease(tab: ManagedTab): void {
    if (tab.guestCdpIdleTimer) {
      clearTimeout(tab.guestCdpIdleTimer);
      tab.guestCdpIdleTimer = undefined;
    }
  }

  closeSession(context: InternalExecutionContext): void {
    this.abortRecordings((entry) => sameScope(entry.context, context), "session closed");
    for (const request of this.runningRequests.values()) {
      if (sameScope(request.context, context)) {
        request.controller.abort(new DOMException("session closed", "AbortError"));
      }
    }
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      // A session is an ownership boundary, not a lifetime boundary for visible tabs. Keep the view, but keep it bound to
      // the original session after release; do not make it globally unclaimed, or other conversations could discover and claim it through user.openTabs().
      this.releaseToUser(tab);
      // As with endTurn, release CDP when the session ends to remove the main-process UAF window from any later guest destruction path.
      this.releaseGuestCdpAfterIdle(tab, "session closed");
    }
    this.activeTabByScope.delete(scopeKey(context));
    this.defaultTabByScope.delete(scopeKey(context));
    this.sessionNames.delete(scopeKey(context));
    this.visibilityByScope.delete(scopeKey(context));
  }

  closeWindow(windowId: number): void {
    this.abortRecordings((entry) => entry.context.windowId === windowId, "window closed");
    for (const request of this.runningRequests.values()) {
      if (request.context.windowId === windowId) {
        request.controller.abort(new DOMException("window closed", "AbortError"));
      }
    }
    for (const tab of this.tabs.values()) {
      if (tab.owner.windowId !== windowId) continue;
      this.detachAndCloseGuest(tab);
      this.residencyCoordinator.remove(tab.tabId);
      this.restoredTabClaims.delete(tab.tabId);
      // closeWindow takes a fast path and does not call closeTab. If per-tab screenshot state is not cleared here, a late
      // settlement callback can corrupt the count for a new tab reused by recovery under the same tabId. decrement is a
      // no-op for a deleted key, provided the entry is removed here first.
      this.inFlightScreenshots.delete(tab.tabId);
      this.abandonedScreenshotCaptures.delete(tab.tabId);
      this.tabs.delete(tab.tabId);
    }
    this.naturalViewportByWindow.delete(windowId);
  }

  private async removeTabRecovery(tab: ManagedTab): Promise<void> {
    await this.residencyOptions.recoveryStore?.remove(tab.tabId);
  }

  private async closeTabDurably(tab: ManagedTab, notifyRenderer = true): Promise<void> {
    if (tab.lifecycle === "closed") return;
    // The old close returned/notified the renderer first, then deleted the recovery store fire-and-forget. If the app quit
    // immediately, a closed tab could reappear from the old shell. Persist the deletion first; on failure, keep the current logical tab so the caller can retry.
    await this.removeTabRecovery(tab);
    this.closeTab(tab, notifyRenderer);
  }

  private closeTab(tab: ManagedTab, notifyRenderer = true): void {
    if (tab.lifecycle === "closed") return;
    this.abortRecordings((entry) => entry.tabId === tab.tabId, "tab closed");
    tab.lifecycle = "closed";
    this.closedTabIds.add(tab.tabId);
    // The tab can no longer execute commands; do not retain the manager reference for an old CDP capture that may never respond.
    this.inFlightScreenshots.delete(tab.tabId);
    this.abandonedScreenshotCaptures.delete(tab.tabId);
    this.resolveWaiters(tab.tabId, null);
    this.detachAndCloseGuest(tab);
    for (const [downloadId, record] of this.downloads) {
      if (record.tabId === tab.tabId) this.downloads.delete(downloadId);
    }
    this.queuedDownloads.delete(tab.tabId);
    let waiter = this.downloadWaiters.get(tab.tabId)?.[0];
    while (waiter) {
      this.finishDownloadWaiter(tab.tabId, waiter, null);
      waiter = this.downloadWaiters.get(tab.tabId)?.[0];
    }
    const key = scopeKey(tab.owner);
    if (this.activeTabByScope.get(key) === tab.tabId) this.activeTabByScope.delete(key);
    if (this.defaultTabByScope.get(key) === tab.tabId) this.defaultTabByScope.delete(key);
    if (notifyRenderer) this.onCloseTabRequested?.(tab.tabId, tab.owner);
    this.residencyCoordinator.remove(tab.tabId);
    this.restoredTabClaims.delete(tab.tabId);
    this.tabs.delete(tab.tabId);
  }

  /**
   * Immediately disconnect CDP when the guest renderer crashes or is killed.
   *
   * Crash sequence (main-process UAF; minidump at DevToolsSession::DispatchProtocolNotification with client_ vptr = 0):
   *   Chromium kills the guest renderer under memory pressure
   *     → render-process-gone: WebContents still exists and CDP remains attached
   *     → renderer increments webviewGeneration and React unmounts the old <webview>
   *     → old WebContents is destroyed; api::Debugger is implicitly destroyed
   *     → DevToolsSession still holds client_ and dispatches an in-flight notification → UAF → main-process crash → app exits
   *
   * Observed with Electron 41.0.3 / forcefullyCrashRenderer in a timestamped control experiment:
   *   - At render-process-gone, isDestroyed()=false, isCrashed()=true, and isAttached()=true; detach() succeeds and
   *     isAttached() becomes false afterward.
   *   - At destroyed, isCrashed()/isAttached() both throw "Object has been destroyed"; detach is no longer possible,
   *     so a destroyed fallback cannot fix this UAF.
   *   - After a crash, if <webview> remains mounted, WebContents stays crashed indefinitely (no destroyed after 10s).
   *     Once the renderer unmounts <webview>, destroyed arrives in about 5ms. The renderer controls destruction timing,
   *     and the safe window for native detach exists only before WebContents is destroyed.
   * Main's render-process-gone handler is the first guard; an explicit detach ACK before renderer recreation is the second
   * barrier, covering cases where the main event did not arrive. Neither changes destruction timing; both ensure CDP is disconnected first.
   */
  private setupCdpCrashGuard(tab: ManagedTab, guest: GuestWebContents): void {
    tab.crashGuardCleanup?.();
    if (!guest.on || !guest.removeListener) return;
    const tabId = tab.tabId;
    const onRenderProcessGone = (...args: unknown[]): void => {
      const reason = safeStr(
        () => String((args[1] as { reason?: string } | undefined)?.reason ?? "unknown"),
        "unknown",
      );
      const guestId = safeStr(() => String(guest.id), "?");
      // Do not require tab.guest === guest: disconnecting CDP for a replaced guest is still correct and necessary;
      // skipping it would leave the UAF window open.
      try {
        if (this.tabs.get(tabId)?.guest === guest) tab.guestLifecycle = "detaching";
        if (!guest.debugger.isAttached()) return;
        guest.debugger.detach();
        this.log?.(
          `[browser-use] cdp detached on render-process-gone tabId=${tabId} ` +
            `guestId=${guestId} reason=${reason}`,
        );
      } catch (error) {
        // Failure here means the UAF window was not closed; record it so it can be correlated with a later crash.
        this.warn(
          `browser guest cdp detach on render-process-gone failed tabId=${tabId} ` +
            `guestId=${guestId} reason=${reason}`,
          error,
        );
      } finally {
        if (this.tabs.get(tabId)?.guest === guest) tab.cdpAttached = false;
      }
    };
    guest.on("render-process-gone", onRenderProcessGone);
    tab.crashGuardCleanup = () => {
      guest.removeListener?.("render-process-gone", onRenderProcessGone);
    };
  }

  private setupDialogTracking(tab: ManagedTab, guest: GuestWebContents): void {
    const tabId = tab.tabId;
    void this.sendGuestCdpCommand(tab, guest, "Page.enable").catch((error: unknown) => {
      this.log?.(`[browser-use] Page.enable failed tabId=${tabId}: ${String(error)}`);
    });
    const onMessage = (_event: unknown, method: string, params: unknown): void => {
      const current = this.tabs.get(tabId);
      if (!current || current.guest !== guest || current.lifecycle === "closed") return;
      if (method === "Page.javascriptDialogOpening") {
        // Timestamp when the dialog event reaches main, to distinguish an "event black hole" from getDialog=null because
        // the dialog was cleared by detach.
        this.log?.(`[browser-use] dialog opening event received tabId=${tabId}`);
        const data = (params ?? {}) as {
          type?: string;
          message?: string;
          defaultPrompt?: string;
        };
        const dialog: BrowserDialog = {
          type: normalizeDialogType(data.type),
          message: typeof data.message === "string" ? data.message : "",
          ...(typeof data.defaultPrompt === "string" ? { defaultPrompt: data.defaultPrompt } : {}),
        };
        this.pendingDialogs.set(tabId, dialog);
      } else if (method === "Page.javascriptDialogClosed") {
        this.pendingDialogs.delete(tabId);
      }
    };
    guest.debugger.on("message", onMessage);
    tab.cdpMessageCleanup = () => {
      guest.debugger.removeListener("message", onMessage);
    };
  }

  private applyViewportOverride(tab: ManagedTab): void {
    const viewport = tab.viewportOverride;
    if (!viewport) return;
    void this.setTabViewport(tab, viewport).catch((error: unknown) => {
      this.log?.(`[browser-use] viewport apply failed tabId=${tab.tabId}: ${String(error)}`);
    });
  }

  private async setTabViewport(tab: ManagedTab, viewport: BrowserViewportSize): Promise<void> {
    assertViewportOverride(viewport);
    if (tab.lifecycle === "closed") return;
    tab.backgroundViewportFallback = undefined;
    tab.viewportOverride = { ...viewport };
    if (!tab.guest) return;
    const guest = tab.guest;
    await this.enqueueViewportMutation(tab, async () => {
      if (tab.guest !== guest || tab.lifecycle === "closed") return;
      await this.sendGuestCdpCommand(
        tab,
        guest,
        "Emulation.setDeviceMetricsOverride",
        buildViewportMetricsOverride(viewport, tab.desktopZoomFactor),
      );
    });
  }

  private async resetTabViewport(tab: ManagedTab): Promise<void> {
    if (tab.lifecycle === "closed") return;
    tab.viewportOverride = undefined;
    tab.desktopZoomFactor = undefined;
    tab.backgroundViewportFallback = undefined;
    if (!tab.guest) return;
    const guest = tab.guest;
    await this.enqueueViewportMutation(tab, async () => {
      if (tab.guest !== guest || tab.lifecycle === "closed") return;
      await this.sendGuestCdpCommand(tab, guest, "Emulation.clearDeviceMetricsOverride");
    });
  }

  private async applyBackgroundViewportFallback(
    tab: ManagedTab,
    viewport: BrowserViewportSize,
  ): Promise<void> {
    const guest = tab.guest;
    if (!guest || tab.lifecycle === "closed") {
      throw new Error(`browser tab '${tab.tabId}' has no readable viewport`);
    }
    const fallback = { ...viewport };
    tab.backgroundViewportFallback = fallback;
    try {
      await this.enqueueViewportMutation(tab, async () => {
        if (
          tab.guest !== guest ||
          tab.lifecycle === "closed" ||
          tab.backgroundViewportFallback !== fallback ||
          tab.viewportOverride
        ) {
          return;
        }
        await this.sendGuestCdpCommand(
          tab,
          guest,
          "Emulation.setDeviceMetricsOverride",
          buildViewportMetricsOverride(fallback, guest.hostWebContents?.getZoomFactor()),
        );
      });
    } catch (error) {
      if (tab.backgroundViewportFallback === fallback) {
        tab.backgroundViewportFallback = undefined;
      }
      throw error;
    }
  }

  /**
   * Shared foreground activation path: a background fallback viewport must not remain after a tab returns to the foreground.
   * Clearing it only during attachGuest({active:true}) is insufficient: foreground switches while the guest is alive
   * (activateTab / claim / renderer residency report) do not reattach, leaving the page permanently stuck at background size.
   * restoreNaturalViewportAfterBackground has an idempotency guard and serialized mutation queue, so repeated foreground signals are safe.
   */
  private maybeRestoreBackgroundViewport(tab: ManagedTab): void {
    if (tab.lifecycle === "closed" || !tab.backgroundViewportFallback) return;
    this.restoreNaturalViewportAfterBackground(tab);
  }

  private restoreNaturalViewportAfterBackground(tab: ManagedTab): void {
    const fallback = tab.backgroundViewportFallback;
    const guest = tab.guest;
    if (!fallback || tab.viewportOverride || !guest) return;
    void this.enqueueViewportMutation(tab, async () => {
      if (
        tab.guest !== guest ||
        tab.lifecycle === "closed" ||
        tab.backgroundViewportFallback !== fallback ||
        tab.viewportOverride
      ) {
        return;
      }
      await this.sendGuestCdpCommand(tab, guest, "Emulation.clearDeviceMetricsOverride");
      if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return;
      const value = await guest.executeJavaScript(
        "({ width: window.innerWidth, height: window.innerHeight })",
      );
      if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return;
      if (isBrowserViewportSize(value)) {
        this.naturalViewportByWindow.set(tab.owner.windowId, { ...value });
        tab.backgroundViewportFallback = undefined;
        return;
      }
      // If active=true arrives before Chromium completes visible layout, keep the transient value. The next visible renderer
      // attach or viewport read can still recover; do not briefly fall back to 0×0.
      await this.sendGuestCdpCommand(
        tab,
        guest,
        "Emulation.setDeviceMetricsOverride",
        buildViewportMetricsOverride(fallback, guest.hostWebContents?.getZoomFactor()),
      );
    }).catch((error: unknown) => {
      this.log?.(
        `[browser-use] background viewport restore failed tabId=${tab.tabId}: ${String(error)}`,
      );
    });
  }

  private enqueueViewportMutation(tab: ManagedTab, mutation: () => Promise<void>): Promise<void> {
    const previous = tab.viewportMutation ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        // CDP recovery uses this to replay directly inside the current critical section instead of requeueing and waiting on itself.
        tab.insideViewportMutation = true;
        try {
          await mutation();
        } finally {
          tab.insideViewportMutation = false;
        }
      });
    tab.viewportMutation = current;
    current.then(
      () => {
        if (tab.viewportMutation === current) tab.viewportMutation = undefined;
      },
      () => {
        if (tab.viewportMutation === current) tab.viewportMutation = undefined;
      },
    );
    return current;
  }

  private setupDownloadTracking(tab: ManagedTab, guest: GuestWebContents): void {
    tab.downloadCleanup?.();
    if (!guest.session) return;
    const listener = (_event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => {
      if (contents !== guest || tab.guest !== guest || tab.lifecycle === "closed") return;
      const downloadId = `iab-download:${randomUUID()}`;
      const record: DownloadRecord = {
        tabId: tab.tabId,
        path: safeStr(() => item.getSavePath(), "") || null,
        state: "pending",
      };
      this.downloads.set(downloadId, record);
      this.refreshRuntimeProtection(tab.tabId);
      item.once("done", (_event, state) => {
        record.path = safeStr(() => item.getSavePath(), "") || record.path;
        record.state =
          state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
        this.refreshRuntimeProtection(tab.tabId);
      });
      const waiters = this.downloadWaiters.get(tab.tabId);
      const waiter = waiters?.shift();
      if (waiter) {
        this.finishDownloadWaiter(tab.tabId, waiter, downloadId);
      } else {
        const queued = this.queuedDownloads.get(tab.tabId) ?? [];
        queued.push(downloadId);
        this.queuedDownloads.set(tab.tabId, queued);
      }
    };
    guest.session.on("will-download", listener);
    tab.downloadCleanup = () => guest.session?.removeListener("will-download", listener);
  }

  private waitForDownload(
    tabId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    const queued = this.queuedDownloads.get(tabId);
    const existing = queued?.shift();
    if (existing) return Promise.resolve(existing);
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = {} as DownloadWaiter;
      waiter.resolve = resolve;
      waiter.signal = signal;
      waiter.timer = setTimeout(() => this.finishDownloadWaiter(tabId, waiter, null), timeoutMs);
      waiter.onAbort = () => this.finishDownloadWaiter(tabId, waiter, null);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      const waiters = this.downloadWaiters.get(tabId) ?? [];
      waiters.push(waiter);
      this.downloadWaiters.set(tabId, waiters);
    });
  }

  private finishDownloadWaiter(
    tabId: string,
    waiter: DownloadWaiter,
    downloadId: string | null,
  ): void {
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    const waiters = this.downloadWaiters.get(tabId);
    if (waiters) {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      if (waiters.length === 0) this.downloadWaiters.delete(tabId);
    }
    waiter.resolve(downloadId);
  }

  /**
   * Attach and restore CDP session state when commands resume after idle/turn-end release.
   * Return an awaitable flight; business commands may dispatch only after Page.enable and viewport overrides are replayed.
   *
   * Page-domain enable and Emulation.setDeviceMetricsOverride are per-session and Chromium clears them on detach.
   * A bare attach("1.3") therefore gets a clean session: dialog events disappear (getDialog stays null; evaluate on a JS
   * dialog was observed to hang until timeout at 62s), and viewport emulation diverges from the manager cache. Fire-and-forget
   * replay also provides no barrier, so business commands (screenshot/evaluate) may run before restoration finishes and the
   * replay fails for the first command. Send recovery commands raw (without ensure) to avoid self-waiting. Replay viewport
   * state through the existing serial queue; if recovery is triggered inside that queue, replay directly to avoid a deadlock
   * from requeueing and waiting on the current flight.
   */
  private async ensureGuestCdpAttached(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    if (!tab.guestCdpRestoreFlight) {
      const flight = this.runGuestCdpSessionRestore(tab, guest).finally(() => {
        if (tab.guestCdpRestoreFlight === flight) tab.guestCdpRestoreFlight = undefined;
      });
      tab.guestCdpRestoreFlight = flight;
    }
    await tab.guestCdpRestoreFlight;
  }

  private async runGuestCdpSessionRestore(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    if (!safeBool(() => guest.debugger.isAttached(), false)) {
      guest.debugger.attach("1.3");
      tab.cdpAttached = safeBool(() => guest.debugger.isAttached(), false);
      if (!tab.cdpAttached) {
        throw new Error(`browser guest cdp restore attach failed tabId=${tab.tabId}`);
      }
    }
    // Recovery failures must propagate: the barrier contract allows business commands only after Page.enable and viewport
    // state are ready. Swallowing an error would make later commands skip recovery whenever they see attached; a missing
    // Page.enable would suppress dialog events for the entire attach period, and a "replayed" log would mislead debugging.
    // Before propagating the error, roll back to detached. A partially restored session is unusable; restoring the released
    // state lets the next command start a new recovery flight (otherwise attached=true would make lazy attach skip recovery permanently).
    try {
      await this.sendGuestCdpCommandRaw(tab, guest, "Page.enable");
    } catch (error) {
      this.warn(`browser guest Page.enable replay failed tabId=${tab.tabId}`, error);
      this.rollbackGuestCdpRestore(tab, guest);
      throw error;
    }
    const viewport = tab.viewportOverride ?? tab.backgroundViewportFallback;
    if (viewport) {
      try {
        const replayViewport = async () => {
          if (tab.guest !== guest || tab.lifecycle === "closed") return;
          await this.sendGuestCdpCommandRaw(
            tab,
            guest,
            "Emulation.setDeviceMetricsOverride",
            buildViewportMetricsOverride(
              viewport,
              tab.viewportOverride ? tab.desktopZoomFactor : guest.hostWebContents?.getZoomFactor(),
            ),
          );
        };
        // Screenshots also use the viewport queue but do not reset metrics. Treating every re-attach inside the queue as
        // already restored would make the first screenshot read the host-scaled natural size. Replay directly when already
        // in the critical section; requeueing and waiting on itself would deadlock.
        if (tab.insideViewportMutation) await replayViewport();
        else await this.enqueueViewportMutation(tab, replayViewport);
      } catch (error) {
        this.warn(`browser guest viewport replay failed tabId=${tab.tabId}`, error);
        this.rollbackGuestCdpRestore(tab, guest);
        throw error;
      }
    }
    this.log?.(`[browser-use] cdp session state replayed tabId=${tab.tabId} pageEnable=1`);
  }

  /** Restore a partially recovered session to the released state; a rollback failure must not mask the original error. */
  private rollbackGuestCdpRestore(tab: ManagedTab, guest: GuestWebContents): void {
    try {
      if (guest.debugger.isAttached()) guest.debugger.detach();
    } catch {
      // The session may already be destroyed; cdpAttached still needs to be reset.
    }
    tab.cdpAttached = false;
  }

  /** Send a recovery command by updating pending count and dispatching only; do not trigger ensure and self-wait deadlock. */
  private async sendGuestCdpCommandRaw(
    tab: ManagedTab,
    guest: GuestWebContents,
    method: string,
    params?: unknown,
    sessionId?: string,
  ): Promise<unknown> {
    tab.pendingCdpCommands += 1;
    try {
      const result = await guest.debugger.sendCommand(method, params, sessionId);
      if (!sessionId && tab.guest === guest) {
        if (method === "Emulation.setDeviceMetricsOverride") {
          tab.appliedViewportScale = normalizeDesktopZoomMetricsScale(
            (params as { scale?: number }).scale,
          );
          // Electron may overwrite the renderer's normalization callback during later page-zoom propagation.
          // Both fixed viewport updates and CDP reconnects must restore guest zoom at the same execution boundary.
          if (guest.getZoomFactor() !== 1) guest.setZoomFactor(1);
        } else if (method === "Emulation.clearDeviceMetricsOverride") {
          tab.appliedViewportScale = undefined;
        }
      }
      return result;
    } finally {
      tab.pendingCdpCommands = Math.max(0, tab.pendingCdpCommands - 1);
      this.scheduleGuestCdpIdleRelease(tab);
    }
  }

  private async sendGuestCdpCommand(
    tab: ManagedTab,
    guest: GuestWebContents,
    method: string,
    params?: unknown,
    sessionId?: string,
    assertCurrentGuest?: () => void,
  ): Promise<unknown> {
    assertCurrentGuest?.();
    if (tab.guest !== guest || tab.guestLifecycle !== "attached") {
      throw new Error("browser guest is detaching");
    }
    // CDP is proactively released after turnEnded/closeSession/command idle to prevent a main-process UAF if the guest
    // is destroyed. This command path reattaches and awaits session-state replay (an explicit serial barrier ensures
    // Page.enable / viewport overrides reach Chromium before this command).
    if (!safeBool(() => guest.debugger.isAttached(), false) || tab.guestCdpRestoreFlight) {
      await this.ensureGuestCdpAttached(tab, guest);
    }
    // The native-raster metrics scale also affects CDP mouse input. Tools, locators, and screenshots remain in CSS pixels;
    // compensate for positions and wheel distance at the single guest dispatch boundary to avoid duplicate conversions in each API.
    const scale = tab.appliedViewportScale ?? 1;
    if (!sessionId && method === "Input.dispatchMouseEvent" && scale !== 1 && params) {
      const event = { ...(params as Record<string, unknown>) };
      for (const key of ["x", "y", "deltaX", "deltaY"]) {
        if (typeof event[key] === "number") event[key] *= scale;
      }
      params = event;
    }
    return this.sendGuestCdpCommandRaw(tab, guest, method, params, sessionId);
  }

  private toControlledView(
    guest: GuestWebContents,
    normalizeScreenshotToCssPixels = false,
    captureViewportScreenshot: ControlledView["captureViewportScreenshot"] | undefined,
    assertCurrentGuest: () => void,
    sendCdpCommand: ControlledView["cdp"]["send"],
  ): ControlledView {
    const assertCurrent = () => assertCurrentGuest();
    return {
      webContents: {
        loadURL: (url) => {
          assertCurrent();
          return guest.loadURL(url);
        },
        getURL: () => {
          assertCurrent();
          return guest.getURL();
        },
        getTitle: () => {
          assertCurrent();
          return guest.getTitle();
        },
        canGoBack: () => {
          assertCurrent();
          return guest.navigationHistory.canGoBack();
        },
        canGoForward: () => {
          assertCurrent();
          return guest.navigationHistory.canGoForward();
        },
        goBack: () => {
          assertCurrent();
          return guest.navigationHistory.goBack();
        },
        goForward: () => {
          assertCurrent();
          return guest.navigationHistory.goForward();
        },
        reload: () => {
          assertCurrent();
          return guest.reload();
        },
        executeJavaScript: (script) => {
          assertCurrent();
          return guest.executeJavaScript(script, true);
        },
      },
      cdp: {
        send: (method, params, sessionId) => {
          try {
            assertCurrent();
            return sendCdpCommand(method, params, sessionId);
          } catch (error) {
            // CDP consumers call .catch directly on abort/terminate paths; the lifecycle guard must return a rejected
            // Promise and must not throw synchronously, which would break cleanup.
            return Promise.reject(error);
          }
        },
      },
      captureViewportScreenshot,
      normalizeScreenshotToCssPixels,
      resizeScreenshotToCssPixels: this.resizeScreenshotToCssPixels,
    };
  }

  private registerTabResidency(
    tab: ManagedTab,
    visible: boolean,
    residency: BrowserTabResidencyRecord["residency"] = visible
      ? "live-visible"
      : "live-background",
    lastSelectedAt: number | null = null,
  ): void {
    this.residencyCoordinator.upsert({
      tabId: tab.tabId,
      windowId: tab.owner.windowId,
      sessionId: tab.owner.sessionId,
      residency,
      guestAttached: Boolean(tab.guest && !safeBool(() => tab.guest!.isDestroyed(), true)),
      openedAt: tab.openedAt,
      lastActivityAt: tab.openedAt,
      lastSelectedAt,
      preferred: visible,
      currentTask: false,
      selected: visible,
      visible,
      operationActive: false,
      captureActive: false,
      audible: false,
      mediaActive: false,
      loading: false,
      downloadActive: false,
    });
  }

  private async closeTabForLimit(record: BrowserTabResidencyRecord): Promise<boolean> {
    const tab = this.tabs.get(record.tabId);
    if (!tab || tab.lifecycle === "closed") return true;
    try {
      // The old count limit destroyed WebContents but kept suspended logical tabs, so the tab bar could exceed 32.
      // Reuse durable close and fully close in order: recovery data → guest → renderer tab shell. This prevents a closed tab
      // from reappearing in the current UI or on the next launch.
      await this.closeTabDurably(tab);
      this.log?.(
        `[browser-use] closed tabId=${tab.tabId} reason=tab-limit windowId=${tab.owner.windowId}`,
      );
      return true;
    } catch (error) {
      this.warn(`browser tab limit close failed tabId=${tab.tabId}`, error);
      return false;
    }
  }

  private async restoreSuspendedGuest(
    tab: ManagedTab,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    if (signal.aborted) return null;
    let flight = this.restoreFlights.get(tab.tabId);
    if (!flight) {
      // The old single-flight used the first caller's AbortSignal; cancelling that first command poisoned all concurrent
      // callers and left the coordinator in restoring. The tab lifecycle now owns the flight.
      flight = this.runRestoreSuspendedGuest(tab, new AbortController().signal).finally(() => {
        if (this.restoreFlights.get(tab.tabId) === flight) this.restoreFlights.delete(tab.tabId);
      });
      this.restoreFlights.set(tab.tabId, flight);
    }
    const result = await waitForPromiseWithSignal(flight, signal);
    return result.completed ? result.value : null;
  }

  private async runRestoreSuspendedGuest(
    tab: ManagedTab,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    const before = this.residencyCoordinator.get(tab.tabId);
    const transition = this.residencyCoordinator.markRestoring(tab.tabId);
    if (!transition) return null;
    if (before?.residency === "suspended") {
      const payload: BrowserViewResidencyTransitionPayload = {
        tabId: tab.tabId,
        workspaceKey: tab.owner.workspaceKey,
        remoteSessionId: tab.owner.remoteSessionId,
        sessionId: tab.owner.sessionId,
        browserId: tab.owner.browserId,
        browserGeneration: tab.owner.browserGeneration,
        generation: transition.generation,
        residency: "restoring",
      };
      if (this.residencyOptions.onRestoreTabRequested) {
        this.residencyOptions.onRestoreTabRequested(payload);
      } else {
        this.onOpenTabRequested?.(tab.tabId, tab.owner);
      }
    }

    const guest = await this.waitForGuest(tab.tabId, signal);
    if (!guest) {
      const failed = this.residencyCoordinator.failRestore(tab.tabId, transition.generation);
      if (failed) {
        // Tell the renderer to return to the lightweight shell; the new generation also makes late attaches from this attempt fail closed.
        this.residencyOptions.onSuspendTabRequested?.({
          tabId: tab.tabId,
          workspaceKey: tab.owner.workspaceKey,
          remoteSessionId: tab.owner.remoteSessionId,
          sessionId: tab.owner.sessionId,
          browserId: tab.owner.browserId,
          browserGeneration: tab.owner.browserGeneration,
          generation: failed.generation,
          residency: "suspended",
        });
      }
      return null;
    }
    const restored = await this.restoreGuestState(tab, guest);
    if (!restored && tab.restoredFromStore && !tab.cachedUrl) {
      // Clean up an orphan only after a forced restore mount when all three recovery facts are missing. Ordinary page-state
      // eviction retains restoreUrl and must not enter this branch, or it would create a restore/close loop.
      await this.removeTabRecovery(tab);
      this.residencyOptions.onRecoveryOrphanCloseRequested?.({
        tabId: tab.tabId,
        reason: "recovery-orphan",
      });
      this.closeTab(tab, false);
      return null;
    }
    if (!restored) {
      // Do not handle only the case where all recovery facts are missing. If history and URL both fail but the guest is
      // committed as live, bootstrap/about:blank would be treated as a successful page permanently. On failure, destroy
      // this guest and return to a retryable shell.
      const failed = this.residencyCoordinator.failRestore(tab.tabId, transition.generation);
      this.detachAndCloseGuest(tab);
      if (failed) {
        this.residencyOptions.onSuspendTabRequested?.({
          tabId: tab.tabId,
          workspaceKey: tab.owner.workspaceKey,
          remoteSessionId: tab.owner.remoteSessionId,
          sessionId: tab.owner.sessionId,
          browserId: tab.owner.browserId,
          browserGeneration: tab.owner.browserGeneration,
          generation: failed.generation,
          residency: "suspended",
        });
      }
      return null;
    }
    if (!this.residencyCoordinator.completeRestore(tab.tabId, transition.generation)) return null;
    const completed = this.residencyCoordinator.get(tab.tabId);
    if (completed) {
      // The renderer previously received only the restoring start and no terminal state on success, leaving the shell stuck restoring.
      this.residencyOptions.onResidencyChanged?.({
        tabId: tab.tabId,
        workspaceKey: tab.owner.workspaceKey,
        remoteSessionId: tab.owner.remoteSessionId,
        sessionId: tab.owner.sessionId,
        browserId: tab.owner.browserId,
        browserGeneration: tab.owner.browserGeneration,
        generation: completed.generation,
        residency: completed.residency === "live-visible" ? "live-visible" : "live-background",
      });
    }
    tab.restoredFromStore = false;
    await this.persistShell(tab);
    return guest;
  }

  private async restoreGuestState(tab: ManagedTab, guest: GuestWebContents): Promise<boolean> {
    const pageState = await this.residencyOptions.recoveryStore?.getPageState(tab.tabId);
    if (pageState && pageState.entries.length > 0) {
      const activePageState = pageState.entries[pageState.activeIndex];
      if (tab.cachedUrl && activePageState?.url !== tab.cachedUrl) {
        // pageState is refreshed only when the budget suspends a tab. After recovery, navigation updates the shell but leaves
        // the old snapshot. Cold start must use the logical shell's current URL and must not roll B back to snapshot URL A.
        this.warn(
          `browser tab stale page-state ignored tabId=${tab.tabId} shellUrl=${tab.cachedUrl} pageStateUrl=${activePageState?.url ?? "missing"}`,
        );
        await this.residencyOptions.recoveryStore?.removePageState(tab.tabId);
      } else {
        const acceptRestoredPageState = () => {
          const active = pageState.entries[pageState.activeIndex];
          tab.cachedUrl = active?.url ?? tab.cachedUrl;
          tab.cachedTitle = active?.title ?? tab.cachedTitle;
          return true;
        };
        try {
          this.log?.(
            `[browser-use] restore page-state start tabId=${tab.tabId} index=${pageState.activeIndex} entries=${JSON.stringify(pageState.entries.map((entry) => entry.url))}`,
          );
          await guest.navigationHistory.restore({
            entries: pageState.entries.map((entry) => ({ ...entry })),
            index: pageState.activeIndex,
          });
          this.log?.(
            `[browser-use] restore page-state complete tabId=${tab.tabId} url=${safeStr(() => guest.getURL(), "")} index=${safeStr(() => String(guest.navigationHistory.getActiveIndex()), "unknown")} entries=${safeStr(() => JSON.stringify(guest.navigationHistory.getAllEntries().map((entry) => entry.url)), "unknown")}`,
          );
          return acceptRestoredPageState();
        } catch (error) {
          const restoreAppliedDespiteAbort =
            String(error).includes("ERR_ABORTED") &&
            safeBool(() => {
              const actualEntries = guest.navigationHistory.getAllEntries();
              return (
                guest.navigationHistory.getActiveIndex() === pageState.activeIndex &&
                actualEntries.length === pageState.entries.length &&
                actualEntries.every((entry, index) => entry.url === pageState.entries[index]?.url)
              );
            }, false);
          if (restoreAppliedDespiteAbort) {
            // Electron 41 may report ERR_ABORTED for the default about:blank even after full history was written.
            // Trust the actual navigationHistory to avoid deleting valid pageState and starting a second URL navigation.
            return acceptRestoredPageState();
          }
          this.warn(`browser tab page-state restore failed tabId=${tab.tabId}`, error);
          await this.residencyOptions.recoveryStore?.removePageState(tab.tabId);
        }
      }
    }
    if (!tab.cachedUrl) return false;
    try {
      await guest.loadURL(tab.cachedUrl);
      return true;
    } catch (error) {
      this.warn(`browser tab URL restore failed tabId=${tab.tabId}`, error);
      return false;
    }
  }

  private async restoreReboundGuest(
    tab: ManagedTab,
    guest: GuestWebContents,
  ): Promise<GuestWebContents | null> {
    if (tab.lifecycle === "closed" || tab.guest !== guest) return null;
    const restored = await this.restoreGuestState(tab, guest);
    if (!restored || tab.lifecycle === "closed" || tab.guest !== guest) {
      if (tab.lifecycle !== "closed" && tab.guest === guest) {
        this.warn(`browser tab guest rebind restore failed tabId=${tab.tabId}`);
      }
      return null;
    }
    this.log?.(
      `[browser-use] guest rebind restore complete tabId=${tab.tabId} url=${tab.cachedUrl}`,
    );
    await this.persistShell(tab);
    return guest;
  }

  private async persistRecoverySnapshot(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
    tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    await this.persistShell(tab);
    try {
      const entries = guest.navigationHistory.getAllEntries().map((entry) => ({ ...entry }));
      if (entries.length === 0) return;
      const pageState: BrowserTabPageStateRecord = {
        schemaVersion: 1,
        tabId: tab.tabId,
        entries,
        activeIndex: guest.navigationHistory.getActiveIndex(),
        updatedAt: this.now(),
      };
      await this.residencyOptions.recoveryStore?.upsertPageState(pageState);
    } catch (error) {
      // Snapshot failure must not let the resource budget remain exceeded indefinitely; the shell's restoreUrl was saved first.
      this.warn(`browser tab page-state snapshot failed tabId=${tab.tabId}`, error);
    }
  }

  private async persistShell(tab: ManagedTab): Promise<void> {
    const store = this.residencyOptions.recoveryStore;
    if (!store || tab.lifecycle === "closed") return;
    const residency = this.residencyCoordinator.get(tab.tabId);
    const record: BrowserTabShellRecord = {
      schemaVersion: 1,
      tabId: tab.tabId,
      windowBindingId: null,
      workspaceKey: tab.owner.workspaceKey,
      ...(tab.owner.remoteSessionId ? { remoteSessionId: tab.owner.remoteSessionId } : {}),
      sessionId: tab.owner.sessionId,
      browserId: tab.owner.browserId,
      browserGeneration: tab.owner.browserGeneration,
      origin: tab.origin,
      lifecycle: tab.lifecycle,
      restoreUrl: tab.cachedUrl || null,
      title: tab.cachedTitle || null,
      faviconUrl: tab.cachedFaviconUrl,
      viewport: tab.viewportOverride ? { ...tab.viewportOverride } : null,
      openedAt: tab.openedAt,
      lastSelectedAt: residency?.lastSelectedAt ?? null,
      updatedAt: this.now(),
    };
    try {
      await store.upsert(record);
    } catch (error) {
      this.warn(`browser tab shell persist failed tabId=${tab.tabId}`, error);
    }
  }

  private requireRendererOwnedTab(
    payload: BrowserViewCloseTabRequest & { windowId: number },
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab;
  private requireRendererOwnedTab(
    payload: BrowserViewResidencyReportPayload & { windowId: number },
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab;
  private requireRendererOwnedTab(
    payload:
      | (BrowserViewCloseTabRequest & { windowId: number })
      | (BrowserViewResidencyReportPayload & { windowId: number }),
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab {
    const tab = this.tabs.get(payload.tabId);
    if (
      !tab ||
      tab.lifecycle === "closed" ||
      tab.owner.windowId !== payload.windowId ||
      tab.owner.workspaceKey !== payload.workspaceKey ||
      tab.owner.sessionId !== payload.sessionId ||
      (!options?.skipRemoteSession &&
        (tab.owner.remoteSessionId ?? "") !== (payload.remoteSessionId ?? ""))
    ) {
      throw new Error(`browser tab '${payload.tabId}' is unavailable for renderer scope`);
    }
    return tab;
  }

  private setupActivityTracking(tab: ManagedTab, guest: GuestWebContents): void {
    tab.activityCleanup?.();
    if (!guest.on || !guest.removeListener) return;
    const onLoadingStarted = () => {
      if (tab.guest !== guest) return;
      tab.loading = true;
      this.refreshRuntimeProtection(tab.tabId);
    };
    const onLoadingStopped = () => {
      if (tab.guest !== guest) return;
      tab.loading = false;
      if (!this.guestRecoveryFlights.has(tab.tabId)) {
        tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
        tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
      }
      this.refreshRuntimeProtection(tab.tabId);
      void this.persistShell(tab);
    };
    const onAudioChanged = () => this.refreshRuntimeProtection(tab.tabId);
    const onMediaStarted = () => {
      if (tab.guest !== guest) return;
      tab.mediaActive = true;
      this.refreshRuntimeProtection(tab.tabId);
    };
    const onMediaPaused = () => {
      if (tab.guest !== guest) return;
      tab.mediaActive = false;
      this.refreshRuntimeProtection(tab.tabId);
    };
    guest.on("did-start-loading", onLoadingStarted);
    guest.on("did-stop-loading", onLoadingStopped);
    guest.on("audio-state-changed", onAudioChanged);
    guest.on("media-started-playing", onMediaStarted);
    guest.on("media-paused", onMediaPaused);
    tab.activityCleanup = () => {
      guest.removeListener?.("did-start-loading", onLoadingStarted);
      guest.removeListener?.("did-stop-loading", onLoadingStopped);
      guest.removeListener?.("audio-state-changed", onAudioChanged);
      guest.removeListener?.("media-started-playing", onMediaStarted);
      guest.removeListener?.("media-paused", onMediaPaused);
    };
  }

  private refreshRuntimeProtection(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.residencyCoordinator.report(tabId, {
      loading: tab.loading,
      operationActive: this.hasRunningRequestForTab(tabId),
      captureActive: this.isTabCaptureActive(tab),
      audible: safeBool(() => tab.guest?.isCurrentlyAudible?.() ?? false, false),
      mediaActive: tab.mediaActive,
      downloadActive: this.hasPendingDownloadForTab(tabId),
    });
  }

  private hasRunningRequestForTab(tabId: string): boolean {
    return [...this.runningRequests.values()].some((request) => request.tabId === tabId);
  }

  private isTabCaptureActive(tab: ManagedTab): boolean {
    return (
      this.inFlightScreenshots.has(tab.tabId) ||
      [...this.recordings.values()].some(
        (entry) => entry.tabId === tab.tabId && entry.status === "running",
      ) ||
      safeBool(() => tab.guest?.isBeingCaptured?.() ?? false, false)
    );
  }

  private hasPendingDownloadForTab(tabId: string): boolean {
    return [...this.downloads.values()].some(
      (record) => record.tabId === tabId && record.state === "pending",
    );
  }

  private detachAndCloseGuest(tab: ManagedTab): void {
    const guest = tab.guest;
    // Closing first would make the destroyed event and later listener cleanup operate on a destroyed object, causing
    // Electron to repeatedly log "Object has been destroyed". Tear down CDP/session/listeners first, then close the saved
    // WebContents reference. This releases the actual renderer without changing the logical tab lifecycle.
    this.detachGuest(tab);
    this.closeGuestWebContents(tab, guest);
  }

  private rejectGuestAttach(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: BrowserGuestAttachRejectReason,
  ): BrowserGuestAttachResult {
    // Scope/session mismatches used to return silently, leaving the renderer unaware of the rejection and forcing
    // waitForGuest to time out. Rejected incoming guests also lacked common cleanup and could leave orphan WebContents.
    const recoveryRequested = this.requestGuestRebind(tab, reason);
    if (tab.guest !== guest) this.closeGuestWebContents(tab, guest);
    return { ok: false, reason, recoveryRequested };
  }

  private requestGuestRebind(tab: ManagedTab, reason: GuestRecoveryReason): boolean {
    tab.attachFailure = reason;
    if (tab.lifecycle === "closed" || tab.rebindRequested || !this.onOpenTabRequested) return false;
    tab.rebindRequested = true;
    this.log?.(`[browser-use] request guest rebind tabId=${tab.tabId} reason=${reason}`);
    this.onOpenTabRequested?.(tab.tabId, tab.owner);
    return true;
  }

  private closeGuestWebContents(tab: ManagedTab, guest = tab.guest): void {
    if (!guest || safeBool(() => guest.isDestroyed(), true)) return;
    try {
      guest.close({ waitForBeforeUnload: false });
    } catch (error) {
      this.warn(`browser guest close failed tabId=${tab.tabId}`, error);
    }
  }

  private now(): number {
    return this.residencyOptions.now?.() ?? Date.now();
  }

  private warn(message: string, error?: unknown): void {
    const suffix =
      error === undefined ? "" : ` error=${error instanceof Error ? error.message : String(error)}`;
    this.residencyOptions.warn?.(`${message}${suffix}`);
    this.log?.(`[browser-use] ${message}${suffix}`);
  }

  detach(key: string): void {
    const tab = this.tabs.get(key);
    if (tab) this.detachGuest(tab);
  }

  /**
   * Disconnect the old guest's native CDP channel before the renderer replaces `<webview>` with a new React key.
   *
   * Electron does not always deliver `render-process-gone` to the main WebContents listener first. If the renderer unmounts
   * the node directly, debugger.detach() is no longer available when `destroyed` arrives; DevToolsSession may still dispatch
   * an in-flight notification to a destroyed client and cause a main-process UAF. Make DOM destruction the second phase,
   * after a main ACK, and validate both sender window and current guest ID so a late event from an old generation cannot
   * disconnect the new guest that has taken over the tab.
   */
  async detachGuestBeforeReplacement(
    tabId: string,
    webContentsId: number,
    windowId: number,
  ): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return true;
    if (tab.owner.windowId !== windowId) {
      this.log?.(
        `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
          `guestId=${webContentsId} reason=window-mismatch`,
      );
      return false;
    }

    const guest = tab.guest;
    if (!guest) return true;
    const guestIdMatches = safeBool(() => guest.id === webContentsId, false);
    if (!guestIdMatches) {
      this.log?.(
        `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
          `guestId=${webContentsId} reason=guest-mismatch`,
      );
      return false;
    }
    if (safeBool(() => guest.isDestroyed(), true)) {
      // There is no safe native detach window after destroyed; replacement is allowed only if CDP was already confirmed disconnected.
      if (tab.cdpAttached) {
        this.log?.(
          `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
            `guestId=${webContentsId} reason=destroyed-with-cdp`,
        );
        return false;
      }
      this.detachGuest(tab);
      return true;
    }

    return this.beginGuestTeardown(tab, guest, "renderer replacement");
  }

  private beginGuestTeardown(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: string,
  ): Promise<boolean> {
    const existing = tab.guestTeardownFlight;
    if (existing) return existing;
    const flight = this.runGuestTeardown(tab, guest, reason);
    tab.guestTeardownFlight = flight;
    const clearFlight = () => {
      if (tab.guestTeardownFlight === flight) tab.guestTeardownFlight = undefined;
    };
    void flight.then(clearFlight, clearFlight);
    return flight;
  }

  private async runGuestTeardown(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: string,
  ): Promise<boolean> {
    if (tab.guest !== guest) return !tab.cdpAttached;
    tab.guestLifecycle = "detaching";

    // Stop new requests/recordings from entering CDP first. Already dispatched requests remain protected by
    // pendingCdpCommands until their promises actually settle, so an outer cancellation cannot mistake a native command for finished.
    for (const request of this.runningRequests.values()) {
      if (request.tabId !== tab.tabId) continue;
      request.controller.abort(new DOMException(`browser guest ${reason}`, "AbortError"));
    }
    this.abortRecordings((entry) => entry.tabId === tab.tabId, `browser guest ${reason}`);

    const pendingAtStart = tab.pendingCdpCommands;
    const settled = await this.waitForGuestCdpIdle(tab, DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS);
    if (!settled) {
      this.warn(
        `browser guest teardown cdp pending timeout tabId=${tab.tabId} ` +
          `pending=${tab.pendingCdpCommands} started=${pendingAtStart} reason=${reason}`,
      );
    }

    // The destroyed event may arrive while waiting. detachGuest has then completed JS-side teardown, but native detach is
    // considered safe only when cdpAttached=false.
    if (tab.guest !== guest) return !tab.cdpAttached;
    if (safeBool(() => guest.isDestroyed(), true)) {
      if (tab.cdpAttached) {
        this.log?.(
          `[browser-use] guest teardown rejected on destroyed guest tabId=${tab.tabId} ` +
            `guestId=${safeStr(() => String(guest.id), "?")}`,
        );
        return false;
      }
      this.detachGuest(tab);
      return true;
    }

    try {
      if (guest.debugger.isAttached()) guest.debugger.detach();
      if (guest.debugger.isAttached()) {
        this.warn(
          `browser guest replacement cdp detach not confirmed tabId=${tab.tabId} ` +
            `guestId=${safeStr(() => String(guest.id), "?")}`,
        );
        return false;
      }
    } catch (error) {
      // Fail closed: if detach fails, retain the old node. Continuing recreation would reopen the known native UAF window.
      this.warn(
        `browser guest replacement cdp detach failed tabId=${tab.tabId} ` +
          `guestId=${safeStr(() => String(guest.id), "?")}`,
        error,
      );
      if (tab.guest === guest && !safeBool(() => guest.isDestroyed(), true)) {
        tab.guestLifecycle = "attached";
      }
      return false;
    }

    this.log?.(
      `[browser-use] cdp detached before guest replacement tabId=${tab.tabId} ` +
        `guestId=${safeStr(() => String(guest.id), "?")}`,
    );
    tab.cdpAttached = false;
    tab.guestLifecycle = "detached";
    this.detachGuest(tab);
    return true;
  }

  private async waitForGuestCdpIdle(tab: ManagedTab, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (tab.pendingCdpCommands > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(10, deadline - Date.now())),
      );
    }
    return tab.pendingCdpCommands === 0;
  }

  /** Memory diagnostic counter; read-only size. */
  collectMemoryDiagnostics(): Record<string, number> {
    return { tabs: this.tabs.size, closedTabIds: this.closedTabIds.size };
  }

  private detachGuest(tab: ManagedTab): void {
    const guest = tab.guest;
    const guestDestroyed = guest ? safeBool(() => guest.isDestroyed(), true) : true;
    if (guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    }
    this.pendingDialogs.delete(tab.tabId);
    try {
      // Electron may destroy the guest as the renderer unmounts <webview>; the listener is already released with the object,
      // so calling session.removeListener again only produces a meaningless "Object has been destroyed" log.
      if (!guestDestroyed) tab.downloadCleanup?.();
    } catch (error) {
      // After Chromium kills the guest renderer, removeListener on the old session may also throw "Object has been destroyed";
      // cleanup failure must not prevent CDP from rebinding to the replacement guest.
      this.log?.(
        `[browser-use] detachGuest download cleanup failed tabId=${tab.tabId} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      tab.downloadCleanup = undefined;
    }
    try {
      if (!guestDestroyed) tab.activityCleanup?.();
    } catch {
      // Listener cleanup may fail after the guest is destroyed; residency state still needs to converge.
    } finally {
      tab.activityCleanup = undefined;
      tab.loading = false;
      tab.mediaActive = false;
    }
    // Removing the crash guard must not depend on guestDestroyed: removeListener is JS-only, and the guest reference is
    // often still alive during replacement. Skipping it would accumulate listeners across generations.
    try {
      tab.crashGuardCleanup?.();
    } catch {
      // removeListener may throw "Object has been destroyed" after guest destruction; convergence can continue.
    } finally {
      tab.crashGuardCleanup = undefined;
    }
    // Clean up JS listeners: old "message" listeners must not remain after guest replacement/destruction. This is
    // independent of native CDP disconnect (DevToolsSession dispatch does not inspect JS listeners); it only prevents listeners from accumulating across guest generations.
    const cdpWasAttached = tab.cdpAttached;
    try {
      tab.cdpMessageCleanup?.();
    } catch (error) {
      this.log?.(
        `[browser-use] detachGuest cdp message cleanup failed tabId=${tab.tabId} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      tab.cdpMessageCleanup = undefined;
    }
    if (guest) {
      const guestId = safeStr(() => String(guest.id), "?");
      if (guestDestroyed) {
        // The guest was destroyed before detach (destroyed callback / renderer unmounted webview). detach() must throw and
        // cannot help: native DevToolsAgentHost has already shut down with WebContents, so main can only accept the result.
        // The crash site (client_ vptr=0 in DevToolsSession::DispatchProtocolNotification) occurred after CDP was implicitly
        // destroyed without an explicit detach, so record this path; otherwise logs cannot correlate the crash with a tab lifecycle.
        if (cdpWasAttached) {
          this.log?.(
            `[browser-use] detachGuest cdp still attached on destroyed guest ` +
              `tabId=${tab.tabId} guestId=${guestId}`,
          );
        }
      } else {
        try {
          if (guest.debugger.isAttached()) guest.debugger.detach();
        } catch (error) {
          // Do not silently swallow this: logs must distinguish detach failure from success. Failure to detach when it
          // should have been possible is precisely the signal to correlate with a crash.
          this.warn(`browser guest cdp detach failed tabId=${tab.tabId} guestId=${guestId}`, error);
        }
      }
    }
    this.clearGuestCdpIdleRelease(tab);
    tab.guest = undefined;
    tab.cdpAttached = false;
    tab.guestLifecycle = guestDestroyed ? "destroyed" : "detached";
    tab.backgroundViewportFallback = undefined;
    // Scale belongs to the old guest's CDP session; the replacement guest's natural viewport will not replay metrics.
    tab.appliedViewportScale = undefined;
    tab.viewportMutation = undefined;
    this.residencyCoordinator.markDetached(tab.tabId);
    this.refreshRuntimeProtection(tab.tabId);
  }

  hasGuest(key: string): boolean {
    const tab = this.tabs.get(key);
    return Boolean(tab?.guest && tab.lifecycle !== "closed");
  }

  disposeAll(): void {
    for (const request of this.runningRequests.values()) {
      request.controller.abort(new DOMException("browser manager disposed", "AbortError"));
    }
    for (const tab of this.tabs.values()) this.closeTab(tab, false);
    for (const key of this.waiters.keys()) this.resolveWaiters(key, null);
    this.tabs.clear();
    this.closedTabIds.clear();
    this.activeTabByScope.clear();
    this.defaultTabByScope.clear();
    this.sessionNames.clear();
    this.naturalViewportByWindow.clear();
    for (const [tabId, waiters] of this.downloadWaiters) {
      let waiter = waiters[0];
      while (waiter) {
        this.finishDownloadWaiter(tabId, waiter, null);
        waiter = waiters[0];
      }
    }
    this.downloads.clear();
    this.queuedDownloads.clear();
    this.inFlightScreenshots.clear();
    this.abandonedScreenshotCaptures.clear();
    for (const entry of this.recordings.values()) {
      entry.controller.abort(new DOMException("browser manager disposed", "AbortError"));
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
      if (entry.artifact?.path)
        void rm(entry.artifact.path, { force: true }).catch(() => undefined);
    }
    this.recordings.clear();
    this.residencyCoordinator.dispose();
    this.restoredTabClaims.clear();
    for (const resolve of this.suspendAckWaiters.values()) resolve();
    this.suspendAckWaiters.clear();
    this.suspendFlights.clear();
    this.restoreFlights.clear();
    this.guestRecoveryFlights.clear();
    this.guestAttachFlights.clear();
  }

  private waitForGuest(tabId: string, signal?: AbortSignal): Promise<GuestWebContents | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise<GuestWebContents | null>((resolve) => {
      const waiter: PendingWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.removeWaiter(tabId, waiter);
          this.log?.(`[browser-use] waitForGuest timeout tabId=${tabId}`);
          resolve(null);
        }, this.attachTimeoutMs),
        signal,
      };
      waiter.onAbort = () => {
        this.removeWaiter(tabId, waiter);
        resolve(null);
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      const list = this.waiters.get(tabId) ?? [];
      list.push(waiter);
      this.waiters.set(tabId, list);
    });
  }

  private removeWaiter(tabId: string, waiter: PendingWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
    const list = this.waiters.get(tabId);
    if (!list) return;
    const index = list.indexOf(waiter);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.waiters.delete(tabId);
  }

  private resolveWaiters(tabId: string, guest: GuestWebContents | null): void {
    const list = this.waiters.get(tabId);
    if (!list) return;
    this.waiters.delete(tabId);
    for (const waiter of list) {
      clearTimeout(waiter.timer);
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(guest);
    }
  }
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function waitForPromiseWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ completed: true; value: T } | { completed: false }> {
  if (signal.aborted) return Promise.resolve({ completed: false });
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ completed: false });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ completed: true, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function waitForDelay(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<"matched" | "timeout" | "cancelled"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) return "cancelled";
    if (predicate()) return "matched";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timeout";
    if (!(await waitForDelay(Math.min(50, remaining), signal))) return "cancelled";
  }
}

function readScreenshotSurfaceInvalidation(signal: AbortSignal | undefined): Error | undefined {
  if (!signal?.aborted) return undefined;
  if (signal.reason instanceof Error) return signal.reason;
  return new Error("browser screenshot activity was invalidated");
}

async function raceBackendExecution(
  execution: Promise<BrowserCommandResult>,
  signal: AbortSignal,
  command: BrowserCommand,
  startedAt: number,
): Promise<BrowserCommandResult> {
  if (signal.aborted) {
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: "browser request cancelled after backend dispatch; side effects may have occurred",
        sideEffect: isSideEffecting(command) ? "uncertain" : "none",
      },
      elapsedMs: Date.now() - startedAt,
    };
  }
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: BrowserCommandResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () =>
      finish({
        ok: false,
        error: {
          code: "cancelled",
          message: isSideEffecting(command)
            ? "browser request cancelled after backend dispatch; side effects may have occurred"
            : "browser request cancelled",
          sideEffect: isSideEffecting(command) ? "uncertain" : "none",
        },
        elapsedMs: Date.now() - startedAt,
      });
    signal.addEventListener("abort", onAbort, { once: true });
    execution.then(finish, (error: unknown) =>
      finish({
        ok: false,
        error: {
          code: "execution_error",
          message: error instanceof Error ? error.message : String(error),
        },
        elapsedMs: Date.now() - startedAt,
      }),
    );
  });
}

function isBrowserViewportSize(value: unknown): value is BrowserViewportSize {
  if (!value || typeof value !== "object") return false;
  const viewport = value as Record<string, unknown>;
  return (
    Number.isInteger(viewport.width) &&
    Number(viewport.width) > 0 &&
    Number.isInteger(viewport.height) &&
    Number(viewport.height) > 0
  );
}

function isBrowserPointValue(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return typeof point.x === "number" && typeof point.y === "number";
}

function abortError(): DOMException {
  return new DOMException("Browser recording cancelled", "AbortError");
}

function normalizeBackgroundViewport(viewport: BrowserViewportSize): BrowserViewportSize {
  return {
    width: Math.min(
      BROWSER_VIEWPORT_LIMITS.maxWidth,
      Math.max(BROWSER_VIEWPORT_LIMITS.minWidth, viewport.width),
    ),
    height: Math.min(
      BROWSER_VIEWPORT_LIMITS.maxHeight,
      Math.max(BROWSER_VIEWPORT_LIMITS.minHeight, viewport.height),
    ),
  };
}

function isScreenshotCommand(command: BrowserCommand): boolean {
  return (
    command.method === "screenshot" ||
    (command.method === "playwright" && command.action.name === "elementScreenshot")
  );
}

function assertViewportOverride(viewport: BrowserViewportSize): void {
  if (
    !Number.isInteger(viewport.width) ||
    viewport.width < BROWSER_VIEWPORT_LIMITS.minWidth ||
    viewport.width > BROWSER_VIEWPORT_LIMITS.maxWidth ||
    !Number.isInteger(viewport.height) ||
    viewport.height < BROWSER_VIEWPORT_LIMITS.minHeight ||
    viewport.height > BROWSER_VIEWPORT_LIMITS.maxHeight
  ) {
    throw new Error("browser viewport is outside the supported free-size range");
  }
}

function safeStr(fn: () => string, fallback: string): string {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function safeBool(fn: () => boolean, fallback: boolean): boolean {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function normalizeDialogType(type: string | undefined): BrowserDialog["type"] {
  switch (type) {
    case "alert":
    case "confirm":
    case "prompt":
    case "beforeunload":
      return type;
    default:
      return "alert";
  }
}

/** Browser response metadata enters model traces and debug logs; retain only origin/path and never include credentials/query/hash. */
function sanitizeBrowserMetaUrl(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const sanitized = url.toString();
    return url.pathname === "/" ? sanitized.slice(0, -1) : sanitized;
  } catch {
    // Valid opaque URLs such as about:blank can also be parsed by URL; unparseable internal page strings must not enter metadata.
    return undefined;
  }
}
