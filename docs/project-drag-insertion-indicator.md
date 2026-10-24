# Project drag insertion indicator

## Behavior

- Dragging a sidebar project over another sortable project shows a 2px blue line at the target edge with an 8px hollow circle at its left end, using the `icon-blue` theme token; it stretches with the sidebar width.
- Sorting up shows the line before the target project, sorting down after it; the position follows the existing reorder animation. An expanded project shows the line at the whole project-node boundary — it can never drop into a task row.
- The hint appears only for valid project reordering inside the same pinned section (cross-Host allowed); the original position, non-sortable projects, and native task drops show nothing. Pointer and keyboard share the hint; release or Escape clears it immediately.
- The indicator takes no layout space, intercepts no pointers, and is hidden from assistive technology; project collapse, menus, file entries, and the original reorder animation are preserved.

## Ownership and boundaries

The display derives directly from the existing `useSortable` active / over / index — no new React state, timers, or persisted fields. The controlling-side sidebar preference is the single owner of display order; commit reuses preferences.reorder, saved as (hostId, projectId); local and offline-remote projects may interleave; no remote `position` is written.

```text
指针 / 键盘 → dnd-kit active + over → 目标边缘蓝线
                                  → 松手 → preferences.reorder → 控制端 → readTree
                                  → Escape → 清除暂态
```

Desktop and mobile share ProjectNode; shared-host, workspaceIdentity, desktop continuous, and mobile replayable boundaries, the protocol, and migrations are untouched. Acceptance uses both themes and narrow layouts; a 390px desktop simulation is not real mobile remote verification.

## Acceptance

VP31 pending E2E extension: no indicator before dragging; downward pointer drag and upward keyboard drag each show exactly one correct target and direction; check line width, theme color, hollow circle, and layout boundaries; clearing after cancel and commit; order survives refresh. Screenshots cover both themes and 390px.

Verification outcome (2026-09-15): Electron E2E 6/6 then 7/7 passed with 1200px/390px light/dark screenshots; CDP confirmed the insertion line and Escape clearing in the dev app. The case stays pending — real mobile shared-host, SSH/WSL, and Windows/Linux GUI runs were not executed. This work changes UI presentation only, not host communication or persistence.

## Drag rendering budget (2026-09-15)

A user trace with 41 projects rendering 4 rounds at startup (656 ControlHintTooltip renders, longest main-thread task 1410ms) showed that `useSortable` context updates were flowing into full project content.

- The ProjectNode sortable shell exclusively owns the useSortable subscription, node ref, transform, and insertion line; the title/action menu/task content are separate memo boundaries that do not subscribe to the drag context. Only the stable activator ref, listeners, and attributes are passed to the title. An activation-state change refreshes at most the active project's content; target and bystander content stays reused.
- Keep normal shallow prop comparison: project, task, availability, collapse, and callback changes must update promptly. No comparators that ignore functions, no second copy of project data, no masking jank with delays or disabled debug logging.
- Sort data changes only with hostId/pinned. Keep the same-pinned-section rule, allowing cross-Host, keyboard ARIA, native task drops, and whole-block movement of expanded projects.

```text
Pointer/Keyboard → DndContext → ProjectNode 外壳（transform / 插入线）
项目投影 / 操作回调 ──────────→ memo 项目内容（标题 / 菜单 / 任务）
松手 → preferences.reorder → 控制端侧栏偏好；Escape → 清除暂态
```

Acceptance: unit tests simulate 41 nodes with activation, movement, target change, and cancel — bystanders do not re-render tooltips/task content, and the active item's ARIA and latest callbacks stay correct. VP31 adds, in an isolated HOME, at least 41 real pointer drags, the blue line, cancel, and frame-interval/longtask sampling: release-build max drag frame interval must stay under 100ms. Performance numbers vary by environment — keep raw metrics and compare against same-condition dev-app recordings. Existing keyboard reorder persistence, both themes, 390px, and menu regressions keep running. The shared UI applies to desktop/Web; mobile replayable, Host/CLI, protocol, and migrations do not change.

Verification outcome: with the same 41-item gesture sampled via PerformanceObserver + rAF, max frame interval dropped from 366.6ms (longtask 387ms, 1152 tooltip renders) to 67.6/34.1ms (longtask 77/59ms, 8 renders); the release-build run reached 17.6ms max frame interval with no longtasks (42 items, raw metrics in that run's `project-drag-performance.json`). Red-first unit tests: one activation triggered 164 tooltip renders before, at most 4 after (0 on move/target change). The stale-Server unit-test title ARIA keeps `aria-disabled={!canOpen}` from the primary-root availability fix; sort disabling stays with `useSortable.disabled`. Checks passed: root typecheck, desktop typecheck:e2e, lint (48 pre-existing warnings, 0 errors), fixture check, format, and incremental architecture check. Cases stay pending; real mobile shared-host, SSH/WSL, and Windows/Linux GUI were not run.

Full history: git show 3da132e86ee5ba3b6a079f99fa3987f038457c29:docs/project-drag-insertion-indicator.md
