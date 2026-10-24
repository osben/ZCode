# CLI Agent Execution Trace: Topology, Schema and Instrumentation Interface

> Status: historical V2 design, kept for traceability only. The current implementation and
> development constraints are in the [CLI Agent Telemetry final spec](../cli-agent-telemetry.md).
>
> This was the v2 main spec for CLI Agent observability. The
> [Model API observability](./model-api-observability-v1.md) v1 kept running; `Model Call` /
> `Model Attempt` were not deprecated but became child nodes of the new execution Trace.
>
> Full history: `git show b8876e8b:docs/trace/archive/turn-trace-observability-v2.md`

## 1. Review summary

Business code declares only (1) what it is doing, e.g. `context.compaction`, and (2) the business
semantics it ended with, e.g. a Step discarded by recovery. It never fills uid / device / app version,
sessionId / queryId / turnId / stepIndex / parentSpanId, provider / baseURL / model / transport /
thinking, token / cache / retry / duration, or error code / message / HTTP status. Scope, Adapter,
Recorder and the Error Sanitizer produce those automatically.

```text
AgentTelemetryRuntime
├── Scope: Turn / Step / Tool / Compaction / Detached Operation
├── Model Recorder: Logical Call / Physical Attempt
├── Schema Registry: Operation / Outcome / Error / specific fields
├── AsyncLocalStorage: in-process parent/child context
└── OTel Backend: BatchSpanProcessor -> OTLP -> ARMS
```

Key decisions:

1. One real Agent Turn is one Trace; a Session is not a long Trace.
2. Step, Tool, Compaction are Spans inside the Turn.
3. Subagent, async Sidecar and out-of-Turn model entries are independent Traces related by Link.
4. No arbitrary `track(name, properties)`.
5. OTel Span, ARMS SDK and Parent ID never enter the business interface.
6. No Span per Chunk, Delta, Token or Tool Progress.

### 1.1 Implementation state (at V2)

Done:

- `Turn -> Step -> Tool/Compaction -> Model Call -> Model Attempt` use real OTel Parent/Child.
- Session/Goal title, Goal completion verification and Workspace Generate Text use independent Roots;
  Subagent/Workflow Child Turns use a Link captured at spawn; Detached Operations started inside an
  active Scope also carry a Link; cross-Turn historical Links await the P1 Link Cache.
- The App can inject `TelemetryRuntime`/`AgentExecutionTelemetryPort`; Standalone CLI creates one
  `TracerProvider + BatchSpanProcessor` itself when OTLP env vars exist.
- Session, Turn, Query, Actor, Step Index, Provider, Model, Thinking, Token, Cache, Retry, duration and
  error are filled by Facade, Adapter and Recorder.
- Model v1 Records are kept and hang under the v2 execution Trace via real OTel Parent; SQLite Usage
  Observability is untouched.
- Error messages are centrally sanitized and truncated; Error code, Provider code/message, HTTP status,
  error phase and fingerprint still go to the Model Span.
- Active Span, Active Turn and Record Queue have hard caps; Active Span has a 30-minute idle TTL; each
  Turn keeps at most 200 Step/Tool/Compaction detail Spans and overflow is summarized on the Root.
- A Model Call captures its parent Scope at start, so a terminal outside the original ALS context
  still updates the right Turn/Step/Tool summary and never a concurrent call's.
- A new child Scope or explicit causation first refreshes the current ancestors' activity time, then
  sweeps other TTL-expired Spans, so resuming after a long pause (e.g. a permission wait) never closes a
  still-active Turn as `abandoned`.
- Export failures are side-path and never affect the Agent.

Not done at V2: ARMS dashboards, alert rules and production sampling; the 30-minute Link Cache and
enabled/disabled CPU, RSS and network-byte baselines; out-of-CLI model entries (Repo Wiki, model
connectivity test); background Bash (the Tool Span means "background task started successfully", final
duration/exit remain in `BackgroundTask*` events with no linked Span, so `commandStatus=backgrounded`
must not be read as final success); `ReadSessionContext` and `WebFetch` in-tool model requests reach the
ARMS Trace but not local `model_usage` (local SQLite is not a complete ledger for them); legacy
RUM/local SQLite paths still upload or persist raw error text (this round only guarantees the new Agent
Trace never copies raw Tool errors; error classification, sanitizing, length and retention for the
legacy paths need separate unification).

### 1.2 2026-07-27 completeness and privacy hardening

Execution chain tree (Tool Span records "tool framework execution"; Bash subprocess state is a
Tool-specific field; the two are never merged into one success rate):

```text
Agent Turn
├── Agent Step
│   ├── Model Call
│   │   └── Model Attempt 1..N
│   └── Tool
│       ├── framework result: completed / failed / denied / cancelled / abandoned
│       ├── performance: permission / command / filesystem / serialization
│       ├── Bash command result: completed / failed / timed_out / cancelled /
│       │                        spawn_error / backgrounded
│       └── in-Tool Model Call (WebSearch / WebFetch / ReadSessionContext)
├── Context Compaction
│   └── Model Call -> Model Attempt 1..N
└── Turn summary: step / model / tool / compaction / token / cache / retry

Detached Operation (title, Goal verification, Workspace Generate)
└── independent Root -- Link --> triggering Turn/Tool
```

Boundaries to keep:

1. All registered tools are counted by canonical Registry tool name (count, duration, framework
   result); unregistered/unresolvable names go to one `unknown` bucket (no high cardinality or user
   content).
2. Bash additionally records a safe executable name, command category, command count, subprocess
   status, exit code and duration. Executable names come only from the built-in public command
   Registry; custom scripts, dynamic expressions and unknown commands are `other`; compound commands
   are `compound`.
3. ARMS never receives raw Bash command, args, cwd, stdout/stderr, Tool Input/Output or `commandHash`
   (`commandHash` is a local diagnostic field, not a remote dimension).
4. Raw Tool error text is not uploaded by default; only stable error type, code, phase and sanitized
   fingerprint. Model API errors may upload a centrally sanitized, single-line, truncated message for
   Provider troubleshooting. Local SQLite `tool_usage.error_message` is a historical capability; no new
   or wider raw error persistence (local retention, sanitizing and migration need a separate design).
5. Trace, RUM and local Usage Store are side paths: export/persist failure logs a controlled warning and
   never interrupts Tool Result persistence, model continuation or the Turn.
6. Turn summaries distinguish model failed/cancelled and tool failed/denied/cancelled, not only totals.
7. On shutdown, 30-minute idle TTL or active-call capacity eviction, the Model Recorder closes any
   Logical Call / Physical Attempt lacking a terminal as `abandoned` with `terminal_missing=true` and a
   controlled reason (incomplete observation lifecycle, not counted in Provider error rate).
8. Standalone Telemetry shutdown closes in order `Model -> Tool/Step/Turn -> Queue -> Exporter`; still
   active Agent Spans are marked `abandoned` deepest first. `abandoned` keeps OTel Status `UNSET` and is
   counted separately from business failure.
9. All string Attributes have a uniform length cap before export.
10. Host-injected `ZCODE_TELEMETRY_USER_SUBJECT_ID` is used as `user_subject_id` only if it satisfies the
    controlled ID constraint; the old `ZCODE_TELEMETRY_USER_ID_HASH` is deprecated and stripped at the
    child-process env boundary. The Desktop Host produces a stable pseudonymous SHA-256 identifier: a
    correlation key, not an anonymization promise. `deviceMid` must be bounded with no whitespace or
    path separators, otherwise device correlation is dropped.
11. Error text sanitizing covers URL, Header, email, IP, local paths, common bare credential prefixes and
    the ARMS LicenseKey shape; error text not provably safe must not enter a Tool Span.
12. Provider Base URL parse input, sanitized route and LRU cache have hard caps; URL
    userinfo/query/fragment never enter the Trace. Numeric Attributes accept finite values only.

Performance principle: reuse the non-enumerable `perf` metadata tools already produce; the Trace
wrapper reads a small object and maps fixed fields, never rescans Output, copies commands/outputs or
flushes on the calling thread. The Bash safe command name is resolved once in the existing performance
attribution stage; commands over 8 KiB skip the parser, degrade to `other` and omit `commandCount`;
parse failure or dynamic commands degrade to a low-cardinality bucket.

## 2. LLM chain scope

### 2.1 Inside the CLI

| Entry                            | Scope               | v2 Operation                           | Model Call parent |
| -------------------------------- | ------------------- | -------------------------------------- | ----------------- |
| Main/Subagent/Workflow model Step | own Turn           | `agent.step`                           | Step              |
| Auto/manual/reactive Compact     | Turn                | `context.compaction`                   | Compaction        |
| WebSearch                        | Tool                | `tool.web_search`                      | Tool              |
| WebFetch content processing      | Tool                | `tool.web_fetch.process`               | Tool              |
| ReadSessionContext extract       | Tool                | `tool.read_session_context.extract`    | Tool              |
| ReadSessionContext synthesize    | Tool                | `tool.read_session_context.synthesize` | Tool              |
| Session title                    | async Sidecar       | `session.title_generation`             | Root + Link       |
| Goal title                       | async Sidecar       | `goal.title_generation`                | Root + Link       |
| Goal completion verification     | blocking pre-Turn   | `goal.completion_verification`         | Root + Link       |
| Git Commit Message               | Workspace operation | `workspace.git_commit_message`         | Root              |
| `workspace/generateText`         | Workspace operation | controlled Purpose mapping             | Root              |

`workspace/generateText` is an explicit out-of-Turn protocol entry; it should migrate from an arbitrary
`querySource` to a controlled `purpose` mapped to an Operation by the CLI. All CLI production model
calls go through `AiSdkModelAdapter`. Classification priority: explicit Operation -> current Scope
default Operation -> legacy `querySource` Registry -> `other` + unclassified health counter (so a
missed classification stays visible and `other` must be alertable).

### 2.2 Known gaps outside the CLI

| Traffic               | Fact                                      | Decision                                      |
| --------------------- | ----------------------------------------- | --------------------------------------------- |
| Repo Wiki             | `packages/services` calls Provider directly | P1: move into CLI ModelPort or the same Port |
| Model connectivity test | Host sends a real small request         | Separate `admin.model_probe`, not in Agent SLO |
| `stream-animate`      | Standalone experimental package           | Not part of ZCode Agent production Trace      |

P0 completion means "all CLI Agent LLM traffic", not all product LLM traffic.

## 3. Trace topology

### 3.1 Turn tree

```text
invoke_agent zcode                         Root / INTERNAL
├── zcode.agent.step                       Step 0 / INTERNAL
│   ├── zcode.model.call                   Logical Call / INTERNAL
│   │   ├── chat <model>                   Attempt 1 / CLIENT / error
│   │   └── chat <model>                   Attempt 2 / CLIENT / ok
│   ├── execute_tool Read                  Tool / INTERNAL
│   └── execute_tool WebFetch              Tool / INTERNAL
│       └── zcode.model.call
│           └── chat <model>
├── zcode.context.compaction               INTERNAL
│   ├── zcode.model.call                   SSE Call / error
│   │   └── chat <model>
│   └── zcode.model.call                   HTTP Fallback / ok
│       └── chat <model>
└── zcode.agent.step                       Step 1
```

Turn uses GenAI `invoke_agent`; Tool uses `execute_tool`; only the Physical Attempt is a remote `CLIENT`
Span; the Logical Call aggregates SDK Retry and is `INTERNAL`. `zcode.span.type` is the stable query
field; dashboards need not parse Span names.

### 3.2 Authoritative boundaries

```text
command accepted  (queueWaitMs is only an attribute)
  -> active turn reserved + turnId allocated
  -> START Turn: context init / hooks, compaction, step 0..N
  -> TurnComplete / TurnError / cancel -> END Turn
```

The Turn must cover init failures before the first model request. Step starts once
`assistantMessageId` is allocated and ends when model, tools and recovery decision end
(`START Step -> Model Call -> zero or more sibling Tools -> completed / discarded / cancelled / failed`).
`stepId = assistantMessageId`; `stepIndex` is allocated strictly increasing by the Turn Scope, never
derived from `iteration`, Tool count or logs.

### 3.3 Parent policy

| New node           | Parent                                               |
| ------------------ | ---------------------------------------------------- |
| Step               | nearest Turn                                         |
| Tool               | nearest Step; falls back to Turn marked degraded     |
| Compaction         | nearest Turn, skipping Step/Tool                     |
| Model Call         | Tool > Detached Operation > Compaction > Step > Turn |
| Attempt            | the Logical Call that created it                     |
| Detached Operation | Root, explicit Link only                             |
| Child Turn         | Root, Link captured at spawn only                    |

Reactive Compaction triggered on the Step error stack still hangs under the Turn; causality uses
`triggeringStepIndex` / `recoveredFromLogicalCallId`, not a wrong Parent.

### 3.4 Link

Parent Turn -> Link -> Child Agent Turn (via `execute_tool Agent`); Parent Turn -> Link -> Session
Title; Previous Turn -> Link -> Goal Verification -> Link -> Continuation Turn. Reasons: Background
Child may outlive the Parent Turn; titles are fire-and-forget; Goal Verification precedes the next
Turn; Foreground/Background Child share one topology. A Link is supplied when the target Span is
created; across Runtimes only an immutable serializable `TelemetryLink` is passed, never an Active
Scope or Span Handle.

## 4. Schema

### 4.1 Location and layering

```text
apps/zcode-cli/packages/contracts/src/telemetry/
├── agent-execution.ts     v2 Operation, Context, Link, Scopes, narrow Port
└── index.ts               existing v1 Model Call/Attempt and unified exports
```

`@zcode/telemetry` holds only Scope, Recorder, OTel mapping and Exporter implementations. Core/Adapter
depend on Contracts only (no OTel/ARMS imports). The v2 schema is kept in `agent-execution.ts` for now;
when Model v1 migrates to v2 naming it splits mechanically into `common/operations/model-api/ports` while
keeping `@zcode/contracts/telemetry` as the single entry. Four composed layers, no giant Optional
interface: Resource Context -> Execution Context -> Span Record Base -> Turn / Step / Tool / Compaction
/ Operation / Model Call / Attempt.

```ts
interface TelemetryResourceContext {
  serviceName: string;
  serviceVersion?: string;
  deploymentEnvironment?: string;
  runtimeSurface: RuntimeSurface;
  identity: {
    state: "authenticated" | "anonymous" | "unavailable";
    userIdHash?: string;
    deviceMid?: string;
  };
}

interface ExecutionContextSnapshot {
  executionTraceId?: string; // existing CLI/log ID, not the OTel TraceId
  queryId?: string;
  sessionId?: string;
  parentSessionId?: string;
  turnId?: string;
  stepId?: string;
  toolCallId?: string;
  actor: { kind: ActorKind; agentName?: string };
}

interface TelemetrySpanRecordBase<TType, TOutcome> {
  schemaVersion: "2";
  recordId: string;
  type: TType;
  context: ExecutionContextSnapshot;
  operation: OperationName;
  timing: { startedAt: string; endedAt: string; durationMs: number };
  outcome: TOutcome;
  error?: SanitizedTelemetryError;
}
```

Resource is injected by the Backend as the OTel Resource; business code does not construct it.

### 4.2 Field ownership

| Field                     | Producer                              | Business behavior         |
| ------------------------- | ------------------------------------- | ------------------------- |
| Operation                 | Registry / call intent                | picks a constant          |
| Actor                     | Scope                                 | none                      |
| Session/Turn/Step/Tool ID | Scope from domain objects             | none                      |
| OTel Trace/Span/Parent    | Backend                               | invisible                 |
| `stepIndex`               | Turn Scope counter                    | none                      |
| Provider/Model/Endpoint   | Adapter's final resolved result       | none                      |
| Thinking                  | Model Catalog + final Provider Options | none                     |
| Token/Cache/Finish        | Adapter Normalization                 | none                      |
| Retry/Transport/TTFT      | Model Runner                          | none                      |
| Duration                  | Scope/Recorder                        | none                      |
| Outcome                   | authoritative lifecycle boundary      | picks a legal terminal    |
| Error                     | Normalizer/Sanitizer                  | passes raw `unknown` only |
| Child summary             | Scope Registry                        | none                      |

Any API asking business code to fill `modelId`, `turnId` or `durationMs` is a design failure.

Inheritance: Resource -> all in-process Spans (Bootstrap only). Turn Execution Context -> Step, Tool,
Compaction, Model (snapshot of the current CLI `TraceContext`, never written back). Step/Tool identity
-> their own children (extracted by the Facade; inner calls cannot rewrite). Actor -> whole Agent Turn
tree (a Child Agent creates its own Actor). Operation -> Model Calls in the current Scope (an explicit
controlled Intent may override; not inherited across Detached/Child Turns). Provider/Model/Thinking ->
current Model Call/Attempt only (always the Adapter's final actual value). Error/Outcome -> current node
(Child Error never rewrites Parent Outcome).

### 4.3 Operation, Execution Kind, Actor are separate

- `zcode.operation.name`: ZCode business purpose such as `context.compaction`.
- `gen_ai.operation.name`: `invoke_agent`, `execute_tool`, `chat`.
- `zcode.execution.kind`: `turn|step|tool|sidecar|standalone_blocking|standalone`.
- `zcode.actor.kind`: `main_agent|subagent|workflow_child|system|tool`.

```ts
export const Operation = {
  AgentStep: "agent.step",
  ContextCompaction: "context.compaction",
  SessionTitleGeneration: "session.title_generation",
  GoalTitleGeneration: "goal.title_generation",
  GoalCompletionVerification: "goal.completion_verification",
  WorkspaceGitCommitMessage: "workspace.git_commit_message",
  ToolWebSearch: "tool.web_search",
  ToolWebFetchProcess: "tool.web_fetch.process",
  ToolReadSessionContextExtract: "tool.read_session_context.extract",
  ToolReadSessionContextSynthesize: "tool.read_session_context.synthesize",
  WorkspaceGenerateText: "workspace.generate_text",
  Other: "other",
} as const;
```

Migration from v1: `sidecar.session_title` -> `session.title_generation`; `sidecar.goal_title` ->
`goal.title_generation`; `sidecar.goal_verification` -> `goal.completion_verification`;
`sidecar.git_commit_message` -> `workspace.git_commit_message`; `tool.web_fetch` ->
`tool.web_fetch.process`. The Exporter may dual-write the old `zcode.operation` during a compatibility
window; business code uses v2 only.

### 4.4 Operation-specific fields

No arbitrary `attributes` Map; use a generic map:

```ts
interface OperationDetailMap {
  "agent.step": Record<string, never>;
  "context.compaction": {
    trigger: "manual" | "auto" | "partial" | "reactive" | "session_memory";
    phase: "standalone_turn" | "pre_request" | "mid_turn" | "reactive";
    outerAttempt: number;
    maxAttempts: number;
    triggeringStepIndex?: number;
    recoveredFromLogicalCallId?: string;
  };
  "session.title_generation": { trigger: "first_user_input" | "external_input" };
  "goal.title_generation": { targetId: string };
  "goal.completion_verification": { targetId: string; goalIteration: number };
  "workspace.git_commit_message": Record<string, never>;
  "workspace.generate_text": Record<string, never>;
  "tool.web_search": Record<string, never>;
  "tool.web_fetch.process": Record<string, never>;
  "tool.read_session_context.extract": { chunkIndex?: number };
  "tool.read_session_context.synthesize": { chunkCount?: number };
  other: { legacyQuerySource?: string };
}

startOperation<O extends OperationName>(operation: O, details: OperationDetailMap[O]): OperationScope<O>;
```

### 4.5 Outcome and Error

```ts
type TurnOutcome = "success" | "failed" | "cancelled" | "abandoned";
type StepOutcome = "completed" | "discarded" | "failed" | "cancelled" | "abandoned";
type ToolOutcome = "completed" | "failed" | "denied" | "cancelled" | "abandoned";
type CompactionOutcome = "completed" | "failed" | "cancelled" | "abandoned";
type ModelOutcome = "completed" | "error" | "cancelled" | "abandoned";
type CancellationReason = "user" | "abort_signal" | "timeout" | "shutdown" | "superseded";
```

| Outcome                              | OTel Status |
| ------------------------------------ | ----------- |
| `success` / `completed`              | `OK`        |
| `failed` / `error` / `discarded`     | `ERROR`     |
| `cancelled` / `denied` / `abandoned` | `UNSET`     |

Child Error never pollutes the Turn; the Turn follows only its authoritative terminal.

```ts
interface SanitizedTelemetryError<TPhase extends string = string> {
  code?: string; // stable low-cardinality ZCode code
  type: string; // Exception / normalized type
  message?: string; // sanitized, truncated ops information
  phase?: TPhase;
  retryable?: boolean;
  fingerprint?: string;
}
```

Phases narrow per node and all include `unhandled` as the wrapper fallback:

```text
Turn:  context_init | hook | compaction | step | finalize | unhandled
Tool:  lookup | validation | hook | permission | execute | serialize | unhandled
Model: prepare | connect | response | stream | parse | postprocess | unhandled
```

Model also carries an independent `providerError` (Provider code/message, HTTP status, request ID,
retry-after). Callers pass only a raw `unknown`; the central Sanitizer removes credentials, Headers, URL
query and obvious paths and limits length. Stack, Prompt, Response, Tool Input/Output are not reported.

### 4.6 Node fields

Turn: P0 `number / inputSource / resultType`; `stepCount / modelCallCount / modelAttemptCount /
toolCallCount`; `modelErrorCount / modelCancelledCount`; `toolErrorCount / toolDeniedCount /
toolCancelledCount`; `compactionCount / retryRecoveredCount`; `inputTokens / outputTokens /
reasoningTokens / cacheReadTokens / cacheWriteTokens`. P1: `queueWaitMs / primaryProvider / primaryModel
/ primaryThoughtLevel / overflowChildCount`. Root summaries accumulate automatically from Children;
`primaryModel` is the first `agent.step`'s actual model only.

Step: P0 `stepId / stepIndex / terminalReason`, model/attempt/tool/tool-error counts, token totals. P1
`finishReason / outputBytes`.

Tool: common `callId / name / outcome / outputBytes / outputTruncated / totalMs / permissionWaitMs`.
Command detail: `runMs / firstOutputMs / noOutputMs / exitCode / timedOut / outputBytes / commandName /
commandCategory / commandCount / status`. Filesystem detail: `readMs / writeMs / fileCount / totalBytes /
maxFileBytes / workspaceKind`. Patch detail: `matchMs / hunkCount / matchAttempts` (plus Filesystem
detail). P1 `permissionDecision`.

Domain types use "common lifecycle fields + discriminated detail", not a flat all-optional perf bag:
`ToolExecutionTelemetry { totalMs, permissionWaitMs, detail? (command { command } | filesystem {
filesystem } | patch { filesystem, patch }) }`. `exitCode` belongs only to Command detail (Read/Write
cannot set it at the type level); remotely only `zcode.tool.command.exit_code` exists, no generic
`zcode.tool.exit_code`.

Tool outcome and Command status are separate semantics: when a Tool handler returns a structured
`BashOutput` normally, Tool outcome is `completed` even if Bash exits non-zero (Command status `failed`).
Framework reliability uses `zcode.outcome`; Bash subprocess reliability uses
`zcode.tool.command.status`; the exit-code distribution denominator contains only calls with a known
`command.exitCode`; a non-zero exit must never be rewritten as a Tool Span Error to make the two
success-rate charts agree.

Model Call = one `generateText`/`streamText` (may contain several Adapter Retries); Attempt = one real
Provider HTTP/SSE request. Call-specific: `logicalCallId / callCause / previousLogicalCallId /
attemptCount / hadError / recoveredAfterRetry`. Attempt-specific: `requestId / providerRequestId /
attemptNumber / maxAttempts / attemptCause / previousRequestId / retryDelayMs / retryAfterMs / TTFT /
streamIdle / streamStall`. Both reuse stable v1 facts: `providerId / providerKind / providerOrigin /
providerRoute / providerEndpointFingerprint / requestedModel / responseModel / reasoning / transport /
streaming / inputTokens / outputTokens / reasoningTokens / cacheReadTokens / cacheWriteTokens /
cacheObservation`. `reasoning` is the strict structure `capability / state / controlType /
requestedLevel / effectiveLevel / effectiveBudgetTokens` (no vendor-native `thinking` naming; the Adapter
parses final Provider Options). `providerId` identifies the user-configured Provider instance,
`providerKind` the protocol/vendor type; `providerRoute` is the sanitized Base URL path (query never
kept). Endpoint sanitizing, caching and SHA-256 fingerprint reuse the v1 implementation. `rid` maps only
the Physical `requestId`, never Turn/Step.

### 4.7 Field naming

Internal TypeScript uses camelCase with explicit `Id / Ms / Bytes / Tokens` suffixes and nested domain
objects; only the Exporter maps external names.

Standard: `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`,
`gen_ai.response.model`, `gen_ai.conversation.id`, `gen_ai.agent.name`, `gen_ai.tool.name`,
`gen_ai.tool.call.id`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
`gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.reasoning.output_tokens`, `server.address`,
`error.type`, `error.message`.

ZCode extensions: `zcode.telemetry.schema_version`, `zcode.span.type`, `zcode.operation.name`,
`zcode.execution.kind`, `zcode.actor.kind`, `zcode.session_id`, `zcode.turn_id`,
`zcode.agent.step_id`, `zcode.agent.step_index`, `zcode.model.logical_call_id`,
`zcode.model.provider.id`, `zcode.model.provider.route`, `zcode.error.code`, `zcode.error.phase`,
`zcode.tool.command.name`, `zcode.tool.command.category`, `zcode.tool.command.status`.

For compatibility with existing ARMS queries the Exporter may emit read-only aliases `uid = userIdHash`,
`sid = sessionId`, `rid = Physical Attempt requestId`, all produced by Resource, Scope or Model Runner
(no such business parameters). `userIdHash` is a pseudonymized cross-device correlation identifier, not
anonymous (low-entropy accounts can be dictionary-inferred); `deviceMid/sessionId/turnId/requestId` are
also linkable identifiers. They may be reported but depend on ARMS-side access control, retention and
audit, and must never be put into error messages or log bodies. Business code contains no `"zcode.*"`
strings; the Exporter uses an exhaustive-mapping test so OTel convention upgrades need no business
changes.

## 5. Instrumentation interface

### 5.1 Injection and context

Bootstrap creates one CLI-level Runtime injected through narrow Ports: AgentRuntime and ToolExecutor use
`AgentExecutionTelemetryPort`; `AiSdkModelAdapter` uses `ModelTelemetryPort`; all share one Scope Storage
and TracerProvider. The App injects only Endpoint, Headers, identity and version; Standalone CLI
self-initializes through the same Bootstrap.

Telemetry uses its own `AsyncLocalStorage<AgentTelemetryScopeContext>`, not an extension of the existing
`TraceContext` (used for logs, SessionEvent and protocol, may be copied or serialized; the OTel Scope
exists only in the current CLI process). Remote replay/snapshot/hydration carries no Active Span. Scope
Context holds only an opaque Scope Ref, Scope Kind, ancestors and default Model Operation; parallel Tools
each run in their own `scope.run()`.

Business code talks to a Facade, separate from the low-level Recorder Port:

```text
domain code -> RuntimeTelemetryFacade
     (reads sessionId/queryId/turnId from current TraceContext; extracts stepId/toolCallId from
      existing Message/ToolCall domain objects; maps domain results to legal Terminals)
  -> AgentExecutionTelemetryPort -> Scope / Recorder / OTel
```

Business code cannot import `AgentExecutionTelemetryPort`; only the Facade and Adapter integration
construct normalized IDs, parent refs and runtime facts.

### 5.2 Business Facade and internal Port

```ts
interface RuntimeTelemetryFacade {
  turn(): TurnScope;
  step(message: AssistantMessage): StepScope;
  tool(call: ExecutableToolCall): ToolScope;
  compaction(intent: CompactionIntent): CompactionScope;
  detached<O extends DetachedOperationName>(
    operation: O,
    details: OperationDetailMap[O],
    causation?: TelemetryLink,
  ): OperationScope<O>;
  captureLink(): TelemetryLink | undefined;
}

interface AgentExecutionTelemetryPort {
  startTurn(input: NormalizedAgentTurnStart): TurnScope;
  startStep(input: NormalizedAgentStepStart): StepScope;
  startTool(input: NormalizedToolStart): ToolScope;
  startCompaction(input: NormalizedOperationStart<"context.compaction">): CompactionScope;
  startDetachedOperation<O extends DetachedOperationName>(
    input: NormalizedDetachedOperationStart<O>,
  ): OperationScope<O>;
}

interface TelemetryScope<TTerminal, TErrorPhase extends string> {
  run<T>(fn: () => T): T;
  end(terminal: TTerminal): void;
  fail(error: unknown, phase: TErrorPhase): void;
  cancel(reason: CancellationReason): void;
  link(): TelemetryLink;
}
```

`AssistantMessage` and `ExecutableToolCall` are domain objects the call site already holds, not new
DTOs; business code cannot pass a free string as `stepId`/`toolCallId`. All terminal methods are
synchronous, non-throwing and idempotent: the first terminal wins; duplicates are ignored at P0 and
counted by a Health Counter at P1. `run()` establishes the ALS and on an unhandled exception calls
`fail(error, "unhandled")`; the domain layer still explicitly selects a legal Terminal on normal return.
A callback that returns normally with no terminal is marked `abandoned` first to avoid leaking an Active
Span (Health Counter at P1). Noop and Enabled implementations have identical call semantics.

### 5.3 Turn, Step, Tool

Each is wrapped as `const scope = telemetry.turn() | step(assistantMessage) | tool(canonicalToolCall)`
then `scope.run(async () => { ... scope.end(terminalFromResult(result)); return result; })`, with the
Turn and Tool wrappers catching errors, calling `scope.fail(error, phase)` (Tool: `scope.cancel
("abort_signal")` when `signal?.aborted`) and rethrowing. The Facade extracts `stepId`; `startStep` finds
the Turn and allocates `stepIndex`. No Turn Handle is put in `RegularTurnLoopState` or threaded through
Model/Tool parameters. Tool is wired once in the Executor with zero Handler changes; Permission,
Validation, Handler, Serialization and Post Hook all sit inside one Scope. The Executor boundary must
explicitly close exceptions and cancellation and rethrow business exceptions unchanged; `run()`'s
`fail("unhandled")` is only the last-resort defense and does not replace domain error-phase
classification.

### 5.4 Model Call Intent

With a unique default Operation in the current Scope nothing is written
(`modelPort.streamText({ model, messages, tools })`). For multiple LLM purposes inside a Tool, declare
only the purpose: `modelCall: { operation: Operation.ToolReadSessionContextExtract }`. The public
`ModelCallIntent` has no actorKind / IDs / parentKey / spanId, provider / model / thinking, or duration /
usage / error. Adapter Retry is fully automatic. Core-level Fallback uses a controlled Call Chain:
`const calls = modelTelemetry.createCallChain({ operation: Operation.ContextCompaction })`, then
`modelCall: calls.initial()` and `modelCall: calls.next({ cause: "transport_fallback", reason:
"pre_commit_stream_failure" })`. The Call Chain generates `logicalCallId` / `previousLogicalCallId`
(business never copies IDs); Cause/Reason are controlled enums and take no raw Provider message.

### 5.5 Detached Operation

The scheduling point captures a Link (`const causation = telemetry.captureLink()`), then inside the
scheduled task calls `telemetry.detached(Operation.SessionTitleGeneration, { trigger:
"first_user_input" }, causation)` and runs the body in `scope.run`. The Detached API always creates a
Root and never inherits the current ALS Parent (so fire-and-forget cannot accidentally hang under a
Turn). Subagent/Workflow likewise pass one `TelemetryLink` at the Spawn boundary.

### 5.6 Error-proofing

Operation typo -> constants + literal union; wrong specific fields -> `OperationDetailMap`; wrong Parent
-> fixed Parent Policy; missing UID/Session/Turn -> automatic Scope/Resource inheritance; Provider/Model
not matching the real request -> Adapter final value; missing Retry -> Runner Status auto Attempt; wrong
Duration -> Scope's own clock; Error leaks -> central Sanitizer; double end -> first terminal wins; new
LLM unclassified -> Scope -> legacy -> `other` alert; replay duplicate reporting -> only the executing
CLI holds the Runtime.

## 6. Runtime and export

v1 created short Model Traces when a Terminal Record arrived. v2 creates real Active Spans:
`scope.start -> tracer.startSpan -> registry[scopeRef] = Span + SpanContext + aggregates`;
`child.start -> resolve parent context -> tracer.startSpan(parentContext)`; `scope.end -> set typed
attributes/status -> span.end -> retain immutable SpanContext in a short Link Cache`. Parent is fixed at
Child creation, unaffected by the 5-second Batch or cross-Batch effects.

The Model Adapter resolves the current Scope at call start; existing `ModelNetworkStatusEvent` keeps
providing Attempt facts: `model_request_started` -> start Call (first) + Attempt; retry/failed -> end
Attempt error; next started -> next Attempt under the same Call; terminal -> end Attempt + Call and
update parent summaries.

Suggested limits: active turns 256, active spans 2000, idle TTL 30 min, completed Link cache 30 min,
detail children per turn 200. A missing Parent falls back to a legal ancestor; if still missing create an
Orphan Root with `zcode.telemetry.parent_resolution=orphan` and a Health Counter, never blocking
business. Production keeps one `TracerProvider + BatchSpanProcessor + OTLPTraceExporter` network Owner;
the existing custom Queue may stay during migration for Terminal Fact compatibility but no longer builds
parent/child relations (no double-layer Queue).

## 7. Performance, migration and acceptance

Hot path allows only ALS/Map lookup, clock, counters and in-memory Span operations; forbidden: network,
Flush, history scan, Payload copy, full JSON, repeated URL sanitizing, Stack Capture. Tool Trace maps
only the fixed whitelist fields of each `ToolExecutionTelemetry` detail; never flatten `commandHash`,
arbitrary `perf.*` extension fields or the whole object into Attributes (controls network size and
prevents later local-diagnostic fields from being uploaded accidentally). Span count grows with
Turn/Step/Tool/Compaction/Call/Attempt, not Token/Chunk; beyond 200 Detail Children keep Turn/Step, only
accumulate `overflowChildCount` and mark truncation.

Order: (1) Schema, Operation Registry, Scope/Memory/Noop Backend; (2) Turn/Step/Tool/Compaction + Model
Parent; (3) Title, Goal Verification, Workspace Purpose, Subagent/Workflow Link; (4) ARMS canary,
dashboards, reconciliation with the old chain; (5) Repo Wiki and `admin.model_probe`.

Must verify: full Turn -> Step -> Call -> Attempt parentage; parallel Tools are siblings and ALS does not
cross Scopes; Compaction skips Step and hangs under Turn; Detached has Link only, no Parent; Retry,
Fallback, Discard, Cancel and post-recovery Turn results correct; no known CLI LLM is `other`; Prompt,
Response and Tool Payload cannot enter Record types; ARMS Down/Queue full does not affect the Agent and
memory stays bounded; enabled/disabled CPU, RSS, gzip bytes and request count have real baselines.

## 8. Entry points and references

Under `apps/zcode-cli/packages/`: Turn `core/src/runtime/methods/turn.ts`; Step
`core/src/runtime/methods/turn-model-step.ts`; Tool `core/src/tool/executor/call-runner.ts`; Compaction
`core/src/runtime/methods/compact-active.ts`; Title `core/src/runtime/methods/title-generation-sidecar.ts`;
Goal Verification `core/src/runtime/methods/target-completion-verification.ts`; Workspace Generate
`core/src/runtime/methods/workspace-generate-text.ts`; Model Adapter `adapters/src/model/runner.ts`; Model
Status `adapters/src/model/runner-status.ts`; v1 Schema `contracts/src/telemetry/index.ts`; Agent v2
Schema `contracts/src/telemetry/agent-execution.ts`; Runtime Facade
`core/src/telemetry/runtime-telemetry.ts`; Agent Scope Runtime `telemetry/src/agent-trace-runtime.ts`;
Recorder `telemetry/src/model-api-recorder.ts`; Exporter `telemetry/src/otlp-exporter.ts`.

- OpenTelemetry Trace API: <https://opentelemetry.io/docs/specs/otel/trace/api/>
- OpenTelemetry GenAI Attributes: <https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/>
- OpenTelemetry GenAI spec repository: <https://github.com/open-telemetry/semantic-conventions-genai>
