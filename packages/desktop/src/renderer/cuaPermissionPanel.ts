import type {
  CuaPermissionKind,
  Locale,
  PrepareCuaHelperPermissionDragResult,
} from "@zcode/shared";
import { resolveCuaPermissionPanelMessages } from "./cuaPermissionPanelMessages.js";

interface CuaPermissionPanelState {
  permission: CuaPermissionKind;
  locale: Locale;
  iconDataUrl: string | null;
}

declare global {
  interface Window {
    cuaPermissionPanel?: {
      prepareDrag?(): Promise<PrepareCuaHelperPermissionDragResult>;
      startDrag?(): void;
      notifyDragEnded?(): void;
      onState?(callback: (state: CuaPermissionPanelState) => void): () => void;
    };
  }
}

const bridge = window.cuaPermissionPanel;
const tile = document.getElementById("tile");
const hintPrefix = document.getElementById("hintPrefix");
const permissionLabel = document.getElementById("permissionLabel");
const hintSuffix = document.getElementById("hintSuffix");
const completion = document.getElementById("completion");
const icon = document.querySelector<HTMLElement>(".icon");

// Prewarm on mount: install+verify are asynchronous and must finish before the user starts dragging;
// otherwise dragstart cannot synchronously initiate the drag (waiting for I/O would miss the gesture window).
// Also retrieve the Helper's actual display name—the tile must show it instead of a hard-coded string,
// because the macOS permissions list uses this value (with a Dev suffix in development),
// so users can confirm the item they dragged is the same one shown there.
bridge
  ?.prepareDrag?.()
  .then((result) => {
    const appName = document.getElementById("appName");
    if (result?.helperDisplayName && appName) {
      appName.textContent = result.helperDisplayName;
    }
  })
  .catch(() => {});

bridge?.onState?.((state) => {
  const messages = resolveCuaPermissionPanelMessages(state.locale, state.permission);
  document.documentElement.lang = state.locale;
  document.title = messages.documentTitle;
  if (tile) tile.title = messages.dragTitle;
  if (hintPrefix) hintPrefix.textContent = messages.hintPrefix;
  if (permissionLabel) permissionLabel.textContent = messages.permissionLabel;
  if (hintSuffix) hintSuffix.textContent = messages.hintSuffix;
  if (completion) completion.textContent = messages.completion;
  // Replace the placeholder gradient with the real ZCode icon, matching the icon shown in System Settings.
  if (state.iconDataUrl && icon) {
    icon.style.backgroundImage = `url("${state.iconDataUrl}")`;
  }
});

let dragStarted = false;

tile?.addEventListener("dragstart", (event) => {
  // Prevent the default HTML5 drag and have main start a native file drag with webContents.startDrag;
  // only a native drag session can be accepted by the permissions list in System Settings.
  event.preventDefault();
  dragStarted = true;
  bridge?.startDrag?.();
});

// Authorization is complete after the drag, so the floating window should get out of the way. Close it on drag end rather than dragstart:
// startDrag only hands the drag session to the OS (non-blocking), and removing the drag source immediately may interrupt the active drag.
const notifyDragEnded = () => {
  if (!dragStarted) return; // A click without dragging should not close the window.
  dragStarted = false;
  bridge?.notifyDragEnded?.();
};

// Whether dragend still fires after preventDefault depends on the Electron implementation, so use mouseup as a fallback
// (mouse events return to the page after the native drag session ends). Both signals are guarded by dragStarted, and main-side
// hide is idempotent, so duplicate notifications are harmless. If neither signal arrives, freezePosition remains a fallback to keep the floating window in place.
tile?.addEventListener("dragend", notifyDragEnded);
document.addEventListener("mouseup", notifyDragEnded);
