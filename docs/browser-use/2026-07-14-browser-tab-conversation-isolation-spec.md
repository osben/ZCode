# Browser Use Per-Conversation Tab Isolation Spec

> Status: conversation isolation implemented. The absolute guest background-residency boundary was
> updated by `2026-07-31-browser-tab-residency-budget-spec.md` to "switching itself does not unload;
> budget overflow may suspend".

## 1. Problem and root cause

First `browser.user.openTabs()` in a new conversation:

- Expected: with an explicit IAB binding it returns `[]` and observes no other conversation's tabs.
- Actual (from a trajectory): ZCode returned 5 user tabs of the same window/workspace, 4 of them
  `about:blank` or with empty URL/title.

The leak came from two existing designs combined:

1. A normal right-side Browser tab attached its guest to main with only `workspaceKey`, not its
   `ownerTaskId` (already present in UI state). Main could only register it as a workspace-level globally
   claimable tab.
2. `turnEnded` / `finalizeTabs` / `closeSession` released control by moving the tab's session to the
   generic `unclaimed`, so other sessions' `listUserTabs` could discover it again.

Blank entries are not model fabrication: a mounted `<webview>` is ready as `about:blank` before its first
navigation, and `openUserTabs()` did not exclude blank or not-yet-loaded guests.

## 2. Frozen semantics

### 2.1 Conversation isolation is a hard boundary

The observable/claimable boundary of an IAB tab keeps the full browser scope. A human tab freezes at
attach time at least:

```text
(windowId, workspaceKey, sessionId)
```

- The renderer must pass the tab's own `ownerTaskId` as `sessionId` to `BrowserViewAttachGuest`, never
  the active task at event-arrival time.
- `browser.user.openTabs()` returns only uncontrolled user tabs whose `windowId + workspaceKey +
  sessionId` all match the caller.
- After a claim, deliverable, turn cleanup or session cleanup releases a tab, it keeps its original
  session ownership; "releasing control" does not mean "publishing to other conversations".
- An old renderer attach without `sessionId` may keep a visible UI but must never become claimable by any
  new session.
- Different remote workspaces with the same workspacePath stay isolated by the existing `workspaceKey =
  workspaceIdentity?.trim() || workspacePath`; never degrade to a path-only comparison.

### 2.2 Blank/unloaded tabs are not part of `BrowserUser.openTabs`

A user tab is discoverable only when its guest is alive and its current URL is non-empty and not exactly
`about:blank`.

- Empty string: no valid page load completed; filtered.
- `about:blank`: UI placeholder; filtered.
- Other URLs: discoverable; whether the agent may navigate is still decided independently by the
  browser-client http/https/about:blank action allowlist.
- A controlled `about:blank` created by the current session via `tabs.new()` still appears in
  `browser.tabs.list()`; this rule constrains only `browser.user.openTabs()` and must not break the
  standard flow of creating a tab and then navigating.

### 2.3 Lifecycle

- `turnEnded()` only cancels requests; it does not close the current session's agent tabs.
- `finalize({deliverable})` / `finalizeTabs({keep})` may release tab control, but the tab returns only to
  the original session's user-tab set.
- `closeSession()` may keep user-visible views but must clear controllable state for that scope; other
  sessions must not enumerate or claim these views. The same sessionId may later rediscover its own
  non-empty user tabs.
- `closeSession({ closeTabs: true })` really closes all tabs under that session: still-controlled ones and
  those previously released back to the session's user-tab set by finalize/deliverable. Other sessions'
  tabs are unaffected. It is only for sessions that never come back to claim: a dwf subagent's sessionId
  is no conversation, so a kept view would be invisible and unclaimable and would hold a guest forever
  (`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`, "Subagent sessions").
- Window close / explicit user close still really closes the tab.

### 2.4 Visibility and background keep-alive on conversation switch

The renderer registries of normal Browser tabs and browser-use tabs must not be bound to the current
active session. Switching task alone does not unload a guest immediately; a guest that becomes eligible
background after the switch may be suspended by the window residency budget. User switches from Session A
(has Browser/browser-use tabs) to Session B (none), then back to A:

```text
A active:registry[A] + mounted webview[A] + side pane expanded
  -> switch B
B active:registry[A] + live-background webview[A] + side pane collapsed
  -> optional budget suspend
B active:registry[A] + suspended shell[A] + side pane collapsed
  -> switch A
A active:resolve active tab from registry[A] + ensureResident[A] + side pane expanded
```

- Switching to B only changes the visible scope. It must not delete A's tabs from the workspace-level
  side-pane registry, and the switch event itself does not unload A's `<webview>`; the background guest
  first keeps page, CDP and in-process state.
- If the owning BrowserWindow has more than 32 live-detached guests, the residency coordinator may suspend
  A's guest when protection rules allow; suspension unloads only page resources, while the stable tabId,
  ownership and shell stay.
- When B has no visible tab of its own, the side pane must collapse; it must not show A's tab or an empty
  tab strip.
- Switching back to A, if A still has visible tabs of its own, selects A's preferred/current/latest tab and
  actively expands; a suspended tab must be lazily restored first and must not inherit B's
  `collapsed=true`.
- If the user manually collapsed the panel inside A, leaving and returning still restores by "current
  conversation has a tab -> expand"; only explicitly closing the tab ends that tab's restore eligibility.
- Plain Web / mobile `/remote` do not support the Electron embedded browser-use pane; this rule adds no
  mobile snapshot field and does not change the `web-remote-replayable` recovery boundary.

## 3. Protocol and layering

- The `packages/shared` platform channel adds an optional `sessionId` to `BrowserViewAttachGuest`,
  keeping old renderer wire compatibility.
- `packages/ui` reports tab ownership only through `IPlatformService.browserViewAttachGuest`, without
  touching Repo/main directly.
- `packages/desktop` main binds `windowId` from the sender and hands the renderer-provided `workspaceKey +
  sessionId` to `BrowserGuestManager`; the renderer cannot forge windowId.
- The ZCode protocol agent stdio BrowserCommand is unchanged; no main/relay business state is added;
  desktop `continuous` and mobile `replayable` message flows are unchanged.
- Mobile Web has no Electron `<webview>` attach; the existing fallback stays and no browser runtime is
  added.

## 4. Acceptance cases

| Case    | Setup                                                           | Action                                         | Assertion                                                                  |
| ------- | --------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| BCP-176 | session A, B in the same window/workspace; A has a non-empty human tab | B calls `user.openTabs()`                | returns `[]`                                                               |
| BCP-177 | session A has a non-empty human tab                             | A calls `user.openTabs()`                      | returns A's tab, claimable                                                 |
| BCP-178 | after A claims, then turn end / deliverable / closeSession      | B calls `user.openTabs()`                      | B never sees it; A still sees the non-empty tab on resume                  |
| BCP-179 | A has human tabs with URL `""`, `about:blank`, https            | A calls `user.openTabs()`                      | only the https tab                                                         |
| BCP-180 | A calls `tabs.new()`, guest currently `about:blank`             | A calls `tabs.list()`                          | still returns the controlled tab                                           |
| BCP-181 | old renderer attach lacks sessionId                             | any session calls `user.openTabs()`            | old tab not claimable; no cross-conversation leak                          |
| BCP-182 | same path, different workspaceIdentity/session                  | enumerate on both sides                        | no workspace or session mix                                                |
| BCP-206 | A has a mounted Browser/browser-use tab; B has none             | switch A -> B -> A without budget pressure     | A's webview stays mounted; B collapses; switching back reselects the original tab and actively expands |
| BCP-217 | A's background guest suspended by the window budget             | switch back to A                               | stable tabId/shell unchanged; new guest restored and shown; B's state does not leak |

## 5. Done criteria

- Trajectory symptom, code root cause and frozen semantics agree.
- Session ownership flows end to end through the shared channel, preload/platform, React view and desktop
  manager.
- Manager unit tests cover cross-session, lifecycle release and blank filtering; UI/IPC unit tests cover
  sessionId reporting.
- Run related targeted tests, `pnpm typecheck`, `pnpm lint`.
- Real desktop regression verifies at least: A/B conversations each open tabs and are invisible to each
  other after switching; blank human tabs do not enter `openTabs()`; after the original conversation
  resumes, its own non-empty tabs are still claimable; with A -> tab-less B -> A, A's webview is not
  destroyed and the side pane auto-expands.

## 6. Delivered state and open verification

Implemented:

- `BrowserViewAttachGuest` carries `sessionId` from the UI tab itself to desktop main; main still binds the
  trusted `windowId` from the IPC sender and rejects late cross-session attach for the same tabId.
- `BrowserGuestManager` human-tab claim compares session; release/closeSession keep the owner session and
  switch to a separate unclaimed browser scope so `tabs.list()` and `user.openTabs()` are not confused.
- `user.openTabs()` filters empty URL and exact `about:blank`; controlled `tabs.list()` is unchanged.
- An old renderer without `sessionId` fails closed: the view may stay but cannot be enumerated or claimed
  by agents.

Guest recovery decisions (clarification record):

| Round         | Question                                                    | User answer                                                      | Fixed boundary                                                                                                     |
| ------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1             | Should a history conversation's browser tab be released on switch | "Keep in the background even when switching conversations" | normal switches keep the same guest, no refresh/rebuild                                                            |
| 2             | How to handle a guest killed abnormally by Chromium         | after the "last URL + stable tabId in-place recovery" proposal, the user asked for the change | replace only the failed guest; explicit close is not recovered; no cross-process-restart persistence |
| 3 (2026-07-31) | Introduce budget suspension and cross-restart recovery for background tabs | confirmed                                              | task switching itself still does not unload; beyond 32 live-detached per window, protection/LRU suspension is allowed, plus cross-restart page-state recovery |

Round 3 supersedes "always the same guest" and "no cross-process recovery" from rounds 1-2 but does not
change conversation/workspace isolation.

Runtime evidence (2026-07-23): A -> B -> A within the same `workspaceKey` keeps the real Electron
`<webview>` attached with unchanged `webContentsId`, node identity and URL (no recovery branch entered).
After forcing a guest crash with CDP `Page.crash`, the renderer captured `reason=crashed`, replaced only
the failed node, the new guest restored the original `data:` test URL and main logged the same browser tab
key re-attached with `cdp=true`. Discovered during validation: when the old guest was already destroyed,
the download listener `removeListener` threw `Object has been destroyed` and blocked the new guest attach;
`BrowserGuestManager.detachGuest` now treats that cleanup as best-effort and continues unbinding/rebinding.
Switching across `workspaceIdentity` still obeys workspace isolation and does not promise reuse of the same
guest; returning to the original workspace restores from the latest URL, so one workspace's live guest is
never leaked to another.

Open real-machine verification:

- Restart desktop on the current main/preload/renderer build and smoke tab visibility and claim across two
  real conversations.
- Real shared-host attachment regression for SSH/WSL/Docker with the same path and different
  `workspaceIdentity`.
- Mobile Web has no Electron `<webview>` attach and no runtime was added; confirm no regression of the
  existing `web-remote-replayable` path in remote-control regression.
