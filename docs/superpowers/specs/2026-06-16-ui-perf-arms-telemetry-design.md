# Client UI Performance ARMS Reporting Design

Status: implemented. The authoritative current event catalog and field calibers live in `docs/monitoring/performance-telemetry-catalog.md`; the original stream-hook integration points described below predate the V4 main chain. `perf_ui_first_screen` was later replaced by the staged `perf_ui_launch_*` events (see `docs/superpowers/specs/2026-06-17-launch-to-input-telemetry-design.md`).

Background: ARMS coverage was system-level and main-process only — `group=stability` (launch, crash, ANR, freeze, exit codes; `desktopStabilityTelemetry.ts`), `group=resource` (CPU, memory, GPU, disk, handles, threads; `desktopResourceTelemetry.ts`), `group=network` (HTTP/RPC/WebSocket quality; `desktopNetworkTelemetry.ts`) — plus renderer webvitals/longTask from the ARMS Browser SDK. This design fills the renderer business-level UI performance gap with ARMS `group=ui_perf` events prefixed `perf_ui_` (plus `plan_request`), 100% sampled, no sampling switch, reusing the existing `reportArmsCustomEvent` → IPC → `armsRum.sendCustom` chain without touching main/preload/IPC channel definitions (`PlatformChannels.ReportArmsCustomEvent`).

Reporting chain (existing, reused):

```
UI calls reportXxx(...)
  → uiPerfArmsTelemetry singleton reporter.reportArmsCustomEvent({name, group, value, properties})
  → window.zcode.reportArmsCustomEvent (packages/desktop/src/renderer/src/main.tsx:147)
  → IPC PlatformChannels.ReportArmsCustomEvent
  → packages/desktop/src/main/desktopMainIpcRemote.ts:119 handler
     auto-attaches common dims: event_name / app_version / arms_env / device_mid / platform / renderer_id / metric_value
  → armsRum.sendCustom({ name, type: "custom", group, value, properties })
```

Common dimensions come from the main handler; the UI never duplicates them.

Architecture — one module, many callers (`packages/ui/src/lib/uiPerfArmsTelemetry.ts`, modeled on the existing business telemetry helper):

- Module-level singleton reporter (`armsReporter: ArmsReporter | null`, `ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">`), injected/cleared in `Root.tsx` via `setUiPerfArmsReporter`, with `clearUiPerfArmsReporterForTest()`. Each event exports a `reportXxx(...)` that builds a payload and reports.
- A module singleton (not a `usePlatform` hook) because trigger points live outside React component context: first screen at `main.tsx` module level, first-token/duration in `messageTelemetry.ts`, stalls in stream handlers.
- All reporting wrapped in try/catch: failures only `logger.warn`, never block send/render/startup. Missing reporter returns silently.
- Constants centralized: `UI_PERF_ARMS_GROUP = "ui_perf"`, event-name constants, `STREAM_STALL_REPORT_THRESHOLD_MS = 3000`.

Core events (all `group = "ui_perf"`, `value` = primary ms metric, details in `properties`):

- `perf_ui_first_screen`: first-screen time from a `main.tsx` module-load timestamp to the existing `"zcode-react-startup-ready"` event. (Superseded by the launch staging; kept here as history. The reporter-injection race — `StartupReadyNotifier`'s effect ran before the reporter injection, so the payload had to be staged in `pendingFirstScreenPayload` and replayed on injection — was the fixed root cause.)
- `perf_ui_first_token`: mirrors `time_to_first_token` already computed by `finalizePromptTelemetry()`; no new timing, `/report` untouched. Properties: `model`, `talk_id`, `message_id`.
- `perf_ui_message_complete`: mirrors `duration_ms`; `result` = success / fail / user_interrupt. The overall experience metric.
- `perf_ui_stream_stall`: during body streaming, report once when the gap to the previous chunk exceeds `STREAM_STALL_REPORT_THRESHOLD_MS` (3000); `value` is the real gap, the threshold is only a gate. Per-task `lastChunkAt` lives in the stream chunk handlers; terminal handlers clear it. Tool calls reset tracking (`clearStreamStallTracking(taskId)`) so tool execution time is never misread as a stall; the first body chunk after a tool starts fresh. `waiting_tool` is fixed `false` in this stage. Semantic boundary (documented in monitoring docs): a >3s chunk gap is usually upstream (model inference / network), not client rendering jank — but it is user-perceivable, hence reported; longTask/render jank stays with the ARMS Browser SDK (`browserCollectors.longTask` enabled in `appARMSBootstrap.ts`).

## 2026-06-25 attribution enhancements

3.1.5 full RUM showed the slowest Agent/UI points concentrated in Bash, reasoning, generation, Write, Edit; existing events could not attribute slowness to queue, model request, retries, tool permission waits, tool execution, stream stalls, or end-to-end completion. Per-step detail stays in the `/report` `agent_step` chain (not mirrored per-item to ARMS, avoiding event amplification on long messages).

Performance constraints (binding):

- No per-token or per-chunk events; `perf_ui_stream_stall` reports only over-threshold gaps.
- End-to-end breakdown reports once per turn, reusing fields `finalizePromptTelemetry()` already computed.
- No per-item `agent_step` mirroring: `/report` keeps step detail; ARMS keeps per-turn breakdown, tool terminal states, and stall events.
- Model network state mirrors only existing low-frequency runtime events: started / completed / failed / retry_scheduled / stream_stalled.
- High-cardinality fields report only stable keys or sanitized/normalized values — never raw commands, file paths, request headers, or response bodies.
- All reporting stays async fire-and-forget, warn-only on failure.

New/enhanced events:

| name                     | value                | Trigger                                           | Key properties                                                                                                                                                                                                                   |
| ------------------------ | -------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `perf_ui_turn_breakdown` | `duration_ms`        | Once per prompt completion              | `talk_id`, `message_id`, `model`, `result`, `ttft_ms`, `waiting_ms`, `tool_call_total`, `tool_call_failed`, `agent_step_cnt`, `retry_cnt`, `file_change_cnt`, `generated_code_lines`                                              |
| `plan_request`           | `1` or `duration_ms` | All model network states from `task_network_debug_status` | `request_status`, `request_id`, `task_id`, `input_id`, `query_id`, `event_key`, `attempt`, `max_attempts`, `status_code`, `duration_ms`, `delay_ms`, `idle_ms`, `timeout_ms`, `retryable`, `reason`, `transport`, `provider_kind` |
| `perf_ui_stream_stall`   | gap ms               | Adjacent body/thought chunk gap over threshold                 | adds `chunk_type` (`message` / `thought`); normal chunks still unrecorded                                                                                                                               |

Attribution calibers: `perf_ui_message_complete` stays the experience total; `perf_ui_turn_breakdown` flattens per-turn TTFT, permission waits, tool totals/failures, retries for ARMS attribution; `plan_request` (extended from started-only to all low-frequency network states) answers whether slowness comes from retries, failures, provider tail latency, or stream stalls; `perf_ui_stream_stall` remains UI-observed upstream gap, not React jank.

## Runtime tool-phase fields (second stage)

The Bash and Write/Edit fields below must be produced by the agent/tool runtime; the UI only passes them through, so UI-observed totals are never misread as intra-tool phases. They are converged into a structured `perf` field on tool results, arriving via the existing `tool_call_result` / `tool_call_update.raw.result.perf` chain. They never appear in model-visible text; they serve UI, debug, RUM, and structured session projection.

- Bash: `permission_wait_ms`, `command_run_ms`, `first_output_ms`, `no_output_ms`, `exit_code`, `timeout`, `output_bytes`, `command_category`, `command_name`, `command_count`, `command_status`.
- Write/Edit: `permission_wait_ms`, `fs_read_ms`, `fs_write_ms`, `patch_match_ms`, `file_count`, `total_bytes`, `max_file_bytes`, `hunk_count`, `match_attempts`, `workspace_kind`.

New event:

| name                       | value                                      | Trigger                                                            | Key properties                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `perf_ui_tool_call_detail` | `total_ms` or `command_run_ms/fs_write_ms` | Tool terminal state `completed/failed/denied` with `raw.result.perf` | `tool_name`, `status`, `talk_id`, `message_id`, `tool_call_id`, plus all Bash and Write/Edit fields above |

Volume/privacy constraints:

- At most one report per tool call, at terminal state.
- Never report raw commands, raw paths, file contents, diffs, or headers.
- `command_hash` stopped going to RUM/ARMS after the 2026-07-27 privacy review: common commands are dictionary-reversible and the field creates high cardinality. Only the public-Registry-whitelisted `command_name`, low-cardinality `command_category`, `command_count`, and `command_status` remain.
- `workspace_kind` uses only `local` / `remote` / `unknown`.

## 2026-07-01 longTask low-cardinality attribution summary

The ARMS Browser SDK's `longTask` event carries LoAF/rAF attribution in `snapshots` (top script `duration` + `invokerType`), but `snapshots` is unstable SDK metadata that does not reliably land as a queryable SLS dimension, while raw script names/URLs/paths are high-cardinality and leak paths. The main-process `beforeReport` therefore distills the top-5 attributions into low-cardinality fields merged into the same `longTask` event's `properties`, without new events:

| properties field         | Type   | Caliber                                                                                                                                                         |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loaf_script_count`     | number | attribution count in SDK `snapshots`, max 5.                                                                                                                |
| `loaf_top_duration_ms`  | number | max attribution `duration`, rounded to ms, negatives clamped to 0.                                                                                                   |
| `loaf_top_invoker_type` | string | top attribution source: `user-callback` / `event-listener` / `script` / `unknown`. rAF sources without `invokerType` count as `script`; invalid enums as `unknown`. |
| `loaf_top_share_pct`    | number | integer percent of `loaf_top_duration_ms / longTask.duration`; 0 when the total is missing, non-numeric, or ≤ 0.                                                               |

Boundaries: only the SDK's `event_type="longTask"` events are enhanced — no new `sendCustom` events and no change to `group=ui_perf` volume; parse failures, missing `snapshots`, or invalid attributions skip silently without affecting the original report; no raw script names, URLs, file paths, stacks, selectors, or source snippets reach SLS. The summary describes only the largest sampled attribution within one longTask and is not a complete React root cause — judge user impact together with `duration`, `fps`, `source`, and `perf_ui_*` events.

## Future adjustments (not this stage)

- Tighten the 3000ms stall gate from real p50/p90/p99 distributions.
- Add a client sampling switch only if high-frequency volumes grow too large.
- Split first-screen into phases (main ready / window creation / React commit) via the `phase` dimension.
