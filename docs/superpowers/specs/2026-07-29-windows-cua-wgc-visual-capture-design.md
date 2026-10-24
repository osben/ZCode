# Windows CUA WGC Visual Capture Design

## Background

The Windows source Helper already has the UIA element tree, pointer input and the native text clipboard, but
the visual chain is a placeholder: `captureWindowImage` of `ax_native.node` returns `null`, the Windows
`SystemSurface` declares `supportsScreenCapture=false`, `screenshot` cannot capture the selected display,
`get_app_state(include_screenshot=true)` returns UIA state without an image, and `space:"state_image"` /
`space:"screenshot"` have coordinate semantics but no Windows image source. macOS has a complete loop of
"window identity verification + window image + state cache"; Windows takes the same product boundary with
Windows Graphics Capture (WGC) as the pixel source, which supports target windows occluded by ordinary
windows. This design covers only the local Windows source Helper; macOS, Linux, SSH, WSL, Docker, remote
workspace, mobile `/remote` and the product packaging chain are unchanged.

## Goals

This phase completes the Windows local visual loop in one go:

1. `screenshot` captures the user-selected display, keeping the origin of a negative-coordinate display.
2. Capture a given HWND and return the target window content even when it is fully occluded by other ordinary
   windows.
3. `get_app_state(include_screenshot=true)` attaches the window image of the same verified observation to the
   state.
4. Reuse the existing `state_id`, `space:"state_image"` and latest-screenshot visual-frame semantics; no new
   screenshot revision protocol.
5. Verify the display or window identity, process, executable path and bounds before and after the screenshot,
   refusing to stitch a stale UIA tree and a new image into one state.
6. Native capture and PNG encoding run in a background worker and do not block the N-API/V8 main thread.
7. The capability is true only when the complete, callable WGC chain exists.
8. Keep the existing 30 MCP tool names, parameters and tier/annotation unchanged.

## Non-goals

Refactoring the macOS/Linux/Electron visual chain; SSH, WSL, Docker, remote workspace, mobile `/remote`;
product installer, signing, store identity, manifest, prebuilt x64/arm64 artifacts; the restricted "no yellow
capture border" capability (source development accepts the system default WGC border); BitBlt, PrintWindow,
PowerShell, external commands, Electron `desktopCapturer` or private binaries as fallbacks; a Rust/napi-rs
sidecar or extra resident process; moving UIA reads into a worker; an independent `screenshotId` handle or MCP
tool schema change; video, streaming, picture-in-picture, multi-frame diff; a "successful screenshot" promise
for minimized windows (they fail honestly); full HDR color management (the first phase outputs SDR BGRA8 PNG).

## Confirmed design

Use the existing Windows C++ addon `ax_native.node`, add a C++/WinRT + D3D11 + WIC implementation, and expose it
to TypeScript through an N-API async Promise.

Rejected alternatives:

1. **Rust/napi-rs sidecar**: adds processes, toolchain, release artifacts and a protocol boundary, unsuited to
   the fast loop of the current source Helper.
2. **Electron `desktopCapturer`**: couples the standalone Node Helper back to the desktop renderer/main and
   breaks the current boundary where the Helper can start independently.
3. **BitBlt/PrintWindow/PowerShell**: cannot reliably meet the occluded-window semantics and introduces
   different permission, color, DPI and lifecycle behavior.

Technical basis:

- [`IGraphicsCaptureItemInterop`](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nn-windows-graphics-capture-interop-igraphicscaptureiteminterop)
  provides `CreateForWindow` and `CreateForMonitor`, allowing a capture item to be created from an
  HWND/HMONITOR;
- [`Direct3D11CaptureFramePool.CreateFreeThreaded`](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded)
  fires the frame event on an internal worker thread and does not require the calling thread to own a
  `DispatcherQueue`;
- the [Windows screen capture docs](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
  require checking `GraphicsCaptureSession.IsSupported` first and describe the WGC frame-pool/session
  lifecycle;
- the [Windows app capability docs](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations)
  say restricted capabilities belong to the product manifest/release boundary, so "no system border" is not
  mixed into the source runtime acceptance in this phase.

## Architecture and event order

```text
screenshot / get_app_state(include_screenshot=true)
  |
  v
TypeScript capability + target identity gate
  |
  v
native Promise
  |
  v
Napi::AsyncWorker (background MTA)
  |
  +--> IGraphicsCaptureItemInterop
  |      +--> CreateForMonitor(HMONITOR)
  |      `--> CreateForWindow(HWND)
  |
  v
Direct3D11CaptureFramePool::CreateFreeThreaded
  |
  v
wait for the first valid frame / target closed / deadline
  |
  v
copy only ContentSize into a D3D11 staging texture
  |
  v
WIC in-memory PNG encoding
  |
  v
verify monitor/HWND/PID/exe/bounds again
  |
  +--> screenshot: write the latest visual-frame
  |
  `--> get_app_state: image and UIA state enter the state cache together
                         |
                         `--> state_id + space:"state_image"
```

All state association is still owned by the existing broker:

```text
display screenshot N
  `--> visual-frame N (origin = physical bounds of that display)
       `--> space:"screenshot" may reference only the current visual-frame

window capture_app N
  `--> UIA tree N + PNG N + capture bounds N
       `--> state_id N
            `--> space:"state_image" may reference only the image of state_id N
```

The next screenshot/zoom replaces the session's current visual-frame; the next `get_app_state` generates a new
`state_id`. The existing protocol therefore already has a screenshot version boundary and needs no
`screenshotId`.

## Native ABI

Additive, optional exports on the Windows addon:

```ts
type NativeScreenCaptureSuccess = {
  ok: true;
  format: "png";
  data: Uint8Array;
  width: number;
  height: number;
  bounds: [number, number, number, number];
};

type NativeScreenCaptureFailure = {
  ok: false;
  error:
    | "unsupported"
    | "unavailable"
    | "busy"
    | "timeout"
    | "invalid_target"
    | "target_changed"
    | "too_large"
    | "device_lost"
    | "capture_failed"
    | "encode_failed";
};

type NativeScreenCaptureOutcome = NativeScreenCaptureSuccess | NativeScreenCaptureFailure;

interface AxWinNativeAddon {
  isScreenCaptureSupported?(): boolean;

  captureMonitorPngAsync?(
    bounds: [number, number, number, number],
  ): Promise<NativeScreenCaptureOutcome>;

  captureWindowPngVerifiedAsync?(
    windowId: number,
    pid: number,
    expectedCanonicalBundleId: string,
    expectedBounds?: [number, number, number, number],
  ): Promise<NativeScreenCaptureOutcome>;
}
```

`data` may be carried by a Node `Buffer` in the implementation, but the ABI validates it as `Uint8Array`, so
upper layers do not rely on Buffer-only methods. A failure outcome does not expose HRESULT, system error text,
window title, executable path, image content, pipe or token.

The three exports must exist as a group. An old addon, a partial export set, an abnormal return value or a
rejected Promise all fail closed; falling back to a synchronous placeholder function is not allowed.

## Display location

The broker has already chosen the display and holds its physical bounds. Native does not trust the `HMONITOR`
number exposed to JS to stay valid; it:

1. receives `[x, y, width, height]`;
2. enumerates current displays and finds the `HMONITOR` whose bounds match exactly;
3. re-reads the bounds once before creating the WGC item;
4. after the PNG is done, confirms again that the display still exists and its bounds have not changed;
5. returns `target_changed` for any mismatch.

The `bounds` of a success outcome are the finally verified physical bounds of the display. Negative `x/y` are
kept and not zeroed; the visual-frame uses these bounds as the origin from global to image coordinates.

## Window identity and bounds

Window capture receives the HWND, the expected PID, the normalized executable path and the optional bounds from
the time of UIA observation. The same verification runs before and after capture:

1. `IsWindow(hwnd)` is true;
2. `GetWindowThreadProcessId` equals the expected PID;
3. the queried canonical executable path equals the expected bundle id;
4. the target is not the Helper itself, the lock-screen shell or a known protected system desktop;
5. the target process is not above the Helper's integrity level;
6. `IsIconic(hwnd)` is false and the window width/height are greater than zero;
7. `GetWindowRect` is a valid physical coordinate;
8. if the caller passes the UIA observation bounds, they must be equal before capture starts;
9. after capture, the HWND, PID, exe and bounds must still equal those at the start.

If the window, process or bounds change during observation, return `target_changed`. For `get_app_state` this
error fails the whole observation and requires a re-observation; an old UIA tree must not be combined with an
image from another moment.

The WGC frame pixel size and `GetWindowRect` may be affected by system borders or platform implementation
details. The `bounds` of a success outcome are the desktop physical coordinate range re-checked before and after
capture, and `width/height` are the PNG pixel size; the upper layer builds the `state_image` coordinate mapping
from these two, neither blindly trusting the earlier UIA outer bounds nor assuming 1:1 when they disagree.

## Pixel pipeline

Each capture worker destroys the capture session right after one image is done:

1. create a BGRA-capable D3D11 device;
2. prefer a hardware adapter, allow a WARP device on failure; WARP is still the WGC path, not a BitBlt
   fallback;
3. wrap the DXGI device as a WinRT `IDirect3DDevice`;
4. create a 2-buffer frame pool with `Direct3D11CaptureFramePool::CreateFreeThreaded`, avoiding the
   DispatcherQueue dependency;
5. create the capture session and start it;
6. wait for the first frame of valid size while listening for item closed and the deadline;
7. copy only the frame `ContentSize` range, refusing historical edge pixels from a reused texture;
8. copy into a CPU-readable staging texture and read by `RowPitch`;
9. encode a BGRA8 PNG in memory with WIC;
10. close the session/frame pool and release the staging, D3D, WinRT and event objects.

The output is a non-interlaced standard PNG. The first phase uses SDR BGRA8; color precision on HDR displays is
a known limitation, but capture success must not be falsely reported with a blank image because of it.

## Threads, concurrency and resource limits

WGC and encoding must not run on the JS main thread:

- each call uses a `Napi::AsyncWorker`;
- the worker initializes MTA and catches all C++/WinRT exceptions inside the worker;
- `NAPI_DISABLE_CPP_EXCEPTIONS` keeps constraining node-addon-api; WinRT exceptions must not cross the
  worker/native ABI;
- a dedicated `std::timed_mutex g_screenCaptureMutex` allows at most one WGC capture per Helper at a time;
- waiting for the capture mutex is at most 250ms, then return `busy`;
- the first valid frame deadline is 2000ms, then return `timeout`;
- maximum single side 16,384 pixels;
- maximum total pixels 33,554,432 (covers a single 8K display);
- maximum PNG 128 MiB;
- an over-limit request returns `too_large` before allocating large staging/PNG memory.

On Helper shutdown, stop new admission first. A worker checks the shutdown state before creating the session and
after getting a frame; an accepted worker closes the session, frame pool and D3D/WinRT objects through RAII
before completing the Promise. No capture thread, window, process or on-disk temp image may be left behind.

## Capability and status

Windows `supportsScreenCapture` is true only when all of these hold:

```text
platform == win32
AND interactive desktop preflight passed
AND isScreenCaptureSupported() == true
AND typeof captureMonitorPngAsync == "function"
AND typeof captureWindowPngVerifiedAsync == "function"
```

`isScreenCaptureSupported()` uses `GraphicsCaptureSession::IsSupported()` internally and confirms the running
system supports `IGraphicsCaptureItemInterop::CreateForWindow/CreateForMonitor`.

Status semantics:

- complete chain present: `screenCaptureStatus="granted"`;
- non-interactive desktop, lock screen/secure desktop or a startup preflight rejection: `"denied"`;
- old addon, unsupported system or incomplete ABI: `"unknown"`, with the capability false at the same time.

The capability means the current source Helper can run visual capture; it does not mean the product installer,
signing or the no-border capability is done.

## TypeScript integration

### Adapter

`createNodeAutomationAdapter` follows the grouped capability pattern of the native clipboard:

- with the full Windows three exports, directly await native capture;
- the Windows SystemSurface stays a fail-closed surface without screenshots and gets no external fallback;
- macOS/Linux keep using the existing SystemSurface;
- a malformed outcome, a synchronous throw and a Promise rejection all map to a sanitized broker error.

`captureScreenPng(area)` calls monitor capture and converts a success result into the existing screen capture
structure. It caches no second image; the session visual-frame is still built by the existing backend.

### App state

`createAxWinReadOnlySource` gains an injectable verified window capture callback:

- with `includeScreenshot=false` WGC is not started;
- with `includeScreenshot=true`, first obtain the UIA snapshot and window identity, then call verified
  capture;
- on success attach the PNG, the actual bounds and the pixel size;
- `invalid_target` / `target_changed` fail the whole observation;
- when identity is stable but there is `busy`, `timeout`, `device_lost`, `capture_failed` or `encode_failed`,
  the UIA tree may be kept with `screenshot=null` plus an additive, sanitized `screenshot_error` warning;
- a state without an image builds no `state_image` visual target, and a later `space:"state_image"` must be
  rejected explicitly with a request to re-observe.

This neither drops usable UIA information because of one read-only visual failure nor lets the model believe
the state contains an image.

## Error mapping

| Native error                        | Broker semantics                        | Retry rule                                                    |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| `busy` / `timeout`                  | `timeout`                               | read-only observation may be retried explicitly by the caller |
| `unsupported`                       | capability false / `not_authorized`     | no retry in this session                                      |
| `unavailable`                       | `internal` or startup capability false  | retry explicitly after the environment recovers               |
| `invalid_target` / `target_changed` | `element_unavailable`, ask to reobserve | old state not reused                                          |
| `too_large`                         | `invalid_request`                       | retry after shrinking the target                              |
| `device_lost`                       | retryable `internal`                    | no automatic action replay, only retry read-only capture      |
| `capture_failed` / `encode_failed`  | sanitized `internal`                    | retry explicitly                                              |

Visual capture is a read-only operation and may be retried explicitly; later actions such as click and typing
still follow the original delivery-state, and a visual failure must not trigger automatic action replay.

## Coordinate consistency

The Windows process already uses `PER_MONITOR_AWARE_V2`, so UIA, `GetWindowRect`, monitor bounds and WGC capture
bounds are all interpreted in physical pixels.

### `space:"screenshot"`

```text
global physical coordinate = screenshot image coordinate + selected monitor bounds origin
```

Negative coordinates of a non-primary display must be kept. The next screenshot or zoom replaces the current
visual-frame, and old screenshot coordinates must not keep being used.

### `space:"state_image"`

```text
global physical coordinate = state_image image coordinate + state capture bounds origin
```

The state cache stores the actual bounds and pixel size of the native success outcome. If the actual pixel size
disagrees with the bounds width/height, the upper layer must scale explicitly per the existing image transform;
it must not default to 1:1 and silently click the wrong position. A window move, resize, minimize, destroy or
HWND/PID reuse invalidates the old state.

## Safety and privacy

- A non-interactive desktop, lock screen and secure desktop are not captured.
- High-integrity-level targets are not captured.
- Native and TypeScript logs contain no PNG, pixel digest, window title, executable path or user content.
- PNGs are not written to disk by default.
- High-frequency capture allows only `debug` lifecycle statistics, recording only the result category,
  duration and size, never content.
- Error messages use fixed error codes only.
- The live smoke uses a non-sensitive marker and prints neither the marker nor image content.

The source development phase accepts the Windows-provided capture border, which is part of how the system
shows the user the capture behavior; it is not bypassed through hidden windows, manifest tricks or private
APIs.

## TDD and verification strategy

Failing tests first, in this order:

1. **ABI/type:** enabled only with all three exports; a missing export, old addon, non-function, malformed
   outcome or rejected Promise fails closed; a Buffer can be consumed as a Uint8Array.
2. **adapter:** monitor/window success; every native error maps to a broker error; Windows never falls back to
   the SystemSurface; macOS/Linux do not read the Windows ABI.
3. **state source:** `includeScreenshot=false` does not capture; image and actual bounds enter the same state;
   an identity/bounds change fails the whole observation; a transient failure keeps the UIA tree but has no
   `state_image` target.
4. **native source:** CreateForWindow/CreateForMonitor, free-threaded frame pool, hardware/WARP order,
   ContentSize crop + RowPitch + WIC PNG, mutex/deadline/size guards/RAII cleanup, pre/post identity and
   bounds checks, fixed error codes without HRESULT text.
5. **MSVC compiled addon:** three exports present; capability truly returned on supported systems; invalid
   bounds/HWND return structured failures without crashing.
6. **broker/source Helper:** `broker_info.capabilities.screen_capture`; `screenshot` builds the right monitor
   visual-frame; `get_app_state` builds a state with an image; `state_image` fails closed without an image;
   normal Helper shutdown with no orphan.
7. **Gates:** zcode-cua focused/full tests, build, typecheck, lint; ZCode CUA focused tests, `pnpm typecheck`,
   `pnpm lint`; existing non-CUA baseline failures are listed separately, never reported as all green.

## Live smoke

Off by default, explicit opt-in, only on an ordinary unlocked desktop, using a controlled test window or an
ordinary app started during the test:

1. Start the source Helper, confirm the capability is true; capture the selected display, parse the PNG header
   and check width/height and monitor origin.
2. Start an identifiable test window and record HWND/PID/bounds; capture it; fully occlude it with another test
   window and capture by HWND again; both captures are valid, non-empty target images, not the occluder.
3. `get_app_state(include_screenshot=true)` returns the image, a new `state_id` and the right capture bounds;
   `state_image` coordinate conversion hits a preset safe target.
4. Minimize the target and confirm fail closed; restore all foreground, window positions and test resources,
   close the Helper and confirm no orphan.

Any restore failure fails the smoke. Lock screen, LockApp, no foreground and non-interactive desktop are
recorded as "environment not met" and never as live acceptance passed.

## Acceptance

- The Windows source Helper's `screen_capture` capability is true under the complete WGC ABI.
- `screenshot` returns a valid PNG of the selected display and handles negative-coordinate origins correctly.
- A given HWND fully occluded by an ordinary window still yields the target window image.
- `get_app_state(include_screenshot=true)` returns the UIA tree, PNG, bounds and a new `state_id` of the same
  verified window observation.
- `space:"state_image"` uses only the image and capture bounds of the corresponding state.
- A change of target identity or bounds produces no mixed state.
- Minimized, high-integrity, lock-screen/secure-desktop and invalid-HWND targets all fail closed.
- An old/half-implemented addon does not falsely report the capability.
- There is no BitBlt, PrintWindow, PowerShell, external command or Electron fallback.
- The native worker does not block the JS main thread, and after Helper exit no thread, process or temp image
  remains.
- macOS/Linux, the 30-tool surface and remote/mobile chains have no behavior change.
- Automated gates meet each repo's existing requirements, and the opt-in live smoke on an ordinary unlocked
  desktop has clear evidence.

## Known risks and later product loop

WGC's default system border may enter the visual experience (going borderless needs a product
identity/manifest/capability review); HDR to SDR color needs later tone mapping; some GPUs/drivers may hit
device lost (only a recognizable error, no automatic recovery); WGC, `GetWindowRect` and the visible content
boundary may differ, so the mapping must use the returned capture bounds/size; 8K PNG peak memory is high
(pixel and PNG caps protect it, product-phase stress testing still needed); x64/arm64 prebuilt addons,
installer signing, upgrade compatibility and release smoke belong to the later product loop.
