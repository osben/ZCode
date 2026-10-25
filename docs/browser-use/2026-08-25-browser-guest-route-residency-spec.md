# Browser Use Guest Cross-Main-View Residency Spec (Minimize Deferred)

> Status: implemented for the current iteration (the minimize scenario is deferred)
> Decision date: 2026-08-25
> Applies to: the Browser / Browser Use `<webview>` Guest of Desktop `desktop-continuous`.
> Does not apply to: mobile `web-remote-replayable`, task/session recovery in relay, a standalone background browser window.

## 1. Background and runtime root cause

After the CDP teardown fix of ticket `ZCT-2092076135526567936`, scheduled tasks running Browser Use in the "Automations" main view still failed:

```text
browser-use newTab
  -> renderer receives BrowserViewReady and registers the iab tab
  -> no browserViewAttachGuest within 10 seconds
  -> waitForGuest timeout
  -> browser guest not attached (webview not ready)
```

In runtime reproduction, staying on the automations page made both `newTab` calls time out after 10 seconds; after switching to the chat page of the executing session the old tab immediately created the `<webview>`, reported `attachGuest`, and navigate / screenshot succeeded. The root cause was not that main failed to create the Guest: `WorkspaceShellLayout` rendered `AnimatedSidePanePanel` only in the chat main view branch, while the automations main view rendered only `AutomationsSection`. So although the renderer held the Browser Use tab shell, there was no DOM to host the Guest.

The existing `shouldMountSidePaneContent()` contract already requires Browser / Browser Use tabs to keep the `<webview>` mounted even when the panel is collapsed. The gap was one level out: the whole Side Pane component was unmounted by main-view routing, so that contract never had a chance to run.

## 2. Current iteration scope and confirmed product boundary

- This iteration guarantees only that Browser Use works from chat, automations, plugins, Repo Wiki and other main views while the ZCode window exists and is not minimized.
- The existing Guest/cold-start behavior after the main window is minimized to the macOS Dock is out of this iteration's acceptance and is handled separately later.
- Clicking "Run now" on the automations page, or a timer trigger, must not require the user to enter the executing session's chat page first.
- No "non-shrinkable transparent window" or any standalone background BrowserWindow is added.
- Non-chat main views (automations, plugins, Repo Wiki) do not show the Side Pane; a background Guest does not steal focus or change the main view.
- During screenshot prepare the physical Side Pane is not expanded; the Browser Use tab creates a fixed-size low-opacity composited layer inside the existing window, so the Guest keeps a compositor surface while not taking part in the right-side layout, and the user must not see the tab bar flash.
- A complete quit of ZCode still ends all Guests; no cross-process persistence or restart recovery is added.

## 3. Goals and non-goals

### 3.1 Goals

1. `AnimatedSidePanePanel` stays resident across `workspaceMainView` inside the Desktop workspace shell.
2. The chat main view keeps expanding/collapsing by `isSidePaneOpen`; non-chat main views are forcibly collapsed without unmounting the Browser Guest.
3. After the automations page receives `BrowserViewReady` it can create the `<webview>` and finish attach within main's 10-second deadline.
4. chat -> automations -> chat triggers no Browser Guest teardown, generation change or page reload.
5. When screenshot prepare arrives in a non-chat main view, the physical Side Pane stays collapsed and the tab's own fixed-size composited layer provides a real compositor surface; the layer is removed once release is requested.

### 3.2 Non-goals

- No transparent window, offscreen window or second Browser runtime.
- No change to BrowserCommand / ZCode Protocol; no new task snapshot, queue or replay field.
- The automations page does not show the Side Pane and a background task is not auto-switched to the foreground.
- No bypass of the 32-tab residency budget, session/workspace ownership or the CDP teardown handshake.
- No promise to restore Browser tabs, URL, history or page state after a complete app quit.

## 4. State and event chain

### 4.1 Before the fix

```text
workspaceMainView = automations
        |
        +--> AutomationsSection (mounted)
        |
        X--> AnimatedSidePanePanel (route branch not rendered)
                   |
BrowserViewReady --X--> no <webview> to create
                   |
                   +--> main waitForGuest 10s timeout
```

### 4.2 After the fix

```text
Desktop workspace shell
        |
        +--> ResizablePanelGroup (resident across main views)
                |
                +--> conversation-column
                |       +--> chat / automations / plugin-store / repo-wiki
                |
                +--> AnimatedSidePanePanel (resident across main views)
                        |
                        +--> chat: visible per isSidePaneOpen
                        +--> non-chat: collapsed, not interactive, but Browser Guest stays mounted
                                      |
BrowserViewReady --------------------> <webview> -> attachGuest -> CDP ready
```

### 4.3 Minimize lifecycle (later dedicated work, not accepted now)

```text
main window minimize
      |
      +--> renderer / Side Pane Host not destroyed
      |       |
      |       +--> an attached Guest keeps the same generation
      |       +--> CDP/DOM/navigation keep going through the original BrowserGuestManager
      |
      +--> screenshot
              +--> reuse the bounded screenshot activity lease
              +--> release after success/failure/cancel

main window close / app quit
      +--> follow the existing teardown and in-process lifecycle, no background window takeover
```

## 5. Impact brief

| Item                | Conclusion                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| Change level        | `presentation` + Desktop Guest `recovery/lifecycle`                                                |
| User entries        | automations main view "Run now", timer trigger, chat-page Browser Use                              |
| Authoritative state | logical tab/Guest in Desktop main; the renderer only hosts and attaches `<webview>`                |
| Commit side effects | no new business commit; only the mount location and visibility gating of the Side Pane Host change |
| Persistence         | none added; a complete restart is still empty                                                      |

| Scenario                 | UI entry                                                                           | Visibility owner        | Mode boundary                                    | Must isolate                           |
| ------------------------ | ---------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------ | -------------------------------------- |
| chat-page Browser Use    | `WorkspaceShellLayout` chat; shared `AnimatedSidePanePanel` / `UnifiedBrowserView` | `isSidePaneOpen`        | Desktop local/remote shared host                 | session, workspaceKey, remoteSessionId |
| automations "Run now"    | `AutomationsSection`; same resident Side Pane Host                                 | main view forced hidden | Desktop only                                     | no focus steal, no session switch      |
| scheduled background run | session derived by Automation service; same resident Side Pane Host                | main view forced hidden | Desktop continuous                               | not in the mobile replayable snapshot  |
| mobile `/remote`         | Mobile shell; no Electron `<webview>`                                              | existing mobile drawer  | `web-remote-replayable` (shared-host attachment) | no new Browser runtime                 |

Guest owner for all desktop rows: Desktop `BrowserGuestManager`.

Relationships: `WorkspaceShellLayout` keeps `AnimatedSidePanePanel` across main views (current unmount point and direct root cause); `AnimatedSidePanePanel` mounts `BrowserUseSidePaneContent` in the background (the real hosting chain from tab to `<webview>`); `useAnimatedResizablePanel` collapses without unmounting (non-chat pages must not take visible width); invariants: Browser tab residency (32-tab/teardown/scope: residency must not bypass recycling and isolation) and Web remote (replayable/shared-host: no mobile Guest or recovery state); evidence: UI layout tests + Electron logs (static structure and runtime evidence complement each other).

Graph drift: the existing feature graph declares that a Browser tab stays mounted when the panel is collapsed or the conversation switches, but not that the automations main view can trigger background Browser Use without showing the Side Pane. That confirmed relationship is added to `zcode-feature-graph.yaml` before implementation.

## 6. Implementation contract

### 6.1 Workspace shell

- Desktop main content is always hosted by the same `workspace-body-layout`.
- Inside `conversation-column`, `workspaceMainView` selects chat / automations / plugin-store / repo-wiki.
- `AnimatedSidePanePanel` is always a stable sibling of that layout; switching the main view must not change its React identity.
- `useAnimatedResizablePanel.open` is true only for chat with the user having opened the Side Pane; non-chat is always collapsed, and screenshots do not change the panel layout.
- During a non-chat screenshot prepare, the target TabsContent renders in a fixed host layer of viewport size inside the existing window with `opacity: 0.001` to keep the Chromium compositor surface, while not taking part in Side Pane layout, avoiding a tab bar or white flash on the automations page.
- During a non-conversation main view the logical `isSidePaneOpen` is not cleared; returning to chat restores the user's original expand intent.

### 6.2 Guest mounting

- `shouldMountSidePaneContent(false, tabs)` still returns true for Browser / Browser Use tabs.
- An already-mounted `<webview>` is not unmounted by a main-view switch; the existing Inactive/screenshot-composition rules are unchanged.
- After a new `BrowserViewReady` enters side pane state on the automations page, the next render must create the corresponding `UnifiedBrowserView` and report `attachGuest` through the trusted IPC sender.
- After the renderer accepts a screenshot prepare, the tab registry may update `browserGeneration` during attach/restore; requests keep routing by the stable `tabId + workspace/session/browser`, and the final stale check is still done by the main coordinator.
- No singleton global Guest is added; one logical tab still corresponds to its own stable tabId, scope and guest generation.

### 6.3 Screenshot and minimize deferral

- The main window never gets a permanent `backgroundThrottling=false`, and no transparent window is added.
- The owner renderer + target Guest screenshot activity lease is still reused; first creation and screenshot results after minimize are left to a later spec.

## 7. Acceptance and pruning

| Case    | Setup                                                                    | Action                                             | Assertions                                                                                                          | Status   |
| ------- | ------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------- |
| BCP-227 | stay on the automations main view with a runnable Browser Use automation | click "Run now" without switching to the chat page | `BrowserViewReady -> attachGuest -> newTab ok`; the automations page stays visible and the Side Pane is not exposed | accepted |
| BCP-228 | chat already has an attached Guest                                       | chat -> automations -> chat                        | `<webview>` identity/guest generation/URL unchanged; no teardown/rebind                                             | accepted |
| BCP-229 | an attached Guest exists, main window minimized                          | background navigate/DOM/screenshot                 | not accepted in this iteration; deferred to the minimize work                                                       | deferred |
| BCP-230 | no Guest, main window minimized first                                    | first background `newTab` and screenshot           | not accepted in this iteration; deferred to the minimize work                                                       | deferred |

Pruning: theme, language and model/provider do not change Guest attach semantics and are covered by structure unit tests and one real Desktop representative; mobile `/remote` has no Electron `<webview>`, so only "does not add that path" is verified, not a Cartesian product with the four Desktop cases.

## 8. Tests and runtime evidence

1. UI SSR/component regression: the automations main view still renders the single `AnimatedSidePanePanel` but its visibility is false; `workspace-body-layout` and `conversation-column` stay stable.
2. Existing `workspaceSidePane` / `BrowserUseSidePaneContent` / `UnifiedBrowserView` tests keep verifying hidden mounting, session/workspace scope and Guest attach.
3. Real macOS dev regression: stay on the automations page and click "Run now", observing `newTab -> attachGuest -> screenshot` completing inside the window (the screenshot still finishes in about 1.3 seconds when the generation updates after attach); switch back to chat and confirm page and Guest identity are preserved; minimize cases BCP-229/230 are not pass conditions and stay for the later work.
4. Must run: affected UI tests, `pnpm typecheck`, `pnpm lint`.

## 9. Done criteria

- BCP-227/228 automation and dev runtime evidence pass.
- BCP-229/230 are clearly marked deferred and do not block the current iteration.
- No visible Side Pane regression on the automations main view, and returning to chat restores the original expand intent.
- The Desktop continuous, mobile replayable, workspace identity, 32-tab residency and CDP teardown contracts are unchanged.
