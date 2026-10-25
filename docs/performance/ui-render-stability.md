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
