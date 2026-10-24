# macOS background input mode

## Current state (corrected 2026-09-16)

Several places in this doc treat `open_application(activate=true)` as the means to foreground or recover
(see "Behavior contract" item 3 and the Chrome fixture acceptance step). **The macOS surface no longer has
that tool:** `open_application` was cut from darwin on 2026-09-11 (`src/tools/platform-surface.ts`), so the
model has no activation means and `FOREGROUND_REQUIRED` is unsatisfiable on macOS. A real machine on
2026-09-16 (LibreOffice background open panel) confirmed that `Cmd+Shift+G` is ignored verbatim while the
sidebar cell's `AXOpen` works reliably. The model-facing file_panel guidance now teaches `AXOpen`
(`src/targeting/format.ts`). Read steps below that say "foreground first, then key" accordingly; restoring
that lane requires restoring an automatic promotion capability first.

> 2026-08 update: this doc's native owner, background delivery and `possibly_sent` safety boundary remain
> valid. "Forced compact/full state after an action, action_outcome, state_sync_status, and the
> delta/no_change unlock barrier" are superseded by `docs/cua-receipt-observation-contract.md`. The current
> model-visible action result is `zcode-cua-action-receipt-v1` by default; a `force_full` state is captured
> once only with explicit `return_state=compact|full`.

## Goal

By default zcode-cua on macOS must not change the user's current system foreground app, key window, window
order or physical mouse position. An action must bind explicitly to a live logical app, presentation window
and actual surface; insufficient evidence fails closed. Only when the logical app is already frontmost and
WindowServer proves the ordinary OS hit-test matches the screenshot surface exactly may `kCGHIDEventTap`
hand the event to the AppKit current responder; that path never activates the app implicitly.

Linux and Windows keep their current platform semantics. The private SkyLight ABI exists only in the macOS
native Helper and never enters the cross-platform MCP schema.

## State and ordering

```text
MCP target/state_id + actionable frame
    |
    v
AX relationship graph ---> presentation root + attached surface(s)
    |                                      |
    |                                      +-- WindowServer before/after owner proof
    v
pixel -> exact actual owner PID + CGWindowID + live bounds
    |
    +-- stale/replaced/unclear relationship ---------> action_sent=false
    |
    +-- logical app frontmost + OS hit-test == actual surface
    |           |
    |           `-- foreground CGEvent -> AppKit focused sheet responder
    |
    `-- otherwise
                |
                `-- synthetic focus + stamped window fields
                    -> SLEventPostToPid(actual owner, actual window)
```

## Behavior contract

1. `left_click` and its `click_count` 2/3 and `mouse_button` right/middle forms share surface routing. In the
   background or with an unrelated occluder it uses the window-scoped recipe; when the logical app is
   frontmost and the OS hit-test hits exactly the same actual surface it uses the foreground CGEvent,
   because NSOpenPanel was measured to accept a window-scoped SkyLight event without producing the AppKit
   responder side effect. Click state is 1/2/3 in turn.
2. `scroll` and `left_click_drag` use the same PID/window-targeted event channel; the internal press of
   `left_click_drag` saves the target window and virtual coordinates, and release must reuse the same target.
   The model side has no standalone press/move/release entry.
3. `type` and `key` (including the hold-duration form) keep AX first. When the logical app is not frontmost,
   real keyboard events are delivered by default in an actual PID/window background session; when already
   frontmost they go to the OS's current focused attached surface. `strategy=event` does not activate the
   app: it sends one global real keyboard event only when the logical PID is already frontmost and the fresh
   `app_ref.window_id` is still the current focused file-panel surface. When foregrounding is needed the
   caller must first run `open_application(activate=true)`, re-observe, then dispatch. Unmet
   foreground/focus preconditions return `foreground_required + action_sent=false`; they must not masquerade
   as TCC `permission_denied` or silently degrade to window_event. Chromium renderer Tab/Enter/combination
   keys are also this exception: a background PID/window receipt cannot prove the renderer received the
   event. A workflow already foreground-verified by the fixture must explicitly use the exact `window_id` and
   `strategy=event`, and be accepted on DOM keydown/keyup/submit results.
4. `type(target=element)`, `set_value`, `select_text` and `perform_action` keep preferring AX tokens. Element
   `set_value(strategy=event)` is as in item 3: it must activate and re-verify the exact window before global
   selection/input and must not be intercepted by background mode; default/AX strategies are still wrapped
   by native synthetic focus without activating the system app.
5. `open_application` opens in the background by default on macOS. The only foregrounding exception is the
   caller passing `activate=true` together with an `app.window_id` that fresh AX/WindowServer evidence
   confirms as `open_panel`, `save_panel`, or an `attached_dialog` derived from a file panel under the same
   presentation root. That path activates the logical app, focuses the exact actual surface and re-checks
   before returning; ordinary windows, popovers, missing lineage and old generations cannot use it to
   foreground. An ordinary launch without URL and not `new_instance` keeps using native
   `NSWorkspaceOpenConfiguration` with fixed `activates=false` and
   `allowsRunningApplicationSubstitution=true`: the window appears on screen (interactive, AX readable) but
   does not activate or steal keyboard focus. Do not set `hides=true`: the window would be created hidden,
   unhide cannot bring it back on screen, AX tree traversal times out, and it violates item 7 ("the input
   target must be an on-screen window"). The Helper must keep the request alive and wait for the
   `openApplicationAtURL` completion to succeed before AX window postcondition verification; "LaunchServices
   request submitted" is not success. The `NSRunningApplication` pid returned by completion must be reported
   to the broker: enumeration sources (NSWorkspace KVO / `CGWindowList(OnScreenOnly)`) lag seconds for a
   freshly launched app, so identity resolution prefers a direct `applicationInfo(pid)` lookup. If the target
   process already exists but `AXWindows=0`, re-dispatch and return only after a real AX window appears,
   otherwise fail explicitly so later observation cannot degrade to `elements(0)`. The whole process never
   activates the target and never hides a transient focus steal by restoring the previous foreground app.
6. A raw action on macOS without `app_ref`/window evidence is always rejected; an old Helper without the
   background ABI is also rejected, never degrading to global input.
7. The target must be a currently on-screen real window still belonging to the bound PID. Hidden, minimized,
   other-Space, stale or negative fallback window ids return `action_sent=false`.
8. An event stamped with PID, window id and in-window coordinates is delivered exactly once through
   `SLEventPostToPid`. `CGEventPostToPid` must not be called again on the same `CGEventRef`; a dual channel
   makes Chromium receive duplicate `mousedown` / `mouseup` / `contextmenu`, letting "tool success" mask
   duplicated business side effects.

## Receipt boundary after AX actions

The return value of write APIs such as `AXUIElementPerformAction` is not a transactional confirmation of app
business state. macOS may hand the action to the target app first (an entry is added, an editor opens, the
selection changes) and the AX API then still returns `kAXErrorAttributeUnsupported`, `kAXErrorFailure` or
`kAXErrorCannotComplete`. After entering the native call, an error therefore means only `possibly_sent`, not
"the action did not happen", and must not trigger automatic retry.

```text
model state s-N
    |
    v
pre-native validation ----fail/target stale----> not_sent receipt
    |                                            only the proven-stale s-N is discarded
    v
enter one native call
    | accepted / possibly_sent
    v
accepted/possibly_sent receipt (retry_action=false)
    |
    +-- return_state=none ----------> done, no capture
    |
    `-- return_state=compact/full --> one force_full capture --> new state s-(N+1)
```

The model-visible action result is uniformly `zcode-cua-action-receipt-v1`:

- `dispatch_status="accepted" | "possibly_sent" | "not_sent"` describes only the dispatch fact;
- `retry_action=false` forbids host or model from replaying a non-idempotent call as is;
- default `return_state="none"`: no implicit capture, settle or state barrier;
- explicit `return_state="compact" | "full"` runs exactly one `force_full` observation;
- the receipt precedes the long AX tree so truncation by the host cannot lose the replay-protection evidence.

An element action discards only the `pre_state_id` referenced by this target; other states of the same
app/window are unaffected by a scope-wide write lock. A fresh native token from a coordinate hit-test has no
`pre_state_id` and so does not wrongly discard the latest state. `possibly_sent` uses the same receipt
contract for element, coordinate, drag, mouse down/up and keyboard, no longer degrading to `CUA_NOT_READY`
and leaving the model to guess about replay. A mutation scope missing pid/bundle/name must still be rejected
before dispatch with `action_sent=false`.

Contextual AX synthetic-focus is only a pre-dispatch precondition. If it explicitly returns
`action_sent=false`, bypassing it for one AX attempt is allowed; once the wrapper has called the native
action or the dispatch fact is unclear, no fallback, token re-resolution or second AXPress is permitted.

## Compatibility and risks

- SkyLight is a private ABI and a system upgrade may make the capability unavailable; the runtime probes
  symbol by symbol and reports explicitly, with no global fallback.
- "Background" does not mean operable without a rendered window. The window may be occluded by others but
  must still be in the current Space and marked on-screen by WindowServer.
- The target app may still reject synthetic input. Action success means only that the event was delivered
  to the target; the final effect is verified by the existing post-action observation.
- Mixed producer/Helper versions are unsupported. Installing a new producer must overwrite the old install
  with the bundled Helper of the same build id; failed startup validation fails explicitly and the action
  path carries no compatibility for old wire payloads.

## Begin failure diagnostics

The begin of a background keyboard session cannot return just a boolean: that would flatten session busy, AX
unauthorized, missing SkyLight symbol, window not in the current Space, window owner/bounds change,
`GetProcessForPID` failure and a synthetic-focus record rejected by WindowServer into one error, leaving the
runtime unable to tell "target stale" from "private ABI broke". The Helper's additive detailed ABI returns:

- a stable `reason`;
- `native_status` (only when the underlying SPI returns a status code);
- `pid`, `window_id`, expected bounds;
- live owner, on-screen and live bounds when readable;
- the list of missing SkyLight symbols.

```text
MCP key/type/hold
    |
    v
beginBackgroundWindowInputDetailed
    |
    +-- parse/AX/SkyLight/live-window/focus-record branches
    |                         |
    |                         v
    |              { ok:false, reason, evidence }
    |                         |
    |                         +--> Helper warn log
    |                         +--> BrokerError.details
    v
verified PID keyboard dispatch (only when ok=true)
```

Failure happens before verified keyboard dispatch, so every begin failure must keep `action_sent=false`. An
old addon without the detailed ABI keeps failing closed and is marked `legacy_unclassified` (not precisely
classifiable); it must not pose as a specific native cause.

## End failure diagnostics

The same argument applies to teardown: a boolean would flatten session mismatch, synthetic-focus release
failure, real foreground change and physical cursor movement. The detailed end ABI returns a stable `reason`,
`native_status`, `pid`/`window_id`, and the frontmost pid and physical cursor measured once before and once
after dispatch.

End happens **after** verified dispatch, so every reason must be read as `action_sent=true`; it must never let
a caller read it as "the action was not delivered, safe to retry".

**The keyboard path does not treat `frontmost_changed` / `cursor_moved` as failures.** This path cannot change
either quantity: app-scoped keyboard uses `CGEventPostToPid` (PID-targeted delivery), which neither moves the
system cursor nor calls `SetFrontProcess`. So observed drift has only two sources:

1. the user moved the mouse (teardown includes 100ms + 40ms waits, so a hand touch triggers it);
2. the target app's normal reaction to the key, for example `escape` closing a menu after which the app
   returns the foreground.

In case 2 the more effective the action, the more the check fails. Reporting them as failures would make the
model think the key was not delivered and retry, causing duplicate input. So: log `warn` and telemetry; the
tool result stays success.

`session_mismatch`, `unfocus_record_failed`, `action_failed` and the `*_unclassified` family keep reporting
errors: they are real state leaks or unclassifiable risks, but must report the exact reason rather than a
generic "invariant changed". The pointer path keeps its original policy and is not adjusted here.

## Acceptance

- Broker unit tests: the five click profiles all select the window-scoped ABI in the background; the
  foreground ABI is selected only when the logical app is frontmost and the actual surface also passes the
  WindowServer hit-test; with an unrelated occluder the global path is not used.
- scroll/drag/mouse-hold unit tests: app/window scope is always kept with no global fallback.
- Chromium keyboard unit tests: no activation and no global send.
- Native source tests lock the private symbols, fields, click recipe, target-only focus and fail-closed.
- Real machine: with a foreground observer app as baseline, act on background Calculator/TextEdit/Chromium,
  compare frontmost PID, physical cursor, window bounds/order before and after, and verify target state
  change.
- Broker unit tests: keyboard end `frontmost_changed` / `cursor_moved` only log and do not change the tool
  result, while `session_mismatch` / `unfocus_record_failed` still fail closed and report the exact reason.
- **Real-machine acceptance must include two tiers: "mouse moved by hand during dispatch" and "escape pressed
  while a target-app menu is open".** Acceptance only in a quiet environment untouched by a human makes the
  frontmost/cursor invariants look permanently true; the 2026-08-13 evidence below passed that way while real
  feedback on the same path saw 6 failures in 7 calls.
- The AppKit fixture must use `NSOpenPanel.beginSheetModal(for:)` to truly establish a modal response, verify
  the `Cmd+Shift+G` child surface, the full path, the default confirm button state and confirm-close, then have
  an in-app oracle verify the exact file; the target lane takes at most 15 CUA calls and must not call
  `osascript`.
- The Chrome fixture must start from a background `open_panel`, foreground the exact surface through the
  double-confirmed `open_application`, then complete `Cmd+Shift+G`, path input, Enter and confirm; page
  AX/DOM text is the final oracle, and the whole tested path must not use CDP/Playwright to set the file.

## 2026-08-23 file-panel real-machine evidence

- The presentation root, the NSOpenPanel and the `Cmd+Shift+G` child sheet resolved to three real window ids
  sharing one presentation root.
- 8 CUA calls completed full path input, target file selection and confirm-close; the in-app oracle returned
  `response=ok`, `target_selected=true`, `osascript_calls=0`.
- The confirm click's outcome reported the actual panel owner/window and `surface_kind=open_panel`; after the
  file panel closed, control returned to the same presentation root.

## 2026-08-24 file-panel differential E2E

- Three independent task packs M14-M16 lock coordinate surface routing, panel-generation keyboard identity
  and state-only coordinate authority; all use a real AppKit NSOpenPanel and native MCP calls.
- M14/M15 explicitly run `activate=true` before the foreground raw keyboard step, directly covering the
  "type immediately after re-activation" recovery path; `return_state:none` must still return the actual
  dispatch surface and a non-retryable outcome.
- `main@e0d27a36`: M14/M16 cannot deliver an actionable panel raster; M15's Escape returns a success text but
  the panel does not close.
- Fix branch: all blocking checks of M14, M15, M16 pass; `osascript_calls=0`.
- M16 additionally proves an ordinary panel click returns only `accepted/not_proven` and is not misreported
  as the panel having closed because settle briefly captured the presentation root.

## 2026-08-13 real-machine evidence

- Background Calculator (PID 23325, CGWindowID 168257) received a click and its display became `7`.
- Double, triple, right and middle click on the same window all succeeded natively; the system frontmost PID
  stayed 17641 and the physical cursor stayed `(985.21484375, 300.1875)` around every event.
- The synthetic-focus keyboard session's begin, verified key and end all succeeded; Calculator showed
  `78,888,891`, and frontmost PID and cursor were unchanged.
