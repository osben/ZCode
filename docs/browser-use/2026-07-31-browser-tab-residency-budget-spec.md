# Browser Tab 32 Hard Limit and Process Lifetime Spec

> Status: revised 2026-08-05 per the user's measurement of production behavior and product ruling.
>
> Alignment baseline: the currently released production build does not restore Browser Tabs after a
> complete quit.
>
> This is the source of truth for the current resource lifetime of Browser / Browser Use tabs. It replaces
> the earlier "cross-restart shell catalog, page-state, suspended/restoring lazy recovery" design.

Current product boundary: **each BrowserWindow keeps at most 32 logical Browser / Browser Use tabs. When
the 33rd is created, the least recently active safe candidate is fully closed and disappears from the UI.
After the ZCode process fully quits, no Browser Tab is persisted or restored.**

## 1. Feature Summary

| Field            | Value                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | Keep the per-window 32 logical Tab hard limit and remove cross-app-restart recovery                                                          |
| Capability       | Desktop embedded Browser logical tab lifetime                                                                                                |
| Change layer     | persistence / recovery / commit-effect                                                                                                       |
| Primary seeds    | `BrowserGuestManager`, `useAppPanels`, `AnimatedSidePanePanel`, Desktop main wiring                                                          |
| Out of scope     | in-process multi-turn reuse, in-place recovery of guest renderer abnormal exit, Browser command, mobile replayable, remote workspace runtime |

### 1.1 Fixed product constants

| Item                       | Value                  | Semantics                                                                                                |
| -------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| Logical Browser tabs       | `32` per BrowserWindow | normal Browser and Browser Use counted together; beyond the limit fully closed from UI and main registry |
| Cross-restart Browser tabs | `0`                    | after a complete quit the new process starts from an empty Browser Tab set                               |

The old Browser Tab page-state product capacity (100 pages, 64 MiB, 500 history) no longer exists; those
values belonged to the retired recovery repository.

## 2. Impact brief

### 2.1 Surfaces

| Scenario                                           | Shared implementation                              | Owner / commit                                                                | Persistence                                                    | Isolated from                                                        |
| -------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| Open/switch normal Browser (Side Pane Browser tab) | `UnifiedBrowserView`                               | renderer side-pane registry; attach/report/close                              | current Electron process memory, not on disk                   | mobile replayable, other workspace/session                           |
| Agent operates Browser Use (Browser Use side pane) | `BrowserUseSidePaneContent` + `UnifiedBrowserView` | renderer shell + main `BrowserGuestManager`; Browser command / attach / close | current Electron process memory, not on disk                   | relay, Host task snapshot, independent mobile runtime                |
| Create the 33rd Tab (tab strip)                    | residency coordinator                              | main logical catalog; `closeTabDurably()`                                     | UI/main/guest deleted together; no cross-restart repository    | protection leases for current operation, screenshot, download, media |
| Complete quit then start (Desktop lifecycle)       | `prepareAppQuit` + renderer bootstrap              | new process empty registry; no Browser Tab restore executed                   | no Browser Tab recovery file authority; dev/packaged identical | conversation/task cold resume                                        |

Shared vs different: the 32 cap is shared by Browser and Browser Use (protection signals are aggregated
by each runtime state, and neither type may bypass the total). In-process, stable logical tabId and live
guest are kept (a guest crash may replace the webContentsId); removing cross-restart recovery must not
break in-process continuity. A complete restart restores neither type of tab, while conversation/task
data still cold-resume by their own rules, so Browser UI state must not mix into task recovery. Mobile
remote creates no independent Browser runtime, keeps using the current desktop process via shared-host
attachment, and desktop tab persistence semantics must not spread to the replayable snapshot.

### 2.2 Relationships

- Browser tab hard limit closes through `BrowserGuestManager`: the 33rd tab must close a full logical tab
  (manager/coordinator tests).
- Desktop bootstrap must not call Browser Tab restore: the new process must get an empty Tab strip
  (`useAppPanels` + Electron E2E).
- Desktop main wiring must not inject a persistent recovery store: no runtime writing of recoverable
  shell/pageState (main wiring + userData evidence).
- App shutdown releases live guests: a normal quit waits only on existing business resources and saves no
  Browser Tab (`prepareAppQuit`).
- Invariants: guest crash recovery stays in-process (mounted guest abnormal exit still recovers in place;
  `UnifiedBrowserView` tests); mobile remote stays isolated from Browser Tab lifecycle (no task
  snapshot/runtime fields).

### 2.3 State owners and commit sinks

| State/fact                | Display owner                         | Authoritative owner              | Commit                 | Persistence      |
| ------------------------- | ------------------------------------- | -------------------------------- | ---------------------- | ---------------- |
| current Tab strip         | renderer workspace side-pane registry | renderer + main logical catalog  | open/close/limit close | in-process only  |
| live guest/CDP            | `UnifiedBrowserView`                  | `BrowserGuestManager`            | attach/detach/close    | not persisted    |
| 32 cap and LRU            | no independent UI                     | `BrowserTabResidencyCoordinator` | `closeTabForLimit`     | in-process only  |
| Browser Tab restart state | none                                  | none                             | no restore command     | no recovery file |

### 2.4 Must-preserve invariants

- `workspaceKey = workspaceIdentity?.trim() || workspacePath`; remote tabs keep carrying `remoteSessionId`.
- Logical tabs of Desktop local and remote workspaces share the same limit of the owning BrowserWindow, but
  content and command scopes are invisible to each other.
- While selected/visible, in a Browser operation, screenshot/capture, audio/media, loading or download, a
  tab must not be auto-closed.
- In-process `finalize({ keep })`, turn switch and session switch do not implicitly close unlisted tabs.
- In-place recovery of guest renderer killed/crashed/oom/memory-eviction stays; it is not app-restart
  recovery.
- Mobile `/remote` adds no Browser runtime, Browser Tab snapshot or replayable recovery field.
- Dev and packaged Desktop have the same "no cross-restart recovery" semantics; data directory differences
  must not change behavior.

### 2.5 Code evidence and graph delta

No codegraph tool was available; feature graph seeds and `rg` call-site tracing were used:
`BrowserGuestManager` (main wiring -> attach/report/close; hard limit and runtime owner),
`browserViewRestoreTabs` (UI effect -> platform -> IPC -> manager; the cross-restart entry that must be
removed from renderer bootstrap), `BrowserTabRecoveryStore` (Desktop main constructor injection; the
persistence sink that must stop being wired), `AnimatedSidePanePanel` (side-pane registry -> Browser
surface; UI consumer of the 33rd Tab close).

Graph delta: the old label of `capability.browser-tab-residency` bound "32 cap" and "cross-restart
recovery" and becomes a pure in-process hard limit; `persistence.browser-tab-recovery-store` becomes a
legacy/disabled node no longer connected to runtime services; a semantic edge is added that local
development and packaged desktop share the same "no tab restore" boundary.

No unresolved questions: the user ruled that after fully closing ZCode and starting again all Browser Tabs
should be gone.

## 3. State model

```text
Electron process N
  logical tab lifecycle: active | handoff | deliverable | closed
  guest residency: live-visible | live-background | transient-replacing

              complete app quit
                      |
                      v
              all Browser tabs end
                      |
                      v
Electron process N+1: empty Browser tab registry
```

- `closed` is the in-process terminal state: delete the tab shell, guest/CDP/listener and main registry.
- A limit victim goes directly to `closed`, never to suspended.
- App quit ends all Browser Tabs; the new process does not rebuild logical tab, stable tabId, URL, title,
  favicon or history.
- `transient-replacing` only describes replacement after a guest renderer abnormal exit within the same
  process, not persisted and not cross-process.
- `suspended/restoring/residencyGeneration` are no longer reachable product restart states; retained
  compatibility types must not be triggered by Desktop wiring.

## 4. 32 logical tab hard limit

Computed independently per BrowserWindow:

```text
logicalTab(tab) = tab.lifecycle != closed
overLimit = count(logical tabs in BrowserWindow) > 32
```

- Normal Browser and Browser Use use the same window limit.
- local and remote workspaces share only the physical window count, not tab content, commands or scope.
- A short-lived crash replacement without a guest is still the same logical tab and cannot bypass counting.
- Closed/tombstoned tabs do not count; a late attach must not revive a tab closed by the limit.

## 5. Protection set and close order

Any of these makes a tab non-closable by the limit: currently selected/actually shown, Browser Use
operation, screenshot/capture, sound or media, loading, download. If all excess tabs are protected the
count may temporarily exceed 32 and is re-evaluated automatically when protection is released.

Safe candidates are chosen in this order:

```text
earliest lastActivityAt -> earliest lastSelectedAt -> earliest openedAt -> tabId lexicographic
```

`preferred/main/currentTask` get no extra 30-minute protection; the least recently active safe candidate
is closed first.

## 6. Limit-close transaction

```text
BrowserTabResidencyCoordinator      BrowserGuestManager       renderer
             |                              |                       |
             | choose oldest safe victim    |                       |
             |----------------------------->| close guest/CDP        |
             |                              | remove main registry   |
             |                              |---------------------->| close tab shell
```

1. Limit close reuses the single close authority; destroying only the WebContents is not allowed.
2. After closing guest/CDP/listener and removing from the main registry, send close directed to the owner
   BrowserWindow.
3. The renderer deletes the corresponding tab trigger with the existing reducer and syncs active/collapsed
   UI.
4. Auto close follows window/workspace/session/remoteSessionId authority and is not broadcast to other
   scopes.
5. Lifecycle logs go through `debug` and record `reason=tab-limit`.

## 7. App quit and next launch

```text
complete quit
  -> release/kill all live Browser guests
  -> do not persist shell/pageState
  -> next process does not request browserViewRestoreTabs
  -> Browser tab strip starts empty
```

- Normal quit, Cmd+Q, Windows quit and update-install quit all save no Browser Tab.
- A `browser-tab-recovery.json` left by old development builds is no longer authoritative data; the current
  runtime must neither read nor append to it.
- Renderer reload, window destruction and complete app quit cannot revive Browser Tabs via a recovery
  catalog.
- Conversation/task SQLite/session cold resume is fully independent of the Browser Tab lifecycle.
- In-process workspace/task switches keep tabs per the existing registry; only the end of the whole
  process/window lifecycle clears them.

## 8. IPC and layering boundary

Capabilities still in use:

| Direction        | Capability                   | Purpose                                                      |
| ---------------- | ---------------------------- | ------------------------------------------------------------ |
| renderer -> main | `browserViewCloseTab`        | explicit user close                                          |
| main -> renderer | `onBrowserViewCloseTab`      | delete the tab shell after user/Agent/limit close            |
| renderer -> main | `browserViewReportResidency` | selected/visible/protection state with trusted sender window |
| renderer -> main | `browserViewAttachGuest`     | live guest attach and late-event protection                  |

`browserViewRestoreTabs`, `onBrowserViewSuspend`, `onBrowserViewRestore` and the recovery generation are
legacy compatibility; Desktop bootstrap/main production wiring neither calls them nor injects a
persistent store. The Agent stdio BrowserCommand needs no change.

## 9. Case planning and pruning

### 9.1 Boundary decisions

| Boundary             | Decision                              | Includes                              | Excludes / prunes                                    | Source                                               |
| -------------------- | ------------------------------------- | ------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| 33rd Tab             | fully close the oldest safe candidate | Browser + Browser Use                 | suspend shell, 30-minute protection                  | user ruling + runtime feedback                       |
| complete app restart | all Browser Tabs disappear            | dev + packaged, local + remote tab UI | shell/pageState/history recovery                     | user production measurement and explicit instruction |
| in-process switching | keep live tabs                        | task/workspace/session switch         | cross-process stable tabId                           | existing BTL01-03                                    |
| guest crash          | replace in place                      | recoverable renderer exit             | replacement after app quit                           | BCP-207                                              |
| mobile remote        | no new state                          | shared-host attachment                | independent runtime, replayable Browser Tab snapshot | architecture constraints                             |

### 9.2 Accepted cases

| Case     | Setup / event                                                              | Assertions                                                                                  | Status   |
| -------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| BTL01-03 | multi-turn / two-session multi-tab without budget pressure                 | in-process stable tab, guest and scope continuous                                           | accepted |
| BTL04    | 32 logical tabs exist, create the 33rd                                     | oldest safe candidate fully disappears from DOM, main registry and guest; total back to 32  | accepted |
| BTL05    | all excess candidates have runtime protection                              | temporarily over the limit; after protection releases the oldest safe candidate auto-closes | accepted |
| BTL10    | local/remote and different workspace identities share a window             | share the physical limit but scope/commands do not cross                                    | accepted |
| BTL11    | user closes a live tab                                                     | UI/main/guest fully closed; a late attach does not revive it                                | accepted |
| BTL12    | several Browser / Browser Use tabs before a complete quit                  | next process: Browser tab strip, main registry and webview all 0                            | accepted |
| BTL19    | remote tab visibility/attach/list/claim                                    | `remoteSessionId` not lost; cross-remote scope fails closed                                 | accepted |
| BTL20    | current-process catalog has a logical tab temporarily without a live guest | still counts toward the 32 cap and can be fully closed as the oldest safe candidate         | accepted |

### 9.3 Retired / pruned cases

- BTL06-09, BTL13-18, BTL21-23 depended on suspended, pageState, shell catalog, recovery repository or the
  recovery deletion barrier and retire with cross-restart recovery.
- No Browser/Browser Use x every quit-path permutation; one real full-process restart E2E represents, and
  quit strategies are guaranteed by focused tests.
- No local/SSH/WSL/Docker x restart permutation; "no Browser Tab is persisted" is the uniform invariant.
- Mobile replayable is not combined with Desktop Browser Tab cold recovery, because mobile has no
  independent Browser runtime.

Planning handoff: case catalog `docs/conversation-session-case-catalog.md` BTL; conversation + Browser Use
coverage matrices; `zcode-feature-graph.yaml`; E2E `browser-tab-residency.test.ts`.

## 10. Done criteria

- Each BrowserWindow's total of logical Browser / Browser Use tabs normally does not exceed 32.
- After the 33rd tab appears, the oldest safe candidate is fully closed from UI, main registry and
  WebContents.
- With all tabs runtime-protected a temporary overflow is allowed, and it converges again without user
  action once protection releases.
- After a complete quit and restart, the Browser tab strip, main logical list and live guests are all 0.
- Desktop main does not wire a persistent Browser Tab recovery store; renderer bootstrap does not request
  shell restore.
- In-process multi-turn/session switching and recoverable guest crash do not regress.
- workspaceIdentity, remoteSessionId, session, window and clientMode boundaries do not regress.
- desktop continuous does not absorb mobile replayable state; relay/Host/task snapshot gain no Browser Tab
  state.
- `pnpm typecheck`, `pnpm lint`, focused unit tests and the real Electron 33-Tab + restart E2E pass.
