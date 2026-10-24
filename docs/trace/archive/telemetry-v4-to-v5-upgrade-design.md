# CLI Agent Telemetry V4 → V5 Upgrade Design

> Status: historical V4 review and V5 upgrade design. Baseline: 2026-07-29 repository implementation.
> Starting point: Agent Trace V2, Model API Record V1, V4 already shipped. Target schema: `5`.
> Scope: the internal Agent in `apps/zcode-cli`. The [final spec](../cli-agent-telemetry.md) is
> authoritative for Span, Event, Attribute, Metric and Writer contracts.
>
> Full history: `git show b8876e8b:docs/trace/archive/telemetry-v4-to-v5-upgrade-design.md`

## 1. Purpose

Records the implementation review, root causes, trade-offs and migration plan: how CLI Agent Trace
worked, what to keep, where it re-implemented OpenTelemetry, why Context, Link, Model Span, identity
and version changed, and how to upgrade, verify and roll back in phases.

## 2. Summary

V4 laid the foundation for a complete Trace. V5 removes parent-aggregated facts, tightens raw error
ownership and completes the Subagent internal topology. The core of both upgrades is restoring the
right division of labor, not rewriting OTel:

```text
OpenTelemetry
  Resource / Context / Span / SpanContext
  Parent / Link / Event / Status
  ContextManager / BatchSpanProcessor / Exporter
                    │
                    ▼
ZCode domain semantics
  Turn / Step / Tool / Command
  Model Call / Model Attempt / Compaction
  zcode.* canonical attributes
  Typed Writer / privacy sanitizing / query projection
                    │
                    ▼
External compatibility adapters
  GenAI semantic conventions / ARMS aliases
```

1. One Telemetry Runtime Owner per CLI process.
2. The OTel Node Context Manager is the only source of truth for the active Span; the business
   execution context no longer pretends to be an OTel Trace Context.
3. Parent, Link and propagation use native Context, SpanContext and the W3C Propagator.
4. Model Call/Attempt are created and ended at real lifecycle boundaries.
5. BatchSpanProcessor is the only Trace queue.
6. Event = instantaneous milestone, Span = sustained work, Attribute = fact/summary.
7. ZCode canonical attributes are the internal analysis truth; GenAI/ARMS are derived by adapters.
8. Identity is governed by privacy class; a plain SHA-256 is not called anonymization.
9. `service.version` comes from the real CLI build; product version and schema version are modeled
   separately.
10. No old-field compatibility; reports switch atomically by Schema Version.

## 3. Feature Impact Brief

### 3.1 Target behavior

- Turn shows Step, Tool, Command, Model Call, Attempt and Compaction below it; LLM calls outside a
  Turn have an explicit Root operation.
- Searchable by device, user, Session, Turn, model, Provider, tool and operation.
- Computable: traffic, success rate, cancel rate, duration, TTFT, Token, Cache, Retry Recovery.
- The App can inject ARMS; the Standalone CLI initializes the same Runtime factory.
- Telemetry faults never change Agent results.
- By default no Prompt, file content, tool I/O, raw URL, Header or large error text is collected.

### 3.2 Consumers

No direct UI change (no conversation UI case catalog). Consumers: ARMS call chains and Trace
Explorer, ARMS/Grafana dashboards and alerts, local Usage SQLite reconciliation, Telemetry health.

### 3.3 State owners

| State             | Before                              | V4                       |
| ----------------- | ----------------------------------- | ------------------------ |
| Provider/Exporter | `OtlpTelemetryRecordExporter`       | Process-level Owner      |
| Active Agent Span | `activeScopeStorage`                | OTel `context.active()`  |
| Correlation       | several execution contexts          | OTel Context private key |
| Active Model call | `ModelApiTelemetryStatusSink.calls` | Live Call/Attempt Writer |
| Record Queue      | `QueuedTelemetryRuntime.queue`      | Removed                  |
| SDK Queue         | `BatchSpanProcessor`                | The only Trace Queue     |
| Local Usage       | SQLite                              | Stays an independent source |

### 3.4 Invariants

1. Telemetry is always a side path.
2. One Provider, Context Manager, Processor and Exporter per process.
3. A Span terminates exactly once.
4. Only live execution is recorded; nothing is fabricated from hydration/recovery/remote replay.
5. No Secret, Prompt, tool I/O or file content is uploaded.
6. Internal Trace/Baggage is never propagated to third-party model Providers.
7. High-cardinality IDs may be used for Trace queries, never as Metric labels.
8. Schema and product versions are independent.
9. When disabled, the OTel SDK is not loaded.
10. No synchronous file/network I/O on production paths.

## 4. Pre-V4 implementation facts

### 4.1 Agent Span chain

```text
RuntimeTelemetryFacade (startTurn / startStep / startTool / startCompaction)
  -> AgentExecutionTelemetryRuntime -> tracer.startSpan
  -> BatchSpanProcessor -> OTLP HTTP/protobuf -> ARMS
```

Kept: `scope.run()` covering sync and Promise; one-shot `end/fail/cancel`; missed terminals
auto-`abandoned`; Tool success/denied/cancelled/failed kept apart; bounded process Active Writers and
active Model Calls; shutdown closeout; warning rate limiting; error-source fact sanitizing, truncation
and same-cause dedup; Tool/Command upload a sanitized short message only for structured failures;
Endpoint resolution cache and redaction; gzip, batch, timeout, bounded queue; Desktop injection and
Standalone init.

The old global idle TTL was removed in the migration because it could truncate legitimate long
Turns/Commands. Turn/Step/Tool/Command rely on normal Terminal, Session/Process Shutdown and the Owner
Registry. Only Model Call/Attempt (which do not go through `run()`) use a 30-minute inactivity lazy
sweep with a cap of 1000 active Calls.

### 4.2 Model API chain (before)

```text
Model Adapter / Runner -> ModelNetworkStatusEvent
  -> ModelApiTelemetryStatusSink (merges CallState / AttemptState)
  -> ModelApiCallRecord / AttemptRecord
  -> QueuedTelemetryRuntime            # first queue
  -> OtlpTelemetryRecordExporter       # rebuilds Spans from startedAt/endedAt
  -> BatchSpanProcessor                # second queue
  -> ARMS
```

Covered Provider, Model, Transport, Reasoning, Token, Cache, TTFT, Retry, Stream Recovery/Stall,
Provider/HTTP Error, but with a lifecycle different from Agent live Spans.

### 4.3 Context/Link/Resource (before)

`contracts/src/tracing/tracer.ts` had a business `TraceContext` plus its own ALS;
`telemetry/src/agent-trace-support.ts` had another `activeScopeStorage`; no native Node Context
Manager was registered; `AgentTelemetryLink` mixed SpanContext with session/turn/tool/operation;
`spanContextFromLink()` always set `isRemote:true` and dropped `traceState`; Resource mixed service,
runtime, device, user hash and `uid` with unclear scope.

## 5. Problems and V4 decisions

- 5.1 P1 Two active Contexts. Cause: no converged Runtime Owner; OTel Context Manager not
  infrastructure; self-built ALS carried Parent, Link, correlation and aggregation. Result:
  `context.active()` unreliable, new entry points forget an ALS, Promise/Timer/EventEmitter propagation
  verified twice. V4: register `AsyncLocalStorageContextManager`; OTel Context is the only active-Span
  truth; correlation uses a private Context Key; the business `TraceContext` is renamed to an
  execution/log correlation context and never generates OTel IDs or decides Parent.
- 5.2 P1 Model Span rebuilt from terminal Records. Result: no natural Span Event, crashes inferred via
  TTL, Parent SpanContext compressed and restored, two queues and two flushes, Record projection
  drifting from the Agent Writer. V4: logical call start creates `model_call`; physical request start
  creates a child `model_attempt`; network events update the Writer directly; retry creates a new
  Attempt; terminal ends directly and also writes SQLite; Trace Record rebuild and Record Queue
  deleted.
- 5.3 P1 Link was not a full native SpanContext. Rules: `isRemote=true` only for Contexts extracted
  from a remote carrier; in-process capture keeps the original `isRemote`; do not drop `traceState`
  without reason; Link is `{context: SpanContext, attributes?}`; session/turn/tool/operation are not
  part of SpanContext. V4: in-process uses `span.spanContext()`; trusted cross-process uses W3C
  `traceparent/tracestate` via Propagator extract (never hand-assemble a remote SpanContext);
  correlation stored independently.
- 5.4 P1 Duplicate Runtime Owner. The factory accepted `runtime`, `agentExecution`, and with an
  Endpoint created one itself; per-Session init would duplicate Provider/Exporter/Queue/Timer. Fixed
  priority: an explicitly injected full Owner is reused; otherwise create once from process startup
  config; no config -> Noop Owner. An Endpoint never overrides an injected Owner; all Sessions share
  one Owner.
- 5.5 P2 SDK loaded when disabled (`bootstrap.ts` statically imported the Exporter, which statically
  imported the SDK). V4: Noop decision precedes dynamic import; SDK/Exporter/Context Manager load only
  after enablement is confirmed; a process-level init Promise prevents concurrent double loading;
  `--help`/no Endpoint/explicitly disabled tests assert the SDK is not in the module cache.
- 5.6 P2 Span Event unused (the self-built `Span.addEvent()` was empty; stall/retry collapsed into
  terminal Attributes). V4: first provider event, first content, first text, stall, fallback and
  permission state use typed Events; retry is a new Attempt Span; final TTFT and stall count/max idle
  stay Attributes; no per-chunk/token, `request_sent` or `completed` Events.
- 5.7 P2 User identity in Resource (users log in/out/switch, so Resource lifetime is wrong). V4: the
  Owner holds a dynamic Identity Source; Desktop login, logout and account switch refresh it through a
  controlled update channel; each Agent Turn Root (including Child Agent Turn) reads the current
  identity once into an immutable snapshot; Detached Roots do not project user identity by default
  (causality via Link/`parent_turn_id`); Child Spans inherit the Root snapshot, existing Spans are not
  rewritten; a Resolver error omits the user ID and emits a health signal without blocking; only
  independently searchable Spans get a limited projection; sentinels (`unknown`, empty) are omitted;
  device installation ID may be a stable Resource once compliance confirms; Metrics carry no
  user/device/session/turn.
- 5.8 P2 SHA-256 is not anonymization (unsalted hashes are deterministic pseudonyms: dictionary-
  reversible for low-entropy accounts, not rotatable, no cardinality reduction, still personal data).
  V4: long term prefer a backend-issued opaque telemetry subject; Desktop converts the account
  identifier at the trusted Host boundary into an unreadable stable `user_subject_id` (raw account,
  email and login never enter the Agent); the subject is pseudonymized personal data, not claimed
  anonymous, never a Metric label; omit the user ID without a compliant identifier; device MID is a
  random installation ID, not hashed; random Session/Turn/Request/Tool IDs are not re-hashed.
- 5.9 P2 Uncontrolled common-field copying. ARMS does not guarantee joining arbitrary ancestor
  Attributes, so some projection is needed but not everything. V4: OTel-native trace/span/parent are
  not mirrored as `zcode.*`; Span-local facts go to local canonical only; project only the correlation
  needed for independent search; each projection declares source, purpose, privacy level and target
  Span; high-cardinality projections never enter Metrics.
- 5.10 P2 Old V3 waited for Children before ending the Parent. OTel allows Parent to end first;
  forced waiting pollutes duration, adds ref-counting and can be held forever by detached work. V4:
  Parent ends when its own business completes; business-owned Children are `await`ed by the business;
  Telemetry never waits; queued/background/fan-out work uses a new Root + Link.
- 5.11 P3 Tool vs Command semantics mixed. Tool covers lookup/validation/permission/hook/execute/
  serialize; Command describes a subprocess; Read/Write have no process exit code and a missing value
  must not become `0`. V4: `tool` -> optional child `command` (command-executing tools only) plus other
  sustained internal work; Tool/Command are parent/child Spans with no mid-flight type swap;
  Permission first ships as `permission_requested/permission_decided` Events (a `permission_wait` Span
  only after a new-Span review shows a need for independent Duration/SLO); exit code only on Command;
  record only executable category and allowlisted subcommand, never full command/args/cwd/env/
  stdout/stderr.
- 5.12 P3 Version source misled by stale dist. At the 2026-07-30 baseline the repo-root product
  version was `3.6.1` and the CLI build version `0.16.1`; `apps/zcode-cli/packages/cli/package.json`
  `0.1.0` is workspace metadata only; a `v3.6.2` Tag exists but is not the branch version truth; the
  local stale `dist/zcode.cjs` and Desktop staging `bundled-agents/darwin-arm64/glm/zcode.cjs` are not
  version truth either. The CLI build injects `__CLI_VERSION__` from `apps/zcode-cli/package.json`;
  Desktop metadata reads root product build metadata; release packaging must rebuild the Agent rather
  than reuse an unverified local staging artifact. The historical gap: Resource kept only the Agent's
  own version, so the outer Desktop/product version could not be confirmed. V5 keeps
  `service.version` = actual bundled CLI version and `zcode.product.version` (omitted for Standalone
  without an outer product); the App injects the product version, release regenerates the bundle, and
  checks: `--version` = `apps/zcode-cli/package.json` = `service.version`; About = product
  package/build metadata = `zcode.product.version`; `zcode.build.commit_id` available; Schema Version
  independent integer `5`. V4 is live; this round's breaking source-fact, Metric and Subagent topology
  changes upgrade atomically to V5 with no dual-write.

## 6. OTel native model usage rules

### 6.1 Resource

Describes who produces telemetry; stable within the Provider lifetime. Suitable: `service.name`,
`service.version`, `deployment.environment.name`, `service.instance.id`, product version, runtime
surface, build commit, Schema Version, compliance-approved installation ID. Not suitable: Session,
Turn, current user, Model, Tool, Request ID.

Metric Resource also keeps `service.instance.id` at first (avoids multiple CLI processes' cumulative
series and restart resets overwriting each other; aggregate across instances at query time). Strip the
instance ID in Collector aggregation only after DELTA Temporality and ARMS multi-producer semantics are
verified. User, device, Session and execution IDs never enter Metric Resource.

### 6.2 Context and SpanContext

```text
OTel Context
  ├─ active Span
  ├─ Baggage (no business identity by default)
  └─ ZCode private values: execution correlation, typed writer anchor
```

Context is an immutable, execution-scoped carrier, not uploaded or queryable. The correlation snapshot
is immutable; the aggregate/writer anchor reference is fixed but the anchor is a Runtime-private
controlled mutable counter that business code cannot read, freeze, copy or modify. SpanContext holds
only trace ID, span ID, flags, state, isRemote.

### 6.3 Parent and Link

Parent requires: same end-to-end operation; a unique direct execution owner; shared Trace and
sampling decision. It is not decided by "who ends later". V4 uses Link only for independent-Trace
queued, fan-out/fan-in, background, Child Agent and recovery causality. A new Root is created
explicitly from `ROOT_CONTEXT` with the Link passed at Span creation so the Sampler sees it.

### 6.4 Event, Attribute, Span, Metric

```text
Needs independent duration/status/children? yes -> Span
  no: final stable fact -> Attribute; a concrete moment -> Event; high-frequency aggregate -> Metric
```

A few facts are dual: `first_content` Event + `time_to_first_content_ms` Attribute;
`stream_stalled` Event + `stall_count/max_idle_ms` Attribute.

### 6.5 Baggage and propagation

Baggage is copied to downstream headers and is not an ARMS query column. Default: no
user/device/session/prompt; never injected toward model Providers; business Baggage is not enabled
(any future low-risk routing value across trusted ZCode process boundaries needs separate review of
fields, scope and retention); correlation relies on SpanContext and controlled Attribute projection.

Trusted cross-process:

```text
Parent context -> propagator.inject(traceparent, tracestate) -> typed protocol metadata
  -> child propagator.extract() -> remote trigger Context
       ├─ new Agent Turn -> ROOT_CONTEXT + Link
       └─ trusted same-trace RPC -> remote Parent
```

A new Agent Turn is always a Root; Desktop/RUM-triggered chains relate only via Link.

## 7. Target runtime

### 7.1 Single Owner

```text
AgentTelemetryRuntimeOwner
  ├─ Resource, AsyncLocalStorageContextManager, TracerProvider
  ├─ BatchSpanProcessor, OTLPTraceExporter, Tracer
  ├─ optional MeterProvider, health counters
Session A / Session B / Subagent / Model / Tools -> same Owner
```

Initialize and shut down once. `forceFlush()` only for tests, diagnostics and bounded shutdown.

### 7.2 Scope

1. Take Parent from the current OTel Context.
2. Create the Span.
3. Run the business in `context.with()`.
4. Business calls the typed writer where facts occur.
5. Business explicitly commits normal or domain terminal states; exception and cancel are the
   Scope's fallback.
6. Telemetry exceptions are isolated.

The fallback guarantees the Span closes; it does not guess complex terminals. A normal return without
a committed terminal is `abandoned(missing_terminal)`, never assumed success. Fail-open also covers
`context.with()` and Writer construction: Writer creation failure returns a No-op Writer; failure before
Context activation runs the business once without Telemetry Context; once the callback has been
entered, a Context Manager throw only awaits the same business Promise and never re-runs it; the
Terminal Latch closes in memory before calling SDK/Adapter/Metric; Setter/Finish/Exporter exceptions
never override the business return value or original exception.

### 7.3 Lifecycle

Child may end after Parent. If the business must wait it `await`s; otherwise treat it as an
independent operation.

### 7.4 Subagent/Workflow Child

Choose Parent or Link by real lifecycle:

```text
foreground: Main Turn -> Agent Tool -> Child Agent Turn -> Step/Call/Attempt/Tool
background: Main Turn -> Agent Tool -- Link --> Child Agent Turn ROOT -> Step/...
```

Child Runtime reuses the process Telemetry Port; every inner Step, model request and tool call still
gets its own Span. Foreground (awaited by the parent Tool) uses a real Parent; explicit background can
end and sample independently, using Root + Link.

## 8. Events

| Span          | Event                   | Attributes            |
| ------------- | ----------------------- | --------------------- |
| Model Attempt | `first_provider_event`  | none                  |
| Model Attempt | `first_content`         | none                  |
| Model Attempt | `first_text`            | no body               |
| Model Attempt | `stream_stalled`        | bounded idle bucket   |
| Model Call    | `fallback_selected`     | transport, reason code |
| Tool          | `permission_requested`  | none                  |
| Tool          | `permission_decided`    | result category       |
| Command       | `termination_requested` | reason                |
| Compaction    | `fallback_selected`     | strategy, reason      |

`permission_requested/permission_decided` appear as a pair only when actually waiting on the user;
`not_required` is a final Attribute only. Not recommended: `request_sent`/`completed` (duplicate Span
start/end), per-SSE-chunk/token, raw logs, stacks, commands, tool I/O, Prompt.

Retry is `model_call` -> `model_attempt #1 ERROR`, `model_attempt #2 OK`. No `retry_scheduled` Event;
retry is expressed by the new Attempt Span and `attempt_cause/retry_delay_ms`. Event/Attribute budgets
are in the final spec; stall detail dropped at the cap still keeps the summary Attributes.

## 9. Canonical, adapters and projection

Three outputs: OTel structure (trace/span/parent/status/time/kind); ZCode canonical
`zcode.<span_name>.<property>`; external compatibility (GenAI, OTel semconv, ARMS aliases). Business
code only calls Writers, e.g. `writer.setRequestedModel(model)` sets
`zcode.model_attempt.requested_model` and (via adapter) `gen_ai.request.model`. Each adapter mapping is
exactly one of `exact` (same semantics, type, unit), `convert` (explicit tested conversion), `omit`
(uncertain). Forbidden: filling unknown as disabled, requested as effective, Tool status as exit code.

The limited query projection matrix is maintained only in the
[Schema dictionary, section 3](../reference/schema-reference.md#3-query-projection); migration implementation and
dashboards are accepted against it.

## 10. Privacy

| Class           | Examples                            | Policy                                 |
| --------------- | ----------------------------------- | -------------------------------------- |
| Secret/Content  | Key, Header, Prompt, file, tool I/O | Drop                                   |
| Person identity | Email, phone, OAuth UID             | Host-generated opaque subject / omit   |
| Execution ID    | Session, Turn, Request, Tool Call   | As-is, controlled retention            |
| Category        | Model, Provider, operation, outcome | As-is                                  |
| Unbounded text  | URL, error, command, path           | Structure / sanitize / truncate        |

URL: keep scheme/host/port/sanitized route; drop query, fragment, userinfo; replace email, UUID, long
numbers, hash/token-like, tenant/account segments; cache the sanitized result per Base URL.

Errors keep the raw exception type/code/message closest to the source, plus HTTP status, Provider
code/message and phase independently; category/retryable are extra analysis/control facts that never
override the raw exception.

Writer creation accepts only a narrow Telemetry Descriptor (approved IDs, stable enums, sanitized short
strings), a plain TypeScript type with no Schema DSL. Never hand Telemetry Tool args/definition, parsed
command, full ResolvedModelTarget, Header, URL or Provider Options. `finishFailed(stage, category,
error?)` accepts an unknown object at the exception or structured-failure boundary and sanitizes and
sets the Failed terminal within one Terminal Latch. The Sanitizer reads allowlisted scalars
(name/message/code/status/retry-after) immediately: no caching, no recursion, no `JSON.stringify`, no
reading response/request/config; candidate strings are hard-truncated first, then regex-sanitized. A
malicious Getter or Sanitizer failure keeps only type/code/stage and category `unknown`. Messages are
stripped of Secret/URL query/path then truncated to the final limit; raw stacks are not uploaded.

Command allows executable category, allowlisted subcommand, exit/signal/duration, output
bytes/truncated, timeout/cancel reason; forbids args/cwd/env/stdout/stderr.

## 11. Performance

Hot path: memory writes only; no sync I/O; no JSON stringify/deep copy; no scanning of
Prompt/tool output/large errors; no duplicate Owner; no `forceFlush()` in business calls; sanitize
short strings only. Numeric gates for capacity, Batch, Export, Shutdown, Metric series and network
size live only in the Schema dictionary ([section 15](../reference/schema-reference.md#15-metric-catalog)).

No global TTL and no ancestor activity updates per Setter/Child. Normal Terminal, Session Teardown and
Process Shutdown close out; event-driven Model Call/Attempt (not via `run()`) keep a light
`lastActivityAt`, lazily swept at most once per minute at status-event entry, closing with
`missing_terminal` after 30 minutes idle.

Overload order: drop low-value Events; drop detail Spans and write an overflow count on the Root; keep
Turn/Model Call terminals where possible; no unbounded Collector-failure replay; rate-limit warnings;
health Metrics record drop/failure; never block the business. Benchmarks: disabled, healthy, timeout,
200 Steps/Turn, 1000 active Calls, high-frequency SSE chunks, leftover-Span shutdown; observe startup,
CPU, heap, event-loop delay, queue bytes, drop, shutdown and business latency.

## 12. Migration phases

- Phase 0 spec and version: final spec, this design, Schema `5`, Span/Event/Attribute catalog, ARMS V4
  queries, version acceptance. Accept: privacy of fields complete; Parent/Link per Span explicit;
  high-cardinality projection explicit.
- Phase 1 process Owner: Runtime Owner, fixed injection priority, `@opentelemetry/context-async-hooks`
  with one `AsyncLocalStorageContextManager` registered at startup, disabled path dynamic import,
  idempotent shutdown, Resource carries version/commit/Schema `5`. Accept: multi-Session single
  Provider; injection not overridden; disabled loads no SDK.
- Phase 2 Context and Link: Scope uses `context.with()`; private correlation key; delete Agent
  active-span ALS; native SpanContext capture preserving traceState/isRemote; W3C Propagator across
  processes; rename business TraceContext. Accept: Promise/Timer/EventEmitter/concurrency do not
  cross-contaminate; same-process remote=false; extract remote=true; tracestate round-trips; no
  propagation on model requests; foreground Child Agent Turn shares the trigger Tool's Trace with a
  `parentSpanId`; explicit background Child uses a new `traceId` with a Link to the trigger Span.
- Phase 3 V5 Writers: typed Writers for Turn, Step, Tool, Compaction; canonical + Adapter; Child and
  Usage write only their own source Span/Metric (delete Parent summaries, `TurnAggregates`/
  `ModelCallAggregates`, terminal `writeAggregates()`); `finish*()` accepts only the node's terminal,
  failure stage, error category and raw exception (no business Result or Usage/count summaries); every
  failable Span uses atomic `finishFailed(stage, error_category, error?)` and non-`failed` terminals
  accept no error category; narrow Telemetry Descriptors; idempotent terminals; Telemetry exceptions
  isolated including Writer construction and `context.with()`; Parent does not wait for Child. Accept:
  success/fail/cancel/abandoned; field types; Adapter exact/convert/omit.
- Phase 4 Command Child: command tools create a Command Child; exit code only on Command;
  executable/subcommand allowlist; timeout/signal/cancel; output size/truncation. Accept: Read/Write
  have no exit; scripts and stderr not uploaded; Tool/Command terminals distinguishable.
- Phase 5 Model live Span: Call start creates a live Span, Attempt start a Child; `call_cause` is the
  fixed enum `initial | continuation | fallback_replacement | recovery`; Transport/Provider adapters
  report the Attempt Failure Stage at the real failure point (not everything as `response`);
  milestone/stall/fallback as Events; retry creates a new Attempt; Call ends explicitly when no more
  retries or exhausted, terminal ends directly and writes SQLite; Record -> Span rebuild deleted.
  Accept: real timing; retry tree; Event/TTFT consistent; sanitized errors; abandoned; SQLite/ARMS
  logical-call reconciliation.
- Phase 6 cover all LLM entry points: normal Step; Compaction streaming/non-stream/fallback; Session
  title; Goal summary/title; Completion verification; Git commit message; Web search/fetch processing;
  Read session context extract/synthesize; Workspace generate text; Subagent/Workflow Child; new
  Provider Adapters. Trace upward from the final model adapter; every real request has an Attempt;
  `read_session_context` and `web_fetch_processing` write both Usage and ARMS.
- Phase 7 Event, Metric, reports: typed Events, Telemetry health, Turn/Tool/Model RED Metrics,
  success/cancel/retry recovery, p50/p95 duration/TTFT, token/cache/provider/model breakdown.
  Instrument kinds, UCUM units, record points, legal labels and Histogram buckets follow final spec
  section 15. CLI uses fixed `AlwaysOnSampler`; downsampling is Collector/ARMS Tail Sampling; when ARMS
  direct ingestion lacks it, all Traces are stored and exact success rate and Token denominators come
  from Metrics. Boundaries: Trace and Metric share one Resource and the four version axes
  (CLI/Product/Schema/Commit); Duration Histogram records once after winning the Terminal Latch; Token
  Counter records monotonic increments at the Attempt Usage Setter, not at Call/Turn End; Tokens are
  written only on the source Attempt and low-cardinality Metrics (no copy to Call/Step/Turn); Metric
  labels only spec fields (no device, user, Session, Turn, Request, Endpoint, error text or command
  text), actual request Model ID length-limited and protected by the Series Cardinality Limit. Error
  fidelity: the raw Transport exception reaches the active Attempt/Call Writer only through a
  Telemetry-dedicated observer callback (never into SessionEvent, product logs or domain Results);
  canonical `error_type/error_code/error_message` come from the raw exception (sanitized, limited);
  display text, `error_category` and Metric labels from business retry classification are extra
  projections that never override the raw fact; unused Provider/Model/Error fingerprints and
  string-guessing Model vendor buckets are removed. Business traffic uses the Duration Histogram's own
  Count (no duplicate same-label Counter); detail Instruments (TTFT, Stall) must first pass per-process
  Series, compressed-byte and ARMS-cost Canary.
- Phase 8 Canary: test env Schema 5; local real requests; CI packaged artifact; Desktop injection;
  Standalone init; ARMS Trace Explorer; SQLite reconciliation; 24h health; storage and cardinality
  assessment.
- Phase 9 production cutover: no dual-write of two full Trees; one build outputs one Agent Schema;
  reports switch to Schema 5; historical V2 kept; delete the old ALS, Record queue/reconstruction, old
  aliases/contracts; SQLite Usage kept.

## 13. File impact

- Contracts: `contracts/src/telemetry/agent-execution.ts` (drop mixed Link; V5 Port/relation/Writer),
  `contracts/src/telemetry/index.ts` (drop Trace-rebuild-only Records), `contracts/src/tracing/tracer.ts`
  (rename business Context; delete pseudo-OTel Span and empty `addEvent()`).
- Telemetry: `package.json` (Node Context Manager; Metric SDK/Exporter when the separate Metric signal
  is enabled), `src/bootstrap.ts` (single Owner, lazy load, dynamic identity source, V4 Resource),
  `src/otlp-exporter.ts` (Provider/Processor/Exporter only, registers Context Manager),
  `src/agent-trace-runtime.ts` (V4 Scope/Writer, native Context), `src/compatibility-adapters.ts`
  (central GenAI, standard HTTP/Server and ARMS aliases; Canonical Writers do not depend on external
  names), `src/agent-trace-support.ts` (delete ALS, keep limits/terminal/sanitizer),
  `src/model-api-recorder.ts` (live Model Writer + Usage projection), `src/runtime.ts` (delete Trace
  Record Queue), `error-sanitizer.ts` and the Model Adapter Endpoint Descriptor (keep, strengthen tests).
- Core/Bootstrap: `core/src/telemetry/runtime-telemetry.ts` (V5 Port, no full OTel context assembly),
  `core/src/tool/executor/telemetry.ts` (Tool Writer + Command Child), Turn/Step/Compaction write facts
  at real boundaries, `bootstrap/src/app/create-app.ts` (process Owner only), Subagent/Workflow
  protocol propagates W3C Context, `services/src/zcode-agent/agentTelemetryEnv.ts` (inject product
  version and dynamic identity update; adjust user identity policy); Desktop build keeps injecting from
  the root version.
- Tests: telemetry runtime (Context, Parent/Link, terminal, limits); exporter (Resource, single owner,
  schema/version); OTLP integration (real protobuf Tree/Event); model (Call/Attempt, retry, stall,
  cache); core (Tool/Command, exceptions, cancel, permission); packaged E2E (OTLP build env and real
  version).

## 14. Verification

### 14.1 Unit matrix

| Dimension | Cases                                                                                  |
| --------- | -------------------------------------------------------------------------------------- |
| Scope     | sync, async, throw, reject, cancel, double terminal, Context activation failure, No-op exactly-once |
| Context   | nested, parallel, timer, emitter, missing parent                                       |
| Link      | same process, remote, tracestate, invalid carrier, Turn Root+Link                      |
| Turn      | success, failed, cancelled, abandoned                                                  |
| Tool      | success, denied, failed, cancelled                                                     |
| Command   | exit 0/nonzero, signal, timeout, missing exit                                          |
| Model     | success, retry recovery/exhausted, cancel, abandoned                                   |
| Stream    | SSE, HTTP, first content, stall, recovery                                              |
| Cache     | hit, write, none, unknown                                                              |
| Reasoning | unsupported, disabled, level, budget, adaptive, unknown                                |
| Privacy   | URL, email, token, path, command, provider error, malicious Getter, circular object    |
| Capacity  | span/detail/event/queue limits, long Span, shutdown/capacity race                      |
| Identity  | login, logout, switch, resolver error, old Span not rewritten                          |
| Metric    | type, unit, bucket, label, multi-process reset                                         |
| Version   | CLI project package, product root, Desktop build metadata, bundle, Resource            |

### 14.2 Integration

Capture local OTLP protobuf and assert: valid Trace/Span IDs and Parent; Link preserves traceState;
Child Agent Turn is a new Root with a Link to the remote trigger; Event timestamps correct; Resource
has only stable fields; Schema=`4`; `service.version` matches the CLI bundle; packaged Desktop
`product.version` matches product build metadata; no Secret/Content; gzip/protobuf decodable.

### 14.3 ARMS manual acceptance

Trigger a normal Turn, Tool, Command, retry, Compaction, out-of-Turn title, Child Agent, error and
cancel. Check: Tree complete; Call/Attempt Parent correct; Root Link locatable; Events on timeline;
status/outcome correct; provider/model/reasoning/cache plausible; identity compliant; errors
diagnosable without privacy; product/schema version correct.

### 14.4 SQLite reconciliation

Compare ARMS Call/Attempt with `model_usage`, Turn summaries, retry recovery and token/cache tokens by
logical call and time window. Sampling, crash, capacity drop, disabled and network failure may cause
differences, but health counters must explain them.

### 14.5 Engineering gates

`pnpm typecheck`, `pnpm lint`, telemetry/core/bootstrap unit tests and a real OTLP integration test.

## 15. Versions and release

| Field                            | Source                    | Example           | Changes when     |
| -------------------------------- | ------------------------- | ----------------- | ---------------- |
| `service.version`                | Actual CLI bundle         | `0.16.1`          | CLI release      |
| `zcode.product.version`          | Outer product build meta  | `3.6.1`           | Product release  |
| `zcode.build.commit_id`          | Build metadata            | commit SHA        | Every build      |
| `zcode.telemetry.schema_version` | Contract                  | `5`               | Data contract    |
| `service.name`                   | Telemetry fixed constant  | `zcode-cli-agent` | Never            |

Packaging gate: run `zcode.cjs --version`; read the CLI project package, repo-root product package and
Desktop build metadata; start the packaged Agent and send a Trace; decode the OTLP Resource; assert
`--version` = `service.version` = CLI project package; About = `zcode.product.version` = product
package/build metadata; Schema=`4` and commit not `unknown`. It guards against stale dist, wrong
cache, a Desktop-bundled old Agent and Resource version drift.

## 16. Rollout and rollback

Migration switches: `ZCODE_AGENT_TELEMETRY_SCHEMA=4`; `ZCODE_MODEL_TELEMETRY_ENABLED=0` (global off);
Event detail; identity projection; Collector/ARMS Tail Sampling policy. The CLI has no Ratio Head
Sampling switch (fixed AlwaysOn); until Tail Sampling is ready, size capacity for store-everything and
do not fake "100% errors kept" with client sampling.

Canary: local -> CI packaged CLI -> internal Desktop -> small cohort -> all production, observing
Agent/model latency, startup, heap/event loop, export failure/drop, ingestion volume and privacy
sampling.

Rollback: roll back the whole build or disable Telemetry; never run V2/V4 Trees in parallel; SQLite
Usage is unaffected; historical ARMS data is kept; Dashboards select by Schema; on backend faults,
disable/downsample first rather than rolling back the Agent business.

## 17. Risks and open items

- Compliance: whether device MID may be a Resource; issuance/rotation of the user telemetry subject;
  identity retention and query permission; Provider error message allowlist; whether Model ID may be a
  Metric label.
- Platform: ARMS Link display/query capability; ARMS Event search/aggregation capability.
- Technical: callback propagation gaps after removing the second ALS; Provider network event order;
  cross-process protocol schema; Child Root/Link UI readability; Event storage volume; Schema and
  Dashboard released together; remote workspace trusted boundary.
- Mitigations: Context stress tests, Provider state-machine tests, protocol runtime schema, Link +
  correlation double location, Event cap/sampling, build Dashboard before switching, propagation
  allowlist.

## 18. Definition of done

- [ ] Single Owner per process; disabled loads no SDK.
- [ ] OTel Context is the only active-Span truth; business Context does not pose as OTel.
- [ ] Parent/Link/remote/tracestate correct.
- [ ] Turn/Step/Tool/Command/Model/Compaction Tree correct.
- [ ] All LLM entry points have a static inventory and dynamic verification.
- [ ] Model Call/Attempt are live Spans; only one Trace queue.
- [ ] Events used for instantaneous milestones; Tool/Command exit codes not conflated.
- [ ] Adapter exact/convert/omit tested.
- [ ] Identity policy passes privacy review; no Secret/Content in payload; no high-cardinality identity
      in Metrics.
- [ ] SQLite/ARMS reconcile explainably; Telemetry faults do not affect the Agent; performance within
      budget.
- [ ] `service.version` equals the CLI bundle version; packaged Desktop `product.version` equals the
      product version; Schema=`4`.
- [ ] ARMS Dashboard/Query/Alert switched.
- [ ] typecheck/lint/integration tests pass; real installer passes OTLP acceptance.

## 19. References

- [OpenTelemetry Context](https://opentelemetry.io/docs/specs/otel/context/)
- [OpenTelemetry Trace API](https://opentelemetry.io/docs/specs/otel/trace/api/)
- [OpenTelemetry Resource](https://opentelemetry.io/docs/specs/otel/resource/) / [Resource Data Model](https://opentelemetry.io/docs/specs/otel/resource/data-model/)
- [OpenTelemetry Baggage](https://opentelemetry.io/docs/concepts/signals/baggage/) / [Propagators](https://opentelemetry.io/docs/specs/otel/context/api-propagators/)
- [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
- [OpenTelemetry GenAI Registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)
- [ARMS Trace Explorer](https://help.aliyun.com/en/arms/application-monitoring/developer-reference/use-trace-explorer-to-query-traces)
- [Current Turn Trace](./turn-trace-observability-v2.md) / [Model API facts](./model-api-observability-v1.md)
