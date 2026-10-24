# Windows Titlebar Menu

## Goal

Enable a custom-drawn top menu on Windows desktop that puts the common `File / View / Help` actions into
the workspace top bar while keeping the system window control buttons.

## Implementation

- The Windows main window uses `titleBarStyle: "hidden" + titleBarOverlay` and keeps
  `backgroundMaterial: "acrylic"`.
- The main process has one `executeDesktopCommand` entry; the native application menu and the renderer top
  menu share the same action implementations.
- `WorkspaceHeader` conditionally renders `WindowsCaptionMenuButton` on Windows/Linux desktop and calls the
  main-process command through `IPlatformService.executeDesktopCommand()`.
- The new-task draft state does not render the full `WorkspaceHeader`, but Windows/Linux desktop still
  keeps the top-right Terminal toggle and merged menu button. The UI renders the shared Terminal entry and
  `WindowsCaptionMenuButton` in the shell's outer title-bar area, restoring only the window-level entries,
  not workspace path, branch or task header content. The Windows draft merged menu button keeps the same
  size, square corners and hover style as the session task header entry but drops the left border, and its
  outer wrapper draws no `bg-background-win-alt` or `border-b border-border`, avoiding an isolated color
  block in the transparent title area.
- The Linux draft merged menu wrapper keeps the Linux title-bar surface style with `rounded-bl-xl` at the
  lower left, forming one layer with the custom-drawn window button area on the right.
- In the desktop draft state a lightweight `<header class="h-10 [app-region:drag]">` is rendered at the
  same layout position as the title-bar drag region. It takes part in the vertical main layout (no
  absolute overlay over ChatView) while staying below the click layer of the top-right window menu.
- The check-update item subscribes to `IPlatformService.onUpdateStateChanged()` and pulls the current
  state with `IPlatformService.getUpdateState()` when the menu opens. The main process's `electron-updater`
  state is synced continuously to the renderer through `PlatformChannels.UpdateStateChanged`, so the
  Windows custom menu shows checking, download progress and ready-to-restart like the macOS native menu.

## Current Menu Items

Merged menu: New task, Open Workspace, Open in File Explorer, About ZCode, Check for Updates (shows state
and percentage while checking/downloading), Feedback, Community (when an entry is available), Export Logs,
Toggle Developer Tools (dev), Resource Manager (dev), Close Window.

## Windows Workspace Outer Edge

### Product Semantics

The system window shape is decided by Windows/DWM; the renderer owns only the workspace content panel. They
must not be merged by `isWindowsDesktop` alone, or Windows 10 vs 11 and normal vs maximized windows would
contaminate each other.

| System and window state                  | System window shape          | Workspace content panel                                                                                                             |
| ---------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Windows 11 normal window                 | DWM native rounded corners   | Keep rounded corners and the full weak border                                                                                       |
| Windows 11 maximized                     | DWM outer edge is square     | Panel switches to square corners; remove the top, right and bottom borders against the window edge, keep only the left separator    |
| Windows 10 normal/maximized              | System native square corners | Only the two right corners against the system edge become square; keep the existing full weak border and inner left rounded corners |
| Windows capability unknown / IPC failure | Not yet confirmed            | Keep the pre-change rounded corners and full weak border; do not misjudge unknown as Windows 10                                     |
| macOS, Linux, Web, mobile Web            | Not part of this feature     | Keep existing styles and responsive overrides                                                                                       |

Windows build `>= 22000` is the Windows 11 native-rounded-corner boundary. Build and maximized state are
read by the Electron main process and injected into the UI through preload and `IPlatformService`; the UI
never reads Node or `window.zcode`. When Windows 11 is maximized, the renderer content panel and the DWM
outline both use square corners. This feature does not change the system window shape through fake
maximize, window shape or work-area bounds changes.

### State Chain

```text
Windows build ───────────────┐
                             v
BrowserWindow maximize/unmaximize -> main computes window appearance state
                                      |
                                      v
                         preload IPC query + state event
                                      |
                                      v
                           IPlatformService (desktop)
                                      |
                                      v
                           useAppChromeState (UI)
                                      |
                                      v
                     WorkspaceShellLayout style matrix

Web / mobile Web -> IPlatformService fallback -> does not enter the Windows style branch
```

### Impact and Invariants

- Direct impact: desktop main window state, desktop preload, shared platform interface, workspace shell
  outer-edge styles.
- Must check: the four Windows 10/11 x normal/maximized combinations and the initialization path when the
  window first loads maximized.
- No impact: title-bar button commands, Agent/session, desktop continuous message flow, mobile remote
  replayable recovery chain.
- No new persistence: the maximized state is held live by `BrowserWindow`; the renderer queries once and
  subscribes to changes.
- Windows Snap layouts and system fullscreen are not `BrowserWindow.isMaximized()`; they keep the normal
  window style and no DWM outline change is claimed.

### Acceptance

1. Windows 11 normal window still shows native rounded corners; the panel keeps its rounded corners and
   weak border.
2. Windows 11 maximized: all four panel corners are square and no extra top, right or bottom stroke
   appears on the window edge.
3. Switching Windows 11 between maximized and restored updates the style immediately without refresh.
4. Windows 10 normal and maximized both avoid simulating right outer rounded corners while keeping the
   original top, right and bottom weak borders.
5. A failed capability query or unavailable bridge keeps the pre-change style, with no flash to Windows 10
   style.
6. Existing layout and responsive styles of macOS, Linux, Web and mobile Web are unchanged.
