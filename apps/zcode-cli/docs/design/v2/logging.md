# Logging and Trace

ZCode logs are not a collection of debug output; they are the agent runtime's observability
contract. Every session, turn, message, model request, tool call, permission, storage operation,
and external I/O must be attributed to one top-level `traceId`, with `spanId` / `parentSpanId`
restoring the call chain.

## Goals

- One stable `traceId` per top-level task, by default covering the task chain of the whole session.
- Every turn, model request, tool call, permission, and adapter I/O creates its own span.
- Session events are the recoverable source of truth, structured logs the diagnostic index, trace
  spans the timing and call chain.
- Logs never persist keys, tokens, full prompts, full tool input/output, or private content.
- Core and adapters receive an explicit `ExecutionContext` / `TraceContext`; no unrelated trace may
  be minted mid-flow.

## Three output layers

### Session event

Append-only session events record recoverable state: user messages, model results, tool lifecycle,
permission lifecycle, compact boundaries, and errors. Events must include `eventId`, `sessionId`,
`turnId`, `traceId`, `sequenceNumber`, `timestamp`, `type`, `payload`.

### Structured log

Logs are the troubleshooting and audit index, written as JSONL by default. Minimal fields per line:
`timestamp`, `level`, `event`, `message`, `module`, `traceId`, `spanId`, `parentSpanId`,
`sessionId`, `turnId`, `toolCallId`, `durationMs`, `status`, `error`.

Log payloads pass through the redactor first. Default sensitive keys include `apiKey`, `token`,
`authorization`, `cookie`, `password`, `secret`, `credential`.

Error logs must keep a diagnosable cause chain. For anything written through
`logger.error(message, error, context)`, the JSONL `error` field must contain at least the outer
error's `name`, `message`, and stable `code` / `type` (if present), plus the same summary recorded
recursively for `cause`. Structured `context` on the error object also enters the log, redacted.
`turn.failed` must never collapse to `UNKNOWN_ERROR`: the original failure must be locatable
directly from the log — provider missing API key, invalid model request, permission denial, or tool
failure — without querying session storage.

User interfaces must surface deep system state too: when an entrypoint shows error, waiting, retry,
permission, model, tool, or I/O state, prefer the stable status code, an actionable summary, and a
safe cause-chain summary over the outermost wrapper error. User-visible summaries must pass a
privacy/secret-leak assessment; full payloads stay in controlled logs or debug paths.

### Conversation command audit index

Renderer logs are not the production source of truth for conversation operations. Low-frequency,
user-initiated V4 conversation commands that change conversation history must write one `info`
structured log after the Agent server completes the command's side effect, so default production
JSONL locates the operation without depending on client logs. The log proves the server completed
the command, not that the user triggered it through a specific button or key.

- `conversation.command.edit_user_query.completed`: recorded only after conversation rewind is
  committed and the edited canonical intent is accepted. Fields at least: `traceId`, `sessionId`,
  `commandId`, `clientId`, `targetRowId`, `targetEntityId`, `workspaceMode`, `intentKind`,
  `attachmentCount`, `status=completed`.
- `conversation.command.fork_assistant.completed`: recorded only after a stable fork completes and a
  child session id exists. Fields at least: `traceId`, `parentSessionId`, `childSessionId`,
  `commandId`, `clientId`, `targetRowId`, `targetEntityId`, `targetBoundaryMessageId`,
  `revisionAtDecision`, `status=completed`.

These logs must not record `newText`, the original query, goal objective, attachment contents, or
other full user input. Rejected/failed results of the same commands stay expressed by command ACKs
and unified error logs; a failed request must never be mis-recorded as completed. Edit/fork are
low-frequency user lifecycle operations — far below message-stream events per production day — so
`info`, not `debug`.

### Model stream diagnostics

Both `generateText()` and `streamText()` must record locatable model SDK diagnostic logs.
`model.sdk.generate.completed` covers the non-streaming completion path. The streaming path records
`model.sdk.stream.completed` and, when stream iteration throws, `model.sdk.stream.failed` with the
same diagnostic fields as the completion log:

- `chunkCounts`
- `errorChunkCount`
- `lastChunkType`
- `finishReason`
- `rawFinishReason`
- `textDeltaChars`
- `reasoningDeltaChars`
- `toolCallCount`
- `usage`
- `error` (on failure)
- `errorAfterFinish` (`true` if the throw happened after `finish` / `message_stop`)

The goal is not to change control flow but to expose tail failures like "response already complete,
then `ECONNRESET` / `aborted` during connection teardown" separately, making it easy to tell a
provider stream drop, a proxy reset, or a client misreading an extra error after completion.

### Trace span

A span is one timed operation. Minimal fields: `traceId`, `spanId`, `parentSpanId`, `name`,
`startedAt`, `endedAt`, `status`, `attributes`, `error`. P0 requires only local in-memory and log
usage; OpenTelemetry exporters, metrics, and external collectors belong to a later telemetry phase.

## Startup duration logs

Startup timing is structured log only, never session event, keeping diagnostic noise out of
recoverable session facts. All startup logs use the existing logger/redactor and carry a linkable
`traceId`, `sessionId` (if any), `module`, `event`, `stage`, `durationMs`, `status`, and
`context.totalDurationMs`.

`durationMs` is the current stage; `context.totalDurationMs` is the cumulative time from the start
of that startup flow to this log. Timing uses a monotonic clock; logging failures must not affect
startup.

App-server process startup records at least:

- `app_server.startup.started`: entry begins.
- `app_server.startup.config.completed`: config loaded.
- `app_server.startup.session_store.completed`: session store opened.
- `app_server.startup.connection.completed`: ZCode app-server connection established.
- `app_server.startup.completed` / `app_server.startup.failed`: total startup duration.

ZCode app-server `session/new` records at least:

- `app_server.session.new.started`: new session request received, session trace created.
- `app_server.session.new.validate.completed`: request constraints validated (cwd, MCP servers,
  additional directories).
- `app_server.session.new.config.completed`: initial mode, model, thought level resolved.
- `app_server.session.new.app.completed`: ZCode app/runtime created.
- `app_server.session.new.record.completed`: ZCode app-server session record registered.
- `app_server.session.new.commands.completed`: available commands notification sent.
- `app_server.session.new.completed` / `app_server.session.new.failed`: total new-session duration.

`createZCodeApp()` also records `bootstrap.app.startup.*` stages covering config, runtime config,
storage, MCP adapter, runtime construction, and total time. When the app-server creates an app, it
must pass the same `traceContext` and `loggerFactory` into `createZCodeApp()` so
`app_server.session.new.*` and `bootstrap.app.startup.*` correlate under one `traceId/sessionId`.

## Layer constraints

- `contracts` defines only `Logger`, `LoggerFactory`, `TraceContext`, `ExecutionContext`, `Span`,
  schemas, and ports.
- `adapters` implement file logs, the console sink, redaction, directory resolution, and future
  exporters.
- `bootstrap` creates the logger factory and root trace context and injects them into the runtime.
- `core` logs only domain events and calls logger/tracer ports; it never reads environment
  variables, the filesystem, or the console directly.
- CLI/TUI/SDK display `traceId` and never assemble raw log formats themselves.

## Environment variables

All project-owned variables use the `ZCODE_` prefix:

- `ZCODE_LOG_DIR`: overrides the default log directory.
- `ZCODE_LOG_CONSOLE`: when `1`, also writes diagnostic logs to stderr.

Log level is not configured through environment variables. Callers may pass an explicit logger
`minLevel` or adjust the level through the logger factory's runtime interface; without an explicit
value, the development environment defaults to `debug` so the local debug app sees `context.built`
and `context_usage_snapshot`, and normal runs default to `info`. Development environment is
detected via `ZCODE_RUNTIME_ENV=development` or local source/tsx CLI entrypoints;
`ZCODE_RUNTIME_ENV=production` and `ZCODE_RUNTIME_ENV=test` explicitly use the normal defaults.
`NODE_ENV` does not participate in ZCode runtime detection, so user shell or package-manager
variables cannot affect agent behavior. `ZCODE_LOG_LEVEL` is not part of the supported environment
surface and must be ignored when set.

The default log directory comes from cross-platform directory resolution; initially
`{home}/.zcode/cli/log`. The default log file name is `zcode-YYYY-MM-DD.jsonl`, where the date is
the machine's local calendar day, not UTC — otherwise positive-offset timezones such as Beijing
write early-morning startup logs into the previous day's file, and startup-timing investigations
misread it as missing logs.

## Log retention and cleanup

By default only the structured log files of the last 7 local calendar days are kept. Cleanup only
touches files matching the default naming contract `zcode-YYYY-MM-DD.jsonl`; other files,
subdirectories, artifacts, session events, SQLite DBs, and debug artifacts must never be deleted by
the log cleanup task.

Cleanup is not a startup gate and must not add user-perceived startup latency. After
`createZCodeApp()` and ZCode app-server agent startup complete, the logging adapter schedules one
cleanup after a 60-second background delay — never during config loading, SQLite migration, runtime
construction, or before the ZCode Protocol connection. Short-lived commands may skip the round due
to process exit.

The cleanup boundary uses the local date in the file name, not mtime. For local date `2026-05-08`,
keep logs from `2026-05-02` through `2026-05-08` and delete `2026-05-01` and older matching logs. A
missing log directory, concurrent deletes, permission errors, or single-file delete failures must
not affect the agent main path; failures only write a structured warn including the directory, file
name, `retentionDays`, `cutoffDate`, and a safe error summary.

This capability adds no environment variables. If retention days or delay ever become configurable,
the config layer, precedence, error behavior, and test coverage must be defined in this spec first;
capabilities expressible through config files, CLI arguments, or session config should not become
`ZCODE_` environment variables.

## Default log payload boundary

`{home}/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl` is the default locating log. It answers "which
session/turn/trace/protocol seq/event type failed when", not full protocol messages, model stream
content, or tool input/output mirrors. Default logs may record indexes, statuses, counts, durations,
byte counts, key lists, and short summaries; they must not write full `protocolMessage`, full
stream deltas, full tool input/result, full stdout/stderr tails, or full request/response headers on
high-frequency paths.

High-frequency events are summarized:

- `event_store.appended` does not log per-event entries for message-stream-frequency events such as
  `model_streaming`, `tool_call_progress`, `streaming_tool_ledger_updated`, and
  `model_network_status`; they are aggregated per session/turn/event type into
  `event_store.appended.summary` recording `firstSessionEventSequenceNumber`,
  `lastSessionEventSequenceNumber`, `eventCount`, `payloadBytes`, `payloadKinds`, `firstEventId`,
  `lastEventId`, and the flush reason.
- ZCode Protocol `session/event` send logs keep `deliveryKind`, `protocolSeq`, `eventId`,
  `protocolEventType`, `payloadKind`, `sessionEventType`, and the source event sequence; by default
  only `protocolMessageBytes`, `protocolPayloadBytes`, `payloadKeys`, and `payloadSummary` are
  logged, never the full `protocolMessage`.
- Context usage writes a compact snapshot by default: total tokens/chars, categories, message
  breakdown, per-category contributor counts and top contributors. Full `mcpTools`, `systemTools`,
  `skills`, `systemPromptSections`, and full contributor detail belong to explicit diagnostic logs
  only, not the default daily log.
- `zcode_protocol.process.memory_sample` reuses the 60s sampling cadence of
  `process/resourceSample` to write process memory samples (`rssKb` / `heapUsedKb` / `heapTotalKb` /
  `externalKb` / `arrayBuffersKb` plus counters like resident sessions and event store rows), but
  only when heapUsed changed more than 5% since the last write, any counter changed, or 5 minutes
  elapsed; gating and field semantics are in root `docs/monitoring/memory-diagnostics-log.md`.
  Samples contain no session ids, paths, or content.

Error and warn logs may keep more context than the debug index but still respect the size cap and
redaction: prefer locating fields such as `errorMessage`, `code`, `statusCode`, `requestId`,
`toolCallId`, `payloadBytes`, `tailBytes`, `outputPath`; raw content only in bounded tails or
diagnostic artifacts.

## Runtime propagation

1. The CLI or SDK creates the root `TraceContext` when creating the app.
2. `AgentRuntime.executeTurn()` creates the turn span and passes the same `traceId` to the event
   store, model adapter, tool executor, and permission service.
3. Model/tool/permission create only child spans, never a new root trace.
4. Adapter I/O receives the current context; logs record the same `traceId` and current `spanId`.
5. Outbound network adapters propagate the current `traceId` into request headers; model requests
   send `x-request-id`, `x-zcode-trace-id`, `x-zcode-session-type`, `x-query-id` (when a query
   exists), and `x-session-id` (when a session exists). `x-zcode-session-type` may only be `main`,
   `subagent`, `side_chat`, or `other` and is for statistics and diagnostics only. Fine-grained
   diagnostics such as `turnId`, `spanId`, and `parentSpanId` stay in status events, session
   events, trace spans, and structured logs, never in provider-visible HTTP headers.
6. Error wrapping preserves `cause` and uses structured error fields in logs and session events.

`cause` recording has a depth limit and handles cycles; logging failures must not affect the main
path. Logs may keep error messages and stable diagnostic fields but never key values, full prompts,
full provider response bodies, or unredacted headers.

## Acceptance

- Session events from one prompt share one `traceId`.
- The `traceId` a tool handler receives matches its turn.
- Outbound model HTTP request headers carry the same `x-request-id` and `x-zcode-trace-id` as the
  model status event, plus an `x-zcode-session-type` resolved from the call origin.
- CLI `--json` output includes `traceId`.
- Log files are JSONL with sensitive fields redacted.
- `turn.failed` logs contain the outer runtime error and the original `cause`'s `name`, `message`,
  `code` / `type`, and redacted `context`; common failure causes are locatable without SQLite.
- When the TUI captures a turn failure it shows a safe cause-chain summary so the user sees the deep
  failure state directly, e.g. `provider_not_configured`.
- Logger file-write failures do not affect the agent main path.
- ZCode app-server `session/new` logs cover validate/config/create app/register/notify
  commands/total stages, each with a non-negative `durationMs` and the same `traceId/sessionId`.
- Log file names use the local calendar day: `2026-05-05 02:46 +0800` must write
  `zcode-2026-05-05.jsonl`, not roll into the previous day's file just because UTC is still
  `2026-05-04`.
- After startup completes, retention cleanup is scheduled with the default 60-second delay, keeping
  at most the last 7 local calendar days of `zcode-YYYY-MM-DD.jsonl`, and cleanup failures do not
  affect the CLI/TUI/ZCode app-server main path.
