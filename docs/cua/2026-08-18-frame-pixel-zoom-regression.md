# CUA Screenshot Pixel and Zoom Regression Record

Status: producer, standalone MCP, ZCode Agent and visible Desktop Kimi K3 real-device chains all pass. Open: the Skill-trimming candidate awaits MR/CI re-verification; the transparent-overlay pixel-ownership fix has landed in the producer and the catalog pin was bumped (see 0.5.8).

## 0.5.8 transparent overlay windows silently steal coordinate clicks

0.5.6 unified capture and dispatch pixel ownership on the WindowServer snapshot, which works as intended; this round exposed a gap in the ownership candidates themselves. Coordinate click delivery is `SLEventPostToPid` pinned to the resolved owner window with no OS hit-test behind it, so "the first front_to_back window whose bounds contain the point" is the hit-test itself. Any on-screen window covering the point steals the click, whether or not it has drawn pixels there, and the tool still returns success.

Trace `model-io-sess_364a4761` (2026-08-19 19:19-19:53, Helper 3.8.1 / producer 0.5.7) lost three clicks in a row; the returned `resolved_app_ref` recorded the actual delivery targets:

| Request # | Window that received the click                                                  | layer    | bounds              |
| --------- | ------------------------------------------------------------------------------- | -------- | ------------------- |
| 18        | `com.electron.lark.iron` (Lark screen-sharing prompt layer LarkSSPromptWindow)  | non-zero | `[0,0,1512,982]`    |
| 25        | `com.volcengine.corplink.networkextension-wrapper` (Corplink network extension) | 25       | `[0,0,1512,982]`    |
| 31        | `now.typeless.desktop` (Typeless "Status")                                      | 1001     | `[381,482,750,500]` |

All three had `isError=false`. 22 tool calls were spent locating and moving these invisible windows. On a machine with Corplink installed any point on the main display attributes to its wrapper window, so coordinate clicks are not flaky but unusable across the whole screen.

Alternative criteria fail (all 26 on-screen windows on one machine measured):

- `kCGWindowIsOnscreen` is true for all three, as it is the snapshot precondition anyway.
- Window-level `kCGWindowAlpha` is 1.0; the transparency exists only in per-pixel alpha (the Corplink window is uniformly 4/255 over 2.39 million pixels), which the existing `alpha<=0` filter cannot see.
- Excluding `layer!=0` would wrongly kill 13 layer-25 `com.apple.controlcenter` menu-bar items and 3 Notification Center desktop widgets, and would miss Lark's layer-0 ghost window that shares the real window's bounds and sorts before it.
- `SLSFindWindowByGeometry` is only a geometry/shape query and returns the same overlay for the same points.
- Per-window `CGWindowListCreateImage` alpha capture can separate them but costs 75-85 ms per candidate, unusable on the delivery path.

The criterion is the event mask the window declares to WindowServer: the `kCGEventLeftMouseDown` bit of `SLSGetWindowEventMask`. Overlay windows measure `0x00005c28` / `0x00005c08` (bit 0); all real click targets measure `0xee5cffde` or `0xee5efffe` (bit 1). This also explains why users did not notice: overlay windows are click-through, so real clicks pass through, and only a synthetic delivery pinned to a window forces the event onto a window that declared it takes no clicks.

The delivery mechanism is unchanged; only the candidate filtering before the existing `SLEventPostToPid` path changed, so background operation, not stealing focus and not moving the system cursor all hold. The fail-closed error now names the skipped windows' identity and the recovery points at `open_application(activate=true)` to raise the target window instead of moving overlay windows in the user's environment.

The producer contract and measurements are in upstream `docs/frame-pixel-zoom-regression.md` section v0.5.8. Producer commit `baa016908` merged to upstream main with `da7cbaf241cc2c279fdc4cbd30df9a990db559ec`, and the catalog pin was bumped to that sha. Real-device re-verification case: with Corplink (or any transparent full-screen overlay) in place, make a pure coordinate click in its covered area; before the fix it was silently mis-delivered to the overlay and returned success, after the fix it must hit the visible layer-0 window beneath, while layer-25 menu-bar status items remain clickable by coordinate. Lark's layer-0 ghost window with the same bounds sorted before the real window is a second live case of the same class on which a layer-only filter still gives dead clicks.

## 0.5.7 Skill trimming and Zoom usage boundary

The official Computer Use Skill is a model decision guide, not a producer development manual. The runtime contract stays `AX element -> visual fallback -> verify`: when the AX tree can locate and express the action, use an element target (background-safe, no focus stealing); only when AX cannot locate or express the target, request the final raster and use a coordinate target.

The model reads integer `(x,y)` only from the raster delivered by the current tool result and carries the adjacent `frame_id` as is. All resize, byte-budget, Retina/DPI, crop, window/display origin and native dispatch projections are done inside `@zcode/zcode-cua`; the model is never asked to compute them.

Zoom is not part of the normal flow. When the target is clearly recognizable in the current raster the model must click directly; Zoom is a last resort when the target is too small or ambiguous to pick reliably. The C07 model prompt and the tool description use the same boundary, so `screenshot` and `zoom` are not listed side by side as default steps.

Producer candidate: `52da434158df32f6d0825db6af1c3d263754c44c` (`v0.5.7`). The visible Dev App with Kimi K3 ran `list_apps -> get_app_state(include_screenshot=true) -> left_click(strategy=event)` on the C07 Canvas fixture without leaking geometry coordinates: no Zoom, no repeated screenshot, and the first click was proven by the authenticated DOM oracle as `trusted=true`, `matched=true`.

## 0.5.6 screenshot click regression without AX

Root cause: screenshot owner and click owner used two authorities. Capture provenance came from WindowServer, but dispatch used an AX hit-test beforehand. A fullscreen Dock layer-20 managed window was therefore mistaken as the owner on the capture side, while AX hit the Chrome below, and an immediate click was rejected as `frame_live_owner_changed`.

The fixed pixel chain uses the WindowServer snapshot throughout. Only the managed surface `com.apple.dock + non-zero layer + covering the whole target display` is penetrated; small Docks, menus, popups and other overlays still block. Full image, `get_app_state(include_screenshot=true)` window image and Zoom sub-image all compare capture/live owner, window bounds and display topology before the Helper's final dispatch, without AX `elementAtPoint`/`captureApp`. Element target/AXPress is unchanged.

C07 keeps targets inside the canvas unlocatable by the AX tree, with direct MCP and ZCode Agent evidence. The marker-grid covers window/full/zoom and records raster hash/size, frame id, crop, pixels, independent projection point, capture/live owner, raw dispatch method and authenticated DOM hit. The change does not enter conversation state, snapshot/replay or the mobile remote chain, so the conversation catalog/matrix is untouched. With macOS Accessibility/Screen Recording authorized, direct C07 and Calculator AX regression of producer `625b32ad` both scored 100; the standalone marker-grid window frame, full image, Zoom and stale-frame gates all passed; in visible ZCode Desktop Kimi K3 also completed the no-AX canvas click with the exact window screenshot `frame_id`.

The first visible Desktop regression also exposed a separate development cache issue: the MCP bundle keeps native `sharp` external, but a dev `~/.zcode/cli/plugins/cache` that synced only JS could not resolve it, so screenshot and Zoom failed with `Cannot find module 'sharp'`. The dev cache now reuses the product packaging sharp runtime staging, with a real native load smoke; the same K3 case passed on the new MCP process. Product package and dev cache thus share one native media dependency chain and no longer rely on repository-root hoisting.

## Background and baseline

The 2026-08-13 Godot chess trace came from the old coordinate protocol: after receiving a `756x485` Zoom image the model still submitted `(295,623)`; the old implementation rejected the screenshot coordinate and then allowed the model to use screen coordinates instead; in another run `state_id/index` was used as a Zoom target and produced a meaningless `12x14` image. Both old behaviors must now be negative replays, not success baselines.

The minimal producer baseline for pixel integrity is `72a8487d5a1bf1dfa2a31b282aafc4093a997b3e`. A candidate producer must be its successor and keep the `./frame-contract` export, immutable `frame_id`, final-raster crop and Helper provenance gates. Bumping only the package/tag version does not prove the implementation.

The final integration candidate of this round is `52da434158df32f6d0825db6af1c3d263754c44c` (`v0.5.7`). It inherits the full stable click baseline of `611304ccccc92e10cd97635a8cc886e0e2e3519e`, merges the screenshot click, Ghost Cursor and active HTTP request lifetime fixes of `2fdac16ebef758d7866586d1a9de0fb3ae74e8b4` and the producer surface simplification of `d55c5f3a7713a3499bfd7102fd7d2842b53e71ec`. The former inherits the final raster and old chess-trace negative replays of `a0d4eaca6342b3cbff41b444309726873d0f5b11`, adds the stable `structuredContent.code` for subagent runtime-scope rejection, and unifies WindowServer capture/dispatch owner authority and retained-raster Zoom crop. The ZCode catalog pins the exact commit; wrapper, bundled skill, Helper runtime contract and the producer's final package version are unified at `0.5.7`.

The standard `pnpm dev:desktop` build must unconditionally treat the CUA plugin as a development filesystem seed and write `sharp` plus the current platform native closure into the seed source before building the agent. Callers must not need to set `ZCODE_CUA_DEV_MODE=1`; otherwise bootstrap atomically replaces the cache with a same-version seed that lacks `sharp`, and `screenshot`, `zoom` and `get_app_state(include_screenshot=true)` all fail in a real model turn.

The model-visible `frame_id` is a short opaque token (for example `frame-a1b2c3d4`) and does not expose a guessable generation. `get_app_state` returns `image_ref -> image -> frame hint -> AX tree`; the hint repeats the exact token next to the image and asks to act before the next visual observation, so a long AX tree cannot push frame provenance out of the bounded transcript. The hint issues no authority; the sole authority is the structured `image_ref` adjacent to the final raster. Private session/generation, latest/supersession, TTL, digest and the Helper native provenance gate are unchanged.

## Contract and sequence

```text
capture/zoom -> final raster + frame_id -> model {frame_id, x, y}
                                              |
                                              v
                           registry live/bounds check
                              | current       | stale/invalid
                              v               v
                     Helper provenance       reject
                              |               broker calls = 0
                              v
                           actuate once
```

- A coordinate target accepts only `{type:"coordinate", frame_id, x, y}` with integer `x/y`.
- `space:"screen"`, `space:"screenshot"` and `state_id/index` coordinate compatibility formats are all rejected.
- Zoom crops from the raster the model actually received; it does not re-screenshot and does not leak source screen geometry.
- Stale, out-of-bounds and window/owner/topology changes must fail closed before the native action.
- Success is judged by the fixture's business marker change, not by CGEvent/AX call success.

## Automated cases

1. Old-trace negative replay: `(295,623)` on a `756x485` frame is rejected out of bounds with zero broker calls; the old `space` and `state_id/index` targets are rejected at schema stage; screenshot A -> zoom B then referencing A returns stale/superseded with zero broker calls.
2. C07 sequence stress: screenshot -> zoom -> click hits the unique canvas marker; screenshot -> zoom -> screenshot -> click on the old frame is rejected; Retina, odd sizes, negative screen origin and partially out-of-bounds crops keep pixel-center projection; after resize/move, owner or display topology change the old frame is rejected.
3. ZCode last mile: `image_ref` is adjacent to the image with bytes, MIME, width and height unchanged; invalid, duplicate and cross-session frames are rejected before the action broker RPC; a producer candidate missing the frame-contract export fails the version consistency gate (the minimal-baseline ancestry is recorded in immutable provenance and cannot be inferred from semver).

## macOS real-device acceptance

- Run the deterministic marker-grid/C07 replay first, then the direct MCP, ZCode Agent and visible ZCode Desktop real-model chains.
- Each run keeps raster SHA-256/size, frame_id, model pixel, projection point, window/display provenance, business marker before and after the click and a screenshot; full image bytes of provider requests are not stored.
- Deterministic window/full/Zoom must all hit correctly; the real-model chain must hit correctly or safely reject before the native action; tool success never substitutes for the fixture's business result.
- A model picking the wrong region with a correct projection is a visual/semantic failure; a wrong frame, wrong coordinate system or wrong physical point is a pixel-coordinate regression.

## Evidence (final state)

| Layer                                        | Result                                       | Note                                                                                                                                                                                                    |
| -------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical `v0.5.3/6d02fc3c`                 | rejected                                     | Diverges from `72a8487d` and lacks frame-contract; proves the same version number is not proof of implementation                                                                                        |
| producer frame baseline `v0.5.4/a0d4eaca`    | 2750 passed, 38 skipped                      | 225 files passed, 3 skipped; frame, Zoom, Retina, stale, native gate                                                                                                                                    |
| producer `v0.5.5/372cbac9`                   | 2766 passed, 23 skipped                      | adds 30-tool subagent stable error code and package/plugin version consistency gate; full socket suite passes on Node 24.14.0                                                                           |
| pixel click implementation `v0.5.6/625b32ad` | 2786 passed, 23 skipped                      | unified WindowServer owner, no-AX window/full/Zoom click, localized AX regression, K3 model-evidence adjudication, Helper LaunchServices TCC attribution gate                                           |
| producer `v0.5.6/c863cff9`                   | 2814 passed, 23 skipped                      | after merging latest `main` AX authoritative-state barrier; build/typecheck/lint, evaluator 472/472, Python 32/32                                                                                       |
| producer `v0.5.6/07a6dca8` (final pin)       | 2814 passed, 23 skipped                      | frame hint fixed between image and AX tree, trace records only delivered frame provenance before truncation; evaluator 474/474, Python 32/32, Kimi K3 direct/app-server pass                            |
| producer trace/coordinate focus set          | 77/77                                        | 12 files; old chess trace adds 3 fail-closed cases                                                                                                                                                      |
| ZCode consumer integrity                     | 124/124                                      | 6 files; final dependency pinned to `07a6dca8`/`0.5.6`; full pre-commit gate and MR pipeline still need re-verification                                                                                 |
| wrapper version/skill/contract gate          | 13/13                                        | missing Windows Helper or final-raster frame-contract is rejected outright; wrapper host authority 1/1                                                                                                  |
| CUA eval evaluator / definition              | 474/474; 31/31 (definition-only quality 100) | Node evaluator full set; Python 32/32 covers C07, region, K3 model-I/O and frame-id recovery                                                                                                            |
| ZCode full unit tests                        | 11476 passed, 12 skipped                     | 1309 files passed, 1 skipped; local full `test:unit` on the consumer final tree; the affected/pre-push gate re-verifies by commit range                                                                 |
| ZCode / producer Node 24.14.0 static gates   | pass                                         | ZCode `typecheck`, `lint` 0 errors (38 existing warnings); producer `typecheck`, `lint` 0 errors (14 existing warnings)                                                                                 |
| plugin product package check                 | pass                                         | bundled skill provenance, producer SHA, version and contract consistent                                                                                                                                 |
| standalone `zcode-cua` MCP                   | pass                                         | stdio start of `v0.5.6` on Node `24.14.0`; canvas marker-grid window 5/5, full, strict-interior Zoom, drag all proven by authenticated DOM oracle, all report `window_event`; stale frame zero dispatch |
| CUA Helper dev wrapper                       | build passes                                 | Node `24.14.0` SEA base with same-ABI `ax_native.node`, provenance `arm64/node_abi=137` passes, installed to `~/.zcode/computer-use/dev`                                                                |
| macOS C07 runtime                            | pass                                         | latest Dev Helper Accessibility/Screen Recording granted; final-SHA direct C07 and Calculator M02 AX both 100                                                                                           |
| Kimi K3 app-server                           | pass                                         | final-SHA gate direct and `zcode_agent_core` lanes pass; product/release score 100; the model really received and recognized the screenshot                                                             |
| Kimi K3 visible ZCode Desktop                | pass                                         | session `sess_be30c6a3-2ce7-4574-aaac-2fe821e311ed`; window raster `1280x900`, `frame-0c9a96ea`, model pixel `(641,496)`, DOM oracle `Marker placed at 450, 280`, canvas has no AX children             |
| Desktop plugin cache sharp                   | pass                                         | first run reproducibly missed sharp; after `sync:cache` reused the product staging, sharp `0.34.5`/libvips `8.17.3` native load smoke and a fresh MCP/K3 C07 pass                                       |

Final Kimi K3 real-device record bound to producer `07a6dca8`: direct C07 100; the ZCode app-server lane `vision-pass`, product score 100. The model really received window image `frame-8ce8ecf9`, submitted integer pixel `(641,469)`, the Helper dispatched via `window_event`, and the DOM oracle returned `Marker placed at 450, 280`. The same candidate's direct C07 also covers retained-raster Zoom, and Calculator M02 AX regression is also 100.

All formal automation evidence uses Node `24.14.0`; both macOS TCC permissions were effective. Provider keys and full provider images are not stored in the repository or MR. An external secondary display is not part of this round's real-device environment; negative origin and topology change are covered by deterministic tests. If a dual-screen environment becomes available, one real topology evidence should be added; it does not affect the current single-screen window/full/Zoom acceptance.
