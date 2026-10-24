# CLI Agent Telemetry Design and Development Spec

> Status: current implementation spec. Telemetry Schema Version: 6.
> Scope: the Agent, model, tool, command and context-compaction paths inside `apps/zcode-cli`.

Defines the data model, topology, design constraints, integration, privacy boundary and basic queries of
CLI Agent Trace. Full fields, the low-level runtime and OpenTelemetry concepts live in the reference
documents. Together with TypeScript Contracts they form the Telemetry Schema: method signatures and type
constraints are authoritative in Contracts; field semantics and system constraints in the documents.

## 1. OpenTelemetry data model

```text
Resource: the Telemetry producer (CLI version, product version, build, runtime surface, install instance)
  `-- Trace: one complete execution chain
        `-- Span: a piece of work with start, end, duration and result
              +-- Attribute: facts about the work
              +-- Event: a milestone at an instant during the work
              `-- Child Span: inner work with its own lifecycle

Metric: cross-request statistics from the same low-cardinality facts; independent of Trace retention
```

Standard topology of a main Agent Turn:

```text
agent_turn
+-- agent_step
|   +-- model_call
|   |   `-- model_attempt [1..n]
|   `-- tool_execution
|       +-- command_execution      only when an OS process is really started
|       `-- model_call             when the tool uses a model internally
`-- context_compaction
    `-- model_call
        `-- model_attempt [1..n]
```

- `model_call`: one logical model request, covering the overall result after Retry/Fallback.
- `model_attempt`: one physical request actually sent to the Provider.
- `tool_execution`: one execution of a registered tool.
- `command_execution`: the command process a Tool really starts (not a "derived type" of Tool).
- `agent_step`: one step of the Agent Loop, not one model HTTP request.

Statistic targets: logical-call success rate -> `model_call`; Provider success rate, 429/500, Endpoint,
TTFT -> `model_attempt`; tool success rate -> `tool_execution`; Shell/Git exit code ->
`command_execution`. Definitions of Resource, Context, SpanContext, Parent, Link, Event, Baggage and
Metric and ZCode's usage constraints: [OpenTelemetry concepts](./reference/otel-concepts.md).

## 2. Observability facilities and boundaries

| Facility         | Purpose                                                                     | Not for                              |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------ |
| CLI OTel Trace   | Single Agent/Model/Tool/Command chain and fault drill-down                  | Page experience, funnels             |
| CLI OTel Metric  | Traffic, success rate, latency percentiles, Token, Telemetry health         | Single-request bodies                |
| CLI SQLite Usage | Local Model/Turn/Tool detail, settings-page Usage, local reconciliation     | ARMS remote chain                    |
| App RUM          | Renderer pages, resources, API, frontend exceptions, interaction experience | CLI Agent internal tree              |
| `/event/report`  | Product behavior, purchase, feedback, business funnels                      | Agent performance Trace              |
| Local logs       | Lifecycle, manual diagnosis, user-exportable troubleshooting                | Automatically carrying Trace Payload |

Trace is not written to local logs and not reported through RUM. Even if the data ends in the same
Alibaba Cloud account or Workspace, the data models and query entries stay independent.

## 3. Design principles

1. **OTel expresses structure, ZCode defines business semantics.** Parent, Link, Context, Span, Event,
   Status, Resource use native OTel; Turn, Step, Attempt, Reasoning, Cache, Tool Outcome use full
   `zcode.*` fields. `zcode.*` is the only authoritative internal query field; `gen_ai.*`, `http.*`,
   `server.*`, `process.*` are compatibility aliases projected from the same fact and never drive
   business APIs or internal reports.
2. **Record at the fact source.** Record the HTTP status when the Provider returns Headers, mark First
   Content when the first valid content arrives, record Exit Code when the process ends. Telemetry must
   not require business code to build aggregate result objects or re-infer facts away from the source.
   The raw Provider Error Message keeps its meaning after credential/path sanitizing (not folded into a
   few templates); error classification is only an extra low-cardinality dimension.
3. **One independent lifecycle, one Span.** Work needing its own duration, result, error, children or
   diagnostic entry is a Span; an instantaneous milestone is an Event; a single fact an Attribute;
   cross-request aggregates a Metric; background work triggered by a foreground operation a Link. Short
   phases that only help failure location (`parse`, `prepare`) are `failure_stage`, not Spans, unless
   they need an independent SLO or inner subtree. Tool request-permission instant = Event; final
   permission decision = Attribute (Event may accompany).
4. **One owner of each raw fact.** Attempt Token belongs only to `model_attempt`, Exit Code only to
   `command_execution`, Provider error body only to the Span nearest the source that first claims the
   error. Parent nodes record their own outcome and failure stage and never copy a Child's Token, error
   body or aggregate summary. A few IDs (Turn ID, Logical Call ID) are projected to key nodes for ARMS
   queryability: controlled query projection, not fake parent/child via Attributes
   ([rules](./reference/schema-reference.md#3-query-projection)).
5. **Unknown is not False.** Unobserved facts are omitted or written `unknown`, never inferred as
   `disabled`, Cache Miss, not streamed, or `exit_code=0` (a plain Read Tool has no process exit code).
6. **Telemetry is isolated from business execution.** Initialization, Context activation, Setter,
   Metric, export and shutdown failures never change the business return value, exception or execution
   count. Disabled mode returns a No-op Writer so callers need no switch checks.
7. **Content is forbidden by default.** Prompt, model input/output, Reasoning body, Tool input/output,
   file content, full command, HTTP Header, Body and URL Query never enter Trace. Data of unconfirmed
   privacy level must not be collected before review.

## 4. Parent, Link and independent operations

Parent/Child = execution ownership within one Trace; Link = causal relation between an independent Trace
and its trigger.

```text
Is the work a sync/await lifecycle owned by the current caller?
  yes -> Child Span: shared traceId, parentSpanId = caller
  no  -> new Root Span with a Link to the trigger
```

1. A normal main Turn is a Root.
2. A foreground Subagent is awaited by the parent Tool: the Child Turn hangs directly under the parent
   Tool.
3. Background Subagents and Workflow Children are scheduled independently: new Root + Link to the trigger.
4. Non-Turn work (title generation, Goal verification, Project Memory) uses `detached_operation`:
   foreground may be a Child; queued/background/recovery execution uses Root + Link.
5. A Parent may end before its Child; end order alone is no reason to use Link. Ownership and the
   scheduling boundary are.

```text
Sync Subagent:  agent_turn -> agent_step -> tool_execution -> agent_turn(child)
Background:     Trace A: tool_execution --Link--> Trace B: agent_turn(root)
Detached work:  Trace A: triggering span --Link--> Trace B: detached_operation(root)
```

Deferred tasks must call `captureCausation()` at scheduling time and must not read the then-Active Context
at execution time to infer the trigger. `AgentTelemetryCausation` holds an OTel SpanContext plus a few
query-projection IDs and is not a business Context. Field naming, Lifecycle inheritance, Query
Projection and per-Span fields: [Schema dictionary](./reference/schema-reference.md).

## 5. Integration

### 5.1 Typed Writer

Business code depends on the narrow interfaces in `@zcode/contracts/telemetry`. Each Writer Setter maps to
one explicit fact; the Writer owns Attribute Key, validation, sanitizing, Event, Metric and external
compatibility alias.

```ts
const step = runtimeTelemetry.step({ stepId: assistantMessageId, stepIndex });

return step.run(async () => {
  try {
    const result = await executeStep();
    step.finishCompleted(result === "continue" ? "tool_requested" : "turn_completed");
    return result;
  } catch (error) {
    if (signal.aborted) {
      step.finishCancelled("abort_signal");
    } else {
      step.finishFailed("unhandled", "unknown", error);
    }
    throw error;
  }
});
```

`run()` puts the current Span into the OTel Context so Spans created inside automatically become Children,
and handles uncaught exceptions and missed terminals. Normal business branches still call the
semantically exact `finish*()`.

### 5.2 Terminal handling and exception isolation

`try/catch` records known business terminals (user cancel, permission denial, parse failure); `run()`
handles uncaught exceptions and `missing_terminal`. Writers use an exactly-once Terminal Latch: only the
first `finishCompleted/Failed/Cancelled/...` takes effect, later calls are ignored; the Latch closes
before calling the OTel SDK and Metric so observation-layer exceptions cannot cause duplicate terminals.

### 5.3 Tool and Command

```ts
const tool = telemetry.startTool({ registeredToolName: toolCall.name, toolCallId: toolCall.id });

return tool.run(async () => {
  tool.markPermissionRequested();
  const decision = await requestPermission();
  tool.setPermissionDecision(decision);

  if (decision === "denied") {
    tool.finishDenied("user_denied");
    return deniedResult;
  }

  const result = await executeTool(tool);
  tool.setOutputBytes(result.outputBytes);
  tool.setOutputTruncated(result.truncated);
  tool.finishCompleted();
  return result;
});
```

A Command Child is created only when the Tool really starts an OS command:

```ts
const command = tool.startCommand({
  category: "git",
  commandCount: 1,
  safeName: "git.status",
  sandboxed: true,
  shellKind: "bash",
});

return command.run(async () => {
  const result = await spawnProcess();
  command.setExitCode(result.exitCode);
  command.setOutputBytes(result.outputBytes);
  command.finishCompleted();
  return result;
});
```

`safeName` is a controlled command family, not a full command; args, paths, scripts and environment
variables are never reported.

### 5.4 Model Call and Attempt

Call sites declare only the business purpose of a model call; the Provider Adapter and status recorder
fill in real request facts. Callers must not hand-fill UID, Session, Provider Origin, actual Model,
Token, Cache, HTTP error or TTFT.

```text
model_call(operation=agent_step, logical_call_id=L1)
+-- model_attempt(request_id=R1, attempt_number=1) -> failed 429
`-- model_attempt(request_id=R2, attempt_number=2) -> completed
```

`ModelApiTelemetryStatusSink` listens to the unified Model Status Event and calls in turn
`call.startAttempt(...)`, `attempt.setHttpStatusCode(429)`, `attempt.setProviderErrorCode("rate_limit")`,
`attempt.setProviderErrorMessage(providerMessage)`, `attempt.markFirstProviderEvent()`,
`attempt.markFirstContent()`, `attempt.setInputTokens(inputTokens)`,
`attempt.setCacheReadTokens(cacheReadTokens)`, `attempt.finishCompleted()`, `call.finishCompleted()`.
Provider, Endpoint, Model, Reasoning and Usage are written from the real request/response of the API
wrapper layer. Fields: [Model Span dictionary](./reference/schema-reference.md#11-model_call).

### 5.5 Independent operations and all LLM entries

Out-of-Turn model work must first create a `detached_operation` so the inner `model_call` becomes its
Child. `operation` is a controlled enum, currently: `goal_completion_verification`,
`goal_title_generation`, `project_memory_extract`, `project_memory_dream`, `project_memory_recall`,
`read_session_context_extract`, `read_session_context_synthesize`, `session_title_generation`,
`tool_internal_model_call`, `web_fetch_processing`, `web_search`, `workspace_git_commit_message`,
`workspace_generate_text`. `agent_step` and `context_compaction` are carried by their own Spans and are
not wrapped in `detached_operation`. A new LLM entry must first pick an existing operation; add an enum
value only when both execution semantics and statistic dimensions differ. Definitions and call entries:
[Operation catalog](./reference/schema-reference.md#101-operation-catalog).

## 6. Extension process

### 6.1 New Span

Needs independent duration/result/error/subtree? No -> Attribute or Event. Yes -> can an existing Span
express it? Yes -> add the necessary Setter to the existing Writer; No -> add a stable Span Name + Typed
Writer. A new Span must also: (1) define start and end boundaries; (2) define Parent or Root + Link; (3)
add a dedicated Start type and Writer in Contracts; (4) write canonical `zcode.<span_name>.*` Keys
explicitly in Runtime; (5) define outcomes, failure stages, events and privacy; (6) update the
[Schema dictionary](./reference/schema-reference.md); (7) add topology, terminal, exception-isolation,
privacy and Metric tests.

### 6.2 New field

State: does it belong to Resource, execution projection, Lifecycle or one Span? Where is the raw fact
first determined? Type, unit, allowed values, missing semantics? Does it contain identity, content, path,
URL, credentials or free text? Will it be a Metric Label (is cardinality bounded)? Is a GenAI/OTel
compatibility alias needed and is the conversion lossless? Then add a semantically clear Setter to the
concrete Writer. Business interfaces must not expose `setAttribute(key, value)` nor introduce a runtime
Schema Registry or second mapping layer.

### 6.3 New Event

An Event is an instantaneous milestone with diagnostic value, exposed through a concrete method such as
`markFirstContent()`; define dedup and count cap; never one Event per Streaming Chunk.

### 6.4 New Metric

Define denominator, Instrument, Unit, Bucket and Label. Only low-cardinality Labels; Session ID, Request
ID, Endpoint, error message, installation ID and user ID must never be Labels. Metric is not derived from
ARMS Trace query results; the Writer records it directly when the fact is determined.

## 7. Privacy and performance constraints

### 7.1 Allowed data

Stable enums, counts, durations, Tokens, HTTP status; controlled Registry Tool Name and command-family
Safe Name; Provider/Model runtime facts; sanitized Provider Origin and Route; sanitized, truncated error
type, code and message; product-generated installation pseudonym ID, controlled user subject ID and
execution correlation IDs. The installation ID is a persistent random pseudonym (not a hardware ID, not
risk-free anonymous data). The user ID is currently recorded as the controlled subject ID verbatim with no
extra Hash; both are for Trace queries only and never Metric Labels.

### 7.2 Forbidden data

```text
Prompt / Message / Reasoning body
Tool input/output / file content / Patch
Full Command / args / cwd / environment variables
HTTP Header / Body / Cookie / Authorization
URL Query / Fragment / username / password
OTLP License Key or other Secret
```

Endpoint sanitizing removes username, password, Query and Fragment and replaces email, UUID, long numbers,
long hashes and token-like Path segments with placeholders; the result is cached boundedly by
`(providerKind, baseURL)`. Error messages are bounded-truncated first, then credentials, emails, common
local paths and sensitive URL parts are removed.

### 7.3 Hot path

Setters do constant-time work on small objects only: no synchronous file/network I/O, no Prompt traversal,
no large JSON serialization, no per-Chunk reporting. Spans export asynchronously, batched, Gzip via
BatchSpanProcessor. At 5000 active Writers per process new Spans are bypassed and Telemetry Health is
recorded without blocking the Agent. Sanitizing algorithms, export budget, capacity caps and degradation:
[Runtime reference](./reference/runtime-and-operations.md#7-performance-capacity-and-reliability).

## 8. ARMS queries

Trace is queried in ARMS application monitoring / trace analysis, not in RUM dashboards. Base filter:

```text
serviceName : zcode-cli-agent
and resources.zcode.telemetry.schema_version : 5
```

```text
# All Turns
spanName : agent_turn

# Failed physical model requests
spanName : model_attempt
and attributes.zcode.model_attempt.outcome : failed

# Key nodes of one Turn
attributes.zcode.execution.turn_id : <turn-id>

# Model requests of one installation
spanName : model_attempt
and resources.zcode.device.installation_id : <installation-id>

# All Retry Attempts of one logical call
attributes.zcode.execution.logical_call_id : <logical-call-id>
```

Error queries: HTTP 429/500 `attributes.zcode.model_attempt.http_status_code`; Provider raw error code
`...provider_error_code`; sanitized Provider raw error message `...provider_error_message`; the Error that
terminated the Attempt (usually a Transport/SDK exception) `...error_message`; request address
`provider_origin` and `provider_route` (not the raw URL). Accurate success rate, QPS, Token and P95/P99
prefer OTLP Metrics; Trace locates concrete samples. Saved Query, Dashboard and formulas:
[ARMS reference](./reference/runtime-and-operations.md#9-arms-queries-dashboards-and-metric-definitions).

## 9. Responsibilities of docs, code and tests

Core spec = data model + principles + integration + system boundary; reference = OTel concepts + full
field dictionary + Runtime/ops detail; TypeScript Contracts/Writers = compilable signatures, enums and
Attribute writes; Tests = executable proof of topology, fields, terminals, sanitizing, compatibility
projection and export.

Code locations under `apps/zcode-cli/packages/`: Contracts `contracts/src/telemetry/`; Writer Runtime
`telemetry/src/agent-trace-runtime.ts`; Context and terminal base `telemetry/src/agent-trace-support.ts`;
Model Status to Writer `telemetry/src/model-api-recorder.ts`; Compatibility Adapter
`telemetry/src/compatibility-adapters.ts`; Metric `telemetry/src/agent-metrics.ts`; OTLP Owner/Exporter
`telemetry/src/otlp-exporter.ts`; business Facade `core/src/telemetry/runtime-telemetry.ts`.

Maintenance rules:

1. Any change to Span, Attribute, Event, Metric, enum, privacy or statistic definition updates the field
   dictionary in the same change; field semantics must not live only in code.
2. A change to overall principles, integration interface or boundary also updates this document;
   field-level detail updates only the matching reference.
3. Migration processes and review records move to `archive/` when done and never sit beside the current
   spec.
4. Breaking a field, type, unit, terminal or topology upgrades the Telemetry Schema Version; product and
   CLI versions evolve independently.
5. Run related tests, `pnpm typecheck` and `pnpm lint` before submitting.

## 10. Version axes

| Meaning                        | Field                            | Current source                                            |
| ------------------------------ | -------------------------------- | --------------------------------------------------------- |
| CLI Telemetry producer version | `service.version`                | Injected at build from `apps/zcode-cli/package.json`      |
| Desktop/product version        | `zcode.product.version`          | Product build metadata; no hardcoded version in docs/code |
| Data contract version          | `zcode.telemetry.schema_version` | Contracts constant, currently 5                           |
| Exact build identity           | `zcode.build.commit_id`          | Trusted CI/Git build metadata                             |

Reports comparing release effects must keep Schema Version, CLI Version, Product Version and Build Commit
together and never treat them as one version field.
