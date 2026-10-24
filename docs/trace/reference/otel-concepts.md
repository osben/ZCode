# OpenTelemetry Concepts and ZCode Choices

> The OpenTelemetry concepts, structural relations and ZCode modeling constraints used by CLI Agent
> Trace. Overall design and integration: [CLI Agent Telemetry design and development
> spec](../cli-agent-telemetry.md).

## 1. Overall model

```text
Resource                      describes the Telemetry producer
 `-- TracerProvider
       `-- Tracer (Instrumentation Scope)
             `-- Trace
                   +-- Span: SpanContext, Attributes, Events, Status, Links
                   `-- Parent/Child topology
Context   in-process propagation of the Active Span and a ZCode-private correlation snapshot
Metric    cross-request aggregate signal, independent of any single Trace
```

These concepts have different roles and do not convert layer by layer into Attributes: Resource ships
with exported data and describes the producer; Context exists only during runtime propagation;
SpanContext is a Span's propagation identity; Attribute/Event/Status are Span data; Parent/Link are
structure between Spans; Metric is a different signal.

## 2. Resource, Provider and Instrumentation Scope

### 2.1 Resource

Producer attributes stable for a Provider lifetime: `service.name`, `service.version`,
`service.instance.id`, `deployment.environment.name`, `process.runtime.name`, `os.type`, `host.arch`,
`zcode.telemetry.schema_version`, `zcode.product.version`, `zcode.runtime.surface`. It answers which
service, version, process and runtime surface produced the data. Session, Turn and logged-in user change
and do not belong in Resource. The OTel SDK combines Resource with Span data at export; business code
never sets it per Span.

The Trace Resource contains `service.instance.id` and `zcode.device.installation_id` for single-case
diagnosis. The Metric Resource deliberately drops these two high-cardinality values, otherwise every
short-lived CLI process would create a new time series.

### 2.2 TracerProvider and Tracer

`TracerProvider` owns processors, Exporter, Sampler and Resource. One CLI process creates one Owner
holding one TracerProvider and one MeterProvider. The Tracer's Instrumentation Scope identifies which
library created the Spans: `name = @zcode/cli-agent-telemetry`, `version = Telemetry Schema Version`.
This OTel Instrumentation Scope is not the business Typed Span Writer nor the `scope.run()` execution
scope.

## 3. Trace, Span and SpanContext

- Trace: the set of Spans sharing a `traceId`; not a separately created object (the Root Span creates
  it, Children inherit). ZCode usually makes one main Agent Turn one Trace; background tasks or
  Workflows with an independent lifecycle create another Trace related by Link.
- Span: a piece of work with start, end and duration: name / kind / start and end time / attributes /
  events / status / links / spanContext / `parentSpanId` (if Child). Span Name is a stable
  low-cardinality node type such as `agent_step`, `model_attempt`; ZCode does not keep a duplicate
  `span_type` Attribute and never puts Step Index or Model Name into the Span Name. `SpanKind.INTERNAL`
  for Turn, Step, Tool, Command, Compaction, Call; `model_attempt` uses `SpanKind.CLIENT`.
- SpanContext: the immutable propagation identity `traceId`, `spanId`, `traceFlags`, `traceState`,
  `isRemote`. It carries no Session ID, UID, Prompt or Attribute; Parent and Link use SpanContext, not
  the whole Span. `isRemote` says whether the context was extracted from a remote propagation boundary;
  a causal reference captured from the Active Span inside the CLI keeps its original value and must not
  be set true to "look cross-task".

## 4. Context and Active Span

OTel Context is the immutable in-process carrier. The Node SDK uses `AsyncLocalStorageContextManager`,
so Promise, `await`, Timer and concurrent async chains each get the right Active Span.

```text
scope.run(callback)
  +-- context.with(childContext, callback)
  |     `-- startStep/startTool/startCall inside callback read the right Active Span as Parent
  `-- after callback, the caller's Context is restored
```

ZCode also stores a Runtime-private `ActiveWriterContext` in the same OTel Context (immutable
Execution Correlation, current Writer, Tool Call ID). Business code cannot access the private Context
Key and should not thread Session/Turn/Provider fields through layers. Context is never exported and
never becomes Attributes automatically; fields that must be searchable in ARMS must be explicitly
projected by `executionProjection()`.

```text
Span --holds--> SpanContext
Span --trace.setSpan(Context, Span)--> new Context
Context --trace.getSpan()--> current Span;  --trace.getSpanContext()--> current SpanContext
```

Context is the runtime container, SpanContext the propagatable identity, Span the work object that
records data.

## 5. Parent, Link and Causation

### 5.1 Parent/Child

A Child shares the Parent's traceId and its `parentSpanId` points to the Parent. It expresses ownership
in one execution tree and does not require the Parent to end after the Child. When the Active Span is
enough, the Writer creates the Child automatically; only deferred, concurrent or new-Runtime boundaries
that cannot rely on the current Context capture a Causation explicitly.

### 5.2 Link

A Link is an edge from a new Span to another SpanContext; the Spans may have different traceIds. It
means "triggered by, not owned by":

```text
tool_execution --Link(spawned_by)--> agent_turn(root)
trigger span   --Link(triggered_by)--> detached_operation(root)
old run        --Link(resumed_from)--> recovery root
```

A Link must be written at Span creation. Root + Link must explicitly use `ROOT_CONTEXT` so the current
Active Span cannot silently become Parent. Link attribute: `zcode.link.relation = spawned_by |
triggered_by | resumed_from`.

### 5.3 `AgentTelemetryCausation`

```ts
interface AgentTelemetryCausation {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: string;
  isRemote: boolean;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
}
```

The first five fields are the OTel SpanContext; the last three are a controlled query projection for
when ARMS cannot join across Links. It carries no Prompt, Tool arguments or arbitrary business objects.
Capture must happen at the scheduling boundary (when enqueuing or creating the child); reading
`context.active()` at "later execution" may yield another task's Span. The later task creates a Child
or Root + Link from the saved Causation.

### 5.4 Cross-process boundary today

Agent Telemetry Causation is currently passed between the shared CLI Runtime and internal child
runtimes. Desktop/RUM Trace and CLI Agent Turn are not unified into one W3C cross-process Trace. The
`traceparent` field in the protocol belongs to the broader RPC tracing infrastructure; do not assume the
CLI Agent Writer injects/extracts it automatically. If the boundary is opened later, use the OTel
Propagator for `traceparent`/`tracestate` and update the strict protocol schema (no hand-written Header);
whether an Agent Turn stays Root + Link is decided separately by execution ownership.

## 6. Attribute, Event, Status and exceptions

- Attribute: a Span fact or terminal summary (Provider, Model, Token, Exit Code, Outcome, Failure
  Stage). Typed and cardinality-bounded; not a log container. No dynamic large objects, bodies, Headers
  or full Error Stacks.
- Event: an instantaneous record within the Span lifecycle (e.g. `first_provider_event`,
  `first_content`). Rule: "what / final value" -> Attribute; "when" -> Event; "how long with its own
  result" -> Child Span. Some milestones write both (`markFirstContent()` writes the `first_content`
  Event and `time_to_first_content_ms`): Event for single-case timing, Attribute for quick filtering.
- Status and business Outcome: OTel Status is only `UNSET/OK/ERROR`, so ZCode uses a Span-specific
  `outcome`:

| Outcome        | OTel Status | Meaning                                                   |
| -------------- | ----------- | --------------------------------------------------------- |
| `completed`    | `OK`        | Business completed normally                               |
| `failed`       | `ERROR`     | Business failed                                           |
| `cancelled`    | `UNSET`     | Cancelled, not counted as system error by default         |
| `denied`       | `UNSET`     | Permission or policy denied                               |
| `discarded`    | `UNSET`     | Result explicitly discarded                               |
| `backgrounded` | `UNSET`     | Command moved to background, foreground observation ended |
| `abandoned`    | `UNSET`     | Writer did not reach a normal terminal and was reclaimed  |

`failure_stage` says where in the Span's business phases the error occurred, `error_category` is the
low-cardinality classification, `error_message` keeps the sanitized source information; they are
complementary and the category alone is not enough.

## 7. Metric

Trace answers which request failed and why; Metric answers overall failure rate and P95. A Metric
series is determined by Instrument name plus Label combination, so high-cardinality Labels cost money
and break correctness. ZCode Writers record Metrics when the fact is determined (Setter / Terminal
Latch writes both the Span Attribute/Event and the low-cardinality OTel Metric), never guessing offline
from exported Traces. Even if the backend later samples Traces, Metric counts and Token denominators stay
complete. Session, Turn, Request, user, installation, Endpoint and error message must never be Metric
Labels.

## 8. Baggage

Baggage travels with Context across services and may be injected into downstream requests; it is not a
"public Attribute" and is riskier. The CLI Agent uses no business Baggage: no UID, installation ID,
Session ID, Prompt, file path or Tool arguments; none injected toward model Providers; any new Baggage
field needs separate review of receivers, lifecycle and privacy. Fields queryable across Spans should
use Resource, controlled Execution Projection or Trace topology.

## 9. Common mistakes

1. Treating Context as a public field set (it is not exported; choose Resource or Attribute).
2. Treating SpanContext as a Span (it can only correlate and propagate).
3. Duplicating all parent fields for Parent/Child (project only IDs the backend must search).
4. Switching to Link because the Parent ended first (Link is for independent lifecycles).
5. Using Event for independent duration (Events have no terminal; create a Child Span for an SLO).
6. Mixing logs, Trace and Metric (different collection, privacy, cardinality, queries).
7. Putting dynamic values in the Span Name (use stable names, dynamic facts in controlled Attributes).
8. Treating GenAI fields as the internal Schema (`zcode.*` is authoritative; compatibility fields are
   Adapter projections).

## 10. Further reading

[OpenTelemetry Specification](https://opentelemetry.io/docs/specs/otel/),
[Context](https://opentelemetry.io/docs/specs/otel/context/),
[Trace API](https://opentelemetry.io/docs/specs/otel/trace/api/),
[Resource](https://opentelemetry.io/docs/specs/otel/resource/),
[Metrics Data Model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/),
[Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/),
[Baggage](https://opentelemetry.io/docs/concepts/signals/baggage/).
