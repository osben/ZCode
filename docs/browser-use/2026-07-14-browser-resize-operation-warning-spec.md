# Browser Use Resize Warning During Operations

## Feature/change summary

| Field | Value |
| --- | --- |
| Change | While a Browser Use operation is running, if the user or external layout changes the actual size of the corresponding visible tab's browser region, the page content dims briefly and one non-blocking warning shows at the top of the panel. The model opening Browser or setting/resetting the viewport does not warn. |
| User-visible surfaces | Desktop browser-use side-pane tab |
| Existing docs | `2026-07-10-browser-use-codex-parity-spec.md`, `browser-use-codex-parity-coverage-matrix.md` |
| Existing code owners | `browserUseOperationUntil` (side-pane tab), `UnifiedBrowserView` (browser region) |
| Out of scope | Interrupting tools, auto-redoing snapshots, CUA coordinate correction, main/host/agent protocol changes, an independent mobile browser runtime |

## Product decisions and boundaries

The prompt is a top-of-panel, auto-dismissing, non-interrupting weak hint with no confirmation. During it the page content dims (brightness 0.88; the address bar does not dim); style follows the ZCode visual system (neutral popover, local warning accent, `shadow-md`, no full-block warning fill). Agent new/show/activate and viewport set/reset are silent; user and external-layout resizes still warn.


| Boundary | Decision | Includes | Excludes / prunes |
| --- | --- | --- | --- |
| Active authority | same `browserUseOperationUntil` as the mouse icon | renewal by later operation events | guessing state from task phase or tool card |
| Resize target | web content region of the visible tab | actual width/height change from window, sidebar or layout | first measurement; zero-size changes from hide/show |
| Resize source | only changes from user interaction or external layout | free-size toggle/input/drag, window and sidebar layout changes | Agent ready/show/activate and known changes caused by `BrowserViewViewportChanged` |
| Agent layout marker | main marks only Browser commands that open, show, activate or change the viewport with `resetsResizeBaseline` | `newTab`, `activateTab`, `browserVisibilitySet(true)`, viewport set/reset | plain navigate/locator/screenshot/list commands do not rebuild the baseline |
| Agent layout settlement | 300ms minimum settle after the marker; every valid observation extends the end to at least 100ms after that observation; total settle capped at 500ms (from the 2026-07-17 dev runtime trace) | multi-frame resize from the 200ms side-pane animation/width lock and guest mount | silencing the whole 5s active cycle, unbounded extension, swallowing only the first frame |
| Frequency | at most one per continuous active cycle | the next cycle after active ends may warn again | warning on every ResizeObserver callback |
| Effect | page content dims lightly; top neutral popover auto-dismisses | `aria-live=polite`, filter fade in/out, warning icon/accent line | full-block warning fill, dimmed address bar, blocking clicks, confirmation, cancelling tools, forced snapshot refresh |

## Domain scope

| Domain | Include? | Why |
| --- | --- | --- |
| UI shell/theme/locale/responsive | yes | the prompt must handle size changes, themes and zh/en (`DESIGN.md`, `UnifiedBrowserView.tsx`) |
| Permission/tool UI | yes | active must share the source of the tab-specific operation indicator (`useAppPanels.ts`, `BrowserUseTabIcon.tsx`) |
| Mobile remote/replayable | no | the IAB pane is desktop UI; no remote-control state is added |
| Architecture/process boundary | no | existing operation events already carry the needed state; no protocol change (`workspaceSidePane.ts`) |

The high-risk cross-product kept is `active x visible x size changed x source`. Theme, locale and platform
do not change the trigger semantics (collapsed via semantic tokens, i18n and the `ResizeObserver`
platform capability).

## State owners

| Concept | Owner | Notes |
| --- | --- | --- |
| Browser Use active | renderer side-pane tab `browserUseOperationUntil` | same time boundary as the mouse-icon animation |
| Browser region size | current `ResizeObserver` observation | based on actual content-region width/height only |
| Resize source | Agent platform event or renderer user/layout event | distinguishes model-known from unknown changes (ready/visibility/viewport event + UI action) |
| Agent layout baseline version | renderer side-pane tab monotonic version | main marks the layout command, the version increments; the target view clears the observation baseline in the layout effect and opens the bounded settle window (`BrowserViewOperation` + side-pane tab local state) |
| Agent layout settle deadline | `UnifiedBrowserView` local ref | absorbs model-known resize across multi-frame init; min 300ms, 100ms quiet after the last observation, at most 500ms |
| Warned this active cycle | `UnifiedBrowserView` local ref/state | de-duplicates continuous dragging; not propagated across tabs/cycles |
| Prompt visibility | `UnifiedBrowserView` local state | drives both the warning banner and webview brightness; not persisted, snapshotted or realtime (`role=status` UI + webview data attribute) |

## Candidate combinations

| ID | Active | Tab visibility | Observation | Expected effect | Status |
| --- | --- | --- | --- | --- | --- |
| BRW-001 | yes | visible | width or height changes after baseline | page briefly dims and one neutral popover shows; warning is only a local accent; continuous changes do not stack; auto-recovers | accepted |
| BRW-002 | no | visible | width or height changes | only update the size baseline, no prompt | accepted |
| BRW-003 | yes/no | hidden | resize / display toggle | no prompt; baseline rebuilt when visible again | pruned |
| BRW-004 | yes | visible | first observer callback | only establish baseline | pruned |
| BRW-005 | yes | visible | repeated callback with unchanged size | no prompt | pruned |
| BRW-006 | yes | visible | locator/CUA after resize | tool execution and snapshot semantics unchanged | ignored (feature only informs of the risk) |
| BRW-007 | yes | hidden/visible | Agent new/show/activate | Browser expands or activates; no prompt, page not dimmed | accepted |
| BRW-008 | yes | visible | Agent viewport set/reset | free-size UI and actual viewport sync; no prompt, page not dimmed | accepted |
| BRW-009 | yes | visible | user resize after an Agent change | user change still shows one prompt; Agent silence must not consume this cycle's prompt quota | accepted |
| BRW-010 | yes | already visible | initial region multi-frame change after Agent `newTab` returns | the operation event opens a bounded layout settle window on the target tab; baseline keeps updating and no prompt shows; after settling a user resize warns again | accepted |

## Pruning decisions

| ID | Pruned combination | Guard/invariant | Reason | Coverage |
| --- | --- | --- | --- | --- |
| BRW-P01 | hidden, zero size, first measurement | a visible non-zero baseline and a real size delta are required | avoids false alarms on tab switch/initial mount | BRW-002/003/004 |
| BRW-P02 | later resize in the same active cycle | `warnedForActiveCycle` | continuous dragging needs only one weak prompt | BRW-001 |
| BRW-P03 | Agent new/show/activate | visibility toggle synchronously clears the old observation baseline | Browser expansion is part of the model's current operation, and hide/show should never warn | BRW-007 |
| BRW-P04 | Agent viewport set/reset | `BrowserViewViewportChanged` is an Agent-only sync event; renderer manual updates do not echo it | the Agent knows it changed the coordinate system and needs no reverse reminder | BRW-008/009 |
| BRW-P05 | Agent `newTab` init convergence with visible pane | the `newTab` operation carries the baseline reset marker after the command succeeds and the real tabId resolves; renderer uses 300ms min settle + 100ms quiet after observation and force-resumes warnings at 500ms | `isVisible` stays true, and clearing the baseline once only swallows the first frame, so it is not a complete false-alarm fix | BRW-010 |

No open product questions.

## Accepted cases

| Case | Setup | Action | Assertions | Evidence layers | E2E status |
| --- | --- | --- | --- | --- | --- |
| BRW-001 | visible browser-use tab, operation indicator active, size baseline set | continuously resize the browser content region | webview brightness drops to 0.88; a neutral popover shows at top with clear warning icon/accent line; no full-block warning fill; address bar and clicks unaffected; both recover automatically | UI state + DOM | automated: `packages/ui/test/UnifiedBrowserView.test.ts` |
| BRW-002 | indicator inactive or tab hidden | change region size | no prompt; becoming visible only builds a new baseline | UI state + DOM | automated: `packages/ui/test/UnifiedBrowserView.test.ts`; hidden desktop smoke pending |
| BRW-007 | operation active; model creates/shows/activates the target Browser tab | tab goes from hidden/unmounted to visible | new size baseline built synchronously; no prompt, page not dimmed | platform event + UI state + DOM | automated: `packages/ui/test/UnifiedBrowserView.test.ts` |
| BRW-008 | visible browser-use tab, operation active | Agent calls viewport set/reset | free-size UI links normally; no prompt, page not dimmed | platform event + UI state + DOM | automated: `packages/ui/test/UnifiedBrowserView.test.ts` |
| BRW-009 | same active cycle after BRW-007/008 | user toggles/types/drags free size | one prompt shows and the page dims | UI action + DOM | automated: `packages/ui/test/UnifiedBrowserView.test.ts` |
| BRW-010 | Browser pane already visible with a tab; target session starts `newTab` | ready/visibility creates the target view first; after the command succeeds an operation with the baseline reset marker is delivered; the init region changes over several frames during the 200ms animation/mount | no prompt and no dimming during the settle window; after it ends a user/external resize warns normally | main IPC + side-pane state + ResizeObserver + timer + DOM | automated: desktop operation marker + workspace side-pane reducer + `UnifiedBrowserView` component; runtime trace |

```text
main newTab                  renderer side pane                 target view
    | ready / visibility ---------->| mount + first baseline -------->|
    | newTab result(real tabId)      |                                |
    | operation(reset baseline) ---->| increment baseline version ---->|
    |                                | clear baseline + settle 300ms  |
    |                                |<---- init ResizeObserver #1 ----|
    |                                | update baseline; quiet +100ms  |
    |                                |<---- init ResizeObserver #2 ----|
    |                                | update baseline; quiet +100ms  |
    |                                |                                |
    |                                | settle deadline elapsed         |
    |                                |<---- user/external resize ------|
    |                                | warn once in active cycle       |
```

Coverage matrix gains BCP-183. The interaction does not depend on provider, file fixtures, Docker or
replayable recovery; deterministic component tests use a jsdom `ResizeObserver` fake and check the dimming
data attribute and the reduced-motion CSS contract. Real dragging and webview compositing remain desktop
smoke risks.
