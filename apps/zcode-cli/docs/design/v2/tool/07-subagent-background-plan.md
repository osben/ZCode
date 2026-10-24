# Background Subagent v1 Implementation Plan (historical)

> **Document status (2026-07-10)**: this document keeps the implementation boundary and background of
> the first background subagent version. It is no longer the complete current behavior contract. The
> current implementation follows the overview in [Subagent Tool](./07-subagent.md); the two-way
> main/child message contract is defined by
> [Subagent RespondToCoordinator](../../../../../../docs/subagent-respond-to-coordinator.md).
> Statements here such as "v1 does not support `SendMessage`" describe the original stage only and do
> not override capabilities that landed later.

## Goal

On top of the existing synchronous one-shot `Agent(Explore)`, add the first background subagent version:

- The model can start a background `Explore` through `Agent({ run_in_background: true, ... })`.
- The `Agent` tool returns a background task reference immediately and does not block the parent turn.
- The child agent keeps running in the same process; state, progress and final result are written to the session event store.
- After completion, failure or cancellation, it re-enters the parent session as a model-visible task notification.
- v1 is background only, with no user-visible `SendMessage`/resume; but the task/transcript contract must leave room for later resume. The current implementation has already added `SendMessage` and the child `RespondToCoordinator` reply channel on this contract.

Non-goals:

- No worktree, fork, remote, teammate/team, MCP, hooks or agent skills.
- No write-capable child tools; background `Explore` still allows only `Read`, `Glob`, `Grep`.
- A background child agent neither asks the user directly nor recursively calls `Agent`.

## Design points

Background lifecycle and notification:

- `run_in_background` or the agent definition `background: true` takes the async path.
- The async path first registers a background task, then consumes the child message stream fire-and-forget.
- The tool result returns `async_launched`, containing `agentId`, `description`, `prompt`, `outputFile`.
- The background lifecycle keeps maintaining progress; at a terminal state it updates task state first, then does the slower cleanup.
- After completion it is injected into the parent session through `<task-notification>`, not stuffed back synchronously into the original tool call.
- Foreground-to-background conversion (close the current iterator first, then rerun in the background with the same task id), worktree, handoff review and `SendMessage` are not implemented in v1.
- Resume relies on persisted child history + metadata, not an in-memory task map.

Independent child session:

- Each subagent creates its own child session; the task id can resume the same child session.
- The child agent's permissions derive from the parent ruleset and explicitly disable disallowed recursion and write tools.
- The running/completed/error state of a tool part lives in the session message parts.
- The model is "a subagent is an independent session", without synchronous blocking.

Control plane:

- A shared control plane owns spawn, send input, resume, wait, close.
- Each subagent inherits the parent turn's runtime config, cwd, approval, sandbox and environment selection.
- spawn returns an id immediately; wait waits for the terminal state through a status subscription.
- The registry maintains the agent tree, names, spawn limit and last task message.
- ZCode v1 adds a background task API alongside `SubagentPort.run()` instead of letting the tool executor poll an internal Promise.

## v1 contract

### Agent input

`AgentInputSchema` gains:

```ts
run_in_background?: boolean
```

Rules:

- Only `true` triggers background; omitted or `false` keeps synchronous one-shot.
- v1 allows only `subagent_type: "Explore"`.
- A background tool call still requires `description` and `prompt`.
- A background task is not bound to the parent `AbortSignal`; cancelling the parent turn must not kill a child that is already backgrounded. An explicit stop/kill API comes later.

### Agent output

`AgentOutput` is extended to a union:

```ts
type AgentOutput = AgentCompletedOutput | AgentBackgroundedOutput

interface AgentBackgroundedOutput {
  status: "backgrounded"
  agentId: string
  agentType: "Explore"
  description: string
  prompt: string
  childSessionId: SessionId
  backgroundTaskId: string
}
```

Model-visible text:

- Start success: `Agent <agentId> is running in the background. You will receive a task notification when it completes.`
- No internal event content other than the full prompt is exposed.

### SubagentPort

Background is not squeezed into the Promise semantics of the existing `run()`; the port is extended into an explicit control plane:

```ts
interface SubagentPort {
  run(request: SubagentRunRequest, options?: SubagentRunOptions): Promise<AgentOutput>
  start?(request: SubagentStartRequest, options?: SubagentStartOptions): Promise<AgentBackgroundedOutput>
  getTask?(agentId: string): Promise<SubagentTaskSnapshot | undefined>
}
```

The v1 runtime implements `start()` and an in-memory `getTask()`; `ToolExecutor` projects `Agent` background tasks into generic `background_task_*` events through `getTask()`, and the CLI/TUI panel and later `wait`/`resume` keep reusing this interface.

### Events

Reuse and extend existing session events instead of adding a parallel state store:

- `subagent_spawned`: adds `background: true`, `childSessionId`, `allowedTools`, `status: "running"`.
- `SessionEventType.SubagentMessage` (event type `subagent_message`): optional; v1 records only a progress summary and does not pour the full child transcript back into the parent session. It is a lifecycle/progress event, not the synthetic user message source later used by `RespondToCoordinator`.
- `subagent_stopped`: records `status: "completed" | "failed" | "cancelled"`, duration, tool count, token usage, error.
- `background_task_started/updated/completed`: may keep serving as generic task events for the UI projection, payload `toolName: "Agent"`, `description`, `taskId: agentId`.
- `user_message` or a dedicated notification event: after background completion a parent-model-visible task notification must be generated and injected before the next model request.
- The later `RespondToCoordinator` replies do not reuse the progress event above. They are delivered through a runtime command with `mode: "subagent-message"` and written as a user-like synthetic message into the parent model history and parent session store; the source is likewise `subagent_message`, but visibility is `model-only`, fully storing the XML-escaped `summary` and `message`.

Principles:

- Child runtime tool/model/turn events are written to the child session.
- The parent session's subagent lifecycle projection stores only spawn/progress/stop/notification summaries, not a bulk copy of the child transcript.
- `RespondToCoordinator` is an explicit later exception: after the response command is drained by the parent, the parent session stores the full coordinator response carrier for current delivery, hydrate/resume and later parent-model context continuity. It does not enter the top-level user message list, session title or `ReadSessionContext`, but exports, diagnostics and storage budgets that read the raw session store must treat it as possibly containing full content; compact may also absorb its meaning into summaries.
- All events inherit the same `traceId` and record the parent `sessionId`, `turnId`, `toolCallId`, child `sessionId`, `agentId`.

## Implementation phases

### M0: Spec and test skeleton

- Update `docs/design/v2/tool/07-subagent.md` and this plan.
- Update `packages/contracts/src/tools/agent.ts`: input/output schema gets the background union.
- Update `packages/contracts/src/interfaces/subagent.port.ts`: add `start` and the task snapshot type.
- Add contract tests proving JSON schema, registry projection and output schema cover background.

### M1: Background task control plane

- Add `SubagentTaskService` or implement `startExploreSubagentTask()` under `core/src/subagent`.
- Start flow:
  1. Create a stable `agentId` and `childSessionId`.
  2. Write parent `subagent_spawned`, and have the tool executor write `background_task_started` through `getTask()`.
  3. Run the child `AgentRuntime` fire-and-forget.
  4. Maintain minimal progress while running: tool call count, last tool, token usage.
  5. At the terminal state write `subagent_stopped` and have the tool executor poll to write `background_task_completed`.
  6. Enqueue the parent session task notification.
- The background task's `AbortController` is independent of the parent turn; best-effort cancel on process shutdown.

### M2: Agent tool wiring

- `agentHandler` detects `run_in_background === true`.
- If `context.subagentPort.start` does not exist, return a structured configuration error.
- The `Agent` entry's `outputSchema` allows the completed/backgrounded union.
- The background path returns `status: "backgrounded"` immediately and does not wait for the child runtime.
- The executor's result serialization must not wait for an artifact for `backgrounded`.

### M3: Notification injection

- Add a session pending notification queue to `AgentRuntime`, or reuse the existing turn steering/notification mechanism.
- After background completion generate a structured parent message, for example:

```xml
<task-notification>
  <task-id>agent_xxx</task-id>
  <tool-use-id>tool_xxx</tool-use-id>
  <status>completed</status>
  <summary>Agent "..." completed</summary>
  <result>...</result>
</task-notification>
```

- Drain the notification before the next parent model request; it must not be inserted between an assistant tool call and its tool result.
- Failure/cancellation must also notify; a failure result contains an actionable error summary.

### M4: Persistence and resume preparation

v1 does not expose model-callable resume, but must persist this state:

- Child session events are already replayable through the child `sessionId`.
- The parent event records `agentId -> childSessionId`.
- The task snapshot records `agentType`, `description`, `prompt`, `status`, `createdAt`, `completedAt`, `resultSummary`, `error`.
- After a process restart, a running background task is marked `lost` or `interrupted` and does not pretend to keep running.

Later resume implements:

- `resumeAgent(agentId)` finds the child session from the parent event.
- Filter unpaired tool calls.
- Append a new user prompt and rerun the child runtime.

### M5: UI / CLI projection

- The TUI does not read the task service directly; it only consumes the session projection.
- The projection aggregates `background_task_*` and `subagent_*` into a task list.
- CLI headless mode only outputs `Agent ... running in background`; the final notification is handled by a later turn.

## Test plan

Minimum tests:

- `Agent` contract exposes `run_in_background` and background output union.
- background Agent call returns immediately without waiting for child runtime.
- parent cancel after background start does not cancel child task.
- child completion emits `subagent_stopped` and `background_task_completed`.
- child failure emits failed status and a notification.
- child runtime only receives `Read`, `Glob`, `Grep`; no `Agent`, `Bash`, `Write`, `Edit`, `AskUserQuestion`.
- notification is injected before the next model request and not between assistant tool call/result pairs.
- trace propagation includes parent and child ids.
- resume/restart with running task marks it `lost` or `interrupted`.

## Risks and trade-offs

- A fire-and-forget task inside a Node process cannot continue after the process exits; v1 must honestly mark it `lost`.
- Proactively "waking" the parent turn after a background task completes would change the current runtime loop; v1 only enqueues the notification, drained by the next turn.
- Not doing `SendMessage` in v1 limits the interactivity of background agents but significantly reduces consistency risk; this trade-off has been superseded by the later `SendMessage` / `RespondToCoordinator` contract.
- The child's full transcript is still not injected into the parent session, to avoid context explosion. The parent session receives lifecycle/completion summaries, plus the full single reply that the child explicitly addresses to it via `RespondToCoordinator`; the latter is not a transcript mirror.
