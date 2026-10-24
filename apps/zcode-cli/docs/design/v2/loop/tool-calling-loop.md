# Tool Calling Loop Implementation Plan

> Model anomaly fallbacks and tool call counting policy: see [`model-anomaly-fallbacks.md`](./model-anomaly-fallbacks.md).
> ZCode targets long-running tasks, so the tool call count has no hard stop condition. Context/token
> limits trigger auto compact; provider context overflow triggers reactive compact.

## Core loop

> Steering semantics for input sent while a turn runs: see [`turn-steering.md`](./turn-steering.md).
> Pending input may only be drained at the next model request boundary after tool results are injected,
> never between the assistant tool calls and their tool results.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Tool Calling Loop                          │
│                                                                  │
│   ┌──────────────┐                                               │
│   │  User Input  │                                               │
│   └──────┬───────┘                                               │
│          │                                                        │
│          ▼                                                        │
│   ┌──────────────┐     ┌──────────────┐                          │
│   │  Call Model  │────▶│ Has Tool     │                          │
│   │  (messages)  │     │   Calls?     │                          │
│   └──────────────┘     └──────┬───────┘                          │
│          ▲                     │                                 │
│          │                     No                                  │
│          │                     │                                   │
│          │                     ▼                                   │
│          │              ┌──────────────┐                          │
│          │              │   Return     │                          │
│          │              │   Response   │                          │
│          │              └──────────────┘                          │
│          │                                                        │
│          │                     Yes                                │
│          │                     ▼                                  │
│          │            ┌──────────────┐                           │
│          │            │   Schedule   │                            │
│          │            └──────┬───────┘                            │
│          │                  │                                     │
│          │                  ▼                                     │
│          │          ┌──────────────┐                            │
│          │          │   Execute    │                             │
│          │          │   Tools      │                             │
│          │          └──────┬───────┘                             │
│          │                 │                                     │
│          │                 ▼                                     │
│          │          ┌──────────────┐                             │
│          │          │ Inject Tool  │                            │
│          │          │  Results     │                             │
│          │          │  (messages)  │                             │
│          │          └──────┬───────┘                             │
│          │                 │                                     │
│          │                 ▼                                     │
│          │          ┌──────────────┐     ┌──────────────┐        │
│          │          │ Call Model   │────▶│ Has Tool     │        │
│          │          │ (continue)   │     │   Calls?     │        │
│          │          └──────────────┘     └──────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. Component responsibilities

| Stage | Component | Responsibility |
|------|------|------|
| Call Model | `AgentRuntime` | Maintains messages, calls the model adapter |
| Permission Check | `PermissionService` / broker | See `permission-broker.md` (originally skipped in this plan) |
| Schedule | `ToolScheduler` | Topological sort, determines parallel groups |
| Execute | `ToolExecutor` | Executes tools, returns results |
| Inject Results | `MessageHistory` | Appends tool results to messages |
| Drain Pending Input | `AgentRuntime` | Appends user input from the active turn queue as user messages |
| Continue | Loop | Exits when there are no tool calls |

The executor may stop later batches because of permission denial, cancellation or a high-risk failure,
but the provider-visible history must still inject one tool result for every tool call returned by the
assistant in this round. If a later batch did not actually run, the executor returns a synthetic
skipped/error result, so the next model request has no dangling tool call.

---

## 2. Implementation structure

- `MessageHistory` (`packages/core/src/agent/message-history.ts`): session-level message history reused
  across turns of one runtime. Operations: `init(systemPrompt?)`, `addUser`, `addSystem` (necessary
  runtime context only; never used for a tool call count hard stop), `addAssistant(content, toolCalls?)`,
  `addToolResult(toolCallId, toolName, content, success)` (a failure is stored as
  `JSON.stringify({ error: content })`), `toModelMessages()`, `getMessageCount()`,
  `getCacheableMessages()`.
- `Runtime.executeTurn` (`packages/core/src/runtime.ts`), core loop per turn:
  1. Create `turnId` / `traceId`, start the `TurnMachine`, append the `turn_started` event.
  2. `history.addUser(input)`.
  3. Loop: call the model with `history.toModelMessages()`, cached tools and the abort signal; record
     usage (for cache analysis).
  4. No tool calls: `history.addAssistant(text)`, complete the `TurnMachine`, append `turn_complete`
     (response, tokenCount, toolCallCount, duration, `resultType: 'success'`), increment the turn number,
     rebuild the projection and return `{ response, turnId, events, projection }`.
  5. Tool calls: `toolCallCount += toolCalls.length` (telemetry only; long-running tasks are bounded by
     cancellation, permissions, tool contracts, provider retry limits and context/token compaction, never
     by a global tool call count), `history.addAssistant(text, toolCalls)`, schedule tools, emit
     `tool_call_scheduled` for each item, execute per schedule, feed each result to the `TurnMachine`
     (`completeTool`, then `aggregateResults`), inject results with `history.addToolResult(...)`
     (non-string output is JSON-stringified), and loop back to the model call.
- `extractToolCalls` (`packages/adapters/src/model/transform.ts`): collects the tool calls
  (`{ id, name, input }`) of assistant responses from the generate result.
- Tool cache (`packages/core/src/runtime.ts`): `getTools()` caches `registry.toContracts()`;
  `registerTool(entry)` registers and invalidates the cache.

---

## 3. Permission check integration

For each tool call: look up the registry entry (missing: `{ allowed: false, reason: 'Tool not found' }`);
build a `PermissionContext` (`toolName`, `input`, `riskLevel` from entry metadata, `mode` default
`'auto'`); call `permissionService.checkPermission`; for a non-allowed decision emit the permission
request event (`emitPermissionRequest`) and record the decision. The ask/broker flow is specified in
`permission-broker.md`.

---

## 4. Scheduling and execution

The schedule result is the runtime execution contract, not a log or hint. The runtime must hand
`ToolSchedule.parallelGroups` to the executor's `executeSchedule()`; after obtaining a schedule it must
not fall back to `executeBatch()` and run all tool calls in parallel at once. This is what makes
parallel read-only tools, serial side-effecting tools, dependency order, permission blocking and failure
short-circuit observable on a single state machine path.

Concurrency is decided per input: if a tool provides `resolvePermissionCapability`, scheduling and the
permission check use the same runtime capability (for example, a read-only Bash that does not change
directory declares `concurrentSafe: true`); otherwise they fall back to static metadata. Resolution order
is runtime capability > `entry.permission` > metadata. `scheduleTools` builds a `ToolDependency` per call
(`toolCallId`, `toolName`, `dependsOn: []` plus the scheduling flags) and calls
`toolScheduler.schedule(...)`; `toScheduleState` maps the schedule to `ToolScheduleState` (`items`,
`parallelGroups`, `executionOrder`).

The execution phase must meet these event and cancellation contracts:

1. Each scheduled tool call writes `tool_call_scheduled` before execution; the payload contains at least
   `toolCallId`, `toolName`, `input`, `dependencies`, `parallelGroupIndex`, `canRunParallel` and the full
   schedule summary.
2. At the start of each parallel group only the persisted tool parts of that group are marked running;
   after the group completes, `tool_batch_complete` is written.
3. The `TurnMachine` phase truly drives the loop:
   `ProcessingInput -> AwaitingModelResponse -> Streaming -> SchedulingTools -> ExecutingTools -> AggregatingResults -> AwaitingModelResponse/Completing`.
4. `executeTurn(..., { abortSignal })` must pass the same signal to the model adapter, the tool executor
   and every `ToolExecutionContext`; cancellation at any layer is attributed to the same `traceId`.

---

## 5. Cache awareness

- `MessageHistory` exposes `getCachedMessageCount()` / `setCachedMessageCount(count)` (the current
  cached prefix size, used to judge cache hits).
- `recordUsage(usage)`: when the provider reports `cacheReadTokens > 0`, record the cache hit
  (`lastCacheHit`, `lastCacheTokens`) for cache statistics.

---

## 6. Full loop sequence

```
Turn Start
    │
    ▼
┌────────────────────────────────────────┐
│ Add User Message to History           │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│ LOOP: Call Model                       │
│   - messages = history.toModelMessages│
│   - tools = registry.toContracts()     │
│   - result = model.generate()         │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│ Check Tool Calls                       │
│   - If empty: BREAK, return response  │
│   - If has calls: CONTINUE            │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│ Add Assistant Message (with calls)     │
│   history.addAssistant(text, calls)    │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│ Permission Check                       │
│   - permissionService.check()         │
│   - emit permission_requested event  │
│   - filter denied tool calls          │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│ Schedule Tools                         │
│   - scheduler.schedule()              │
│   - emit tool_call_scheduled event    │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│ Execute Tools (sequential)             │
│   - executor.executeSchedule()        │
│   - emit tool_call_started/complete    │
└────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────┐
│ Inject Tool Results                    │
│   - history.addToolResult()           │
│   - one message per tool result       │
└────────────────────────────────────────┘
    │
    ▼
         LOOP BACK TO Call Model
```

---

## 7. Task list

| # | Task | File | Depends on |
|---|------|------|------|
| 1 | MessageHistory class | `agent/message-history.ts` | none |
| 2 | extractToolCalls | `adapters/model/transform.ts` | none |
| 3 | Runtime tool loop | `runtime.ts` | 1, 2 |
| 4 | Tool cache | `runtime.ts` | 3 |
| 5 | Permission check integration | `runtime.ts` | 3 |
| 6 | Cache-aware statistics | `agent/cache-aware.ts` | 1 |
| 7 | Unit tests | `runtime.test.ts` | 1-5 |

---

## 8. Verification cases

```
Case 1: No tool call
  Input: "Hello"
  Model: "Hi!"
  Output: "Hi!"

Case 2: Single tool call
  Input: "Read package.json"
  Model: (calls Read tool)
  Execute: Read package.json
  Result: "{ name: "test" }"
  Model: "The package.json contains..."
  Output: "The package.json contains..."

Case 3: Multiple tool calls
  Input: "Read all config files"
  Model: (calls Read x3)
  Execute: Read file1, file2, file3
  Result: content1, content2, content3
  Model: "Here are the configs..."
  Output: "Here are the configs..."

Case 4: Long-running tool calls
  Input: (triggers many tool calls)
  Count > 100
  Event: telemetry/log records toolCallCount
  No hard stop; tools remain available
  Context/token limit may compact before the next model request

Case 5: Tool execution failure
  Input: "Do something"
  Model: (calls Tool X)
  Execute: FAIL
  Result: { error: "..." }
  Model: "The operation failed because..."
  Output: "The operation failed..."
```
