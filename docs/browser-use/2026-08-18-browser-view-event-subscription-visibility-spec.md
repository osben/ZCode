# Browser View Authoritative Event Subscription Decoupled from Visibility

## Background

Ticket ZCT-2089607799244095488 (3.8.0 Windows) reported "cannot open the side-bar bua". The main log
showed three `newTab` calls in one session all timing out in the 10-second attach window:

```text
14:55:09.535 newTab -> 14:55:19.540 waitForGuest timeout ok=false (10004ms)
14:55:29.891 newTab -> 14:55:39.892 waitForGuest timeout ok=false (9999ms)
14:55:50.514 newTab -> 14:56:00.525 waitForGuest timeout ok=false (10011ms)
```

During the same period `list`, `listUserTabs`, `browserVisibilityGet` and `browserVisibilitySet` all
succeeded, there was no renderer crash and no error-level log, and the whole log had no `attachGuest`
record (including skip / rejected): the renderer never reported the guest `webContentsId` back to main,
that is, the renderer never created a webview.

All three `newTab` calls were adjacent to `system.listIntegratedTerminalShells` (called only by
`SettingsPage`), accompanied by `getStaticTeamProducts`, `getEnterprisePricing` and
`file-watcher.unwatch`, which shows the settings page was active during the failure. The user reproduced
it: switching to the settings page while a Browser Use conversation runs triggers it.

## Root cause

`isWorkspaceVisible` carried two semantics at once:

- Display semantics: whether the view is shown to the user now.
- Subscription semantics: whether to receive main's authoritative events.

`RootWorkspaceContent` passed `isWorkspaceVisible={!isSettingsTabActive}`, and `useAppPanels` hung the
four Browser View event subscriptions on that flag. When the settings page opened, effect cleanup
unsubscribed; the `BrowserViewReady` that main's `onOpenTabRequested` emitted had no receiver,
`waitForGuest` waited 10 seconds then failed, and the `newTab` branch immediately ran
`closeTabDurably(tab)` and deleted the tab. When the user left settings the side bar had no browser tab,
which looked like "cannot open the side bar".

Main is the sole authority on browser tab lifecycle and the renderer is only a passive receiver. Turning
off the subscription by visibility sends authoritative events into a black hole during the settings page,
a design flaw and not an occasional bug.

## Target semantics

- Subscribing to main authoritative events is independent of view visibility: the subscription stays
  resident while the settings page covers the app.
- Whether to grab focus is still decided by the existing `shouldReveal` (workspace / remoteSession /
  ownerTaskId scope match); no new pending reveal state.
- While the settings page is shown, the agent can still create, navigate and operate iab tabs normally;
  tabs and page content are preserved as they were after leaving the settings page.
- The settings page is an overlay; App and the side pane are not unmounted, so "preserving content"
  needs no extra state save or restore logic.
- Capability semantics remain a gate: `isDesktop` and `supportsEmbeddedBrowser` still take part.

## Event chain

```text
Before the fix (settings page active -> isWorkspaceVisible=false)

  main (tab lifecycle authority)              renderer
  --------------------------                  --------
  newTab
   +- ensureGuest
   |   +- onOpenTabRequested
   |       +- send BrowserViewReady ---X--->  subscription already cleaned up, event dropped
   +- waitForGuest (10s)
       +- timeout -> ok=false
           +- closeTabDurably --------------> tab deleted
                                              no browser tab in the side bar after leaving settings

After the fix

  newTab
   +- ensureGuest
   |   +- send BrowserViewReady ----------->  subscription resident
   |                                          +- applyBrowserUseSidePaneEvent
   |                                          |   +- mount tab (unconditional)
   |                                          |   +- shouldReveal decided by scope
   |                                          +- <webview> created and attached
   +- waitForGuest <------ browserViewAttachGuest
       +- attachGuest -> resolveWaiters ok=true
```

## Implementation constraints

- In `packages/ui/src/hooks/useAppPanels.ts` the four effects drop the `!isWorkspaceVisible` check:
  `onOpenBrowserUrl`, `onBrowserViewReady`, `onBrowserViewOperation`, `onBrowserViewVisibility`. All four
  are main authoritative forwards, and missing any one leaks events: a missed ready makes attach time out
  and deletes the tab; a missed visibility makes `browserVisibilitySet` return ok while the UI does not
  move; a missed operation desynchronizes the tab's operation indicator; a missed `onOpenBrowserUrl`
  silently swallows an in-page `target=_blank`.
- `isWorkspaceVisible` stays in the hook parameter type but the hook does not consume it. Display
  semantics are carried by the consumers inside `App.tsx`. The parameter serves no runtime semantics; its
  only reason to stay is as a regression guard: unit tests pass `false` to express "settings page
  covering", and if visibility is ever written back into the subscription condition the four cases fail
  immediately. Deleting the parameter would delete that protection.
- The other consumers in `App.tsx` are unchanged: `useGitAutoRefresh` `enabled`,
  `getCloseActiveContextSidePaneTab`, `runWorkspaceVisibleCommand` and `useWorkspaceMainViewSettingsExit`
  use "user intent / performance" semantics.
- No pending reveal and no event caching/replay: the existing `shouldReveal` already expresses focus
  semantics, and replay would fight main authority over tab lifecycle.
- The first `tabs.new()` in a hidden or 0-width pane can still attach and merely gets a 0x0 viewport,
  covered by `applyBackgroundViewportFallback` in `browserGuestManager`; this path is not changed.

## Acceptance

- With `isWorkspaceVisible: false`, `BrowserViewReady` still mounts the tab and, when the scope matches,
  expands and activates it.
- After `isWorkspaceVisible` switches from `true` to `false`, the subscription is not dropped.
- With `isWorkspaceVisible: false`, visibility events still switch the active tab.
- With `isWorkspaceVisible: false`, an in-page `target=_blank` still opens a right-side browser tab.
- Unit tests cover the four items above: `packages/ui/test/useAppPanelsBrowserViewLifecycle.test.ts`.

## Runtime verification (2026-08-18, macOS dev)

With the settings page left open, the agent was asked to "open https://example.com with the embedded
browser"; main and renderer logs:

```text
18:12:38.983 [main]     browser-use execute start method=newTab
18:12:38.984 [renderer] [App] expand and activate browser-use tab tabId=iab-tab:2...
18:12:39.088 [main]     browser-use attachGuest tabId=iab-tab:2994a9a5... windowId=1 cdp=true
18:12:39.090 [main]     browser-use execute done method=newTab ok=true elapsedMs=107
18:12:39.221 [main]     browser-use execute done method=navigate ok=true
18:12:40.046 [main]     browser-use execute done method=playwright ok=true
18:12:42.712 [main]     browser-use execute done method=screenshot ok=true
```

`newTab` finished in 107ms (before the fix: a 10004ms timeout and tab deletion), and navigate / playwright
/ screenshot all succeeded while the settings page covered the app, showing the guest did not get an
unusable 0x0 state. After leaving the settings page the webview still existed with a visible size of
385x216, the side-bar tab title synced to `Example Domain`, and content was fully preserved.
