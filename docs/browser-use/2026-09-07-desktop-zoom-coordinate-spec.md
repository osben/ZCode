# Browser Use Coordinate Contract Under Desktop Zoom

Ticket: ZCT-2096856609784438784. Supplements the zoom boundary of the responsive-browser-viewport spec; model visual recognition is not involved.

## Behavior

- In free-size mode the viewport, screenshot pixels, model coordinates and DOM coordinates share one CSS pixel unit.
- Guest layout compensation for a fixed viewport happens only in the renderer, with the same formula for zoom-in and zoom-out: the webview layout is scaled by `1 / desktopZoom` and then composited back to the frame with `scale(desktopZoom)`. The guest's natural viewport therefore equals the target viewport whether or not CDP is attached. CDP metrics fix only the CSS viewport and the screenshot DPR and carry no `scale`; mouse events are sent in CSS coordinates unchanged (since 2026-10-16, see "Page grows and shrinks after CDP idle detach" below).
- When setting or replaying a fixed viewport, Main normalizes the guest page zoom to 1, so nothing depends on the order of renderer callbacks and Electron zoom propagation. When Desktop zoom changes the renderer still resends the current viewport once so Main normalizes the guest zoom again at the same serialization boundary.
- After a CDP idle detach, the next screenshot must restore the metrics first, even if it is already inside the viewport queue. The screenshot critical section is not equivalent to the viewport already being restored; on re-entry it must not queue again and wait for itself.
- An ordinary screenshot of a fixed viewport reads Main's `guest.capturePage()` when the preview is shrunk or Desktop is zoomed in, then normalizes to the CSS size. The renderer reporting `surfaceScale=1` only means the preview layout ratio and does not prove that the CDP raster covers the whole viewport; clip / fullPage are still executed by CDP.
- The size of the ordinary screenshot prepare layer must not exceed the host's visible window, and it temporarily derives a Fit preview; this also holds when the user selected 100% / 200%. Otherwise on Windows high DPI the Chromium guest raster crop causes an image with missing edges, and the later normalization would stretch the missing edges as if they were the full picture. The temporary prepare layer does not change the user's viewport or preview zoom preference and the original ratio is restored after release. The recording `unscaled` request keeps its original layout and 100% surface contract.
- The existing idle detach, guest lifecycle, workspace/session isolation and the desktop-continuous / web-remote-replayable routing boundaries are kept. Changes happen only on the shared guest execution side.

```text
Desktop zoom -> renderer: webview layout x1/zoom + scale(zoom)   (natural layout = viewport)
             -> viewport mutation -> CDP metrics (no scale) + guest zoom=1
                                         |
CSS input (x,y,delta) ------------------v
                                  sent unchanged
                                         |
                                         v
                           Chromium -> event at the original CSS coordinates

CDP idle detach -> next screenshot -> restore Page / metrics / guest zoom
                                         |
                                         v
                     temporary Fit inside the window (user preference kept)
                                         |
                                         v
                      Fit < 1 or Desktop zoom > 1
                            /                 \
                          yes                  no
                          |                    |
                  native capturePage       CDP capture
                          |                    |
                          +-- normalize to CSS size --+
```

## Regressions

### Page grows and shrinks after CDP idle detach (2026-10-16)

Symptom: with the app zoomed in one step and the embedded browser in free size (including the 1280x720 brought by Agent `newTab`), the page grows during each Browser Use operation and returns after about 1.5s of command idleness. Normal mode is not affected.

Root cause: the zoom-in layout compensation had been placed only in the CDP metrics `scale`, and metrics are per-session state. The command-idle detach added to prevent a UAF makes Chromium clear it; when idle the guest falls back to the webview's natural layout (the renderer applies no zoom-in compensation, guest zoom=1) and innerWidth becomes `viewport x desktopZoom`. Zoom-out already did the `1 / zoom` layout compensation in the renderer, so its two states agree.

```text
Before the fix (zoom=1.1, viewport=1280)
  during command  CDP attach -> metrics(1280, scale 1.1) -> innerWidth 1280
  idle            idle detach -> metrics cleared -> natural layout -> innerWidth 1408   <- jumps back and forth
After the fix
  renderer: webview layout x1/zoom + scale(zoom) -> natural layout innerWidth 1280
  during command / idle are both 1280; metrics fix only the CSS viewport and DPR and carry no scale
```

Independent Electron 41.0.3 experiment (macOS, Retina): with layout `vw / z` + `scale(z)`, the guest innerWidth equals vw for z=1.1 / 1.21 / 0.9, the right and bottom edge color blocks are complete, with no blank; the original zoom-in layout gives `vw x z`. The 2026-07-22 conclusion "on zoom-in a transform only enlarges the webview DOM while the raster is left blank" holds only for "no layout shrink, transform only" and does not apply here.

Unchanged: idle detach, the CDP recovery barrier, guest zoom normalization, screenshot prepare/release and the `natural | emulated` distinction. On Desktop zoom-in an ordinary viewport screenshot still uses native capture + CSS normalization (the existing guard against Windows tiling and missing edges). `appliedViewportScale` and the mouse input multiplier are removed together with the metrics scale.

Regression: the zoom coordinate E2E reads guest innerWidth/innerHeight after the idle detach and before the first command in every round, and it must equal 1280x720; the manager unit test asserts that zoom-in metrics carry no `scale` and input coordinates are not multiplied; the UI unit test asserts that the zoom-in webview layout is `1 / zoom` and the transform is `zoom`.

### Multiplier cleanup after a guest generation change (CR-01)

> Since 2026-10-16 metrics carry no scale; the multiplier state described in this section has been deleted. Kept as history.

`appliedViewportScale` mirrored the CDP metrics installed on the current guest and must not survive a guest generation change of the logical tab. A normal background fallback installed the multiplier on zoom-in; after the old guest was destroyed or replaced, a new guest using the natural viewport does not replay metrics and the leftover multiplier sent (300,200) wrongly as (330,220).

`detachGuest` clears the applied multiplier together with the fallback state. The guest-mismatch branch of an old async mutation keeps only returning and must not clear the new guest's valid multiplier. A normal CDP idle reconnect keeps using the existing metrics replay barrier, with no new state or recovery mechanism.

```text
old guest + fallback scale=1.1 -> detachGuest clears the multiplier -> new guest natural viewport -> input at original coordinates
```

Manager regression covers replacement right after fallback install, the destroyed callback and a further CDP reconnect; before the fix both tests sent (300,200) as (330,220), after the fix they pass. The real Electron regression reuses the zoom E2E and adds a normal-mode guest crash rebuild, foreground restore and click case. On macOS a hidden guest may keep the natural size and an installed fallback may be cleared by foreground restore, so the native E2E proves only that the real rebuild and click chain do not regress and does not claim to reproduce the old multiplier leftover, which is proven by the manager-targeted test. The fixed-viewport, natural screenshot and Windows fallback regressions are kept.

2026-09-08 verification: 129 manager unit tests; macOS arm64 / Electron 41.0.3 native E2E 4 cases passed (run `desktop-e2e-20260908-055435-369`, 8 PNG / 20 trusted clicks). In the new scenario guest 2 -> 3, the viewport stays 368x573 / DPR about 2.2, and a click at (100,200) really lands at (100,200). Artifacts are in that run's `zoom-coordinates/guest-recovery.{json,png}`. typecheck, lint (43 existing warnings), E2E type and fixture checks passed; Windows/Linux and mobile remote were not rerun and the E2E still awaits manual review.

### Ordinary foreground natural-viewport screenshot (2026-09-08, macOS reproduction)

On real ZCode dev / macOS at `4b9c4d51a0`, with free size exited and the app zoomed out two steps (zoom about 0.826446), the product Node REPL `tab.screenshot()` reproduced: before the screenshot the viewport was 508x855, during prepare it became 614x1034, and after release it returned to 508x855. The page media query moved the button center from (100,200) to (200,200); a trusted click at (200,200) after the screenshot missed while (100,200) hit.

Root cause: the natural viewport has no CDP metrics fixing the logical size, yet it reused the `1 / desktopZoom` guest layout expansion of the emulated viewport. Ready divided by the layout scale looked like a match, but the page had actually reflowed.

Main explicitly passes `viewportMode: natural | emulated` inside the screenshot critical section according to the actual viewport state. An ordinary foreground natural viewport is still temporarily Fit to the requested size, but the guest is not expanded and no reverse transform is applied; free size and the background fallback keep the emulated layout compensation. An old payload without the field keeps the emulated behavior, and the recording unscaled contract is unchanged. Different viewport modes do not share a prepare lease and ready must echo the matching mode.

```text
Main viewport state -> prepare(request.viewport, viewportMode)
  natural  -> temporary Fit frame -> guest original layout -> capture -> release
  emulated -> temporary Fit frame -> guest zoom compensation + CDP metrics -> capture -> release
```

The regression must go through the real Browser Use chain, recording the viewport / DPR / media query target position before the screenshot, at resize events and after release, and checking the target's actual position in the PNG and the following trusted click. Natural mode keeps the original guest, original zoom and user preference. The existing five-round free-size zoom, normal background fallback and recording unscaled regressions continue to run. This change adds only Main/renderer transient layout metadata and does not change the Agent protocol, Host routing, mobile-remote attachment, or the continuous/replayable boundary.

macOS arm64 / Electron 41.0.3 verification passed (run `desktop-e2e-20260908-042444-192`): in the new natural-mode scenario the viewport stayed 531x815 throughout with no screenshot-induced resize, the button stayed at (100,200), PNG color blocks and trusted clicks agreed; the existing five-round free-size and normal background fallback also passed, in total 3 cases, 7 screenshots, 19 trusted clicks. 244 related unit tests, typecheck, E2E type check, lint (43 existing warnings) and the fixture check passed. Evidence and platform boundary: [macOS verification record](../testing/browser-natural-viewport-macos-regression-2026-09-08.json). Windows/Linux, mobile remote and native recording were not rerun; the E2E stays pending.

### Normal-mode background fallback screenshot (2026-09-08 P2)

A background normal-mode tab may keep a fallback viewport larger than the current window. Limiting only the prepare layer size and passing Fit is not enough to enable responsive layout: the webview still shrinks with its container and ready cannot match the requested size. Every screenshot prepare must temporarily enable responsive layout and adopt `request.viewport`: Fit for ordinary screenshots, 100% for recording. After release the original mode, logical size and preview preference are restored, with the same webview / guest and no write to user settings.

```text
normal background tab + cached viewport -> small-window prepare
  -> temporary responsive(request.viewport) -> Fit -> ready -> capture
  -> release -> original normal mode / original preference / same guest
```

Regression covers width-limited and height-limited component layout probes, a real Electron background normal tab with a shrunken window screenshot and release; the existing free-size zoom E2E and recording unscaled unit tests continue to run.

Temporary responsive layout is not the same as the user entering free-size mode: the guest zoom of a normal background fallback keeps being managed by main's metrics lifecycle, and release must not restore it to the desktop zoom. A component regression checks that prepare/release do not modify the guest zoom under a non-100% app zoom; the native regression keeps CDP attached at 110% app zoom, does not reinstall metrics after release, and checks the viewport, guest zoom and three consecutive trusted clicks.

The native reproduction also showed that without the app zoom-in compensation in the normal fallback, ready passes yet the PNG color blocks are still shrunk to `1 / desktopZoom` of the coordinates. Fallback metrics must read the app zoom from the guest's owning renderer and reuse the CDP scale and input-boundary conversion of free size (this metrics-scale design was removed by the 2026-10-16 change above); the initial install, idle reconnect and re-screenshot stay consistent. App zoom-out adds no metrics scale, guest zoom stays 1, and returning to the foreground still clears the fallback to restore natural layout.

Verification requirements:

1. The same guest switching among 100% -> 110% -> 100% -> zoom-out -> zoom-in, covering Fit / 100% / 200% / 50% previews; real trusted clicks at the fixed button centers (300,200), (600,400), (1000,600) all hit, and both the PNG color block centers and the event coordinates are within 1 CSS px.
2. Each round first waits for the CDP idle detach and uses the screenshot as the first command after reconnect: the PNG must be 1280x720, the page viewport 1280x720, guest zoom=1; the screenshot content position agrees with the click position.
3. Unit tests cover the mouse path, wheel delta, tab isolation, zoom reset and the detached screenshot recovery order; the real Electron E2E verifies Chromium's actual events and image pixels.
4. Run `pnpm typecheck`, `pnpm lint` and the affected unit tests; each platform verification must state version, DPI and the actual scope executed, and history must not be counted as verification of the current patch.
5. The Windows native regression must verify both PNG content and trusted clicks, never judging a pass by image size and DOM hits alone; each round saves the PNG, page coordinates, color samples and Electron/OS/display scale information before assertions, and failing rounds keep evidence too.
6. After the screenshot the `preparing` layer must disappear and the actual `responsiveScale` must return to the user-selected 1 / 2 / 0.5; checking only the dropdown text does not prove the release chain completed. Recording unscaled layout and preference restoration remain constrained by their own unit tests.

## Windows supplementary regressions

2026-09-07, Windows 11 x64 / Electron 41.0.3, system display scale 125%: 100% passed; at 110% the PNG size and click assertions passed, but CDP tiled the smaller native raster periodically and the third button center was white. The fix reuses the existing native capture + CSS normalization path and adds Desktop zoom-in to the selection condition, without screenshot retries or relaxed pixel assertions.

Red evidence: `packages/desktop/.e2e-artifacts/desktop-e2e-20260907150411437-p10372-00512ee1039753cb/zoom-coordinates/round-1.png`; the new `surfaceScale=1` unit test returned the CDP PNG before the fix and reads the native PNG after. Per-round evidence is stored in the run artifact `zoom-coordinates/`, including the PNG, page viewport/DPR/trusted events and native color, platform, Electron/Chromium and display scale metadata.

At 200% DPI + Desktop 110%, a native PNG of 2747x1584 (the full size should be 2816x1584) was also reproduced, and after normalization the button at x=1000 became about 1025. Chromium computes the guest compositing rect by inverse-transforming the host viewport and expanding by 30%, so content outside the range never enters the raster. An independent Electron experiment that changed only the window width from 960 DIP to 1000 DIP restored the PNG width from 2721 to 2816 with the height unchanged, confirming visible-range clipping. The prepare layer width and height are capped at `100vw` / `100vh` so Fit uses a canvas inside the visible window; coordinates are not compensated by changing the user's window size, delayed retries or non-proportional stretching.

Impact boundary: Main's ordinary viewport screenshot selection and the renderer's temporary screenshot prepare layer; no new protocol, host, runtime or persisted state. Mobile Web keeps the original preview when there is no native prepare request; remote-control requests are still routed by the existing attachment to the same desktop guest, without changing continuous / replayable semantics. Mobile remote and native recording E2E were not added; recording `unscaled` keeps its original branch behavior with unit-test protection.

### Windows P2 fix verification (2026-09-08)

Increment on top of `28f297339ad2126fdd92e0e69277e432be9ae95a`: normal-mode background screenshot temporary layout, the guest zoom release boundary, and the fallback metrics zoom-in compensation (the latter removed on 2026-10-16). Old-build native red run `desktop-e2e-20260908-024203-610`: requested 1280x720, the actual webview in a 960x600 window was 960x552 and inactive, with a 3000ms prepare timeout.

| Windows display scale | Final build result | Artifact run ID                   |
| --------------------- | ------------------ | --------------------------------- |
| system native 125%    | both cases passed  | `desktop-e2e-20260908-025710-354` |
| forced 200%           | both cases passed  | `desktop-e2e-20260908-031302-774` |

Each tier keeps the original five rounds of app/preview zoom screenshots and clicks and adds one round of normal background 960x600 window with app 110% prepare/capture/release, in total 12 screenshots and 36 trusted clicks. In the new scenario ready stays 1280x720 and the three target color blocks are right; after release the same guest, normal mode, guest zoom=1 and 1280x720 viewport hold, and three consecutive clicks have a max error of 1px.

The new native scenario uses the production prepare/ready/release IPC directly, injects fallback metrics, and then runs real native capture and CDP input; it does not simulate DOM sizes or ready, but it does not represent a full-chain E2E of the manager fallback cache establishment. Manager unit tests separately verify initial fallback, hot zoom-in, idle reconnect, reset/zoom-out, native path selection and input compensation. Machine-readable evidence: [this verification record](../testing/browser-normal-fallback-windows-regression-2026-09-08.json).

340 related unit tests, `pnpm typecheck`, `pnpm lint` (43 existing warnings, 0 errors), E2E type and fixture checks passed. 100%/150% display scale only has the previous-commit record below; macOS/Linux, mobile remote or native recording were not rerun. With no native prepare, Web does not change layout; remote control is still routed to the same desktop guest and the continuous/replayable boundary is unchanged. Recording unscaled behavior is protected by existing unit tests. This case is still in manual-review/pending, and merge/release must keep the coverage limits above.

### Windows verification matrix (2026-09-07, previous commit)

Windows 11 x64 (10.0.26200) / Electron 41.0.3 / Chromium 146.0.7680.80. All are the same final-patch and strengthened case; each tier has 5 rounds, 15 trusted clicks and 5 PNGs, in total 20 rounds / 60 clicks. All PNGs and guest viewports are 1280x720, page DPR=1, guest zoom=1, the same guest throughout; the max image color block center error is 0 px, the max real click error 1 px, and screenshot release and preview restoration all passed.

| Windows display scale | How run                                 | Result | Artifact run ID                   |
| --------------------- | --------------------------------------- | ------ | --------------------------------- |
| 125%                  | system native display scale             | PASS   | `desktop-e2e-20260907-153516-455` |
| 100%                  | Chromium forced device scale factor 1   | PASS   | `desktop-e2e-20260907-153630-178` |
| 150%                  | Chromium forced device scale factor 1.5 | PASS   | `desktop-e2e-20260907-153744-604` |
| 200%                  | Chromium forced device scale factor 2   | PASS   | `desktop-e2e-20260907-153901-372` |

Per-round platform info, viewport, DPR, coordinate error and PNG SHA-256 are committed in the [machine-readable verification record](../testing/browser-zoom-windows-regression-2026-09-07.json). Raw PNG / JSON are in `packages/desktop/.e2e-artifacts/<run ID>/zoom-coordinates/`.

Patch verification: 336 related unit tests, full `pnpm typecheck`, `pnpm lint` (43 existing warnings, 0 errors), E2E type check and case-local fixture check passed. Typecheck ran after temporarily isolating pre-existing unrelated workspace changes that are not part of this commit.

Coverage limits and merge/release checks: this closes the Windows gap of SG-01; Linux was not run per this task's scope; macOS has only the historical baseline below and the current patch must not be marked three-platform passed on it. The E2E stays in `manual-review/pending` and is not yet an automatic CI gate; merge/release records must keep the platform limits above, and before claiming macOS/Linux verification passed it must be rerun on those platforms. A single machine with forced DPI is not the same as a multi-monitor cross-screen test.

## Historical baseline verification (2026-09-07)

macOS arm64 / Electron 41.0.3 record of the original branch `8a669c3b9279bf3bf55d2ae7adbe5239c7644b94`: case-local model replay drives the real Node REPL -> Host/Main -> Chromium; a single guest over 5 consecutive rounds 0/+1/0/-2/+2, all 15 trusted clicks hit under Fit/50% with max error 1 px; all PNGs 1280x720, button pixel coordinates agree, guest zoom=1. 206 related unit tests, typecheck, lint (43 existing warnings), E2E type check and fixture check passed. The Windows patch has not been rerun on macOS.

## How to run on Windows

In PowerShell at the repository root, set the case-local replay; only model decisions are replayed, and Electron / guest / compositor / CDP / trusted input are all real:

```powershell
$env:ZCODE_E2E_MANUAL_REVIEW = '1'
$env:E2E_PROVIDER_HTTP_MODE = 'replay'
$fixtures = Join-Path (Get-Location).Path 'packages/desktop/test/e2e/fixtures/deepseek'
$env:E2E_PROVIDER_REPLAY_FIXTURE_PATH = "$fixtures/common.json,$fixtures/conversation-session/conversation-session-browser-zoom-coordinates.json"
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/conversation-session-browser-zoom-coordinates.test.ts'
```

The DPI extension runs on the same Windows native Electron with `--force-device-scale-factor=1/1.5/2`, which does not represent three different physical-DPI machines. Place the following temporary config at `packages/desktop/.e2e-artifacts/browser-zoom-dpi.wdio.ts`, then run `pnpm --filter @zcode/desktop exec wdio run ./.e2e-artifacts/browser-zoom-dpi.wdio.ts --spec <the spec above>`:

```typescript
import { config } from "../wdio.conf.js";
const scale = Number(process.env.ZCODE_ZOOM_TEST_DPR);
if (![1, 1.25, 1.5, 2].includes(scale)) throw new Error("Expected DPI scale 1/1.25/1.5/2");
for (const capability of config.capabilities as Array<Record<string, any>>) {
  capability["wdio:electronServiceOptions"].appArgs.push(`--force-device-scale-factor=${scale}`);
}
export { config };
```

With an existing build of this branch you can set `ZCODE_E2E_SKIP_BUILD=1` and `ZCODE_E2E_SKIP_AGENT_BUILD=1`; the renderer must be built with `VITE_ZCODE_E2E_STORE_BRIDGE=1`. The host output of `pnpm typecheck` and the tsup bundle share `out/host`, so it must run serially with the native E2E; if the E2E runs after typecheck, rebuild tsup and do not reuse a host bundle overwritten by tsc.
