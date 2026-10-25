# System zoom shortcuts

## Background

The desktop previously removed ZCode's custom interface zoom setting so that historical `localStorage` zoom
ratios no longer affect the first screen. After that, the app menu no longer contained Electron's native page
zoom role, so the common system shortcuts `Cmd/Ctrl + +/-/0` could not zoom the current window content.

## Goals

- Restore the desktop's system-level page zoom shortcuts.
- Use desktop commands to carry `Cmd/Ctrl + 0/+/-` and limit the current window's page zoom level to between
  `-3` (zoom out) and `+5` (zoom in).
- On macOS, after each zoom, adjust the vertical position of the top-left traffic-light native buttons and
  notify the renderer to adjust the left safe area of the top overlay in step; the traffic-light width itself
  does not change with page zoom, and the horizontal position temporarily keeps the system initial value.
- It acts only on the desktop current window's page zoom, without reintroducing a UI settings page, an account
  menu entry, a persisted zoom level or a dedicated platform API.

## Non-goals

- The old three-level interface zoom preference is not restored.
- The historical `zcode-zoom-level` is not read or written.
- The Web / mobile remote link is unchanged; mobile keeps using the browser's own zoom and the existing
  replayable recovery boundary.

## Implementation

- `packages/shared/src/desktopMenu.ts` adds the desktop menu copy for View-menu Actual Size, Zoom In and Zoom
  Out.
- `packages/desktop/src/main/desktopApplicationMenu.ts` adds the accelerators `CmdOrCtrl+0`, `CmdOrCtrl+Plus`
  and `CmdOrCtrl+-` to the View menu, and keeps a hidden `CmdOrCtrl+=` zoom-in fallback for different keyboard
  layouts.
- View-menu Actual Size, Zoom In and Zoom Out are disabled by the focused window's zoom level: Actual Size
  disabled at the default size, Zoom In at the maximum `+5` level, Zoom Out at the minimum `-3` level; the
  hidden `CmdOrCtrl+=` fallback and Zoom In share the same disabled state.
- `packages/desktop/src/main/desktopCommandHandlers.ts` handles `ResetZoom`, `ZoomIn` and `ZoomOut` uniformly:
  it reads the current `zoomFactor`, converts it to an internal level, calls
  `webContents.setZoomFactor(1.1 ^ level)` and clamps the level to `[-3, 5]`.
- The app menu is refreshed after each zoom command; it is also refreshed when the main window regains focus,
  so the system menu does not keep a stale disabled state.
- `packages/desktop/src/main/desktopWindowButtonPosition.ts` reuses the macOS initial traffic-light position
  `{ x: 24, y: 25 }`; horizontal `x` temporarily stays `24`, vertical `y` is displaced by the uniform zoom factor
  `1.1 ^ level` times a visual-follow gain of `1.5`, then `setWindowButtonPosition` is called; the top overlay
  receives `leftPaddingPx` as `96 / zoomFactor`. Windows does not adjust native button coordinates but syncs
  `titleBarOverlay.height` as `48 * zoomFactor` to the current zoom level so the top-right
  minimize/maximize/close buttons keep following the zoom; the renderer uses the Window Controls Overlay
  `titlebar-area-*` CSS geometry as the source of truth for the right safe area and keeps `136 / zoomFactor` as
  the fallback when the environment variables are unavailable. The custom caption button width is derived from
  the real safe area divided by the three native buttons, so zoom or DPI differences cannot let the dropdown
  button enter the minimize button area. Linux does not yet compensate the native button area.
- `packages/desktop/src/main/desktopWindowChrome.ts` reads the current `zoomFactor` right after the window is
  created and syncs the macOS traffic-light position; `packages/desktop/src/preload/index.ts` synchronously reads
  `webFrame.getZoomFactor()` before React takes over the root, caching the top overlay safe area for the first
  render of `RootStartupLoading` and notifying main through `WindowControlsOverlayReady` to reset the
  traffic-light position early, rather than adjusting only after entering the App page.
- `packages/desktop/test/desktopApplicationMenu.test.ts` verifies the View menu forwards the shortcuts to
  controlled desktop commands, and `packages/desktop/test/desktopCommandHandlers.test.ts` verifies the zoom
  bounds.
