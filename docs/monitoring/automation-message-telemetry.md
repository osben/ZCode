# Scheduled-task / off-peak-task message telemetry

> Status: message-source attribution for scheduled tasks (MVP) is wired. Off-peak tasks V1 use the same
> message event chain; the contract is in `docs/monitoring/off-peak-task-telemetry-v1.md`. The "future off-peak
> task" and telemetry outbox parts of this document are a historical evolution plan; where they conflict with V1,
> that contract wins, and V1 implements no outbox/retry/restart replay.

## Goals

1. Scheduled tasks and (future) off-peak tasks are real Agent input turns and reuse the ordinary chat
   `message_completion` and `agent_step`, so latency, tool use, tokens and success rate compare uniformly.
   Only a minimal source dimension is added; no prompt body, file path or tool input/output is uploaded.
2. When a scheduled-task tool creates a rule, the existing `automationId` links `agent_step.tool_name=CronCreate`
   to later `message_completion`s. If the reporting path must not carry the raw UUID, send its stable hash; no
   second domain ID is introduced.

```text
Ordinary chat
UI commandId/inputId
        |
        +-- SessionPane ACK -> UI telemetry seed
        |
        +-- message_completion / agent_step -> /event/report

Scheduled task (implemented)
automation_runs.runId -> Host traceId -> inputId/sourceCommandId
        |                         |
        +-- trigger: schedule/manual
        +-- automationId (rule-level stable correlation key; this run's execution context)
                                  |
                                  +-- CLI TurnStarted establishes the trusted telemetry seed

Off-peak task (not implemented)
Spec: offPeakTaskId -> future Host sendPrompt -> inputId/sourceCommandId
```

## 1. Ordinary message event definitions

Common correlation fields:

| Field                           | Meaning                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `talk_id`                       | task / session ID.                                                                                             |
| `message_id`                    | Current input turn ID; in V4 it is `sourceCommandId` / `inputId`. Completion and steps of one turn must match. |
| `model_name` / `model_provider` | The model and provider actually used in this turn.                                                             |

### `message_completion`

Final summary of one Agent input turn; at most one per `talk_id + message_id`.

| Group                                     | Fields                                                                                                                 | Meaning                                                                                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latency                                   | `request_time`, `duration_ms`, `time_to_first_token`, `waiting_ms`                                                     | Send time, end-to-end duration, time to first token, accumulated waits such as permission.                                                                                                                  |
| Usage                                     | `input_tokens`, `output_tokens`, `reasoning_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `total_tokens` | Main Agent usage of this turn.                                                                                                                                                                              |
| Steps and tools                           | `agent_step_cnt`, `tool_call_total`, `tool_call_failed`                                                                | Number of closed steps and tool-call statistics of the turn.                                                                                                                                                |
| Result                                    | `status`, `error_type`, `error_msg`                                                                                    | `success` / `fail` / `user_interrupt`; failure attribution uses `error_type`; non-empty raw `error_msg` is uniformly `[redacted]`, an empty string stays empty.                                             |
| Plan identity                             | `plan_status`, `plan_product_id`                                                                                       | User plan identity frozen at send time: `coding_plan` / `start_plan` / `no_plan` / `unknown`; the backend stable product ID of the current plan.                                                            |
| Source and correlation (new)              | `message_source`, `task_trigger`, `automation_id` / `off_peak_task_id`                                                 | Written to `event_extra_detail`; state the source and the schedule/immediate run mode and link a scheduled task's creation turn with its later runs.                                                        |
| Scheduled-run timing (new, schedule only) | `scheduled_at`, `schedule_lag_ms`                                                                                      | Written to `event_extra_detail`: the planned trigger Unix-ms timestamp, and the Host admission time minus `scheduled_at`. Only for `task_trigger=schedule`; empty for manual runs; not copied to each step. |
| Compatibility                             | `file_change_cnt`, `generated_code_lines`, `ask_mode`, `retry_cnt`                                                     | Existing report-compatible fields; some keep historical fixed definitions.                                                                                                                                  |

### `agent_step`

A closed execution step within a turn; `message_completion.agent_step_cnt` must equal the number of steps
actually reported for that turn.

| Group                        | Fields                                                                      | Meaning                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order and type               | `step_id`, `loop_index`, `step_type`, `is_tool_call`                        | `step_id` is the stable unique ID of a closed step within one `message_id`, `loop_index` the in-turn order; types `reasoning` / `generation` / `tool_call`. |
| Tool                         | `tool_name`, `tool_call_id`                                                 | Tool step name and call ID; empty for non-tool steps.                                                                                                       |
| Latency and result           | `duration_ms`, `waiting_ms`, `generation_tail_finalize_ms`, `status`        | Step duration, permission wait, text last-frame closing latency, success/failure/timeout.                                                                   |
| Usage and error              | `input_tokens`, `output_tokens`, `cached_tokens`, `error_type`, `error_msg` | Step usage under the compatibility definition; failure attribution uses `error_type`, non-empty raw `error_msg` is `[redacted]`, empty stays empty.         |
| Source and correlation (new) | `message_source`, `task_trigger`, `automation_id` / `off_peak_task_id`      | Same as the owning `message_completion` for ordinary input; the completion woken by an independent background subagent refines the source.                  |

`send_btn` is a user click/submit event and must not be forged by background automation; automation reuses only
completion and step.

`step_id` is not just a report field: one input turn may legally produce several `agent_step`s, and after a
retry or Host restart the same closed step must keep the same `step_id`. For reliable delivery the step's event
instance identity / outbox logical idempotency key / unique constraint is `message_id + agent_step + step_id`,
never just `message_id + event_type`.

## 2. Minimal source distinction

Both events keep the source fields:

```ts
message_source: "chat" | "background_subagent" | "background_task" | "scheduled_task" | "off_peak_task";
task_trigger: "schedule" | "manual" | "";
automation_id?: string; // scheduled task: the existing automationId used directly
off_peak_task_id?: string; // off-peak task: the existing offPeakTaskId used directly in future
```

Only `message_completion` with `message_source=scheduled_task` additionally has:

```ts
scheduled_at?: number; // automation_runs.scheduledAt, Unix ms; empty for manual
schedule_lag_ms?: number; // Host admission time of the input - scheduled_at; empty for manual
```

These describe a run, not a single Agent step, so they are not written to `agent_step`; all steps of the run
link back to that completion through the existing `message_id=runId`.

- Ordinary input: `chat` + empty `task_trigger`.
- Scheduler run at the planned time: `scheduled_task` + `schedule`.
- Scheduled task "Run now": `scheduled_task` + `manual`.
- Future off-peak task: `off_peak_task` + empty `task_trigger`; extend the trigger enum separately if an
  "execute now" semantic appears.

`message_source` is the warehouse filter field; `task_trigger` only adds how a scheduled task started. The
source of ordinary input, scheduled and off-peak tasks is determined at prompt admission and frozen on that
`inputId`. The main `agent_step` of an independent background notification keeps the existing `background_task`
admission source; only when a background subagent result is explicitly consumed and the admission source is
explicitly a subagent does the final `message_completion` refine to `background_subagent`; when the concrete
source cannot be identified it stays `background_task`.

A main turn woken by an independent background notification uses the same `message_source` field:
`background_subagent` when admission metadata explicitly identifies a subagent completion; otherwise
`background_task`. When a background result is consumed by active-loop merging during a user query, the current
turn stays `message_source=chat` and the source is not rewritten by the consumed result. When several background
notifications merge into one turn, the display `originMeta` may keep a representative task, but the causal source
is frozen only when all batch members share it; a mixed or missing source stays `background_task`, independent
of notification arrival order.

> **Never decide the source from IDs alone.** `talk_id` and `message_id` only say "whose turn is this"; read the
> source from `event_extra_detail.message_source` and a scheduled task's trigger from
> `event_extra_detail.task_trigger`.

```text
Trusted Host computes the source (not inferred from the session)
    |
    +-- UI ordinary input        -> chat
    +-- automation_runs.runId    -> scheduled_task + schedule/manual
    +-- future offPeakTaskId     -> off_peak_task
    |
    v
agent_step + message_completion of the same inputId reuse the same source
```

### Scheduled-task IDs, creation turn and run turn

Scheduled tasks and (future) off-peak tasks produce the standard `talk_id` and `message_id`. Scheduled tasks
already produce a trusted `prompt.accepted` telemetry fact through the CLI `TurnStarted`, seed the run turn and
emit standard completion/step events. Creating a rule and a later run are different input turns and must not
share a `message_id`; they correlate through the existing `automationId`.

```text
automationId = one persisted schedule rule
       |
       +-- runId #1 = one run at the planned time
       +-- runId #2 = next run at the planned time
       +-- runId #3 = user clicks "Run now"

automationId 1 : N runId
```

For one scheduled execution the `runId` is reused as-is by Host, Agent and telemetry input identifiers:

```text
automation_runs.runId
  = Host sendPrompt.traceId
  = V4 commandId
  = Agent inputId
  = telemetry sourceCommandId
  = /event/report message_id
```

This equality holds for both dispatch paths: reusing a bound session and creating a new session for a UI-created
unbound task. The session trace generated by `createTask` only describes the session-creation operation and must
not remain the `traceId/inputId` of the first automation prompt; otherwise the CLI cannot recognize
`manual` / `schedule` from the input ID, the renderer would not seed telemetry for that turn, and the whole turn
would lack `agent_step` and `message_completion`. The prompt sent after creating the session must explicitly
override it with this `runId`.

`talk_id` is the other axis: the session/task in which this run executes. A bound rule reuses its
`targetTaskId`; an unbound rule creates a task. A complete record reads:

```text
talk_id    = which session executed
message_id = which scheduled run in that session (runId)
```

| Field              | Scope and generation                                                                       | Use                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automationId`     | One per rule, constant across every schedule / manual run.                                 | `event_extra_detail.automation_id` of the creation turn and all run turns; **not** `message_id`.                                                                                |
| `runId`            | One per run: `automationId:scheduledAt` or `automationId:manual:uuid`.                     | Host `traceId`, then run-turn `inputId/sourceCommandId/message_id`; the idempotency namespace of this turn's telemetry. Completion is keyed by it; a step also needs `step_id`. |
| `scheduledAt`      | The theoretical trigger time of this run in `automation_runs` (Unix ms); empty for manual. | Written to this `message_completion.event_extra_detail.scheduled_at` and used for schedule lag; **not** the rule's cron expression.                                             |
| `talk_id`          | Session/task ID of this execution; bound rules reuse the target task, unbound create one.  | Groups this turn's completion and steps into the executing session; **not** the rule ID.                                                                                        |
| `cronAutomationId` | Session ownership marker in task meta.                                                     | UI grouping/tool isolation only; never use for message source or creation-to-run correlation.                                                                                   |

```text
Creation turn: ordinary chat
talk_id = T0
message_id = M0
agent_step { tool_name=CronCreate, status=success, automation_id=A }
                                      |
                                      | automation_runs later reference A many times
                                      v
Nth run turn: scheduled task
talk_id = T0 (bound session) or a new task
message_id = runId=R1
message_completion / agent_step {
  message_source=scheduled_task,
  task_trigger=schedule|manual,
  automation_id=A
}
```

The warehouse joins the creating `CronCreate` step and later runs through `automation_id=A`; the creation turn's
`M0` and the run turn's `R1` stay different so several runs of one rule are not merged into one message.

A future off-peak task reuses `offPeakTaskId`: the execution `message_id` uses its single-run ID (a run ID if the
implementation has one), cross-turn correlation writes `off_peak_task_id=offPeakTaskId`. Off-peak tasks are not
implemented, so `CronCreate` metrics must not be called "users who configured off-peak tasks".

### Users who created scheduled tasks through conversation (MVP)

No `task_configuration_created` event is added. The existing Agent tool step is the creation-success fact:

```text
element_name = agent_step
event_extra_detail.tool_name = CronCreate
event_extra_detail.status = success
event_extra_detail.automation_id = A (non-empty)
```

The warehouse filters on that and counts `count(distinct user_id)`, giving **"users who successfully configured
a scheduled task through conversation"**. `automation_id` joins the creation step to later execution data and is
not used for user de-duplication.

This MVP covers neither manually created scheduled tasks nor off-peak tasks: off-peak tasks are unimplemented,
and the current spec creates them from the composer via a direct service call, which does not naturally produce
a `CronCreate` agent step. If off-peak tasks keep that entry, no `agent_step` may be forged; a separate business
telemetry for their creation must be defined. If creation moves to an Agent tool, use a separate
`tool_name=OffPeakCreate` with `off_peak_task_id`, not `CronCreate`.

There is no independent `agent_id` message-correlation key. `talk_id + message_id` suffices to correlate one
execution; to relate Agent/provider keep using `agent`, `model_provider`, `model_name`, and never pass
`automationId` or `runId` off as `agent_id`.

### Usability of existing fields

| Existing field                  | Verdict                                       | Reason                                                                                                                                                   |
| ------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled `runId`               | Run-turn message ID and idempotency namespace | `runId -> Host traceId -> inputId/sourceCommandId`, unique per run. `message_completion` de-duplicates by it; several `agent_step`s also need `step_id`. |
| Scheduled `trigger`             | Usable as `task_trigger` source               | Persisted as `schedule` / `manual`.                                                                                                                      |
| Scheduled `automationId`        | Correlation key for creation and runs         | Written to `event_extra_detail.automation_id`; also used for this turn's tool isolation.                                                                 |
| `cronAutomationId` (task meta)  | Not usable for message classification         | Task-level ownership; later ordinary user messages in that session may carry it too.                                                                     |
| `inputId` / `sourceCommandId`   | Correlation only, not classification          | Every input has one.                                                                                                                                     |
| `clientMode=desktop-continuous` | Cannot classify                               | Ordinary desktop chat is the same as scheduled tasks.                                                                                                    |
| `querySource`                   | Not reused                                    | Internal model-request source, not a product-level message source.                                                                                       |
| `offPeakTaskId`                 | Future internal correlation key               | Off-peak tasks currently exist only as a spec: no runtime, repo, scheduler or UI.                                                                        |

## 3. Current MVP runtime chain and boundary

For ordinary V4 input, the renderer's `SessionPane` establishes the telemetry seed on the accepted ACK; live facts
then close into `agent_step` and `message_completion`.

The scheduler calls Host `dispatchCronRun -> sendPrompt` with `runId` as `traceId/inputId`. At trusted admission
the CLI publishes a body-free `prompt.accepted` fact, the desktop continuous workspace supervisor builds the
lifecycle from it, and the existing UI `/event/report` aggregation and reporting is reused.

```text
scheduler / Run now
  -> Host sendPrompt(runId, automationId)
  -> CLI TurnStarted (trusted admission fact)
  -> prompt.accepted telemetry fact (no body)
  -> desktop-continuous workspace supervisor
  -> agent_step* + message_completion
```

The MVP reuses only the desktop `desktop-continuous` live telemetry attachment and does not enter the mobile Web
`web-remote-replayable` snapshot/gap recovery. Reports can still be lost when the renderer is absent or the
attachment is not ready; unattended reliable delivery would need a Host telemetry outbox, and business state must
not move into main or the relay.

## 4. Implemented scheme and follow-up evolution

### Task split

The product goal is two things: make scheduled/off-peak executions reuse ordinary message telemetry, and let the
existing `CronCreate` creation step correlate with later scheduled runs. Engineering splits into three items:

```text
Task 1: execution source and ID propagation
  scheduled: runId -> traceId/inputId/sourceCommandId/message_id
  off-peak: future offPeakTaskId (or its runId) -> same input chain
  plus message_source, task_trigger, automation_id/off_peak_task_id
  schedule-run completion also carries scheduled_at, schedule_lag_ms
  runId is the event idempotency namespace: completion uses runId, step uses runId + step_id

Task 2: execution message telemetry wiring
  scheduler / future off-peak Host dispatch
    -> create telemetry seed or Host reporter
    -> standard message_completion + agent_step

Task 3: add correlation field to the existing CronCreate creation step
  CronCreate repo commit success
    -> agent_step { tool_name=CronCreate, status=success, automation_id }
    -> joins later runs of Task 2 by automation_id
```

Task 1 answers where a run comes from and how IDs stay consistent; Task 2 how background runs report without the
UI; Task 3 how the creation action correlates with later runs and how to count users who created scheduled tasks
through conversation.

All three schemes first need the same creation-correlation chain: the `CronCreate` tool terminal attaches
`automationId` to the V4 `tool.lifecycle` telemetry fact only after the automation repo write succeeds (ID only,
no prompt or tool output); the supervisor maps it to that `agent_step.event_extra_detail.automation_id`. When the
Host later dispatches a run, it freezes the same `automationId` on that run's completion and every step. The
fact schema is strict, so the field must be declared explicitly in the shared telemetry protocol; the UI must not
guess it or infer it from task meta.

```text
CronCreate repo commit
  -> terminal tool.lifecycle { toolName=CronCreate, automationId=A }
  -> agent_step { tool_name=CronCreate, status=success, automation_id=A }

dispatchCronRun { runId=R, automationId=A }
  -> message_completion / agent_step { message_id=R, automation_id=A }
```

### Scheme A: Host adds a trusted seed to the existing renderer supervisor (MVP, implemented)

After `sendPrompt` is accepted, the Host publishes a body-free `automation prompt accepted` fact with
`sessionId`, `inputId/runId`, `message_source`, `task_trigger` and `automation_id` (a schedule run also carries
`scheduled_at`, `schedule_lag_ms`). The renderer supervisor builds the same lifecycle as the UI from it and then
consumes existing live facts.

- Pros: smallest change; reuses the current `messageTelemetry` aggregation and `/event/report`.
- Limit: reports can be lost on renderer reload, absent window or attachment not ready.
- Fit: MVP to validate scheduled-task volume and field definitions.

### Scheme B: Host reuses the `/event/report` message lifecycle directly

Extract the UI's source-neutral aggregation into a module the Host can call. For automation / off-peak input the
Host reports the standard `agent_step` / `message_completion` at accepted, step close and terminal, freezing the
source and `automation_id` / `off_peak_task_id` (a schedule run's completion freezes `scheduled_at`,
`schedule_lag_ms`); the UI keeps only the ordinary-chat reporter.

- Pros: no renderer dependency; works for scheduled and future off-peak tasks.
- Limit: a reporter owner must be explicit to avoid UI and Host double-reporting one `inputId`.
- Minimal rule: `chat` is reported by the UI; `scheduled_task` / `off_peak_task` only by the Host.

### Scheme C: Scheme B + Host telemetry outbox (recommended for formal rollout)

Add a lightweight outbox in the same database as the automation run ledger: accepted, each closed step and the
terminal `message_completion` each write a pending record carrying `runId`, `automationId` and an event-instance
level `outbox_event_id`; a background batch sender marks it done on success.

`automationId` only correlates across turns and cannot distinguish individual outbox records. `runId` equals the
turn `inputId`, but one run may have several `agent_step`s, so the idempotency key must include the event
instance identity:

```text
accepted seed:       runId + ":accepted"
agent_step:          runId + ":agent_step:" + step_id
message_completion:  runId + ":message_completion"
```

The terminal does not generate a second `/event/report` terminal event; it closes into the single
`message_completion`. If the implementation persists the raw terminal fact it must use an independent fact ID,
never sharing an `event_type`-level idempotency key with `agent_step`.

```text
accepted / finalized step / terminal
        -> SQLite telemetry outbox (event-instance outbox_event_id)
        |      |- runId:accepted
        |      |- runId:agent_step:step_id # one per closed step
        |      `- runId:message_completion
        -> batched /event/report
        -> mark delivered on success; async retry on failure
```

- Pros: does not block the scheduler or model stream; retries after Host restart or network failure; covers
  unattended runs.
- Cost: new persistence and delivery cleanup.
- Boundary: no per-chunk writes; only accepted, each final step and one completion are recorded, high-frequency
  detail logs use `debug`. On retry or Host restart the same `outbox_event_id` is not re-delivered; different
  `step_id`s are each delivered.

## 5. Suggested order and acceptance

1. Done: `message_source`, `task_trigger` and `automation_id` / `off_peak_task_id` were added to the shared prompt
   context / live fact contract; a schedule run's completion also gets `scheduled_at`, `schedule_lag_ms`.
   Ordinary chat defaults to `chat` and old callers stay compatible.
2. Scheduled runs already use `runId` as the execution message ID and `automationId` for cross-turn correlation;
   future off-peak tasks use `offPeakTaskId` through the same interface.
3. Currently scheme A validates fields and event payloads; for unattended reliable statistics use scheme C.
4. Assertions to cover:
   - `CronCreate` closes into `agent_step(tool_name=CronCreate, status=success)` with a non-empty `automation_id`
     only after the automation repo write succeeds; failure, cancel or duplicate replay is not a successful
     creation;
   - schedule run: the completion and all steps of the same `inputId` are `scheduled_task/schedule` with the
     matching `automation_id`; the completion's `scheduled_at` equals the `automation_runs` record and
     `schedule_lag_ms >= 0`;
   - Run Now: `scheduled_task/manual`, same `automation_id`, different `message_id=runId`; `scheduled_at` and
     `schedule_lag_ms` are empty;
   - the creation turn's `CronCreate` step and every later run join by the same `automation_id`; the creation
     turn's inputId is never reused for a run turn;
   - a later manual message in the same cron session stays `chat` and carries no `automation_id` of that run;
   - a run with reasoning, two tool calls and generation persists four different `runId:agent_step:step_id` step
     records; after a send failure, Host restart or duplicate terminal each of the four steps is reported exactly
     once and the completion has `agent_step_cnt=4`;
   - on Host/renderer reconnect or duplicate terminal, the same event instance's `outbox_event_id` is not
     re-reported; de-duplication must not use only `inputId + event type`;
   - once off-peak tasks are implemented: `off_peak_task`, with the source never inferred from provider, session
     ID or workspace path.
