# Browser Use Screenshot Raster Surface under Windows Negative Zoom and Fit

Date: 2026-07-24
Status: corrected against Windows Electron runtime evidence and implemented

## 1. Problem and runtime evidence

With Windows Desktop global zoom `-2` (factor `0.826446...`), the first fix turned the fixed `1500ms` surface
preparation timeout of Browser Use screenshots into a success, but the returned `1280 × 720` PNG contained an
exact tiling (repeat period `800px` horizontally and `450px` vertically, zero sampled error at a `450px`
vertical offset). The tool result held a single image, so this is not a duplicate insertion by the conversation
UI. The model called `tab.screenshot()` once; the extra end-of-turn screenshot the Browser runtime issues before
`turnEnded` is existing best-effort behavior and not the cause of the tiling inside one PNG.

## 2. Root cause

The responsive viewport's logical size is `1280 × 720`, but the Fit preview in the sidebar only gets a real
compositor surface of `800 × 450`; Windows display scale, Desktop negative zoom and the Electron guest surface
do not provide a backing raster large enough for the target CSS viewport, unlike macOS Retina. The first fix
only restored the negative-zoom-compensated raw layout (`1549 × 871 / layoutScale 1.21 ≈ 1280 × 720`) to the
logical viewport and sent ready from it. That proves only that the guest's CSS/layout coordinate system is
right, not that the native raster covers the same size; after the wrong ready main called
`Page.captureScreenshot` and Chromium periodically filled the output with the `800 × 450` surface.

```text
CSS viewport 1280 × 720
  -> responsive Fit visualScale = 0.625
  -> Windows guest compositor surface = 800 × 450
  -> renderer falsely reports ready from logical layout only
  -> Page.captureScreenshot target = 1280 × 720
  -> 800 × 450 surface is tiled periodically
```

The preparation protocol therefore lacks a second dimension: besides the logical viewport it must carry the
current compositor/preview scale and use it to choose the truly available screenshot source. Real Electron
probes showed that capture-only CDP metrics cannot repair it (see §6); the one thing that works is calling
`guest.capturePage()` in the main process, which returns the correctly composited surface, and after
high-quality normalization to the logical viewport all four corner sentinels are correct with no `800 × 450`
period. The final design keeps the `surfaceScale` contract and reads the main guest surface for ordinary
viewport screenshots when `surfaceScale < 1`.

## 3. Goals and non-goals

### 3.1 Goals

1. With Windows Desktop zoom `< 1` and responsive Fit `< 100%`, screenshots still output a PNG of the CSS
   viewport size with correct corners and no periodic tiling.
2. The user's current Fit/fixed-ratio preview, sidebar tab, focus, mouse mapping and accessibility state are
   unchanged.
3. macOS Retina, Windows high DPI, Linux, Desktop zoom `>= 1` and non-responsive viewports keep the same
   cross-platform path with no platform special cases.
4. If prepare, capture or restore fails at any step, an image that may be tiled is never returned or
   persisted.
5. Explicit and end-of-turn screenshots share the fix; the extra end-of-turn screenshot count itself is out of
   scope.

### 3.2 Non-goals

- No detecting, cropping or deduplicating already-corrupt tiles; size normalization applies only to the
  correct composited surface returned by `capturePage()`.
- No temporary switch of the responsive preview to `100%` (avoids visible jumps, cropping and focus changes).
- No second Browser runtime, second guest or mobile-specific screenshot path.
- No change to conversation stream, snapshot, queue, owner/lease or `desktop-continuous` /
  `web-remote-replayable` semantics.

## 4. Design

"Ready reports preview surface scale + main guest surface capture + CSS-size normalization."

### 4.1 Renderer ready contract

Screenshot surface ready reports the current responsive preview scale in addition to the existing full
identity and logical viewport:

```ts
interface BrowserViewScreenshotSurfaceReadyPayload {
  // existing identity and viewport fields
  surfaceScale: number;
}
```

`surfaceScale` is the preview ratio of the current guest compositor surface to the logical viewport:

- responsive Fit/fixed ratio uses the visual scale the renderer actually applied;
- ordinary mode is `1`;
- must be finite and greater than `0`;
- the renderer sends ready only after two consecutive animation frames confirm a stable guest id, logical
  viewport and surface scale.

"Normalized offset equals logical viewport" no longer means the raster is ready; that value only validates the
logical viewport.

### 4.2 Main guest surface capture

While `BrowserGuestManager` holds the surface lease:

1. validate the lease's guest identity and logical viewport;
2. for an ordinary viewport screenshot with `surfaceScale < 1`, call `guest.capturePage()` directly in the
   main process to read the visible surface Electron composited correctly;
3. use the existing host `nativeImage` high-quality resize to normalize the surface PNG to the logical
   viewport size;
4. `surfaceScale >= 1`, clip and fullPage keep the existing CDP screenshot path;
5. on success, error, cancel or late settle, release the surface lease after the underlying operation ends.

The call runs on the main-side guest `webContents`, not the renderer's `<webview>.capturePage()`, which
historically triggered a V8 FATAL and stays forbidden. The final path changes no metrics, DPR, media query,
DOM geometry, tab state or user focus and has no Windows branch.

### 4.3 Errors and recovery

- Invalid or unstable `surfaceScale`: prepare does not become ready and ends in the existing structured
  timeout.
- Main guest capture or CSS-size normalization fails: the explicit request returns a structured
  `execution_error`; it does not fall back to the known-tiling CDP viewport image.
- Guest changes before capture: abort the request; never use the old lease on a new guest.
- Automatic end-of-turn screenshots stay best-effort and skip failed images without affecting normal task
  completion.

High-frequency prepare/ready/capture/release details log at `debug` only and never record image base64 or
page text.

## 5. Sequence

```text
Browser screenshot request
  -> main read logical viewport
  -> renderer compose target guest
       -> stable guest id
       -> stable logical viewport 1280 × 720
       -> stable surfaceScale 0.625
       -> ready
  -> main acquire surface lease
  -> verify guest identity
  -> main guest.capturePage() reads the correct 800 × 450 composited surface
  -> nativeImage high-quality normalize to 1280 × 720 CSS size
  -> release surface lease
  -> return PNG
```

The chain does not change the guest or the responsive frame geometry the user sees.

## 6. Rejected alternatives

- **Temporarily switch the responsive DOM frame to 100%.** It enlarges the surface, but the same guest is the
  visible preview; switching flickers, crops or changes the sidebar scroll extent and adds separate
  active/inactive tab behavior.
- **`fromSurface=false` or only `captureBeyondViewport`.** Earlier Electron isolation tests showed
  background/occluded guests may return a black image or wrong size, and the old surface tiling is not fixed
  (consecutive tile capture may even hang).
- **Detect and crop/deduplicate corrupt images.** It cannot prove the first tile covers the whole viewport and
  breaks the correspondence between screenshot coordinates and later click coordinates.
- **Capture-only CDP metrics scale.** Windows Electron probes showed `Emulation.setDeviceMetricsOverride(scale:
1 / surfaceScale)`, temporary `deviceScaleFactor`, page scale and guest zoom changes still tile, and
  `dontSetVisibleSize: false` is rejected by the guest widget. Do not rely on a CDP parameter combination that
  only holds in mocks.

## 7. Tests and acceptance

Implemented with strict TDD:

1. Shared/UI: the ready payload validates and reports a stable `surfaceScale`; negative-zoom raw layout is
   used only for the logical viewport and no longer means raster ready.
2. Coordinator: full identity, viewport and surfaceScale validation; invalid, changed and late ready must not
   establish a lease.
3. Manager: an ordinary viewport screenshot with `surfaceScale < 1` must call main `guest.capturePage()` and
   normalize to the logical viewport; success, error, cancel and guest change all release after the
   underlying operation settles.
4. Executor: only ordinary viewport screenshots use the injected guest surface; clip, fullPage and quality
   recapture keep the existing CDP/CSS pixel contract.
5. Electron compositor smoke:
   - logical viewport `1280 × 720`;
   - historical/visible surface `800 × 450`;
   - Windows scale factor `1.25` and Desktop zoom `-2`;
   - before the fix the test must detect the `800 × 450` periodic tiling;
   - after the fix the PNG is `1280 × 720`, the four corner sentinels differ, and the horizontal/vertical
     period match rate is below the threshold.
6. Product regression: restart dev desktop, and at zoom `-2` have a real model open `example.com` and take an
   explicit screenshot; the image must actually be viewed, not passed on `ok=true` and IHDR size alone.
7. Run `pnpm typecheck` and `pnpm lint`.

## 8. Multi-client and architecture boundary

- The change lives only in the transient screenshot coordination between the Desktop owner renderer and main.
- Web/mobile do not create an independent embedded browser runtime; they still read the image facts the
  desktop persisted successfully through the shared-host attachment.
- `workspaceKey = workspaceIdentity?.trim() || workspacePath`, `remoteSessionId` and the full
  browser/session/tab identity continue through prepare/ready/release.
- No new relay business state; screenshot surface state is not written to the replayable snapshot.
- If the current machine cannot cover macOS/Linux, the commit description must state that Windows is verified
  and other platforms await CI regression.
