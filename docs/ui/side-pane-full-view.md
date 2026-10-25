# Side Pane Full View

Status: implemented (2026-10-16), E2E promoted (2026-10-17): `ui-shell/side-pane-full-view.test.ts` and
`conversation-session/conversation-session-side-pane-full-view.test.ts`. Desktop Electron only; ordinary Web
and mobile remote `/remote` offer no entry. Code module: `packages/ui/src/side-pane-full-view/` (managed, see
its `CONTRACT.md`).

## Goal

The right panel can temporarily fill the whole area except the left task list. The middle conversation area no
longer takes layout space; the conversation becomes the first tab in the panel tab strip and a floating input
window is offered above the panel tabs. The left task list and the top-left button group (toggle sidebar,
back, forward, new conversation) stay as is.

## Entry and Exit

| Action                                                                                                         | Result                                                                                  |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| The panel top-right "进入完整视图" (Enter full view) button (left of the panel toggle), `⇧⌘F` / `Ctrl+Shift+F` | Enter full view; the current tab stays a panel tab and the floating window is collapsed |
| The same button (now "退出完整视图", Exit full view), the same shortcut                                        | Exit full view and return to the original three-column layout                           |
| Panel toggle ◫                                                                                                 | Close the panel and exit full view; reopening the panel does not return to full view    |
| Close the last panel tab                                                                                       | The panel collapses by existing rules and full view exits                               |
| Press the shortcut while the panel is closed                                                                   | Open the panel and enter full view                                                      |

- The shortcut command id is `toggleSidePaneFullView`, rebindable in settings; Web registers no handler and
  does not show it in settings.
- Exiting full view modifies no original state: sidebar visibility, sidebar width, panel width and terminal
  open/close keep their values from before entering.

## Layout

```
Normal view                                Full view
┌────────┬────────────────┬────────────┐   ┌────────┬───────────────────────────────┐
│ task list │ WorkspaceHeader │ [tabs][⤢][◫] │   │ task list │ [💬 chat][tab…][+]   [⤡][◫] │
│        │ conversation    │ panel content│   │        │ panel content (or full-width chat) │
│        │ terminal        │             │   │        │              ┌─────────────┐ │
└────────┴────────────────┴────────────┘   │        │              │ floating input │ │
                                           └────────┴──────────────┴─────────────┴─┘
```

- The left task list and the top-left button group show as usual, and the sidebar toggle works as usual. When
  the sidebar is collapsed the left of the tab strip leaves room for the button group by the same rule as
  `WorkspaceHeader`; when expanded it leaves none.
- `WorkspaceHeader` is not shown; the panel tab strip replaces it as the content-area top bar; Windows/Linux
  window buttons stay at the panel top right.
- The conversation tab is fixed first: chat icon + current task title (a draft shows "新任务" (New task)); it
  cannot be closed or drag-sorted and has no "..." menu (the task menu stays on the title bar after exiting
  full view). The tab strip is a window drag area (`app-region: drag`), so the conversation tab must be marked
  `no-drag` explicitly, or a real mouse click would be taken as a window drag.
- Clicking the conversation tab shows the conversation full width in the panel content area (including the
  bottom terminal). Clicking any panel tab shows that tab and the floating input window appears.
- In full view the panel frame is `absolute inset-0 z-0`: it only establishes its own stacking context and
  does not raise the level. Plugin UI pages are not in the panel DOM but sit in a fixed parking layer at the
  end of `body` (`[data-sandbox-page-parking]`, no z-index) placed by the tab placeholder's coordinates; if
  the frame used a positive z-index, its opaque background would paint over the plugin pages. The conversation
  content lives in the host (`fixed z-30`), so the floating window stays above plugin pages.
- When an expanded panel has an empty tab set, `useAppPanels` creates a "新标签页" tab (see
  `docs/ui/side-pane-tabs.md`) and full view follows; in the instant before it is created the content area
  shows the same launcher page, and the tab strip has only the conversation tab and "+".

## Single-Instance Principle

The conversation area keeps only one `SessionPane` instance. Full view only changes the positioning of its
container: no DOM move, no remount, no second composer copy.

```
WorkspaceShellLayout (the React tree structure is the same in all three forms)
└─ #content / ResizablePanelGroup (saved panel ratios unchanged)
   ├─ conversation-column
   │   └─ full-view host (a permanently present wrapper)
   │       ├─ normal view: static layout, h-full
   │       ├─ full view + conversation tab: position: fixed, fills the panel content area (slot)
   │       └─ full view + panel tab: position: fixed, floats inside the slot at the snap position
   ├─ ResizableHandle: hidden in full view
   └─ panel panel: fills the width in full view
```

Reasons:

- Two composers bound to the same session each hold a draft copy and the last writer overwrites the other;
  the attachment upload controller is also saved per instance.
- Switching containers remounts SessionPane, losing scroll position, focus and in-flight attachments.
- Permission / Q&A cards depend on the conversation context and must stay in the original React tree.
- Esc-to-stop works only when focus is inside the conversation DOM; the floating window is the same DOM, so
  pressing Esc in a browser tab does not stop the agent.
- The embedded browser is a DOM `<webview>`, so an HTML floating layer can cover the web page.

The slot is the content area below the panel tab strip. The host reads the slot's window coordinates through
ResizeObserver and writes them to the host style; this is only a DOM layout projection, not business state.

Panel width: full view does not change the flex managed by react-resizable-panels; the panel frame becomes
`absolute inset-0`, using the PanelGroup as positioning container to fill the whole row. The library computes
group size from the sum of each panel's `offsetWidth`; squeezing the conversation column to 0 with CSS would
make the group size 0 when the panel expands from collapsed, and the resize would fail.

## State Ownership

```
Remembered per session: taskSidePaneMemory.sidePaneFullViewByOwner[ownerTaskId ?? "__draft__"]
└─ { surface: "conversation" | "side-pane", floating: "collapsed" | "expanded" | "minimized" } | absent

Global preference: localStorage "zcode:side-pane-full-view:floating-anchor"
└─ one of 7 snap positions, default bottom-right

Transient state inside the host component (not remembered)
└─ coordinates while dragging, whether the action bar shows, bottom input area height

Read-only derivation
├─ full view in effect = desktop && not remote && panel open && current owner has a record
├─ WorkspaceHeader shown = !full view in effect
└─ floating window shown = full view in effect && surface === "side-pane"
```

- The owner is the same as `sidePaneCollapsedByOwner`: taskId for a formal task, `__draft__` for a draft.
  Switching away and back to the same session keeps full view, the current surface and the floating form.
- Like panel tabs it lives only in memory, LRU per workspace; not retained after refresh or restart.
- When the panel goes from open to closed under the same owner, that owner's record is cleared (◫ and
  closing the last tab both take this path). A panel open/close change caused by switching owners clears no
  record.
- The auto-collapse strategy on window narrowing applies only in normal view; in full view the conversation
  is positioned by the host and the conversation column width does not represent the visible conversation
  area, so it must not be used to collapse the panel or sidebar.

## Floating Input Window

The floating window has two layers: the input box itself in front, and a drawer behind. The collapsed form
shows only the input box, with no outer border or margin; the drawer hides behind the input box, slides up
from behind it on focus to reveal the action bar, and when expanded keeps pulling up, holding a narrow message
stream.

```
 collapsed (blurred)        collapsed + action bar (focused)     expanded
                        ┌──────────────────────┐   ┌──────────────────────┐
                        │ [−] [⌃] ◌        [⠿] │   │ [−] [⌄] ◌        [⠿] │
                        │╭────────────────────╮│   │ narrow message stream │
 ╭────────────────────╮ ││[+] input…  [ctrls][↑]││   │╭────────────────────╮│
 │[+] input…  [ctrls][↑]│ │╰────────────────────╯│   ││[+] input…  [ctrls][↑]││
 ╰────────────────────╯ └──────────────────────┘   │╰────────────────────╯│
                          ▲ drawer slides up from behind the input box    └──────────────────────┘

 ◌ = conversation-running loading, hidden when idle
 focus enters the floating window -> drawer slides out (collapsed + action bar); focus leaves -> drawer retracts behind the input box
 click [⌃] -> expand; click [⌄] -> collapse
 any form -- "−" or menu "最小化编辑器" (Minimize editor) --> minimized (round button showing run state)
 round button -- click --> collapsed + action bar, input box focused
 a new permission / Q&A request while minimized --> auto-restore to collapsed, the card replaces the input box
 drag ⠿ or the round button -- release --> snap to the nearest position
```

- Input box layer: only the bottom input area of SessionPane (`data-v4-composer-dock`) shows; in floating form
  the input area has no inner padding, the input shell is the outermost layer of the floating window with
  `shadow-lg`. The inner SessionPane keeps the fixed expanded-state height and sticks to the bottom; content
  above the input area is clipped but still mounted. When a permission / Q&A card appears the input area grows
  and the floating window grows with it, as in the desktop main conversation.
- In floating form the input area is not in the message scroll container: it is still the same DOM node (no
  remount) but changes from sticky to bottom-attached relative to the timeline root; the scroll container's
  bottom edge yields "input area height + 12px" and messages leave 16px blank at the bottom, so the scrollbar
  stops above the input box and no longer extends behind it. In floating form the message layer adds no bottom
  fade mask (messages never pass through the input box). The conversation tab and normal view keep the sticky
  input area.
- In floating form the conversation uses no centered empty-session layout, the input area always sticks to the
  bottom, and neither the draft recommended hints nor the "choose project / branch" bar at the draft top show
  (switch to the conversation tab to choose a project).
- The input box is single-line in floating form: `[+] [input area] [mode / model controls] [send]` on one row.
  The input area takes at least half the width; when controls do not fit, the main input toolbar's progressive
  collapse rule applies (text first, finally icon only). When text exceeds one line the input area grows
  upward with left/right buttons stuck to the bottom. `topContent` such as attachments takes a full row above
  the input row.
- The single-line and ordinary two-line layouts share one DOM tree and switch only styles: the editor node
  position is unchanged, so switching between the floating window and the conversation tab does not remount the
  editor and the draft, cursor and undo history are kept. Only the "+" menu button changes position and
  remounts.
- Running placeholder: in floating form while the conversation runs, the input placeholder shows
  "工作中 {duration}" (`chat.history.workingFor`), the same value as the running work segment's "工作中 N 秒" in
  the message stream (the same `workStatus.durationMs`, refreshed every second) with the same formatter
  (`formatConversationWorkDuration`, day / hour / minute / second suffixes, at most two segments). Before a
  duration exists the original placeholder is kept; the conversation tab and normal view are unchanged.
- Answer bubble: in floating form, when one round of answer ends (a turn appears that is ended, whose final
  answer is complete and different from the baseline), a bubble shows above the floating window (below it at a
  top snap position) with only the first two lines of plain text of the answer body, no icon or title.
  Baseline: when the floating window first sees a session, ended turns count as seen and a running turn does
  not; leaving floating form clears the baseline and re-establishes it on return, so answers seen in the
  conversation tab do not pop up. It does not require seeing "running": replay or a very fast answer may go
  from not started to ended within one render.
  - Only two ways dismiss the bubble: click the top-left x; click the bubble itself (which also switches the
    floating window to the expanded form to show the message stream). Sending the next message keeps the
    bubble, and it is replaced by the new answer after the next round ends.
  - The bubble is recorded per session (memory only) and survives switching away and back; it shows only in the
    collapsed floating form and hides (without clearing) when expanded or minimized.
  - The data source is unique: the timeline's last turn (render unit) gives turnKey, run state, run duration and
    final answer together, reported once via `reportFloatingStatus`, avoiding inconsistent order when run state
    and answer come from two sources.
- Drawer layer: the same width as the input box, `rounded-2xl`, `bg-background`, `border-border`, `shadow-lg`.
  When blurred it hides wholly behind the input box; when the action bar is visible it extends all the way down
  to the input box bottom edge with continuous side borders, and what shows outside the input box's top
  rounded corners is the drawer background (if the drawer reached only a short way behind the input box, the
  drawer's bottom corners and the input box's top corners would leave a notch). Height transitions with the
  floating window size, producing the slide-out effect from behind the input box.
- The action bar has only buttons: "−" minimize on the left, "⌃ / ⌄" expand or collapse the message stream,
  and on the right ⠿ is the drag handle and menu in one. It shows no task title (the title is on the
  conversation tab). While the conversation runs (`snapshot.control.canStop`, the same state source as the round
  button), a spinning loading icon shows right of "⌃ / ⌄" and hides when idle. Blank space on the action bar has
  no click behavior and pressing it does not steal the input box's focus.
- In the collapsed form the action bar shows only when focus is inside the floating window or a menu is open;
  in the expanded form it always shows.
- ⠿ hover hint "拖动以移动 · 点击查看选项" (Drag to move, click for options). A click (movement under 4px)
  opens the menu: "在完整视图中打开" (Open in full view) switches to the conversation tab; "最小化编辑器"
  enters minimized. A drag over 4px makes the floating window follow the pointer and snap on release. Clicks of
  the ⠿ menu portal bubble along the React tree, so the action bar container must carry no click behavior.
- Switching between minimized and restored, the floating window size takes effect directly with no width/height
  transition; instead it scales (0.92 -> 1) and fades in from the snap corner of the round button for 150ms.
  While minimized the input layer keeps the floating-window width layout (invisible) and does not reflow with
  the 48px button. Reason: a width transition from 48px to 560px would wrap the single-line input into several
  lines, the measured input height would grow first then shrink back, and the floating window background would
  first get taller and then drop.
- Snap positions: top-left, top-right, middle-left, middle-right, bottom-left, bottom-center, bottom-right,
  16px from the slot edge. Top positions expand downward, bottom positions upward, middle positions centered.
- The expanded form is 560px wide and min(640px, slot height - 32px) tall, with the message stream scrolling
  inside; the collapsed form has the same width; when the slot is too narrow the width shrinks to slot width -
  32px.

## Split Pane Entry Removal

This feature also removes all entries of the conversation-area split pane (see
`docs/v4-split-pane-workbench.md`): the task row context "在分屏打开" (Open in split) and dragging a task row to
the conversation area edge to create a split. Dragging a task row onto a project to move the task is kept.
Existing split layouts still display and close normally. The full-view floating window shows only the
currently focused pane.

## Verification

- Unit tests: snap position computation, nearest snap point, owner memory and exit rules, shortcut table.
- Desktop E2E (formal): see the SPFV cases of `docs/testing/side-pane-tabs-e2e-case-catalog.md`.
