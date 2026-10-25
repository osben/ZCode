# zcode-cli background subagent wake-up contract

This is the design contract for background subagent completion wake-up and the
foreground-subagent auto-background mechanism, built on the existing `Agent` tool /
profile loader / child runtime / `RuntimeTaskRegistry` (implemented as the runtime
command queue in `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`).

## Expected behavior

- `Agent(run_in_background=true)` returns `async_launched`, and the main agent can
  finish/go idle normally.
- When a background subagent completes, the parent runtime automatically triggers
  one model-only turn, injecting the `<task-notification>` as `background_task`
  synthetic user input into the provider request so the main agent can continue
  processing the result.
- If completion happens while the parent turn is still active, the active turn's
  pre-request drain is reused instead; no second injection.
- A foreground subagent auto-backgrounds at the configured threshold (120000 ms when
  enabled); it is off by default and enabled only through config.

## Non-goals

These capabilities already exist or are explicitly out of scope:

- Reimplementing the `Agent` tool or the Claude Code-compatible `Task` alias.
- Reimplementing the profile loader, user/project `.zcode/agents` Markdown loading,
  or plugin agent loading.
- Making `Explore` the default agent. Omitting `subagent_type` defaults to
  `general-purpose`; `Explore` is only a specialized built-in.
- Reimplementing the `general-purpose` / `Explore` built-in profiles, child runtime
  creation, artifact writing, `SendMessage`.
- Teammate, swarm, workflow, worktree isolation, model-facing `TaskCreate` /
  `TaskList` / `TaskUpdate`.
- Recovering running background subagents after process restart, or persisting an
  unconsumed notification outbox; the queue is in-process runtime state, not a
  durable outbox.

Later phases (P1+): `background_tasks` control request / Ctrl+B style UI or SDK
entry points; `TaskStop` / `TaskOutput` compatibility surfaces.

## Background notification queue

The queue is runtime-internal and in-process. It is designed for multiple runtime
task sources from the start: `local_agent` background subagents first, with
`local_bash` and `monitor_mcp` meant to join the same queue/wake design later. The
API and idempotency fields are not hardcoded to subagents, but earlier phases are
not blocked on Bash/monitor integration.

Data shape:

```ts
interface PendingBackgroundTaskNotification {
  id: string;
  taskId?: string;
  toolUseId?: string;
  source: "local_agent" | "local_bash" | "monitor_mcp";
  text: string;
  traceContext: TraceContext;
  queuedAt: Date;
}
```

Key constraints:

- Idempotency by `taskId + toolUseId + terminal status` or notification `id`, so
  completion/failure paths cannot double-enqueue.
- Active-turn drain and idle wake consume the same queue; an idle wake must claim
  first, then start the model-only turn, so the pre-turn drain does not inject twice.
- Each runtime command drain synchronously snapshots the queue. If the next runnable
  command is a `task-notification`, one claim takes all same-priority
  `task-notification` commands from that snapshot and joins them, in queuedAt /
  admission order, into one batch input separated by blank lines.
- A batch never crosses priority and never absorbs notifications enqueued after the
  claim; there is no microtask, debounce, or other waiting window. Late arrivals
  wait for the next legitimate notification drain: if the current batch's outer turn
  produces a tool continuation, the existing active-loop drain can merge them into
  the same turn's next provider request; if the current request goes terminal, the
  next outer drain claims them.
- Batching covers `task-notification` mode only; `prompt`, `target-continuation`,
  and `subagent-message` keep their own consumption semantics. If the same-priority
  queue starts with a notification, it may skip other modes to collect the same-mode
  items; if another mode is selected first, that command runs first.
- A whole batch persists as exactly one `background_task` / `model-only` synthetic
  user message; each notification's ledger input settles independently and points at
  that message, so cold hydration does not rebuild one batch of results as several
  empty turns.
- No batch-specific metadata/schema is added. If every batch member has structured
  `originMeta`, the ordinary `BackgroundResultOriginMeta` is reused:
  `backgroundSource/workId` take the earliest-admission member as the display/tracking
  anchor, and `title` is composed in admission order; show at most the first three
  titles, then append `· +N`. The persisted synthetic message and the live turn must
  reuse the same composed object. If any member lacks structured metadata, never
  reverse-parse the `<task-notification>` text; the whole batch takes the
  no-`originMeta` compatibility path.
- If, after claiming, the runtime turns out to be active again, the batch must go
  back to the queue head or the claim must be dropped and rescheduled —
  notifications are never lost.
- Once claimed, a notification command is scheduled at-most-once: a terminal
  provider/model failure or stop does not re-enqueue the command, preventing double
  wake-ups. At the same time, the whole batch's model-only synthetic input must be
  persisted before the query; so failure/stop only ends that assistant/model turn,
  and the notification content stays in the transcript for later legitimate input to
  carry. Bounded attempt retries inside a provider adapter belong to the same query
  and are not a command re-delivery.

## Idle wake scheduler

A lightweight scheduler inside the runtime, not a new app stdio protocol.

Triggers:

- After `enqueueBackgroundTaskNotification()` successfully queues, schedule a wake
  ("enqueue").
- After `finishActiveTurn()` clears the active turn, if the queue still has
  pending items, schedule a wake ("turn_finished"). This covers the race where the
  notification arrives while the parent turn is active but its last model request
  has already ended.

Execution:

1. Synchronously claim all eligible notifications at the moment the scheduler/drain
   is actually runnable — no waiting for same-tick results, no debounce.
2. If `activeTurn` exists, log debug/info and exit; wait for the active drain or
   `finishActiveTurn()` to schedule again.
3. If nothing is pending, no-op.
4. Claim the pending batch.
5. Call
   `executeTurn(batchText, undefined, { inputVisibility: "model-only", inputSource: "background_task", displayInput: "Background task completed", inputId: "background-task:<first-id>", traceContext })`.
6. The provider-visible latest user content of that turn is the
   `<task-notification>`; the UI-facing snapshot must not gain a real user bubble.

Notes:

- Never inject real user text such as "continue" / "please continue".
- Do not go through `recordExternalUserPrompt`, so a background completion is never
  recorded as user input.
- The wake turn reuses the existing model request / tool loop / persistence / event
  paths, so the main agent can keep calling tools or replying.

## Completion enqueue

`finalizeBackgroundCompletion()` / `finalizeBackgroundFailure()` own:

- Writing `metadata.json` / `output.txt` / `task.output` / the transcript artifact.
- Updating `RuntimeTaskRegistry` terminal state, `notified: true`, and usage.
- Emitting `SubagentStopped` / `BackgroundTaskCompleted` and similar events.

Notification delivery goes through the queue API with:

- `source: "local_agent"`.
- `id` = task/agent id plus terminal status (idempotency).
- `taskId` = `agentId` / backgroundTaskId.
- `toolUseId` = the parent tool call id.
- `text` generated by `formatTaskNotification()`, keeping the user-like
  `<task-notification>` form.

## Foreground auto-background timer

Added to the existing foreground `run()` path; it does not restart the child and
does not change the direct-background `start()` path.

Config:

- `AgentRuntimeConfig.subagents.autoBackgroundMs?: number`.
- Default `0` / `undefined` (off).
- Bootstrap config mapping sets `120000` when the switch is on; a future product
  beta flag uses the same field. Tests may pass a short threshold directly.

Lifecycle:

- After foreground `run()` registers the task, if `autoBackgroundMs > 0`, start the
  timer.
- Timer expiry only calls `registry.requestBackground(lifecycle.agentId)`.
- The timer is cleared on completion, failure, abort, and manual backgrounding.
- After the timer fires, the foreground race takes the existing
  `waitForBackgroundRequest()` branch, returns `async_launched`, and the child
  completion promise keeps finalizing in the background.

## Logging

Using the runtime/core logger:

- `info`: notification queued, idle wake started/completed, auto-background
  triggered — low-frequency lifecycle events.
- `debug`: wake skipped because active/no pending, duplicate ignored, batch size.
- `warn`: wake turn failed to start, requeue needed after claim, timer fired but the
  task is missing or already terminal.

Never log every streaming chunk / tool delta at info.

## Acceptance

- With `Agent(run_in_background=true)`, the parent turn can finish first; after the
  child completes, the parent runtime automatically starts a model-only continuation
  request with no further user input.
- The auto-wake provider-visible request contains a user-role `<task-notification>`,
  with no `<system-reminder>` wrapper and no extra real user text.
- The session store shows the synthetic notice with `source: "background_task"`;
  the UI-facing projection does not render it as a user-sent message.
- A foreground subagent auto-backgrounds only when configured; the default behavior
  is unchanged.
- After auto-backgrounding, the tool result is still `async_launched` and completion
  goes through the same notification/wake path.
- `general-purpose` stays the default agent; `Explore` does not become default.
- Usage: the background completion's `totalToolUseCount`, event payload, metadata,
  and `<usage><tool_uses>` come from real child runtime event aggregation — never
  regress to 0 (covered by a test where the child has multiple tool results).

## Risks / invariants

- **Reentrancy**: a wake turn must never start while an active turn is running;
  guard on both `activeTurn` and `finishActiveTurn()`.
- **Double injection**: with active drain and idle wake sharing one queue,
  claim/drain must be atomic.
- **User-input pollution**: a background wake must not use the normal user-prompt
  persistence path and must not create a real user bubble.
- **Retry/loss boundary**: only same-query provider attempts may retry with a bound;
  a terminal failure/stop never re-enqueues a claimed command, but the pre-query
  persisted batch input is preserved, and later requests must neither lose content
  nor inject it twice.
- **Mobile/remote**: this stays inside the zcode-cli runtime. If app/service idle
  wake is ever wired into the remote-control link, a separate spec must define the
  desktop continuous and web-remote replayable boundaries.

## Open follow-up

Unify the other background runtime tasks — `local_bash` (which already has
`BackgroundTaskTracker` completion enqueue) and `monitor_mcp` (entry point to be
confirmed) — into the same queue/wake mechanism once the subagent background path is
stable. Full convergence of the Bash/monitor provider-visible XML shapes is
evaluated within that phase and does not block subagent background acceptance.
