# Desktop main window size

## Spec

- The desktop main window is created uniformly by `createBrowserWindow` in
  `packages/desktop/src/main/desktopWindowChrome.ts`.
- On first launch or without a valid saved state, the default window size stays `1200x800`.
- After the user resizes the main window, the desktop saves the width and height of the latest non-maximized
  window when a short debounce ends; after a full quit and restart, the latest size that completed persistence
  is restored.
- The maximized state is stored separately from the normal window size: after quitting while maximized, the next
  start first creates the window at the latest normal size and then maximizes it, so the maximized screen size
  does not pollute the normal window size.
- A restored size must be a finite positive integer and is clamped to the current primary display's available
  work area; a missing, corrupt value or one below the minimum window size falls back to the default. After
  display, resolution or scale-factor changes the main window must not be created beyond the current work area.
- The user can drag to change the window width; the height must not go below `640px`, so a 1280x720 desktop
  (available height below 768px) can still resize the window, while keeping basic usable space for the main
  workspace, top bar and bottom input area.
- The minimum width stays `480px` for narrow desktop windows; mobile Web does not reuse the Electron
  `BrowserWindow` constraint.
- Window size state is an app-global desktop setting, not isolated by workspace, remote session or window ID;
  Web, mobile `/remote`, auxiliary windows and task recovery state neither read nor write this field.

## Implementation

- The desktop main window resize lower bound is constrained through the Electron `BrowserWindow` constructor
  parameter `minHeight: 640`.
- At startup the main process reads and validates `desktopWindowSize` from `setting.json`, and after the window
  is created listens to resize/maximize/unmaximize events, asynchronously writing the stable state back to the
  settings service; consecutive resizes use a short debounce and maximized-state changes refresh immediately.
  Window close only cancels a not-yet-fired resize debounce and starts no new size write; the full-quit phase
  also creates no size write, to avoid leaving an async task still holding `setting.json.lock` after the quit
  barrier completes. If the user quits immediately before the resize debounce finishes, the last unpersisted size
  may be dropped.
- This constraint acts only on the desktop main window and does not affect Web, mobile `/remote` or
  non-resizable auxiliary popups.

## Impact brief

| Field | Value |
| --- | --- |
| Developer intent | Restore the main window size the user last adjusted after a full ZCode restart |
| Capability | Desktop main window size persistence |
| Change layer | persistence / recovery |
| Operating mode | planning |
| Primary seeds | `createWindow`, `createBrowserWindow`, `AppSettings`, `createSettingService` |
| Out of scope | window position, per-window independent sizes, auxiliary windows, Web/mobile |

| User scenario | UI entry | Display owner | Commit action | Authority/persistence | Mode boundary |
| --- | --- | --- | --- | --- | --- |
| Restart the app after resizing | Electron main window edge / system maximize control | Electron `BrowserWindow` | update settings after resize/maximize/unmaximize | app-global field in `~/.zcode/v2/setting.json` | packaged/dev Desktop main only; Web/mobile do not take part |

### Must-preserve invariants

- Restoring the size must not lengthen the Local Host, renderer or workspace recovery critical path; a settings
  read failure keeps using `1200x800`.
- Windows maximize chrome notifications are still owned by the existing maximize/unmaximize listeners; size
  persistence does not change the renderer protocol.
- The desktop continuous and mobile replayable links, workspace identity and task/session snapshots are
  unaffected.
- All file IO keeps going through the asynchronous settings service; no synchronous file API in the Electron
  resize callback.

## Accepted cases

| Case | Setup | Action | Assertion |
| --- | --- | --- | --- |
| WINDOW-SIZE-01 | no saved size | create the main window | uses `1200x800` |
| WINDOW-SIZE-02 | valid saved normal size | restart and create the main window | constructor arguments restore the saved width and height |
| WINDOW-SIZE-03 | saved size exceeds the current primary work area | restart and create the main window | width/height clamped to the work area, not below the window minimum |
| WINDOW-SIZE-04 | quit maximized after a normal size | restart and create the main window | created at the normal size, then maximize is called |
| WINDOW-SIZE-05 | resize/maximize/unmaximize | wait for the persistence callback | saves the non-maximized width/height and the independent maximized state |
| WINDOW-SIZE-06 | main window created | trigger window close or app-quit preparation | no new window-size settings write starts |
