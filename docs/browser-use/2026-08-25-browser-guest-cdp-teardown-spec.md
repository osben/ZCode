# Browser Use Guest CDP Teardown and Destruction Order Spec

> Status: in implementation
> Applies to: the Browser / Browser Use `<webview>` guest of Desktop `desktop-continuous`.
> Does not apply to: the independent recovery semantics of mobile `web-remote-replayable`, and session/stream business state in relay/main.

## 1. Background and root cause

In the `v3.9.1` build of ticket `ZCT-2092076135526567936`, a native access violation in the ZCode main
process occurred during continuous Playwright/CDP automation. Before the crash the log contained both:

```text
detachGuest cdp message cleanup failed ... Object has been destroyed
detachGuest cdp still attached on destroyed guest ...
```

This shows the guest WebContents was already destroyed but the native DevTools session had not been
actively detached; an in-flight CDP notification then accessed the destructed `client_` and triggered a
use-after-free on the Electron/Chromium side. Calling `debugger.detach()` after the `destroyed` event
arrives is already too late and cannot serve as a safety net.

## 2. Goals and non-goals

### 2.1 Goals

- Every destroy, replace and generation-change path of a guest must first go through the main CDP
  teardown handshake.
- After teardown starts, reject new CDP dispatch and ensure an old guest command cannot be sent to a
  replacement guest.
- The renderer may unmount or replace the `<webview>` only after main confirms the CDP is disconnected.
- On teardown failure fail closed: keep the old guest or enter an explicit error state, never keep
  opening the known native UAF window.
- Record `tabId`, `guestId`, `guestGeneration`, teardown reason, pending CDP count and result, to
  correlate with the minidump.

### 2.2 Non-goals

- Do not introduce the snapshot/queue recovery semantics of mobile `web-remote-replayable` into the
  desktop continuous main chain.
- Do not hide the native lifecycle problem by lowering Playwright frequency, adding timeouts or trimming
  model return values.
- Do not try to "rescue" a native detach after `destroyed`; that event is only for wrap-up and abnormal
  reporting.

## 3. Lifecycle state machine

```text
attached(generation=N)
        |
        | acquire CDP lease / pendingCommands++
        v
  command dispatch
        |
        +-----------------------------+
        |                             |
        v                             v
 beginGuestTeardown(reason)      command settled
        |
        ├─ state = detaching
        ├─ reject new command dispatch
        ├─ abort tab-scoped running requests
        ├─ wait pending commands to settle (bounded)
        ├─ debugger.detach() and confirm detached
        └─ resolve detached ACK
                        |
                        v
             renderer replaces/unmounts <webview>
                        |
                        v
                 destroyed → cleanup only
```

Teardown of one tab must be single-flight; the generation of an old guest and that of a new guest must
never be reused.

## 4. Implementation contract

### 4.1 Main-side guest teardown

`BrowserGuestManager` adds to each `ManagedTab` a teardown state, a generation, a teardown promise and a
pending CDP count. All these entries call `beginGuestTeardown` uniformly:

- `render-process-gone`
- the explicit ACK before the renderer replaces `<webview>`
- close tab / close window / close session
- residency eviction / suspend
- scope mismatch / guest rebind
- guest recovery

`detachGuest` only cleans up state; if it observes `destroyed + cdpAttached` it must keep a severe
anomaly record and must not treat it as a successful native detach.

### 4.2 CDP command lease

`toControlledView().cdp.send()` must not call `guest.debugger.sendCommand()` directly. It must:

1. validate the current guest, generation and lifecycle state;
2. increment the pending CDP count and register a finally to close it out;
3. reject new commands after teardown;
4. let an old command act only on its original guest, never across generations.

### 4.3 Renderer handshake

Any state change in `UnifiedBrowserView` that can make the `<webview>` disappear must wait for:

```text
renderer request replacement
        → main beginGuestTeardown
        → main confirms debugger.detach
        → detached=true ACK
        → setWebviewGeneration / unmount
```

On ACK failure `webviewGeneration` must not be incremented and the old node must not be unmounted
directly.

### 4.4 Scope/rebind

Follows `2026-08-23-browser-guest-scope-recovery-spec.md`: the tab freezes the owner scope, attach returns
a typed result, a scope mismatch uses single-flight bounded rebind, and a rejected incoming guest must be
cleaned up so that an orphan WebContents does not take part in the later CDP lifecycle.

## 5. Acceptance criteria

### 5.1 Unit tests

- After teardown starts, a new command returns `stale_guest` or `backend_unavailable` and does not call
  the debugger.
- Concurrent teardown runs `debugger.detach()` only once.
- During a pending CDP command, teardown can cancel or wait with a bound, and finally settles the count.
- After guest A is replaced by guest B, an old command is never dispatched to B.
- `destroyed + cdpAttached` is marked abnormal and is not recorded as a normal detach.

### 5.2 Electron Windows regression

- The forceful crash / replacement / direct webview unmount paths all detach before destroyed.
- 1000 consecutive Playwright locator, DOM snapshot and tab switch operations produce no new native dump.
- The log no longer shows `cdp still attached on destroyed guest`.
- On teardown failure the UI fails closed, with no main-process crash.
- The desktop continuous chain does not change the recovery boundary of the mobile replayable chain.

## 6. Implementation order

1. Add `BrowserGuestManager` lifecycle/lease/teardown unit tests first.
2. Implement main-side single-flight teardown and the CDP send wrapper.
3. Wire renderer replacement and the other destroy entries to the ACK.
4. Add a real Electron Windows guest-replacement regression.
5. Enter release verification only after the affected tests, `pnpm typecheck` and `pnpm lint` pass.
