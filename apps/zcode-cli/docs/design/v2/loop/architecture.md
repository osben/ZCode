# Agent Loop Design

## Document scope

Core agent loop design for the ZCode CLI, as the sub-module design of `architecture.md`. The agent
loop is the system's core engine; other modules (tool, provider, permission, etc.) are components
serving it.

---

## 1. Design foundations

### 1.1 Core loop

**Core loop**: `Gather → Act → Verify`

```
user input -> model evaluation -> tool calls or final response -> execute tools -> feed results back -> repeat
```

**Permission modes**:

- `default` — uncovered tools trigger approval
- `acceptEdits` — auto-approve file edits
- `plan` — produce a plan only, no execution
- `dontAsk` — never prompt, rules only
- `yolo` — skip permission prompts, execute directly
- `auto` — reserved, not implemented yet

**Hook system**: `PreToolUse` / `PostToolUse` / `PostToolUseFailure`, `UserPromptSubmit`, `Stop`,
`SubagentStart/Stop`, `PreCompact`, `PermissionRequest`, `SessionStart/End`.

### 1.2 Design patterns

| Pattern | Description |
|---------|-------------|
| Event-driven loop | State changes are recorded as events; the loop advances by events |
| Session/Turn hierarchy | A session contains multiple turns; each turn is one full request-response |
| Tool contract declaration | Tools must declare schema, permissions, side effects, timeout, etc. |
| Independent permission | Permission checks are separated from execution, never mixed into business logic |
| Event sourcing | Append-only event store, supporting recovery and replay |
| Port/Adapter separation | Core does not depend on concrete implementations |

---

## 2. ZCode agent loop design

### 2.1 Core loop

ZCode uses an **event-first agent loop**: Turn Input → Event Creation → State Transition (reducer) →
Projection (`ConversationView` | `ToolCallView` | `PendingPermissionView`) → Provider (LLM call) /
Tool Runtime / Permission Service → Event Emit, which feeds the next transition.

### 2.2 Turn lifecycle

A turn has four phases:

1. **Input Processing** — parse user input, apply the permission mode, inject context (memory,
   system prompt).
2. **Model Request** — build the prompt (system + context + history + input), call
   `ProviderAdapter`, handle streaming events, record `model_request`.
3. **Tool path** (when tool calls exist):
   - 3a **Tool Scheduling** — order by dependencies (read-only in parallel, writes serial),
     pre-check permissions, register pending permissions.
   - 3b **Tool Execution** — execute tools, capture result or error, emit `tool_result` events.
   - 3c **Result Aggregation** — aggregate all tool results, prepare the next model request, then
     return to Phase 2.
4. **Turn Completion** (on final response) — emit `turn_complete`, update projections, check whether
   compaction is needed.

### 2.3 State model

#### 2.3.1 SessionState

```typescript
interface SessionState {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  mode: CollaborationMode;
  status: SessionStatus;

  // Events
  eventLog: SessionEvent[];
  turnCount: number;
  totalTokenCount: number;

  // Context management
  contextWindow: number;
  contextUsed: number;
  compactBoundaries: CompactBoundary[];

  // Concurrency
  pendingPermissions: PendingPermission[];
  activeToolCalls: ToolCall[];
}
```

#### 2.3.2 TurnState

```typescript
interface TurnState {
  id: TurnId;
  sessionId: SessionId;
  turnNumber: number;

  phase: TurnPhase;

  // Model
  modelRequest?: ModelRequest;
  modelResponse?: ModelResponse;
  streamingParts: StreamingPart[];

  // Tools
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  toolSchedule: ToolSchedule;

  // Permissions
  pendingPermissions: PermissionRequest[];
  resolvedPermissions: PermissionResult[];

  // Outcome
  finalResponse?: string;
  error?: TurnError;
  resultType: TurnResultType;
}
```

#### 2.3.3 TurnPhase enum

```typescript
enum TurnPhase {
  Idle = 'idle',                    // waiting for input
  ProcessingInput = 'processing_input',
  AwaitingModelResponse = 'awaiting_model_response',
  Streaming = 'streaming',
  SchedulingTools = 'scheduling_tools',
  ExecutingTools = 'executing_tools',
  AggregatingResults = 'aggregating_results',
  AwaitingPermission = 'awaiting_permission',
  Completing = 'completing',
  Error = 'error',
}
```

---

## 3. Event design

### 3.1 Event taxonomy

| Category   | Events                                                                                             | Description       |
|------------|----------------------------------------------------------------------------------------------------|-------------------|
| Session    | `session_created`, `session_resumed`, `session_forked`, `session_compacted`                         | Session lifecycle |
| Turn       | `turn_started`, `turn_input_received`, `turn_complete`, `turn_error`                                | Turn lifecycle    |
| Message    | `user_message`, `assistant_message`, `system_message`                                               | Messages          |
| Model      | `model_request`, `model_streaming`, `model_complete`, `model_error`                                 | Model calls       |
| Tool       | `tool_call_scheduled`, `tool_call_started`, `tool_call_result`, `tool_call_error`, `tool_batch_complete` | Tool execution |
| Permission | `permission_requested`, `permission_resolved`, `permission_denied`                                  | Permissions       |
| State      | `compact_boundary`, `rewind_triggered`, `checkpoint_created`                                        | State management  |
| Subagent   | `subagent_spawned`, `subagent_message`, `subagent_stopped`                                          | Child agents      |
| System     | `interrupt`, `cancel`, `resume`, `error`                                                            | System events     |

### 3.2 Event structure

```typescript
// Base event
interface SessionEvent {
  id: EventId;
  sessionId: SessionId;
  turnId?: TurnId;
  type: SessionEventType;
  timestamp: Date;
  traceId: TraceId;
  sequenceNumber: number;
  payload: EventPayload;
  metadata?: EventMetadata;
}

// Example: tool call event
interface ToolCallScheduledEvent extends SessionEvent {
  type: 'tool_call_scheduled';
  payload: {
    toolCallId: ToolCallId;
    toolName: string;
    input: unknown;
    dependencies: ToolCallId[];
    parallelGroupIndex: number;
    canRunParallel: boolean;
    schedule: {
      parallelGroups: ToolCallId[][];
      executionOrder: ToolCallId[];
    };
  };
}

interface ToolCallResultEvent extends SessionEvent {
  type: 'tool_call_result';
  payload: {
    toolCallId: ToolCallId;
    result: ToolResult;
    duration: number;
    outputSize: number;
  };
}
```

### 3.3 Event constraints

1. **Immutable**: an event never changes after creation.
2. **Replayable**: the event store supports replay from any point.
3. **Ordered**: `sequenceNumber` guarantees order.
4. **Propagatable**: carries `traceId` for distributed tracing.
5. **Versioned**: event schemas can evolve.

---

## 4. Projection design

### 4.1 Projection types

| Projection              | Purpose                                  | Updated on          |
|-------------------------|------------------------------------------|---------------------|
| `SessionProjection`     | Overall session state                    | Any session event   |
| `ConversationView`      | Conversation history (prompt building)   | Message events      |
| `ToolCallView`          | Tool call state                          | Tool events         |
| `PendingPermissionView` | Pending approvals                        | Permission events   |
| `ContextBudgetView`     | Token budget                             | Model events        |

### 4.2 Projection updates

```typescript
// EventReducer
function reduce(state: SessionProjection, event: SessionEvent): SessionProjection {
  switch (event.type) {
    case 'turn_started':
      return { ...state, currentTurn: createTurnProjection(event.payload) };

    case 'tool_call_result':
      return updateToolCallView(state, event.payload);

    case 'permission_resolved':
      return updatePendingPermissionView(state, event.payload);

    case 'compact_boundary':
      return applyCompactBoundary(state, event.payload);

    default:
      return state;
  }
}
```

### 4.3 Prompt building

```typescript
// ConversationView builds the model prompt
interface ConversationView {
  messages: Message[];
  systemPrompt: string;
  compactBoundaries: CompactBoundary[];
  contextBudget: ContextBudget;

  toModelMessages(): ModelMessage[];
  estimateTokenCount(): number;
  shouldCompact(): boolean;
}
```

---

## 5. Tool scheduling

### 5.1 Schedule shape

```typescript
interface ToolSchedule {
  items: ToolScheduleItem[];
  parallelGroups: ToolCallId[][];  // groups that can run in parallel
  executionOrder: ToolCallId[];   // final execution order
}

interface ToolScheduleItem {
  toolCallId: ToolCallId;
  toolName: string;
  dependencies: ToolCallId[];
  canRunParallel: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  sideEffectScope?: ToolSideEffectScope;
  estimatedDuration?: number;
}
```

### 5.2 Scheduling rules

1. **Read-only / concurrentSafe tools run in parallel**: `Read`, `Glob`, `Grep`, `WebSearch`, plus
   any tool whose metadata declares `concurrentSafe: true`; only `WebSearch`'s provider-native
   `web_search` side requests inside the handler stay outside local tool scheduling.
2. **Write / destructive / non-concurrentSafe tools run serially**: e.g. `Write`, `Edit`, `Bash`.
3. **Dependencies execute first**: if tool B depends on tool A's result, B runs after A.
4. **Pending permissions block**: an unapproved permission request blocks the related tools.
5. **The schedule must be consumed**: the runtime must call
   `executor.executeSchedule(toolCalls, schedule, { signal })`; it must not ignore the schedule and
   fall back to a full `executeBatch`.

### 5.3 Scheduling algorithm

```typescript
function scheduleTools(toolCalls: ToolCall[]): ToolSchedule {
  // 1. Topological sort
  const sorted = topologicalSort(toolCalls, getDependencies);

  // 2. Group: within a dependency layer, only read-only/concurrentSafe tools join a parallel
  //    group; side-effecting or undeclared tools each get their own group.
  const groups = groupByParallelSafety(sorted);

  // 3. Validate no dependency cycles
  validateNoCycles(groups);

  return {
    items: sorted,
    parallelGroups: groups,
    executionOrder: flatten(groups),
  };
}
```

---

## 6. Permission integration

### 6.1 Permission flow

`PermissionService.check(toolCall)` runs, in order:

1. Check the permission mode (plan/build/yolo/auto).
2. Check `allowed_tools` / `disallowed_tools`.
3. Check the risk level.
4. If asking is required, emit a `permission_requested` event.
5. Wait for the user response or an automated decision.

Decision outcome: `allow` continues execution; `deny` emits `tool_call_error` and returns the
rejection; `escalate` triggers higher-level approval.

### 6.2 Permission mode

```typescript
enum CollaborationMode {
  Plan = 'plan',      // read-only, produce a plan
  Build = 'build',    // normal execution
  Yolo = 'yolo',      // skip permission prompts
  Auto = 'auto',      // reserved, not implemented yet
}
```

### 6.3 Permission events

```typescript
interface PermissionRequestedEvent extends SessionEvent {
  type: 'permission_requested';
  payload: {
    toolCallId: ToolCallId;
    toolName: string;
    riskLevel: RiskLevel;
    reason: string;
    input: unknown;
  };
}

interface PermissionResolvedEvent extends SessionEvent {
  type: 'permission_resolved';
  payload: {
    toolCallId: ToolCallId;
    decision: PermissionDecision;
    reason?: string;
    userModifiedInput?: unknown;
  };
}
```

---

## 7. Context management

### 7.1 Context budget

```typescript
interface ContextBudget {
  maxTokens: number;
  usedTokens: number;
  reservedTokens: number;  // fixed overhead: system prompt, tool definitions

  // Per-part budgets
  systemPromptBudget: number;
  conversationBudget: number;
  toolResultBudget: number;
  memoryBudget: number;
}
```

### 7.2 Compact triggers

```typescript
interface CompactTrigger {
  condition: 'token_threshold' | 'turn_count' | 'manual';
  threshold: number;  // e.g. 0.85 (85%)
  priority: CompactPriority;
}
```

### 7.3 Compact flow

Trigger satisfied → emit `PreCompact` event → build the compact boundary (identify messages to
keep, generate the summary, mark the compact range) → emit the immutable `CompactBoundary` event →
rebuild `ConversationView` → emit `SessionCompacted`.

---

## 8. Error handling

### 8.1 Error types

```typescript
enum TurnErrorType {
  ModelError = 'model_error',
  ToolError = 'tool_error',
  PermissionDenied = 'permission_denied',
  ContextExceeded = 'context_exceeded',
  Timeout = 'timeout',
  Canceled = 'canceled',
  Unknown = 'unknown',
}

interface TurnError {
  type: TurnErrorType;
  message: string;
  cause?: Error;
  recoverable: boolean;
  retryable: boolean;
}
```

### 8.2 Error strategies

| Error type         | Strategy                                          |
|--------------------|---------------------------------------------------|
| `ModelError`       | Retry N times with exponential backoff            |
| `ToolError`        | Check retryability; possibly skip or degrade      |
| `PermissionDenied` | Return the rejection to the user                  |
| `ContextExceeded`  | Trigger compaction or end the session             |
| `Timeout`          | Cancel the operation, attempt recovery            |
| `Canceled`         | Clean up state, exit the turn gracefully          |

---

## 9. Candidate naming

| Concept            | Candidates                                             | Status |
|--------------------|--------------------------------------------------------|--------|
| Agent Runtime      | `AgentRuntime`, `AgentEngine`, `TurnCoordinator`       | L1     |
| Turn State         | `TurnState`, `TurnContext`, `TurnRecord`               | L1     |
| Event Reducer      | `EventReducer`, `StateReducer`, `ProjectionUpdater`    | L1     |
| Conversation View  | `ConversationView`, `PromptBuilder`, `MessageHistory`  | L1     |
| Tool Scheduler     | `ToolScheduler`, `ToolCoordinator`, `ExecutionPlanner` | L1     |
| Permission Service | `PermissionService`, `ApprovalService`, `AccessController` | L1 |

---

## 10. Relationship to other modules

```
Agent Loop (this document)
    ├── ToolSystem        (ToolRegistry, ToolRuntime, ToolContract — see ToolContract RFC)
    ├── Provider          (ProviderAdapter, ProviderCapabilities — see ProviderCapability RFC)
    ├── PermissionService (Permission/Mode/Risk policy)
    ├── Storage           (SessionEventStore, ProjectionStorage)
    ├── MemoryPipeline    (cross-session knowledge extraction)
    └── SubagentRuntime   (Mailbox, InterAgentMessage)
```

---

## 11. To be detailed

- [ ] Concrete Tool Scheduler algorithm implementation
- [ ] Concrete Permission Risk Level classification
- [ ] Concrete Context Budget allocation strategy
- [ ] Concrete Compact Boundary schema
- [ ] Concrete Error Recovery retry strategy
- [ ] Hook System integration points with the loop

---

## 12. References

- [Model Context Protocol](https://modelcontextprotocol.io)
