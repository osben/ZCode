# UI Render Stability Optimization

## Background

DevTools traces of the big session branch (2026-06-27 to 2026-06-28, rounds `p6`-`p13`) showed that most
of the selected main-thread time was DevTools/Inspector overhead (`CpuProfiler::StartProfiling`,
`V8Console::runTask`, `v8::Debugger::*`). The project-attributed self time was much smaller, but the
React Components track showed repeated workspace-level render bursts: `DesktopWindowFrame` re-rendering
large parts of the workspace shell, workspace task rows re-rendering with semantically unchanged data
(each row carrying menu/tooltip structures that multiply Radix `ContextMenu` / `Popper` / `Tooltip`
work), and the chat composer and toolbar recreating equivalent objects and callbacks during stream
updates. After discounting DevTools overhead, the remaining delay was main-thread React work during
streaming (layout and paint were not dominant until the DOM-size issues in rule 7).

## Goals

- Keep desktop continuous and web remote replayable behavior unchanged.
- Reduce render propagation by stabilizing props at the TaskList, shell and composer boundaries.
- Avoid mounting heavy per-row menu content until the user opens a row context menu.
- Preserve the current visual design, theme behavior, i18n strings and keyboard/pointer interactions.

## Rules in force

1. **Task row actions.** Keep `TaskList` callbacks stable across list-local state changes by reading
   mutable values through refs where the action only needs the latest value at invocation time.
   `WorkspaceSidebarItem` passes task actions to the memoized `TaskList` through stable callback
   references; task-ID adapters use `useCallback` and preserve the existing action semantics. Task row
   props stay stable while task identity, active state, pinned state, mobile active state and visible
   metadata are unchanged; task row display fields are compared semantically so an equivalent task meta
   object replacement does not re-render unchanged rows.
2. **Task row menu cost.** The row itself stays mounted as the context-menu trigger.
   `TaskListItemContextMenu` and its file/provider-path loading are limited to the opened context menu;
   the task row context-menu content and the Radix context-menu ownership live in list-level singletons
   so idle rows do not each carry a menu root/trigger/content tree. Hover-only archive tooltip/action
   controls are deferred until the row is hovered or already in archive-confirming state. Task rename
   dialogs mount only while a rename is active.
3. **Workspace shell props.** Memoize shell `resetKeys`, render callbacks and small object props passed
   into memoized/error-boundary children, without changing boundary scopes or reset semantics. Add memo
   boundaries to workspace shell chrome and shared overlay/dialog components that do not need to
   re-render for every chat token batch (`WorkspaceSidebarFooter`, `WorkspaceSidebar`,
   `CommandCenterDialog`, `WebRemoteControlDialog`, feedback dialogs).
4. **Composer and toolbar props.** Memoize equivalent action objects, submit controls and toolbar
   callbacks that React DevTools reported as referentially unstable, keeping all command behavior and
   remote/mobile behavior unchanged. Specifically: memoize `ChatBottomDock` prop objects and JSX
   controls in `ChatView` and make `ChatBottomDock` a memo boundary; memoize toolbar usage callbacks and
   `codingPlanUsageRemaining` in `ChatInputToolbar`; memoize portal/control subtrees inside
   `ToolbarControls` and wrap it with `memo`; memoize `ModelConfigSelect` so unchanged model picker
   props do not re-render when context usage changes; render model selector menu content only while the
   dropdown is open.
5. **Stable event callbacks.** A tiny stable event callback hook serves UI callbacks that need the
   latest values only when invoked; it is used for toolbar model/config callbacks and conversation
   rewind callbacks. Filtered Coding Plan usage entitlement arrays are stabilized by semantic keys
   before crossing the toolbar memo boundary. (The old message-level rewind callback entry has since
   been removed; current conversation render work is checked against the remaining toolbar, summary and
   visible active-turn paths.)
6. **Conversation and summary.** Memoize the conversation render callbacks (`renderHistoryLoader`,
   `renderTurnGroup`) and wrap `ChatConversationContent` with `memo`, preserving streaming, history
   loading, search and remote-control behavior. Reuse goal verification summary arrays when their
   semantic signatures are unchanged; stabilize the summary panel variant callback in `ChatView`, wrap
   `ChatViewSummaryPanel` with `memo` and memoize small object/function props inside the panel.
7. **Markdown table and layout cost.** `MarkdownTable` keeps its scroll/resize observers mounted for the
   table lifetime instead of keying the observer effect to `children`; it stores the latest measurement
   callback in refs and skips `setMaskState` when the resolved mask state is unchanged. Replace
   `transition-all` on the Git action row with color-only transitions (so hover/state changes do not
   animate scrollbar/layout-related properties); remove `max-height` from summary panel shell
   transitions (the panel may snap between compact and expanded heights while border/background/shadow
   transitions stay). Add explicit `contain: layout style` boundaries around chat content and turn
   content. Do not use `content-visibility:auto`, `contain:paint` or `contain:size` on turn shells, so
   scroll height, message sizing and visible table overflow semantics are unchanged (wide markdown
   tables may overflow the normal message text width and must remain visible). Full virtualization of
   turns is avoided because native find, scroll restoration, fork/rewind anchors and web remote
   replayable snapshots depend on the existing DOM semantics.
8. **Heavy side-pane code viewer.** A runtime CDP inspection (resize gesture) found the large DOM in the
   code-viewer tab of the right side pane (`@pierre/diffs` `diffs-container` shadow root with 1634 direct
   children in each of `data-gutter` and `data-content`, about 8.3k descendants) participating in
   style/layout while only a narrow sliver was visible. Since 2026-07-28 ordinary text preview renders a
   file up to `256KB` once as a complete document and larger files show a bounded-preview message
   instead of separate transport chunks (earlier `FILE_VIEWER_CHUNK_BYTES = 128 * 1024` chunks); the
   heavy-content visibility gate stays necessary because an allowed complete document can still contain
   many rows. Keep the side-pane shell, tabs, source state and file read state mounted so animations and
   tab memory stay stable. Gate only the heavy PreviewPane body: a code-viewer tab may render
   `PreviewPaneContent` only when its tab is active, the side pane is logically visible and the side
   pane has enough viewport-intersecting inline width. Preserve scroll metrics with a lightweight spacer
   while the heavy body is deferred and restore `scrollTop` when the pane becomes visible again. Skip
   auto-loading adjacent file chunks while the heavy body is deferred, since an empty body can look like
   an under-filled viewport and trigger unnecessary hidden reads. Changing chunk size or virtualizing
   `@pierre/diffs` would affect code navigation, comments, search and scroll anchoring, so it was not the
   first repair.

## Verification

- Targeted render-stability tests for TaskList row props and TaskListItem context-menu content mounting.
- Tests proving list rows do not mount per-row context menus, rename dialogs are closed-state unmounted,
  equivalent task meta references do not re-render a row, and model menu content is not built while
  closed.
- Run the affected tests first to confirm they fail before implementation, then targeted UI tests after.
- Run `pnpm typecheck` and `pnpm lint` before committing.

## Trace outcomes (summary)

- After the task-list/sidebar work (p9), task rows and workspace task sections stopped dominating the
  React Components track; after the toolbar/model-select stabilization (p10-p12), `TaskList*`,
  `WorkspaceSidebar*`, `ModelConfigSelectComponent` and `ToolbarControlsComponent` no longer dominated
  and `ChatBottomDockComponent` reduced to the expected inline-layout transitions; after the summary
  panel work (p13), `ChatViewSummaryPanel` dropped to the expected two variant/layout renders and the
  remaining delay moved from React execution to browser style/layout over a large DOM (about 13.8k
  elements, one `DIV` with 1634 children, three long layout tasks of roughly 90ms), addressed by rules
  7 and 8.
- The active streaming turn still re-renders chat message/tool-call components as real `parts` /
  `toolCalls` change; this is expected, but old turns and summary chrome must not be pulled into the same
  render burst.

## 2026-11-03 Project expand render isolation (SPT07)

Confirmed in a dev window: the expand callback was rebuilt with `preferences`, so a collapse update of one project propagated to all projects. The 300 ms height/opacity animation was still there, but synchronous rendering used most of the animation time, so the expand looked sudden.

- `useProjectSidebarPreferences` stays the single owner of view, order and expand preferences; single-project commands keep a stable reference and read the latest preferences through functional updates.
- A single-project toggle updates only the target project's content; full props comparison is kept, so real directory, task and callback changes still propagate.
- The shared Collapsible's 300 ms two-way animation is kept; the animation duration is not changed and the expand state commit is not delayed.
- Toggling different projects in sequence, expand/collapse all, and a single action after a storage event keep the other projects, views and order; a refresh restores persisted preferences. Expanding a project does not select a task or create a draft.

```text
click project -> stable setExpanded -> functional update in the single preferences owner
                                         |- save full preferences
                                         `- target row expanded changes -> existing height/opacity animation
                                            other rows' props unchanged -> skip content render
```

SPT07 reuses the real directory Provider, preferences hook and project component of `new-task-rendering`, covering 44 projects, desktop/mobile layouts and Zai Light/Zai Dark. It records React commits, animation events and per-frame height/opacity; render scope and animation behavior are the assertions, and timing is kept as evidence only. The browser and the macOS Electron standalone renderer do not stand for the full App, real mobile transport or a whole Windows/Linux machine.

Earlier verification (2026-11-03): with the same 44-project fixture, all four groups recorded a full 44-row update before the fix; after the fix Chromium and macOS Electron updated only the 1 target row in all four groups, the two-way 300 ms animation still had intermediate height/opacity frames, and reverse operations in a row and persistence after a storage update were normal. Browser whole file 16/16, Electron standalone renderer 4/4 and the full macOS App project interaction E2E 14/14 passed; the latter covers batch expand/collapse, restore after refresh, quick reverse toggles and neighboring project operations. Evidence is in coverage matrix SPT07. The old SPT06 "double spinner icon" assertion was aligned with the current sidebar spinner and the message-area pixel animation; the stale assertion also fails on the unchanged baseline. Windows/Linux native and real mobile devices are not verified.

The extra global conversation coverage audit did not pass; the unchanged staging baseline `681c5f2d5b` reports the same four items: the formal case lists of background and dynamic-workflow lack a request ledger ID, and two coverage-table totals say 121 where the actual count is 120. This pending regression does not change those formal cases or the global statistics.

### 2026-11-04 addendum: top area and session title

Confirmed at runtime: a single-project expand changes only the `preferences` of the directory Context, yet the top navigation, the list title and `WorkspaceHeaderTitleSection` all updated with it, although the session title's props had not changed.

- Directory and preferences are still held by the existing `DirectoryOwner`. The session title reuses the project selection projection that carries no expand preferences, only narrowing the subscription and creating no second directory cache; an embedded scene without a Provider still returns empty.
- The top navigation and list title isolate parent updates by their actual inputs. The navigation receives a stable new-task command and keeps omitting the project argument, preserving the current-project inheritance. View, navigation selection state, language and real callback changes must still update.
- Expanding/collapsing a project adds zero renders to the top navigation, the list title and the session title. Unmount/remount of the current project's tasks, title width measurement and the 300 ms animation keep their existing lifecycle.
- SPT07 adds the zero-update assertions above and verifies that session title rename, remote device directory changes and navigation actions still take effect. It covers desktop/mobile layouts and both themes; the actual project expand is also replayed in the full Dev App to separate fixture evidence from real-chain evidence.

```text
expand command -> DirectoryOwner.preferences -> project list and target row
project/device change -> project selection projection of the same owner -> session title
navigation input change -> top navigation; view change -> list title
```

This regression: browser SPT03/SPT07/RRI06 12/12, macOS Electron standalone renderer SPT07 4/4; the full Dev App did 8 toggles in both themes with zero extra renders in all three places. Positive cases for title rename, device directory change and navigation selection are kept. The old SPT06 loading pixel assertion in the same file also fails on the original HEAD and is not recorded as passing; evidence and platform boundaries are in the coverage matrix.

## 2026-11-04 Sidebar render isolation on session switch (SPT08)

When an existing session is clicked, the file preview callback changes with the active session; the sidebar did not use that callback yet still received it, and project file operations depended on the whole props, which invalidated the memo of every project row. Each single-row TaskList also subscribed to the whole workspace's activeTaskId, so unrelated session rows re-ran.

- The sidebar contract drops the unused code preview callback. Project file operations depend only on the navigation, connection and file entries actually used; a top navigation state change must not rebuild all projects' file operations, and a real file entry change still uses the latest callback.
- A single row derives its own selected state from the existing session store, and identity stays workspaceIdentity or workspacePath. Switching inside one workspace updates only the old and new selected rows; a same-named session in another workspace is unaffected.
- A pure selected-state change updates project content zero times; opening an unread session for the first time still clears the Host's unreadAt, and only that session's project may update. The runtime records changed fields; a real unread update must not be masked as an extra render.
- No new selected-state cache; no change to the Host row set, navigation completion, unread CAS, file-entry cancel generation, or the desktop-continuous / web-remote-replayable boundaries.

```text
click session -> session store single selected state -> old/new selected rows
navigation chrome change -> sidebar parent -> file-operation dependencies unchanged -> project content skips update
real file callback change -> latest callback -> original file navigation/connection chain
```

SPT08: 44 projects, desktop/mobile layouts, both themes; draft entering a session and A/B switching in a row, isolation of same-named tasks across workspaces, the latest file entry, and unchanged project/task DOM identity. Browser/standalone Electron record the component execution scope; the full App replays the actual selection and file entries. Render counts are assertions; timing is observation only, and dev-mode results are not used to infer production FPS.

New-session regression (SPT08): clicking New from an existing session has two independent commit phases, the active session being cleared and the draft warm-up obtaining a session ID. Neither phase may update unrelated project content; only the previously selected row may deselect. Draft preparation, project ownership, session navigation and file-operation cancel semantics are kept, and the fix is not done by hidden updates or a comparator that ignores props. After first entering a workspace from a history session, New fills in the tab's workspacePurpose; such classification updates must likewise not propagate to the whole list. Navigation clicks read the latest target from the window tab store; the remote sync menu subscribes only to the workspaceIdentity -> localWorkspacePath mapping, and a real mapping change still updates the sync target. Connection resolution of a session row subscribes only to workspacePath, workspaceIdentity, remoteSessionId and remoteTarget, so classification field updates cannot pierce the single-row memo; remote identity and connection switches still trigger the original resolution. The full Dev App must record, on a site with at least 40 projects, the React commits for a click and for Cmd/Ctrl+N, draft warm-up completion and list DOM identity; the standalone browser fixture covers desktop/mobile layouts and both themes.

```text
existing session -> click New -> active session cleared -> draft warm-up done
                                   `- only the previously selected row updates
unused preview callback does not enter the sidebar; actual file navigation inputs unchanged -> zero project content updates
```
