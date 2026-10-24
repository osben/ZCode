# Dev build icon badge

## Background

When a dev build (`pnpm dev:desktop`) and the released ZCode run side by side, their Dock icons are identical and indistinguishable.

## Design

When unpackaged (`!app.isPackaged`), main overlays a blue diagonal "DEV" ribbon on the top-left corner of the app icon at startup:

- Rendering: `renderDevBadgeIcon()` in `packages/desktop/src/main/devIconBadge.ts`
  - Reads `build/icon.png` (`icon_windows.png` on Windows).
  - Composites directly with `sharp`: `buildDevRibbonSvg(size)` generates a blue-with-white-text "DEV" ribbon SVG rotated -45°, with geometry scaled proportionally to the icon size.
  - Ribbon thickness is `19.9%` of the icon size, text `15.2%` — about 20% larger overall than the previous version.
  - The rotation center sits at `24%` of the icon size; the enlarged ribbon also shifts toward the bottom-right, keeping a more visible patch of the original dark icon area in the top-left corner.
  - The ribbon is `composite`d onto the original image, then the original is reused as a `dest-in` mask so the ribbon is clipped to the icon's rounded silhouette and never bleeds into the transparent corners.
  - The resulting PNG becomes a `nativeImage` entirely in memory; nothing is written to disk.
  - Any step failure logs a warning and returns `null`, falling back to the original icon without affecting startup.
- Application points (`packages/desktop/src/main/index.ts`):
  - macOS Dock: `applyAppIcon(devBadgeIcon ?? iconPath)` (`applyAppIcon` accepts a `NativeImage` directly).
  - Windows/Linux window icons: the main window is created via `createWindowInstance()` → `createWindow()` → `createBrowserWindow()`, where `iconPath` accepts `string | NativeImage`; dev passes `devBadgeIcon ?? iconPath`, so the taskbar/title bar shows the DEV badge. The updater status window uses the badge icon too.
- Packaged builds skip this logic entirely; their icons are unchanged.

## Tests

- `packages/desktop/test/devIconBadge.test.ts`: ribbon SVG contract (diagonal rotation, blue background, size scaling, top-left placement); `renderDevBadgeIcon` success, read-failure, and empty-image fallback paths.
- `packages/desktop/test/desktopWindowChrome.test.ts`: `applyAppIcon` uses a passed `NativeImage` directly; `createBrowserWindow` passes a `NativeImage` icon through to `BrowserWindow.icon` (Windows/Linux main-window badge regression guard).
