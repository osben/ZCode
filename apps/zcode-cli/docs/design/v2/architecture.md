# ZCode CLI Architecture Design v2

## Document positioning

`architecture-v2` is a boundary document, not an interface-implementation document. It keeps the
valuable parts of v1 — module division, dependency direction, state principles, evolution order —
and deliberately omits premature code detail. Candidate variable, module, interface and event
names may appear, but not field lists, method signatures, full enums, protocol payloads, class
implementations, sample code or database structures: module boundaries for a coding-agent CLI
only stabilize after repeated feedback from implementers, testers and real user flows. The
architect defines direction, constraints, verification questions and feedback loops first.

This document:

- defines system layering and dependency direction;
- defines which capabilities must converge into infrastructure boundaries;
- defines what core may and may not depend on;
- marks which interfaces are candidate names only, not yet stable contracts;
- marks where detailed design must be driven by implementation feedback.

It does not contain TypeScript pseudocode, concrete fields/methods/parameters, a complete RPC
method table, final provider/tool/storage/sandbox schemas, or examples treated as decisions.

## 1. Overall Architecture

ZCode CLI is organized in four layers: `app/bootstrap`, `application/core`, `adapters/infra`,
`contracts/`.

### 1.1 Layer responsibilities

`contracts/` is the contract layer for all cross-boundary interaction: stable schemas, port
names, capability descriptions, event semantics, error types and permission metadata. It depends
on no business implementation, adapter, UI, provider SDK, filesystem, network or process
environment.

`core/` is the business state machine and scheduling layer: session, turn, agent loop, tool
lifecycle, permission, compact, rewind, subagent, mailbox, memory, hooks, mode. Core expresses
intent only; it never touches the external world directly.

`adapters/` is the external I/O implementation layer: filesystem, child processes, network,
SQLite, artifacts, providers, MCP, ZCode app-server, config loading, logging, metrics, sandbox.
Every adapter exposes its capability through contracts.

`bootstrap/` is the composition and entry layer: startup of CLI, TUI, server and SDK entries,
dependency assembly, rendering, exit codes, process boundaries. It is the only place allowed to
assemble core and adapters together.

### 1.2 Layer responsibilities in detail

- `contracts/src/`: `interfaces/` (ports), `events/`, `errors/`, `capabilities/`. No business
  logic or implementation detail.
- `core/src/`: `agent/` (AgentRuntime scheduler), `session/`, `tool/` (ToolSystem),
  `permission/` (PermissionService), `provider/`, `hooks/` (HookRunner), `subagent/`
  (SubagentRuntime + Mailbox), `state/` (Compact + Rewind), `memory/` (MemoryPipeline),
  `sandbox/` (SandboxPort). Business state machines, agent-loop driving, turn scheduling,
  session management, tool/provider/permission orchestration; no direct external I/O.
- `adapters/src/`: `storage/`, `fs/`, `exec/`, `http/`, `provider/` (model adapters). Implements
  the contracts ports; all external I/O side effects and provider SDK adaptation.
- `bootstrap/`: composition root, dependency-injection configuration, layer assembly, application
  start and exit.

### 1.3 Dependency direction

Allowed compile-time dependencies:

- `bootstrap` may depend on `contracts`, `core`, `adapters`, `cli`, `tui`.
- `core` depends only on `contracts`.
- `adapters` depends only on `contracts`.
- `contracts` depends on no upper layer.

Forbidden:

- core depending on adapters;
- core depending on provider SDKs;
- core depending on SQLite, filesystem, network, child processes, `process.env`;
- adapters depending on core;
- contracts depending on core, adapters or bootstrap.

Runtime may call back into adapter capabilities through dependency injection, but compile-time
dependencies stay one-directional.

### 1.4 Startup principles

Startup keeps only the architectural order, not implementation detail:

1. The entry layer parses minimal startup info and creates the top-level execution context.
2. The config system merges defaults, user config, project config, environment variables and CLI
   arguments under an explicit precedence.
3. All project-owned environment variables use the `ZCODE_` prefix.
4. bootstrap creates base adapters and injects them into core.
5. Storage runs required initialization and migrations.
6. Core restores or creates the session and builds projections through event replay.
7. UI, CLI, SDK or server subscribes to state changes.
8. Every user input advances the session through session events, never implicit in-memory state.

### 1.5 CLI/TUI default entry contract

For interactive use, bare `zcode` enters the local TUI by default instead of printing help.
`zcode tui` is an explicit alias of the same entry; `zcode --prompt <text>` stays the
script-friendly single-turn non-interactive entry.

The TUI occupies the full terminal screen with an input box at the bottom (Enter submits) and the
user/agent message history above, in order. The TUI only does input collection, layout rendering,
status hints and exit cleanup; it never holds provider, tool, permission or event-store
internals.

In TUI mode the entry layer must take over raw `process.stderr` before loading bootstrap,
provider, storage or any module that may emit process-level diagnostics. During a normal TUI
session raw `stderr` must not reach the terminal — Node runtime warnings, adapter warnings and
background diagnostics would break the full-screen UI; they go to a TUI diagnostics buffer or
controlled log. Controlled errors (entry layer, argument parsing, TUI startup failure) may be
written back through an explicit passthrough so real errors are never silently dropped, but
startup-time raw warnings are never flushed into the UI. Non-TUI CLI modes keep the Unix I/O
contract (results to `stdout`, diagnostics and errors to `stderr`); the entry layer may filter
only Node runtime warnings that are explicitly attributed and cannot change the user's outcome —
for example the experimental-SQLite notice Node 24+ prints when loading `node:sqlite` — never
silence all of `stderr`.

TUI submissions go through a restricted callback injected by the entry layer into bootstrap/core.
The callback creates or reuses the session, carries the same trace chain, runs the turn and
returns the final reply to the TUI; subsequent submissions within the same runtime reuse the
session-level message history instead of rebuilding context each turn, so multi-turn local agent
interaction works while the UI/business state machine boundary stays clean.

## 2. Repository structure

```text
packages/
├── contracts/          # protocol layer: port, event, error, capability definitions
├── core/               # core business layer: agent runtime, session, tool, ...
├── adapters/           # adapter layer: external I/O implementations
├── bootstrap/          # composition layer: dependency assembly and startup
├── cli/                # CLI entry
├── tui/                # TUI entry
├── shared-types/       # shared types
└── swift-bridge/       # Swift bridge (unchanged)
```

## 3. Interface maturity

v2 introduces interface maturity instead of defining every interface up front.

### 3.1 Maturity levels

- `L0 Concept`: domain concept and boundary confirmed only (for example `ToolRuntime`,
  `ProviderAdapter`, `SessionEventStore`).
- `L1 Candidate Contract`: candidate interface name, responsibility and constraints exist, but
  fields, methods and error shapes are not promised stable.
- `L2 Executable Contract`: validated by a first implementation; runtime schema, error types,
  permission metadata, timeout and cancellation semantics completed.
- `L3 Stable Contract`: validated by real tools, providers, session recovery, cross-platform
  tests and failure paths; enters the stable API.

### 3.2 Feedback loop

Every key contract lands through: architecture proposes boundary and invariants; an implementer
does a minimal implementation or spike; leaked details, duplicated adaptation logic and
hard-to-test paths are recorded; architecture adjusts the contract from that feedback; schema,
error types, tests and observation points are completed; only then is maturity raised.

### 3.3 Interfaces that must not be frozen in v2

`Tool`, `ToolRegistry`, `ToolRuntime`, `ProviderAdapter`, `ProviderCapabilities`,
`ModelCapabilities`, `FileSystemPort`, `FileWriteAdapter`, `ExecutionPort`, `HttpClient`,
`SandboxPort`, `PermissionPort`, `SessionEventStore`, `ArtifactStore`, `MemoryPort`,
`Transport`, `McpAdapter`, `AppServerTransport`. These names may appear as candidate boundaries,
but fields, methods, schemas and error shapes must be confirmed through separate design and
implementation feedback.

## 4. Application-layer communication architecture

A clear protocol boundary between core logic and the interaction layer supports both local
direct connection and remote proxy forms.

### 4.1 Local mode

CLI and TUI may run core in the same process. The interaction layer never reads or writes core
internals directly; it submits commands, subscribes to events and reads projections through a
unified transport boundary. Candidate names: `Transport`, `LocalTransport`, `AgentCore`,
`ServerNotification` — direction only, not final signatures.

### 4.2 Remote mode

Remote mode serves SDK integration, remote TUI, background servers and multi-process scenarios.
The remote protocol must support request/response, server push, cancellation, error
normalization, trace propagation and permission interaction. Candidate names:
`WebSocketTransport`, `JsonRpcServer`, `RpcRequest`, `RpcResponse`. v2 does not define a concrete
RPC method table; RPC methods must sediment out of real CLI/TUI/SDK operation flows, not be
enumerated once from an architecture document.

### 4.3 Communication principles

- UI subscribes to event streams or projections, never to core internal objects.
- The remote protocol carries trace context.
- Large content goes to artifact/storage and returns a reference; it is not stuffed into protocol
  messages.
- Protocol errors must be stably identifiable by UI, logs and automated tests.
- Local and remote modes reuse the same set of domain commands and event semantics as much as
  possible.

## 5. Cross-cutting capabilities

### 5.1 Logger and Trace

Logging and tracing are first-class. Every session, turn, message, tool call, provider request,
permission, subagent, storage operation and external I/O belongs under the same top-level
`traceId`. Detailed contract: [logging.md](./logging.md). Candidate names: `Logger`,
`TraceContext`, `ExecutionContext`.

Constraints: trace must propagate across async tasks, processes and the remote protocol; logs
must not leak keys, tokens, private data or full user content by default; adapters and core
services must receive context instead of generating unrelated traces ad hoc.

### 5.2 Config

Configuration is an explicit layered system, not scattered environment-variable reads. Precedence
covers at least: system default, user config, project config, session config, environment, CLI
arguments.

Constraints: project-owned environment variables use the `ZCODE_` prefix; security-relevant
config keeps source tracking; core does not read environment variables directly;
provider/model/tool/sandbox differences do not all pile into base config; config subscriptions
are scoped, not global broadcasts. Candidate names: `ConfigPort`, `RuntimeConfig`,
`ConfigStorage`.

### 5.3 Storage

Storage separates facts, views and large content:

- `EventStore`: session truth, append-only.
- `Projection`: rebuildable query views.
- `ArtifactStore`: large results, attachments, model stream fragments, tool output references.
- `ConfigStorage`: config persistence.
- `MemoryStore`: cross-session long-term memory.

Constraints: session events are the source of truth; a corrupted projection can be dropped and
rebuilt; large tool results are not fed back into model context directly; storage adapters
handle migration, concurrency, corruption recovery and structured errors. Concrete database
schemas are not defined in v2. Candidate names: `SessionEventStore`, `ProjectionStorage`,
`ArtifactStore`, `MemoryStore`.

### 5.4 Feature Gate

Local feature gate by default; a remote feature flag can only be an optional adapter, never a P0
startup path. Constraints: the CLI still starts when the network is unavailable; remote gates
have a local fallback and kill switch; feature decisions are testable and traceable; remote
service, proxy and custom-certificate details converge into the network adapter. Candidate name:
`FeatureGate`.

### 5.5 i18n

i18n covers UI copy, error hints and user-visible messages; it must not turn business errors into
plain strings. Constraints: error types and codes stabilize before localization; core may depend
on message keys but not on UI rendering; at least Chinese and English are supported; fallback
rules are explicit. Candidate names: `I18n`, `MessageKey`, `Locale`.

### 5.6 Network

All network access converges into a unified network boundary; business modules never call
low-level network APIs directly. Constraints: timeout, cancellation, retry, backoff, proxy,
custom certificates and error normalization are supported; trace context propagates; provider,
MCP, remote feature gate and web fetch all use the same class of network adapter; network errors
are never discriminated by text. Candidate names: `HttpClient`, `RequestOptions`.

## 6. Core layer modules

Core is the business state machine. It depends only on contracts and does no external I/O
directly.

### 6.1 Agent Runtime

The Agent Runtime is the core scheduler: receiving input, advancing turns, calling providers,
scheduling tools, handling cancellation, restoring sessions and emitting events. It orchestrates
subsystems; it carries no concrete business logic itself.

Constraints: every state transition first becomes a session event; in-memory state is only a
projection or runtime cache, not truth; model streams, tool calls, permission requests, errors
and cancellations are all eventified; crash recovery relies on event replay; rewind appends new
state changes instead of deleting history.

Candidate names: `AgentRuntime`, `SessionService`, `EventReducer`, `SessionProjection`,
`ConversationView`, `ToolCallView`, `PendingPermissionView`.

### 6.2 Session Event

Session events are the system's source of truth, but v2 does not define concrete event fields or
a complete enumeration. Event semantics must cover: session/turn/message lifecycle, model request
and streaming, tool-call lifecycle, permission request and resolution, checkpoint, snapshot,
compact, rewind, artifact lifecycle, subagent and mailbox, error, cancel and interrupt.

Constraints: events carry propagatable context; events are persistable, replayable and
migratable; event payloads have runtime schemas; event version upgrades have a compatibility
strategy. Candidate names: `SessionEvent`, `SessionEventType`.

### 6.3 Tool System

The Tool System turns model intent into approvable, auditable, cancellable, recoverable external
actions. v2 keeps only the tool boundary, not interface detail.

Constraints: every tool declares input schema, output schema, read-only-ness, destructiveness,
concurrency safety, timeout, cancellation semantics, permission requirements, maximum output size
and side-effect scope; side-effecting tools declare idempotency and recovery strategies where
practical; oversized tool output goes to artifact/storage and returns only a summary and
reference; the tool runtime never bypasses permission, trace, audit and adapter contracts; tools
exposed by MCP, plugins and subagents also pass unified capability and schema validation.

Candidate names: `Tool`, `ToolRegistry`, `ToolRuntime`, `ToolResult`, `ToolContext`. First tool
directions: file read/search, file write/edit, subprocess execution, web search/fetch, todo/task
internal tools. Concrete tool contracts are designed separately.

### 6.4 Provider

Provider is a capability-first model adaptation boundary. Core reads no vendor SDK, private HTTP
fields or model branches.

Constraints: provider/model capabilities are explicitly probed or declared; tool calling,
structured output, streaming, reasoning, cache, parallel tools, token limits and retry policy are
all capability design; model config only selects and holds user overrides, not all behavior
branches; provider errors are normalized while keeping the original cause; provider adapters
support trace, cancellation, timeout and audit.

Candidate names: `ProviderAdapter`, `ProviderCapabilities`, `ModelCapabilities`, `ModelPort`.

Current state: the base model-capability contract is split into `model/README.md` and landed as
the `ModelCapability` / catalog query interface, adapter default policy and core runtime
consumption path. The full `ProviderCapabilities` stable schema is still open, especially
provider-level network, cache, parallel-tool and retry-budget capabilities.

### 6.5 Permission and Mode

Permission owns collaboration mode, approval policy, risk policy and audit policy. It does not
implement filesystem, network or subprocess isolation itself.

Constraints: permission decisions are eventified; auto-approval never bypasses schema validation,
adapter contracts, audit events or high-risk rules; Plan, Build, Yolo and Auto modes are
permission-policy inputs, not scattered if-branches; the tool catalog does not change with mode —
mode only changes the decision after a tool call reaches the permission gate, so tools-schema
changes never break provider caches; sandbox is a separate boundary that permission may compose
with, never the same concept.

Current P0 mode semantics:

| Mode | Permission behavior |
| --- | --- |
| `plan` | Allows tools with `readOnly=true` and `destructive=false`; rejects workspace/git/system/network writes and other non-read-only tools. |
| `build` | Default mode; read-only tools are allowed directly, side-effecting, destructive or high-risk tools enter `ask` and wait for the UI/SDK approval chain. |
| `yolo` | Skips permission prompts and allows directly; still does not skip the tool registry, schema/adapter contracts, trace or audit. |
| `auto` | Reserved, not implemented; if configured, permission explicitly denies it with a debuggable reason. |

A permission decision must carry `mode`, `toolName`, `riskLevel`, `sideEffectScope`, `decision`,
`ruleId` and a human-readable `reason`, and be recorded as structured debug logs at the tool
executor. Logs record only an input summary; the approval-requiring `permission_requested` event
may carry the raw input for UI display.

Candidate names: `PermissionPort`, `PermissionService`, `PermissionResult`,
`CollaborationMode`, `ApprovalPolicy`, `RiskPolicy`.

### 6.6 Hooks

Hooks are extension points, not a hidden global event bus.

Constraints: hooks have an explicit phase, input, output, timeout, cancellation and error policy;
hook side effects go through adapters; hooks never implicitly mutate core internal state; hook
results are observable. Candidate names: `Hook`, `HookRunner`, `HookPhase`.

### 6.7 Subagent and Mailbox

Subagent and Mailbox are durable lifecycles, not in-memory maps.

Constraints: spawn, state changes, message delivery, ack, failure, cancellation and recovery are
all eventified; the mailbox is point-to-point communication with no global event bus; messages
have capacity limits, expiry policy, duplicate-delivery protection and failure propagation; child
agents inherit the parent's trace, workspace scope and permission policy, but permission requests
are still explicitly eventified; a spawn guard prevents runaway recursion.

Candidate names: `SubagentRuntime`, `SubagentRecord`, `SubagentPolicy`, `Mailbox`,
`InterAgentMessage`. Concrete lifecycle, backpressure and recovery strategies are designed
separately.

### 6.8 Compact and Rewind

Compact manages current-session context compression; rewind manages rollback semantics. They
share session state but are not the same thing.

Constraints: the compact boundary is auditable state, not a pure in-memory marker; rewind never
physically deletes history; prompt building understands post-compact context boundaries; compact,
snapshot and rewind coordinate with the event store, projections and artifacts.

Candidate names: `CompactBoundary`, `RewindPoint`, `SessionStateManager`. Concrete boundary
fields and recovery strategies are designed separately.

### 6.9 Memory

Memory is cross-session long-term memory, distinct from compact: compact compresses a single
session's context; memory is cross-session knowledge extraction, retrieval, merging and expiry.

Constraints: memory extraction is disableable, observable and source-traceable; memory does not
leak privacy or sensitive content by default; memory injection into prompts has an explicit
priority and token budget.

Candidate names: `MemoryPort`, `MemoryPipeline`, `MemoryEntry`, `MemorySource`. Extraction
strategy, confidence, expiry and merge strategy are designed separately.

### 6.10 Skill

Skill is a core-understandable domain concept, but loading sources belong to adapters.
Implementation planning: [Skill Integration Plan](./skill.md).

Constraints: skill triggers, instructions and dependencies have schemas; skill loading never
pulls filesystem detail into core; the relationship between skills, tools, MCP and plugins is
converged through capability declarations. Candidate names: `Skill`, `SkillLoader`,
`SkillTrigger`.

### 6.11 Sandbox

Sandbox is an independent port, never merged with permission. It provides execution isolation or
policy enhancement: permission decides whether to allow; sandbox decides how to isolate or
constrain. Sandbox errors are structured with the underlying cause preserved; sandbox
capabilities may vary by platform and must be detectable. Candidate names: `SandboxPort`,
`SandboxPolicy`.

### 6.12 File Watcher

File Watcher is a hint mechanism, not a correctness mechanism. It reminds the session that the
user or an external process changed a file; watcher events never replace pre-write validation —
write correctness belongs to the file write adapter's re-read, revision/hash, lock and structured
errors. Cross-platform watcher differences are handled by the adapter. Candidate names:
`FileWatcher`, `FileChangeEvent`, `FileReadState`.

## 7. External I/O boundaries

All external side effects converge into adapters.

### 7.1 Filesystem

Filesystem capabilities are exposed through a unified port and adapter. Path handling uses Node
standard cross-platform APIs; no hand-written separators, absolute-path prefixes, temp
directories or newline assumptions. Stale writes are handled before writing; atomic writes,
permission errors, symlinks, case sensitivity, BOM, line endings and Windows rename behavior are
part of the adapter contract. Candidate names: `FileSystemPort`, `FileWriteAdapter`.

### 7.2 Subprocess

Subprocess execution goes through a unified execution adapter. Prefer argument-array form; avoid
shell string concatenation; account for Windows `.cmd`/`.exe`, paths with spaces, environment
variable casing and shell differences; support timeout, cancellation, output truncation, streamed
output, exit-code normalization and permission auditing. Candidate name: `ExecutionPort`.

### 7.3 Network

Network capabilities converge into an `HttpClient`-class boundary. Provider, MCP, web fetch,
remote config and telemetry do not each invent their own network behavior.

### 7.4 Artifact

Artifacts carry large results, attachments, downloaded files, model stream fragments, tool
outputs and traceable references. Model context receives only summaries and references; artifacts
carry hash, source, permission scope and lifecycle; the physical artifact-storage structure is
not defined in v2.

## 8. Multi-session parallel execution

Session, message, tool call, permission, checkpoint, queue and pending states are first-class
objects.

### 8.1 Session isolation

Every session has its own event stream, projection, file-read baseline, pending permission and
runtime state. Sessions share no in-memory truth; inter-session communication passes only hints
or requests; shared-resource access is coordinated through adapters or managers; fork, resume,
rollback and concurrent sessions all keep their trace. Candidate names: `SessionManager`,
`SharedStateHandle`, `SessionMailbox`.

### 8.2 Write conflicts

Write conflicts are P0/P1 problems, not late-phase work. Default is to reject stale writes, never
auto three-way merge. Read records a sufficient file baseline — a truncated read never authorizes
a full-file write. Edit, Write and Patch re-read the current file and validate before writing. A
per-path lock only resolves in-process interleaving and is not a cross-process correctness
guarantee; modifications by the user, IDE, formatters and other processes are discovered through
pre-write re-reads.

### 8.3 Watcher and concurrency

The watcher only provides context hints. Real concurrency safety is carried by the file write
adapter and the session event state together.

## 9. Error handling and observability

Errors are first-class design objects. Low levels throw structured errors upward by default;
errors are caught only where the code can recover, retry, degrade, add context, or format at the
CLI boundary. Wrapped errors keep the original cause. Program flow never keys on error text. The
CLI entry layer uniformly prints user guidance and sets exit codes. Tests cover critical failure
paths.

Observability keeps entry points from the first version: model request, context composition,
token/cost, tool call, permission, external I/O, queue/backpressure, retry, compact/rewind,
provider capability, session recovery.

## 10. Implementation order

Implementation phases define review order only; interface details stay unfixed.

- **Phase 0 — Protocol baseline**: first `contracts/` version; `TraceContext` and execution
  context boundary; error type/code direction; session event semantic scope; base port names and
  responsibilities.
- **Phase 1 — Bootstrap and base I/O**: bootstrap composition root; config loading; logger and
  trace propagation; minimal event store; minimal filesystem, execution, http and artifact
  adapters.
- **Phase 2 — Session and Agent Runtime**: minimal session create/resume/fork loop; event reducer
  and projection; model streaming events; tool-call lifecycle events; interrupt, cancel and crash
  recovery.
- **Phase 3 — Tool / provider / file contract deepening**: Tool Contract detailed design;
  Provider/Model Capability detailed design (model-capability catalog main line landed;
  provider-level stable schema still converging); FileWriteAdapter detailed design; Read / Edit /
  Write / Bash first-tool validation; cross-platform file and subprocess failure-path tests.
- **Phase 4 — Permission, modes and security boundary**: permission event lifecycle; collaboration
  mode; approval policy; sandbox port spike; high-risk tool policy.
- **Phase 5 — Advanced state and concurrency**: subagent lifecycle; durable mailbox; compact
  boundary; rewind; multi-session; file watcher.
- **Phase 6 — Extensions and ecosystem**: hooks; skills; MCP / ZCode app-server; plugin
  capability; metrics and telemetry; memory pipeline.

## 11. Key design decisions

### 11.1 Core does not depend on infra

Core must be independently testable. Provider, MCP, SQLite, filesystem, network and subprocess
must not leak into the business state machine.

### 11.2 Session events are truth

Resume, fork, rollback, pending permission, streaming parts, tool lifecycle and crash recovery
all depend on event facts. Projections can be rebuilt; in-memory objects are never the source of
truth.

### 11.3 No global event bus

A global bus hides dependencies, ordering and failure propagation. Cross-agent or cross-session
communication uses explicit mailboxes, commands or projection hints.

### 11.4 Provider capability first

Provider differences are more than model names. Tool calling, structured output, streaming,
reasoning, cache, parallel tools, token limits and error shapes are all capability-ized.

### 11.5 Tool contracts must be audit-friendly

A tool is not just a function call. It is a composition of permission, audit, cancellation,
recovery, output management and side-effect boundaries.

### 11.6 File watcher is not a lock

The watcher can only hint at file changes. Write correctness is guaranteed by pre-write re-reads,
revision/hash, locks and structured errors.

### 11.7 Architecture defines constraints first, not all interfaces

v2 deliberately does not freeze fields and methods. Interfaces are shaped by implementation
feedback, failure paths, cross-platform validation and real tool integration.

## 12. Detailed designs to split

The following must become separate design documents or implementation RFCs. Completed RFCs stay
listed here so automation does not re-treat the same capability as a gap.

Split and landed:

- Tool Contract: `tool/README.md` and `tool/*.md`. As of the 2026-05-07 check, the public
  contract, built-in tool declarations, registry projection, executor/scheduler consumption,
  output-schema validation and artifact result budget have a code and test loop.
- Provider / Model Capability: `model/README.md`. As of the 2026-05-07 check, `ModelRef`,
  provider-neutral request/result, the `ModelCapability` catalog, adapter default policy, config
  override projection, AI SDK registry/runner and the core runtime model loop have a code and
  test loop; provider-level network/cache/parallel-tool/retry-budget capabilities are still not
  promoted to a stable capability schema.

Still to split:

- Provider Capability stable schema (network / cache / parallel tool / retry budget)
- FileSystem / FileWriteAdapter
- Execution Adapter
- Session Event schema
- EventStore storage schema
- Projection rebuild strategy
- Permission / Mode / Risk Policy
- Sandbox Port
- Subagent / Mailbox lifecycle
- Compact / Rewind
- Memory Pipeline
- Config schema and subscription
- Transport / RPC Protocol
- MCP / ZCode app-server integration
- Metrics / Observability

Each detailed design must include: goals and non-goals; candidate contract names; runtime schema;
error types; permission and side-effect scope; timeout, cancellation and retry semantics;
cross-platform notes; a minimal implementation plan; implementation feedback records; and the
conditions for promotion to a stable contract.

## 13. Current TODO

- [x] Repository structure (packages/contracts, adapters, bootstrap)
- [x] Layer responsibilities written into the design
- [x] Agent Loop sub-module design (`loop/architecture.md`)
- [x] Agent Loop implementation plan (`loop/plan.md`)
- [x] M1: base data structures (contracts/interfaces, contracts/events)
- [x] M2: Event and EventReducer
- [x] M3: Turn state machine
- [x] M4: Tool Scheduler
- [x] M5: Agent Runtime skeleton
- [x] Tool Contract RFC (`tool/README.md` implementation check)
- [x] Provider / Model Capability RFC base implementation (`model/README.md` implementation
  check)
- [ ] Provider Capability stable schema (network/cache/parallel tool/retry budget)
