# Windows Taskbar Unread Badge (taskbar overlay badge)

## Background

Desktop plays a sound when a task completes, but users who are listening to music or focused elsewhere can miss it. The app icon on the taskbar shows a numeric badge (like the macOS Dock badge) so "how many completed sessions are unread" is visible at a glance.

The application-level unread badge chain exists (renderer count -> IPC -> main-process aggregation -> `app.setBadgeCount`) and works on macOS and Linux. On Windows Electron's `app.setBadgeCount` is a no-op, so phase 1 deliberately left it a no-op (see the original comment and cases in `unreadBadge.ts`). This spec is the phase-2 Windows completion.

## Badge Semantics

- The badge number is the **number of tasks completed during this app run that the user has not opened yet**. Unread that already existed at startup does not light the badge, for the same reason the tray red dot was removed on 2026-10-30: the badge reports only "new things", and the user should not see an old badge that cannot be cleared after every boot (product decision 2026-11-05).
- The data is **from the same source** as the sidebar blue dot (the authoritative tree of host `projectService.readTree()`, counting only projects the sidebar actually renders and excluding orphans and soft-deleted ones: they have no blue-dot landing spot, and counting them would create a ghost reminder of "badge without blue dot"), but the count semantics **diverge** from the blue dot: blue dot = all unread, badge = unread added during this run. Having historical unread at startup is normal (blue dot lit, badge 0), not a bug.
- **Boundary mechanism** (`mergeBaselineForHosts` / `countUnreadTasksSinceBaseline`, project-sidebar/view.ts): the baseline is a **per-host** Map. When a host first appears in the success set returned by the read layer (`onlineHostIds`, passed explicitly by `readProjectSidebarTree` -> `mergeProjectTrees`, including hosts that return an empty tree), that host's "unread task key -> unreadAt" is snapshotted into process memory (module-level, tied to the renderer process lifetime, not persisted and not written back; an app restart clears it; remounting the Provider does not reset it). From then on the count = unread tasks in the authoritative tree whose key is not in that host's baseline or whose unreadAt differs from the baseline value; completing the same task again refreshes unreadAt and lights it again. The boundary uses task identity (the de-dup key), not time comparison: a remote workspace's `unreadAt` is written by the remote clock, and comparing it with the local "start time" would break on clock skew; the identity comparison is same-source throughout (two reads of the same tree) with no external variable.
- **The success signal must be passed explicitly by the read layer, not inferred from the tree**: when a remote read fails `mergeProjectTrees` still synthesizes projects from cached rows (for sidebar display), so "the project is in the tree" does not prove the read succeeded; inferring success from "tasks entered the tree" is also incomplete: an empty-tree host (read succeeded, no tasks yet) has no tasks, so when its first new unread appears during the run it is first skipped because the host has no baseline, then absorbed by the first baseline, swallowing the new item and keeping the badge at 0. So `onlineHostIds` is produced explicitly at the read boundary: local is always successful, remote follows `readTree` fulfilled (an empty tree counts), then narrowed by entry membership. The baseline snapshot walks all tasks, not the display selector, which excludes archived tasks; restoring an archived task changes only `archived` and not `unreadAt`, so an archived unread task that is not in the baseline would be misjudged as newly completed at the moment of restore and light the badge.
- **Why per host and not one global snapshot**: the directory tree fills in host by host: a remote Source Server connects after the first read completes (offline, its cached project rows enter the tree without a successful read), the whole first read fails (the tree is still EMPTY), a remote failure falls back to the local tree only. A one-time global snapshot is incomplete in these cases, and a late host's historical unread would be misjudged as "new this run" and light the badge, which reproduces exactly the "old badge that cannot be cleared on boot" this semantics removes. With per-host baselines, in the frame where a late host's read first succeeds its historical unread is not counted (the host has no baseline) and is absorbed when the baseline is built; a host that goes offline and back online does not misreport either, while a task that really completes remotely in the meantime (unreadAt changed / new key) still lights it.
- Opening a task decrements the number; at zero the badge disappears. It is not a historical completion total.
- Constraint from an earlier failure: counting from the renderer session store `workspace.taskListCache` only covers the active workspace's list, so background workspaces showed a blue dot but a zero badge. That path is removed (`lib/unreadTaskCount.ts` deleted). The sync point is `ProjectSidebar`, because the authoritative tree lives in the `ProjectDirectoryProvider` context and Root cannot reach it.

## Cross-platform Chain

```
[Host] projectService.readTree() -> ProjectTree.tasks[].unreadAt (tasks-index SQLite, authoritative)
    |  ProjectDirectoryProvider (resident owner, authoritative tree in this context)
    |  host first enters the tree: mergeBaselineForHostsInTree(tree)  <- per-host baseline (process memory)
    |  countUnreadTasksSinceBaseline(tree, baseline)        project-sidebar/view.ts
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
- **Clear**: when `count = 0` the taskbar receives a `null` image and the badge is removed. The baseline dies with the process: after an app restart old unread no longer lights the badge (see "Badge Semantics").
- **性能**：角标只在"任务完成 / 用户查看任务"时变化，更新频率为事件级；徽章图按 label 缓存在内存，单次更新是一次查表 + 一次 Shell 调用。
- **无障碍**：overlay `description` 传静态英文描述（主进程无 i18n 管线，v1 不做本地化）。

## Platform Matrix

| Platform               | Mechanism                                 | Status                                                        |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| macOS                  | `app.setBadgeCount` (Dock red number)     | Live; count follows the new semantics (unread added this run) |
| Linux (Unity/KDE etc.) | `app.setBadgeCount` (LauncherEntry D-Bus) | Live; count follows the new semantics (unread added this run) |
| Linux (native GNOME)   | No system badge API                       | No badge                                                      |
| Windows                | `BrowserWindow.setOverlayIcon`            | Added by this doc; count follows the new semantics            |

## Tests and Verification

- Unit tests: App business unit tests are retired (see docs/testing/unit-test-quality.md), so this chain has no engineering unit test; the historical cases for main-process pure functions (label parsing, win32 branch clearing with null) were removed with them, and behavior is covered by manual acceptance.
- Manual acceptance (Windows): complete a task -> a badge with the count appears at the bottom-right of the taskbar icon, and the tray icon never carries a red dot; open the task -> decrements; all read -> disappears; multiple windows show the same total. Baseline semantics: start with historical unread -> badge 0 (blue dot may be lit); a new task completes this run -> lights; a task in the baseline completes again (unreadAt refreshed) -> lights again; restart the app -> badge back to 0. Host catch-up: a remote workspace with historical unread comes online late after startup -> badge still 0 (blue dot may be lit); simulate the first read failing and then recovering -> badge still 0; a remote task completes during this run -> badge +1.
- E2E：任务栏 overlay 为 OS Shell 渲染，WebDriverIO 无法断言，以单测 + 手工验收覆盖（验收记录见 MR 描述）。

## Boundaries and Known Limitations

- The overlay stays visible when a window is minimized to the taskbar (the target scenario). If "close to tray" is supported later, the overlay is not visible while hidden and needs a separate indication on the tray icon.
- Mobile web remote has no taskbar concept and does not apply. The desktop badge count includes unread tasks of remote workspaces (same renderer store).
