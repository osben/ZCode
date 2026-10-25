# Project sidebar: deferred rows in off-screen projects

ISSUE-064 · Linear ZCO-53

## Problem

Switching the sidebar to "By project" mounts every expanded project's header and its first page of rows in one commit (15 expanded projects ≈ 15 headers + ~95 rows), most below the fold. Each row is a full `TaskList` + `TaskListItem` with its own context menu, hover card and tooltips. The tree derivation (`selectProjectRows`, `projectHasUnread`) costs under 0.5 ms at 1,874 tasks and is not the cause. On the dev build the switch blocked 275–300 ms against a 200 ms budget (SB-02); the deferral cut React mount work ~40% (jsdom harness, 15 expanded projects of 8 tasks each: 700 px scroller 50→30 ms / 75→25 rows; 900 px 50→30 ms / 75→30 rows). The remainder is mostly the project headers.

## Rule

In the "By project" view, an expanded project mounts its task rows only once one of the following holds. After that the rows stay mounted for the lifetime of the project node.

1. **Near the viewport.** The rows' slot is within half a scroll-viewport height above or below the visible area of the sidebar scroll container (the element marked `data-project-rows-viewport`). This is checked synchronously, before paint, when the node mounts, including on the sidebar's first mount. Later scrolling is watched with an `IntersectionObserver` rooted at that container, with `rootMargin: 50% 0px`.
2. **Active task.** The project's rows include the task that is active in the current window workspace, or the task the mobile remote view has active. This rule keeps the selected row in the DOM, so anything that scrolls to or queries the active task finds it.
3. **Keyboard focus.** Focus enters the project's header row, or any of its buttons. Tab from the header then reaches the first task row, as before.
4. **User expand.** The project was collapsed when the node mounted and is then expanded. A user expand never shows a placeholder.
5. **No viewport available.** No ancestor carries `data-project-rows-viewport`, or the environment has no `IntersectionObserver`.

Until then, the rows' slot inside `CollapsibleContent` is an `aria-hidden` placeholder. It has `data-project-rows-placeholder` and an estimated height: min(row count, page size 5) × 32 px, plus 20 px for "show more".

## What does not change

- **Order.** Still from `compareProjectTaskRows`. The page size (5) and "show more" are unchanged.
- **Mounted rows.** They render exactly as before: same `data-testid`s, same task keys, same memoization.
- **Expansion state.** It stays with the preferences owner. `CollapsibleContent` stays mounted and keeps its 300 ms height/fade animation. Deferral only decides the content of the rows' slot.
- **Unread dot on collapsed projects.** Still derived from the authoritative tree (`projectHasUnread`), not from mounted rows.
- **Other views and sections.** The pinned section, local unfiled tasks, the timeline view and the grouped view are not deferred.
- **Empty projects.** They render the empty state directly.

## State owner and event order

```text
ProjectNodeContent (per Host + project id, lives while the node is mounted)
  rowsRevealed: boolean  — initial = !isOpen; only ever false → true

mount (isOpen) ─ layout effect: measure slot vs scroll root ─┬─ within ½ viewport → reveal (before paint)
                                                            └─ else observe slot (IO, root = sidebar scroller)
IO isIntersecting ────────────────────────────────────────────── reveal
focus enters header row ─────────────────────────────────────── reveal
render: isOpen became true since last render ────────────────── reveal
render: rows contain active task ────────────────────────────── reveal
reveal → disconnect IO; rows mount; never reverts
```

The scroll root is the sidebar's existing `ScrollFadeViewport`, marked with `data-project-rows-viewport`. The placeholder resolves it with `closest()` in its layout effect; the DOM is already inserted at that point, whereas an ancestor's ref is not yet attached when the sidebar and its projects mount in the same commit. The root's height is bounded (`min-h-0 flex-1 overflow-y-auto`), so the reach is measured against the visible area, not the full list.

## QA / E2E impact

The DOM no longer holds rows of an expanded project more than half a viewport beyond the visible area. A selector that queries such a row must first scroll the project's `<section data-project-id>` into view. The active task's project, and every project within reach, keep their rows.

## Known limit

Shift+Tab moves backward into a project above the visible area. If that project's rows are still deferred, focus lands on its header buttons and skips its rows. This only happens after a scroll jump (for example dragging the scrollbar), because any project scrolled through normally has already mounted its rows.

## Acceptance

- With 15 expanded projects, only the projects within reach mount `MemoTaskItem`s.
- After the observer reports a project as intersecting, that project's rows mount in comparator order. Scrolling the project away again does not unmount them.
- Focusing a deferred project's header mounts its rows.
- A deferred project that contains the active task mounts its rows.
- Collapsing and re-expanding keeps rows mounted.
- A project that starts collapsed and is then expanded mounts its rows immediately.
- A collapsed project with an unread task shows the unread dot, whether or not its rows were ever mounted.

## Verification

- Unit tests: `packages/ui/test/projectDeferredRows.test.ts` uses a fake `IntersectionObserver` with positioned rects and counts mounted rows.
- Desktop E2E: `packages/desktop/test/e2e/ui-shell/project-sidebar-deferred-rows.test.ts` — SBD01 placeholder far down; SBD02 Tab from a deferred header reaches its first row; SBD03 scrolling mounts the rows and they stay mounted; SBD04 the active task's row stays mounted off-screen and scrolls into view. Setup: it creates 12 projects through the UI, then writes legacy-shaped task rows while the app is stopped and restarts; the Host's legacy reconcile assigns those rows to the projects.
