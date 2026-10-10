/**
 * Lifecycle management for the CUA permission-drag panel.
 *
 * This window has four non-negotiable properties, all based on testing:
 *
 * 1. **Must not activate its owning app** (`type: "panel"` + `focusable: false`; both are required).
 *    It floats above System Settings while the user drags between the panel and Settings. Setting
 *    only focusable still activates ZCode.app when clicked, moving focus to the main window and
 *    breaking the flow; see the comment in `createRealCuaPermissionPanelWindow`.
 * 2. **Must stay above System Settings** (`alwaysOnTop(true, "screen-saver")`). The ordinary `floating`
 *    level is covered while Settings is active.
 * 3. **Stop tracking position after the drop** (`freezePosition()`). System Settings then shows a
 *    modal warning; continued tracking would make the panel follow it and move underneath.
 * 4. **Destroy on every terminal state.** A PiP panel once remained open indefinitely because its
 *    lifecycle boundaries were unclear. Here show/hide/destroy states are explicit, and destroy is
 *    idempotent and stops the position source.
 *
 * Inject the real BrowserWindow through `createWindow` so lifecycle and positioning can be unit-tested without Electron.
 */

import type { CuaPermissionKind, Locale } from "@zcode/shared";
import { resolvePanelBounds, type PanelSize, type Rect } from "./cuaPermissionPanelPositioner.js";

/** Minimal window interface required by the panel, suitable for test doubles. */
interface CuaPermissionPanelWindow {
  onceReadyToShow(callback: () => void): void;
  setBounds(bounds: Rect): void;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

interface CreateCuaPermissionDragPanelOptions {
  createWindow: (initialBounds: Rect) => CuaPermissionPanelWindow;
  getDisplayWorkArea: () => Rect;
  /** System Settings window-bounds source; when missing or failing, fall back to the bottom of the screen. */
  getSettingsBounds?: () => Rect | null;
  /** Release the source above (usually by killing the persistent child process). */
  stopSettingsBounds?: () => void;
  /** App icon shown in the panel tile (data URL). The page uses its built-in placeholder if absent. */
  getIconDataUrl?: () => string | null;
  /** Current ZCode interface language. Read it again on each show; the panel must not guess the system language. */
  getLocale: () => Locale;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  panelSize?: PanelSize;
  repositionIntervalMs?: number;
}

export interface CuaPermissionDragPanel {
  show(permission: CuaPermissionKind): void;
  /**
   * Stop position tracking while keeping the window visible and draggable.
   *
   * After the drop, System Settings shows a modal warning ("…may not be able to record…"). Continued
   * tracking would make the panel chase the dialog and move underneath it. Freeze the position after
   * the first drag: the user's attention is on Settings, and further panel movement would only
   * distract. Tracking resumes automatically when `show()` runs for the next permission stage.
   */
  freezePosition(): void;
  hide(): void;
  destroy(): void;
}

export const CUA_PERMISSION_PANEL_STATE_CHANNEL = "zcode:cua-permission-panel-state";

const DEFAULT_PANEL_SIZE: PanelSize = { width: 560, height: 124 };
// Track every 0.15 seconds to balance position-sync overhead with panel responsiveness while dragging in Settings.
const DEFAULT_REPOSITION_INTERVAL_MS = 150;

export function createCuaPermissionDragPanel(
  options: CreateCuaPermissionDragPanelOptions,
): CuaPermissionDragPanel {
  const panelSize = options.panelSize ?? DEFAULT_PANEL_SIZE;
  const intervalMs = options.repositionIntervalMs ?? DEFAULT_REPOSITION_INTERVAL_MS;

  let window: CuaPermissionPanelWindow | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastBounds: Rect | null = null;
  let destroyed = false;

  function readSettingsBounds(): Rect | null {
    if (!options.getSettingsBounds) return null;
    try {
      return options.getSettingsBounds();
    } catch (error) {
      // Fail open: snapping is only a visual enhancement; a broken data source must never break authorization guidance.
      options.logger.warn(
        "[cua-permission-panel] settings bounds source failed; falling back to screen bottom",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  function sameRect(a: Rect | null, b: Rect): boolean {
    return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  function reposition(): void {
    if (!window || window.isDestroyed()) return;
    const bounds = resolvePanelBounds({
      settings: readSettingsBounds(),
      display: options.getDisplayWorkArea(),
      panel: panelSize,
    });
    // Calling setBounds on every tick causes visible jitter; move only when the target rectangle changes.
    if (sameRect(lastBounds, bounds)) return;
    lastBounds = bounds;
    window.setBounds(bounds);
  }

  function startTracking(): void {
    if (timer) return;
    timer = setInterval(reposition, intervalMs);
    // Position tracking must never prevent process exit.
    timer.unref?.();
  }

  function stopTracking(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    show(permission: CuaPermissionKind): void {
      if (destroyed) destroyed = false;
      const initialBounds = resolvePanelBounds({
        settings: readSettingsBounds(),
        display: options.getDisplayWorkArea(),
        panel: panelSize,
      });
      lastBounds = initialBounds;

      if (!window || window.isDestroyed()) {
        window = options.createWindow(initialBounds);
        window.onceReadyToShow(() => {
          if (!window || window.isDestroyed()) return;
          window.setBounds(lastBounds ?? initialBounds);
          // The panel is a standalone static renderer outside the main React Intl tree; without a
          // locale, even English ZCode would show hard-coded Chinese. Send the current locale before
          // showing it to avoid a flash of Chinese fallback text.
          window.send(CUA_PERMISSION_PANEL_STATE_CHANNEL, {
            permission,
            locale: options.getLocale(),
            iconDataUrl: options.getIconDataUrl?.() ?? null,
          });
          window.showInactive();
          startTracking();
        });
        return;
      }

      window.setBounds(initialBounds);
      window.send(CUA_PERMISSION_PANEL_STATE_CHANNEL, {
        permission,
        locale: options.getLocale(),
        iconDataUrl: options.getIconDataUrl?.() ?? null,
      });
      window.showInactive();
      startTracking();
    },

    hide(): void {
      stopTracking();
      if (window && !window.isDestroyed()) window.hide();
    },

    freezePosition(): void {
      stopTracking();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stopTracking();
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
      lastBounds = null;
      options.stopSettingsBounds?.();
    },
  };
}

/**
 * Production window factory. Each property in this tested minimal set has a specific purpose:
 *   frame:false + transparent  — rounded floating appearance
 *   type:"panel"               — NSPanel + NSWindowStyleMaskNonactivatingPanel; clicking it does not activate its owning app
 *   focusable:false            — the window itself cannot receive focus
 *   skipTaskbar:true           — omit it from the Dock/task switching
 *   show:false + showInactive  — show without activating
 *   alwaysOnTop("screen-saver") — stay above System Settings; the floating level would be covered
 *
 * `type` and `focusable` must be set **together**. The initial version set only focusable:false, but
 * clicking the panel moved focus to the ZCode main window. A three-way comparison confirmed:
 *   focusable:false alone                     → app still activates; focus moves to its next focusable window (main)
 *   type:panel alone (focusable defaults true) → panel receives focus and activates the app; Settings is still displaced
 *   both together                             → no focus event on click; System Settings stays in front ✓
 * In other words, focusable controls whether the window gets focus, while type:panel controls
 * whether the app activates; either one alone is insufficient.
 */
export function createRealCuaPermissionPanelWindow(deps: {
  BrowserWindow: typeof import("electron").BrowserWindow;
  app: Pick<typeof import("electron").app, "isPackaged">;
  preloadPath: string;
  rendererDir: string;
  rendererDevUrl?: string | undefined;
}): (initialBounds: Rect) => CuaPermissionPanelWindow {
  return (initialBounds: Rect) => {
    const win = new deps.BrowserWindow({
      ...initialBounds,
      // macOS: NSPanel with NSWindowStyleMaskNonactivatingPanel — see above; this is required so clicking the panel does not send System Settings to the background.
      type: "panel",
      frame: false,
      transparent: true,
      hasShadow: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Match the main window: production packages always load renderer assets from the signed bundle.
    if (!deps.app.isPackaged && deps.rendererDevUrl) {
      void win.loadURL(`${deps.rendererDevUrl}/cua-permission-panel.html`);
    } else {
      void win.loadFile(`${deps.rendererDir}/cua-permission-panel.html`);
    }

    return {
      onceReadyToShow(callback: () => void) {
        win.once("ready-to-show", callback);
      },
      setBounds(bounds: Rect) {
        win.setBounds(bounds);
      },
      showInactive() {
        win.showInactive();
        win.setAlwaysOnTop(true, "screen-saver");
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      },
      hide() {
        win.hide();
      },
      destroy() {
        win.destroy();
      },
      isDestroyed: () => win.isDestroyed(),
      send(channel: string, payload: unknown) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      },
    };
  };
}
