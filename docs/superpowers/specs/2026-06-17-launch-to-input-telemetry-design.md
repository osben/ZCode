# Desktop "App Launch → Input Ready" Staged Telemetry Design

The launch path "process creation → user can type" is split into 7 stages, each reported independently via ARMS `sendCustom` (`group=ui_perf`), replacing `perf_ui_first_screen` (renderer-internal render only, mean ≈ 75ms), which missed the user-perceived bulk: Electron cold start, main-process init and window orchestration, renderer bundle load, and the post-commit startup gate (auth resolution / provider startup / workspace restore, during which `RootStartupLoading` shows and the input is not usable).

Goals:

- One total duration plus 6 stage durations, all sampled at 100%, once per renderer cold start.
- Same paradigm as the existing `perf_network_*_dns_ms`: one event name per stage, each with its own `value`, so mean/p50/p90/p99 aggregate reliably. (In the ARMS chain, `desktopMainIpcRemote.ts:126-148`, only `value` maps to the numeric `metric_value`; `properties` are dimensions/counts — do not bet on aggregating properties.)

Non-goals: no new main/preload/IPC channel definitions — reuse `PlatformChannels.ReportArmsCustomEvent` and the `additionalArguments` injection; `perf_ui_first_token` / `perf_ui_message_complete` / `perf_ui_stream_stall` untouched; secondary windows and runtime reloads are excluded (first cold-start main window only).

Clocks: the start anchor is in main, the end in renderer; their `performance.now()` origins cannot be subtracted. Use epoch milliseconds — `T0 = process.getCreationTime()` (main-process creation, readable from both processes); all other boundaries via `Date.now()`. All stage subtraction happens in one place in the renderer, sending 7 events at once.

Seven timestamps:

| Mark | Where captured | Process | Meaning |
|------|----------|------|------|
| `T0` | `process.getCreationTime()` | main | process creation (anchor) |
| `T1` | first line of `main/index.ts` module top, `Date.now()` | main | main JS start |
| `T2` | `app.whenReady().then` callback entry (`index.ts:981`) | main | framework ready |
| `T3` | before main-window `loadURL` | main | start loading renderer |
| `T4` | `renderer/src/main.tsx` module top | renderer | bundle starts executing |
| `T5` | on `zcode-react-startup-ready` | renderer | first React commit |
| `T6` | when the startup gate `isStartupRenderBlocked` flips `true→false` | renderer | input usable |

Seven stages (adjacent differences), each event's `properties` carrying `session_id` (derived from `T0` or renderer_id) to reassemble one launch:

| Event (`group=ui_perf`) | `value` | Interval | Optimization target |
|---------------------------|---------|------|----------|
| `perf_ui_launch_to_input` | total | `T6 - T0` | main "launch → usable" metric |
| `perf_ui_launch_electron_init_ms` | `T1 - T0` | creation → main JS | Electron binary + V8 start (baseline, mostly uncontrollable) |
| `perf_ui_launch_app_ready_ms` | `T2 - T1` | main JS → whenReady | main synchronous init |
| `perf_ui_launch_window_ms` | `T3 - T2` | whenReady → loadURL | window/data-dir/network-policy orchestration |
| `perf_ui_launch_renderer_load_ms` | `T4 - T3` | loadURL → bundle | HTML shell, bundle download/parse |
| `perf_ui_launch_react_commit_ms` | `T5 - T4` | bundle → React commit | renderer render (= old `perf_ui_first_screen`) |
| `perf_ui_launch_startup_gate_ms` | `T6 - T5` | commit → input usable | auth / provider / workspace restore |

Data flow:

```
main process
  T0 = process.getCreationTime()        // anchor
  T1 = Date.now()  (index.ts module top)
  T2 = Date.now()  (app.whenReady callback entry)
  T3 = Date.now()  (before main-window loadURL)
    └─ serialize {T0,T1,T2,T3} into webPreferences.additionalArguments
       as --zcode-launch-marks=<json> (precedent: --device-id= in desktopWindowChrome.ts:283)
         │
renderer process
  parse {T0,T1,T2,T3} from process.argv (precedent: preload/index.ts:14)
  T4 = Date.now()  (renderer/src/main.tsx module top)
  T5 = Date.now()  (zcode-react-startup-ready, once)
  T6 = Date.now()  (Root: isStartupRenderBlocked true→false)
    └─ at T6 compute all 7 stages → reportUiLaunchStages(...)
       → uiPerfArmsTelemetry reporter.reportArmsCustomEvent × 7
       → window.zcode.reportArmsCustomEvent → IPC → armsRum.sendCustom
```

Common dimensions (app_version / arms_env / device_mid / platform / renderer_id) are attached by the main handler; the UI does not duplicate them.

T6 and boundaries:

- T6 is the moment `isStartupRenderBlocked` (`Root.tsx` L547, from `shouldShowRootStartupLoading`) flips to `false`: `RootStartupLoading` exits and `LexicalChatInput` mounts editable. A `useEffect` watches the flip and records T6 + triggers reporting (ref-guarded, once per process).
- Unlogged/WelcomeScreen boundary: `shouldShowRootStartupLoading` returns `false` while `welcomeScreenOpen` (`rootStartupGate.ts:47`) — the gate is "clear" but there is no input. Such launches skip the whole batch (no `perf_ui_launch_to_input`), keeping the distribution clean; only logged-in launches into the workspace report.
- Reporter timing: T6 happens after Root mount, so the reporter is already injected via `setUiPerfArmsReporter` — no `pendingFirstScreenPayload` staging (removed together with the old event).

Clock robustness:

- `Date.now()` is wall time; clock adjustments can produce negative spans. Every `value` goes through `Math.max(0, Math.round(...))`.
- Sanity sentinel: total `T6 - T0` > `LAUNCH_TO_INPUT_SANITY_MAX_MS` (`300000`) discards the whole batch with `logger.warn`.
- `process.getCreationTime()` returning `null`/`-1` (rare platforms) skips the batch with `logger.warn` (no anchor).

`perf_ui_first_screen` deprecation (fully replaced by `perf_ui_launch_react_commit_ms`): delete `UI_PERF_EVENT_FIRST_SCREEN`, `reportUiFirstScreen`, `pendingFirstScreenPayload`, and the replay branch in `setUiPerfArmsReporter`; remove `uiFirstScreenStartedAt` and the `reportUiFirstScreen` call from the `zcode-react-startup-ready` listener (keep the listener — T5 needs it); update tests and docs entries. Historical dashboards for the old event stop updating (accepted by the requester; the 75ms segment folds into the new chain).

Constants: `UI_PERF_ARMS_GROUP` = `"ui_perf"` (reused); 7 event names as above; `LAUNCH_TO_INPUT_SANITY_MAX_MS` = `300000`; `LAUNCH_MARKS_ARGV_PREFIX` = `"--zcode-launch-marks="`.

Error handling: all reporting wrapped in try/catch, failures only `logger.warn`, never blocking startup; missing reporter returns silently; any missing anchor (invalid T0 or unparsed argv marks) skips the whole batch — no partial data.

Tests (`uiPerfArmsTelemetry.test.ts`): 7 payloads with correct name/group/value and adjacent differences; negative span clamped to 0; sentinel discards; WelcomeScreen flag skips; missing/throwing reporter does not throw. Local verification (`arms_env=local`): logged-in cold start logs 7 `custom:perf_ui_launch_*` events with total ≈ sum of stages; `react_commit` ≈ the old ~75ms; unlogged cold start emits no `perf_ui_launch_to_input`; the three retained events regress clean.

Future (not this round): subdivide `react_commit`/`startup_gate` if dominant; set p50/p90/p99 baseline alerts once volumes stabilize; secondary-window/reload chains get separate events, never mixed into the cold-start distribution.
