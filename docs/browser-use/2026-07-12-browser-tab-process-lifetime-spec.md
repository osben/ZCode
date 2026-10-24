# Browser Tab in-process default-persistent lifecycle spec

> Status: product lifecycle semantics confirmed; the 32-logical-tab hard cap and cross-restart recovery of `2026-07-31-browser-tab-residency-budget-spec.md` replace this document's original boundary "always live / no cross-restart / explicit close only".
>
> Background trace: in `model-io-sess_3b29b7bb-c7b3-406f-8460-5462b4ce3d3a.jsonl`, the first-turn Turing community page was implicitly kept as a handoff, while the second-turn Baidu page was auto-closed at `turnEnded` because a handoff already existed. That difference was not a model or user close; it was a data-loss lifecycle defect of the old "keep only one fallback tab" policy.

## Change summary

| Field              | Decision                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Change             | IAB tabs change from "turn-temporary resources, explicit keep" to "ZCode in-process persistent resources, explicit close"                    |
| User-visible entry | browser-use tabs created by agent `browser.tabs.new()`; user-opened tabs claimed by the agent                                                |
| State owner        | `BrowserGuestManager` in Electron main manages control; the residency coordinator manages the logical cap; the renderer keeps the tab shell  |
| Close authority    | model explicit `tab.close()`; manual user close; LRU auto-close beyond 32 logical tabs per window; workspace clear; recovery orphan fallback |
| Out of scope       | adaptive renderer budget; persistence of the unimplemented extension/CDP backends                                                            |

## Confirmed decisions

| Round                              | Question                                                       | User confirmation                             | Fixed boundary                                                                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                                  | Should keeping a tab depend on the model writing lifecycle JS? | No; keep by default                           | `turnEnded` must not auto-close tabs                                                                                                                                          |
| 2                                  | May tabs not listed in `finalize({ keep })` be closed?         | No; without an active close they must be kept | `keep` omission has no delete semantics                                                                                                                                       |
| 3                                  | Does "keep by default" span ZCode restarts?                    | Only during the current ZCode process         | `closeWindow`/process exit may reclaim; no persistence recovery added                                                                                                         |
| 4 (2026-07-31, revised 2026-08-05) | Introduce cross-process Tab recovery and a logical tab cap?    | Yes, revised by run feedback                  | Tab shells recover across processes; at most 32 logical tabs per window, the oldest safe candidate is fully closed beyond the cap; snapshots 100 pages / 64 MiB / 500 history |

Round 4 is a new product decision that replaces round 3's "no persistence recovery"; the detailed state machine is in the residency spec.

## Boundary decisions

| Boundary                  | Decision                                                                                         | Forbidden                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `tabs.new()`              | After creation, visible and controllable by default                                              | Closing because a turn finished, errored, or the model forgot finalize |
| `turnEnded`               | Only cancels that turn's pending requests; keeps all tabs                                        | Choosing a "final active page" and closing other tabs                  |
| `tabs.finalize({ keep })` | Applies `handoff`/`deliverable` marks only to tabs in `keep`                                     | Interpreting "not in `keep`" as close                                  |
| `markHandoff()`           | Explicitly marks continued control across turns; does not affect other tabs                      | Turning other active tabs into temporary pages                         |
| `markDeliverable()`       | At turn end releases the tab to the original conversation but keeps it visible                   | Closing the tab or other tabs, or publishing to other conversations    |
| `closeSession`            | Cancels pending requests, releases tabs to the original conversation, keeps webviews visible     | Closing tabs, or making them claimable across conversations            |
| `tab.close()`             | The model explicitly closes one tab                                                              | Spreading to other tabs of the same scope                              |
| User closes a tab         | Treated as an active user close; the matching snapshot is deleted                                | Re-creating a closed tab automatically                                 |
| Window/process exit       | Reclaims only live guests; keeps logical tabs that meet persistence conditions                   | Interpreting it as the user closing tabs one by one                    |
| 33rd logical tab          | LRU fully closes the oldest safe candidate, deleting recovery facts and the renderer tab shell   | Destroying only the guest and keeping a suspended tab shell            |
| forced restore orphan     | When shell/page-state/restoreUrl are all missing, close the unrecoverable orphan shell by target | Using it for ordinary snapshot eviction; forming a restore/close loop  |
| ZCode exit                | Reclaims live guests; restores logical tab shells from the page-state repository                 | Mounting all historical guests at once                                 |

## Domain scope and high-risk cross-products

The main domain is browser tool lifecycle, desktop main guest ownership and renderer side-pane visibility. High-risk combinations:

- multi-tab x multi-turn: with a handoff already present, a new active tab must still be kept.
- finalize keep subset x unlisted tabs: unlisted tabs keep their state.
- session close x agent-created/claimed user tab: both are released rather than closed and stay bound to the original session ownership.
- desktop-continuous x web-remote-replayable: IAB state is still held by the shared desktop host; the delivery mode cannot change close semantics.
- window/process lifecycle x session lifecycle: window close/process exit may reclaim; that rule must not be applied early to turn/session.
- logical tab x live guest: below the cap, stable tab identity is kept by default; lazy cross-restart recovery allows the guest renderer and `webContentsId` to change; closing beyond the cap deletes the logical tab too.

## Concept map and state owners

| Concept                                           | Owner                                         | Evidence                                                                                      |
| ------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| tab guest, CDP attachment, lifecycle, scope       | `BrowserGuestManager`                         | `packages/desktop/src/main/browserView/browserGuestManager.ts`                                |
| logical tab cap, protection lease, recovery state | `BrowserTabResidencyCoordinator`              | `packages/desktop/src/main/browserView/browserTabResidencyCoordinator.ts`                     |
| visible tab webview and user close action         | renderer side pane                            | `packages/ui/src/hooks/useAppPanels.ts`, `packages/ui/src/browser-use/UnifiedBrowserView.tsx` |
| turn/session lifecycle notification               | ZCode agent runtime -> browser control broker | `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts`, `agent-runtime.ts`                |
| model API and guidance                            | browser-use plugin API/docs/skill             | `apps/zcode-cli/packages/browser-use-plugin`                                                  |
| process exit                                      | Electron main/window lifecycle                | `packages/desktop/src/main/index.ts`                                                          |

## Cases

| Case    | Initial state                | Event                     | Expected effect                                                             | Class                                                        |
| ------- | ---------------------------- | ------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| BTL-001 | two unmarked agent tabs      | `turnEnded`               | both tabs stay controlled/visible                                           | accepted; old implementation bug-candidate                   |
| BTL-002 | one handoff + one active     | `turnEnded`               | both tabs kept, lifecycle not implicitly rewritten                          | accepted; main trajectory-regression case                    |
| BTL-003 | multiple tabs                | `finalize({keep:[A]})`    | A gets the declared state, B keeps its state                                | accepted; old implementation bug-candidate                   |
| BTL-004 | agent tab + claimed user tab | `closeSession`            | both released as user tabs of the original session, no renderer close       | accepted; global unclaimed was a bug-candidate               |
| BTL-005 | any open tab                 | model `tab.close()`       | only the target tab closes and leaves a tombstone                           | accepted                                                     |
| BTL-006 | any open tab                 | user closes the tab       | webview destroyed, tab no longer controllable and not rebuilt automatically | accepted                                                     |
| BTL-007 | any open tabs                | window close / ZCode exit | live guests reclaimed; recoverable logical tabs kept                        | accepted; new decision 2026-07-31                            |
| BTL-008 | previous process had tabs    | new process starts        | tab shells restored; the current/visited tab lazily restores its guest      | accepted; the 2026-07-31 decision replaces the old exclusion |
| BTL-009 | create the 33rd logical tab  | residency cap evaluation  | by protection set and LRU fully close the oldest safe candidate             | accepted; see the residency spec                             |

## Assertions and evidence

| Case        | Setup / action                            | Assertions                                                                                                                   | Evidence                                    |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| BTL-001/002 | create several tabs then send `turnEnded` | close callback count 0; `tabs.list()` returns all tabs                                                                       | manager unit test + response meta           |
| BTL-003     | finalize lists only some tabs             | unlisted tabs stay in `tabs.list()`; deliverable enters only the owner session's `user.openTabs()`                           | manager unit test                           |
| BTL-004     | send `closeSession` after both tab kinds  | close callback 0; owner controlled list empty and user list contains all; other sessions' user list empty                    | manager unit test                           |
| BTL-005     | explicit `close`                          | only the target tab's close callback fires; late attach rejected                                                             | existing manager unit test                  |
| BTL-007     | window close / manager dispose            | live guests cleaned; explicitly closed tabs are not restored                                                                 | lifecycle unit                              |
| BTL-008     | restart                                   | stable tabId/shell kept; guest replaceable; snapshot/URL restored per the new spec                                           | repository + manager + Electron restart E2E |
| BTL-009     | open the 33rd logical tab                 | the oldest safe candidate disappears from DOM, main registry, guest and recovery repository together; not revived on restart | manager + Electron 33-tab E2E               |

## Coverage and E2E handoff

- Update BCP-044/046/047/049/052 in `docs/testing/browser-use-codex-parity-coverage-matrix.md`.
- turn/session lifecycle stays covered by `BrowserGuestManager` unit tests; residency adds pure policy, repository, manager/UI unit tests and a real Electron 33+ tab E2E.
- The real UI E2E keeps reproducing "Turing community -> turn done -> Baidu -> turn done"; below the cap both original guests exist; the 33rd-logical-tab E2E asserts that the oldest tab shell, guest and recovery facts are all fully closed.
- Desktop continuous and phone replayable share the desktop IAB manager; no task/session state is added to relay/main.

## `finalize({ keep })` semantics

`tabs.finalize({ keep })` has no semantics of cleaning unlisted temporary tabs. This spec keeps only the product semantics "no auto-close within the process"; released tabs must still be isolated per conversation, see `docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md`. The API shape is unchanged: in ZCode IAB omission has no delete semantics. All model prompts, API semantics, implementation and tests must state this together; wording like "unlisted means cleaned" that lures the model into deciding page survival is forbidden.
