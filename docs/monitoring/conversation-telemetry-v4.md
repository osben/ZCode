# V4 Conversation Telemetry Compatibility Spec

This document freezes V4 conversation main chain telemetry compatibility criteria. Implementation uses `z-code-2` production behavior as the compatibility baseline,
restoring only previously existing data without migrating field types, metric formulas, or collection scope.

## Objectives & Non-Objectives

Restore the following production events:

- `/event/report`: `send_btn`, `message_completion`, `agent_step`, `context_compaction`,
  `assistant_message_feedback`.
- ARMS: `perf_ui_first_token`, `perf_ui_message_complete`, `perf_ui_turn_breakdown`,
  `perf_ui_stream_stall`, `perf_ui_tool_call_detail`, `plan_request`, `plan_ttft`,
  `chat_error_banner`.
- `session_quota_alert` quota banner and existing Upgrade panel handoff depending on real conversation entry.

Non-objectives:

- Web/mobile actual network reporting.
- Back-reporting from the initial snapshot, cold hydration, gap recovery or historical transcripts.
- Correcting legacy fixed zeros, empty strings, negative-value clamping and stop-without-terminal definitions.
- Writing telemetry state into conversation rows, snapshots, the relay or the main process.

## Architecture & State Boundaries

```text
CLI V4 live SessionEvent
        |
        | normalize metadata-only fact
        v
Host workspace telemetry service
        | validate + forward; no persistence/replay
        v
Renderer workspace telemetry supervisor
        | seed + foreground refs + bounded dedupe
        +----------------------+----------------------+
        |                      |                      |
        v                      v                      v
 /event/report            ARMS ui_perf       quota/feedback

persisted hydration / initial / recovery
        |
        +----> conversation projection only
               MUST NOT emit telemetry facts
```

Must not revive the old `zcodeTaskRuntimeMonitor`, nor place the supervisor in `SessionPane`,
`SessionDataLayer`, or on a connection under 30-second keep-warm control. The supervisor belongs to the
window's workspace/service attachment, with isolation key:

```text
endpoint + remoteSessionId + (workspaceIdentity?.trim() || workspacePath) + serviceGeneration
```

There is only one supervisor per workspace/service generation. Task switching, pane unloading, and keep-warm
expiration do not destroy it; workspace detach, window closure, or service generation change destroys it.

Foreground is a reference set to visible sessions, not a single pane owner. The same session visible in multiple splits still consumes
the fact only once; multiple different sessions can be foreground simultaneously.

## Live Fact Protocol

`ConversationTelemetryFact` is a strict discriminated union, with common fields:

```ts
interface ConversationTelemetryFactBase {
  version: 1;
  eventId: string;
  eventSeq: number;
  occurredAt: number;
  sessionId: string;
  sourceCommandId?: string;
  turnId?: string;
}
```

Fact types cover:

- `turn.started`
- `model.request.status`
- `stream.chunk`: only `thought | text`, length, is-first-chunk and optional `parentToolCallId`, no content
  body. Parented subagent text does not enter the main generation step, but the old handler still records its
  first token and stall outside the step builder; parented thought keeps the old reasoning/TTFT/stall behavior
- `tool.lifecycle`: only tool name, status, ID, parent/child/Agent association and flat allowlist perf, no
  input/output. Runtime `ToolExecutionTelemetry` nested `detail` must be mapped field-by-field by CLI fact normalizer
  by command/filesystem/patch branch, never passed through or spread directly; `command.hash` stays only in the
  CLI local diagnostic object and does not enter the V4 fact. The `commandHash` retained in the shared schema does
  not mean the official producer populates it
- `permission.lifecycle`
- `usage.delta`, only produced by `querySource=main_turn` (or compatible historical default and non-`tool_internal`) of `ModelComplete`; `session_title`、compact、subagent and other
  sidecar usage must not accumulate to user prompt
- `turn.terminal`
- `compaction.terminal`

`model.request.status` only keeps the provider/model/status, request duration, error classification and provider
hostname needed by the old `plan_request` and message telemetry. The hostname must come from URL parsing; path,
query, headers, header count, token, prompt, upstream raw message and finish reason are never kept.

`message_completion` and `agent_step` `event_extra_detail` must also carry current workspace scenario dimensions:

- `workspace_kind`: `local` / `remote`, the actual workspace type for this turn;
- `remote_kind`: `ssh` / `wsl` / `docker` / `server`, empty string when local or the remote type cannot be parsed.

These two fields are low-cardinality dimensions, values frozen by renderer workspace attachment at supervisor creation time, and written simultaneously to the same message's completion and step. Remote type can only be parsed via unified `parseRemoteWorkspaceIdentity`; must not write `remoteSessionId`, `workspaceIdentity`, `workspacePath`, host address or other high-cardinality identity directly to telemetry.

Host determines subscription permissions based on attachment-injected trusted `clientMode`, must not trust renderer self-reporting.
Only `desktop-continuous` renderer installs real reporter; `web-remote-replayable`、Bot and automation clients
even if they can see authoritative conversation status, must not use telemetry service to generate network reporting. SSH/WSL/Docker/Server
remote chains may have multi-layer connection scope (Desktop Host attachment → trusted host relay); relay itself still
must not install reporter, but must pass the existing trusted downstream connections `clientMode` and namespace connectionId to upstream.
Only telemetry facts with trusted downstream `desktop-continuous` context can pass through relay, direct relay
subscription or `web-remote-replayable` downstream must return empty events.
Telemetry attachment is a bypass capability; Platform or agent service must be no-op until ready, cannot block
workspace/remote renderer, establish supervisor and live subscription only when dependencies are ready.

Facts are produced only from current process live ingest:

- persisted hydration, subscribe initial, snapshot and recovery: no production.
- Events arriving during hydration and sitting in live buffer: produced once.
- After CLI/runtime restart, must not synthesize completion based on orphan or historical terminal state.

## ID, Clock & Deduplication

- `talk_id = sessionId`.
- send/completion/step `message_id = sourceCommandId`.
- feedback `message_id = assistant entityId`; when entityId is missing, rowId must not be used instead.
- compaction `message_id = summaryMessageId ?? operationId`.
- The renderer computes legacy durations at `Date.now()` when receiving a live fact; `occurredAt` is diagnostic only.
- eventId uses a bounded LRU of about 2000 items.
- terminal exactly-once by `(sessionId, sourceCommandId, eventName)`.
- compaction exactly-once by `(sessionId, operationId, "context_compaction")`; same operation
  even if anomalous duplicates arrive with a conflicting terminal status, only the first live terminal is adopted.
- The local prompt seed is kept only in memory; a renderer reload does not backfill.

## Event Trigger Matrix

| Event                | Foreground                                        | Background After Cutting Away            | Initial/Recovery                                   |
| -------------------- | ------------------------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| `send_btn`           | Once when local desktop command is accepted by UI | queued promotion no duplicate report     | No report                                          |
| `message_completion` | Report                                            | Report for turn with existing local seed | No report                                          |
| `agent_step`         | Report                                            | Report for turn with existing local seed | No report                                          |
| `plan_request`       | Report                                            | Report                                   | No report                                          |
| `context_compaction` | Report only when terminal visible                 | No report                                | No report                                          |
| Six UI ARMS events   | Report                                            | No report                                | No report                                          |
| `chat_error_banner`  | Report only when banner actually visible          | No report                                | Can report after recovery when first truly visible |

`send_btn` send time comes from UI raw action. Existing session direct/queued commands report after local acceptance;
draft first send waits for create ACK to get sessionId, but retains original input/send time. Retries with same commandId,
queued promotion or command inbox duplicate do not duplicate report.

Send seed model fields continue to reuse old UI compatibility values: runtime provider (currently default `glm`) writes only `agent`;
when `config.provider !== glm`, `model_name` uses `custom:<provider>:<model>` encoding, `model_provider`
still writes the split real config provider. When real model request arrives, completion/step then rewrite to
`<provider>/<model>` per old logic. Must not change old data warehouse string criteria just because V4 config split provider/model fields.
Draft first send must derive seed from the draft lifecycle frozen initialization config merged with explicit intent
even if prewarm snapshot has not arrived; must not fall back to empty model/`glm`, nor block real send waiting for telemetry.

`message_completion` and `agent_step` only produced by prompts with seed established by desktop UI. `turn.started` binds seed with
session/turn/sourceCommandId; all subsequent facts carrying sourceCommandId must match current lifecycle. stop
without terminal preserves old behavior, no synthesized completion.

Same `talk_id + message_id` `message_completion` and all `agent_step` must use same
`workspace_kind` / `remote_kind`. Both local Desktop and Desktop remote workspace belong to
`desktop-continuous`, therefore `clientMode` only used for trusted subscription gate, not as workspace scenario dimension.

When tool terminal fact arrives, must immediately close corresponding tool step at that moment, and first report
`/event/report agent_step`; same turn `message_completion` only closes at subsequent turn terminal. If normal tool
terminal is dropped due to fact schema failure, turn terminal will still fallback-close open steps but will
extend `duration_ms` to entire turn end, and may override real tool status, error and failure counts with turn state. This fallback
is preserved only for real missing/anomaly paths, must not be used as normal desktop continuous path success path or test basis.

`TurnComplete(cancelled)` preserves old two-phase close: agent step still closes with `task_complete` success, then
`message_completion.status="user_interrupt"` with old fixed error
`USER_INTERRUPT / User stopped generation`. Only real `TurnError` uses `task_error` to close step.

`plan_request` directly consumes real model network state, covering old five states; allows foreground/background and does not require local prompt seed.
Must not infer from `apiRetry`、accepted、queued or other projected states. eventKey uses 2000-item FIFO/LRU deduplication.

Six UI performance events and `plan_ttft` only update/close during session foreground. stream stall must strictly
be `> 3000ms`; tool start/update and terminal clear tracker; tool detail reports only when allowlist perf is non-empty.
Old stats accept first thought、text (including parented child chunk) or tool as first token. Old prompt
with no thought/text/tool before terminal, completion `time_to_first_token="-1"` still mirrors once
`perf_ui_first_token(value=0)`; `plan_ttft < 0` or empty provider does not send. First token arriving only in background
cannot be back-calculated as UI TTFT after switching to foreground.

Old production completion calls never passed `fileChanges`, therefore `file_change_cnt`,
`generated_code_lines` and corresponding ARMS breakdown attributes are fixed as `"0"`/`0`. V4 even with runtime
file summaries, must not use migration to correct these two metrics.

Compaction uses the old runtime model values: non-`glm` provider `model_name` is
`<provider>/<model>`, `model_provider` retains provider id; differs from `send_btn`'s
`custom:<provider>:<model>` UI encoding. `reason` only reads old timeline actually consumed `reason`; must not use
V4 `compactReason` to backfill empty string.

`chat_error_banner` reports after error truly rendered visible, once per same key per component mount; reducer/UI
suppressed errors do not report. Normal provider business error preserves old visible recovery action and business code dimension; official version security validation
internal recovery action does not enter banner telemetry.

When error projected from CLI to UI, may carry `attribution` structured facts: `source`、`reason`、`providerId`,
`modelId`、`providerKind`、`transport`、`statusCode`、`providerErrorCode`、`retryable`,
`errorPhase`、`exceptionKind`. These fields
are all optional, used only for fault attribution and monitoring aggregation; must not change existing banner visibility, copy, buttons, retry, security validation or
feedback behavior. Old events and old persisted records missing attribution continue with original fallback.

`chat_error_banner` expands above facts into whitelist as
`error_source`、`failure_reason`、`provider_scope`、`provider_id`、`model_id`、`provider_kind`,
`transport`、`status_code`、`provider_error_code`、`failure_retryable`、`failure_phase`,
`failure_exception_kind` while preserving existing fields. Built-in providers may retain stable IDs;
Custom providers uniformly normalized to `provider_scope=custom`、`provider_id=custom` to avoid high cardinality or privacy leakage from user custom names. `model_id` only allows retaining built-in stable model IDs in telemetry explicit whitelist; custom provider
models and built-in provider models not hitting whitelist uniformly written as `custom`, empty string when provider or model missing.
Whitelist matching and output both use normalized lowercase IDs, new built-in models not entering whitelist must default to `custom`, must not pass through as-is. Prohibited from uploading base URL/full URL、header、token、request or response body、prompt/tool content、stack、full
detail、requestId. ZCode only reports factual attribution, does not report `owner` or `shouldAlert` monitoring strategy conclusions.

`exceptionKind` must be standardized by allowlist at adapter boundary, prohibited from passing custom Error name as-is into protocol or ARMS.
`failure_reason=unknown` does not equal missing diagnostic fields; Dashboard separately stats reason coverage and
`source + errorPhase + exceptionKind` diagnostic coverage.

Attribution enters snapshot with authoritative conversation error state, therefore live continuous and persisted cold
hydration should get same attribution for same error; it does not trigger telemetry backfill. Desktop still only reports via
`desktop-continuous` reporter when banner actually visible, mobile `web-remote-replayable` does not add new network reporting capability.

`source` must be determined by error occurrence boundary, cannot guess from failure reason alone. Priority: user cancellation and
local provider config before request sent, request option validation, an unknown adapter exception is classified `runtime`; explicit TLS, proxy,
connection and timeout transport failures `network`; the rest `provider` only when provider response, provider business error
or provider content validation failure upstream evidence exists. The same `invalid_request` reason
is therefore `runtime` or `provider` depending on whether a provider response exists; an explicit network reason
stays `network` even when carried by a provider response.

When adapter error with structured attribution passes runner terminal boundary again, `source`、`reason`,
`retryable`, `statusCode` and provider business error fields are responsibility of boundary that first obtains valid evidence; subsequent boundaries
can only fill missing values, must not override with coarser reclassification. `attempt`、`requestId`、`traceId`、`providerId`,
`modelId`、`providerKind` and `transport` etc. this-request facts still based on current runner boundary. To preserve original stack,
cause and caller's existing error object references, completing an existing adapter error context must not replace the error object; compact etc.
call sites can continue appending phase fields they explicitly own.

## Business trigger chains

### Assistant feedback

V4 provides the `setAssistantFeedback` CAS command:

```ts
{
  target: {
    kind: "assistantEntity";
    entityId: string;
  }
  feedback: "like" | "dislike" | null;
}
```

The CLI updates the assistant row and persists it. The UI updates optimistically and rolls back if the command
fails; the click still immediately reports the legacy format:

```ts
{
  eventType: "ck";
  eventRegion: "chat";
  elementName: "assistant_message_feedback";
  eventExtraDetail: {
    reaction: "like" | "dislike" | "none";
  }
}
```

Clicking the same reaction again writes `null` and reports `none`.

### Session quota entry

The V4 quota banner must restore visibility, dismiss, submit blocking, entitlement refresh and the Upgrade panel.
`coding_plan_upgrade_ck` is reported by the original purchase module only after the existing purchase panel is
confirmed open; the conversation entry passes:

- `eventRegion = app.session`
- `upgrade_source = session_quota_alert`

The purchase module's internal product/cycle/pay/result events and payment results are outside this conversation
refactor; only verify that the Upgrade panel really opens and the funnel context is not lost at the conversation
entry.

## Verification contract

- Golden tests must compare the complete payload, including stringified numbers, empty strings and fixed zeros.
- A fake clock covers first token, 3000/3001 stall, permission waiting and terminal exactly-once.
- Schema/privacy tests prove that body text, tool content and URL path/query never enter a fact.
- Gateway/service tests prove a live buffered event is produced once and initial/hydration/recovery zero times.
- Desktop E2E verifies the production entry with an `/event/report` fetch mock and a bounded ARMS ring buffer
  dedicated to test builds; the ring buffer must not be exposed or persisted in production builds.

Formal conversation case IDs and pruning conclusions are in the `TEL` group of the case catalog and the E2E
coverage matrix. Old/new runtime differential, atomic regression cases and automation layering are in
[`conversation-telemetry-differential-regression-plan.md`](../testing/conversation-telemetry-differential-regression-plan.md).

## Memory switch dimension

`eventExtraDetail` of `send_btn`, `message_completion` and `agent_step` includes `memory_enabled`: `"1"` on,
`"0"` off, `""` when an old CLI/old fact provides no state. It only records the App Memory setting adopted when the
session runtime instance was created; it does not say whether CLI memory finally took effect, whether a read hit
or a write succeeded. No read/write metrics are added and the Memory switch behavior is unchanged.

The only data source is the CLI `ZCodeProtocolSessionRecord.memoryEnabled`; the App's current setting is not
re-read at send or completion. A mid-session setting change does not alter existing runtime instances; new or
cold-resumed instances use their creation-time value.

```text
session record memoryEnabled
  ├─ accepted command ACK → prompt seed → send_btn / completion / agent_step
  └─ live turn.started → background-task seed → completion / agent_step
                           └─ child step inherits the source prompt's value
```

The ACK and live telemetry fact gain an optional boolean `memoryEnabled`; absence stays unknown and does not
default to off. For new/selection side-chat ACKs the result session's record is read; for ordinary sends the
target session's record. Ordinary facts that arrive before the ACK use the existing pending-fact buffer; child
start facts reuse the parent session field directly without waiting for the ACK; de-duplication, FIFO and
workspace identity are unchanged. Background tasks do not forge `send_btn`; a subagent inherits the source
prompt's switch and its own use of memory tools is not treated as the switch. Transport adds only body-free
metadata, and CLI snapshots/history recovery do not fabricate telemetry facts. Desktop keeps the
`desktop-continuous` live reporter; mobile `web-remote-replayable` installs no reporter and telemetry scope is not
widened; command ACKs are compatible with the new field on both ends.

Acceptance: on/off each verify the same value on all three events; existing instances do not drift after a setting
change; background turns and detached children inherit; facts before the ACK and duplicate ACKs keep the existing
de-duplication; an old CLI missing the field leaves it empty; a non-boolean protocol value is rejected. The
existing Memory E2E adds three-event assertions for default off and for a new session with it on.

### Verification boundary of this change

- Root and CLI typecheck, root lint and architecture changed checks pass.
- UI/protocol unit tests: 112 passed; gateway/workflow fact regression: 108 passed, 1 failed. The failure is the
  pre-existing `Core admission ACK does not wait for TurnStarted projection; old revision retry/file rewind only
  stale` (the same failure reproduces with the unmodified staging gateway).
- CLI lint is blocked by pre-existing `max-lines` errors in unmodified files.
- The Memory WDIO `before all` could not select Full access/yolo mode and never reached the new telemetry
  assertions, so that run is not end-to-end evidence for on/off telemetry on desktop. Mobile remote control had no
  new real-device verification; the reporter's desktop-continuous boundary is unchanged.
