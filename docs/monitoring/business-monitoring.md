# Business Quality Monitoring

> **Current state:** the V4 `ConversationTelemetrySupervisor` consumes real request facts and reports
> `agent_step` / `message_completion`. After the provider refactor, the official identity only restores the old
> statistics ID at event-field construction: Personal/Team share the old Coding Plan bucket, Start is
> independent, and the two off-peak plans share the old off-peak bucket. UUID and unknown identities are not
> inferred; model-name encoding, usage, attribution, de-duplication and historical data are unchanged. Mapping
> and acceptance: [Todo129](../working-memory/provider-refactor/steps/todo-129-impact-and-cases.md).
>
> The field tables below describe the metric design. Statements below that "the V4 main link does not call"
> the old `finalizePromptTelemetry()` / `reportAppTelemetryEvent()` path describe the old UI aggregation, whose
> entries (`useZCodeChat`, `taskStreamEventHandlers`) were deleted.

## Boundary with non-business monitoring

| Belongs to this document                                     | Does not belong (see [performance-monitoring.md](./performance-monitoring.md)) |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Product behavior, session/task quality, telemetry events     | Page performance, JS errors, crashes, RUM, development profiling               |

## Metrics and event list

### `send_btn`

User send message click/submit event. At send time, read current login identity domain's plan identity snapshot and freeze result to current
prompt telemetry; subsequent same round `message_completion` must reuse same fields, do not re-read account status at completion.

| Field             | Type   | New | Description                                           | Scope / Example                                                                                                                                                                                                        |
| ----------------- | ------ | --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan_status`     | string | Yes | User plan identity when sending current round message | `coding_plan` / `start_plan` / `no_plan` / `unknown`                                                                                                                                                                   |
| `plan_product_id` | string | Yes | Backend stable product ID of current plan             | Coding Plan uses subscription `productId`; Start Plan uses balance interface `plans[]` server-priority-sorted first active plan `plan_id` (i.e. entitlement `subscription.details[0]`); no active plan is empty string |

Plan identity judgment priority fixed as `Coding Plan > Start Plan > No Plan > Unknown`. Request failure, still loading, authentication exception,
provider not configured or snapshot exceeds entitlement cache TTL must report `unknown`, cannot misattribute to `no_plan`.
Z.AI and BigModel mutually exclusive login identity domain decided by `providerFamilyDomain`; this field only used to select current identity domain's
Coding Plan / Start Plan snapshot, not reported as business telemetry field, nor follows `message_completion.model_provider` switching.

Multiple active Start Plan scope: `subscription.details` now carries all active plans and maintains server priority order,
`plan_product_id` takes `details[0]` (server-sorted first active plan). When server adjusts plan order or plans increase/decrease,
this dimension will follow flip, this is declared scope not identity jump; doing funnel/retention comparison by this dimension needs align with data side on this rule.

### `message_completion`

Agent single round message completion event historical design aggregated by UI side `finalizePromptTelemetry()`, then
reported via `reportAppTelemetryEvent()` to `/event/report`; the current V4 main link does not call this interface.

| Field                  | Type          | New | Description                                                 | Scope / Example                                                                                                                |
| ---------------------- | ------------- | --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `time_to_first_token`  | string(float) | No  | Duration from send to first token, ms                       | `firstTokenAt - sendTime`                                                                                                      |
| `waiting_ms`           | string(float) | No  | Permission wait etc user waiting duration, ms               | Accumulated value of this round's tool permission request to response/termination                                              |
| `duration_ms`          | string(float) | No  | This round wall clock total duration, includes `waiting_ms` | `finishedAt - sendTime`                                                                                                        |
| `request_time`         | string(float) | No  | User send timestamp                                         | `sendTime`                                                                                                                     |
| `input_tokens`         | string(float) | No  | Input token count                                           | Reported when success has usage                                                                                                |
| `output_tokens`        | string(float) | No  | Output token count                                          | Reported when success has usage                                                                                                |
| `reasoning_tokens`     | string(float) | No  | Reasoning token count                                       | `0` when no value                                                                                                              |
| `cached_input_tokens`  | string(float) | No  | Number of cached input tokens                               | `0` when no value                                                                                                              |
| `total_tokens`         | string(float) | No  | Total token count                                           | Reported when success has usage                                                                                                |
| `agent_step_cnt`       | string(int)   | No  | Agent step count                                            | Number of `agent_step` actually closed and reported in current message lifecycle                                               |
| `file_change_cnt`      | string(int)   | No  | Number of changed files                                     | Deduplicated path count by this round's fileChanges                                                                            |
| `generated_code_lines` | string(int)   | No  | Number of new code lines                                    | Based on before/after diff statistics added                                                                                    |
| `ask_mode`             | string        | No  | Current conversation mode                                   | `chat` / `plan` / other mode id                                                                                                |
| `retry_cnt`            | string(int)   | Yes | Number of model/API retries in this round                   | Current completion link has not stably exposed retry events, default `0` first                                                 |
| `tool_call_total`      | string(int)   | Yes | Total tool calls in this round                              | Number of `tool_call` steps actually closed in current message                                                                 |
| `tool_call_failed`     | string(int)   | Yes | Number of failed tool calls in this round                   | Number of `tool_call` steps with fail/timeout status or error in current message                                               |
| `error_type`           | string        | Yes | Failure classification                                      | Success is empty; failed tool is `TOOL_CALL_FAILED`; other failures `UNKNOWN`                                                  |
| `error_msg`            | string        | Yes | Failure prompt                                              | Success is empty; failure original text non-empty as `[redacted]`, original text empty is empty; attribution uses `error_type` |
| `plan_status`          | string        | Yes | User plan identity when sending current round message       | Reuse same round `send_btn` frozen value, not recalculated at completion                                                       |
| `plan_product_id`      | string        | Yes | Backend stable product ID of current plan                   | Reuse same round `send_btn` frozen value; empty string when unable to confirm                                                  |
| `workspace_kind`       | string        | Yes | This round workspace type                                   | `local` / `remote`, frozen by workspace attachment                                                                             |
| `remote_kind`          | string        | Yes | Remote workspace type                                       | `ssh` / `wsl` / `docker` / `server`; empty string when local or unresolvable                                                   |

Implementation location:

- Field aggregation: `packages/ui/src/lib/messageTelemetry.ts`
- Completion reporting: old entry deleted; reported by the V4 supervisor
- UI reporting encapsulation: `packages/ui/src/lib/appTelemetry.ts`

### `agent_step`

Agent single step execution event. Its granularity is finer than `message_completion`: one
`message_completion` corresponds to overall completion state of one user message; one user message can produce multiple
`agent_step`.

Currently only `reasoning` / `tool_call` / `generation` three step types are used, no new permission step added;
tool permission waiting separately expressed via `tool_call.waiting_ms`, user question content not uploaded.

| Field                         | Type        | New | Description                                                    | Scope / Example                                                                                                                                                                                                                            |
| ----------------------------- | ----------- | --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `talk_id`                     | string      | No  | Session / task id                                              | Mapped through report payload's `talkId`                                                                                                                                                                                                   |
| `message_id`                  | string      | No  | Current user message id                                        | Mapped through report payload's `messageId`                                                                                                                                                                                                |
| `step_id`                     | string      | Yes | Globally unique id of this Agent step                          | `uuid`                                                                                                                                                                                                                                     |
| `is_tftt_cached`              | string(int) | Yes | Whether first token hit cache                                  | No stable signal yet, fixed `0` first                                                                                                                                                                                                      |
| `loop_index`                  | string(int) | Yes | Order of current step in this message                          | Starts from `1` increments                                                                                                                                                                                                                 |
| `step_type`                   | string      | Yes | Current step type                                              | `reasoning` / `tool_call` / `generation`                                                                                                                                                                                                   |
| `is_tool_call`                | string(int) | Yes | Whether tool call                                              | `tool_call` is `1`, others `0`                                                                                                                                                                                                             |
| `tool_name`                   | string      | Yes | Tool name                                                      | `read_file` / `bash`; non-tool empty                                                                                                                                                                                                       |
| `tool_call_id`                | string      | Yes | Tool call id                                                   | Only `tool_call` step written, used to associate with tool terminal performance event; non-tool empty                                                                                                                                      |
| `agent_id`                    | string      | Yes | Foreground Subagent association id                             | Parent `Agent` step and its mirrored child tool write same value; other steps omit                                                                                                                                                         |
| `duration_ms`                 | string(int) | Yes | Current step wall clock duration, includes `waiting_ms`        | Step close time - step start time                                                                                                                                                                                                          |
| `waiting_ms`                  | string(int) | Yes | Accumulated permission wait within current step                | `tool_call` accumulates by request to response/termination; other steps `0`                                                                                                                                                                |
| `generation_tail_finalize_ms` | string(int) | Yes | Tail closure delay from last body chunk to task terminal state | Only written for main agent `generation` in desktop `desktop-continuous` closed by `task_complete` / `task_error`; other steps, mobile replayable recovery, generation interrupted by tool/reasoning or tool child output are empty string |
| `status`                      | string      | Yes | Current step final state                                       | `success` / `fail` / `timeout`                                                                                                                                                                                                             |
| `model_request_id`            | string      | Yes | Model request to which token belongs                           | Empty when current step doesn't hold request usage                                                                                                                                                                                         |
| `model_request_count`         | string(int) | Yes | Number of real model requests aggregated in current step       | Main Agent request is `1`; foreground child lifecycle can be > `1`; `0` when no usage                                                                                                                                                      |
| `token_usage_scope`           | string      | Yes | Token scope                                                    | Main Agent single request is `model_request`; foreground child aggregated is `subagent_requests`; otherwise empty                                                                                                                          |
| `input_tokens`                | string(int) | Yes | Single request input token                                     | Provider request usage; same request only attributed to one step                                                                                                                                                                           |
| `output_tokens`               | string(int) | Yes | Single request output token                                    | Provider request usage; same request only attributed to one step                                                                                                                                                                           |
| `reasoning_tokens`            | string(int) | Yes | Single request reasoning token                                 | `0` when provider not returned                                                                                                                                                                                                             |
| `cached_tokens`               | string(int) | Yes | Single request cache hit token                                 | Corresponds to provider cache read; `0` when not returned                                                                                                                                                                                  |
| `cache_write_input_tokens`    | string(int) | Yes | Single request cache write token                               | `0` when provider not returned                                                                                                                                                                                                             |
| `total_tokens`                | string(int) | Yes | Single request total token                                     | Provider explicit total; calculated by unified usage rule when missing                                                                                                                                                                     |
| `error_type`                  | string      | Yes | Failure classification                                         | Tool failure is `TOOL_EXEC_ERROR`; task failure uses error code; success empty                                                                                                                                                             |
| `error_msg`                   | string      | Yes | Failure prompt                                                 | `[redacted]` when error original text non-empty, empty when original text empty; success empty; attribution uses `error_type`                                                                                                              |
| `workspace_kind`              | string      | Yes | Current step workspace type                                    | Consistent with same `talk_id + message_id` `message_completion`; `local` / `remote`                                                                                                                                                       |
| `remote_kind`                 | string      | Yes | Remote workspace type                                          | `ssh` / `wsl` / `docker` / `server`; empty string when local or unresolvable                                                                                                                                                               |

`step_type` judgment scope:

- `agent_thought_chunk` start `reasoning` step.
- On `tool_call` / ordinary `agent_message_chunk` / `task_complete` / `task_error` close current `reasoning`.
- `tool_call` start `tool_call` step; `tool_call_update` to `completed` / `failed` / `denied` close.
- Main agent `agent_message_chunk` without `zcodeTimeline` and without `parentToolUseId` starts `generation` step; close on subsequent `tool_call` / `agent_thought_chunk` / `task_complete` / `task_error`.
- `generation_tail_finalize_ms` only answers desktop continuous main link body last chunk to task terminal state finalize tail delay; if body continues tool call, enters new reasoning, comes from mobile replayable recovery replay, or chunk carries `parentToolUseId` belonging to tool sub-output, field is empty string, avoiding mixing next stage duration, recovery replay processing time or child agent output into tail delay.
- `agent_message_chunk` if system timeline (e.g. context compaction) not counted into `generation`.
- Model fields frozen at step creation from current real `model_request_started`, cannot cover historical step from prompt's last request. Provider only provides request-level usage, therefore same request's complete usage only written to last model output step at request end, other stages keep `0`, see
  [Agent Step Real Model and Token Attribution](./agent-step-model-token-attribution.md).
- Foreground Subagent's child request usage via `childSessionId + parentToolCallId` attributed to parent message corresponding
  `Agent` tool step; background Subagent's asynchronous message lifecycle not in current scope.

Counting scope:

- `activatePromptTelemetry()` activates new message when, `loop_index` restarts from `1`.
- Each `agent_step` closure simultaneously accumulates current message completion metrics.
- Under same `talk_id + message_id`, `message_completion.agent_step_cnt` must equal actual
  reported `agent_step` count; must not scan or accumulate historical assistant messages of same session.

Implementation location:

- State machine and field aggregation: `packages/ui/src/lib/messageTelemetry.ts`
- Stream event access and reporting: old entry deleted; reported by the V4 supervisor
- UI reporting encapsulation: `packages/ui/src/lib/appTelemetry.ts`

## Multi-end and clientMode

Remote workspace and mobile Web Remote Control usage scope see
[Remote Scenario Usage Telemetry V1](./remote-usage-telemetry-v1.md); remote workspace logic session concurrency, disconnect reason and observable connection duration see
[Remote Workspace Connection ARMS Custom Events](./remote-usage-arms-telemetry.md).

Remote control embed only observes existing lifecycle terminal states, does not change transmission semantics: desktop keeps
`desktop-continuous`, mobile keeps
`web-remote-replayable`; relay does not parse `rpc-frame`, Web bundle adds no independent reporter. Mobile actual use judged by
desktop shared-host attachment successfully establishing bridge.

## Implementation Index (code facts, not specification)

Only positioning reference before requirements finalized, code prevails:

- Business embed reporting: `packages/services/src/telemetry/telemetryCore.ts` (`https://zcode.z.ai/api/v1/event/report`)
- UI encapsulation: `packages/ui/src/lib/appTelemetry.ts`, `packages/ui/src/lib/messageTelemetry.ts`
- Agent usage persistence: `apps/zcode-cli/docs/design/v2/usage-observability.md` (CLI design spec, not document in this directory)
- App Usage aggregation: `docs/superpowers/specs/2026-06-02-app-usage-db-migration-design.md` (feature spec, not document in this directory)

## Postscript: Workflow Sub-agent Enters `agent_step` / `agent_composition`

Spec: `apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md` "Token telemetry for subagents". Field scope increments:

| Field                                                                       | Change                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent_step.agent_role`                                                     | New value `workflow subagent` (existing `foreground subagent` / `background subagent` unchanged)                                                                               |
| `agent_step.agent_id`                                                       | Workflow sub-agent is `siteId@ordinal`                                                                                                                                         |
| `agent_step.workflow_run_id` / `child_session_id` / `workflow_tool_call_id` | New, only present on workflow sub-agent steps                                                                                                                                  |
| `agent_step.tool_call_id`                                                   | Workflow sub-agent: tool step `tool_workflow_<agentId>_<childToolCallId>`, summary step `tool_workflow_<agentId>_<runId>`                                                      |
| `agent_step.message_id`                                                     | Workflow sub-agent steps hang under the inputId of the round that initiated the run; a run started directly from the middle center uses a run-dedicated synthetic UUID v7 and that message has no `message_completion` |
| `message_completion.agent_composition`                                      | Adds `main_plus_wf` / `main_plus_fg_wf` / `main_plus_bg_wf` / `main_plus_fg_bg_wf`: run notification consumed by main conversation some round sets position                    |
| `message_completion.message_source`                                         | Independent round woken by workflow notification records `background_workflow`                                                                                                 |
