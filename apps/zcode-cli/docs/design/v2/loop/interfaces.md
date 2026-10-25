# M1-M5 Public Interfaces

This document indexes the public APIs of `@zcode/contracts` and `@zcode/core`. The authoritative
definitions live in the source files below; this file records structure, rules, and maturity.

---

## 1. @zcode/contracts

- `interfaces/shared.ts` — brand types `SessionId`, `TurnId`, `EventId`, `TraceId`, `ToolCallId`
  and factory functions (`createSessionId`, `createTurnId`, `createEventId`, `createTraceId`,
  `createToolCallId`).
- `interfaces/session.port.ts` — enums (`CollaborationMode`, `SessionStatus`, `RiskLevel`,
  `ToolCallStatus`, `InputDelivery`, `TurnSteerRejectReason`), `SessionEventStorePort`,
  `SessionProjection` (with `PendingSteerInputInfo`, `PendingPermission`, `ActiveToolCall`,
  `ErrorInfo`), `EventReducerPort`, `SessionManagerPort`, `TurnSteerInput`, `TurnSteerResult`,
  `SendInputResult` (`started_turn` | `queued` | `rejected`), `SessionSummary`.
- `events/session.events.ts` — the `SessionEventType` constant map (session/turn/message/model/
  tool/permission/state/subagent/system events, including the steer events `turn_steer_queued`,
  `turn_steer_drained`, `turn_steer_rejected`, `turn_steer_discarded`), the base `SessionEvent`,
  event payloads (`SessionCreatedPayload`, `TurnStartedPayload`, `TurnCompletePayload`,
  `TurnErrorPayload`, `ToolCallScheduledPayload`, `ToolCallResultPayload`,
  `PermissionRequestedPayload`, `PermissionResolvedPayload`), supporting types (`TurnResultType`,
  `PermissionDecision = 'allow' | 'deny' | 'escalate' | 'modify'`, `ToolSchedulePayload`,
  `ToolResultPayload`, `ErrorPayload`, `TokenUsage`), and the `createSessionEvent` factory.
- `events/event-reducer.ts` — `EventReducer` with `reduce(events)` and
  `apply(projection, event)`, plus the equivalent free functions.
- `errors/index.ts` — the `CoreErrorType` constant map (`session_not_found` … `unknown_error`),
  `CoreError` (typed, with `code`, `cause`, `context`, `recoverable`, `retryable`), the
  `createCoreError` factory, error creators (`sessionNotFound`, `invalidTurnPhase`, `toolNotFound`,
  `toolExecutionFailed`, `permissionDenied`), and predicates (`isCoreError`, `isRetryable`,
  `isRecoverable`).
- `model/index.ts` — `ModelRef` (`providerId`, `modelId`, `role`, `source`, `variant`), brand types
  `ModelProviderId` / `ModelId`, `ModelRole` (`main`, `lite`, `compact`, `review`, `subagent`),
  `ModelRefSource` (`default`, `config`, `env`, `cli`, `session`, `agent`, `tool`).

## 2. @zcode/core

- `agent/turn-state.ts` — `TurnPhase` (`idle`, `processing_input`, `awaiting_model_response`,
  `streaming`, `scheduling_tools`, `executing_tools`, `aggregating_results`,
  `awaiting_permission`, `completing`, `error`), `TurnState` with model/tool/permission sub-states
  (`ToolCallStateStatus` includes `waiting_permission` and `permission_denied`), the
  `createTurnState` factory, and phase predicates (`isTerminalPhase`, `isWaitingPhase`,
  `canTransitionTo`).
- `agent/turn-machine.ts` — `TurnMachine` state transitions (`start`, `startModelRequest`,
  `addStreamingContent`, `scheduleTools`, `startToolExecution`, `completeTool`,
  `requestPermission`, `resolvePermission`, `aggregateResults`, `complete`, `fail`,
  `getNextPhase`, `isComplete`); `TurnMachineImpl.create(...)`.
- `tool/scheduler.ts` — `ToolSchedule` / `ToolScheduleItem` / `ToolDependency`, `ToolScheduler`,
  `defaultToolScheduler`, and `READ_ONLY_TOOLS` (Read, Glob, Grep, WebFetch, TodoRead, TodoWrite,
  AskUserQuestion).
- `permission/service.ts` — `PermissionContext`, `PermissionDecisionResult`, `PermissionService`
  (`checkPermission`, `requiresApproval`, `getRiskLevel`), `PermissionConfig` and
  `defaultPermissionConfig`.
- `runtime.ts` — `AgentRuntimeConfig`, `AgentRuntimeDeps` (event store, permission service, tool
  scheduler), `TurnResult`, `AgentRuntime` (`executeTurn`, `scheduleTools`,
  `emitPermissionRequest`, `resolvePermission`, `getProjection`, `getSessionId`), `RuntimeFactory`.

Interface dependency direction: `AgentRuntime`, `TurnMachine`, and `PermissionService` in
`@zcode/core` all depend on `@zcode/contracts` (ports, events, `EventReducer`, `CoreError`,
`ModelRef`); nothing in contracts depends on core.

---

## 4. Context Builder

### 4.1 Design goals

The Context Builder assembles the system/context prefix sent to the model:

1. **Structured output** — each section is recorded separately for debugging and tests.
2. **Token estimation** — context window usage stays observable.
3. **Silent tolerance** — missing files are skipped silently.
4. **Cache friendliness** — stable system, dynamic system, and meta user context are emitted as
   separate blocks; adapters translate the provider cache intent.

### 4.2 Section composition

| Section | source | Status | Notes |
|---------|--------|--------|-------|
| CLI Prefix | `cli_prefix` | done | Fixed product identity prefix |
| Agent Identity | `identity` | done | Fixed `zcode-agent` identity |
| Dynamic Behavior | `dynamic_behavior` | done | Communication and action-caution content |
| Environment Info | `env_info` | done | cwd, platform, git status |
| Skills | `skills` | done | Injected with a `<system-reminder>` user prefix |
| Request User Context | `request_user_context` | done | Aggregated resolved instruction files and project-memory index |
| Current Date | `current_date` | done | Current date |

Provider-visible copy inside dynamic system sections stays English-only — Environment Info
headings, field labels, and enum-like status text — so the system prompt stays language-consistent
across locales.

Provider-visible copy inside stable behavior sections also stays English-only; see
`docs/design/v2/loop/system-prompt-contract.md` for the full stable prompt contract. The stable
system prompt must include guidance equivalent to:

- The main coding agent identity is fixed as `zcode-agent`; runtime agent metadata must not be
  string-spliced into the identity sentence.
- Do not guess or invent repository facts. Read relevant files and inspect existing patterns before
  proposing or making code changes.
- Tool results and user messages may include `<system-reminder>` or other tags; those tags carry
  system context and are not inherently tied to the specific tool result or user message that
  contains them.
- Fix root causes when possible, keep changes focused, update documentation when needed, and verify
  meaningful changes with focused checks.
- Ask for confirmation before destructive, hard-to-reverse, shared-system, or externally visible
  actions.
- Responses should stay brief and concise.
- When referencing a specific function or code snippet, use `file_path:line_number`.
- When the user types `/<skill-name>`, call `Skill` only if that exact skill is listed in the
  available skills metadata. Never guess missing skill names.

### 4.3 Core types

Context sections carry, per `ContextSection`: `name`, `source` (a `ContextSource` such as
`cli_prefix`, `identity`, `env_info`, `system_context`, `skills`, `tools`,
`request_user_context`, `memory`, `current_date`, `custom_system_prompt`,
`subagent_agent_prompt`, `subagent_notes`, `subagent_environment`, `dynamic_behavior`,
`session_guidance`, `output_style`, `context_management`), `injectionTarget`
(`'system' | 'meta_user'`), `cacheHint` (`'stable' | 'dynamic'`), `chars`, `tokens`, `content`, and
a 100-character `preview`.

`ContextBuildResult` returns `sections[]`, `totalChars`, `totalTokens`, and `messages` (stable
system + dynamic system + optional meta_user prefix messages). `ModelInputMessage` may carry
`cacheControl: { type: 'ephemeral', ttl?: '5m' | '1h', scope?: 'global' | 'org' }` — a
provider-neutral cache intent translated by adapters.

`EnvInfo` mixes one live field with a frozen git snapshot:

- The runtime must refresh `currentModel` from the active session model selection whenever the
  dynamic system block is rebuilt, including after `/model` changes and on resume.
- All git-derived fields (`isGitRepository`, branch metadata, git user, status lines, recent
  commits) are a session-start snapshot: persisted and reused for the rest of the session, never
  recomputed mid-session, otherwise normal repository changes would invalidate prompt cache
  identity.

Other config inputs: `UserInstructionsOptions` (`workingDirectory`, optional `projectRoot`,
`priorityFiles` defaulting to `['AGENTS.md', 'CLAUDE.md']`, `maxBytes`), `ProjectContext` (type,
package manager, scripts, build files — P2), and `SessionContextOptions` (P3).

### 4.4 User Instructions (L2)

Project instructions must enter the model context automatically on the default prompt/TUI path,
not require callers to pass them:

```typescript
// Search in order; stop at the first file that exists
const PRIORITY_FILES = ['AGENTS.md', 'CLAUDE.md'];

// Hierarchical lookup: from CWD upward to the project root
// Stop at the first match; do not stack multiple files
```

Rules:

- `AGENTS.md` outranks `CLAUDE.md`.
- Search upward to the project root; stop at the first match.
- Missing files are skipped silently.
- Bootstrap enables `userInstructions: { workingDirectory }` by default.
- File reads stay in the context source adapter; core only consumes
  `ResolvedUserInstructions`.
- Injection into model context must carry the source path, so audits can show why a rule applies.
- Read failures go to diagnostics only and never block session startup.

### 4.5 Project Context (P2)

Collect basic project facts at startup: project type from marker files (Node `package.json`,
Python `requirements.txt`/`pyproject.toml`, Rust `Cargo.toml`, Go `go.mod`), package manager from
lock files (`yarn.lock`, `pnpm-lock.yaml`, `package-lock.json`), and build files (`Makefile`,
`docker-compose.yml`).

### 4.6 Context Builder interface

```typescript
interface ContextBuilder {
  config: ContextBuilderConfig;

  build(): ContextBuildResult;

  addSection(section: Omit<ContextSection, 'chars' | 'tokens'>): this;

  // Compatibility entry; tool descriptions do not enter the context —
  // they are carried by the model request tools.
  setTools(registry: ToolRegistry): this;
}
```

### 4.7 Debug usage

`ctx.sections` supports per-section stats (`name`, `chars`, `tokens`), looking up a section's
content by `source` (e.g. `request_user_context`), and asserting `ctx.totalTokens` bounds in
tests.

---

## 5. Ports awaiting adapter implementations

| Port | Purpose | Status |
|------|---------|--------|
| `SessionEventStorePort` | Session event persistence | Pending |
| `EventReducerPort` | Events-to-projection conversion | Implemented (EventReducer) |
| `SessionManagerPort` | Session lifecycle management | Pending |

## 6. Interface maturity

| Interface | Maturity | Notes |
|-----------|----------|-------|
| `SessionEvent` / `SessionEventType` | L2 | Implemented, tested |
| `SessionEventStorePort` | L1 | Defined, pending implementation |
| `EventReducer` | L2 | Implemented, tested |
| `TurnState` / `TurnPhase` | L2 | Implemented, tested |
| `TurnMachine` | L2 | Implemented, tested |
| `ToolScheduler` | L2 | Implemented, tested |
| `PermissionService` | L2 | Implemented, integration tests pending |
| `AgentRuntime` | L1 | Skeleton implementation, to be completed |
| `CoreError` | L2 | Implemented |
| `ModelRef` | L1 | Defined, to be extended |
