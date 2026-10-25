# Interface zoom removal

## Background

ZCode used to offer three interface zoom levels: smaller, normal and larger. Entries were the desktop View menu
shortcuts, the settings page and the sidebar account menu, and the current window zoom was persisted through
`localStorage` and Electron `webFrame` / `webContents`.

## Goals

- Remove the user-visible interface zoom feature.
- Remove the startup logic that restores `zcode-zoom-level`, so a historical ratio no longer affects the first
  screen.
- Remove Actual Size / Zoom In / Zoom Out and the matching shortcuts from the desktop View menu.
- Remove the interface zoom entries from the UI settings page and account menu.
- Remove the APIs in platform/preload/web fallback that served only interface zoom.

## Non-goals

- The macOS system window green-button zoom/maximize/fullscreen behavior is not removed.
- Zoom with its own semantics in business canvas, graph, PDF, document or animation components is not removed.
- The historical `zcode-zoom-level` `localStorage` key on user machines is not migrated or cleaned; it simply
  stops mattering once the code no longer reads it.

## Impact

- Desktop: the app menu no longer registers interface zoom shortcuts, and the main process no longer handles the
  `resetZoom` / `zoomIn` / `zoomOut` desktop commands.
- Web/mobile: these were only no-op fallbacks; removing them does not change the remote-control link.
- UI layer: the settings page and sidebar account menu no longer show interface zoom.

## Follow-up

`docs/desktop/system-zoom-shortcuts.md` restored controlled system page zoom shortcuts. They provide only the
current-window zoom of `Cmd/Ctrl + +/-/0`, limited to 5 steps up and down from the default size, and do not
restore the old persisted interface zoom setting or UI entries.
