export interface BrowserWindowForTransparentBootstrap {
  isDestroyed(): boolean;
  isVisible?(): boolean;
  isMinimized?(): boolean;
  isFocused?(): boolean;
  getOpacity?(): number;
  setOpacity?(opacity: number): void;
  showInactive?(): void;
  hide?(): void;
  setSkipTaskbar?(skip: boolean): void;
  on?(event: "focus", listener: () => void): void;
  removeListener?(event: "focus", listener: () => void): void;
}

export interface TransparentWindowBootstrap {
  release(): void;
}

/**
 * Bounded presentation grace after showInactive and before Viz surface creation: reading it back in
 * the same turn throws UnknownVizError (and has caused SIGSEGV under concurrency). Every path that
 * captures immediately after showInactive (activity pump, full capture) must use the same constant.
 */
export const TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS = 100;

/**
 * Provide one user-invisible, window-level presentation for guests created only after a macOS hide-close.
 *
 * Return undefined when no bootstrap is needed and false when the current window cannot be bootstrapped safely.
 */
export function startBrowserScreenshotTransparentWindowBootstrap(options: {
  win: BrowserWindowForTransparentBootstrap;
  enabled: boolean;
  windowId: number;
  webContentsId: number;
  requestId: string;
  hideTaskbarDuringBootstrap?: boolean;
  log?(message: string): void;
}): TransparentWindowBootstrap | false | undefined {
  const { win } = options;
  if (!options.enabled || win.isVisible?.() !== false || win.isMinimized?.() === true) {
    return undefined;
  }
  if (
    !win.isFocused ||
    !win.getOpacity ||
    !win.setOpacity ||
    !win.showInactive ||
    !win.hide ||
    !win.on ||
    !win.removeListener ||
    (options.hideTaskbarDuringBootstrap && !win.setSkipTaskbar)
  ) {
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap unavailable windowId=${options.windowId} webContentsId=${options.webContentsId} requestId=${options.requestId}`,
    );
    return false;
  }

  let originalOpacity: number;
  try {
    originalOpacity = win.getOpacity();
  } catch {
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap opacity read failed windowId=${options.windowId}`,
    );
    return false;
  }

  let released = false;
  let taskbarHidden = false;
  const release = (preserveVisibility: boolean) => {
    if (released) return;
    released = true;
    try {
      win.removeListener?.("focus", handleFocus);
    } catch {
      options.log?.(
        `[browser-screenshot-activity] transparent bootstrap listener cleanup failed windowId=${options.windowId}`,
      );
    }
    if (win.isDestroyed()) return;

    try {
      if (!preserveVisibility && !win.isFocused?.()) {
        win.hide?.();
      }
    } catch {
      options.log?.(
        `[browser-screenshot-activity] transparent bootstrap hide failed windowId=${options.windowId}`,
      );
    } finally {
      if (!win.isDestroyed()) {
        try {
          win.setOpacity?.(originalOpacity);
        } catch {
          options.log?.(
            `[browser-screenshot-activity] transparent bootstrap opacity restore failed windowId=${options.windowId}`,
          );
        }
        if (taskbarHidden) {
          try {
            win.setSkipTaskbar?.(false);
          } catch {
            options.log?.(
              `[browser-screenshot-activity] transparent bootstrap taskbar restore failed windowId=${options.windowId}`,
            );
          }
        }
      }
    }
  };
  const handleFocus = () => {
    // Transparent bootstrap may race with the user restoring the window from the Dock/second-instance.
    // Focus means window ownership has returned to the user; restore transparency only, and do not
    // hide again in a later Ready/release callback.
    release(true);
  };

  try {
    // A guest attached only after its owner was hidden has never received a compositor first frame;
    // capturer count can only keep an existing surface alive. Make the window transparent before
    // showInactive to give the guest an invisible presentation opportunity, then restore the
    // original window state on Ready/release.
    if (options.hideTaskbarDuringBootstrap) {
      win.setSkipTaskbar?.(true);
      taskbarHidden = true;
    }
    win.setOpacity(0);
    win.on("focus", handleFocus);
    win.showInactive();
  } catch {
    release(true);
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap failed windowId=${options.windowId} webContentsId=${options.webContentsId} requestId=${options.requestId}`,
    );
    return false;
  }

  return { release: () => release(false) };
}
