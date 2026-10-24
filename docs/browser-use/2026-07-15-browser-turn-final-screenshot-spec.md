# Browser Use Turn-End Auto Screenshot Spec

> Status: implemented; formal desktop/mobile E2E pending.
> Date: 2026-07-15.
> Related: `docs/browser-use/2026-07-10-browser-use-codex-parity-spec.md`,
> `docs/conversation-session-case-catalog.md`,
> `docs/testing/conversation-session-e2e-coverage-matrix.md`.

## 1. Product goal

If and only if the turn successfully called, through Node REPL, a Browser API tied to a concrete page,
the current active tab is screenshotted automatically after the turn completes normally and shown as an
independent turn-tail image block. Whether the turn explicitly returned an image via
`nodeRepl.emitImage(...)` does not affect the turn-tail screenshot: an explicit image is a tool result,
the auto screenshot is the final page state at turn end.

The auto screenshot is not model output and is not fed back into provider context. It is a conversation
display fact persisted by CLI/runtime; desktop `desktop-continuous` and mobile `web-remote-replayable`
read the same fact.

## 2. Confirmed boundaries

| Dimension               | Conclusion                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger source          | only a Browser API that succeeded inside Node REPL and whose response meta ties to a concrete tab                                                                                                                                                                |
| Not a trigger           | `agent.browsers.list()`, documentation, capability queries, failed calls                                                                                                                                                                                         |
| Existing explicit image | does not skip the auto screenshot; the explicit image stays in the original tool result and the turn tail still appends the current active tab's final state                                                                                                     |
| Tab selection           | at completion re-read browser tabs and screenshot only the tab with `active=true`; this `active` is main's effective active (including background fallback), not "currently visible in UI"                                                                       |
| Turn end state          | attempted only on normal completion; Stop, cancel and failure skip                                                                                                                                                                                               |
| Placement               | end of the turn's content area: after the final assistant/Website preview cards and the file diff summary, before the message action bar; not attached back to existing tool cards                                                                               |
| Style                   | reuse the Node REPL tool-result screenshot rendering, size, left alignment, rounded corners, image-hugging border and large-image viewer                                                                                                                         |
| Failure policy          | browser closed, no live tab left in scope, screenshot failure, or still over budget after compression: skip silently and log with the service/runtime logger. When the scope still has a live tab this row is not reached, because effective active is non-empty |
| Model context           | the auto screenshot does not enter message history/provider content and adds no model tool call                                                                                                                                                                  |

## 3. State and order

```text
Node REPL Browser API success
  -> turn-local marker { browserId, generation, tabId }
  -> later model/tools keep running
  -> final assistant text persisted
  -> normal turn completion boundary
       ├─ no qualifying browser marker -> skip
       ├─ list tabs has no active tab (no live tab left in scope) -> skip + debug log
       └─ screenshot(active tab), unaffected by this turn's explicit emitImage
            ├─ failed / invalid -> skip + warn/debug log
            └─ success
                 -> over the Node REPL display budget: scale/transcode first
                 -> still over budget after compression -> skip + warn log
                 -> persist turn-tail screenshot fact
                 -> desktop continuous delta
                 -> TurnComplete
                 -> mobile replayable snapshot can restore the same image block
  -> browser turnEnded cleanup
```

The screenshot must become a persisted fact before `TurnComplete`; `turnEnded` cleanup still runs in the
finally after the main turn completes/fails. Cleanup must not precede the screenshot attempt, and the
renderer must not call the Browser API after seeing completed.

The persisted row order cannot be used directly as the final completed-UI layout order. Website preview
cards derive from the final assistant text and the file diff summary aggregates from the turn header; the
renderer must place the auto screenshot after this same-turn content:

```text
final assistant text
  -> Website / file preview cards
  -> per-turn file diff summary
  -> browser turn-end screenshot
  -> copy / feedback / fork / retry / timestamp actions
```

This reorder applies only to display rows with `source=browser_turn_end`; ordinary tool-result images and
the `turnTailBoundary` marker keep their existing positions, with no global reorder by UI type.

## 4. Layering and multi-client constraints

- Browser API usage detection and the final screenshot belong to CLI/runtime; desktop main and relay own no
  turn state.
- Browser execute keeps using the existing `BrowserControlPort` and shared-host attachment; no mobile
  Agent/runtime is added.
- Remote workspaces keep passing `workspaceIdentity`, `remoteSessionId`, `clientMode` along the existing
  request; never correlate by `workspacePath` alone.
- Desktop continuous receives the new turn-tail fact directly; mobile replayable recovers through delta,
  gap or snapshot of the same CLI event log/projection, and replayable assembly rules must not leak into
  the desktop path.
- The auto screenshot belongs only to the session/turn that issued the Browser API; switching the active
  UI session does not change ownership.

## 5. Data and safety budget

- Only strict `image/*` MIME and valid base64 are accepted, with the count and per-image budgets of
  `node_repl_images`. When the raw screenshot exceeds the per-image budget it must first be scaled/
  transcoded through the existing `ImageProcessorPort` before the display fact is built; the persistence
  budget must not be loosened.
- The Browser screenshot source is PNG. If both size and byte budgets are met, keep it. If only bytes are
  over, one more original-size optimized PNG attempt is allowed. If that candidate still misses the budget,
  the compression state moves one-way into JPEG: first at the largest size allowed by `maxDimension` try
  quality `80 / 60 / 40 / 20`, then shrink by `75% / 50% / 25%` and repeat the JPEG qualities, and only
  last the existing low-quality small-size JPEG fallback. Once in the JPEG branch, no quantized PNG or
  shrunk PNG is tried, to avoid returning a low-resolution PNG when a larger JPEG would fit.
- Display data uses a strict schema; unknown/corrupt payloads fail closed and never fall back to showing
  `[Attached image/png: MCP image]`.
- Logs never record image base64, page body, or full URL query/hash. High-frequency call markers use
  `debug`, a single auto screenshot failure uses `warn`, a normal skip uses `debug`.
- fork/compact/cold resume only copy or restore the persisted turn-tail fact and never re-screenshot.

Compression candidate state machine:

```text
PNG source
  ├─ original PNG meets size and byte budget -> original PNG
  ├─ original-size optimized PNG meets budget -> optimized PNG
  └─ original-size optimized PNG still over budget
       -> JPEG-only
            ├─ max allowed size × quality 80 / 60 / 40 / 20
            ├─ 75% × quality 80 / 60 / 40 / 20
            ├─ 50% × quality 80 / 60 / 40 / 20
            ├─ 25% × quality 80 / 60 / 40 / 20
            └─ aggressive JPEG fallback
```

Representative combinations are pruned by invariant, not permuted with tab, turn and client mode:

| Case    | Setup                                                | Action            | Assertion                                                                         | Evidence              |
| ------- | ---------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------- | --------------------- |
| BTA-C01 | PNG original already meets size and byte budget      | `prepareForModel` | bytes, MIME, size unchanged, strategy=`original`                                  | adapter unit          |
| BTA-C02 | PNG original over budget, original-size JPEG fits    | `prepareForModel` | outputs `image/jpeg`, width/height unchanged, no shrunk PNG                       | adapter unit          |
| BTA-C03 | PNG original and original-size JPEG both over budget | `prepareForModel` | later candidates stay `image/jpeg`, shrunk by existing ratios until within budget | adapter unit          |
| BTA-C04 | JPEG, GIF, WebP input                                | `prepareForModel` | existing format entry and failure contract                                        | existing adapter unit |

## 6. Acceptance

1. Browser API success + normal end: one active-tab screenshot appears after the same-turn Website/file
   preview and file diff summary, before the message action bar.
2. Explicit `emitImage` in the turn: the tool result keeps the explicit image, and the active-tab auto
   screenshot is still appended independently after the final answer.
3. Only documentation, browser discovery, capability or failed calls: no screenshot appended.
4. Stop/cancel/failure, no live tab left in scope, screenshot failure: the conversation terminal state is
   unaffected and no empty placeholder shows.
5. After refresh, cold resume and mobile replayable snapshot, the screenshot stays at the same turn tail and
   appears once.
6. The screenshot keeps the Node REPL image style: left aligned, border hugging the actual image, no
   horizontal overflow on desktop and narrow mobile.
7. When one session calls the Browser API over multiple consecutive turns, each turn independently
   detects, screenshots and persists; the previous turn's screenshot or cleanup must not suppress the next.
   A raw PNG of a complex page over the display budget must still display after compression.
8. After the original-size optimized PNG exceeds budget, later persisted candidates may only be JPEG; if
   the original-size JPEG already meets budget, image width/height must not shrink.
9. When the session is entirely in the background (side pane not expanded, or that browser tab not
   selected): the turn-tail screenshot is still appended per the rules. The renderer in the background
   reports only `attachGuest({ active: false })`; this is **not** the "no live tab" of item 4. Main's
   effective active fallback guarantees that whenever the scope still has a live tab, `tabs.list()` has
   exactly one `active` (see "system effective active fallback" in
   `2026-07-12-browser-tab-selection-activation-spec.md`).

## 7. Large-image viewer interaction

Node REPL tool-result screenshots and the auto turn-tail screenshot must reuse the same renderer-only
large-image viewer, with no new conversation fact, protocol field or persisted state:

```text
thumbnail
  -> click
  -> fullscreen overlay + current image fitted to viewport proportionally
       ├─ click image or blank overlay -> close
       ├─ click top-right close        -> close
       └─ Escape                       -> close
```

- Desktop, plain Web and mobile `/remote` use the same interaction; mobile replayable only restores the
  original image fact and does not sync overlay open state.
- The large image keeps its aspect ratio; max width/height must not exceed the viewport; at least 96px of
  viewer safe space is reserved vertically so the image does not contend with the close button and desktop
  title bar for the top-right corner; wheel zoom, drag and pan are not supported.
- The thumbnail keeps its left-aligned, image-hugging border and no-horizontal-overflow-on-narrow-screen
  contract; opening the large image must not change the original tool block or turn-tail block layout.
- The thumbnail entry, top-right close button and Escape must be accessible; after closing, focus returns
  to the triggering thumbnail.
- For multi-image results each clicked image opens separately; the overlay shows only the current image,
  and image data stays identical to the original `node_repl_images` fact.
- On Windows desktop the close button must sit below the native `titleBarOverlay` with extra inward
  spacing; the position prefers the real Window Controls Overlay `titlebar-area-height`, so DPI or ZCode
  page zoom never moves it back into the native close button hit area. The Windows large-image max height
  must subtract the top and bottom title-bar safe heights so the image top is at least 8px from the close
  button bottom; moving the button while keeping the original image height is not enough. macOS, Linux,
  plain Web and mobile `/remote` do not inherit this Windows safe area.
