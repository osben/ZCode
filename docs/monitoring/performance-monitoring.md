# Performance monitoring

> This document maintains stability, network and UI performance; the process-resource contract is in
> [all-process CPU / memory telemetry](./process-resource-telemetry.md). Business quality is in
> [business-monitoring.md](./business-monitoring.md).
>
> A quick reference of event names / value / fields of all performance telemetry (including the message-chain
> `/report` agent_trace) is in [performance-telemetry-catalog.md](./performance-telemetry-catalog.md).
>
> **V4 wiring note:** main/renderer ARMS stability, resource and network metrics are unchanged; conversation
> metrics are wired through the live-only workspace supervisor defined in
> [conversation-telemetry-v4.md](./conversation-telemetry-v4.md) and do not enter snapshot/recovery.

## Scope

- **P0 (current):** Electron desktop **stability**, **resource usage** and **network and communication** metrics,
  sent to **ARMS `@arms/rum-electron`** (`sendCustom`, `group` is `stability` / `resource` / `network`).
- **Not done:** Web/mobile remote-control RUM, Host/Agent process ANR, `/report` business telemetry (`app_launch`
  is not a crash-rate denominator). Agent unexpected exit is reported by desktop main as `perf_agent_crash`;
  mobile remote control reuses the shared host and does not report again.

## Boundary with business monitoring

| Belongs here                                    | Belongs to [business-monitoring.md](./business-monitoring.md)             |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| Crash rate, ANR, Crash-Free, freeze, exit codes | Product telemetry, Agent observability store, App Usage reliability panel |

## P0 stability metrics

### Common dimensions

All P0 custom events (`sendCustom`) carry:

| Field                      | Description                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `platform`                 | `macos` / `windows` / `linux`                                                                   |
| `app_version`              | `ZCODE_VERSION`                                                                                 |
| `arms_env`                 | `prod` / `local` (`mapZCodeEnvToArmsRumEnv(runtimeEnv)`; local development is fixed to `local`) |
| `device_mid`               | Desktop device identifier (hash of the `userData` path)                                         |
| `telemetry_schema_version` | Version of the stability event definitions; fixed at `2` after this fix                         |
| `scene_lifecycle`          | See below                                                                                       |
| `scene_window`             | See below                                                                                       |

**Scene lifecycle**

| Value            | Meaning                                  |
| ---------------- | ---------------------------------------- |
| `cold_start`     | Process cold start, `perf_app_start`     |
| `runtime`        | Normal running (default)                 |
| `app_quit`       | User/system quit                         |
| `update_install` | Quit for `quitAndInstall` update install |

**Scene window (first version)**

| Value             | Meaning                           |
| ----------------- | --------------------------------- |
| `main`            | Main business window              |
| `process_monitor` | Resource Manager singleton window |
| `other`           | Any other `BrowserWindow`         |

### 1. Crash rate

- **Renderer Crash rate:** `count(perf_crash where crash_scope=main_window_renderer) / app_start_count`.
- **Native Crash rate:** `count(crashReporter where crash_scope=app_native_process and native_dump_process_role=main) / app_start_count`.
- **Denominator:** `perf_app_start`, once per process (after `await armsInitPromise`, delayed about 3.2 s after
  the main window's first-paint `did-finish-load`).
- **Never add:** Renderer Crash and Native Crash must be counted per source. A Windows renderer dump may also
  contain the product exe, so one incident can produce both an Electron callback and a crashReporter dump; the two
  share no stable incident ID and adding them double-counts.
- **Not counted as Renderer Crash:** `auxiliary_window_renderer`, `embedded_webview` (Page Crash), `host`, Agent
  Crash, recoverable GPU/Utility exits.
- **Counting:** every Electron `render-process-gone` / `child-process-gone` callback reports once, with no
  five-minute client de-duplication by `crash_kind`. ARMS network retries are handled by the server event
  identifier; a coarse in-process time window must not swallow another real crash.

```text
One Windows renderer crash
        │
        ├─ render-process-gone ── perf_crash / electron_callback
        │                              └─ Renderer Crash rate
        │
        └─ Crashpad dump ─────── crashReporter / crash_reporter_dump
                                   │
                                   ├─ role=main ── app_native_process ── Native Crash rate
                                   └─ unknown/helper ── native_dump_unattributed
                                                        └─ diagnostics only, not in Crash-Free

Two per-source events ── union by device_mid ── Crash-Free
             └─ never add event counts directly
```

**Crash classification**

`crash_scope` says which product process/page crashed, `crash_cause` says why. Do not mix them with `js` /
`native` again.

| Source                                                         | `crash_scope`               | `crash_cause`                                   | `crash_source`        |
| -------------------------------------------------------------- | --------------------------- | ----------------------------------------------- | --------------------- |
| Main business window `render-process-gone`                     | `main_window_renderer`      | `oom` / `process_crashed` / `abnormal_exit` / … | `electron_callback`   |
| Auxiliary windows such as Resource Manager / update / About    | `auxiliary_window_renderer` | same                                            | `electron_callback`   |
| Built-in browser `<webview>` `render-process-gone`             | `embedded_webview`          | same                                            | `electron_callback`   |
| ZCode Host `child-process-gone`                                | `host`                      | `process_crashed` / `abnormal_exit` / …         | `electron_callback`   |
| ARMS crash dump explicitly marked as main process              | `app_native_process`        | `native_crash`                                  | `crash_reporter_dump` |
| ARMS crash dump only confirmed to come from the product binary | `native_dump_unattributed`  | `native_crash`                                  | `crash_reporter_dump` |
| `reason=killed` / `clean-exit`                                 | —                           | not a crash, goes to `perf_process_exit`        | —                     |

Electron `reason=memory-eviction` and `reason=oom` are both classified `crash_kind=oom`, `crash_cause=oom`; the
former means Chromium evicted the process under memory pressure.

`crash_kind` is kept only for historical-query compatibility: in schema v2 `oom` stays `oom` and every other
process crash is `native`; the historical value `js` is no longer added. A Page Crash is queried directly as
`perf_crash AND crash_scope=embedded_webview`; no second `perf_page_crash` is added, to avoid reporting the same
incident twice.

The ARMS `crashReporter` scans the shared crash-dump directory. Before reporting it verifies that the current
ZCode product executable appears in `binary_images`; dumps of external programs such as `hdc`,
`plugin-container`, `chrome-headless-shell` are dropped. The filter walks only existing metadata of the crash
batch and adds no sampling, file or child-process cost. The trusted-name set must include the product app name
and `basename(process.execPath)`, covering development `Electron` and Linux Preview `zcode-preview`.

Matching the product binary alone does not prove the dump came from the main process: Electron child processes on
Linux/Windows may share the executable. An event uses `crash_scope=app_native_process` only when
`native_dump_process_role` (or the compatible process-role metadata) explicitly marks it `main`; an unknown or
child role keeps the raw event but uses `crash_scope=native_dump_unattributed` and does not enter App Crash /
Crash-Free.

The role metadata chain is fixed as: Crashpad structured `process_type` / `ptype` → the `@arms/rum-electron` crash
collector extracts it from the minidump Crashpad info and annotation RVA into `meta.process_type` →
`readNativeDumpProcessRole()`, where `browser` normalizes to `main`. The collector must not scan the whole dump
for adjacent key/value bytes; same-name bytes not referenced by the annotation structure cannot take part in role
determination. `meta.process` (the app name) must not be used to guess the role. A dependency upgrade or SDK patch
must keep this passthrough, otherwise all dumps without a role stay in `native_dump_unattributed`.

On Windows and Linux the Electron main process and some child processes may share one product executable name, so
`binary_images` alone cannot reliably tell the process role. A dump not marked by the main process must not be
used directly for Crash-Free; Native Crash and Renderer Crash must use their own per-source ratios and never be
combined into an `app_crash_count`.

### 1.1 Agent process crash

- **Start event:** after Node `spawn` is received, `perf_agent_start(value=1)` is reported once per runtime; a
  spawn failure produces no start event.
- **Ready event:** when the same runtime first passes the provider/model gate, `perf_agent_ready(value=1)` is
  reported with `startup_duration_ms`; a read-only runtime does not count ready early.
- **Event:** `perf_agent_crash`, `value=1`, counted by events or `sum(value)`.
- **Judgement:** the Agent is a long-running process; an exit without a Host active-exit intent is an unexpected
  exit even with `exit_code=0`.
- **Exclusions:** workspace/app active recycling is not reported; request-timeout recycling is recorded
  `watchdog_recycle` and not mixed into crash; `protocol-close` is a crash result and cannot be an exclusion.
- **App-exit protection:** after desktop main emits `perf_app_exit` it keeps `app_quit` / `update_install`; an
  Agent exit arriving asynchronously afterwards does not enter crash.
- **Controlled-termination compatibility class:** local desktop RUM excludes Windows `exit_code=0x40010004` and
  POSIX `signal=SIGTERM` only when there is no structured exit root cause. `protocol-close` establishes no
  active-exit intent, but the Host passes the first cleanup reason as `termination_reason`; even if later
  process-tree recycling produces a controlled system exit trait, a crash is still reported as a protocol fault.
- **Diagnostics:** a redacted stderr tail of at most 4000 characters, with `error_name/error_code/error_fingerprint`,
  `crash_phase`, `termination_class`, `termination_reason`, `diagnostic_class`. The summary prefers OOM, SQLite,
  errno and drops structural noise such as `[Object]`, GC headers and native stack addresses. Workspace paths,
  command arguments, credentials and session content are never uploaded; bare `sk-...` API keys must be redacted
  in both services and desktop main.
- **Instance correlation:** `perf_agent_start` / `perf_agent_ready` / `perf_agent_crash` /
  `perf_agent_spawn_error` use the same random `runtime_instance_id`; it contains no workspace, PID or device
  information.
- **Start failure:** reported separately as `perf_agent_spawn_error(value=1)`.
- **Detailed contract:** [Agent process crash ARMS reporting](./agent-process-crash-arms.md).

### 2. ANR / unresponsive rate

- **Formula:** `anr_count / app_start_count` (platform x version).
- **Judgement:** timing starts at `webContents` `unresponsive` and ends at `responsive` or destruction; lasting at
  least **`STABILITY_ANR_THRESHOLD_MS` (5000)** reports `perf_anr`.
- **Windows:** relies on Electron/Chromium `unresponsive`, consistent with the system "program not responding"; no
  Win32 API is added.

### 3. Crash-Free rate

- **Formula:** `1 - (affected_users / active_users)`, industry baseline **>= 99.5%**.
- **User key:** `device_mid` (ARMS `properties` + `perf_app_start` binding).
- **Affected devices:** the de-duplicated `device_mid` union within the window of `main_window_renderer` plus
  `app_native_process` that passed product-binary verification with `native_dump_process_role=main`.
  `native_dump_unattributed` and auxiliary-window/Page/Host/Agent crashes do not enter the set.
- **Period:** daily/weekly dashboards are configured on the ARMS side; the client guarantees events carry
  `device_mid`.

### 4. Freeze rate

- **Formula:** `freeze_count / app_start_count` (platform x version).
- **Judgement:** `unresponsive` lasting at least **`STABILITY_FREEZE_THRESHOLD_MS` (30000)** without a crash in
  that episode → `perf_freeze`. If a crash follows, only the crash is counted, not the freeze.

### 5. Exit-code distribution

| Event               | Description                                                                       |
| ------------------- | --------------------------------------------------------------------------------- |
| `perf_app_exit`     | App exit (`before-quit`, `exit_kind=normal`, `exit_code=0`)                       |
| `perf_process_exit` | Abnormal child/renderer process exit (`exit_code`, `exit_reason`, `process_role`) |

Dashboard: histogram by `exit_code` x `process_role`; `exit_kind=normal` in its own bucket.

## P0 resource usage metrics

All-process CPU / memory sampling, the three resource events, performance red lines and the PRT-023 / PRT-024
acceptance are in [all-process CPU / memory telemetry](./process-resource-telemetry.md). The separate data-directory
size event is in [ZCode data directory usage ARMS reporting](./zcode-data-size-arms-telemetry.md).

---

## P0 network and communication metrics

Main aggregates and reports every **5 min** (1 min in development). Each `transport + interface` window sends one
`group=network/name=perf_network_window`; success, error and retry rates are derived from counts queries, with no
event split and no global error-rate mirror. After merging global properties an event must not exceed 20
properties.

### Data sources

| Transport | Collection point                                                                                                                             | Interface dimension        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| HTTP      | ARMS `beforeReport` parses `api` events (`dns_duration` / `connect_duration` / `ssl_duration` / `first_byte_duration` / `download_duration`) | `host+path`                |
| RPC       | Host `NetworkTelemetryChannelServer` wraps `ChannelServer`; batches return to main via `HostResponseTypes.NetworkTelemetryBatch`             | `channel.command`          |
| WebSocket | `WebRemoteControlDeviceTransport` remote-control relay connect/disconnect/reconnect                                                          | `web_remote_control.relay` |

### Event overview

| Event                 | Metrics                                                                                                                                                               | Dashboard dimensions                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `perf_network_window` | `value` = duration mean; success/fail/retry counts, duration peak/p95; HTTP phases keep only the mean; errors keep only the window's primary error type and its count | platform x `transport` x `interface` |

`primary_error_kind` is fixed to: `timeout`, `dns_failure`, `connection_reset`, `proxy_error`, `tls_error`,
`server_error`, `client_error`, `other`, with `primary_error_count`. With several error kinds in a window the
highest count wins, ties are broken by the fixed enum order, and any foreign value goes to `other`.

HTTP paths keep only low-cardinality static route segments explicitly registered in code; numbers, UUIDs, emails,
user slugs, long tokens and unregistered segments are all templated as `:id`. File URLs, Windows drive paths and
any POSIX local absolute path starting with `/` are all classed `local_file`; the local-path range must not be
guessed by enumerating common roots. The in-memory bucket of each transport has a hard cap, with the overflow
going to `other`; flush still keeps only the 40 interfaces with the most requests.

Constants: `NETWORK_REPORT_INTERVAL_MS` production 300000 / development 60000; Host batch flush 30 s / at most 200
entries.

## P0 client-side UI performance metrics

Renderer (UI) telemetry goes through `reportArmsCustomEvent` → IPC → `armsRum.sendCustom`. Events use
`group=ui_perf` and the name prefix `perf_ui_`. 100% sampled. Common dimensions are filled by the main IPC handler
(`app_version` / `arms_env` / `device_mid` / `platform` / `renderer_id`).

### Event overview

| Event                             | `value`                               | Source                                                                           | Key properties                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `perf_ui_launch_to_input`         | Total launch-to-input time, ms        | Process creation (`getCreationTime`) → startup gate cleared, input usable        | `session_id`                                                                                                                                                                                    |
| `perf_ui_launch_electron_init_ms` | Electron startup, ms                  | Process creation → main JS                                                       | `session_id`                                                                                                                                                                                    |
| `perf_ui_launch_app_ready_ms`     | main initialization, ms               | main JS → `app.whenReady`                                                        | `session_id`                                                                                                                                                                                    |
| `perf_ui_launch_window_ms`        | Window orchestration, ms              | `whenReady` → `loadURL`                                                          | `session_id`                                                                                                                                                                                    |
| `perf_ui_launch_renderer_load_ms` | renderer load, ms                     | `loadURL` → bundle execution                                                     | `session_id`                                                                                                                                                                                    |
| `perf_ui_launch_react_commit_ms`  | React rendering, ms                   | bundle → first React commit                                                      | `session_id`                                                                                                                                                                                    |
| `perf_ui_launch_startup_gate_ms`  | Startup gate, ms                      | React commit → input usable (auth/provider/workspace recovery)                   | `session_id`                                                                                                                                                                                    |
| `perf_ui_session_open_start`      | Session-open start count              | Logical open start after Renderer pane acquire                                   | `session_open_id` / `session_id` / `open_kind` / `open_trigger` / `client_mode`                                                                                                                 |
| `perf_ui_session_open_result`     | First-screen-to-interactive total, ms | First snapshot paint with an interactive Composer; failure/timeout also reported | `status` / `session_open_id` / `session_id` / Host/CLI/Renderer stage durations                                                                                                                 |
| `perf_ui_first_token`             | First-token latency, ms               | Mirrors `time_to_first_token` of `message_completion`                            | `model` / `talk_id` / `message_id`                                                                                                                                                              |
| `perf_ui_message_complete`        | End-to-end message duration, ms       | Mirrors `duration_ms` of `message_completion`                                    | `result` / `talk_id` / `message_id`                                                                                                                                                             |
| `perf_ui_stream_stall`            | Real stall duration, ms               | Gap between adjacent streamed text chunks > 3000 ms                              | `stall_ms` / `waiting_tool` / `talk_id` / `message_id`                                                                                                                                          |
| `perf_ui_tool_call_detail`        | Tool terminal duration, ms            | `raw.result.perf` of a `tool_call_update` terminal state                         | `tool_name` / `status` / `talk_id` / `message_id` / `tool_call_id` / `parent_tool_call_id` / `child_tool_call_id` / `child_session_id` / `agent_id` / `agent_type` / tool-internal stage fields |

### Notes and boundaries

- **Launch stages:** the 7 segments are each reported once per process cold start, `value` is the ms of each
  segment (clamped non-negative with `Math.max(0,...)`). The anchor is `process.getCreationTime()`; main's T0-T3
  are injected into the renderer through the main window loadURL query (`zcodeLaunchMarks`) and computed/reported
  together when the startup gate clears (`isStartupRenderBlocked` turns false). Logged-out (WelcomeScreen) does
  not report; totals > 300000 ms are discarded as sentinels. `session_id` correlates the segments of one launch.
  The old `perf_ui_first_screen` is deprecated and its meaning merged into `perf_ui_launch_react_commit_ms`.
- **First session open:** `perf_ui_session_open_start` / `perf_ui_session_open_result` produce at most two events
  per logical open; stage timing is carried by the `v4/conversation/subscribe` ACK and ARMS events are not split by
  stage; the Web/mobile reporter is empty. Full fields and boundaries:
  [Session first-open ARMS telemetry](./session-open-telemetry.md).
- **First token / message duration:** the V4 supervisor reuses the `messageTelemetry` builder; the time anchor is
  still the renderer receipt clock; initial/recovery do not back-report.
- **Tool terminal detail:** `perf_ui_tool_call_detail` is reported only when a tool completes/fails/is denied and
  `raw.result.perf` exists. Bash carries `command_run_ms` / `first_output_ms` / `no_output_ms` / `timed_out` /
  `command_category` etc.; Edit/Write carry `fs_read_ms` / `fs_write_ms` / `patch_match_ms` / file sizes etc.
  Subagent-mirrored child tools additionally carry `parent_tool_call_id` / `child_tool_call_id` /
  `child_session_id` / `agent_id` / `agent_type` to drill from the parent `Agent` step to child-tool durations.
- **Per-step duration:** `agent_step` keeps the old `/report` definition; the ARMS **RUM Custom Event** still only
  does low-frequency per-turn and tool-terminal attribution, and `/report agent_step` must not be mirrored
  one-by-one as RUM events. The CLI Agent Loop `zcode.agent.step` OTel Span is a separate strongly-typed execution
  Trace whose target structure is in the [CLI Agent Telemetry guide](../trace/cli-agent-telemetry.md); it does not
  go through Renderer IPC nor reuse the old `agent_step` schema.
- **Stream stall:** `value` is the real chunk gap (not the threshold); the threshold
  `STREAM_STALL_REPORT_THRESHOLD_MS=3000` is only the reporting gate. **Tool calls are not counted:**
  `clearStreamStallTracking` runs when `tool_call`/`tool_call_update` arrives, and the first text chunk after a
  tool is treated as the first one and not compared with chunks before the tool, so normal tool execution is not
  misjudged as a stall. A chunk gap > 3 s may be rooted upstream (model inference/network) rather than client
  rendering stutter, but users perceive "the UI does not move for a long time", so it is reported; the threshold
  will be tightened from online distributions. `waiting_tool` is fixed to `false` in this phase.
- **Render stutter (longTask):** collected automatically by the ARMS Browser SDK (`browserCollectors.longTask`),
  not instrumented by hand here. Main `beforeReport` distills the top-5 LoAF/rAF attribution in the SDK
  `snapshots` into low-cardinality fields merged into the same longTask's `properties`: `loaf_script_count`,
  `loaf_top_duration_ms`, `loaf_top_invoker_type`, `loaf_top_share_pct`. No raw script name, URL, path or source
  fragment is reported; when `snapshots` is missing/unparsable it is skipped without affecting the raw longTask
  report.

Constant (code): `STREAM_STALL_REPORT_THRESHOLD_MS=3000` (`packages/ui/src/lib/uiPerfArmsTelemetry.ts`).

## ARMS dashboard suggestions

- Historical events such as stability ones can be filtered by `properties.event_name`; to save the attribute
  budget, resource events and network `perf_network_*` must be filtered directly by custom `name`.
- Crash rate: the schema v2 App Crash numerator is filtered by `crash_scope` and grouped by `crash_cause`; the
  denominator is `perf_app_start`.
- The Native Crash dashboard must also filter `json_extract_scalar(properties, '$.native_dump_process_role')='main'`;
  otherwise historical dumps that only matched the product binary with unconfirmed process role still pollute
  Native Crash / Crash-Free.
- Dimensions: `platform`, `app_version`, `scene_lifecycle`, `scene_window`, `crash_scope`, `crash_cause`,
  `telemetry_schema_version`.
- Environment: development builds `arms_env=local`, production `prod`.

## Implementation index

| Module                             | Path                                                      |
| ---------------------------------- | --------------------------------------------------------- |
| P0 stability reporting             | `packages/desktop/src/main/desktopStabilityTelemetry.ts`  |
| P0 resource reporting              | `packages/desktop/src/main/desktopResourceTelemetry.ts`   |
| P0 network reporting               | `packages/desktop/src/main/desktopNetworkTelemetry.ts`    |
| P0 client UI performance reporting | `packages/ui/src/lib/uiPerfArmsTelemetry.ts`              |
| Network aggregation                | `packages/desktop/src/main/networkTelemetryAggregator.ts` |
| RPC network middleware             | `packages/rpc/src/network-telemetry-middleware.ts`        |
| Host network batches               | `packages/desktop/src/host/hostNetworkTelemetry.ts`       |
| Aggregation tools                  | `packages/desktop/src/main/resourceMetricsStats.ts`       |
| ARMS initialization                | `packages/desktop/src/main/appARMSBootstrap.ts`           |
| Crash archive                      | `packages/desktop/src/main/desktopCrashCapture.ts`        |
| Main-process wiring                | `packages/desktop/src/main/index.ts`                      |
| Resource Manager window ID         | `packages/desktop/src/main/resourceManagerWindow.ts`      |

## Local verification checklist

1. Start a dev build: main-process log `[stability] perf_app_start reported` (or ARMS `beforeReport` contains a
   custom event).
2. Trigger an ordinary JS exception in DevTools: only an exception should appear, not a fake process Crash;
   simulating `render-process-gone` should show `perf_crash` with the right `crash_scope` / `crash_cause`.
3. Simulate a hang: a synchronous main-thread loop >= 5 s → `perf_anr`; >= 30 s without a crash → `perf_freeze`.
4. ARMS console: pick environment `local`, group by `app_version` x `platform` and check numerator/denominator.
5. Regression: `/report` `app_launch` still reports independently; its count need not equal `perf_app_start`.
6. Resources: log `[resource] sampling started`; after about 1 min (dev / E2E) `[resource] perf_process_window +
perf_system_window flushed` appears; `beforeReport` contains one `custom:perf_process_window` per role and one
   `custom:perf_system_window`.
7. Network: log `[network] reporting started`; after triggering RPC or HTTP, about 1 min later `[network]
perf_network flushed` and `custom:perf_network_window` appear.
8. ARMS ingestion may lag by minutes; query by the `beforeReport` time anchor.
