# Permission Waiting Telemetry Design

`message_completion.waiting_ms` permission-wait timing, plus the same-caliber `waiting_ms` on existing `agent_step` events. Permission waits are attributed to the `tool_call` that triggered them; there is no new `permission_wait` step, and `agent_step_cnt` / `loop_index` semantics are unchanged.

Metrics:

- `message_completion`: `duration_ms = max(finishedAt - sendTime, 0)` is the whole-turn wall time including model, tools, and user authorization waits; `waiting_ms` is the accumulated sum of the turn's permission wait intervals (`Σ permissionWaitDuration`, accumulated per `tool_call` requiring authorization).
- `agent_step`: the existing `reasoning` / `tool_call` / `generation` steps remain; every step reports `waiting_ms`, fixed `"0"` for non-`tool_call`. `tool_call.duration_ms` stays the wall time from tool start to close (including permission waits); `tool_call.waiting_ms` accumulates only that call's waits:

```text
tool_call.waiting_ms = Σ max(permissionWaitEndAt - permissionRequestedAt, 0)
```

- `waiting_ms` is never subtracted from `duration_ms`; consumers compute `execution_ms = max(duration_ms - waiting_ms, 0)` themselves.

State model — `messageTelemetry` remains the single owner of UI telemetry lifecycle:

- The active prompt keeps permission wait intervals indexed by `requestId`, each with at least `requestedAt` and the owning `toolCallId`.
- The active `tool_call` step keeps its own accumulated `waitingMs`.
- Intervals closed before their tool step appears are staged by `toolCallId` (`waitingMs` + `earliestRequestedAt`) for later backfill by tool events.
- The prompt keeps the turn-wide accumulated `waitingMs` for `message_completion`.

`toolCallId` is read from the raw permission payload first, falling back to the protocol's current `requestId` matching. Waits that match no active tool still count toward `message_completion` but never land on another tool's step.

Event handling:

- `permission_request`: register only while the current prompt is active; idempotent by `requestId` (duplicate stream/replay never resets `requestedAt`); record the `toolCallId` for step attribution.
- Permission responses close from two entry points, both idempotent by `requestId`: this client's successful submission, and a streamed `permission_response` (including one completed by another client). On close, the interval is accumulated into the prompt, and into the `tool_call` step if present; otherwise into the pending attribution keyed by `toolCallId`. The open interval is then deleted — request-level idempotency plus out-of-order safety for tool attribution.
- Tool/task termination: when the owning `tool_call` closes, its still-open intervals close at tool termination time. A terminal `tool_call_update` without a preceding `tool_call` produces a fallback step that absorbs that tool's closed and open wait attribution, with `startedAt` no later than the earliest permission request and `duration_ms >= waiting_ms` guaranteed. On `task_complete`, `task_error`, or user stop, all still-open intervals close at message termination time — so stopping without authorizing still counts `permission_request → finishedAt` into both `tool_call.waiting_ms` and `message_completion.waiting_ms`.

Multi-client and duplicate events:

- Desktop `desktop-continuous` and mobile `web-remote-replayable` share one telemetry aggregation caliber without changing their message recovery protocols.
- Replay/re-observed requests or responses never reset the start or double-accumulate; a mobile-authorized request closes correctly when the desktop observer receives the `permission_response`.
- Relay, main, host, and ZCode protocol responsibilities are unchanged.

Tests:

| Case | Scenario | Assertion |
| --- | --- | --- |
| PW01 | One tool, one authorization | tool and completion `waiting_ms` equal; both `duration_ms` include the wait |
| PW02 | Multiple tools waiting in one turn | completion equals the sum of tool `waiting_ms` |
| PW03 | Multiple authorizations for one tool | all intervals accumulate in tool and completion |
| PW04 | User stops / task ends without response | open intervals count to termination time |
| PW05 | Duplicate request/response delivery | start not reset, no double counting |
| PW06 | Another client responds | stream response closes the wait |
| PW07 | Permission matches no active tool | completion counts it; other tool steps unpolluted |
| PW08 | reasoning/generation steps | `waiting_ms="0"` |
| PW09 | request → response → terminal tool update, no prior tool call | fallback step backfills closed waits, `duration_ms >= waiting_ms` |
| PW10 | request → terminal tool update, no prior tool call | open wait closes at terminal and lands in the fallback step, `duration_ms >= waiting_ms` |

Regression invariants: `message_completion.duration_ms` is always `max(finishedAt - sendTime, 0)` and `agent_step.duration_ms` always `max(stepFinishedAt - stepStartedAt, 0)`; adding `waiting_ms` changes neither formula.

Non-goals: no new `permission_wait` step; `agent_step_cnt`, `loop_index`, and step types unchanged; elicitation / AskUserQuestion waits excluded; server-side telemetry storage and external dashboards unchanged.
