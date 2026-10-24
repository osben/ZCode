# Windows Taskbar Unread Badge (taskbar overlay badge)

## Background

Desktop plays a sound when a task completes, but users who are listening to music or focused elsewhere can miss it. The app icon on the taskbar shows a numeric badge (like the macOS Dock badge) so "how many completed sessions are unread" is visible at a glance.

The application-level unread badge chain exists (renderer count -> IPC -> main-process aggregation -> `app.setBadgeCount`) and works on macOS and Linux. On Windows Electron's `app.setBadgeCount` is a no-op, so phase 1 deliberately left it a no-op (see the original comment and cases in `unreadBadge.ts`). This spec is the phase-2 Windows completion.

## Badge Semantics

- The badge number is the **number of completed tasks the user has not opened yet** ("unread tasks"). It uses the **same authoritative data** as the sidebar blue dot: the ProjectTree returned by host `projectService.readTree()` (`unread_at` in the tasks-index SQLite). Only **projects the sidebar actually renders** are counted: tasks of soft-deleted projects and orphan tasks (projectId with no project) are excluded, because they have no blue dot and would produce a phantom "badge without dot". Filtering and de-duplication are in `countProjectTreeUnreadTasks` (`project-sidebar/view.ts`).
- Opening a task decrements the number; at zero the badge disappears. It is not a historical completion total.
- Constraint from an earlier failure: counting from the renderer session store `workspace.taskListCache` only covers the active workspace's list, so background workspaces showed a blue dot but a zero badge. That path is removed (`lib/unreadTaskCount.ts` deleted). The sync point is `ProjectSidebar`, because the authoritative tree lives in the `ProjectDirectoryProvider` context and Root cannot reach it.

## Cross-platform Chain

```
[Host] projectService.readTree() -> ProjectTree.tasks[].unreadAt (tasks-index SQLite, authoritative)
    |  ProjectSidebar (authoritative tree in ProjectDirectoryProvider context)
    |  countProjectTreeUnreadTasks(tree)                   project-sidebar/view.ts
    v
usePlatform().syncWindowUnreadCount(count)                 IPC: zcode:sync-window-unread-count
    |  (no-op on web; fires only when the tree refreshes; no message if the count is unchanged)
    v
[Main] desktopMainIpcPlatform.ts -> handleWindowUnreadCountSync
    |  windowUnreadCountMap (per-window count; cleaned up when a window closes)
    v
syncApplicationUnreadBadge(map)                     desktopWindowLifecycle.ts
    |
    +- darwin / linux -> app.setBadgeCount(total)            (existing behavior)
    +- win32          -> setOverlayIcon on every BrowserWindow + tray red dot
```

Counting and sync are shared on all platforms. Only the main-process last mile forks per platform.

## Windows Implementation

Electron supports the taskbar badge on Windows through `BrowserWindow.setOverlayIcon(image, description)` (Shell `ITaskbarList3::SetOverlayIcon`). Unlike `setBadgeCount`, **the overlay does not render the number**; the badge image must be drawn by the app.

- **Position**: the system draws the overlay at the bottom-right of the taskbar button (same mechanism as the Windows update shield and Outlook sync state). The API has no position parameter, so a top-right effect is impossible. Top-right is only possible on the tray badge, which the app draws itself.
- **Appearance**: the taskbar overlay provides native 1x (16x16) and 2x (32x32) `NativeImage` representations at the fixed Windows display size, instead of handing the Shell a 32px hard-edged circle to scale blindly. The red dot is pure red, no outline, 4x supersampled anti-aliasing, logical diameter about 7px. One installer picks the canvas center by OS build at runtime: Win10 (build < 22000) anchors bottom-right inside the canvas to compensate for the older taskbar overlay placement; Win11 (build >= 22000) centers inside the canvas, so the Shell's own corner placement is not offset twice. The accessibility description still carries the count (for example "3 unread tasks").
- **Tray badge**: the Windows/Linux tray (`Tray`) composes a pure red dot (no number) into the top-right rounded gap of the app icon. Its size is independent of the taskbar, about 8px; it also provides native 1x (16px) and 2x (32px) representations with 4x supersampled anti-aliasing, avoiding the blur of a hard-edged 32px composite scaled by the Shell. On count change `tray.setImage` swaps the image; at zero the original multi-resolution icon is restored. macOS has no tray (the platform returns null); the Dock badge covers it.
- **Multi-window**: all windows show the global unread total (consistent with the macOS Dock showing the app-level total; "N sessions completed, N shown"). Windows without a taskbar button (CUA indicator, update status window and other skipTaskbar windows) get the overlay with no side effect and are not excluded.
- **Clearing**: at `count = 0` the taskbar gets a `null` image to remove the badge, and the tray restores the original icon.
- **Performance**: the badge changes only on "task completed / user views task", so updates are event-level. Badge images are cached in memory by label; one update is one lookup plus one Shell call / one tray image swap.
- **Accessibility**: the overlay `description` is a static English string (the main process has no i18n pipeline; no localization in v1).

## Platform Matrix

| Platform                 | Mechanism                                                | Status                            |
| ------------------------ | -------------------------------------------------------- | --------------------------------- |
| macOS                    | `app.setBadgeCount` (Dock red number)                    | Shipped, unchanged                |
| Linux (Unity/KDE, etc.)  | `app.setBadgeCount` (LauncherEntry D-Bus) + tray badge   | Shipped; tray badge added by this spec |
| Linux (native GNOME)     | No system badge API                                      | Tray badge fallback (added by this spec) |
| Windows                  | `BrowserWindow.setOverlayIcon` + tray badge              | Added by this spec                |

## Tests and Verification

- Unit: label resolution (0 / 1-9 / 10+); pixel rendering size/margins and key pixel colors (red-dot mode has no digit); premultiplied alpha blending; tray image swap (red dot composition, restore at zero, no-op without tray); the win32 branch calls `setOverlayIcon` (null at zero, multi-window, destroyed windows skipped); darwin/linux branches still use `setBadgeCount`.
- Manual acceptance (Windows): complete a task -> a counted badge appears at the bottom-right of the taskbar icon and a small badge at the top-right of the tray icon; open a task -> both decrement; read all -> badge disappears and the icon is restored; multiple windows show the same total.
- E2E: the taskbar overlay and tray image are rendered by the OS Shell and cannot be asserted by WebDriverIO; covered by unit tests plus manual acceptance (acceptance record in the MR description).

## Boundaries and Known Limitations

- The overlay stays visible when a window is minimized to the taskbar (the target scenario). If "close to tray" is supported later, the overlay is not visible while hidden and needs a separate indication on the tray icon.
- Mobile web remote has no taskbar concept and does not apply. The desktop badge count includes unread tasks of remote workspaces (same renderer store).
