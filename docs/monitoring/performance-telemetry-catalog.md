# Performance Telemetry Event Dictionary

Cross-channel reference catalog answering "What are all performance-related telemetry events and what do they report?"

Detailed specifications and boundaries see [performance-monitoring.md](./performance-monitoring.md); this catalog only provides index and field quick reference.

For unified observation of CLI Agent model API OTel, see [CLI Agent Telemetry Development Guide](../trace/cli-agent-telemetry.md); effective after deploying ARMS OTLP configuration.

Data flows through four channels:

- **ARMS (main process)**: `@arms/rum-electron` `sendCustom`, process-level stability / resource / network; CLI resource samples reported to main.
- **ARMS (renderer/UI)**: `reportArmsCustomEvent` → IPC → main `sendCustom`, `group=ui_perf`.
- **ARMS (CLI Agent)**: `@zcode/telemetry` → OTLP/HTTP protobuf, model Logical Call / Physical Attempt.
- **`/report` (agent_trace)**: `reportAppTelemetryEvent`, message link quality and timing, **NOT ARMS**.

**V4 Integration Spec**: Recovery specs for chat `/report` and renderer ARMS see
[conversation-telemetry-v4.md](./conversation-telemetry-v4.md). Implementation must be wired via live-only fact feed,
cannot supplement from initial/recovery projections.

## `/report` Local Log Boundary

- `TelemetryCore` does not log requests, complete payloads, responses, response bodies, or raw errors locally.
- After all attempts finally fail, only a redacted `warn` is logged; fields limited to event name, event ID, attempt count, status classification and duration. Retries only use dev-mode `debug`. See
  [event-report-delivery-reliability.md](./event-report-delivery-reliability.md) for complete delivery contract.
- Failed reports continue along the original Promise rejection path to be handled by the caller; bounded retries shall not alter `device_mid` persistence or daily-active deduplication semantics.
- High-frequency events like `message_completion` / `agent_step` are prohibited from adding local
  console or disk logs for each report.

## Public Dimensions

| Channel               | Auto-Bearing Dimensions                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| ARMS main             | `platform` / `app_version` / `arms_env` / `device_mid` (+ channel-specific dimensions, see below)                                                  |
| ARMS ui_perf          | Same + `renderer_id` (auto-filled by main IPC handler)                                                                                             |
| `/report` agent_trace | `model_name` / `model_provider` / `ask_mode` / `agent` / `talk_id` / `message_id` / `workspace_kind` / `remote_kind` (version injected by backend) |
| ARMS CLI Agent        | `service.name=zcode-cli-agent` + `uid` (hash) / `device_mid` / `session_id` / `turn_id` / `trace_id` / `rid` / `operation` / `provider` / `model`  |

---

## I. ARMS Stability `group=stability`

Channel-specific dimensions: `scene_lifecycle` (cold_start / runtime / app_quit / update_install), `scene_window` (main / process_monitor / other).

| Event                      | Value            | Report Content                                                                                                                                                                                                | Trigger Condition                                                                                                 |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `perf_app_start`           | —                | Cold start count (Crash-Free denominator, bound `device_mid`)                                                                                                                                                 | Main window `did-finish-load` after **3.2s** delay (`PERF_APP_START_AFTER_VIEW_MS`)                               |
| `perf_crash`               | `1`              | `crash_scope` / `crash_cause` / `crash_source=electron_callback` / `crash_id` / backward-compatible `crash_kind`                                                                                              | `render-process-gone` / ZCode Host `child-process-gone`; one report per Electron callback                         |
| `perf_agent_start`         | `1`              | `runtime_instance_id` / `runtime_generation` / `provider`                                                                                                                                                     | Agent child process successfully triggered Node `spawn`                                                           |
| `perf_agent_ready`         | `1`              | `runtime_instance_id` / `runtime_generation` / `provider` / `startup_duration_ms`                                                                                                                             | Agent runtime first passed provider/model permission gate                                                         |
| `perf_agent_crash`         | `1`              | `runtime_instance_id` / `error_name` / `error_code` / `error_message` / `error_stack` / `error_fingerprint` / `exit_code` / `signal` / `uptime_ms` / `crash_phase` / `termination_class` / `diagnostic_class` | Host-managed Agent exit without intentional shutdown reason matching exclusion conditions; one report per runtime |
| `perf_agent_spawn_error`   | `1`              | `runtime_instance_id` / `error_name` / `error_code` / `error_message` / `error_stack` / `error_fingerprint` / `runtime_generation` / `diagnostic_class`                                                       | Agent command/cwd spawn failure                                                                                   |
| `perf_mcp_process_start`   | `1`              | `mcp_id` / `mcp_instance_id` / `mcp_source` / `mcp_isolation` / `runtime_surface`                                                                                                                             | Formal stdio MCP completes connection and `tools/list`; version probe not counted                                 |
| `perf_mcp_process_crash`   | `1`              | start marker + `exit_code` / `signal` / `uptime_ms` / `affected_session_count`                                                                                                                                | Stdio MCP that already sent start unexpectedly exits; intentional shutdown not counted                            |
| `perf_mcp_session_startup` | `process_count`  | `session_id` / `configured_count` / `connected_count` / `process_count` / `failed_count`                                                                                                                      | First MCP startup snapshot of session lease                                                                       |
| `perf_anr`                 | `duration_ms`    | Unresponsiveness duration                                                                                                                                                                                     | `webContents` `unresponsive` for ≥ **5s** (`STABILITY_ANR_THRESHOLD_MS`)                                          |
| `perf_freeze`              | `duration_ms`    | Freeze duration (no crash during freeze)                                                                                                                                                                      | `unresponsive` for ≥ **30s** (`STABILITY_FREEZE_THRESHOLD_MS`)                                                    |
| `perf_app_exit`            | `exit_code` (=0) | `exit_kind=normal`                                                                                                                                                                                            | `before-quit`                                                                                                     |
| `perf_process_exit`        | `exit_code`      | `exit_reason` / `process_role`                                                                                                                                                                                | Child process / renderer abnormal exit                                                                            |

SDK native crash does not go through `sendCustom(group=stability)`, uses separate event spec:

| `event_type` | `type`  | `source`        | Report Content                                                                                                                                                                          | Trigger Condition                                                                                                                                             |
| ------------ | ------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exception`  | `crash` | `crashReporter` | `crash_scope=app_native_process` (only if `native_dump_process_role=main`) or `native_dump_unattributed` / `crash_cause=native_crash` / `crash_source=crash_reporter_dump` / `crash_id` | dump's `binary_images` matches product app name or real runtime exe; only matched product binary but no main process role marker → `native_dump_unattributed` |

Implementation: `packages/desktop/src/main/desktopStabilityTelemetry.ts`,
`packages/desktop/src/main/appARMSBootstrap.ts`

---

## II. ARMS Resource `group=resource`

Resource chain fully implemented since v3.12.1; complete sampling, aggregation, and failure semantics see
[full-process CPU/memory monitoring](./process-resource-telemetry.md). Production aggregation window is 5 minutes,
development builds and E2E are 1 minute; Bash completes immediately. Full collection across all devices and roles.
Three events share `platform`, `app_version`, `arms_env`, `device_mid` four global attributes,
combined with event-specific properties yields at most 20 items; undefined not sent. CPU is normalized percentage across the machine, memory in KB.
`platform` / `arch` / `logical_cpu_count` / `total_memory_gb` describe actual runtime machine, remote CLI / MCP cover desktop defaults; `app_version` is the version of the reporting desktop.

Role enumeration: `main`, `renderer_main`, `renderer_guest`, `gpu`, `chromium_other`, `host`,
`scheduler`, `cli_chat`, `cli_aux`, `mcp`. main's `getAppMetrics()` provides Chromium CPU / RSS every 10 seconds,
Node and main renderer heap every 60 seconds; CLI self-samples every 60 seconds, MCP every 5 minutes uses generic process probe.
Main has zero external processes; thread count, GPU memory, disk I/O and 10% role sampling removed.
Local `[memory]` log continues and reuses telemetry reads, see [process memory local diagnostic log](./memory-diagnostics-log.md).

### `perf_process_window`

Per role / runtime surface / machine grouping every 5 minutes; MCP additionally grouped by mcp_id.
`value=cpu_percent_mean`. Node and renderer_main at most 20 properties (heap omitted when no reading),
mcp 19 properties, other Chromium roles 18 properties; whitelist union 21 items doesn't mean sending 21 items.

| Category  | Property                  | Description                                                                        |
| --------- | ------------------------- | ---------------------------------------------------------------------------------- |
| Dimension | `process_role`            | 10 enumeration values above                                                        |
| Dimension | `runtime_surface`         | `local` / `remote`                                                                 |
| Dimension | `arch`                    | Runtime architecture                                                               |
| Dimension | `logical_cpu_count`       | Runtime logical core count                                                         |
| Dimension | `total_memory_gb`         | Runtime physical memory, rounded to GB                                             |
| Dimension | `mcp_id`                  | Only for `mcp` role                                                                |
| Status    | `background_ratio`        | 0 to 1, two decimal places                                                         |
| Status    | `uptime_minutes`          | Oldest process runtime minutes in this role                                        |
| CPU       | `cpu_percent_p95`         | Role's total CPU p95 within window                                                 |
| CPU       | `cpu_percent_peak`        | Role's total CPU max within window                                                 |
| Memory    | `rss_kb_total_mean`       | Role's all processes RSS sum's mean                                                |
| Memory    | `rss_kb_total_peak`       | Role's all processes RSS sum's max                                                 |
| Memory    | `rss_kb_max_process_peak` | Single process RSS max within window                                               |
| Memory    | `heap_used_kb_mean`       | Only Node and renderer_main; max single process reading per process, then averaged |
| Memory    | `heap_used_kb_peak`       | Same, take max                                                                     |
| Quality   | `process_count_peak`      | Max concurrent process count for this role in window                               |
| Quality   | `sample_count`            | Sample count in window; main role expected 30, CLI role expected 5, mcp is 1       |

### `perf_system_window`

Per desktop device every 5 minutes, `value=app_cpu_percent_mean`, fixed 17 properties.
Chromium uses same tick for precise aggregation, CLI / MCP use most recent sample (120 / 600 seconds expiry); remote not counted.

| Category  | Property                                         | Description                                                                                  |
| --------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Dimension | `arch`, `logical_cpu_count`, `total_memory_gb`   | Desktop machine                                                                              |
| Status    | `background_ratio`, `app_uptime_minutes`         | `background_ratio` same source as role events; uptime takes main process runtime             |
| System    | `system_cpu_percent_p95`                         | `os.cpus()` diff                                                                             |
| System    | `system_free_memory_kb_min`                      | `os.freemem()` min within window                                                             |
| App       | `app_cpu_percent_p95`                            | All local ZCode process sum                                                                  |
| App       | `app_rss_kb_total_mean`, `app_rss_kb_total_peak` | Chromium-based every 10 seconds precise sum, plus CLI and MCP most recent known sample       |
| App       | `process_count_total_peak`                       | Peak total ZCode process count on this machine                                               |
| Quality   | `sample_count`                                   | First tick with no CPU baseline doesn't produce sample, 29 expected per 5 min window         |
| Quality   | `telemetry_self_ms`                              | Main-side sampling and aggregation code cumulative wall clock ms, `performance.now()` timing |

### `perf_tool_exec_resource`

Reported immediately on Bash completion when run ≥ 15 seconds, `value=duration_ms`.
Non-Windows has 12 properties; Windows has 10 properties (no tree two fields), sample_count=0.

| Category  | Property                | Description                                                                     |
| --------- | ----------------------- | ------------------------------------------------------------------------------- |
| Dimension | `runtime_surface`       |                                                                                 |
| Dimension | `tool_name`             | Currently fixed `bash` only                                                     |
| Dimension | `exit_kind`             | `completed` / `timeout` / `killed` / `error`                                    |
| Command   | `tree_rss_kb_peak`      | Command process tree RSS sum peak                                               |
| Command   | `tree_cpu_time_ms`      | Command process tree accumulated CPU time; divide by duration_ms for busy ratio |
| Command   | `sample_count`          | Sample count collected                                                          |
| Context   | `cli_rss_kb`            | CLI self RSS at command end                                                     |
| Context   | `system_free_memory_kb` | System free memory at command end                                               |

### Discontinued Resource Events

| Event                  | Discontinued Version and Replacement                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `perf_resource_window` | **Discontinued since v3.12.1**; replaced by role-level `perf_process_window` and device-level `perf_system_window` |
| `perf_resource_agent`  | **Discontinued since v3.12.1**; replaced by `perf_process_window` `cli_chat` / `cli_aux` roles                     |
| `perf_mcp_memory`      | **Discontinued since v3.12.1**; replaced by `perf_process_window` `mcp` role                                       |

### Independent Resource Events

`perf_resource_zcode_data_size` stays as local ZCode data root logical byte count spec, at most once per 24 hours per device,
see [ZCode Data Directory Size ARMS Report](./zcode-data-size-arms-telemetry.md). Older `perf_resource_cpu`
and other events only exist for historical queries. MCP's three stability lifecycle events see [MCP Process ARMS Observability](./mcp-process-arms-telemetry.md).

---

## III. ARMS Network `group=network`

**5min aggregated** (dev 1min). Each `{transport, interface}` sends one
`perf_network_window`, merged with global properties at most 20 items. HTTP path only preserves explicitly registered static route segments, other segments templated; any local absolute path unified as `local_file`; RPC=`channel.command`; WS=`web_remote_control.relay`.

| Event                 | Value            | Description                                                                |
| --------------------- | ---------------- | -------------------------------------------------------------------------- |
| `perf_network_window` | duration mean ms | counts + duration peak/p95; HTTP phases mean; primary error type and count |

Data source: HTTP parsed from ARMS `beforeReport` `api` event; RPC batches via Host `NetworkTelemetryChannelServer`; WS from remote control relay.
Implementation: `desktopNetworkTelemetry.ts`, `networkTelemetryAggregator.ts`, `packages/rpc/src/network-telemetry-middleware.ts`, `hostNetworkTelemetry.ts`

---

## IV. ARMS End-User UI Performance `group=ui_perf`

Renderer-side instrumentation, full sampling (100%).

### 4.1 Launch Phase Breakdown (7 segments, one per cold start, `session_id` groups same launch)

| Event                             | Value Measurement                                                 |
| --------------------------------- | ----------------------------------------------------------------- |
| `perf_ui_launch_to_input`         | **Total**: process creation (`getCreationTime`) → input focusable |
| `perf_ui_launch_electron_init_ms` | process creation → main JS                                        |
| `perf_ui_launch_app_ready_ms`     | main JS → `app.whenReady`                                         |
| `perf_ui_launch_window_ms`        | `whenReady` → `loadURL`                                           |
| `perf_ui_launch_renderer_load_ms` | `loadURL` → bundle execution                                      |
| `perf_ui_launch_react_commit_ms`  | bundle → React first commit                                       |
| `perf_ui_launch_startup_gate_ms`  | React commit → input focusable (auth/provider/workspace restore)  |

### 4.2 Session First Open (at most two entries per logical open)

| Event                         | Value      | Key Properties                                                                              |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `perf_ui_session_open_start`  | `1`        | `session_open_id` / `session_id` / `open_kind` / `open_trigger` / `client_mode`             |
| `perf_ui_session_open_result` | `total_ms` | `status` / `session_open_id` / `session_id` / per-phase timing fields for Host/CLI/Renderer |

Sentinel: any segment negative (cross-process clock skew) or total > **300000ms** (`LAUNCH_TO_INPUT_SANITY_MAX_MS`) → **discard entire batch**. Not reported when not logged in (WelcomeScreen). Old `perf_ui_first_screen` deprecated, semantics merged into `perf_ui_launch_react_commit_ms`.

### 4.3 Message Link (mirrors `/report` `message_completion`, no new timing)

| Event                      | Value Nature                                                 | Key Properties                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `perf_ui_first_token`      | First token latency ms                                       | `model` / `talk_id` / `message_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `perf_ui_message_complete` | Message end-to-end latency ms                                | `result` / `model` / `talk_id` / `message_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `perf_ui_stream_stall`     | Real stall ms (between adjacent content chunks > **3000ms**) | `stall_ms` / `waiting_tool` / `model` / `talk_id` / `message_id` (first chunk after stall, or empty if unavailable)                                                                                                                                                                                                                                                                                                                                                                                              |
| `perf_ui_tool_call_detail` | Tool terminal state latency ms                               | `tool_name` / `status` / `talk_id` / `message_id` / `tool_call_id` / `parent_tool_call_id` / `child_tool_call_id` / `child_session_id` / `agent_id` / `agent_type` / `total_ms` / `permission_wait_ms` / `command_run_ms` / `first_output_ms` / `no_output_ms` / `timed_out` / `command_name` / `command_category` / `command_count` / `command_status` / `fs_read_ms` / `fs_write_ms` / `patch_match_ms` / `file_count` / `total_bytes` / `max_file_bytes` / `hunk_count` / `match_attempts` / `workspace_kind` |

`perf_ui_stream_stall` boundary: not counted during tool calls (`clearStreamStallTracking` on `tool_call`/`tool_call_update` arrival); threshold `STREAM_STALL_REPORT_THRESHOLD_MS=3000` only as report gate, value is real interval. `model` takes current active prompt's `model_name` via `getActivePromptModelName` (chunk itself doesn't carry model), empty if no active prompt. Rendering jank (`longTask`) automatically collected by ARMS Browser SDK, not manually instrumented here.

`agent_step` details stay only in `/report` `agent_trace` chain; ARMS RUM doesn't duplicate per step
to avoid inflating IPC and custom event volume per message. RUM side uses
`perf_ui_turn_breakdown.agent_step_cnt`, first token, end-to-end, stream stall and tool terminal events for low-frequency attribution.
CLI directly reports `zcode.agent.step` OTel Span which is
[CLI Agent Telemetry Development Guide](../trace/cli-agent-telemetry.md), doesn't go through this IPC/RUM chain,
thus not equivalent to `/report agent_step`.
`perf_ui_tool_call_detail` only mirrors tools that have `raw.result.perf` at terminal state.
Subagent mirror sub-tools carry parent-child linkage fields, allowing drill-down from parent `Agent`'s `tool_call_id` to sub-tools in ARMS via `parent_tool_call_id`. Non-subagent tools have empty fields for these.

`command_name` only allows static executable file name from public command Registry or `empty` / `compound` /
`other` buckets. `command_hash` no longer enters RUM/ARMS since 2026-07-27: even truncated hash
may create high cardinality and enable reverse lookup via common command dictionary; this field only preserved in CLI local structured diagnostics object. CLI OTel Agent Trace is new authoritative source for tool reliability, current RUM events run in parallel for compatibility,
later dashboard migration completed before retiring duplicate fields/events.

`model` and `chat_error_banner.model_id` share same whitelist: only telemetry-whitelisted built-in stable model IDs,
custom provider's models (`custom:<providerId>:<modelName>` encoded values),
`<providerId>/<modelId>` composite values for non-builtin provider parts, and built-in provider models not matching whitelist
unified as `custom`; empty if missing. Implementation via `@zcode/shared`'s
`sanitizeTelemetryModelValue`, `uiPerfArmsTelemetry.emit` uniformly rewrites `model`
property before sending, callers don't need to handle individually. Whitelist source aligns with builtin provider dual naming spaces (runtime `account:*` and legacy report identity `builtin:*`) judgment rules see [plan-usage-arms-telemetry](./plan-usage-arms-telemetry.md).
Implementation: `packages/ui/src/lib/uiPerfArmsTelemetry.ts`; V4 entry driven by workspace telemetry supervisor.

### 4.4 ARMS SDK longTask Auto Events

| Field                              | Specification                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `event_type=longTask`              | Rendering main thread jank event auto-collected by Browser SDK.                                              |
| `duration` / `fps` / `source`      | SDK original fields, `source` as `LoAF` or `rAF`.                                                            |
| `properties.loaf_script_count`     | Attribution count in SDK `snapshots`, max 5.                                                                 |
| `properties.loaf_top_duration_ms`  | Top attribution duration ms, rounded and clamped non-negative.                                               |
| `properties.loaf_top_invoker_type` | `user-callback` / `event-listener` / `script` / `unknown`; rAF missing `invokerType` normalized to `script`. |
| `properties.loaf_top_share_pct`    | Top attribution % of longTask total `duration`, integer; 0 if total duration invalid.                        |

Privacy boundary: does not write original script names, URLs, paths, selectors, stacks or source snippets to `properties`; `snapshots` missing or parse failure doesn't add fields.

---

## V. ARMS Visible UI Errors `group=ui_error`

| Event               | `surface`                    | Trigger Spec                                                                      | Deduplication Spec                                                    |
| ------------------- | ---------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `chat_error_banner` | `chat_input_error_banner`    | Input area error banner visible after suppression                                 | One dedup per fingerprint of Composer mount's task/code/trace/message |
| `chat_error_banner` | `session_subscription_error` | Real visible error of formal Session's conversation subscription failure on front | One dedup per fingerprint of SessionPane mount's session/code/message |

Subscription failures reuse `chat_error_banner` to avoid dashboard having a second "user-visible chat error" spec;
`surface` distinguishes input area errors from full-page subscription errors. Events must preserve structured `error_code`,
`fault.subscribe.sessionNotFound` etc reasonCode not allowed only in message. Silent fallback errors in background panes,
pre-warmed drafts and errors suppressed by product logic are not exposed.

Attribution fields are optional incremental fields: `error_source` / `failure_reason` / `provider_scope` /
`provider_id` / `model_id` / `provider_kind` / `transport` / `status_code` /
`provider_error_code` / `failure_retryable` / `failure_phase` / `failure_exception_kind`. Where
`provider_scope` only `builtin | custom | unknown`; custom provider's `provider_id` always written `custom`. `model_id` only allows
telemetry whitelist built-in stable model IDs; custom or non-whitelisted models always `custom`, provider/model
missing written empty string. Prohibited from writing custom provider/model names, base URLs/full URLs, credentials,
request or response bodies, prompt/tool content, stacks, full detail or requestId. Missing fields don't block event send, also don't change
error display and recovery behavior.

`failure_phase` is fixed Model API phase enumeration, `failure_exception_kind` is adapter allowlist-derived low cardinality
exception family; raw exception name not uploaded. Dashboard should separate reason coverage and diagnostic coverage.

Implementation: `packages/ui/src/lib/chatErrorBannerTelemetry.ts`, `packages/ui/src/v4/ConversationComposer.tsx`,
`packages/ui/src/v4/SessionPane.tsx`.

### 5.1 React Error Boundary `group=react_error`

| Event              | value | properties                                                                            |
| ------------------ | ----- | ------------------------------------------------------------------------------------- |
| `perf_react_error` | `1`   | `error_name` / `error_message` / `error_stack` / `component_stack` / `boundary_scope` |

React error boundary intercepts subtree render errors and prevents bubbling to `window.onerror`.
Browser RUM SDK can't see these errors, so separately logged custom event.
`boundary_scope` is root-level `app` or each scoped boundary name.

Privacy boundary: `error_message`, `error_stack`, `component_stack` must be processed via `@zcode/shared`'s
`redactTelemetryText` before reporting, same rules as ARMS auto-collected exception events
(see [privacy boundary](./arms-browser-monitoring.md#auto-collected-event-redaction-boundary)): paths unified to
`{path}`, emails unified to `{email}`, URLs only keep `protocol//host` and normalized routes, credentials unified to
`{redacted}` / `{secret}`. `error_stack` and `component_stack` also have 4000 character limit, ensuring topmost error
component reaches the server. Redaction applies only to report copy, local logs and fallback recovery continue raw values.

Implementation: `packages/ui/src/lib/reactErrorArmsTelemetry.ts`, `packages/ui/src/ErrorBoundary.tsx`.

---

## VI. Message Link (`/report` agent_trace, NOT ARMS)

`messageTelemetry.ts` continues providing legacy format builder; V4 workspace telemetry supervisor only consumes live facts,
then calls `reportAppTelemetryEvent(eventType="agent_trace")`.

| elementName          | Value Nature      | Key Report Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message_completion` | End-to-end        | `duration_ms` (sendTime to turn terminal visible wall clock duration, includes foreground Subagent and waiting)/ `time_to_first_token` (if no first token=-1)/ `waiting_ms` (all tool permission wait cumulative)/ `input_tokens`·`output_tokens`·`reasoning_tokens`·`cached_input_tokens`·`cache_write_input_tokens`·`total_tokens` / `agent_step_cnt` (actual steps in completion)/ `tool_call_total`·`tool_call_failed` (actual tool steps in completion)/ `generated_code_lines` / `file_change_cnt` / `status` / `error_type` (failure attribution)·`error_msg` (non-empty raw as `[redacted]`, else empty)/ `request_time`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `agent_step`         | Per-step          | `step_type` (reasoning / tool_call / generation)/ `loop_index` / `duration_ms` (step wall clock duration, includes wait)/ `waiting_ms` (tool permission wait cumulative, non-tool is 0)/ `generation_tail_finalize_ms` (only desktop `desktop-continuous` where main agent generation captured by `task_complete` / `task_error`, indicates last chunk without `parentToolUseId` to terminal event tail delay; phone replayable re-play and inapplicable scenarios empty string)/ `status` (success / fail / timeout)/ `tool_name` / `tool_call_id` (only tool steps)/ `agent_id` (parent `Agent` and mirrored child tools equal association id)/ `is_tool_call` / `model_name`·`model_provider`·`provider_name` (step-associated real request model dimensions)/ `model_request_id`·`model_request_count`·`token_usage_scope` (main request is `model_request`, foreground child aggregated is `subagent_requests`)/ `input_tokens`·`output_tokens`·`reasoning_tokens`·`cached_tokens`·`cache_write_input_tokens`·`total_tokens` (full request usage only belongs to one step). Only via `/report`, not mirrored per ARMS RUM; CLI OTel Step Span see Agent Turn Trace spec |
| `context_compaction` | Compaction Result | `status` (completed / failed / interrupted)/ `trigger` / `reason` / `attempt` / `duration_ms` / `pre_compact_tokens`·`post_compact_tokens`·`true_post_compact_tokens` / `compact_ratio` (post/pre). Success rate aggregated by warehouse on status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

`message_completion` and `agent_step` must also carry same scene dimensions: `workspace_kind` (`local` /
`remote`) and `remote_kind` (`ssh` / `wsl` / `docker` / `server`; local or unparseable empty string).
Both frozen by workspace attachment, cannot upload `remoteSessionId`, workspace path, host address or other high-cardinality identities.

Input phase fields (`queuePromptTelemetry` injected into `message_completion`): `input_start_time` / `input_first_char_time` / `input_send_time`.
`agent_step_cnt`, `tool_call_total`, `tool_call_failed` share same active prompt lifecycle; history assistant messages in same session not included in this completion count.
Skill tool steps additionally carry `skill_qualified_name`, `skill_plugin_id`, `skill_source`; only when
`tool_name=Skill` and runtime successfully parses metadata, not contain Skill body or description.
Foreground handler and backend runtime monitor both must first send received step/terminal events into this lifecycle,
then report `message_completion`; switching task cannot reset or drop counts for same round's backend
`agent_step`. All events with `inputId` must match runtime's current `activeInputId`; old input's delayed
reasoning / generation / tool / terminal events can't be accepted or contaminate new prompt's step state/count.
Legacy protocol without `inputId` preserves compatibility path; when queued prompt sent, even with actual inputId rebinding,
actual inputId from runtime remains ownership source, can't reject current events using pending inputId from queue stage.
Format implementation: `packages/ui/src/lib/messageTelemetry.ts`; lifecycle and multi-platform boundaries see
[conversation-telemetry-v4.md](./conversation-telemetry-v4.md).

---

## VI. ARMS CLI Agent Model API (OTLP Trace)

`service.name=zcode-cli-agent`, does not go through Electron RUM `/rum/web/v2`, no new client database tables.

| span.name             | Granularity                                | Key Fields                                                                                                                                                                         |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zcode.model.call`    | One `generateText/streamText` Logical Call | `operation` / `actor` / `provider_id/kind/origin/route` / `model` / requested/effective thinking / status / duration / TTFT / token/cache / retry recovery / error / `uid/rid/sid` |
| `zcode.model.attempt` | One real Provider HTTP/SSE request         | Same public dimensions + attempt/max / transport / previous request / retry delay / provider request ID                                                                            |

Normal successful calls produce 1 Call + 1 Attempt; Adapter Retry only adds Attempt, Compaction SSE → HTTP fallback produces two linked via `previous_logical_call_id`. All events are Terminal Span, no prompt/header/provider options/tool content or individual SSE chunk reported.

Default 5 second / 100 batch gzip protobuf, queue limit 2,000 items or 4MiB; no-op when OTLP unconfigured.
App RUM, SQLite Usage and `/report` continue dual-write, await post-graymatch decide long-term replacement scope.

Implementation: `apps/zcode-cli/packages/telemetry`, `apps/zcode-cli/packages/adapters/src/model/runner-status.ts`.

## Coverage and Known Gaps

- ✅ **Stability / Resource / Network**: Process-level complete (CPU / memory / GPU / crash / ANR / freeze / exit code / network layered duration).
- ✅ **Launch Chain**: Process creation → "input focusable" 7 segments, distributable to percentiles.
- ✅ **Message Chain**: Input → first token → `/report` per-step → stall → end-to-end → context compaction;
  ARMS RUM maintains low-frequency events per round/tool terminal state, CLI OTel Agent Turn Trace independent evolution.
- ✅ **CLI Model API**: Main Agent/Subagent/Workflow, Compaction, Sidecar and tools internal model calls all form Call/Attempt; traffic, success rate, duration, Token/Cache, Retry/Fallback and redacted errors all observable in ARMS aggregation.
- ⚠️ **CLI Model Dashboard Not Deployed**: Code supports standard OTLP injection, but repository doesn't have ARMS OTLP credentials; Workspace dashboard, alerts and RUM/SQLite reconciliation await deployment-side graymatch completion.
- ⚠️ **End-frame Rendering Not Covered**: `message_completion.duration_ms` / `time_to_first_token` endpoint is `task_complete` reaching handler moment, **does not include React re-render → browser paint upload**; user-perceived "render complete" latency remains blind spot.
- ⚠️ **Resource Not Attributed to Message**: Resource sampling 5min aggregation cannot answer "CPU/memory peak when sending specific message".
