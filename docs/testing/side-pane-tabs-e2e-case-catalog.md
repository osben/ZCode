# Side Pane Tabs E2E Case Catalog

## Scope

This document records the desktop UI E2E semantics of the Side Pane Tab strip: responsive width, overflow, action buttons and title Tooltip. The capability belongs to UI shell presentation and does not depend on the Agent, provider fixtures, session realtime or persistence recovery.

## State Dimensions and Pruning

| Dimension     | Equivalence classes                                                          | Decision                                                                                                   |
| ------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Available width | fits 156px / must shrink between 156px and 60px / 60px still does not fit | All three covered                                                                                          |
| Tab type      | Browser / Terminal / Diff / Code Viewer / session-scoped tab                 | A repeatedly creatable Terminal represents the shared `SidePaneTabTrigger`; type-specific content is not repeated here |
| Tab state     | active / inactive                                                            | Covered together by the close-button case                                                                  |
| Tooltip hover | under 1500ms / 1500ms reached / across Tabs                                  | All three covered                                                                                          |
| Client        | Desktop / mobile Web touch                                                   | Desktop covered; touch does not rely on hover so Tooltip is pruned; mobile layout is covered by component-level responsive tests |
| Middle click  | active / inactive tab                                                        | Desktop covered; a middle click closes without activating the target tab and prevents the browser's default middle-click scroll |
| Other interaction | drag, right click, tab overview                                          | Not part of this change; existing component tests, not repeated here                                       |

## Accepted Cases

### SPT-E2E-000 Independent panel platform radius and drag indicator

- Setup: desktop new-task draft, Side Pane and bottom Terminal expanded, light and dark theme each.
- Action: wait for platform state and layout readiness, hover and drag the Sidebar, Side Pane and Terminal handles.
- Assertions: Windows 5px, Sequoia and earlier macOS 6px, Tahoe 26+ 12px, Linux 12px; three hit areas stay 4px, the indicator is a 2px along-edge foreground-subtlest/50 line with no mask, hidden by default and visible on hover/drag, and sizes really change.
- Data-chain addition: `useAppChromeStateAutoUpdate.test.ts` runs the real hook, with the async platform query returning macOS 15/26, verifying radius and subscription cleanup; it catches a macOS query skipped by a guard on non-macOS CI. It does not replace macOS native visual acceptance.

### SPT-E2E-001 Default width and the following plus button

- Setup: desktop window with Side Pane open and a single Terminal tab, with enough space for the default width.
- Action: observe the tab strip.
- Assertions: Tab width is 156px (sub-pixel tolerance); the horizontal viewport has no overflow; the add button sits inside the scroll content right after the last Tab.

### SPT-E2E-002 Equal shrink without scrolling

- Setup: three Terminal tabs, window resized to need shrinking while every Tab stays above 60px.
- Action: wait for ResizeObserver to finish layout.
- Assertions: all Tab widths are equal; width is in `[60px, 156px)`; no horizontal viewport overflow; the add button is still inside the scroll content.

### SPT-E2E-003 Scrolling after the minimum width is reached

- Setup: keep creating Terminal tabs until the sum of 60px minimum widths exceeds the available space.
- Action: wait for the overflow state to update.
- Assertions: no Tab is below 60px; viewport `scrollWidth > clientWidth`; the add button moves outside the viewport, fixed in the right action area.

### SPT-E2E-004 Close button shows when selected or hovered and does not activate

- Setup: at least two Tabs, the second active, the first inactive.
- Action: move the mouse away and clear focus, check close-button visibility; hover the inactive Tab and click its close button.
- Assertions: the active Tab's close button is visible; the inactive Tab's is hidden when not hovered and visible on hover; the inactive Tab is closed; the original active Tab stays active.

### SPT-E2E-005 Tooltip waits 1500ms independently

- Setup: at least two Tabs.
- Action: hover the first Tab for under 1500ms, move to the second Tab, then wait until the second Tab itself reaches 1500ms.
- Assertions: no Tooltip within the first wait window; the waited time is not inherited across Tabs; after the second Tab reaches 1500ms, a Tooltip with the complete title shows.

### SPT-E2E-006 Middle-click close without activation

- Setup: at least two Tabs, the second active, the first inactive.
- Action: dispatch a middle-button (`button=1`) event on the label body of the inactive Tab.
- Assertions: the inactive Tab is closed; the original active Tab stays active; the event default is prevented and no tab activation is triggered.

### SPT-E2E-007 Plugin panel: empty state and new-tab dual entries

- Setup: real `AnimatedSidePanePanel`, plugin discovery hook and open action; the fixture creates and activates tabs through `activateNewTabSidePane` and the unified ownership function. The recommended list contains two surfaces and another development surface is not recommended; covers 1200px/en-US/light and 390px/zh-CN/dark.
- Action: open a plugin from the default new-tab launcher on first expansion, click "+" to create a new-tab, and repeat-open the same plugin from the active tabpanel's launcher; create another tab and open a second plugin with Tab/Enter.
- Assertions: both entries show the same recommendations and localized titles; requests keep the workspace/session fields, repeated opens reuse the plugin tab; after install or enable a separate click is needed to open. A draft session hides the whole app plugin area with its divider and the view-all-plugins entry; an existing session entering the marketplace from the default empty state or an explicit new tab can return to the source, and after returning from the default empty state the panel stays expanded. With no host and no bridge there are no plugin items; an empty recommendation or failed config shows the empty state; cold load shows a skeleton. The new tab stays visible and a narrow screen has no horizontal overflow.
- Operation progress: with controlled install/enable responses, only the target plugin shows loading and is disabled, others keep their original copy and clickable state. Two different plugin installs submitted in a row each keep their progress; one failing or succeeding clears only itself, and enabled plugins can still be opened. Repeated clicks on the same plugin submit once, failure is retryable, success does not auto-open. Covers the empty state and new tab, desktop light English and phone dark Chinese.
- Loading icon: while waiting for the response, the target entry shows a visible rotating icon and `aria-busy`, cleared on success or failure; the same plugin's two surfaces show progress in sync, other plugins show none; with reduced-motion preference the icon stays but does not rotate.
- Boundary: services are injected by the browser fixture and requests are checked at the plugin tab owner boundary; no sandbox, Agent or real phone remote control. Browser E2E 16/16 passed (4 groups of concurrent install without blocking, 8 of operation progress, same-plugin multi-surface / reduced-motion regression). Stays manual-review/pending; it does not represent real Agent install, plugin sandbox or phone remote verification.

### SPT-E2E-008 Conversation-isolated close and restore (manual-review/pending)

- Setup: conversations A and B in the same workspace each have a Browser and a site-permission settings tab.
- Action: B closes others and closes all; switch back to A and check retention, then close A's settings tab; switch to B and check recently closed, then switch back to A and reopen.
- Assertions: B's close does not delete A's hidden tabs; recently closed shows only the current owner's records; reopening in A restores the original settings tab; the Browser main close matches the UI.
- Evidence: real Electron menu/tab/settings page and renderer logs. No model request, no site-permission decision change, no provider fixture. A passing run still keeps manual review pending.
- Unit supplements: same path with different workspaceIdentity, public / conversation / draft tabs, each intrinsic owner type, no visible tab, switching workspace/conversation or opening a new tab while an async close waits, main rejecting a close.

## Invariants

- `+` does not take part in the equal-width computation of Tabs.
- Scrolling can only happen after all Tabs have reached the 60px floor.
- A close-button click must not trigger Tab activation or dragging.
- A middle-click close must not activate the target Tab first nor trigger the browser's default middle-click scroll.
- The timing state of Tooltip must not change the flex-shrink behavior of Tabs.
- This group must not start model requests or depend on a provider replay fixture.

## General / Coding mode M1

Scope and MODE-01 to MODE-07 cases: see the [mode verification matrix](general-coding-mode-verification.md). The desktop case is `packages/desktop/test/e2e/ui-shell/general-coding-mode.test.ts` (settings preference, entry hiding, existing panel retained); manually accepted and promoted to a formal ui-shell case, not yet in a Docker preset. Conversation display is covered by component unit tests; verification status follows that matrix.

### New tab multi-open and standard tab behavior

- Setup: open one Terminal tab.
- Action: click "+" twice in a row, select the first new tab, then close the two new tabs separately.
- Assert: the two ids are independent, the latest page is active, the title is the new-tab title, width does not exceed 156px; the old page can regain focus and shows the launcher; closing removes only the target tab.
- Entry change: the former plus-menu selection became a launcher row inside the new tab, still using the existing app open action.

### SPT-E2E-009 Default new tab and tool replacement

- Setup: new task draft with no tab in the current scope.
- Action: expand, choose terminal, collapse and expand again, click plus, close the added tab and the last tool tab.
- Assertions: first expansion shows exactly one new tab and the plus; terminal replaces that tab; restore after collapse keeps the original id; plus adds independently; closing the last tab collapses the panel; expanding again creates a new tab.
- Scope: desktop interaction and shared UI state; cross-scope and async close are supplemented by hook regression.

SPT-E2E-009 addition: after the last tab is closed the panel collapses with no rebuild; re-expanding creates a new tab. After the real close-menu command closes the only new tab, the next close-context event is not intercepted by the App and can enter the window-close fallback.

## Full view (SPFV, spec: `docs/ui/side-pane-full-view.md`)

### State dimensions and pruning

| Dimension      | Equivalence classes                                        | Decision                                                                                          |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Entry          | button / shortcut                                          | Both cover enter and exit                                                                         |
| surface        | conversation tab / panel tab / no visible panel tab        | First two covered; with no visible tab the launch page is handled by component logic, not covered separately |
| Float form     | collapsed / collapsed + action bar / expanded / minimized  | All covered                                                                                       |
| Exit           | button / shortcut / ◫ / close the last tab      | First three covered; closing the last tab reuses the existing collapse logic, covered by owner-memory unit tests |
| owner          | switch back to the same session / different session        | Covered by the provider case                                                                      |
| Blocking interaction | appears when collapsed / appears when minimized      | Appearing when minimized is covered (also proves the card is inside the float)                    |
| Client         | desktop / Web / phone remote                               | Desktop only; Web and remote do not render the entry, covered by component condition unit tests   |

### SPFV-E2E-001 Enter, exit and single instance

- Setup: desktop draft, open the Side Pane and create a Terminal tab; put a DOM marker on the main SessionPane root.
- Action: click «进入完整视图» (enter full view); exit with the shortcut; enter again with the button.
- Assertions: in full view the left task list width is unchanged, the top-left button group remains, WorkspaceHeader does not exist, the Side Pane frame width is close to the `#content` width; the first tab in the tab strip is the conversation tab, with computed style `-webkit-app-region` of `no-drag` (clickable with a real mouse); after exit the sidebar and panel widths return to those before entering; throughout, the SessionPane root keeps the same DOM marker (not remounted).

### SPFV-E2E-002 Conversation tab full width and panel tab float

- Setup: after 001, the current tab in full view is Terminal.
- Action: click the conversation tab; then click the Terminal tab.
- Assertions: with the conversation tab active the conversation host covers the slot (within 2px), the float does not exist, the input is a two-row layout (`data-composer-layout=stacked`) with the draft project bar; back on the Terminal tab the float appears at the slot's bottom-right (16px from the edge) exposing only the input area: input area and float have the same width and aligned bottoms, no outer padding, the drawer invisible; the input is single-row (`data-composer-layout=inline`, float height at most 64px, "+", the input area and the send button on one row left to right, vertically centered within 2px, the input area at least half the width), with no draft project bar; the DOM marker put on the input node before switching is still there (editor not remounted).

### SPFV-E2E-003 Action bar, minimize and restore

- Setup: after 002, float collapsed.
- Action: click the float input and type; click blank panel space; focus the input again and click «−» (minimize); click the round button.
- Assertions: when the input has focus the drawer slides out and the action bar is visible without a title (no loading even when idle), and the drawer extends to the input's bottom edge (within 1.5px, no notch on either side); hidden on blur; after «−» only the round button remains; after clicking it the collapsed state is restored, the input gets focus and the text is still there; after switching to the conversation tab the main input shows the same text.

### SPFV-E2E-004 Drag snap and menu

- Setup: after 003, float collapsed.
- Action: drag ⠿ to the slot's top-left area and release; click ⠿ to open the menu and choose «在完整视图中打开» (open in full view).
- Assertions: after release the float sticks to the slot's top-left (16px); the global preference `zcode:side-pane-full-view:floating-anchor` is written as `top-left`; after choosing the menu item the conversation tab is shown and the float's expanded state is not changed by the menu click (regression: portal events bubble along the React tree).

### SPFV-MODEL-001 Float model menu dismissal (pending)

- Setup: full-view float over a standalone plugin page; two available models and one locked model.
- Action: open the model menu and click the plugin area; open it again and select a model (including the current model and keyboard confirmation), then click outside to close; change level and switch Provider; close with Escape.
- Assertions: one outside click closes the menu and does not trigger the underlying plugin action; selecting an available model takes effect and keeps the menu open, a locked model does not close it; level change and Provider navigation keep it open; after selecting a model one outside click still closes it, and the plugin remains interactive afterwards. Desktop Electron uses a real webview; browser phone width uses a standalone iframe; both themes covered.
- Candidate automation: `packages/ui/test/browser/manual-review/pending/composer-menu-dismiss.test.mjs`, together with the existing `ui-shell/side-pane-full-view.test.ts` for the full App's float behavior. The component-level fixture does not cover plugin install, Agent handshake and remote connection.

### SPFV-E2E-005 Expand and collapse the message stream

- Setup: float collapsed + action bar.
- Action: click the «⌃» button; then click the «⌄» button.
- Assertions: after expanding the float height is above 400px and the timeline is visible, the button has `aria-expanded=true`; the bottom edge of the message scroll container is at least 8px above the input area's top edge (the scrollbar does not extend behind the input); clicking again returns to the collapsed state.

### SPFV-E2E-009 Plugin page layer not covered by the panel frame

- Setup: after 005, full-view float form, current tab is Terminal.
- Action: using the same styles as `pluginUiPagePlane`, put a `position:fixed; z-index:10` page node covering the slot into the parking layer at the end of `body` (`[data-sandbox-page-parking]`, `position:fixed; inset:0`, no z-index); run `elementFromPoint` in the slot's bottom-right area.
- Assertions: it hits that page node and not an element inside the panel frame (regression: the frame's `z-10` covered the plugin UI and the plugin tab was blank).

### SPFV-E2E-006 Panel toggle exit

- Setup: full view.
- Action: click the panel toggle ◫; then click the panel toggle on WorkspaceHeader to reopen.
- Assertions: after closing, the normal layout is back; after reopening it is still the normal view (does not return to full view).

### SPFV-E2E-007 Float send and per-session memory (provider)

- Setup: existing session A (first message completed), Terminal tab open, enter full view.
- Action: send a message in the float input; in full view create a draft with the command palette (⌘K → New task); switch back to A in the left task list.
- Assertions: the message appears in A's timeline and a reply arrives; after the answer ends an answer bubble pops up above the float containing only the answer body (no icon, no title); the draft is the normal view; after switching back to A the full view and float are restored and the bubble is still there (it disappears only via the x or by clicking); clicking the bubble expands the float and the bubble disappears, and it does not appear again after collapsing (regression: switching sessions does not produce React #185 and the panel does not stay collapsed).

### SPFV-E2E-008 AskUserQuestion appearing while minimized (provider)

- Setup: after 007, session A in full view, current tab Terminal.
- Action: send a prompt that triggers AskUserQuestion in the float (replay delay 4s), minimize right after the user message appears, wait for the question request.
- Assertions: after the user message appears (before the question request arrives, while the conversation is running) loading shows to the right of the action bar «⌃ / ⌄», the input placeholder is "工作中 N 秒" / `Working for …`, exactly the same as the running-duration text on the last line of the streaming message; the float auto-restores to collapsed and the question card shows inside the float; after submitting the answer the card disappears and the input recovers; a new bubble (`spfv-ask-done`) pops up when the answer ends, and after clicking the x the bubble disappears and the float stays collapsed; after the conversation is idle, focusing the float shows the action bar without loading.

### Invariants

- Switching full view must not remount SessionPane and must not write panel ratio or sidebar width persistence.
- The float and the conversation tab share the same draft.
- Webview / terminal instances of panel tabs stay mounted when the surface switches.
