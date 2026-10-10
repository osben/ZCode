/**
 * Preload for the CUA permission drag panel.
 *
 * Expose only the three capabilities this panel needs instead of reusing the main window's large preload.
 * The panel is an unfocused window displayed over System Settings, so its attack surface should stay small.
 *
 * `startDrag` must use send instead of invoke: Electron requires native dragging to start synchronously
 * in the dragstart event chain. The invoke Promise round trip misses the OS drag gesture window, so
 * holding and dragging would produce no dragged item.
 */
import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels, type CuaPermissionKind, type Locale } from "@zcode/shared";

const CUA_PERMISSION_PANEL_STATE_CHANNEL = "zcode:cua-permission-panel-state";

interface CuaPermissionPanelState {
  permission: CuaPermissionKind;
  /** The current ZCode UI language maintained by main; the panel must not read system language or localStorage. */
  locale: Locale;
  /** The real ZCode icon as a data URL; null keeps the placeholder graphic visible. */
  iconDataUrl: string | null;
}

contextBridge.exposeInMainWorld("cuaPermissionPanel", {
  /** Warm up the verified Helper path and fingerprint on mount so dragstart can call startDrag synchronously. */
  prepareDrag: () => ipcRenderer.invoke(PlatformChannels.PrepareCuaHelperPermissionDrag),
  /** Start a native file drag synchronously. Call this directly from the dragstart handler. */
  startDrag: () => ipcRenderer.send(PlatformChannels.StartCuaHelperPermissionDrag),
  /** The drag gesture has ended, so the panel can close. */
  notifyDragEnded: () => ipcRenderer.send(PlatformChannels.NotifyCuaHelperPermissionDragEnded),
  /** Receive the current permission step and app icon from main to update copy and the tile icon. */
  onState: (callback: (state: CuaPermissionPanelState) => void) => {
    const listener = (_event: unknown, payload: CuaPermissionPanelState) => callback(payload);
    ipcRenderer.on(CUA_PERMISSION_PANEL_STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(CUA_PERMISSION_PANEL_STATE_CHANNEL, listener);
  },
});
