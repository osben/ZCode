/* oxlint-disable eslint(max-lines) -- UnifiedBrowserView owns navigation, events, and guest lifecycle for the persistent webview; horizontal scrolling is handled by a separate hook. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  BrowserViewScreenshotSurfacePreparePayload,
  EmbeddedBrowserViewportPreference,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWebElementPicker } from "@/hooks/useWebElementPicker.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { BrowserSiteSettingsEntry } from "@/browser-use/BrowserSiteSettingsEntry.js";
import { BrowserToolbar } from "@/EmbeddedBrowserPaneParts.js";
import { EmbeddedBrowserPermissionPrompts } from "@/browser-use/EmbeddedBrowserPermissionPrompts.js";
import { BrowserViewportSurface } from "@/browser-use/BrowserViewportSurface.js";
import { BrowserViewportToolbar } from "@/browser-use/BrowserViewportToolbar.js";
import { useBrowserResizeOperationWarning } from "@/browser-use/useBrowserResizeOperationWarning.js";
import { useBrowserScreenshotSurfaceReady } from "@/browser-use/useBrowserScreenshotSurfaceReady.js";
import { useEmbeddedBrowserWheelChain } from "@/browser-use/useEmbeddedBrowserWheelChain.js";
import { useDesktopZoomFactor } from "@/browser-use/useDesktopZoomFactor.js";
import { useResponsiveBrowserViewportControl } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import type { HumanBrowserViewportPreferenceChangeSource } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import {
  DEFAULT_BROWSER_URL,
  INITIAL_BROWSER_STATE,
  describeBrowserLoadFailure,
  displayBrowserUrl,
  isDefaultBrowserOpenableUrl,
  isRecoverableBrowserGuestExitReason,
  normalizeBrowserUrl,
  safeWebviewCall,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";

type PendingGuestNavigationCompletion = {
  resolve: () => void;
  url: string;
};

/** UnifiedBrowserView — unified browser view (`<webview>` + CDP-on-guest architecture). The renderer’s `<webview>` guest renders page pixels directly (composited in the DOM, so DOM overlays can cover it and menus are no longer hidden behind a native WebContentsView layer). Human navigation/back/forward/refresh/element-picking calls webview methods directly (low latency, no handshake required); webview events drive chrome state. On did-attach, also report the guest webContentsId to main via browserViewAttachGuest, allowing main to attach CDP (webContents.debugger) for the Agent to control the tab over the protocol. Chrome reuses EmbeddedBrowserPaneParts BrowserToolbar; URL normalization and the not-mounted fallback reuse embeddedBrowserHelpers. */
export function UnifiedBrowserView({
  browserKey,
  onOpenPermissionSettings,
  isResidencyRestore = false,
  isVisible,
  isSelected = isVisible,
  isCurrentTask = isSelected,
  initialUrl,
  faviconUrl,
  navigationRequest,
  onUrlChange,
  onPageMetadataChange,
  onNavigationRequestHandled,
  workspacePath,
  workspaceIdentity,
  workspaceKey,
  remoteSessionId,
  sessionId,
  residencyGeneration,
  browserUseOperationUntil,
  browserResizeBaselineVersion,
  screenshotSurfaceRequest,
  deferEmptyGuest = false,
  initialHumanViewportPreference,
  onHumanViewportPreferenceChange,
}: {
  /** Controlled view key (= tab.id / sessionId, used by the Agent to locate the tab). */
  browserKey: string;
  /** Site-settings entry in the address bar; opens the site's permissions settings tab. */
  onOpenPermissionSettings?: (origin: string) => void;
  /** During budget recovery, revoke the bootstrap src immediately after the guest is created; main owns the first real navigation. */
  isResidencyRestore?: boolean;
  /** Whether the pane is visible (active + expanded). When hidden, remove it only from layout without unmounting the webview, preserving the page and history. */
  isVisible: boolean;
  /** Tab-strip selection and panel visibility are independent; keep selected state while collapsed. */
  isSelected?: boolean;
  /** Tab for the current task, used by main for the eviction tier. */
  isCurrentTask?: boolean;
  /** Initial/restore URL to navigate to on mount (human-tab restore state). */
  initialUrl?: string | null;
  /** Current favicon in the tab shell; persisted with the residency report. */
  faviconUrl?: string | null;
  /** External request to navigate this tab to a URL ({id,url}); acknowledge through onNavigationRequestHandled after consuming it. */
  navigationRequest?: { id: string; url: string } | null;
  /** Report URL changes (persist human-tab URL). */
  onUrlChange?: (url: string) => void;
  /** Report page title/favicon changes (updates the tab label). */
  onPageMetadataChange?: (metadata: { title?: string; faviconUrl?: string | null }) => void;
  /** Acknowledge after consuming navigationRequest. */
  onNavigationRequestHandled?: (requestId: string) => void;
  /** Workspace path needed to add an element selection to chat (passed by the human branch; optional for the Agent branch). */
  workspacePath?: string;
  /** Workspace identity owning the element-selection context (passed by the human branch). */
  workspaceIdentity?: string;
  /** Identity scope frozen when the browser-use tab was created; takes priority over ambient workspace props. */
  workspaceKey?: string;
  remoteSessionId?: string;
  /** Conversation owner frozen when the tab was created; do not fill it from the active task when dom-ready fires. */
  sessionId?: string;
  residencyGeneration?: number;
  /** Operation deadline shared with the tab mouse icon; passed only for browser-use tabs. */
  browserUseOperationUntil?: number;
  browserResizeBaselineVersion?: number;
  /** Temporarily preserve the real layout of a background guest before taking a screenshot; does not change active/focus semantics. */
  screenshotSurfaceRequest?: BrowserViewScreenshotSurfacePreparePayload | null;
  /** Delay guest creation for an empty human tab; Agent/browser-use tabs must attach during creation. */
  deferEmptyGuest?: boolean;
  /** Passed only by the human Browser surface; must remain undefined for Agent Browser Use. */
  initialHumanViewportPreference?: EmbeddedBrowserViewportPreference;
  /** Accept only changes initiated by the human UI; Agent viewport events must not call this. */
  onHumanViewportPreferenceChange?: (
    preference: EmbeddedBrowserViewportPreference,
    source: HumanBrowserViewportPreferenceChangeSource,
  ) => void;
}): React.JSX.Element {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const desktopZoomFactor = useDesktopZoomFactor();

  const [addressValue, setAddressValue] = useState("");
  const [browserState, setBrowserState] = useState<BrowserState>(INITIAL_BROWSER_STATE);
  const hasInitialNavigation = Boolean(initialUrl && initialUrl !== DEFAULT_BROWSER_URL);
  const [hasNavigated, setHasNavigated] = useState(hasInitialNavigation);
  const [webviewGeneration, setWebviewGeneration] = useState(0);
  const [webview, setWebview] = useState<ElectronWebviewTag | null>(null);
  // Filter permission bubbles by owning tab: read the guest webContents id after attach/dom-ready.
  // Keep undefined if unavailable (the component falls back to rendering requests without an owner id).
  const [permissionGuestWebContentsId, setPermissionGuestWebContentsId] = useState<
    number | undefined
  >(undefined);
  useEffect(() => {
    if (!webview || typeof webview.getWebContentsId !== "function") return;
    const id = safeWebviewCall(() => webview.getWebContentsId(), 0);
    setPermissionGuestWebContentsId(id > 0 ? id : undefined);
  }, [webview, browserState.isReady]);
  const [guestAttachRetryNonce, setGuestAttachRetryNonce] = useState(0);
  useBrowserScreenshotSurfaceReady({
    request: screenshotSurfaceRequest ?? null,
    webview,
  });
  const shouldComposeSurface = Boolean(screenshotSurfaceRequest);
  const setGuestZoomFactor = useCallback((target: ElectronWebviewTag, targetZoomFactor: number) => {
    if (typeof target.setZoomFactor !== "function") return;
    safeWebviewCall(
      () => target.setZoomFactor(targetZoomFactor),
      undefined,
      (error) => {
        logger.debug("[browser-use] 跳过未就绪 webview 的 zoom 同步", {
          error: error instanceof Error ? error.message : String(error),
          targetZoomFactor,
        });
      },
    );
  }, []);
  const normalizeResponsiveGuestZoom = useCallback(() => {
    if (webview) setGuestZoomFactor(webview, 1);
  }, [setGuestZoomFactor, webview]);
  const {
    browserRegionRef,
    notifyBrowserViewportResize,
    prepareForAgentViewportChange,
    showResizeWarning,
  } = useBrowserResizeOperationWarning({
    browserKey,
    isVisible,
    operationUntil: browserUseOperationUntil,
    resizeBaselineVersion: browserResizeBaselineVersion,
  });
  const {
    isResponsiveMode,
    responsiveViewportSize,
    responsiveViewportZoom,
    setResponsiveViewportZoom,
    synchronizeInitialHumanViewport,
    toggleResponsiveMode,
    updateResponsiveViewportSize,
  } = useResponsiveBrowserViewportControl({
    browserKey,
    desktopZoomFactor,
    onAgentViewportChange: prepareForAgentViewportChange,
    onViewportSynchronized: normalizeResponsiveGuestZoom,
    onViewportResize: notifyBrowserViewportResize,
    initialHumanViewportPreference,
    onHumanViewportPreferenceChange,
    sessionId,
  });
  // MediaRecorder captures the actual WebView surface composited in the renderer. If we keep the user’s Fit/50% preview,
  // the canvas later has to upscale a low-resolution source to the target size. Derive a separate 100% surface for the recording lease,
  // without changing the user’s free-size dimensions, zoom choice, or persisted state; when the request releases, React restores the preview naturally.
  const forceUnscaledSurface = screenshotSurfaceRequest?.surfaceScaleMode === "unscaled";
  // A regular background tab’s fallback viewport may be wider than the window; passing Fit alone does not enable responsive layout,
  // so the webview stays shrunk by the preparation layer and never becomes ready. During screenshots, derive responsive layout for the requested size;
  // when released, restore the user’s mode and dimensions without saving preferences or recreating the guest.
  const effectiveIsResponsiveMode = isResponsiveMode || Boolean(screenshotSurfaceRequest);
  const effectiveViewportSize = screenshotSurfaceRequest?.viewport ?? responsiveViewportSize;
  // Ordinary screenshots temporarily change layout; main manages guest zoom for fallback metrics.
  // Treating temporary Fit as a user mode change would make release restore the desktop zoom incorrectly and break later CDP coordinates.
  const shouldNormalizeGuestZoom = isResponsiveMode || forceUnscaledSurface;
  // A fixed 100%/200% preview does not shrink with the screenshot canvas, and high-DPI Windows guest rasterization
  // may still be clipped by the host viewport. Temporarily use Fit for regular screenshots, then restore the user ratio; recording stays unscaled.
  const effectiveViewportZoom = forceUnscaledSurface
    ? "100"
    : screenshotSurfaceRequest
      ? "fit"
      : responsiveViewportZoom;
  useEmbeddedBrowserWheelChain({
    browserRegionRef,
    isResponsiveMode: effectiveIsResponsiveMode,
    webview,
  });

  // Navigation URL queued before dom-ready; load it once the webview is ready (the <webview> src applies only on first mount).
  const pendingUrlRef = useRef<string | null>(null);
  const lastRequestedUrlRef = useRef<string | null>(null);
  // Consumed initialUrl/navigationRequest values, to avoid duplicate navigation.
  const lastAppliedInitialUrlRef = useRef<string | null>(null);
  const lastHandledNavigationRequestIdRef = useRef<string | null>(null);
  const lastRestorableUrlRef = useRef<string | null>(
    initialUrl && initialUrl !== DEFAULT_BROWSER_URL ? initialUrl : null,
  );
  const guestRecoveryInProgressRef = useRef(false);
  // For an external navigation on a failed guest, acknowledge only after the replacement guest actually takes over the loadURL.
  const pendingGuestNavigationCompletionRef = useRef<PendingGuestNavigationCompletion | null>(null);
  // Deduplicate guestId reports: did-attach and dom-ready can fire consecutively; report again only when the guest or active state changes.
  const lastReportedGuestRef = useRef<{
    active: boolean;
    webContentsId: number;
    scopeFingerprint: string;
  } | null>(null);
  const wasResponsiveModeRef = useRef(false);
  // Attribute guest destruction: before the production main-process UAF (EXC_BAD_ACCESS at
  // 0x10, where an in-flight DevToolsSession notification accessed a destroyed client), main logs only showed
  // “cdp still attached on destroyed guest” and could not identify who unmounted the webview node:
  // residency suspension/re-shell, parent tree unmount, shouldMountWebview condition change, or generation replacement.
  // ref(null) is the first place React reports unmounting a <webview> node. Together with component-unmount marks and suspend-shell ACK logs,
  // it identifies the destroyer and timing. Emit only after a webview has actually existed, at a rate proportional to tab lifetimes.
  const webviewTeardownProbeRef = useRef({
    browserKey: "",
    generation: 0,
    hasNavigated: hasInitialNavigation,
    hadWebview: false,
  });
  webviewTeardownProbeRef.current.browserKey = browserKey;
  webviewTeardownProbeRef.current.generation = webviewGeneration;
  webviewTeardownProbeRef.current.hasNavigated = hasNavigated;
  const logWebviewTeardown = useCallback((trigger: string) => {
    const probe = webviewTeardownProbeRef.current;
    logger.info("[browser-use] webview 节点离开 DOM（guest 将被销毁）", {
      browserKey: probe.browserKey,
      generation: probe.generation,
      guestReported: lastReportedGuestRef.current,
      hasNavigated: probe.hasNavigated,
      trigger,
    });
  }, []);
  const onPageMetadataChangeRef = useRef(onPageMetadataChange);
  onPageMetadataChangeRef.current = onPageMetadataChange;
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;

  const completePendingGuestNavigation = useCallback(
    (completion?: PendingGuestNavigationCompletion | null) => {
      const pendingCompletion =
        completion === undefined ? pendingGuestNavigationCompletionRef.current : completion;
      if (!pendingCompletion || pendingGuestNavigationCompletionRef.current !== pendingCompletion) {
        return;
      }
      pendingGuestNavigationCompletionRef.current = null;
      pendingCompletion.resolve();
    },
    [],
  );

  const waitForGuestNavigationTakeover = useCallback((url: string) => {
    // Keep only one external navigation intent per view. If a future entry point allows concurrent requests, the newer one explicitly replaces the older one;
    // settle the old acknowledgement first so its Promise does not remain pending forever.
    const replacedCompletion = pendingGuestNavigationCompletionRef.current;
    pendingGuestNavigationCompletionRef.current = null;
    replacedCompletion?.resolve();
    return new Promise<void>((resolve) => {
      pendingGuestNavigationCompletionRef.current = { resolve, url };
    });
  }, []);

  useEffect(
    () => () => {
      // Closing the view is an explicit cancellation; do not leave the caller waiting forever for navigationRequest.
      completePendingGuestNavigation();
    },
    [completePendingGuestNavigation],
  );

  useEffect(
    () => () => {
      // Component unmount means the <webview> must leave the DOM: residency suspension/re-shell, parent panel closure, or
      // a full remount after switching sessions. The timing gap from ref-null helps distinguish “generation rebuild” from a true unmount.
      if (webviewTeardownProbeRef.current.hadWebview || lastReportedGuestRef.current) {
        webviewTeardownProbeRef.current.hadWebview = false;
        logWebviewTeardown("component-unmount");
      }
    },
    [logWebviewTeardown],
  );

  const reportBrowserGuest = useCallback(
    (active: boolean) => {
      if (!webview) return;
      if (typeof webview.getWebContentsId !== "function") return;
      const webContentsId = safeWebviewCall(() => webview.getWebContentsId(), 0);
      if (webContentsId <= 0) return;
      const effectiveWorkspaceKey = workspaceKey ?? (workspaceIdentity?.trim() || workspacePath);
      const scopeFingerprint = JSON.stringify({
        active,
        webContentsId,
        workspaceKey: effectiveWorkspaceKey ?? "",
        remoteSessionId: remoteSessionId ?? "",
        sessionId: sessionId ?? "",
        residencyGeneration: residencyGeneration ?? null,
      });
      const lastReported = lastReportedGuestRef.current;
      if (lastReported?.scopeFingerprint === scopeFingerprint) {
        return;
      }
      lastReportedGuestRef.current = { active, webContentsId, scopeFingerprint };
      const attachRequest = platform.browserViewAttachGuest?.({
        key: browserKey,
        webContentsId,
        active,
        ...(effectiveWorkspaceKey ? { workspaceKey: effectiveWorkspaceKey } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(residencyGeneration === undefined ? {} : { residencyGeneration }),
      });
      if (!attachRequest) return;
      void attachRequest
        .then((result) => {
          // An older preload may still return undefined; retain the existing successful-attach compatibility behavior.
          if (!result || result.ok) {
            synchronizeInitialHumanViewport();
            return;
          }
          logger.warn("[browser-use] main 拒绝 guest attach，等待按 owner scope 重绑", {
            browserKey,
            reason: result.reason,
            recoveryRequested: result.recoveryRequested,
          });
          // main may replay BrowserViewReady; clear the deduplication marker so the same webContentsId can be reported again.
          if (result.recoveryRequested) {
            lastReportedGuestRef.current = null;
            setGuestAttachRetryNonce((current) => current + 1);
          }
        })
        .catch((error) => {
          logger.debug("[browser-use] 上报 guest webContentsId 失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [
      browserKey,
      platform,
      remoteSessionId,
      residencyGeneration,
      sessionId,
      synchronizeInitialHumanViewport,
      webview,
      workspaceKey,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const detachBrowserGuestBeforeReplacement = useCallback(async (): Promise<boolean> => {
    const lastReported = lastReportedGuestRef.current;
    // Before the guest is reported to main, there is no native CDP session; Web must not expose this desktop capability either.
    if (!lastReported || !platform.browserViewDetachGuest) return true;
    try {
      const detached = await platform.browserViewDetachGuest({
        key: browserKey,
        webContentsId: lastReported.webContentsId,
      });
      if (!detached) {
        logger.warn("[browser-use] main 未确认旧 guest CDP 已断开，取消 webview 重建", {
          browserKey,
          webContentsId: lastReported.webContentsId,
        });
      }
      return detached;
    } catch (error) {
      logger.warn("[browser-use] 请求 main 断开旧 guest CDP 失败，取消 webview 重建", {
        browserKey,
        error: error instanceof Error ? error.message : String(error),
        webContentsId: lastReported.webContentsId,
      });
      return false;
    }
  }, [browserKey, platform]);

  const {
    cancelPicking: cancelWebElementPicking,
    isPicking: isWebElementPicking,
    togglePicking: toggleWebElementPicking,
  } = useWebElementPicker({
    // Transport-independent exit: when the webview is ready, use <webview>.executeJavaScript(script, true);
    // if it is still null, return cancelled (a valid selection result) and keep this a no-op.
    executeJs: (script) =>
      webview ? webview.executeJavaScript(script, true) : Promise.resolve({ status: "cancelled" }),
    workspacePath: workspacePath ?? "",
    workspaceIdentity: workspaceKey ?? workspaceIdentity,
  });

  // ---- Sync chrome state from webview (URL/back-forward/title) ----
  const syncBrowserState = useCallback((target: ElectronWebviewTag) => {
    // Before dom-ready, during navigation churn, or while reattaching, the guest may not be attached; sync methods can throw
    // “must be attached to the DOM”. Route through safeWebviewCall so this does not bubble to window.onerror.
    const onDetached = (error: unknown) => {
      logger.debug("[browser-use] 跳过未就绪 webview 的状态同步", {
        error: error instanceof Error ? error.message : String(error),
      });
    };
    const currentUrl =
      safeWebviewCall(() => target.getURL(), "", onDetached) || DEFAULT_BROWSER_URL;
    const canGoBack = safeWebviewCall(() => target.canGoBack(), false, onDetached);
    const canGoForward = safeWebviewCall(() => target.canGoForward(), false, onDetached);
    const title = safeWebviewCall(() => target.getTitle(), "", onDetached);
    if (currentUrl !== DEFAULT_BROWSER_URL) {
      lastRestorableUrlRef.current = currentUrl;
    }
    setAddressValue(displayBrowserUrl(currentUrl));
    setBrowserState((prev) => ({
      ...prev,
      canGoBack,
      canGoForward,
      currentUrl,
      isReady: true,
      title,
    }));
    onPageMetadataChangeRef.current?.({ title: title || undefined });
    // Page URL is untrusted: use it only for display and tab persistence, never for execution.
    if (currentUrl !== DEFAULT_BROWSER_URL) {
      onUrlChangeRef.current?.(currentUrl);
    }
  }, []);

  // ---- Wire webview events + report guestId on did-attach ----
  useEffect(() => {
    if (!webview) return;

    const handleDidAttach = () => {
      // navigationHistory.restore is available only for a guest that has never loaded a page. If reporting waits until
      // dom-ready, about:blank has already committed and restore can only reload the URL. Report immediately after attach so
      // main can restore the complete Chromium pageState before the first navigation commits.
      if (isResidencyRestore) {
        // A <webview> needs src to create the guest, but keeping that attribute after attach resubmits
        // about:blank and interrupts main’s history restore. Remove the bootstrap src as soon as the guest exists.
        webview.removeAttribute("src");
      }
      reportBrowserGuest(isSelected);
    };

    const handleDomReady = () => {
      // Electron/Chromium continues propagating the main page zoom to the guest; compensating only with an outer
      // transform still changes guest innerWidth/DPR. Keep guest zoom at 1 for free-size mode;
      // normal mode lets Electron propagate naturally, avoiding an explicit rewrite of page zoom.
      if (isResponsiveMode) setGuestZoomFactor(webview, 1);
      // did-attach is the earliest point for full history restore; retain dom-ready as a compatibility fallback for Electron versions.
      reportBrowserGuest(isSelected);

      // <webview> src applies only on first mount; subsequent navigations use imperative loadURL and consume queued URLs.
      const pending = pendingUrlRef.current;
      if (pending) {
        const pendingCompletion = pendingGuestNavigationCompletionRef.current;
        pendingUrlRef.current = null;
        setBrowserState((prev) => ({ ...prev, isReady: true }));
        void (async () => {
          try {
            await webview.loadURL(pending);
          } catch (loadError: unknown) {
            const message = loadError instanceof Error ? loadError.message : String(loadError);
            if (!message.includes("ERR_ABORTED")) {
              setBrowserState((prev) => ({
                ...prev,
                errorMessage: intl.formatMessage(
                  { id: "browser.loadFailed" },
                  { message: describeBrowserLoadFailure({ rawError: loadError }) },
                ),
                isLoading: false,
              }));
            }
          } finally {
            // Acknowledging after only writing an external request to pendingUrl is insufficient: a failed guest will never consume it.
            // Count the navigation intent as taken over only after the replacement guest reaches dom-ready and attempts loadURL.
            completePendingGuestNavigation(pendingCompletion);
          }
        })();
        return;
      }
      guestRecoveryInProgressRef.current = false;
      syncBrowserState(webview);
    };

    const handleDidStartLoading = () => {
      void cancelWebElementPicking();
      setBrowserState((prev) => ({
        ...prev,
        errorMessage: null,
        loadErrorCode: null,
        isLoading: true,
      }));
    };

    const handleDidStopLoading = () => {
      guestRecoveryInProgressRef.current = false;
      setBrowserState((prev) => ({ ...prev, isLoading: false }));
      syncBrowserState(webview);
    };

    const handleNavigation = () => {
      syncBrowserState(webview);
    };

    const handleTitleUpdated = (event: ElectronWebviewTitleEvent) => {
      setBrowserState((prev) => ({ ...prev, title: event.title }));
      onPageMetadataChangeRef.current?.({ title: event.title || undefined });
    };

    const handleDidFailLoad = (event: ElectronWebviewDidFailLoadEvent) => {
      // Ignore subframe failures and -3 (ERR_ABORTED, interrupted by a later navigation).
      if (!event.isMainFrame || event.errorCode === -3) return;
      logger.warn("[browser-use] 页面加载失败", {
        errorCode: event.errorCode,
        errorDescription: event.errorDescription,
        url: event.validatedURL,
      });
      setBrowserState((prev) => ({
        ...prev,
        currentUrl: event.validatedURL || prev.currentUrl,
        errorMessage: intl.formatMessage(
          { id: "browser.loadFailed" },
          {
            message: describeBrowserLoadFailure({
              errorCode: event.errorCode,
              errorDescription: event.errorDescription,
            }),
          },
        ),
        loadErrorCode: event.errorCode,
        isLoading: false,
      }));
      setAddressValue(
        displayBrowserUrl(
          event.validatedURL || safeWebviewCall(() => webview.getURL(), "") || DEFAULT_BROWSER_URL,
        ),
      );
      guestRecoveryInProgressRef.current = false;
    };

    const handleRenderProcessGone = (event: ElectronWebviewRenderProcessGoneEvent) => {
      const { exitCode, reason } = event.details;
      if (!isRecoverableBrowserGuestExitReason(reason)) {
        logger.warn("[browser-use] guest renderer 异常退出且不可自动恢复", {
          browserKey,
          exitCode,
          reason,
        });
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage(
            { id: "browser.loadFailed" },
            { message: `renderer ${reason} (${exitCode})` },
          ),
          // Rebuild the entire guest after the renderer exits; navigating again alone cannot restore it.
          // guestFailure makes the UI show the rebuild entry instead of the retry entry for an ordinary page load error.
          guestFailure: { exitCode, reason },
          isLoading: false,
          isReady: false,
        }));
        // If the replacement guest also fails to start, the failure is definitive; finish waiting so the caller does not hang forever.
        completePendingGuestNavigation();
        return;
      }
      if (guestRecoveryInProgressRef.current) return;

      guestRecoveryInProgressRef.current = true;
      const recoveryUrl = lastRestorableUrlRef.current;
      void cancelWebElementPicking();

      logger.warn("[browser-use] guest renderer 异常退出，原位重建并恢复最近 URL", {
        browserKey,
        exitCode,
        reason,
        recoveryUrl,
      });
      void (async () => {
        const detached = await detachBrowserGuestBeforeReplacement();
        if (!detached) {
          guestRecoveryInProgressRef.current = false;
          setBrowserState((prev) => ({
            ...prev,
            errorMessage: null,
            loadErrorCode: null,
            guestFailure: { exitCode, reason },
            isLoading: false,
            isReady: false,
          }));
          completePendingGuestNavigation();
          return;
        }

        pendingUrlRef.current = recoveryUrl;
        lastRequestedUrlRef.current = null;
        lastAppliedInitialUrlRef.current = null;
        lastReportedGuestRef.current = null;
        setAddressValue(displayBrowserUrl(recoveryUrl ?? DEFAULT_BROWSER_URL));
        setHasNavigated(Boolean(recoveryUrl));
        setBrowserState((prev) => ({
          ...prev,
          canGoBack: false,
          canGoForward: false,
          currentUrl: recoveryUrl ?? DEFAULT_BROWSER_URL,
          errorMessage: null,
          loadErrorCode: null,
          guestFailure: null,
          isLoading: Boolean(recoveryUrl),
          isReady: false,
        }));
        // The renderer observed the guest exit, but the main process's render-process-gone listener does not always arrive first.
        // Wait for the CDP detach ACK above before incrementing the key; otherwise React unmounts the old
        // `<webview>` and Electron DevToolsSession may access a destroyed client during an in-flight notification.
        setWebviewGeneration((current) => current + 1);
      })();
    };

    webview.addEventListener("did-attach", handleDidAttach);
    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-navigate", handleNavigation);
    webview.addEventListener("did-navigate-in-page", handleNavigation);
    webview.addEventListener("page-title-updated", handleTitleUpdated);
    webview.addEventListener("did-fail-load", handleDidFailLoad);
    webview.addEventListener("render-process-gone", handleRenderProcessGone);

    return () => {
      webview.removeEventListener("did-attach", handleDidAttach);
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-navigate", handleNavigation);
      webview.removeEventListener("did-navigate-in-page", handleNavigation);
      webview.removeEventListener("page-title-updated", handleTitleUpdated);
      webview.removeEventListener("did-fail-load", handleDidFailLoad);
      webview.removeEventListener("render-process-gone", handleRenderProcessGone);
    };
  }, [
    browserKey,
    cancelWebElementPicking,
    completePendingGuestNavigation,
    detachBrowserGuestBeforeReplacement,
    intl,
    isResidencyRestore,
    isSelected,
    platform,
    reportBrowserGuest,
    setGuestZoomFactor,
    syncBrowserState,
    webview,
  ]);

  useEffect(() => {
    if (!webview) return;
    const wasResponsiveMode = wasResponsiveModeRef.current;
    wasResponsiveModeRef.current = shouldNormalizeGuestZoom;

    if (shouldNormalizeGuestZoom) {
      setGuestZoomFactor(webview, 1);
    } else if (wasResponsiveMode) {
      // Restore the current app zoom only when leaving free-size mode; during ordinary browsing, keep Electron's native propagation.
      setGuestZoomFactor(webview, desktopZoomFactor);
    }
  }, [desktopZoomFactor, shouldNormalizeGuestZoom, setGuestZoomFactor, webview]);

  useEffect(() => {
    reportBrowserGuest(isSelected);
  }, [guestAttachRetryNonce, isSelected, reportBrowserGuest]);

  useEffect(() => {
    const effectiveWorkspaceKey = workspaceKey ?? (workspaceIdentity?.trim() || workspacePath);
    if (!effectiveWorkspaceKey || !sessionId) return;
    const restoreUrl =
      browserState.currentUrl && browserState.currentUrl !== DEFAULT_BROWSER_URL
        ? browserState.currentUrl
        : (lastRestorableUrlRef.current ?? null);
    void platform
      .browserViewReportResidency?.({
        tabId: browserKey,
        workspaceKey: effectiveWorkspaceKey,
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId,
        selected: isSelected,
        visible: isVisible,
        currentTask: isCurrentTask,
        loading: browserState.isLoading,
        restoreUrl,
        title: browserState.title || null,
        // Do not keep the favicon only in renderer tab state: if residency reporting omits it,
        // a suspended or cold-start-restored shell will revert to the globe icon.
        ...(faviconUrl === undefined ? {} : { faviconUrl }),
      })
      .catch((error) => {
        logger.debug("[browser-use] 上报 tab residency 失败", {
          error: error instanceof Error ? error.message : String(error),
          tabId: browserKey,
        });
      });
  }, [
    browserKey,
    browserState.currentUrl,
    browserState.isLoading,
    browserState.title,
    faviconUrl,
    isCurrentTask,
    isSelected,
    isVisible,
    platform,
    remoteSessionId,
    sessionId,
    workspaceKey,
    workspaceIdentity,
    workspacePath,
  ]);

  const rebuildBrowserGuest = useCallback(
    async (
      recoveryUrl: string | null,
      trigger: "address-navigation" | "external-navigation" | "manual-retry",
    ): Promise<boolean> => {
      guestRecoveryInProgressRef.current = true;
      void cancelWebElementPicking();

      const detached = await detachBrowserGuestBeforeReplacement();
      if (!detached) {
        guestRecoveryInProgressRef.current = false;
        return false;
      }

      pendingUrlRef.current = recoveryUrl;
      lastRequestedUrlRef.current = null;
      lastAppliedInitialUrlRef.current = null;
      lastReportedGuestRef.current = null;

      logger.warn("[browser-use] 显式导航触发重建失败的 guest renderer", {
        browserKey,
        recoveryUrl,
        trigger,
      });
      setAddressValue(displayBrowserUrl(recoveryUrl ?? DEFAULT_BROWSER_URL));
      setHasNavigated(Boolean(recoveryUrl));
      setBrowserState((prev) => ({
        ...prev,
        canGoBack: false,
        canGoForward: false,
        currentUrl: recoveryUrl ?? DEFAULT_BROWSER_URL,
        errorMessage: null,
        loadErrorCode: null,
        guestFailure: null,
        isLoading: Boolean(recoveryUrl),
        isReady: false,
      }));
      setWebviewGeneration((current) => current + 1);
      return true;
    },
    [browserKey, cancelWebElementPicking, detachBrowserGuestBeforeReplacement],
  );

  // ---- Navigation (human directly calls webview.loadURL; if not ready, queue until dom-ready) ----
  const openUrl = useCallback(
    async (input: string, source: "toolbar" | "restore" | "request" = "toolbar") => {
      const nextUrl = normalizeBrowserUrl(input);
      if (!nextUrl) {
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage({ id: "browser.invalidUrl" }),
          // An invalid address is unrelated to the previous network failure; without clearing it, the error state keeps showing stale certificate instructions.
          loadErrorCode: null,
        }));
        return;
      }

      // If an external request can only be queued for a guest that is not ready, acknowledge it only after dom-ready takes over loadURL.
      // Address-bar/restoration navigation has no upstream consumer confirmation and does not need to wait for this lifecycle signal.
      const navigationTakenOver =
        source === "request" && (!webview || !browserState.isReady)
          ? waitForGuestNavigationTakeover(nextUrl)
          : null;

      // After launch-failed, isReady=false; writing only the address-bar URL to pendingUrl is insufficient:
      // the invalid guest will never fire dom-ready again, leaving both the failure state and queued navigation stuck forever.
      if (browserState.guestFailure && (source === "toolbar" || source === "request")) {
        lastRestorableUrlRef.current = nextUrl;
        onUrlChange?.(nextUrl);
        const rebuilt = await rebuildBrowserGuest(
          nextUrl,
          source === "request" ? "external-navigation" : "address-navigation",
        );
        if (!rebuilt) completePendingGuestNavigation();
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      // Deduplicate: an external request and restore may provide the same URL at once; consecutive loadURL calls trigger ERR_ABORTED(-3).
      if (
        nextUrl === lastRequestedUrlRef.current &&
        (pendingUrlRef.current === nextUrl || browserState.isLoading)
      ) {
        setAddressValue(displayBrowserUrl(nextUrl));
        setHasNavigated(true);
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      setAddressValue(displayBrowserUrl(nextUrl));
      setHasNavigated(true);
      lastRestorableUrlRef.current = nextUrl;
      onUrlChange?.(nextUrl);
      setBrowserState((prev) => ({ ...prev, errorMessage: null, loadErrorCode: null }));
      lastRequestedUrlRef.current = nextUrl;

      if (!webview || !browserState.isReady) {
        pendingUrlRef.current = nextUrl;
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      try {
        await webview.loadURL(nextUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("ERR_ABORTED")) return;
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage(
            { id: "browser.loadFailed" },
            { message: describeBrowserLoadFailure({ rawError: error }) },
          ),
          isLoading: false,
        }));
      }
    },
    [
      browserState.guestFailure,
      browserState.isLoading,
      browserState.isReady,
      completePendingGuestNavigation,
      intl,
      onUrlChange,
      rebuildBrowserGuest,
      waitForGuestNavigationTakeover,
      webview,
    ],
  );

  // ---- Navigate to the initial/restored URL on mount (restoring a human tab) ----
  useEffect(() => {
    if (!initialUrl || initialUrl === DEFAULT_BROWSER_URL) return;
    lastRestorableUrlRef.current = initialUrl;
    if (lastAppliedInitialUrlRef.current === initialUrl) return;
    if (browserState.currentUrl === initialUrl) {
      lastAppliedInitialUrlRef.current = initialUrl;
      setHasNavigated(true);
      setAddressValue(displayBrowserUrl(initialUrl));
      return;
    }
    lastAppliedInitialUrlRef.current = initialUrl;
    void openUrl(initialUrl, "restore");
  }, [browserState.currentUrl, initialUrl, openUrl]);

  // ---- External navigation request ({id,url}): navigate and acknowledge ----
  useEffect(() => {
    if (!navigationRequest) return;
    if (lastHandledNavigationRequestIdRef.current === navigationRequest.id) return;
    lastHandledNavigationRequestIdRef.current = navigationRequest.id;
    void openUrl(navigationRequest.url, "request").finally(() => {
      onNavigationRequestHandled?.(navigationRequest.id);
    });
  }, [navigationRequest, onNavigationRequestHandled, openUrl]);

  // ---- Tool/navigation buttons (isReady gate + safeWebviewCall fallback for detach races at click time) ----
  const runWebviewAction = useCallback((action: () => void) => {
    safeWebviewCall(
      () => {
        action();
        return undefined;
      },
      undefined,
      (error) => {
        logger.debug("[browser-use] 跳过未就绪 webview 的操作", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, []);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void openUrl(addressValue);
    },
    [addressValue, openUrl],
  );

  const handleGoBack = useCallback(() => {
    if (!webview || !browserState.canGoBack) return;
    runWebviewAction(() => webview.goBack());
  }, [browserState.canGoBack, runWebviewAction, webview]);

  const handleGoForward = useCallback(() => {
    if (!webview || !browserState.canGoForward) return;
    runWebviewAction(() => webview.goForward());
  }, [browserState.canGoForward, runWebviewAction, webview]);

  const handleReload = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => webview.reload());
  }, [browserState.isReady, runWebviewAction, webview]);

  const handleOpenDevTools = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => webview.openDevTools());
  }, [browserState.isReady, runWebviewAction, webview]);

  const handleOpenExternal = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => {
      const currentUrl = webview.getURL();
      // Security boundary: the system-default browser entry allows only Web URLs and file URLs; inline protocols such as about/data remain blocked.
      if (!isDefaultBrowserOpenableUrl(currentUrl)) return;
      platform.openExternal(currentUrl);
    });
  }, [browserState.isReady, platform, runWebviewAction, webview]);

  const handleTogglePicker = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    void toggleWebElementPicking().catch((error: unknown) => {
      setBrowserState((prev) => ({
        ...prev,
        errorMessage: intl.formatMessage(
          { id: "browser.elementPickerFailed" },
          { message: error instanceof Error ? error.message : String(error) },
        ),
      }));
    });
  }, [browserState.isReady, intl, toggleWebElementPicking, webview]);

  const handleToggleResponsiveMode = useCallback(() => {
    toggleResponsiveMode();
  }, [toggleResponsiveMode]);

  const handleResponsiveViewportSizeChange = updateResponsiveViewportSize;

  const handleResponsiveViewportInput = useCallback(
    (viewportSize: typeof responsiveViewportSize) => {
      notifyBrowserViewportResize();
      updateResponsiveViewportSize(viewportSize);
    },
    [notifyBrowserViewportResize, updateResponsiveViewportSize],
  );

  const faviconListenerRef = useRef<{
    node: ElectronWebviewTag;
    listener: (event: ElectronWebviewFaviconEvent) => void;
  } | null>(null);
  const handleWebviewRef = useCallback(
    (node: ElectronWebviewTag | null) => {
      const current = faviconListenerRef.current;
      if (current?.node === node) return;
      if (current) {
        current.node.removeEventListener("page-favicon-updated", current.listener);
        faviconListenerRef.current = null;
      }
      if (node) {
        const listener = (event: ElectronWebviewFaviconEvent) => {
          onPageMetadataChangeRef.current?.({
            faviconUrl: event.favicons[0] ?? null,
          });
        };
        // Favicon may be a one-time guest event. If the listener is connected only in useEffect,
        // it may fire between webview ref commit and effect execution. Attach the listener synchronously during the ref phase to close that gap.
        node.addEventListener("page-favicon-updated", listener);
        faviconListenerRef.current = { node, listener };
      } else if (webviewTeardownProbeRef.current.hadWebview) {
        // Generation changes (controlled rebuilds) and parent unmounts both reach here first. If a new node ref callback follows,
        // it is a generation change; otherwise the whole tree/conditional branch was unmounted. See the webviewTeardownProbeRef comment for teardown attribution.
        webviewTeardownProbeRef.current.hadWebview = false;
        logWebviewTeardown("ref-null");
      }
      if (node) webviewTeardownProbeRef.current.hadWebview = true;
      setWebview(node);
    },
    [logWebviewTeardown],
  );

  const handleRetryGuest = useCallback(() => {
    void rebuildBrowserGuest(lastRestorableUrlRef.current, "manual-retry");
  }, [rebuildBrowserGuest]);

  // A load failure means only this navigation was rejected; the guest is still alive, so call openUrl again without rebuilding it.
  const handleRetryLoad = useCallback(() => {
    const retryUrl = lastRestorableUrlRef.current ?? browserState.currentUrl;
    if (!retryUrl) return;
    void openUrl(retryUrl, "toolbar");
  }, [browserState.currentUrl, openUrl]);

  // Including the addressValue draft in empty-state detection hides the empty state and exposes the webview as soon as users start typing, before pressing Enter.
  // Empty state depends only on confirmed navigation and loading/error status.
  const isEmptyBrowserState =
    !hasNavigated && !browserState.isLoading && !browserState.errorMessage;
  const shouldMountWebview =
    !deferEmptyGuest || isResidencyRestore || hasNavigated || hasInitialNavigation;
  const prevShouldMountWebviewRef = useRef(shouldMountWebview);
  useEffect(() => {
    const previous = prevShouldMountWebviewRef.current;
    prevShouldMountWebviewRef.current = shouldMountWebview;
    if (previous && !shouldMountWebview && webviewTeardownProbeRef.current.hadWebview) {
      logWebviewTeardown("should-mount-flip");
    }
  }, [logWebviewTeardown, shouldMountWebview]);

  let permissionOrigin: string | null = null;
  try {
    const url = new URL(browserState.currentUrl);
    if (["http:", "https:"].includes(url.protocol)) permissionOrigin = url.origin;
  } catch {
    /* A blank page has no site permissions. */
  }

  // display:none on an inactive view makes Electron retain the old compositor surface, which gets tiled in background screenshots.
  // flex during preparation is for compositing only; outer inert, pointer-events-none, and aria-hidden isolate interaction and accessibility.
  return (
    <div
      aria-hidden={!isVisible}
      data-browser-screenshot-webview-state={
        screenshotSurfaceRequest ? (webview ? "ready" : "missing") : undefined
      }
      className={cn(
        isVisible || shouldComposeSurface ? "flex" : "hidden",
        "relative h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background",
      )}
    >
      <BrowserToolbar
        addressValue={addressValue}
        browserState={browserState}
        permissionControl={
          permissionOrigin ? (
            <BrowserSiteSettingsEntry
              origin={permissionOrigin}
              onOpenSettings={onOpenPermissionSettings}
            />
          ) : null
        }
        formatMessage={intl.formatMessage}
        onAddressChange={setAddressValue}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onOpenExternal={handleOpenExternal}
        onOpenDevTools={handleOpenDevTools}
        onPickElement={handleTogglePicker}
        onReload={handleReload}
        onToggleResponsiveMode={handleToggleResponsiveMode}
        onSubmit={handleSubmit}
        isElementPickerActive={isWebElementPicking}
        isResponsiveMode={isResponsiveMode}
      />
      {/* Permission dialog layer: mount only in the visible tab (tabs share a store, avoiding duplicate rendering and background requests appearing in the wrong tab); then filter permission requests by guest to the tab that initiated them. */}
      {isVisible ? (
        <EmbeddedBrowserPermissionPrompts guestWebContentsId={permissionGuestWebContentsId} />
      ) : null}
      {isResponsiveMode ? (
        <BrowserViewportToolbar
          isVisible={isVisible}
          onViewportSizeChange={handleResponsiveViewportInput}
          onZoomChange={setResponsiveViewportZoom}
          viewportSize={responsiveViewportSize}
          zoom={responsiveViewportZoom}
        />
      ) : null}
      <BrowserViewportSurface
        browserRegionRef={browserRegionRef}
        browserState={browserState}
        desktopZoomFactor={desktopZoomFactor}
        isResidencyRestore={isResidencyRestore}
        formatMessage={intl.formatMessage}
        isEmptyBrowserState={isEmptyBrowserState}
        isComposed={isVisible || shouldComposeSurface}
        isResponsiveMode={effectiveIsResponsiveMode}
        isViewportEmulated={
          effectiveIsResponsiveMode && screenshotSurfaceRequest?.viewportMode !== "natural"
        }
        onRetryGuest={handleRetryGuest}
        onRetryLoad={handleRetryLoad}
        onViewportResize={notifyBrowserViewportResize}
        onViewportSizeChange={handleResponsiveViewportSizeChange}
        onWebviewRef={handleWebviewRef}
        shouldMountWebview={shouldMountWebview}
        showResizeWarning={showResizeWarning}
        webviewGeneration={webviewGeneration}
        viewportSize={effectiveViewportSize}
        viewportZoom={effectiveViewportZoom}
      />
    </div>
  );
}
