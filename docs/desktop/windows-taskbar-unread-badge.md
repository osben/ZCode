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
    │
    ├─ darwin / linux → app.setBadgeCount(total)            （既有行为）
    └─ win32         → 对每个 BrowserWindow 调 setOverlayIcon（本文新增）
```

Counting and sync are shared on all platforms. Only the main-process last mile forks per platform.

## Windows Implementation

Electron supports the taskbar badge on Windows through `BrowserWindow.setOverlayIcon(image, description)` (Shell `ITaskbarList3::SetOverlayIcon`). Unlike `setBadgeCount`, **the overlay does not render the number**; the badge image must be drawn by the app.

- **位置**：overlay 由系统固定绘制在任务栏按钮右下角（与 Windows 更新盾牌、Outlook 同步状态同一机制），API 无位置参数，无法绘制右上角效果。
- **观感**：任务栏 overlay 按 Windows 固定显示尺寸提供原生 1x（16×16）与 2x（32×32）`NativeImage` representation，不再把普通 32px 硬边圆交给 Shell 盲缩。红点为纯红、无描边、4× 超采样抗锯齿，逻辑直径约 7px。同一个安装包运行时按系统 build 自动选画布圆心：Win10（build < 22000）在画布内右下锚定，补偿旧任务栏的 overlay 落点；Win11（build ≥ 22000）在画布内居中，避免 Shell 已放到图标角上后再次右下锚定造成二次偏移。无障碍 description 仍携带具体数量（如 "3 unread tasks"）。
- **托盘不挂角标**：Windows/Linux 托盘（`Tray`，屏幕右下角通知区域）保持原始图标，不合成未读红点。2026-10-30 起移除：托盘红点在用户眼里像"常驻不消"，与通知区域"有红点 = 有新消息"的惯例冲突；未读提醒由任务栏 overlay 与应用内任务列表蓝点承担。
- **多窗口**：所有窗口统一显示全局未读总数（与 macOS Dock 显示应用级总数一致，符合"完成了几个会话就显示几"的直觉）。无任务栏按钮的窗口（CUA 指示器、更新状态窗等 skipTaskbar 窗口）设置 overlay 无副作用，不单独排除。
- **清零**：`count = 0` 时任务栏传 `null` image 移除角标。
- **性能**：角标只在"任务完成 / 用户查看任务"时变化，更新频率为事件级；徽章图按 label 缓存在内存，单次更新是一次查表 + 一次 Shell 调用。
- **无障碍**：overlay `description` 传静态英文描述（主进程无 i18n 管线，v1 不做本地化）。

## Platform Matrix

| 平台                  | 机制                                       | 状态         |
| --------------------- | ------------------------------------------ | ------------ |
| macOS                 | `app.setBadgeCount`（Dock 红色数字）       | 已上线，不变 |
| Linux（Unity/KDE 等） | `app.setBadgeCount`（LauncherEntry D-Bus） | 已上线，不变 |
| Linux（原生 GNOME）   | 系统无 badge API                           | 无角标       |
| Windows               | `BrowserWindow.setOverlayIcon`             | 本文新增     |

## Tests and Verification

- 单测：label 解析（0/1~9/10+）、像素渲染尺寸/边距与关键像素颜色（含红点模式无数字）、win32 分支对 `setOverlayIcon` 的调用（含清零传 null、多窗口、跳过已销毁窗口）、darwin/linux 分支仍走 `setBadgeCount`。
- 手工验收（Windows）：完成任务 → 任务栏图标右下角出现角标并计数，托盘图标始终不挂红点；打开任务 → 递减；全部读完 → 消失；多窗口显示同一总数。
- E2E：任务栏 overlay 为 OS Shell 渲染，WebDriverIO 无法断言，以单测 + 手工验收覆盖（验收记录见 MR 描述）。

## Boundaries and Known Limitations

- The overlay stays visible when a window is minimized to the taskbar (the target scenario). If "close to tray" is supported later, the overlay is not visible while hidden and needs a separate indication on the tray icon.
- Mobile web remote has no taskbar concept and does not apply. The desktop badge count includes unread tasks of remote workspaces (same renderer store).
