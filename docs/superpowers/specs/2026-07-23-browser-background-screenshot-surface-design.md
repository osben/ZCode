# Built-in Browser Background Tab Screenshot Surface Sync Design

> Status: implemented. 2026-07-30 added a bounded activity lease on the owner renderer + target guest, replacing
> permanently disabled background throttling; the same day added event-loop fairness for the preparing pump and
> a transparent first-frame bootstrap for hidden-born guests after macOS / Windows close-to-tray.
> Date: 2026-07-23.
> Related specs:
> `docs/browser-use/2026-07-15-browser-turn-final-screenshot-spec.md`,
> `docs/browser-use/2026-07-15-responsive-browser-viewport-spec.md`,
> `docs/testing/browser-use-codex-parity-coverage-matrix.md`.

## 1. Problem and runtime evidence

The end-of-turn screenshot a user reported was `1274 × 720`. A pixel comparison showed the content repeats
almost exactly with a period of `800px` horizontally and `450px` vertically. Only one `source=browser_turn_end`
image fact is persisted, so the repetition is not caused by conversation UI stitching or image compression.

The runtime chain:

```text
browser-use tab is not the sidebar's current active tab
  -> TabsContent(forceMount) stays mounted, but data-[state=inactive]:hidden makes it display:none
  -> the Electron guest keeps the 800 × 450 compositor surface from when it was last visible
  -> the page keeps running; the current CSS viewport read through CDP has become 1274 × 720
  -> Page.captureScreenshot(fromSurface=true) outputs at 1274 × 720
  -> Chromium periodically fills the target PNG with the old 800 × 450 surface
```

An isolated Electron `<webview>` reproduction proved:

- an ordinary `BrowserWindow` does not repeat with the same CDP parameters;
- it reproduces stably when the `<webview>` guest's layout size, visible composited surface and CSS viewport
  disagree;
- adding `clip`, `captureBeyondViewport` or `Emulation.setVisibleSize` does not fix it;
- `fromSurface=false` may return a black image or a wrong size on a background/occluded guest and cannot be a
  fallback.

The root cause is the missing synchronization boundary "the screenshot surface has been composited for the
current viewport" before screenshotting a background guest, not image encoding, end-of-turn persistence or the
display layer.

### 1.1 Main-process livelock under a hidden window

A real macOS reproduction (2026-07-30): the user closes the last window, the app hides it per product policy, and
BUA then triggers a screenshot in the hidden owner window. The log stops at the screenshot request, the main
process CPU stays at 100% with no crash dump, and sampling shows the main thread running V8 Promise/microtasks.

```text
hidden owner window
  -> activity controller starts the owner + guest continuous capture pump
  -> Electron capturePage(1×1) resolves immediately
  -> the async continuation synchronously creates the next capture inside a microtask
  -> the continuous branch has no macrotask yield, so the microtask queue never drains
  -> renderer Ready IPC / 1500ms timeout / 35s watchdog / second-instance events can never be scheduled
  -> the hidden single-instance process still holds the lock; no new window opens ("ZCode crashed and won't open")
```

The root cause is the pump's scheduling, which lets "immediately completing captures" occupy the Electron main
event loop. The fix must live in the pump itself; the coordinator timeout and watchdog cannot serve as a
fallback because those timers and the IPC are exactly the tasks being starved.

### 1.2 A newly created guest in a hidden window has no first frame

After the fairness fix, the real macOS log exposed a second problem: after the window was hidden (20:35:41),
BUA created a tab (guest attached/navigated while the owner was hidden), the screenshot request found guest
activity capture failing/pending, and the same screenshot succeeded only after the user reactivated ZCode
(20:36:53). Isolated Electron 41 experiments confirmed:

- a guest created in a hidden owner may return empty on the first `capturePage()`, throw `UnknownVizError` or
  stay pending even after navigation completes;
- `invalidate()`, an owner full capture and CDP `Page.startScreencast` cannot establish the guest first frame;
- `showInactive()` establishes it, but calling it directly re-shows the window the user just closed; setting
  opacity `0` first, then `showInactive()`, then `hide()` and restoring the opacity after the first guest
  capture yields non-empty follow-up screenshots (end state `visible=false / focused=false / opacity=original`);
- starting two overlapping `capturePage()` calls each for owner/guest in the same synchronous turn right after
  `showInactive()` triggers `UnknownVizError` and once an isolated-smoke `SIGSEGV`; a bounded presentation
  grace must separate the window show event from Viz surface initialization.

The root cause is that the guest was born after the owner window was hidden and never got a window-level
compositor presentation opportunity; Electron's capturer count can only maintain an existing surface and cannot
bootstrap a first frame from zero.

## 2. Goals and non-goals

### 2.1 Goals

1. Before screenshotting a background, non-active browser-use tab, prepare an Electron guest surface consistent
   with the current natural CSS viewport, without switching the user's sidebar tab, stealing focus, accepting
   mouse/keyboard events or flickering.
2. Main must receive an explicit renderer ready acknowledgment before calling `Page.captureScreenshot`; on
   preparation failure the screenshot terminates explicitly and never returns an old, possibly tiled surface.
3. Success, failure, cancellation, timeout and guest rebuild all release the temporary surface state; the
   existing screenshot, clip, fullPage, end-of-turn persistence and image budget contracts are unchanged.
4. With no screenshot in progress the owner BrowserWindow keeps Electron's default background throttling; the
   process-lifetime persistence of browser-use tabs must not keep waking the window renderer, guest and GPU.
   Wake-up is phased and rate-limited: after Ready the owner no longer participates and the target guest's
   `capturePage()` has a fixed frequency cap.
5. Even if `capturePage()` completes synchronously in the preparing phase, the pump yields one macrotask between
   turns; renderer IPC, cancellation, timeout, watchdog and app lifecycle events stay schedulable.
6. After a macOS window close or a Windows close-to-tray, a guest newly created by BUA can still complete an
   explicit or end-of-turn screenshot; the window is never visible, focused, flickering or back in the Windows
   taskbar, stays hidden afterwards, and is not hidden again if the user reopens it during bootstrap.

### 2.2 Non-goals

- Do not cover compositor errors by cropping the repeated area, image correlation detection or post-screenshot
  resampling.
- Do not force the browser-use tab to become the user's current active tab.
- Do not add task/stream/snapshot business state to the relay, desktop main or mobile.
- Do not change `@zcode/protocol`; this design only adds transient platform coordination between desktop main
  and the owner renderer.
- This fix does not solve the independent Electron limitation "an explicit responsive viewport larger than the
  window's compositable area". If that scenario cannot prepare a same-size surface it must fail rather than
  output a tiled image. Real Electron coverage of large viewports for BCP-199 stays a separate work item.
- No opacity-based transparent window simulation on Linux: Electron Linux `setOpacity()` is a no-op and calling
  `showInactive()` would cause real flicker. Closing the last window on Linux also enters `app.quit()`, so no
  owner/guest remains for BUA to screenshot. The transparent bootstrap is enabled only in the macOS and Windows
  desktop wiring, which have reversible window opacity.

## 3. Design choice

Adopt "background screenshot surface preparation + renderer ACK".

Rejected alternatives:

1. `fromSurface=false`: a background webview can return a black image, and the output size no longer matches
   the Browser API's CSS coordinate system.
2. Activate the browser tab before the screenshot and switch back afterwards: it can make the surface update,
   but steals the user's focus and flickers, and with concurrent multi-tasking also disturbs tab owner
   semantics.
3. Crop the first repeated tile and stretch it: it cannot prove the first tile covers the whole viewport,
   lowers image quality and breaks the correspondence with later click coordinates.

## 4. Layered design

### 4.1 BrowserScreenshotSurfaceCoordinator

Add an injectable screenshot surface coordinator in the desktop browser-use domain. `BrowserGuestManager`
depends only on this interface and does not access React, the DOM or a concrete IPC implementation.

```ts
interface BrowserScreenshotSurfaceCoordinator {
  prepare(input: {
    requestId: string;
    windowId: number;
    workspaceKey: string;
    sessionId: string;
    browserId: string;
    browserGeneration: number;
    tabId: string;
    webContentsId: number;
    viewport: { width: number; height: number };
    signal: AbortSignal;
  }): Promise<{
    viewport: { width: number; height: number };
    release(): void;
  }>;
}
```

- Local desktop wiring uses a renderer IPC implementation.
- Tests may inject a fake coordinator to verify call order, cancellation and release.
- With no available owner renderer, `prepare` fails explicitly and does not fall back to an old-surface
  screenshot.
- `groupsByReadyRequestId` is the only request registry for Ready association; pending requests no longer keep
  a mirror Map that never takes part in lookup.
- `leaseReleases` is the only source of truth for a group's currently valid leases. Only after the last release
  closure is removed from the Set are the surface/activity returned; an independent `leaseCount` must no
  longer be maintained in sync, avoiding counter and real resource set drift when abort/watchdog/dispose
  re-enter.

### 4.2 Main and renderer transient messages

New platform messages strictly correlated by `requestId`:

- `BrowserViewScreenshotSurfacePrepare`
- `BrowserViewScreenshotSurfaceReady`
- `BrowserViewScreenshotSurfaceRelease`

A message must carry `workspaceKey`, `sessionId`, `browserId`, `browserGeneration`, `tabId` and
`webContentsId`; prepare also carries main's current actual `timeoutMs`, and when an old payload lacks it the
renderer falls back to the shared default. The renderer handles only requests whose full scope matches the
current tab/guest at once; main accepts only a ready with the same `requestId`, and a late or old-generation
receipt is dropped.

These messages express only transient rendering preparation and do not enter persisted Zustand state,
conversation facts, the relay or the replayable snapshot.

### 4.3 Renderer screenshot surface

After receiving prepare, the target browser-use tab enters a temporary `preparing` state:

1. an inactive `TabsContent` no longer uses `display:none`, `visibility:hidden` or
   `content-visibility:hidden`;
2. it is placed in a background capture layer inside the sidebar content area, keeping its real layout size but
   below the current active content;
3. the capture layer disables pointer events, keyboard focus and accessibility exposure and cannot change the
   current tab selection;
4. the original responsive viewport, guest zoom and viewport override are not rewritten here;
5. a `ResizeObserver` watches the webview, and after the width/height are stable and greater than zero for two
   consecutive animation frames, `getBoundingClientRect()` is read;
6. the renderer returns the `webContentsId` and the stable DOM viewport and enters `ready`.

The capture layer must establish an independent stacking context, and the active tab keeps its original
background and interaction level. The concrete CSS must be proven by a real Electron smoke that the guest
surface keeps compositing while covered by active content; "the element is not `display:none` in JSDOM" alone
is not completion evidence.

### 4.4 Main screenshot gate

Before executing screenshot, clip screenshot or fullPage screenshot, `BrowserGuestManager`:

1. reads the current CSS viewport through CDP;
2. calls the coordinator `prepare`;
3. validates that the `webContentsId` of ready has not changed and the viewport equals the current natural CSS
   viewport within a `1px` rounding tolerance;
4. on mismatch, keeps waiting for one stable receipt within the prepare budget;
5. only after a match calls the existing `executeBrowserCommandOnView`;
6. calls `release` in `finally`.

The existing same-tab `inFlightScreenshots` mutual exclusion stays. Surface preparation counts toward the same
screenshot request budget and cannot bypass timeout/backpressure.

### 4.5 Owner renderer + target guest activity lease

Electron's `backgroundThrottling: false` is not a single-guest isolation switch: once any WebContents in a
BrowserWindow disables throttling, the whole window and its other WebContents keep painting, and disabling it
at window creation keeps Page Visibility at `visible`. Throttling is therefore not disabled at main window
creation. The runtime also rejected "set false dynamically, set back to true afterwards": on a hidden
WebContents Electron 41's `setBackgroundThrottling(true)` restores the getter but still calls
`RenderWidgetHostImpl::WasShown()` without re-triggering `WasHidden()`, so rAF kept running and CPU did not
fall back; the API cannot serve as a reversible lease.

The final design uses the native capturer-count semantics of `capturePage()`: a hidden page counts as visible
while the capturer count is non-zero, and Chromium returns the count and restores hidden scheduling once the
capture Promise settles. The `<webview>` guest and the owner renderer are different WebContents (capturing only
the owner does not wake the guest, and capturing only the guest does not drive the owner's
`ResizeObserver + rAF` ready handshake), so the activity controller works in two phases; other guests of the
window never take part:

```text
preparing:
  owner: start A -> start B before awaiting A -> A settle -> macrotask yield -> start C -> ...
  target guest: start A -> start B before awaiting A -> A settle -> macrotask yield -> start C -> ...
  invariant: even if A/B settle immediately, no target may chain another pump turn in the same microtask drain
ready:
  owner: stop creating captures -> final captures settle -> hidden
  target guest: one 1×1 capture at most every 200ms
sibling guest: no capturer
release
  -> stop creating target guest captures
  -> await the final capture settle
  -> capturer count returns to zero
  -> Chromium restores background scheduling
```

The `1 × 1` capture only keeps the reversible activity and never reads, records or persists page images. The
overlap in Prepare lets the owner renderer finish `ResizeObserver + 2 rAF` continuously, with at most two
unsettled captures per target; after each capture settles the pump passes one macrotask boundary before the
next turn, which keeps the overlap while letting the Ready IPC and the bounded reclaim timer run. After Ready
the owner stops pumping; the target guest keeps a single-in-flight pulse with a start interval of at least
`200ms`. The real Electron smoke must prove this frequency still lets the hidden guest advance rendering while
the owner and sibling stay throttled.

Desktop main gains an injectable controller:

```ts
interface BrowserScreenshotActivityLease {
  readonly invalidated?: AbortSignal;
  markPrepared?(): void;
  release(): void;
}

interface BrowserScreenshotActivityController {
  acquire(input: {
    windowId: number;
    webContentsId: number;
    requestId: string;
    reason: "browser-screenshot";
  }): BrowserScreenshotActivityLease | undefined;
}
```

State ownership and constraints:

1. `desktopWindowChrome` no longer sets `backgroundThrottling: false` (Electron default `true`).
2. When the coordinator activates a preparation group it first obtains the owner renderer + target guest
   activity lease and only then sends renderer `Prepare`; otherwise a hidden, minimized or occluded renderer
   could not reply `Ready` because rAF and the compositor are frozen.
3. The controller verifies the target guest's `hostWebContents.id` belongs to the owner window and fails in a
   controlled way otherwise (no cross-window wake-up).
4. The first lease for an owner + guest starts one overlapping `1 × 1 capturePage()` pump each in the preparing
   phase; later leases for the same target only add a reference. A preparation group holds a single activity
   lease from prepare until all its surface leases are really released; concurrent requests for the same guest
   share the group, queued groups do not wake early.
5. After renderer `Ready` the coordinator calls `markPrepared()`: the owner pump stops and the target guest
   pump switches to the capturing mode (`200ms` minimum start interval, single in-flight).
6. When a group settles, send the renderer `Release` first, then release the activity lease; the last lease
   stops the pump and waits for the last capture to settle. `release()` is idempotent. The stop of the last
   lease is deferred by one microtask, so a synchronously activated next queued group cancels the stop (no
   capturer count dip and repeated hidden/visible scheduling).
7. A failure of any owner/guest activity capture makes the `invalidated` signal aborted; the coordinator
   rejects prepare immediately before Ready and invalidates the delivered surface lease after Ready, instead
   of silently waiting out the prepare timeout.
8. After each completed round the continuous pump passes a wakeable macrotask delay; `markPrepared()`,
   `release()` or invalidation ends the delay immediately and the phase is re-read, with no extra capture.
9. The activity controller is transient desktop-main resource state; it does not enter the renderer Zustand,
   relay, conversation fact or web remote replayable snapshot.

### 4.6 Transparent bootstrap for hidden-born guests on macOS / Windows

Capturer-count activity works for a guest that once had a surface but cannot establish the first frame of a
hidden-born guest. Desktop wiring therefore enables the `transparentWindowBootstrap` capability on macOS
hide-close and Windows close-to-tray only (not Web, mobile or Linux). When the first activity lease finds the
owner window hidden, before starting the capture pumps:

```text
snapshot originalOpacity
  -> Windows: setSkipTaskbar(true)
  -> setOpacity(0)
  -> subscribe focus
  -> showInactive()                 # does not activate the app or steal focus; transparent to the user
  -> 100ms presentation grace       # forbid concurrent CopyFromSurface
  -> owner + target guest pump establishes/maintains the first frame
  -> renderer Ready
       -> if the user has not focused: hide() -> restore originalOpacity
       -> if the user has focused: restore originalOpacity, stay visible
       -> Windows: setSkipTaskbar(false)
  -> guest paced capturer maintains the surface
  -> Page.captureScreenshot
```

1. Opacity is zeroed before `showInactive()`; no exception may show an opaque window first. The original
   opacity is restored from the snapshot, never assumed `1`.
2. Windows temporarily `setSkipTaskbar(true)` before `showInactive()` and restores `false` on every
   hidden/focus/error path, otherwise a pixel-free window could bring back the taskbar button or preview.
3. Bootstrap belongs to the first owner + guest activity state; concurrent leases for the same guest reuse it
   and never show/hide repeatedly.
4. A `100ms` presentation grace follows `showInactive()`; no activity `capturePage()` starts inside it (avoids
   concurrent CopyFromSurface before the Viz surface exists). A renderer Ready/actual screenshot may finish
   inside the grace on the transparent visible window without waiting for the timer.
5. Renderer Ready, prepare timeout, capture failure, abort, watchdog, window destroy and coordinator dispose
   all clean up the bootstrap idempotently. If the window is already destroyed, no `hide()` / `setOpacity()` /
   `setSkipTaskbar()` is called. A failing `showInactive()`, opacity or taskbar call fails the activity in a
   controlled way and never falls back to a visible `show()`.
6. An owner `focus` during bootstrap counts as the user restoring the window: restore opacity/taskbar at once
   and forbid later cleanup from calling `hide()`; the focus decision and hide/restore happen in one
   synchronous cleanup section.
7. `showInactive()` only supplies a window-level presentation opportunity and does not change the Browser API
   active tab, renderer tab selection, workspaceKey, session owner or image persistence. Bootstrap is not
   started for an originally visible or minimized window; Linux keeps the capability off.

The activity lease has an independent bounded reclaim: the host default screenshot transport budget is `30s`,
the Playwright element screenshot budget at most about `32s`, and the lease safety watchdog `35s`. The
watchdog only restores the renderer capture layer and stops the capture pump; it does not fake that the
underlying Chromium screenshot has ended. After a caller timeout/cancel the activity lease is released at once
(no continuous frames) while `inFlightScreenshots` is kept until the Chromium Promise really settles; CDP
`Page.captureScreenshot` has no reliable per-request cancel API, so a same-tab retry stays blocked without
disabling background throttling indefinitely.

## 5. Sequence

```text
CLI/runtime screenshot(tabId)
  -> desktop main / BrowserGuestManager
       -> enter per-tab viewport mutation queue
            -> CDP read CSS viewport
            -> coordinator.prepare(requestId, full scope, webContentsId, viewport)
                 -> activityController.acquire(owner window, target guest)
                      -> macOS / Windows hidden owner: opacity=0 + showInactive() bootstrap
                      -> preparing: start owner + target guest continuous 1×1 capture pumps
                           -> each completed turn yields to Electron main event loop
                 -> owner renderer
                      -> target inactive tab: hidden -> background capture layer
                      -> ResizeObserver + 2 stable animation frames
                      -> ready(requestId, webContentsId, DOM viewport)
                 <- ready
                 -> activityLease.markPrepared()
                      -> if not activated by the user: hide() + restore opacity
                      -> owner stops; target guest switches to 200ms paced capture
            -> validate guest identity + viewport
            -> Page.captureScreenshot
            -> finally coordinator.release(requestId)
                 -> renderer removes capture layer state
                 -> activity lease release
                      -> target guest stops; Chromium restores hidden scheduling
  <- PNG or structured screenshot failure
```

The sequence only synchronizes the rendering surface and does not change the tab owner, the active Browser API
tab or the user's sidebar selection.

## 6. Errors and cleanup

- Prepare waits at most `3000ms` (for slow machines or background windows; it does not replace the guest
  identity, viewport, consecutive stable frame and raster content checks). Window destruction, an unresponsive
  renderer, a zero viewport, a guest id change or cancellation all return a screenshot failure, and
  `Page.captureScreenshot` is not executed, so a known-corrupt image is never persisted.
- Main puts its current `timeoutMs` into the prepare payload; the renderer verification deadline is
  `timeoutMs + 1000ms` (default `4000ms`) as insurance against a lost Release only; the normal path is cleaned
  early by main's `Release`.
- `release` is idempotent and runs after success, CDP exception, timeout, abort and late completion; abort in
  the prepare phase, send failure, window destruction or dispose releases the activity lease, and abort after
  ready releases the surface lease automatically.
- The activity watchdog forces the group to settle, stops the pump and logs `warn`; the underlying screenshot
  keeps its `inFlightScreenshots` tombstone until it settles. Activity capture failure ends preparation
  immediately; if the surface is already Ready, the manager re-checks invalidation before returning an image.
- The renderer ignores an unknown release; a new prepare may overwrite an ended request of the same tab but not
  a different active one. High-frequency prepare/ready/release uses only `debug` logs without image base64,
  page body or full URLs.
- The automatic end-of-turn screenshot stays best-effort (record and skip the image, conversation completion
  unaffected); the explicit screenshot API returns a structured error.

## 7. Multi-client and identity boundary

- Desktop `desktop-continuous` and mobile `web-remote-replayable` still read the same successfully persisted
  image fact.
- Mobile remote control commands still reach the owner desktop window via the shared-host attachment; no
  independent browser runtime or host for mobile is created.
- `workspaceIdentity` is still isolated through `workspaceKey = workspaceIdentity?.trim() || workspacePath`;
  the existing `remoteSessionId` routing of remote workspaces is unchanged.
- prepare/ready/release do not enter the relay and carry no stream, queue, snapshot or clientMode recovery
  semantics.
- macOS, Windows and Linux share the same coordinator contract; the desktop wiring's transparent window
  bootstrap is enabled only on macOS/Windows where Electron supports opacity, and Windows also temporarily
  hides the taskbar entry. Windows high DPI is a risk surface that must be verified; the screenshot surface and
  raster contract themselves have no platform special case.

## 8. Tests and acceptance

### 8.1 Automated

1. UI: after prepare an inactive browser-use tab is no longer `display:none`, but the active tab, focus, pointer
   and accessibility do not change; restored after release.
2. Renderer IPC: no ready if any of scope, generation, tabId, webContentsId or requestId mismatches.
3. Coordinator: ready, timeout, abort, window destroyed, late ready and idempotent release. The activity lease
   is acquired before prepare; a same-guest group gets one lease; queued groups get none; the activity phase
   switches at Ready; activity invalidation, abort after prepare/send/ready, watchdog, window destroyed and
   dispose all release.
4. Manager: prepare precedes the CDP screenshot and is acquired inside the per-tab viewport mutation queue;
   success/error/abort all release; on prepare failure `Page.captureScreenshot` is not called; no successful
   image is returned after surface invalidation. Existing screenshot, clip, fullPage and in-flight backpressure
   tests keep passing.
5. Real Electron smoke: make the guest visible at `800 × 450`, set the tab inactive and resize the sidebar to
   `1274 × 720`; after prepare the screenshot is the current CSS viewport, the four corner sentinels differ and
   no `800 × 450` periodic repetition appears.
6. Real Electron activity smoke: under a hidden window the owner renderer, target guest and sibling guest all
   throttle; preparing wakes only the owner renderer + target guest; after `markPrepared()` the owner throttles
   again, the target guest advances with capture pulses no higher than 5Hz and the sibling stays throttled;
   after release and the last capture settling all three throttle again. One injected capture failure proves
   the pump stops and invalidation is reported. `getBackgroundThrottling()` stays `true` throughout.
7. Controller scheduling regression: with owner/guest `capturePage()` resolving immediately in succession,
   before the first timer turn each target has at most the initial overlapping captures, the timer can run, and
   `markPrepared()` / `release()` then stop the pump.
8. Controller window-state regression: a hidden owner runs `setOpacity(0) -> showInactive()` before the first
   capture pump; after Ready, if not activated by the user, once the presentation grace has expired and the
   target guest capturer has started, run `hide() -> restore originalOpacity`. Before the grace the owner/guest
   capture count is zero (avoids `UnknownVizError` / native crash). A `focus` during bootstrap restores opacity
   immediately and Ready/release no longer hide; a visible owner and a platform without the capability call none
   of these APIs. Windows additionally asserts `setSkipTaskbar(true)` precedes `showInactive()` and `false` is
   restored on hidden/focus/error cleanup.
9. Real Electron hidden-born smoke (macOS and Windows): hide the owner, then dynamically attach/navigate the
   guest; before the bootstrap capture is empty or fails, after it the guest first frame and the final
   screenshot are non-empty; after cleanup `isVisible() === false`, `isFocused() === false`, opacity restored,
   and a later hidden screenshot still succeeds. Windows also covers temporary taskbar hiding.

### 8.2 Acceptance

- With the conversation/another sidebar tab kept active, the end-of-turn screenshot neither switches the UI,
  flickers nor stitches repeats.
- Active and background screenshots of the same page match in content, size and scroll position.
- Windows 125%/150%/160% DPI gets at least one manual or real Electron smoke; mocks alone are not enough.
- `pnpm typecheck` and `pnpm lint` must pass.
- Hidden-born guest must be covered on real Electron macOS; Windows close-to-tray needs Windows CI/manual
  smoke, and non-Windows environments can currently cover only the taskbar lifecycle unit tests; Linux does not
  enable the transparent bootstrap.
- If CI cannot cover other macOS versions, Windows close-to-tray, Linux or minimized-window compositor, the
  commit description must list the risks and pending items.

## 9. Impact and case pruning

The change is `commit-effect + recovery + rendering/performance + app-shutdown-policy`. Owner:
`DesktopBrowserScreenshotActivityController` in Electron main (the renderer only receives prepare/release);
call chain `BrowserGuestManager -> DesktopBrowserScreenshotSurfaceCoordinator -> activity controller ->
BrowserWindow`. It affects only `desktop-continuous` local transient resources and stays isolated from
`web-remote-replayable`, the relay and snapshots; workspaceKey, tab/session ownership, image facts, UI
selection, protocol shape and user focus are unchanged.

| Case    | Initial state                    | Event                          | Expected effect                                             | Classification               |
| ------- | -------------------------------- | ------------------------------ | ----------------------------------------------------------- | ---------------------------- |
| BAS-001 | owner window in background, no screenshot | browser-use tab persists | keep default throttling, no continuous frames              | accepted                     |
| BAS-002 | owner window in background       | explicit or end-of-turn screenshot | wake owner + target guest before prepare, stop the pump after settle | accepted          |
| BAS-003 | concurrent prepare for the same guest | two requests ready        | share the surface group and one activity lease              | accepted                     |
| BAS-004 | requests for different guests queued | previous screenshot not released | only the active group's target guest is woken         | accepted                     |
| BAS-005 | timeout/abort before ready       | preparation fails              | release renderer and activity lease, run no screenshot      | accepted                     |
| BAS-006 | backend hangs after ready        | host cancel/watchdog           | restore throttling, keep same-tab in-flight re-entry guard  | accepted                     |
| BAS-007 | owner window destroyed           | any phase                      | idempotent cleanup, no access to a destroyed WebContents    | accepted                     |
| BAS-008 | mobile replayable recovery       | read the persisted screenshot  | no propagation of activity lease or new mobile runtime      | pruned; desktop-local invariant |
| BAS-009 | hidden owner; capture completes immediately | preparing continuous pump continues | yield a macrotask each round; IPC/timers can run and capture count stays bounded | accepted; root-cause regression |
| BAS-010 | macOS owner already hidden       | later attach a guest and request a screenshot | transparent bootstrap first frame; screenshot succeeds and the window stays hidden/unfocused | accepted; root-cause regression |
| BAS-011 | transparent bootstrap in progress | user actively focuses ZCode   | restore opacity immediately; Ready/release must not hide the user's window again | accepted; window state race |
| BAS-012 | Windows owner hidden to tray     | later attach a guest and request a screenshot | transparent bootstrap; taskbar does not reappear; stays hidden to tray after the screenshot | accepted; Windows peer path |
| BAS-013 | Linux or visible/minimized owner | request a screenshot           | no transparent bootstrap; follow the existing activity/close lifecycle | accepted; platform boundary |

Representative combinations are mainly "active group x lifecycle event" and are not permuted fully with tab
count, workspace type or `desktop-continuous` / `web-remote-replayable`; the full scope stays proven by the
existing coordinator identity tests.
