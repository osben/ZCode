# Runtime, Privacy, Performance and ARMS Reference

> Lifecycle, propagation, privacy, performance, test and ARMS operations constraints of the CLI Agent
> Telemetry Runtime. Overall design and integration: [CLI Agent Telemetry design and development
> spec](../cli-agent-telemetry.md); fields: [Schema dictionary](./schema-reference.md).

## 1. Process-level Runtime

### 1.1 Single Owner

Each CLI process has one `AgentTelemetryRuntimeOwner`:

```text
AgentTelemetryRuntimeOwner
+-- AsyncLocalStorageContextManager
+-- BasicTracerProvider
|   +-- ParentBasedSampler(TraceIdRatioBasedSampler=10%)
|   +-- BatchSpanProcessor
|   `-- OTLPTraceExporter
+-- MeterProvider (PeriodicMetricReader, OTLPMetricExporter)
+-- AgentExecutionTelemetryRuntime
+-- ModelApiTelemetryStatusSink
`-- many lightweight Writers shared by Sessions
```

A Session borrows the Owner's `agentExecution/modelExecution/statusSink` and creates no Provider,
Exporter, queue or Timer of its own. On Session close:

```text
abandonSession(sessionId)
    +-- the Session's unfinished Writers -> abandoned(session_shutdown)
    `-- clean the Model Status Sink index
flush(timeout=1.5s)    best-effort flush of the shared Owner, does not close it
```

Only the outermost process entry (CLI/TUI/Protocol Agent exit) calls `shutdown()`. Shutdown stops status
recording first, closes remaining Writers as `abandoned(process_shutdown)`, then closes the Trace and
Metric Providers with a bound.

### 1.2 Injection and self-initialization

Both entries end in the same Owner contract: Desktop/Host injects OTLP config, versions, runtime
surface, installation ID and identity updates; Standalone CLI reads the same OTLP config from the
controlled environment; then async `prepareModelTelemetryEnv()` -> `createOwnedAgentTelemetryRuntime()`.
`createModelTelemetry({ owner })` with an explicit Owner wins over the process-prepared Owner; Endpoint
config cannot override a caller-injected instance. A Session may only borrow, never replace, the
process-level Owner.

Config:

```text
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
OTEL_EXPORTER_OTLP_ENDPOINT
OTEL_EXPORTER_OTLP_TRACES_HEADERS
OTEL_EXPORTER_OTLP_HEADERS
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
OTEL_EXPORTER_OTLP_METRICS_HEADERS
OTEL_SERVICE_NAME
ZCODE_MODEL_TELEMETRY_ENABLED
ZCODE_TELEMETRY_DEVICE_MID
ZCODE_TELEMETRY_USER_SUBJECT_ID
ZCODE_TELEMETRY_IDENTITY_STATE
ZCODE_TELEMETRY_RUNTIME_SURFACE
ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION
ZCODE_APP_VERSION
ZCODE_BUILD_COMMIT_ID
```

With only the shared `OTEL_EXPORTER_OTLP_ENDPOINT`, Trace appends `/v1/traces` and Metric `/v1/metrics`.
With only an ARMS Trace-specific URL, Metric reuses the same URL (the ARMS custom OTLP HTTP endpoint
serves all three signals). Headers are runtime Secrets: they go only into Exporter config, never
Resource, Span, Metric or logs.

### 1.3 Disabled path

With no valid Trace Endpoint, or `ZCODE_MODEL_TELEMETRY_ENABLED` = `0/false/off/disabled`: the OTel
SDK/Exporter is not dynamically imported; no Provider, queue, Timer or network request is created; a
shared No-op Writer is returned; No-op `run()` executes the business callback directly and exactly once;
`--help`, version query and paths with no Agent work bear no SDK init cost.

### 1.4 Installation ID and identity update

The Standalone installation ID is stored in `$ZCODE_HOME/v2/telemetry-state.json` or
`~/.zcode/v2/telemetry-state.json`. Creation uses async file I/O, atomic temp-file Rename, a
cross-process lock and 5-minute Stale Lock reclamation. If another active process is updating, do not
wait: this run may omit the anonymous correlation; any read/write failure never blocks the CLI.

The identity snapshot can be updated through `updateIdentity()` on login, logout and account switch.
Each new Turn reads the current snapshot once at creation; existing Spans are not rewritten, so identity
is stable within one execution.

## 2. Context, topology and multiple execution surfaces

### 2.1 In-process Context

`BaseSpanWriter.run()` activates the current Span via OTel `context.with()`; children find the Parent
from the active context automatically. The Runtime keeps no second "current Span" AsyncLocalStorage. The
private `ActiveWriterContext` lives in the same Context as the OTel Span and holds the correlation
snapshot, Parent Writer and Tool Call ID.

### 2.2 Causation modes

`AgentTurnTraceStart` supports `causationMode=child` (rebuild the Parent Context from the saved
SpanContext; Child shares the traceId) and `causationMode=linked_root` (default: new Trace from
`ROOT_CONTEXT`, Link to the saved SpanContext). `DetachedOperationTraceStart` follows `executionKind`:
Foreground = Child; Queued and Background = Root + Link. A Recovery Link uses `resumed_from`, other
independent operations `triggered_by`. Explicit Causation rebuild must start from `ROOT_CONTEXT` and not
inherit execution-time temporary Baggage, Active Span or private Writer State.

### 2.3 Subagent and Workflow

```text
Foreground Subagent (parent tool awaits):  parent tool -> child agent_turn -> child's own step/call/attempt/tool
Background Subagent:                       parent tool --Link(spawned_by)--> child agent_turn root
Workflow / Script Workflow Child:          trigger --Link(spawned_by)--> child agent_turn root
```

The Child Runtime receives the same `AgentExecutionTelemetryPort` and the captured Causation, so every
inner Step, Tool, Call and Attempt gets its own Span (not a Subagent black box). Actor Kind from
`SessionTaskType`: `subagent_child` -> `subagent`; `workflow_child` / `nested_workflow_child` ->
`workflow_child`; otherwise `main`.

### 2.4 Out-of-Turn operations

`detached_operation` covers title, Goal, Project Memory, Workspace text generation and other work
outside a Turn. If such an operation calls a model it must run inside its `scope.run()` so the Model
Call becomes its Child. Project Memory Recall captures Causation at scheduling/prefetch time; Dream,
Extraction and Title likewise. Operation enum:
[Schema dictionary](./schema-reference.md#101-operation-catalog).

### 2.5 Multi-surface live facts

```text
desktop-continuous real execution ---------------------> creates Span
web-remote-replayable triggering shared-host real run --> creates the same CLI Span
snapshot / hydration / UI replay ----------------------> creates no Span
```

Trace records the Agent Runtime's real execution, not Renderer replay. When mobile `/remote` uses
shared-host attachment, the Host carrying the real CLI Runtime still reports; nothing is reported from
Relay, Main or recovery UI (it would double count). `AgentTelemetryCausation` is an internal strict CLI
type, not complete W3C cross-process propagation from Desktop/RUM to the Agent; to open that boundary,
change the `@zcode/protocol` strict Schema and add topology tests.

## 3. Writers and terminal guarantees

### 3.1 Direct Setter model

No runtime Schema Registry and no Telemetry DTO wrapping of business results: a business fact -> the
concrete Writer Setter -> normalize/sanitize, write Canonical `zcode.*`, write an Event if needed,
record a Metric if needed, project a Compatibility Alias if needed. Contracts give compile-time
interfaces; explicit Keys in Runtime make implementation and queries visible; the Schema dictionary
explains what code cannot express.

### 3.2 `run()` exactly-once behavior

`run<T>(() => T): T` supports both sync values and Promises: synchronous throw -> if no terminal,
`finishUnhandled`, rethrow the original error; returned Promise -> resolve without explicit terminal =>
`abandoned(missing_terminal)`, reject without terminal => `finishUnhandled`, re-reject; plain value
without explicit terminal => `abandoned(missing_terminal)`.

Context Manager should not throw outside the business callback, but Runtime defends three cases: (1)
failure before activation: log a controlled Warning and run the business once outside Context; (2)
Context teardown failure after the business returned: keep the business return, do not re-run; (3)
business failure: close the Span then rethrow unchanged. Internal `entered/businessReturned/
businessValue/businessError` latches guarantee the callback never runs twice because of a Telemetry
exception.

### 3.3 Terminal Latch

All terminal methods share a one-shot Latch: `claimTerminal()` sets `ended=true` first, then writes
outcome / status / metric / `span.end()`. Even if the SDK, Adapter, Metric or `span.end()` throws, the
Latch does not reopen; later terminal calls are No-ops. When Session/Process reclamation races a normal
terminal, only the first terminal operation takes effect.

### 3.4 Error claiming

The same Error object and its `cause` chain (up to 8 levels) are claimed with a `WeakSet`: a
ProviderError's body is recorded first at `model_attempt`; the AdapterError(cause=ProviderError)
bubbling to `model_call` records failed/category/stage but not the body again; step/turn likewise. The
original object is not held long-term (WeakSet does not extend lifetime). A non-object error that cannot
be claimed is converted in a controlled way at the nearest Span. The guarantee relies on upper layers
passing on the same Error or `cause` chain; a Producer that re-creates causally unrelated Error objects
per layer defeats recognition and is forbidden.

## 4. Model Status to Trace

The model API layer supplies real request facts through unified Status Events; `ModelApiTelemetryStatusSink`
manages: `logical_call_started` -> `startCall(logicalCallId, operation, requested target)`;
`attempt_started` -> `call.startAttempt(requestId, actual target, transport, cause)`; headers / stream /
usage / error status -> the concrete attempt Setter or marker; `attempt_terminal` -> `attempt.finish*`;
`logical_call_terminal` -> `call.finish*`.

It keeps at most 1000 active Model Calls. Status event entry lazily sweeps at most once per minute; Calls
and Attempts idle for 30 minutes close as `missing_terminal`. This TTL belongs only to the status index,
not a general Span TTL: legitimately long Turns/Commands are never auto-ended for duration. The model
entry `operation` prefers the call site's explicit Observation; the old `querySource` is only a
compatibility mapping and an unknown Query Source falls back to `tool_internal_model_call` (never a
free-text Operation).

## 5. Compatibility Adapter

The Adapter accepts only already normalized, sanitized facts: Provider Adapter / Writer Setter -> Canonical
`zcode.*` and `compatibility-adapters.ts` (`gen_ai.*`, `http.response.*`, `server.*`, `process.*`,
`error.*`). Business call sites are unaware of GenAI or ARMS fields. On an external convention change,
change the Adapter and exact-mapping tests; Canonical keeps full internal semantics. Canonical is never
rebuilt from compatibility fields (conversion may lose information).

## 6. Privacy and sanitizing

### 6.1 Data classes

| Class                   | Examples                                           | Policy                                      |
| ----------------------- | -------------------------------------------------- | ------------------------------------------- |
| Low-risk runtime facts  | Outcome, Token, HTTP Status, Provider Kind         | Recorded under type/cardinality limits      |
| Pseudonymous identifiers | Installation, User Subject, Session, Turn, Request | Trace only, bound by access and retention policy |
| Controlled free text    | Model, Provider Error, Safe Name                   | Sanitize, truncate, test                    |
| High-privacy content    | Prompt, body, file, command, Header, Body          | Collection forbidden                        |

The installation ID is a random persistent product pseudonym (not a MAC or disk serial). User Subject ID
is currently not re-hashed in the CLI; the Host must supply only a stable subject ID allowed into
Telemetry. Both can correlate user behavior and must not be called anonymous.

### 6.2 Provider Endpoint

Rules for an input Base URL: length > 4096 -> omit; non-http/https or parse failure -> omit;
username/password -> delete; query/fragment -> delete; hostname lowercased; default 80/443 port removed;
path segment that is email/uuid/long number/long hex/token -> placeholder; ordinary segment at most 128
chars; route at most 1024 chars. Output: `provider_origin = scheme://host[:port]`,
`provider_route = sanitized pathname`. Users need not configure a safe template.
`ProviderEndpointIdentityCache` caches up to 256 entries by `(providerKind, baseURL)` to avoid repeated
URL parsing and regex sanitizing.

### 6.3 Error message

Keep original diagnostics but remove high-risk content: (1) truncate input to 4096 chars first (bounds
malicious Provider message cost); (2) strip URL Query/credentials and sanitize dynamic Segments; (3)
clear Authorization, API Key, Token, Password, Secret, Cookie, Session key-values; (4) clear Bearer/Basic,
common `sk-*`, GitHub Token, AWS Key, Google Key; (5) replace emails, user local paths, Temp paths and
Windows absolute paths; (6) strip control chars, collapse whitespace; (7) truncate to 2048 chars.
`provider_error_message` and Lifecycle `error_message` both use this Sanitizer. Error codes only get
control-char cleanup and a 128-char cap, never re-classified by template.

### 6.4 Tool and Command

Allowed: Registry Tool Name, command category, Shell Kind, controlled Safe Name, Exit Code, Signal,
Timeout, Output Bytes, Truncated. Forbidden: Tool arguments, Tool output body, full command, script,
args, path, cwd, environment variables. Safe Name comes only from the command Registry/Allowlist; a
truncated command text is not "safe".

### 6.5 Access and retention

Code sanitizing is not the only privacy control. The ARMS Workspace still needs least privilege, query
audit and sensible retention; exports containing user or installation pseudonym IDs must not be shared
freely. OTLP Header/License Key must not enter screenshots, doc examples or Git.

## 7. Performance, capacity and reliability

### 7.1 Current defaults

| Item                            | Current value/behavior                              |
| ------------------------------- | --------------------------------------------------- |
| Active Writer cap               | 5000 per process                                    |
| Model Status active Call cap    | 1000                                                |
| Model Status lazy reclaim       | 30 min idle; Sweep at most once per minute          |
| BSP Queue                       | 2000 Spans                                          |
| Export Batch                    | 100 Spans                                           |
| Batch Delay                     | 5 s                                                 |
| Export Timeout                  | 3 s                                                 |
| Session Flush                   | default 1.5 s                                       |
| Process Shutdown                | default 1.5 s                                       |
| Metric Export Interval          | 5 min; best-effort flush still on process exit      |
| Metric Series cap               | 250 per View                                        |
| Trace Head Sampling             | Root 10%; child Spans inherit the parent decision   |
| Histogram Min/Max               | Not recorded; Count, Sum and slim Buckets kept      |
| OTLP compression                | Gzip                                                |

### 7.2 Hot path

Writer creation and Setters handle only small known inputs; no synchronous file or network I/O; no
traversal of Prompt, Messages, Header, Body or arbitrary large objects; bounded Endpoint sanitizing
cache; truncate before error regexes; Streaming records only First, Stall Count and Max Idle (no
per-Chunk Event); Token Metric uses a monotonic Delta of the cumulative value; Trace is exported
asynchronously by BSP and the business never waits for a Span report.

### 7.3 Capacity and degradation

At the Active Writer cap: refuse to create a new Span -> return the shared No-op Writer ->
`zcode.telemetry.creation_drop.count += 1` -> `onWarning` (one active warning until capacity recovers)
-> business continues. The only remotely observable Health Metrics are currently `creation_drop` and
`abandoned`. Dedicated Metrics for BSP Queue Drop, Exporter Failure and Shutdown Timeout are not
implemented and Dashboards must not assume them. On a complete outage the remote Metric cannot arrive
either, so a "service data disappeared" alert or a Collector-side health check is still required.

### 7.4 Sampling

The CLI connects directly to ARMS; Root Traces use deterministic 10% Head Sampling via
`ParentBasedSampler(TraceIdRatioBasedSampler(0.10))`; child Spans of one Trace must inherit the parent
decision (never per-Span sampling producing broken trees). Metric does not follow Trace sampling:
accurate traffic, success rate, Token and latency percentiles keep coming from full Metrics. Head
Sampling decides at Span start and cannot know final failure or slowness, so the current stage accepts
sampling error Traces at 10% too, and must not claim failed or slow requests are 100% retained. If
Collector Tail Sampling is introduced later, restore the client to AlwaysOn and let the Collector decide
on the complete Trace terminal: keep failed, abandoned, slow Traces and rare Operations first; exact QPS,
success rate, Token and percentiles still come from Metrics; Root + Link are two independent Traces with
independent sampling; before the Collector goes live verify capacity, failure retention and Trace-tree
completeness, and do not stack it on client 10% Head Sampling.

### 7.5 Metric volume reduction

`PeriodicExportingMetricReader` interval is 5 minutes (was 60 s); DELTA temporality unchanged and a normal
CLI shutdown still triggers a last best-effort flush, so short-lived processes are not necessarily lost.
Histograms disable `recordMinMax`. Duration/TTFT Histograms use at most 10 slim Buckets covering existing
SLO turning points; the Attempts Histogram keeps `1/2/3/5/8`. This only lowers observation resolution
and ARMS point count and does not change Writer, model call, Tool or Session execution.

## 8. Tests and release gates

### 8.1 Unit and behavior tests

At least: each Setter's Canonical Key, type, enum, unit; Compatibility Alias exact/convert/omit; negative
privacy cases for Endpoint, Error, Tool, Command; exactly-once End, `missing_terminal`, Session/Process
abandon; completed/failed/cancelled/denied/discarded/backgrounded vs OTel Status; business result and
execution count unchanged when Telemetry throws at any boundary; Unknown/Absent/False/0; First Event
dedup, Token Delta, Metric Label Allowlist.

### 8.2 Topology Golden Test

Memory Exporter verifies: Turn -> Step -> Call -> Attempt; Turn -> Step -> Tool -> Command; Turn ->
Compaction -> Call -> Attempt; Tool -> Call -> Attempt; Tool -> Foreground Child Agent Turn; Tool --Link-->
Background Child Agent Turn Root; Trigger --Link--> Detached Operation Root; Retry = one Call + multiple
Attempts. Also check traceId, parentSpanId, Link SpanContext, traceState, isRemote and Query Projection.

### 8.3 Completeness and privacy

At least one call-entry test per Model Operation; every real Provider Attempt enters both OTel and SQLite
`model_usage`; internal model calls (Read Session Context, Web Fetch, Project Memory, Title) not missed;
Stream/Non-stream, Retry, Fallback, Cancellation, Compaction covered; Snapshot/Hydration/Replay do not
backfill; malicious Getter, circular object, oversized Error, Secret, URL Query, file path, email and full
command must not appear in the OTLP Payload.

### 8.4 Build and integration

Disabled verifies SDK, Timer, Network are 0; Standalone CLI and Desktop Packaged Agent send real Canaries;
the packaged build cache fingerprint includes Endpoint/Header/Service Name build inputs; `service.version`
equals the bundled CLI version; `zcode.product.version` equals the product installer version;
`zcode.build.commit_id` locates the build; run related tests, `pnpm typecheck` and `pnpm lint` before
submitting.

Main existing tests (paths relative to `apps/zcode-cli/`):

```text
packages/telemetry/tests/agent-trace-runtime.test.ts
packages/telemetry/tests/model-api-recorder.test.ts
packages/telemetry/tests/agent-metrics.test.ts
packages/telemetry/tests/error-sanitizer.test.ts
packages/telemetry/tests/provider-endpoint.test.ts
packages/telemetry/tests/compatibility-adapters.test.ts
packages/telemetry/tests/otlp-integration.test.ts
packages/core/tests/runtime-agent-telemetry.test.ts
packages/core/tests/tool-agent-telemetry.test.ts
packages/bootstrap/tests/telemetry-bootstrap.test.ts
```

## 9. ARMS queries, dashboards and metric definitions

### 9.1 Data location

OTLP Trace goes to ARMS Trace storage, OTLP Metric to metric storage; no business "table" is needed. To
build: Saved Queries, Dashboards, Alert Rules.

```text
OTel native:  serviceName / spanName / traceId / duration / statusCode
Resource:     resources.service.version, resources.zcode.product.version, resources.zcode.build.commit_id,
              resources.zcode.telemetry.schema_version, resources.zcode.runtime.surface,
              resources.zcode.device.installation_id
Span Attribute: attributes.zcode.execution.turn_id, attributes.zcode.<span_name>.outcome,
              attributes.zcode.model_attempt.provider_origin
```

Different ARMS console versions may use visual conditions, SPL or equivalent syntax; field semantics are
unchanged.

### 9.2 Saved Query

Common condition:

```text
serviceName : zcode-cli-agent
and resources.zcode.telemetry.schema_version : 5
```

Turn: `and spanName : agent_turn`. Failed Attempt:

```text
and spanName : model_attempt
and attributes.zcode.model_attempt.outcome : failed
```

429:

```text
and spanName : model_attempt
and attributes.zcode.model_attempt.http_status_code : 429
```

Provider Error troubleshooting: the failed-Attempt filter above, then aggregate/display
`attributes.zcode.model_attempt.{provider_origin, provider_route, http_status_code, provider_error_code,
provider_error_message, error_code, error_message}`. When the Provider returns no structured error body,
`provider_error_message` can be empty; network/DNS/Timeout errors are usually in Lifecycle
`error_message`. Show both columns when troubleshooting rather than hiding the source difference with
`coalesce`.

Version comparison shows at least `resources.service.version`, `resources.zcode.product.version`,
`resources.zcode.build.commit_id`, `resources.zcode.telemetry.schema_version`. If ARMS does not support
`>=` on semantic version strings, do not compare `3.10` and `3.9` lexicographically: use an exact version
set, Build Commit/release-time slicing, or add a numeric version dimension before ingestion and upgrade
the Schema.

### 9.3 Recommended Dashboards

- Agent overview: Turn count, completed/failed/cancelled/abandoned; P50/P95/P99; Actor Kind, Launch
  Surface, Runtime Surface; CLI Version, Product Version, Build Commit.
- Model Call: logical success rate; Attempt/Call amplification; Retry recovery rate; Operation, Model
  Role, Call Cause; Attempt-per-Call distribution.
- Model Attempt: Provider Kind, Origin, Model, Transport, API Operation traffic; physical success rate,
  P50/P95/P99; First Provider Event, TTFC, TTFT; HTTP Status, Provider Error Code, Failure Stage;
  Input/Output/Reasoning/Cache Read/Cache Write Token; Stream Stall Count and Max Idle.
- Tool and Command: Tool Name traffic, success rate, duration; Permission Denied, Output Truncated;
  Command Category/Safe Name, non-zero Exit Code, Timeout, First Output.
- Telemetry Health: Creation Drop; Abandoned by Span Name/Reason; service data disappeared; there is no
  dedicated Export Failure/Queue Drop Metric yet and the gap must be marked explicitly.

### 9.4 Formulas

Per-Span traffic is the Count of the matching `*.duration` Histogram (no duplicate Request Counter).
Default business success rate: `completed / (completed + failed)`. `cancelled`, `denied`, `discarded`,
`backgrounded` and `abandoned` are shown separately and never silently put into the failure denominator.

```text
Retry recovery rate =
  model_call.duration count where retry_state=recovered
  / model_call.duration count where retry_state in (recovered, not_recovered)

Attempt amplification = sum(zcode.model.call.attempts) / count(zcode.model.call.attempts)

cache read token ratio =
  sum(token where token_type=cache_read) / sum(token where token_type in (input, cache_read))
```

Token definitions differ per Provider, so Dashboards must keep Provider/Model filters and not merge all
vendors' Cache semantics into one unexplained "hit rate". Accurate traffic, success rate, Token and
latency percentiles prefer Metrics; Trace is for error messages, Endpoint, ID correlation and sample
drill-down.

## 10. Versions and Schema evolution

```text
service.version                  CLI Telemetry producer version
zcode.product.version            Desktop/product version
zcode.telemetry.schema_version   data contract version
zcode.build.commit_id            exact build identity
```

Upgrade Schema Version when breaking an Attribute Key/type/unit, Outcome meaning, Parent/Link topology or
Metric denominator. Adding an optional field or compatibility Alias usually does not, but the field
dictionary, Golden Tests and dashboards must be updated. Historical designs and migration plans are for
traceability only, never a basis for new reports or implementation.
