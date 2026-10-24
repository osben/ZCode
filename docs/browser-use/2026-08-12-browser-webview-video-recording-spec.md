# Browser Use Embedded WebView Video Recording Spec

> Status: revised implementation of 2026-08-14 (Electron MediaRecorder / WebM).
>
> Goal: let ordinary plugins such as `video2code` record the ZCode embedded browser through the official Browser Use SDK, dropping the Playwright/standalone Chromium dependency; ordinary plugins still get neither raw CDP nor Electron permissions.
>
> The capability ships with Browser Use plugin `0.3.0`; the version and recording doc asset contract is in `2026-08-14-browser-use-plugin-version-0-3-0-spec.md`.

## 1. Feature Summary

| Field            | Value                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | Reuse the embedded `<webview>` and the Browser Use interaction chain to produce WebM without an external video encoder                                                     |
| Capability       | Browser Use embedded WebView scenario recording                                                                                                                            |
| Change layer     | validation / commit-effect / transient state / artifact materialization                                                                                                    |
| Primary seeds    | `BrowserGuestManager`, `DesktopBrowserScreenshotSurfaceCoordinator`, `BrowserControlMainBridge`, Browser client `Tab`                                                      |
| Out of scope     | exposing raw CDP to third-party plugins; a separate Chromium; recording the whole ZCode window; writing recording jobs into the task snapshot; transcoding for other video features |

## 2. Product and security decisions

1. Third-party plugins may only call `Tab.recording.*` of the official `node_repl` Browser Use SDK; the permission boundary is still controlled by `browser-use@zcode-plugins-official`, and a plugin manifest cannot declare a high-privilege browser runtime.
2. v1 records the WebView composited content of one already-controlled IAB tab. Page interaction and picture come from the same guest and the same CDP timeline; no Playwright browser/context is created.
3. Async `start/status/cancel` is used; every BrowserControl command finishes within the existing 30-second transport budget, so a recording of up to 90 seconds does not hold a stateless `node_repl` call.
4. Recording actions use a restricted DSL (wait/click/type/hover/move/scroll/scrollTo/wheel/drag/waitFor); no `eval` or arbitrary script. Selectors are CSS selectors; interaction still goes through CDP trusted input.
5. Recording uses Electron `session.setDisplayMediaRequestHandler` to authorize the target guest's `WebFrameMain` to a hidden ZCode-owned recorder renderer; the renderer encodes VP8 WebM directly with Chromium `MediaRecorder`. No JPEG frames collected, no FFmpeg, and no dependence on PATH or user-installed software.
6. The recorder renderer runs in a one-shot in-memory session and can capture only the target frame main designates; WebM chunks are streamed to main over a `MessagePort` and written to disk. The recorded page and ordinary plugins get no capture stream, recording chunks or IPC permissions. The recording surface lease explicitly declares `surfaceScaleMode=unscaled`: for the lease lifetime the owner renderer temporarily derives a 100% free-size composited surface from the requested viewport without rewriting the user's saved Fit/fixed preview ratio, and the React-derived state recovers automatically after release. The raw display stream is then normalized to the requested viewport/fps in a canvas of the trusted renderer before `MediaRecorder`, so high DPI does not leak into the artifact resolution and a Fit low-res surface is never upscaled to pose as the target resolution.
7. Main owns only the WebView and short-lived recording artifacts. When the `recordingStatus` reply completes, Host atomically places the WebM into the workspace and rewrites the model-visible path to the final path. The model never depends on a main temp path.
8. In pure CLI, Server remote, or when no Desktop IAB executor is injected, the Browser Use backend stays `backend_unavailable`; this feature starts no browser runtime for those forms.

## 3. Impact brief

### 3.1 Surfaces

| Scenario | Entry / shared implementation | Owner | Gating | Persistence / isolation |
| --- | --- | --- | --- | --- |
| Desktop task records the current page | Browser Use side pane; current `UnifiedBrowserView` guest | renderer tab shell + main recording job | official Browser Use runtime, session/tab scope, 90-second cap; Host materializes WebM into the workspace | job/main temp and workspace file, not in the task DB; `desktop-continuous`; isolated from other window/workspace/session |
| Mobile remote starts a recording | `/remote` attached to the desktop shared host; the same Desktop IAB guest/executor | desktop main | trusted `clientMode` + workspaceKey + remoteSessionId; the same Host returns a workspace path | not in the replayable snapshot; `web-remote-replayable` is only a carrier; no independent mobile browser runtime |
| Recording with panel hidden or Fit preview | no new UI; screenshot surface prepare/release | main transient lease + renderer-derived 100% surface | guest generation, surface identity, 100% scale, watchdog; release the surface after capture | not persisted; user preview zoom not rewritten; isolated from relay/task recovery |
| Remote workspace | existing remote workspace task; reuses only when the existing Desktop IAB executor is reachable | Desktop main + Host remote backend | workspaceIdentity + remoteSessionId, else fail closed; backend uploads to the remote workspace | remote file; never equated by workspacePath alone |

Shared vs different: all paths use BrowserControl session/tab authority and an ordinary plugin never touches CDP directly (recording must not bypass the official plugin gate). Screenshot and recording share the background surface; the recording lease has a longer but bounded watchdog and requires a 100% surface, while screenshot keeps the current preview scale (hidden panels still get native-clarity frames and throttling is not disabled forever). The model sees only the final workspace path; the main temp path appears only inside host<->main. Task/session message flow is not modified; mobile treats BrowserControl only as a shared-host RPC. All Desktop IAB forms produce VP8 WebM, with MIME support probed at recorder renderer startup, so system FFmpeg availability is not a prerequisite.

### 3.2 Relationships (inspect list)

- recording records the guest from the Browser Use side-pane guest (same tab/generation: picture and interaction must share a source).
- recording job holds a bounded lease through screenshot surface coordination (capture phase only: a hidden pane must keep emitting frames).
- recording surface temporarily overrides the display scale of the owner renderer free-size canvas (recording lease only: Fit/50% must not become the recording source resolution).
- the recording artifact is materialized by the Host browser bridge (completed status + validated output path; the main temp path must not leak).
- the third-party video2code plugin executes through the official stateless Browser Use MCP (official plugin enabled; no new plugin privilege).
- invariants: recording transient state must not enter desktop/mobile task delivery (all client modes); recording scope is isolated by workspace key + remoteSessionId + session + tab generation on every command.
- evidence: schema/client/main/bridge/runtime tests plus Electron smoke, so that real frame capture is tested and not only types.

### 3.3 State owners

| State/fact | Authoritative owner | Commit | Persistence |
| --- | --- | --- | --- |
| recording id/status/phase | `BrowserGuestManager` process-local job registry | `recordingStart/status/cancel` | bounded 1-hour temporary state |
| WebView media stream | target guest `WebFrameMain` + isolated recorder renderer | `getDisplayMedia`/`MediaRecorder` | WebM chunk stream |
| capture residency | Desktop main coordinator (renderer background surface) | prepare/release lease | not persisted |
| recording surface scale | Desktop main recording lease (renderer derives from the prepare payload) | `surfaceScaleMode=unscaled` | not written into preview zoom state |
| final WebM path | workspace filesystem / remote backend | Host artifact materializer | user workspace file |

### 3.4 Must-preserve invariants

- `workspaceKey = workspaceIdentity?.trim() || workspacePath`; remote identity and `remoteSessionId` are never lost.
- A recording id is not an authorization credential; status/cancel must re-verify the full BrowserControl scope.
- At most one recording per tab at a time; during recording `captureActive=true` and the 32-tab LRU must not evict the tab.
- On turn/session/window/tab end, a still-running recording must be cancelled, MediaRecorder/media tracks stopped, the recorder renderer, file handles and MessagePort closed, and the surface and cursor overlay released.
- Completion/failure/cancel must all clean up the one-shot display-media handler; a failed artifact must not be exposed.
- Recording surface ready must satisfy both the requested viewport and `surfaceScale=1`; preview surfaces such as Fit/50% must not be accepted by main. After release/failure/cancel the user's original preview zoom must be restored, leaving no persistent 100% state.
- High-frequency chunk logs go only through `debug`, never per-chunk production `info`.
- The output path must be inside the current workspace; `..` escapes and absolute paths overwriting across roots are rejected.
- Desktop `continuous` does not stitch mobile replayable state; mobile creates no independent Host/Agent/browser runtime.

Code evidence (no `codegraph` available; feature graph seeds and `rg` 2-level tracing): `BrowserGuestManager.execute` (host request -> main runner -> manager -> guest CDP: command authority and real guest owner), `DesktopBrowserScreenshotSurfaceCoordinator.prepare` (the hidden-pane wake lease recording must reuse), `createBrowserControlMainBridge` (agent service -> host pending map -> main result: the final artifact materialization sink), `Tab` (Browser client facade -> BrowserCommand schema: the plugin-facing async recording API).

Graph delta: added `capability.browser-webview-video-recording`, `state.browser-recording-job-registry`, `evidence.browser-webview-video-recording-tests`; semantic edges from recording to the screenshot surface, stateless Browser Use MCP, workspace key and desktop/mobile delivery boundary were written back to the feature graph in planning mode.

## 4. State and order

### 4.1 State machine

```text
                start(scope, tab, actions)
 idle ------------------------------------------------> preparing
                                                        |
                                                        | surface ready + recorder started
                                                        v
                                                     capturing
                                                        |
                                                        | actions finished
                                                        v
                                                     finalizing
                                                        |
                             +--------------------------+------------------+
                             |                                             |
                             v                                             v
                          completed                                     failed
                             |
                             | Host validates/materializes outputPath
                             v
                       workspace artifact

 preparing/capturing/finalizing -- cancel | turn/session/window/tab end --> cancelled
 completed/failed/cancelled -- TTL -------------------------------------> cleanup
```

### 4.2 Event order

```text
Browser client      node_repl/Browser SDK      Host       Desktop main       owner renderer        recorder / target
      | recording.start(options) |               |              |                    |                    |
      |-------------------------->| BrowserCommand|              |                    |                    |
      |                           |-------------->| parentPort   |                    |                    |
      |                           |               |------------->| sync CSS viewport  |                    |
      |                           |               |              |-- prepare(unscaled)->|                    |
      |                           |               |              |<-- ready(scale=1) ---|                    |
      |                           |<--------------| running{id}  |                    |                    |
      |<--------------------------|               |              | getDisplayMedia(target WebFrameMain)       |
      |                           |               |              |<========== MediaRecorder =================>|
      |                           |               |              |<--------- WebM chunks ---------------------|
      | recording.status(id,out)  |               |              |                    |                    |
      |-------------------------->|-------------->|------------->| completed(temp.webm)|                    |
      |                           |               |              |-- release --------->| restore preview   |
      |                           |               | copy/upload + rewrite path                                   |
      |                           |<--------------| workspace WebM|                    |                    |
      |<--------------------------|               |              |                    |                    |
```

`recording.start` only starts the job and does not wait for capture/encode; every `status` re-addresses by the string id in a fresh JS kernel. Browser/tab continuity belongs to the BrowserControl registry, not to JS globals.

## 5. Protocol and API

### 5.1 BrowserCommand

- `recordingStart { tabId?, options }`
- `recordingStatus { recordingId, outputPath? }`
- `recordingCancel { recordingId }`

`options` contains `viewport`, `fps`, `maxDurationMs`, `settleMs`, `showCursor` and a restricted `actions[]`. Defaults: viewport 1280x720, 25 fps, max 60 seconds; the schema hard cap is 90 seconds. `jpegQuality` is only a compatibility field for unreleased old calls, ignored by the new recorder, and may be removed in a later protocol major version.

### 5.2 Browser client

```js
const job = await tab.recording.start({
  viewport: { width: 1280, height: 720 },
  actions: [
    { type: "wait", durationMs: 800 },
    { type: "click", selector: "#start" },
    { type: "scroll", deltaY: 600, durationMs: 1000 }
  ]
});

const status = await tab.recording.status(job.id, {
  outputPath: "recordings/demo.webm"
});
// when status.status === "completed", status.artifact.path is the final workspace path.
```

## 6. Case planning

### 6.1 Boundary decisions

| Boundary | Decision | Includes | Excludes / prunes |
| --- | --- | --- | --- |
| browser runtime | record only an existing IAB guest | desktop shared-host / mobile attached | plugin Playwright, standalone Chromium |
| duration | async job, schema max 90 seconds | capture + encode phase polling | a single 600-second node_repl call (120-second tool cap) |
| interaction | CSS selector + trusted CDP input DSL | common URL2Video actions | eval, custom JS, network requests (Browser safety) |
| artifact | Host workspace materialization | local copy; upload when an existing backend exists | exposing the main temp path |
| encoder | Chromium MediaRecorder | VP8 WebM; `isTypeSupported` at startup | FFmpeg, external binaries, standalone Chromium (zero install dependency) |
| delivery | browser RPC only | desktop continuous, mobile carrier | task snapshot/replay queue |

### 6.2 Accepted cases

The "status" column records the automation that actually landed, not the plan. When changing the recording chain, check here first, then decide which layer to add.

| Case ID | Setup / action | Assertions | Status |
| --- | --- | --- | --- |
| BVR01 | visible IAB animation page; start -> wait/click/scroll -> poll | non-empty WebM with correct resolution/fps/duration; interaction appears in the same video | focused unit (`browserGuestManager.test.ts` BVR01/BVR04, `browserVideoRecorder.test.ts`, recorder injected) + Electron smoke (`scripts/browser-webm-recording-smoke.mjs`: EBML header, real playback resolution, seek-derived real duration, motion ratio, measured decoded frame rate). Gap: the smoke connects the recorder directly without the manager DSL actions, so "interaction appears in the same video" has no automation evidence |
| BVR02 | Browser side pane hidden; start recording | surface lease keeps capturing and is released afterwards | focused unit (`browserGuestManager.test.ts`: prepare already invalid, invalid during recording, lease pointing to another webContents, each asserting no capture and lease returned). Gap: real surface runtime probe of a hidden pane |
| BVR03 | two sessions/tabs; use a foreign recording id for status/cancel | fail closed, no status/path returned | focused unit (cross-session status, cross-session cancel with the original job alive, wrong tabId) |
| BVR04 | active recording; turn/session/window/tab end | stop/ack/release/cursor cleanup, status cancelled | focused unit (endTurn / closeSession / closeWindow each assert cancelled + recorder.cancel + lease release; the recorder side has an external-abort cleanup case). Gap: closeTab entry not unit-tested |
| BVR05 | same tab with an active job; start a second recording | structured execution error; first job continues | focused unit (execution_error, no second recorder, first job still running) |
| BVR06 | output `../outside.webm` or `.mp4`; completed status materialization | reject path escape / wrong extension, nothing written outside the workspace | focused unit (`browserRecordingArtifactMaterializer.test.ts` 4 cases + `browserControlMainBridge.test.ts` materialization) |
| BVR07 | Chromium lacks VP8 WebM or the recorder renderer crashes; start/finish capture | failed status carries recorder unavailable; no fake artifact | focused unit (`electronBrowserWebmRecorder.test.ts`: MIME allowlist, renderer crash, unexpected MessagePort close, disk write failure; `browserGuestManager.test.ts`: recorder unavailable -> failed with no artifact) |
| BVR08 | mobile attached local workspace; recording RPC | no runtime/snapshot created; still scoped by workspace/session/tab | partial: `scopeKey` contains `clientMode`, unit-tested that a web-remote client cannot see desktop jobs. The `attachGuest` options do not accept `clientMode`, so this layer cannot build a mobile-attached tab; "no runtime/snapshot created" must be verified at the host/server layer |
| BVR09 | tab preview currently Fit/50%; recording requests the same or a different viewport; start -> prepare -> capture -> release | renderer temporarily composites at 100% by the requested viewport; ready accepts only scale=1; original preview zoom restored after completion/failure | focused unit (`browserScreenshotSurfaceCoordinator.test.ts` accepts only scale=1; `UnifiedBrowserView.test.ts` temporary UI switch; `browserGuestManager.test.ts` main restores the viewport override). Gap: Electron runtime smoke does not cover zoom restoration |

Coverage notes:

- The `scripts/browser-*-smoke.mjs` series needs an Electron GUI and screen-recording permission and is **not wired into CI**; it is a manual/local gate. When changing the recording chain run `pnpm --filter @zcode/desktop test:browser-webm-recording-smoke` manually.
- `packages/desktop/test/*.test.ts` (non-e2e unit tests) are not in any `tsconfig` include, so type errors there are not caught by `pnpm typecheck`.
- `width/height/fps/durationMs/frameCount` returned by `browserVideoRecorder.ts` are all derived from inputs and the WebM is not parsed. Only the Electron smoke checks the container's real resolution and duration, so unit assertions on those fields are tautological.

### 6.3 Pruning decisions

- No Browser UI recording button; the entry is the plugin/agent API. `packages/ui` derives the 100% capture layout only from the transient surface request, adding no control and no write to the user's preview zoom state.
- No full SSH/WSL/Docker x every-action permutation; the local/remote representatives of the workspace materializer suffice, and remote/server forms where BrowserControl itself is unreachable keep returning structured `backend_unavailable`.
- No conversation-session E2E; conversation/session state semantics are unchanged. Protocol, manager, Host and a real Electron smoke cover the recording chain directly, keeping media encoding out of provider conversation fixtures.

## 7. Done criteria

- `video2code` has no Playwright Python import, browser install/launch check or standalone Chromium launch script.
- The official Browser Use docs/manifest expose `Tab.recording.start/status/cancel` with executable fresh-kernel examples.
- Both visible and hidden IAB guests produce playable VP8 WebM; the recording contains real DSL-triggered interaction.
- During recording the owner renderer reports `surfaceScale=1`; when the current preview is Fit/fixed non-100% the stream still comes from the native-size surface, and the original preview ratio is restored after release.
- Recording still starts and completes without FFmpeg installed and with no ffmpeg/ffmpeg.exe on PATH.
- The temp artifact is not returned directly to the Agent; output path escape is rejected.
- Lifecycle cancel, scope isolation, surface lease and tab LRU capture protection have automation evidence.
- No new task/replayable snapshot fields; workspaceIdentity/remoteSessionId/clientMode passthrough does not regress.
- Focused tests, `pnpm typecheck`, `pnpm lint` pass, and one real Electron recording verification is done.
