# Session first-open ARMS telemetry

## Goal

Record the key durations on the desktop Renderer from acquiring an existing session in a pane to the first
authoritative snapshot being rendered and ready for input, distinguishing the Renderer, Window Host, CLI runtime
and historical-session restore stages. The current implementation takes pane acquire as the Renderer's observable
start; the user's raw mouse event does not yet enter this unified chain.

Only two ARMS Custom Events are added:

- `perf_ui_session_open_start`: reported once when the logical open starts, as the denominator for samples that
  never get a result (crash, protocol disconnect, permanently stuck).
- `perf_ui_session_open_result`: reported once when it ends in success, failure or timeout, with `value` =
  `total_ms`.

No ARMS event is sent per stage. Stage durations are computed locally in each process with a monotonic clock, the
CLI/Host timing is carried by the `v4/conversation/subscribe` ACK, and the Renderer aggregates them in the result
event.

## Product boundary

- Only Desktop `desktop-continuous` installs the real ARMS reporter; Web/mobile `web-remote-replayable` sends no
  ARMS.
- Only the process of the user navigating to, restoring or split-opening an already existing session is measured.
  Creating a session by the first send of an empty draft, promoting a warmed-up draft session, and a successful
  pending `createSession` recovery all count as "new Task" and must not send
  `perf_ui_session_open_start/result`. A new Task counts toward this metric only when it is explicitly opened
  again after leaving the current pane.
- Only one user-logical open is measured; subscribe retry, same-sub recovery or repeated frames around the ACK are
  not new opens.
- `open_kind` distinguishes `cold`, `warm`, `keep_warm`: only a `cold` open that creates a new projection store and
  issues this subscribe carries the Host/CLI/Renderer first-frame stage timing; `warm` and `keep_warm` reusing an
  existing projection store still record this open's `total_ms` and paint timing but must not reuse the stage
  durations of a previous subscribe.
- Session content, workspace path/identity, prompt, tool input/output, MCP server names and Skill bodies never
  enter ARMS.
- `MCP` startup is parallel runtime work; MCP connection time is not added to the first-screen total. The wait of
  the first model request for MCP is covered by existing model-request observation.
- `content_settled` (history backfill, plan catalog, lazy-loaded resources done) is not this metric's endpoint; the
  endpoint is the current store being `live`, the target session's first snapshot painted and the Composer
  interactive. A residual snapshot during reconnecting cannot end the open on its own.

## Time boundaries

```text
R0 pane acquire
  -> R1 acquire / subscribe issued
  -> Host prepare
  -> CLI process bootstrap (new process only)
  -> CLI session restore / context / history / V4 projection
  -> initial frame ready / transport
  -> Renderer snapshot apply
  -> React commit
  -> paint + main-thread yield
R8 interactive_ready
```

`total_ms = R8 - R0`. Absolute times of different processes are not subtracted; Host/CLI each compute their own
duration and the Renderer computes the perceivable duration from pane acquire.

## ARMS events

### `perf_ui_session_open_start`

`group=ui_perf`, `value=1`. Properties:

| Field             | Value                                                                      |
| ----------------- | -------------------------------------------------------------------------- |
| `session_open_id` | Opaque correlation ID of this logical open                                 |
| `session_id`      | Current session ID, following the existing talk/session correlation policy |
| `open_trigger`    | Low-cardinality buckets such as sidebar/search/deeplink/reload             |
| `open_kind`       | `cold` / `warm` / `keep_warm`                                              |
| `client_mode`     | `desktop-continuous`                                                       |

### `perf_ui_session_open_result`

`group=ui_perf`, `value=total_ms`. Besides the start-event fields, properties allow:

| Field                                               | Meaning                                                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                            | `success` / `failed` / `timeout`                                                                                                        |
| `error_phase` / `error_code`                        | Failure stage and structured reason code                                                                                                |
| `total_ms`                                          | pane acquire → interactive_ready                                                                                                        |
| `renderer_prepare_ms`                               | click → subscribe issued                                                                                                                |
| `host_prepare_ms`                                   | Host receives the request → CLI subscribe request sent                                                                                  |
| `provider_registry_sync_ms`                         | Historical field name; currently the time the Host waits for this Environment's Provider Registry readiness, not cross-Environment sync |
| `task_meta_read_ms`                                 | Time for the Host to read session/task metadata                                                                                         |
| `cli_request_ms`                                    | Host issues the CLI subscribe request → receives the CLI ACK                                                                            |
| `cli_bootstrap_ms`                                  | New CLI process start → Protocol ready; empty for a reused process                                                                      |
| `cli_session_restore_ms`                            | CLI receives conversation subscribe → initial projection ready                                                                          |
| `initial_frame_encode_ms`                           | CLI builds the first-frame wire projection → physical wire encoding done                                                                |
| `initial_frame_transport_ms`                        | initial frame ready → Renderer received it completely                                                                                   |
| `renderer_snapshot_apply_ms`                        | frame received → ProjectionStore apply done                                                                                             |
| `react_render_ms`                                   | snapshot apply → React commit                                                                                                           |
| `paint_to_interactive_ms`                           | React commit → main-thread yield after paint                                                                                            |
| `cli_process_state`                                 | `spawned` / `reused`                                                                                                                    |
| `session_runtime_state`                             | `cold` / `warm`                                                                                                                         |
| `attempt_count`                                     | Number of subscribe/retry attempts                                                                                                      |
| `persisted_message_count`                           | Number of history messages, count only, no body                                                                                         |
| `snapshot_row_count`                                | Number of first-screen projection rows                                                                                                  |
| `snapshot_bytes`                                    | First-frame size                                                                                                                        |
| `plugin_count` / `skill_count` / `mcp_server_count` | Low-cardinality counts                                                                                                                  |

These stages overlap, so the stage properties need not add up to `total_ms`; dashboards use `total_ms` as the main
metric and the stage fields for attribution.

## CLI/Host internal timing

`openTiming` may appear only in the `v4/conversation/subscribe` ACK, never in sessions-index, workspace-config,
resync or the conversation snapshot:

- Host: `hostPrepareMs`, `providerRegistrySyncMs`, `taskMetaReadMs`, `cliRequestMs`; all map to snake_case fields
  of the final ARMS result.
- CLI: `cliBootstrapMs` (new process), `cliSessionRestoreMs`, `initialFrameEncodeMs`; all map to snake_case fields
  of the final ARMS result.
- Renderer: `rendererPrepareMs`, `initialFrameTransportMs`, `rendererSnapshotApplyMs` are computed with the
  Renderer's local monotonic clock, `reactRenderMs` is the time from snapshot apply to React commit, then mapped to
  the ARMS result.
- The CLI also returns `sessionRuntimeState` and `snapshotRowCount`; `cliProcessState` is filled in by the Host
  depending on whether the runtime was reused.
- Finer `plugin/skill/memory/history` stages are not sent as ARMS events one by one; if core stages look abnormal
  online, a second-layer diagnosis uses the existing CLI/Host debug/trace, so each session is not amplified into
  several events.

Skill discovery may read each `SKILL.md` to parse metadata but does not load Skill bodies into the model context
during session open. MCP connection can start in parallel after the runtime is built; the first model turn waits
for tool registration.

## De-duplication, failure and sampling

- `session_open_id` is generated in the Renderer and spans the logical open; retry/recovery reuse the same ID.
- start/result events are both ARMS side-channel fire-and-forget and block neither the UI nor the protocol.
- Desktop start/result are reported 100%; no per-stage events and no stream/delta-level reporting.
- A call exceeding the session-open watchdog reports `status=timeout`; when a process crash or window destruction
  leaves no result, the start/result gap estimates unfinished samples.
- Detailed `plugin/skill/memory/history/projection` sub-stages go only to the existing CLI/Host structured
  debug/trace and are not high-frequency ARMS events.
