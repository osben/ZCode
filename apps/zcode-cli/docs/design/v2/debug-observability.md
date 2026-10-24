# Debug Observability App

`debug` is a development-only sidecar observation app built with React, Vite, and Hono. It never
enters the agent runtime, does not change prompts, sessions, tools, model adapters, or cache policy;
it only reads logs, SQLite session data, and session event JSONL that the agent already persisted or
explicitly exported.

## Goals

- Link every session, turn, model request, tool call, permission, subagent, and error event of one
  top-level task by `traceId`.
- Express concurrent execution within one trace as a Gantt chart, so tool calls, model requests, and
  network requests are not misread as strictly serial.
- Visualize the composition of provider-visible context: at least character counts, estimated
  tokens, and share for system prompt, skills, tools, and other sections.
- Show overall prompt cache behavior: cache read/write tokens, estimated hit rate, and hit/miss
  state of observable text segments.
- Show network requests live through a local debug HTTP(S) proxy, attributing them by `traceId`,
  `sessionId`, `turnId`, and `spanId` where possible.
- When sidecar data is insufficient, mark the observation gap explicitly and name the runtime events
  or artifacts agent developers should add.

## Non-goals

- Not enabled for production users; no high-concurrency, low-latency, or long-term storage goals.
- Does not modify the agent execution path and does not monkey patch or hook provider SDKs for
  implicit data; the network proxy only observes traffic when a developer explicitly points the
  tested process's proxy environment variables at the debug app.
- Does not persist full prompts in new locations by default; if the source data has no full content,
  the debug UI can only show metadata and the gap.

## Data sources

### Structured log JSONL

Reads `{home}/.zcode/cli/log/*.jsonl` by default; a custom `logDir` can be passed via UI/API. Logs
are indexed by:

- `traceId`, `sessionId`, `turnId`, `spanId`, `parentSpanId`, `toolCallId`
- `event`, `module`, `message`, `status`, `durationMs`
- Safe metadata in `context`, e.g. section names, character counts, and token counts recorded by
  `Context built`

When the logger detects the dev-default debug level, the runtime writes a debug-level log with
`event: "context.built"` containing context sections' `name`, `source`, `chars`, `tokens`,
`preview`, and `content`. This is the dev-time observability path; non-debug default log levels do
not write full section content. Log level is not configured through `ZCODE_LOG_LEVEL`; when these
snapshots are needed, rerun the tested CLI in the dev run mode.

Before each model request the runtime also writes `event: "context_usage_snapshot"` at debug level.
It is not a stable public API but a dev-time JSONL observation event used by the debug app to show
context usage. The snapshot contains at least:

- `categories[]`: usage grouped by system prompt, meta user context, skills, tool prompt, tool
  schemas, messages.
- `categoryBreakdown[]`: default logs record only the contributor count and top contributors per
  group; a section contributor records `name`, `source`, `injectionTarget`, `cacheHint`; a tool
  contributor records tool name/server/readOnly/sideEffectScope; a skill contributor records skill
  name/source/scope/path; a message role contributor records role/count. The field answers "who
  contributed the bulk of each turn's context" and must not contain full prompt/message/tool schema
  text, nor list all contributors without limit.
- `mcpToolCount`, `systemToolCount`, `skillCount`, `systemPromptSectionCount`: counts in default
  logs, to detect tool/skill/section count anomalies.
- `messageBreakdown`: message usage split by role.
- `tokenMethod`, `confidence`, `tokenizer`: the provenance of each token count. The current version
  uses local estimation `zcode.estimateTokens.v1`, so `tokenMethod` is `estimated`; once provider
  token counts are integrated it may be `provider_count`.

Full `mcpTools[]`, `systemTools[]`, `skills[]`, `systemPromptSections[]` and full contributor
detail belong to explicit diagnostic mode or a dedicated debug artifact; the default daily log keeps
only the compact snapshot. This still lets default logs answer "which category grew" and "who the
top contributor is" without re-persisting every tool/skill/section detail before each model request.

Logs pass through the redactor by default, so the debug UI must not assume it can get full tool
input/output or provider responses.

### SQLite session DB

Opened read-only at `{home}/.zcode/cli/db/db.sqlite` by default; a custom `dbPath` can be passed via
UI/API. SQLite shows persisted state: session, message, part, todo.

Message/part rows in the current DB are not guaranteed to carry `traceId`. The debug app may merge
them into the same view when `sessionId` is known, but must label them `session-only` and must not
pass them off as complete trace evidence.

### Session event JSONL

The debug app reads user-supplied session event JSONL files or directories. This is the sidecar
format best suited to visualizing traces; the minimal event fields follow `docs/design/v2/logging.md`:

- `id` or `eventId`
- `sessionId`
- `turnId`
- `traceId`
- `sequenceNumber`
- `timestamp` / `occurredAt` / `recordedAt`
- `type`
- `payload`

If `model_request.payload.messages` contains the system message, the debug app can show the full
context text and infer section shares. With only `Context built` metadata, it can show section names
and counts only.

With only SQLite `step-finish.tokens.input`, the debug app can show a low-confidence fallback row
`模型输入（SQLite 聚合）` (SQLite-aggregated model input) so the developer sees that the turn really
had provider input tokens; the fallback must not masquerade as system prompt, skills, tools, or
message chunks.

### Network capture proxy

The debug server starts a local HTTP(S) MITM proxy by default; see
`docs/design/v2/network-capture-debug.md`. This source is a dev-time in-memory live view: it is not
written to the session DB and does not replace runtime events. Requests are linked to traces via
the `x-zcode-trace-id` header or a trace query parameter; requests without attribution fields must
show as unattributed.

## Hono API

All APIs are read-only.

### `GET /api/traces`

Query:

- `logDir?: string`
- `dbPath?: string`
- `eventPath?: string`

Returns:

- Source status, paths, record counts, and warnings
- Recent traces: first user message summary, `traceId`, linked sessions, event count, log count,
  first/last timestamps, cache token totals

### `GET /api/traces/:traceId`

Query:

- `sessionId?: string`
- `logDir?: string`
- `dbPath?: string`
- `eventPath?: string`

Returns:

- Merged timeline: logs, session events, SQLite messages/parts
- Execution spans: sustained turn, model, tool, permission, subagent, and log segments; contract in
  `docs/design/v2/debug-execution-gantt.md`
- Context snapshots, built from model requests or context built logs
- Cache reports, aggregated from model complete, turn complete, and assistant step-finish
- Developer requests: questions the current sources cannot answer and suggested new runtime events

### `GET /api/observations/events`

Query identical to `GET /api/traces`:

- `logDir?: string`
- `dbPath?: string`
- `eventPath?: string`

Returns a `text/event-stream` for live UI updates of the trace list, trace detail, and Gantt chart.
The stream sends lightweight change notifications only, never full timeline/context/cache payloads;
after receiving `change`, the frontend must re-fetch the current filter via the existing read-only
APIs.

Events:

- `hello`: on connect, returns the observed source fingerprint and the server check interval.
- `change`: sent when any observed source fingerprint changes; carries `revision`, `changedAt`,
  `changedSources[]`, and the full `sources[]`.
- `source-error`: structured error when checking a source fails; the UI shows it as recoverable and
  waits for browser auto-reconnect or the next event.

The server may implement change detection with a filesystem watcher or mtime/size fingerprint
polling; this is a debug-only sidecar capability that must not affect the agent runtime path. SQLite
requires watching the main DB plus its `-wal` and `-shm` companions, or the UI stops updating in WAL
mode; `-shm` is a shared-memory index whose mtime readers may also update, so change detection uses
only its presence and size as a signal while actual content refresh relies on the main DB and
`-wal` fingerprints.

### `GET /api/network/status`

Returns proxy run status, certificate path, and copyable environment variables.

### `GET /api/network/requests`

Returns recent network requests, filterable by `traceId`.

### `GET /api/network/events`

Returns the network capture SSE stream for incremental UI list updates.

## UI views

- Trace selector: the filter bar keeps exactly two selects — project, then trace; each trace option
  shows both the `traceId` and the first user message summary.
- Realtime status: the UI connects to `/api/observations/events` by default and auto-refreshes the
  trace list, current trace detail, and Gantt chart on source changes; a manual refresh button
  remains as a recovery path.
- Timeline: shows turn, model, tool, permission, subagent, log, and DB message/part in time order.
  A timeline entry's `summary` and expandable `payload` must keep the full content provided by the
  source with no character truncation; the UI may use wrapping, scrolling, or collapsing to control
  layout but must not replace content with an ellipsized preview.
- Gantt: shows execution spans of one trace by lane; runtime spans come from `spans[]`, network
  requests convert to the `network` lane per `NetworkRequestRecord` and merge by `traceId`.
- Context panel: horizontal share bars and a list for system/skills/tools/other tokens and chars;
  observable text is expandable.
- Cache panel: cache read/write tokens, estimated hit rate, attributable text segments, and reasons
  attribution is impossible.
- Gaps panel: development requests to the agent runtime, to guide the next observation events.
- Network page: standalone proxy status, certificate location, environment variables for launching
  the tested CLI, and a live HTTP(S) request list; the selected `traceId` highlights matching
  requests, and the page can filter by trace. Request rows use fixed height with single-line
  ellipsis on the main URL and error text so the list does not jump when live requests arrive.

## Cache attribution rules

If the session events contain both:

- `model_request.payload.messages`
- a later `model_complete.payload.usage.cacheReadTokens`
- or `turn_complete.payload.cacheStats.cachedMessages`

the debug app may mark the prefix of provider-visible messages as `hit` and the rest as `miss`. This
is an explainable estimate based on runtime cache stats, not a per-segment hit detail returned by
the provider.

With only SQLite `step-finish.tokens.cache` or model usage tokens, only a token-level hit rate can
be shown, and `limitations[]` must state that per-text cache reports are missing; no fabricated
`unknown` message segments may be generated.

## Observation events requested from agent developers

### `context_snapshot`

Emit a read-only artifact or session event before each model request:

- `traceId`, `sessionId`, `turnId`, `modelRequestId`
- `sections[]`: `id`, `name`, `source`, `chars`, `tokens`, `contentHash`, `preview`, optional
  `artifactRef`
- `messages[]`: provider-visible message `role`, `chars`, `tokens`, `contentHash`, section reference
- `toolSchemaSetHash`

### `prompt_cache_report`

Emit after the model response:

- `traceId`, `sessionId`, `turnId`, `modelRequestId`
- `usage`: input/output/total/cacheRead/cacheWrite/reasoning tokens
- `segments[]`: `messageIndex`, `role`, `source`, `contentHash`, `tokens`, `cacheStatus`
  (`hit` / `miss` / `unknown`), `reason`

### `session_event_jsonl_sink`

Provide a dev-time config or CLI flag that appends session events to a JSONL file. This must go
through the existing event sink / storage port; business modules must not write files directly.

### `http_trace_headers`

The HTTP adapter writes the top-level trace of the current execution context into outbound request
headers:

- `x-zcode-trace-id`

This header is the debug proxy's primary way to attribute network requests. Fine-grained
diagnostics such as `sessionId`, `turnId`, `spanId`, `parentSpanId`, and `modelRequestId` must not
be sent as `x-zcode-*` HTTP headers; they belong in runtime events/logs merged by the same
`traceId`. The adapter must not mint a new trace when the execution context is missing.

## Test coverage

- The JSONL parser skips bad lines and returns warnings.
- Trace merging orders logs and events of one `traceId` into a stable timeline.
- The context analyzer infers `skills`, `tools`, and `system_prompt` shares from a full system
  prompt.
- The cache analyzer marks a prefix hit when `cachedMessages` exists and reports text attribution as
  unavailable when only token usage exists.
- API tests use temporary fixture files and do not depend on real user logs or DBs.
- Observation events send `change` over SSE when a JSONL/SQLite source fingerprint changes, and the
  frontend re-fetches automatically.
- Network capture starts the local HTTP proxy, redacts sensitive headers, filters by `traceId`, and
  exposes live requests via API/SSE.
