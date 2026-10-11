import { useEffect, useRef, useState } from "react";
import type { DesktopWindowChromeState, IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX = 96;
const WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX = 136;

function readFinitePositivePx(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function resolveInitialWindowControlsPaddingPx({
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  platform,
}: {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  platform: IPlatformService;
}) {
  const metrics = platform.getWindowControlsOverlayMetrics?.();
  const leftPaddingPx =
    isDesktop && isMacDesktop
      ? (readFinitePositivePx(metrics?.leftPaddingPx) ??
        MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX)
      : MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX;
  const rightPaddingPx =
    isDesktop && isWindowsDesktop
      ? (readFinitePositivePx(metrics?.rightPaddingPx) ??
        WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX)
      : WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX;

  return { leftPaddingPx, rightPaddingPx };
}

function resolveLegacyReadyVersionFromState(payload: UpdateStatePayload) {
  // The old UpdateReady event only told the renderer that a version was ready; it did not report later
  // transitions to non-installable states such as staging error. When the new state stream is not update-downloaded, clear any old ready state.
  return payload.kind === "update-downloaded" ? payload.version : null;
}

export function useAppChromeState({
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  platform,
  workspaceAbsPath,
}: {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  platform: IPlatformService;
  workspaceAbsPath: string;
}) {
  const initialWindowControlsPadding = resolveInitialWindowControlsPaddingPx({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    platform,
  });
  const [isMacFullscreen, setIsMacFullscreen] = useState(false);
  const [desktopWindowChromeState, setDesktopWindowChromeState] =
    useState<DesktopWindowChromeState | null>(null);
  const [macWindowControlsLeftPaddingPx, setMacWindowControlsLeftPaddingPx] = useState(
    () => initialWindowControlsPadding.leftPaddingPx,
  );
  const [windowsWindowControlsRightPaddingPx, setWindowsWindowControlsRightPaddingPx] = useState(
    () => initialWindowControlsPadding.rightPaddingPx,
  );
  const [updateReadyVersion, setUpdateReadyVersion] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null);
  const sidebarContainerRef = useRef<HTMLElement | null>(null);
  const hasShownUpdateToastRef = useRef(false);
  const updateStateEventRevisionRef = useRef(0);
  const { intl } = useZCodeIntl();

  useEffect(() => {
    if (!isDesktop || !isMacDesktop) {
      setIsMacFullscreen(false);
      setMacWindowControlsLeftPaddingPx(MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX);
      return;
    }

    // After macOS enters fullscreen, the red/green traffic lights return close to the top-left layout.
    // Keeping the windowed pl-24 in the top overlay makes the left safe area too wide, visually making the three buttons look “gone.”
    // Subscribe to desktop-window fullscreen state and narrow the padding only in macOS fullscreen; normal windowed layout is unaffected.
    return platform.onWindowFullscreenChanged((fullscreen) => {
      setIsMacFullscreen(fullscreen);
    });
  }, [isDesktop, isMacDesktop, platform]);

  useEffect(() => {
    // Excluding macOS would leave the version unknown and make Tahoe incorrectly use Sequoia’s 6px corner radius.
    // Share the window-state query across Desktop platforms, preserving event priority and cleanup on unmount; Web does not read native state.
    if (!isDesktop || !platform.getDesktopWindowChromeState) {
      setDesktopWindowChromeState(null);
      return;
    }

    let disposed = false;
    let eventRevision = 0;
    const dispose = platform.onDesktopWindowChromeStateChanged?.((state) => {
      eventRevision += 1;
      setDesktopWindowChromeState(state);
    });
    const requestRevision = eventRevision;

    // Listening only to maximize/unmaximize misses the initial state when the app starts with the window already maximized.
    // Subscribe first, then query; use revision to stop a slower query result from overwriting a newer window event.
    void platform.getDesktopWindowChromeState().then(
      (state) => {
        if (!disposed && eventRevision === requestRevision) setDesktopWindowChromeState(state);
      },
      (error) => logger.warn("[app-chrome] 同步桌面窗口外观状态失败", { error }),
    );

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [isDesktop, platform]);

  useEffect(() => {
    const isLinuxDesktop = isDesktop && !isMacDesktop && !isWindowsDesktop;
    const rootElement = document.documentElement;
    if (!rootElement) return;
    // The Linux shell is clipped by the renderer; retaining rounded corners after maximize would leave transparent gaps in screen corners.
    // Reuse the main-process window state as the single source so Workspace and Settings switch together.
    rootElement.classList.toggle(
      "window-maximized",
      isLinuxDesktop && (desktopWindowChromeState?.isMaximized ?? false),
    );
    return () => rootElement.classList.remove("window-maximized");
  }, [desktopWindowChromeState?.isMaximized, isDesktop, isMacDesktop, isWindowsDesktop]);

  useEffect(() => {
    if (
      !isDesktop ||
      (!isMacDesktop && !isWindowsDesktop) ||
      !platform.onWindowControlsOverlayChanged
    ) {
      setMacWindowControlsLeftPaddingPx(MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX);
      setWindowsWindowControlsRightPaddingPx(WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX);
      return;
    }

    // After page zoom, native window controls do not scale with renderer zoom.
    // Synchronize the macOS left traffic-light safe area and the Windows right title-bar button safe area.
    return platform.onWindowControlsOverlayChanged((metrics) => {
      const leftPaddingPx = readFinitePositivePx(metrics.leftPaddingPx);
      const rightPaddingPx = readFinitePositivePx(metrics.rightPaddingPx);
      logger.debug("[app-chrome] 收到原生窗口控制区几何变化", {
        isMacDesktop,
        isWindowsDesktop,
        leftPaddingPx,
        rightPaddingPx,
      });
      if (isMacDesktop && leftPaddingPx !== null) {
        setMacWindowControlsLeftPaddingPx(leftPaddingPx);
      }
      if (isWindowsDesktop && rightPaddingPx !== null) {
        setWindowsWindowControlsRightPaddingPx(rightPaddingPx);
      }
    });
  }, [isDesktop, isMacDesktop, isWindowsDesktop, platform]);

  useEffect(() => {
    if (!platform.onUpdateReady) {
      return;
    }

    // Update-ready state used to live inside button components, forcing each one to subscribe to platform events separately.
    // WorkspaceHeader therefore could not know “whether an update is currently available,” and multiple entry points risked maintaining divergent states.
    // Manage version state centrally in App, then distribute it to Header / Overlay as needed.
    return platform.onUpdateReady((version) => {
      logger.info("[App] 收到可安装更新", {
        workspaceAbsPath,
        version,
      });
      setUpdateReadyVersion(version);

      // On Windows Desktop, show a brief non-blocking hint when an update arrives.
      if (isWindowsDesktop && !hasShownUpdateToastRef.current) {
        hasShownUpdateToastRef.current = true;
        toast(intl.formatMessage({ id: "update.toast.ready" }, { version }), {
          durationMs: 4000,
          position: "bottom-left",
          variant: "update",
        });
      }
    });
  }, [platform, workspaceAbsPath, isWindowsDesktop, intl]);

  useEffect(() => {
    let cancelled = false;

    if (platform.getUpdateState) {
      const requestRevision = updateStateEventRevisionRef.current;
      void platform.getUpdateState().then(
        (payload) => {
          if (!cancelled && updateStateEventRevisionRef.current === requestRevision) {
            setUpdateState(payload);
            setUpdateReadyVersion(resolveLegacyReadyVersionFromState(payload));
          }
        },
        (error) => {
          logger.warn("[App] 同步自动更新状态失败", { error });
        },
      );
    }

    if (!platform.onUpdateStateChanged) {
      return () => {
        cancelled = true;
      };
    }

    const dispose = platform.onUpdateStateChanged((payload) => {
      updateStateEventRevisionRef.current += 1;
      setUpdateState(payload);
      setUpdateReadyVersion(resolveLegacyReadyVersionFromState(payload));
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [platform]);

  return {
    isMacFullscreen,
    desktopWindowChromeState,
    macWindowControlsLeftPaddingPx,
    windowsWindowControlsRightPaddingPx,
    updateReadyVersion,
    updateState,
    sidebarContainerRef,
  };
}
