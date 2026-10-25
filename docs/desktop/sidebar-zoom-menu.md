# Sidebar zoom menu

## Background

The desktop already supports page zoom via the View menu and `Cmd/Ctrl + +/-/0`, with internal levels
`[-3, 5]` and a factor of `1.1 ^ level` per level. The sidebar avatar menu once dropped the old
`zcode-zoom-level` localStorage preference; the lightweight menu restored later only reused the current window's
system zoom commands, so a size adjusted through the menu or shortcuts went back to the default on the next
restart.

## Goals

- The desktop sidebar avatar menu shows an `Interface zoom` submenu containing three commands: `Zoom In`,
  `Zoom Out` and `Actual Size`.
- Menu items run the existing `DesktopCommandIds.ZoomIn` / `ZoomOut` / `ResetZoom` and save the successful
  desktop zoom level as `AppSettings.desktopZoomLevel`.
- When the main window is created, the main process reads the saved level and applies it to
  `BrowserWindow.webContents` first, so the first screen, the macOS traffic-light position and the Windows title
  bar control area use one zoom source of truth.
- Disabled states match the View menu: the maximum `+5` level disables `Zoom In`, the minimum `-3` level
  disables `Zoom Out`, and the default level disables `Actual Size`.
- The renderer reads and subscribes to the current desktop zoom level through a platform capability, so the
  sidebar menu state also stays in sync after a shortcut or the top menu triggers it.

## Non-goals

- The browser's own zoom on Web / mobile is unchanged.
- The Web remote replayable recovery chain is unchanged and no zoom state is added to the remote-control link.
- The old settings-page Interface zoom preference and `zcode-zoom-level` localStorage read/write are not
  restored.
- The mobile Web remote replayable recovery semantics do not spread to the desktop continuous main link; the
  zoom preference affects only the desktop BrowserWindow.

## Implementation

- `packages/shared/src/platform.ts` defines `DesktopZoomState` and the desktop zoom read/subscribe capability of
  `IPlatformService`.
- `packages/shared/src/channels.ts` adds the platform channels `GetDesktopZoomLevel` and
  `DesktopZoomLevelChanged`.
- `packages/shared/src/protocol.ts` and `packages/shared/src/validationAppSettings.ts` add `desktopZoomLevel`,
  allowing old config to omit it and accepting a persisted level within `[-3, 5]`.
- After a successful zoom command the desktop main sends the latest level to the corresponding window, writes it
  to `setting.json`, and keeps refreshing the native View menu disabled states.
- At startup the desktop main reads `AppSettings.desktopZoomLevel` and passes it to the window creation flow as
  `initialDesktopZoomLevel`.
- The desktop preload caches the latest level and provides `getDesktopZoomLevel` / `onDesktopZoomLevelChanged`.
- `WorkspaceSidebarFooter` shows the `Interface zoom` submenu only when `isDesktop` and reuses the existing View
  menu command copy; the avatar menu restores the original display-preference order: `Language`, `App theme`,
  `Interface zoom`.
- The visible zoom item order of the desktop system View menu matches the sidebar submenu: `Zoom In`,
  `Zoom Out`, `Actual Size`.

## Verification

- Unit tests cover writing `desktopZoomLevel` after a successful zoom command, and applying the persisted zoom
  first when the window is created.
- `pnpm typecheck`
- `pnpm lint`
