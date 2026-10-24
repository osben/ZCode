# Desktop IAB Browser Use E2E Spec

> Date: 2026-07-19
> Status: product boundary confirmed; first automation batch is in `manual-review/pending`.
> Related: `docs/testing/browser-use-codex-parity-coverage-matrix.md`,
> `docs/conversation-session-case-catalog.md`,
> `docs/testing/conversation-session-e2e-coverage-matrix.md`.

## Feature Summary

| Field                 | Value                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change                | Add repeatable Electron WDIO E2E for Desktop local IAB Browser Use; unit tests or one-off manual smoke no longer count as formal E2E                            |
| User-visible surfaces | conversation, Browser/browser-use side pane, real `<webview>` guest, Node REPL images and turn-tail screenshot, free-size viewport                              |
| Existing owners       | CLI runtime/browser-client, host/main BrowserControl, `BrowserGuestManager`, renderer side pane, conversation projection                                        |
| First batch           | local Desktop `desktop-continuous` + IAB; provider uses case-local deterministic replay; visual assertions are mainly geometry/CDP metrics                      |
| Deferred              | SSH/WSL/Docker, formal mobile replayable recovery, Windows UAC/App-Bound on real machines, extension positive path, Browser safety confirmation not yet closed  |

## Clarification Log

| Round | Question | User answer | Boundary fixed |
| --- | --- | --- | --- |
| 1 | Limit the first batch to local Desktop IAB? | proceed as suggested | Desktop IAB is the formal target; remote and mobile only register gaps |
| 1 | Allow synthetic provider replay to drive the real `mcp__node_repl__js`? | proceed as suggested | replay only fixes model choice; Browser commands still go through real host/main/webview/CDP |
| 1 | Pixel diff or geometry/CDP metrics for visual evidence? | proceed as suggested | geometry, guest metrics, PNG size first; few screenshots as review evidence |
| 1 | Is Windows native import a hard gate this round? | proceed as suggested | protocol/unit stay; signed Chrome, UAC and service cleanup go to a later Windows-specific gate |
| 1 | Make unimplemented safety confirmation / deny anti-bypass a formal assertion? | proceed as suggested | stay undefined/deferred; do not guess product semantics from the current implementation |
| 2 | Add "multiple sessions chatting and operating several tabs at once"? | user explicitly asked | two running sessions A/B of the same workspace, two IAB tabs each; verify permissions, provider continuation, tab/guest/page state and side pane isolation |
| 2 | Add the subagent Browser Use boundary? | user explicitly asked; changed 2026-10-09 to "subagents may use it" | foreground built-in child can use ordinary Node REPL and Browser, shares tabs with the conversation, new tabs are visible in the panel and kept after it ends; after returning to the main Agent the original binding keeps working |
| 2 | Which concurrent permission order is representative? | prune by high-risk state combinations | approve foreground B first, then switch back and approve A; no permutation of 3+ sessions/tabs, deny/allowAlways, or all subagent methods |

## Domain Scope And State Owners

```text
case-local provider replay
  -> V4 conversation send
  -> mcp__node_repl__js
  -> browser-client / BrowserControlPort
  -> host process
  -> Electron main BrowserGuestManager
  -> renderer <webview> ready/attach
  -> guest CDP / trusted input / screenshot
  -> tool result + response meta
  -> conversation projection
  -> turn-tail screenshot before normal completion
  -> TurnComplete
```

| State / fact                          | Authority                              | E2E evidence                                                              |
| ------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| Browser API and REPL binding          | CLI runtime + browser-client           | provider request, tool result, structured error                           |
| tab scope, selected, pending command, generation | `BrowserGuestManager`       | main-side guest registry, command result, real guest URL                  |
| tab visibility and background mount   | renderer side-pane registry            | DOM test id, webContentsId, page JS state before/after switching          |
| viewport, DPR, screenshot backpressure | guest CDP + main manager              | `innerWidth/innerHeight/devicePixelRatio`, PNG dimensions, capture count  |
| conversation image facts              | CLI event log/projection               | live UI, cold hydration, row source/order/count                           |

## Dimensions And Equivalence Classes

| Dimension  | Included values                                                                                                                     | Pruned/deferred values                                           | Reason                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Backend    | IAB; existing CLI managed CDP smoke as a separate representative                                                                   | extension positive actions                                       | extension is unimplemented; a stub cannot prove availability                                        |
| Client     | Desktop local `desktop-continuous`                                                                                                  | formal mobile `web-remote-replayable` recovery                   | mobile creates no Browser runtime/pane; later only verify recovery through shared-host              |
| Session    | two simultaneously running sessions of one workspace, two tabs each; background session; one session over two turns                | 3+ sessions/tabs and full lifecycle Cartesian product           | 2 x 2 already crosses conversation, interaction, broker, renderer and guest ownership boundaries    |
| Tab        | agent-created, two tabs, background keep-alive, stable id across turns                                                              | human claimed, blank, closed/stale re-entry, restart recovery   | product promises only in-process tab persistence; human/blank/stale go to separate lifecycle cases  |
| API        | `tabs.new/list/get/finalize`, `tab.close/goto`, `domSnapshot`, locator `count/fill/click`, CUA `type`, `screenshot`                | `press`, dialog, remaining methods x OS                         | representatives per input, pointer, visual and lifecycle equivalence class                          |
| Viewport   | normal/free, Fit/50%, zoom `0/+2/-2`, bounds/out of range                                                                           | UA/touch/network/device emulation                               | only the CSS viewport is defined now                                                                |
| Completion | normal, conversation image cold restore                                                                                             | stop/failure, over budget, two consecutive turns, every failure code | first batch guards the normal-completion two-image fact; negative terminal states stay in the BTA gap |
| Security   | replay dynamic URL accepts only loopback and fails closed; subagent Browser Use shares tabs with the conversation                   | URL scheme product rejection, payment/delete/upload/secret confirmation and cross-API deny | subagent tab ownership (parent session) confirmed; Browser safety product implementation not closed |

## Candidate Decisions

| ID | Setup / action | Expected assertions | Status |
| --- | --- | --- | --- |
| BU-E2E-001 | A has a loaded Browser/browser-use tab; switch to tab-less B, then back to A | B collapses; A guest always mounted; webContentsId, URL, history/JS state unchanged; switching back actively expands | accepted |
| BU-E2E-002 | replay makes the model run `tabs.new -> goto local fixture -> domSnapshot -> locator fill/click/press -> screenshot` | real IAB pane activates; trusted input changes the guest; tool/meta correct; screenshot is a non-empty PNG | accepted |
| BU-E2E-003 | one session, two tabs across two turns, run `turnEnded` and `finalize({keep:[A]})`, then `list -> get(B)` | A/B both kept; unlisted tabs not closed; get(B) activates both manager and UI; explicit close closes only the target | accepted |
| BU-E2E-004 | A/B same workspace, A owns a human tab; mixed blank human tab and agent-created blank | B `user.openTabs=[]` and cannot claim; A can still resume; human blank filtered, agent blank still in `tabs.list` | accepted |
| BU-E2E-005 | focus a page input, force the host Composer to steal focus, then locator fill and CUA/DOM CUA type | text goes only into the guest, Composer stays empty; focus-token drift fails closed | accepted |
| BU-E2E-006 | animated/hidden-duplicate/overlay/iframe/navigation-race page fill/click | fill does not wait for click stable/hit-target; unique-visible succeeds; real ambiguity returns candidates; failure leaks no AbortError, TypeError or `undefined.count` | accepted |
| BU-E2E-007 | Agent new/show/activate/set/reset viewport triggers multi-frame layout; after settling the user resizes | 0 warnings during model layout settle; after settling a user resize warns once and dims, without blocking the page | accepted |
| BU-E2E-008 | free size `393x852`, `393x1200`, `3840x2160`, out-of-range draft, exit/re-enter | strict range; failure not partially applied; same guest; tab-local size kept; zoom returns to Fit on re-entry | accepted |
| BU-E2E-009 | same tab at Desktop zoom `0/+2/-2`, using Fit/50% each | frame/native guest coincide on four edges; viewport/DPR=1 unchanged; no clipping/extra scroll extent; center pointer maps correctly | accepted |
| BU-E2E-010 | qualifying Browser API normal completion, explicit `emitImage`, discovery/failure/stop, two consecutive turns and cold restore | normal turn-tail appended; explicit image does not suppress the tail image; negatives append nothing; over-budget compressed; after restore exactly once with stable order | accepted |
| BU-E2E-011 | human top/iframe alert/confirm; Agent `getDialog/handleDialog` | human gets exactly one trusted `<host> says` system box; automation keeps using Chromium/CDP dialog | accepted |
| BU-E2E-012 | main Agent caches Browser objects; subagent lists conversation tabs and opens/operates a new tab, then back to main Agent | subagent Browser calls succeed and see the main Agent's tabs, new tab visible in the current conversation panel; ordinary Node REPL works; child's tab kept after it ends; main Agent binding keeps working | accepted |
| BU-E2E-013 | window B reports window A's guest webContentsId | must fail closed, B cannot operate A's guest | bug-candidate; current implementation seems to lack a `hostWebContents` check, not added to the pass gate |
| BU-E2E-014 | SSH/mobile/Windows signed Chrome/UAC | regress on each client's real chain | deferred; needs dedicated environments |
| BU-E2E-015 | after payment/delete/upload/secret confirmation, bypass with evaluate/CUA/backend | same intent still rejected | undefined; waits for Browser safety product implementation |
| BU-E2E-016 | A/B running simultaneously, each makes a Browser permission request and creates two IAB tabs; switch sessions back and forth during operation | each permission routes only to its source session; A/B `tabs.list`, tab id, URL, page state and side pane visibility do not cross; background completion does not steal the foreground | accepted |

Concurrent representative state and permission order:

```text
A running -> Browser permission A pending -----------+-> approve A -> A1/A2 -> A completes
                 switch session                      |
B running -> Browser permission B pending -> approve B -> B1/B2 -> B completes
                 ^                    |              |
                 +---- foreground ----+---- switch --+

Expected: permission/task, provider continuation, tab registry, guest/page state, side pane
          are all isolated per session; background ready/show/completion does not change the foreground session.
```

Background-execution viewport semantics:

```text
renderer inactive / display:none
  -> only means the user cannot currently see the pane
  -> main must still give Browser commands a stable, non-zero execution viewport
  -> tabs.new/list/get and later DOM / Playwright commands can finish in the background
  -> when the session becomes foreground-visible again, the host natural viewport is restored

Forbidden: returning the hidden guest's 0x0 host layout as the BrowserTabSummary viewport or throwing directly;
Forbidden: activating a background session, taking over the foreground side pane or reusing a tab across sessions to fix the viewport.
```

Subagent boundary as originally frozen:

```text
main: bootstrap -> cache Browser/Tab -> parent-before
  -> child: ordinary Node REPL succeeds
  -> child: documentation/capabilities/tabs/cached Tab/re-bootstrap all denied
  -> main: same Browser/Tab -> parent-after
```

## Pruning Decisions

| Decision                                                  | Guard / invariant                                                          | Representative coverage                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| Playwright is not treated as a backend                    | Playwright is a tab API family                                             | IAB full chain + CLI managed CDP smoke          |
| No separate runtime for mobile                            | `/remote` must use shared-host attachment                                  | later mobile replayable only restores conversation facts |
| No app-restart tab recovery test                          | IAB promises persistence only within the current ZCode process             | BU-E2E-003                                      |
| No full method x OS x zoom                                | high-risk equivalence classes and pairwise are enough to tell behaviors apart | BU-E2E-005/006/008/009                       |
| No stub to claim extension availability                   | unavailable member/backend must be hidden                                  | discovery contract/unit; positive path deferred |
| Unconfirmed safety behavior is not frozen                 | the current matrix is still to-be-implemented                              | BU-E2E-015 stays undefined                      |
| No permutation of 3+ sessions, 3+ tabs or all permission response orders | 2 x 2 already crosses conversation, interaction, broker, renderer and guest ownership | BU-E2E-016                  |
| No subagent x all Browser methods permutation             | init, tabs.new/list, goto, fill and read cover init, transport and tab ownership classes | BU-E2E-012                   |

## E2E Handoff

- First-batch representatives of `BU-E2E-001/002/003/005/006/007/008/009/010` go into conversation
  `manual-review/pending` with case-local replay; each case is still marked partial in the matrix and does
  not mean the full candidate is covered.
- Pure Browser UI/guest lifecycle cases go into a Browser Use dedicated manual-review spec; the local HTTP
  fixture is started by the test process, the URL is injected through a replay marker, and public-network
  dependence is forbidden.
- Implemented now: the real full chain of `BU-E2E-002`, the cross-turn multi-tab independent case
  `BU-E2E-003`, and high-risk representatives of `BU-E2E-001/005/006/007/008/009/010`. Second batch:
  `BU-E2E-012` subagent runtime boundary and `BU-E2E-016` two sessions x two tabs x permission routing.
  `BU-E2E-004/011` and the remaining branches of every partial case stay `missing`; formal WDIO coverage
  must not be inferred from unit tests or manual smoke.
- Before promotion: manual review, fixture check and isolated replay; single-spec container admission is
  done when entering a Docker preset.

## Implementation and verification state

- Candidate spec:
  `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-browser-use-iab-full-chain.test.ts`
- Multi-tab lifecycle spec:
  `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-browser-use-iab-multitab-lifecycle.test.ts`
- Provider replay: 4 case-local fixtures (title, bootstrap, action, final); the local HTTP port is
  back-filled dynamically from the user marker and only loopback URLs are accepted.
- Replay continuation matches the success marker by the latest `user/tool_result`, never by the same string
  in assistant tool code (no false positives); the permission helper clicks the single `allowOnce` once per
  stage so rapid consecutive calls cannot approve the next permission card by mistake.
- 2026-07-19 passed fixture check, E2E TypeScript check and macOS Electron isolated replay. The real chain
  covers two build-mode MCP "allow once", real IAB guest, unique-visible fill with moving input,
  strict duplicate/overlay rejection, CUA type after the host Composer steals focus, DOM locator click,
  explicit image and turn-tail image, session-switch keep-alive, free size, 50%, Desktop zoom `+2/-2` and
  conversation image cold restore.
- The multi-tab case uses 6 case-local fixtures covering first-turn A/B + `finalize({keep:[A]})` handoff,
  normal `turnEnded`, the second turn's independent `tabs.list()`, `tabs.get(A)` by URL/stable id,
  continuous page state and explicit `close(B)`. Isolated replay product assertions passed continuously
  (latest report `1 passed / 0 failed`); the WDIO session-delete teardown still times out and makes the
  process exit code 1, kept as a runner infrastructure issue, not a product case failure or a full pass
  gate.
- Two sessions x two tabs: fixtures/typecheck done and in isolated replay. Both A/B Browser permissions
  restore with task switching; after approving foreground B first, B really creates two IAB tabs, returns
  two stable ids/correct URLs and completes. Runtime logs and provider capture (2026-07-19) confirmed that
  after switching back and approving A, permission routing, Node REPL and tool-result injection work; the
  real failure was that when the test then switched back to B, the background A's first `tabs.new()` had
  attached the guest but `summary()` read the hidden `<webview>`'s `window.innerWidth/innerHeight=0` and
  threw `invalid viewport`. The fixture accepted only success markers, so the error tool result's
  continuation showed up as a `Missing Fixture` retry that masked the original fault.
- Fix: when the natural viewport is 0x0, `BrowserGuestManager` uses the most recent valid natural size of
  the same window (800x600 with no history) as a transient CDP viewport; after the renderer's real
  `attachGuest(active=true)` the host natural size is restored, and the transient clear is serialized with
  explicit viewport set/reset. Isolated replay report `desktop-e2e-20260719-092055-600`: product result
  `1 passed / 0 failed` (4.89s); A/B with two tabs each, four different guest webContentsIds, URL/page
  state and side pane isolation all pass; the WDIO `DELETE session` teardown still times out with exit code
  1, recorded separately from product assertions.
- Subagent boundary case: 8 case-local fixtures, isolated replay product assertions `1 passed / 0 failed`
  (2.38s): child's ordinary Node REPL returns 42; the main Agent's cached Browser documentation,
  capabilities, tabs, cached Tab and re-bootstrap are all uniformly rejected in child scope, the first
  real provider-visible error contains no internal stack; after the child completes the main Agent reuses
  the same renderer webContents/Tab and writes successfully. The WDIO `DELETE session` teardown still
  times out with exit code 1, recorded separately.
- The two-image case explicitly uses a normal context window: the 240-token auto compact of manual-review
  would remove history tool images under the existing media budget, which is mutually exclusive with "both
  explicit and turn-tail images persisted". Browser compact continuity needs its own case and is not
  falsely covered here.
- Still in `manual-review/pending`: manual visual review not done; BU-E2E-003 human/stale/abnormal terminal
  branches, BU-E2E-004/011, BU-E2E-002 `press`/response meta, BU-E2E-005 iframe/OOPIF and focus-token
  drift, BU-E2E-006 iframe/navigation race, BU-E2E-007 show/activate/reset, BU-E2E-008 extremes and
  exit/re-enter, BU-E2E-009 pointer/four-edge pixel human review, BU-E2E-010 failure/stop/over-budget/two
  consecutive turns remain for later cases.
