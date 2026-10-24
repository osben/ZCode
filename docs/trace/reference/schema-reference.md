# Span, Attribute, Event and Metric Dictionary

> Defines the Spans, Attributes, Events and Metrics of Telemetry Schema Version 6. Design principles and
> call examples: [CLI Agent Telemetry design and development spec](../cli-agent-telemetry.md).

This file is maintained by hand. TypeScript constrains Setter parameters but cannot replace the
description of field meaning, missing semantics, privacy, cardinality, query use and inheritance. Any
change to a Span, Attribute, Event, Metric or compatibility alias must update this file.

## 1. Naming and type conventions

### 1.1 Span Name

Stable and low-cardinality: `agent_turn`, `agent_step`, `tool_execution`, `command_execution`,
`context_compaction`, `detached_operation`, `model_call`, `model_attempt`. There is no separate
`span_type`. Dynamic values (index, model, Provider, Tool Name) go only into Attributes.

### 1.2 Canonical Attribute

```text
zcode.<span_name>.<property>
zcode.execution.<property>
zcode.telemetry.<property>
zcode.runtime.<property>
zcode.device.<property>
```

Span Attributes use the underscore Span Name, e.g. `zcode.model_attempt.requested_model`. Metric names
use OTel-style dotted domains, e.g. `zcode.model.attempt.duration`; they serve different purposes and
are not mechanically interchangeable.

1. Time Attributes end in `_ms` (milliseconds); the OTel Unit of Duration Metrics is `s`.
2. Count/Index are integers; Tokens are non-negative integers.
3. Booleans are written only when the fact is clear.
4. Absent means "not observed / not applicable", never to be read as false or 0.
5. Stable enums are lowercase snake_case.
6. Raw Provider Model / Finish Reason / Error Code are not artificially folded but are length- and
   charset-constrained.

### 1.3 Field source stages

No runtime Schema Registry; fields are written as facts arrive.

| Stage    | Typical source                | Typical fields                                   |
| -------- | ----------------------------- | ------------------------------------------------ |
| Start    | Known at Span creation        | operation, tool_name, requested_model            |
| Progress | First determined mid-lifecycle | first_content, permission_decision, HTTP status |
| Terminal | Determined at end             | outcome, failure_stage, exit_code, finish_reason |
| Resource | Determined at Runtime creation | version, build, runtime surface                 |

Writer methods are the field entry; the explicit Keys inside Runtime are the output mapping.

## 2. Resource fields

### 2.1 Trace Resource

| Field                            | Type    | Meaning and source                                                          |
| -------------------------------- | ------- | --------------------------------------------------------------------------- |
| `service.name`                   | string  | Default `zcode-cli-agent`; overridable by controlled OTEL config            |
| `service.version`                | string? | Actual CLI bundle version, injected at build from `apps/zcode-cli/package.json` |
| `service.instance.id`            | string  | Random per-CLI-process instance ID                                          |
| `deployment.environment.name`    | string? | Product environment                                                         |
| `process.runtime.name`           | string  | `nodejs`                                                                    |
| `process.runtime.version`        | string  | Node version                                                                |
| `os.type`                        | string  | Node `process.platform`                                                     |
| `host.arch`                      | string  | Normalized CPU architecture                                                 |
| `zcode.telemetry.schema_owner`   | string  | Fixed `cli`                                                                 |
| `zcode.telemetry.schema_version` | integer | Currently `5`                                                               |
| `zcode.product.version`          | string? | Desktop/product build version                                               |
| `zcode.build.commit_id`          | string? | Trusted build commit                                                        |
| `zcode.runtime.surface`          | enum    | `standalone_cli` / `desktop_local_host` / `remote_workspace_host`           |
| `zcode.runtime.distribution`     | enum    | `source` / `development_bundle` / `packaged` / `unknown`                    |
| `zcode.device.installation_id`   | string? | Persistent random installation pseudonym, not a hardware ID                 |

### 2.2 Metric Resource

Metric keeps service, version, environment, Runtime, platform and build fields but omits
`service.instance.id` and `zcode.device.installation_id` (they would enter Metric Series identity and
give every installation and process its own series). The Metric Exporter uses DELTA Temporality to suit
many short-lived CLI producers.

## 3. Query Projection

These fields come from the immutable `AgentTelemetryExecutionContext` and are projected only onto key
Spans that need independent search. They are not Span inheritance and do not replace Parent/Link.

| Field                               | Type    | Meaning                                                            | Mainly on                            |
| ----------------------------------- | ------- | ------------------------------------------------------------------ | ------------------------------------ |
| `zcode.execution.session_id`        | string? | Current Session                                                    | Turn, Detached, Call, Attempt        |
| `zcode.execution.parent_session_id` | string? | Child's parent Session                                             | same                                 |
| `zcode.execution.turn_id`           | string? | Current Turn                                                       | all key Spans with a Turn Context    |
| `zcode.execution.parent_turn_id`    | string? | Child's parent Turn                                                | Turn, Detached, Call, Attempt        |
| `zcode.execution.query_id`          | string? | Request-level Query ID                                             | Turn, Detached, Call, Attempt        |
| `zcode.execution.actor_kind`        | enum?   | `main` / `subagent` / `workflow_child`                             | Turn, Tool, Detached, Call, Attempt  |
| `zcode.execution.agent_name`        | string? | Controlled Agent name                                              | Turn                                 |
| `zcode.execution.identity_state`    | enum?   | `authenticated` / `anonymous` / `unknown`                          | Turn                                 |
| `zcode.execution.user_subject_id`   | string? | Controlled user subject ID                                         | Turn                                 |
| `zcode.execution.launch_surface`    | enum?   | `desktop` / `standalone_cli` / `web_remote` / `automation` / `bot` | Spans with an Execution Context      |
| `zcode.execution.tool_call_id`      | string? | Tool Call correlation ID                                           | Tool, Command, in-Tool Call/Attempt  |
| `zcode.execution.logical_call_id`   | string? | Logical model call ID                                              | Call, Attempt                        |
| `zcode.execution.model_operation`   | enum?   | Snapshot of the Attempt's parent Call Operation                    | Attempt                              |
| `zcode.execution.model_role`        | string? | Snapshot of the Attempt's parent Call Model Role                   | Attempt                              |

`user_subject_id` is currently not a Hash field; callers may inject only a subject ID confirmed by the
product identity boundary. Installation ID and user subject ID must never be Metric Labels.

## 4. Lifecycle field inheritance

Every business Span inherits the same lifecycle semantics under its own prefix, e.g. `model_attempt`
produces `zcode.model_attempt.{outcome,failure_stage,error_category,error_type,error_code,error_message,
cancel_reason,abandon_reason}`.

| Property         | Type    | Written when                 | Meaning                                                  |
| ---------------- | ------- | ---------------------------- | -------------------------------------------------------- |
| `outcome`        | enum    | every terminated Span        | Business terminal state                                  |
| `failure_stage`  | enum    | `failed`                     | Failure stage within this Span                           |
| `error_category` | enum    | `failed`                     | Low-cardinality error category                           |
| `error_type`     | string? | source error first claimed   | Error name/type, controlled characters                   |
| `error_code`     | string? | source error first claimed   | SDK/runtime error code, control chars stripped, truncated |
| `error_message`  | string? | source error first claimed   | Source error message, sanitized, at most 2048 characters |
| `cancel_reason`  | enum?   | `cancelled`                  | Cancel reason                                            |
| `abandon_reason` | enum?   | `abandoned`                  | Abnormal closeout reason                                 |

### 4.1 Common enums

```text
error_category =
  configuration | authentication | permission | rate_limit | timeout |
  network | provider | parse | cancelled | internal | unknown

cancel_reason =
  user | abort_signal | timeout | shutdown | superseded | unknown

abandon_reason =
  missing_terminal | session_shutdown | process_shutdown
```

One Error may bubble Attempt -> Call -> Step -> Turn. The error object and its `cause` chain are claimed
by the Span nearest the source; a parent Span still records its own `outcome/failure_stage/
error_category` but does not copy the error body.

## 5. `agent_turn`

Parent: a main Turn is Root; a foreground Child Agent may be a Tool Child; a background Child Agent is a
new Root + Link.

| Field                           | Type    | Meaning                                                      |
| ------------------------------- | ------- | ------------------------------------------------------------ |
| `zcode.agent_turn.turn_number`  | integer | Turn ordinal within the Session                              |
| `zcode.agent_turn.input_source` | enum?   | `user` or a controlled Synthetic Message Source              |
| `zcode.agent_turn.result_type`  | enum?   | `assistant_message` / `tool_request` / `no_output` / `other` |

```text
outcome       = completed | failed | cancelled | abandoned
failure_stage = setup | agent_loop | finalize | unhandled
```

At Start the full Session/Turn/Query, Actor, Agent, Identity and Launch Surface are projected.

## 6. `agent_step`

Parent: `agent_turn`.

| Field                              | Type    | Meaning                          |
| ---------------------------------- | ------- | -------------------------------- |
| `zcode.agent_step.step_id`         | string  | Message/execution ID of the Step |
| `zcode.agent_step.step_index`      | integer | 0-based Step ordinal in the Turn |
| `zcode.agent_step.terminal_reason` | enum?   | Normal end reason                |

```text
terminal_reason = model_completed | tool_requested | turn_completed | compaction_requested
outcome         = completed | discarded | failed | cancelled | abandoned
failure_stage   = prepare | model | tool | commit | unhandled
```

## 7. `tool_execution`

Parent: usually `agent_step`; in-Tool model calls and commands are its Children.

| Field                                           | Type     | Meaning                                                     |
| ----------------------------------------------- | -------- | ----------------------------------------------------------- |
| `zcode.tool_execution.tool_name`                | string   | Controlled name from the Tool Registry                      |
| `zcode.tool_execution.permission_decision`      | enum?    | `granted` / `denied` / `not_required`                       |
| `zcode.tool_execution.permission_denial_reason` | enum?    | `user_denied` / `policy_denied` / `unavailable` / `unknown` |
| `zcode.tool_execution.output_bytes`             | number?  | Serialized Tool result size, no body                        |
| `zcode.tool_execution.output_truncated`         | boolean? | Whether output was truncated; omitted when unknown          |

```text
outcome = completed | denied | failed | cancelled | abandoned
failure_stage = lookup | validation | permission | pre_hook | handler | post_hook | serialize | unhandled
```

Events: `permission_requested` (at most one per Tool); `permission_decided { decision }` (written only
when a request occurred and a decision was finally needed).

## 8. `command_execution`

Parent: `tool_execution`. Created only when an OS process is actually started; not for ordinary Tools such
as Read/Write.

| Field                                     | Type     | Meaning                                                |
| ----------------------------------------- | -------- | ------------------------------------------------------ |
| `zcode.command_execution.safe_name`       | string   | Allowlisted command family, e.g. `git.status`, not the raw command |
| `zcode.command_execution.category`        | enum     | Command category                                       |
| `zcode.command_execution.command_count`   | integer  | Number of commands in the pipeline                     |
| `zcode.command_execution.shell_kind`      | enum?    | `bash` / `zsh` / `sh` / `powershell` / `cmd` / `other` |
| `zcode.command_execution.sandboxed`       | boolean  | Whether run in a Sandbox                               |
| `zcode.command_execution.first_output_ms` | number?  | Time to first output, ms                               |
| `zcode.command_execution.exit_code`       | integer? | OS process exit code; omitted when none produced       |
| `zcode.command_execution.signal`          | string?  | Controlled identifier of the terminating Signal        |
| `zcode.command_execution.output_bytes`    | number?  | Output bytes, no body                                  |
| `zcode.command_execution.timed_out`       | boolean? | Whether explicitly timed out                           |

```text
category = shell | git | package_manager | build | test | file | network | other
outcome = completed | failed | cancelled | backgrounded | abandoned
failure_stage = prepare | spawn | execute | timeout | collect_output | unhandled
```

Events: `first_output` (at most one); `termination_requested { reason }` with reason
`cancelled/timeout/shutdown`. Full command, args, scripts, paths, cwd and environment variables are never
reported.

## 9. `context_compaction`

Parent: the current Turn (usually the same Turn as the triggering Step, but not a Step "error recovery
field"). Inner model requests are Child Call/Attempt.

| Field                                                     | Type     | Meaning                                                              |
| --------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `zcode.context_compaction.trigger`                        | enum     | `CompactTrigger` in Contracts                                        |
| `zcode.context_compaction.phase`                          | enum     | `CompactPhase` in Contracts                                          |
| `zcode.context_compaction.model_mode`                     | enum     | `streaming` / `non_streaming`                                        |
| `zcode.context_compaction.outer_attempt`                  | integer? | Outer recovery attempt ordinal                                       |
| `zcode.context_compaction.max_attempts`                   | integer? | Outer max attempts                                                   |
| `zcode.context_compaction.triggering_step_index`          | integer? | Step ordinal that triggered compaction                               |
| `zcode.context_compaction.recovered_from_logical_call_id` | string?  | Recovery source Call ID                                              |
| `zcode.context_compaction.input_tokens`                   | number?  | Current provider-visible context Tokens when Auto / Reactive compaction triggered |
| `zcode.context_compaction.output_tokens`                  | number?  | Compaction output Tokens                                             |
| `zcode.context_compaction.policy_context_window_tokens`   | number?  | Policy context window used by the executing model for Auto / Reactive |
| `zcode.context_compaction.threshold_tokens`               | number?  | Trigger threshold used by this Auto Compact decision; may be omitted for other triggers |
| `zcode.context_compaction.token_source`                   | enum?    | `estimate` / `provider_usage`; the source of `input_tokens`          |

```text
outcome = completed | discarded | failed | cancelled | abandoned
failure_stage = prepare | model | parse | commit | fallback | unhandled
```

Event: `fallback_selected { reason }` (controlled enum).

Auto Compact reuses the existing policy decision. Reactive Compact reuses the provider-visible messages
of the overflow path: prefer the latest Provider Usage plus an estimate of messages added since the
snapshot, falling back to a local estimate; it does not write `threshold_tokens`. Its window is taken
from, in order, the current turn's executing model, Runtime config, then the Compact default. Manual,
Partial and SessionMemory omit these three context fields. These are Span attributes only, never Metric
labels.

## 10. `detached_operation`

For out-of-Turn operations that still need an independent result and duration. Foreground may be a
Child; Queued/Background uses Root + Link.

| Field                                     | Type     | Meaning                                                       |
| ----------------------------------------- | -------- | ------------------------------------------------------------- |
| `zcode.detached_operation.operation`      | enum     | Operation type from §10.1                                     |
| `zcode.detached_operation.execution_kind` | enum     | `foreground` / `queued` / `background`                        |
| `zcode.detached_operation.trigger`        | enum     | `user` / `turn` / `tool` / `scheduler` / `recovery` / `other` |
| `zcode.detached_operation.target_kind`    | enum?    | `session` / `goal` / `workspace` / `project_memory` / `other` |
| `zcode.detached_operation.goal_iteration` | integer? | Goal iteration ordinal                                        |
| `zcode.detached_operation.chunk_index`    | integer? | Chunk ordinal                                                 |
| `zcode.detached_operation.chunk_count`    | integer? | Chunk total                                                   |
| `zcode.detached_operation.result_type`    | enum?    | `text` / `boolean` / `metadata` / `other`                     |

```text
outcome = completed | failed | cancelled | abandoned
failure_stage = schedule | execute | commit | unhandled
```

### 10.1 Operation catalog

| Operation                         | Meaning                              | Entry class    |
| --------------------------------- | ------------------------------------ | -------------- |
| `goal_completion_verification`    | Goal completion verification         | system-sidecar |
| `goal_title_generation`           | Goal title generation                | system-sidecar |
| `project_memory_extract`          | Project Memory extraction            | system-sidecar |
| `project_memory_dream`            | Project Memory Dream/consolidation   | system-sidecar |
| `project_memory_recall`           | Project Memory recall                | system-sidecar |
| `read_session_context_extract`    | Session Context extract phase        | tool           |
| `read_session_context_synthesize` | Session Context synthesize phase     | tool           |
| `session_title_generation`        | Session title generation             | system-sidecar |
| `tool_internal_model_call`        | In-Tool model work not listed        | tool/system    |
| `web_fetch_processing`            | Web Fetch content processing         | tool           |
| `web_search`                      | Web Search model request             | tool           |
| `workspace_git_commit_message`    | Git Commit Message generation        | system-sidecar |
| `workspace_generate_text`         | Workspace general text generation    | system-sidecar |

`agent_step` and `context_compaction` also belong to `AgentTelemetryOperation` but have dedicated parent
Spans and are not Detached Start operations. "Entry class" only helps understand the Operation; it is not
`zcode.execution.actor_kind`, which describes only the executing Agent Runtime
(`main/subagent/workflow_child`).

## 11. `model_call`

Parent: `agent_step`, `context_compaction`, `tool_execution` or `detached_operation`. One logical Call
contains one or more physical Attempts.

| Field                                                | Type     | Meaning                                                          |
| ---------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| `zcode.model_call.operation`                         | enum     | Business purpose of the model call                               |
| `zcode.model_call.streaming`                         | boolean  | Whether the logical call requested streaming                     |
| `zcode.model_call.model_role`                        | string?  | Controlled role such as main model, fast model                   |
| `zcode.model_call.requested_provider_id`             | string   | Resolved Provider config ID                                      |
| `zcode.model_call.requested_model`                   | string   | Model requested by user/caller                                   |
| `zcode.model_call.call_cause`                        | enum     | `initial` / `continuation` / `fallback_replacement` / `recovery` |
| `zcode.model_call.previous_logical_call_id`          | string?  | Previous logical ID of a non-initial call                        |
| `zcode.model_call.reasoning_capability`              | enum     | `supported` / `unsupported` / `unknown`                          |
| `zcode.model_call.reasoning_requested_state`         | enum     | `enabled` / `disabled` / `provider_default` / `unknown`          |
| `zcode.model_call.reasoning_requested_control`       | enum     | Control mode, below                                              |
| `zcode.model_call.reasoning_requested_level`         | string?  | Raw requested effort/level                                       |
| `zcode.model_call.reasoning_requested_budget_tokens` | integer? | Requested thinking budget                                        |

```text
reasoning control = fixed_level | fixed_budget | adaptive | toggle | provider_default | unknown
outcome = completed | failed | cancelled | abandoned
failure_stage = resolve_target | attempts | fallback | aggregate | unhandled
```

Reasoning is a cross-Provider normalized concept; whether upstream calls it Thinking or Reasoning, the
Adapter maps it to Capability, State, Control, Level/Budget. An unknown/custom model must not be
inferred as disabled.

## 12. `model_attempt`

Parent: `model_call`. SpanKind: `CLIENT`. One Attempt is one real Provider API request.

### 12.1 Request and correlation

| Field                                     | Type    | Meaning                                                                        |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------ |
| `zcode.model_attempt.request_id`          | string  | ZCode physical request ID                                                      |
| `zcode.model_attempt.attempt_number`      | integer | 1-based Attempt ordinal                                                        |
| `zcode.model_attempt.max_attempts`        | integer | Max attempts of the current policy                                             |
| `zcode.model_attempt.attempt_cause`       | enum    | `initial` / `retry` / `fallback`                                               |
| `zcode.model_attempt.previous_request_id` | string? | Previous request ID of a Retry/Fallback                                        |
| `zcode.model_attempt.retry_delay_ms`      | number? | Wait before this Attempt                                                       |
| `zcode.model_attempt.transport`           | enum    | Adapter's real Transport, e.g. `sse` / `json`                                  |
| `zcode.model_attempt.api_operation`       | enum    | `messages` / `chat_completions` / `responses` / `generate_content` / `unknown` |

### 12.2 Provider, Endpoint and Model

| Field                                     | Type    | Meaning                                         |
| ----------------------------------------- | ------- | ----------------------------------------------- |
| `zcode.model_attempt.provider_id`         | string  | User-configured/routing instance ID             |
| `zcode.model_attempt.provider_kind`       | enum    | Protocol/vendor type, e.g. `anthropic`, `openai` |
| `zcode.model_attempt.provider_origin`     | string? | Sanitized `scheme://host[:port]`                |
| `zcode.model_attempt.provider_route`      | string? | Sanitized Path, no Query/Fragment               |
| `zcode.model_attempt.requested_model`     | string  | Model this Attempt actually requested           |
| `zcode.model_attempt.response_model`      | string? | Model returned in the Provider response         |
| `zcode.model_attempt.provider_request_id` | string? | Request ID returned by the Provider             |

`provider_id` differs from `provider_kind`: one OpenAI-compatible protocol can have several
user-configured instances; Origin describes the service location actually reached. A missing Origin
means the Adapter did not supply it or the Base URL could not be parsed safely; it is not the "default
Provider".

### 12.3 Reasoning

The Attempt repeats the Call's requested Reasoning so a physical Provider/Model request is independently
queryable, and adds response-confirmed Effective values: `reasoning_capability`,
`reasoning_requested_{state,control,level,budget_tokens}`,
`reasoning_effective_{state,control,level,budget_tokens}` under `zcode.model_attempt.`. Requested is the
intent entering the Provider Adapter; Effective is what the Adapter/Provider finally used. A missing
Effective fact is omitted, never guessed from Requested.

### 12.4 Usage, streaming and response

| Field                                                 | Type    | Meaning                                                                             |
| ----------------------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `zcode.model_attempt.input_tokens`                    | number? | Provider Usage input Tokens                                                         |
| `zcode.model_attempt.output_tokens`                   | number? | Provider Usage output Tokens                                                        |
| `zcode.model_attempt.reasoning_tokens`                | number? | Provider Usage Reasoning Tokens                                                     |
| `zcode.model_attempt.cache_read_tokens`               | number? | Cache Read Tokens reported by the Provider                                          |
| `zcode.model_attempt.cache_write_tokens`              | number? | Cache Write Tokens reported by the Provider                                         |
| `zcode.model_attempt.finish_reason`                   | string? | Raw bounded Provider finish reason                                                  |
| `zcode.model_attempt.stream_output_committed`         | boolean | Whether stream output was committed to the business consumer at terminal; the Status Sink normalizes a missing legacy value to false |
| `zcode.model_attempt.time_to_first_provider_event_ms` | number? | Time to first Provider Event                                                        |
| `zcode.model_attempt.time_to_first_content_ms`        | number? | Time to first valid content                                                         |
| `zcode.model_attempt.time_to_first_text_ms`           | number? | Time to first text                                                                  |

Token Setters accept cumulative values; Metric internally records only monotonic increments and ignores
a regressed value smaller than already recorded (avoids double counting). No cache-hit boolean summary
is created: `cache_read_tokens > 0` from the Provider expresses the raw fact; without Usage it stays
missing.

### 12.5 HTTP and Error

| Field                                        | Type     | Meaning                                                        |
| -------------------------------------------- | -------- | -------------------------------------------------------------- |
| `zcode.model_attempt.http_status_code`       | integer? | Provider HTTP status, e.g. 429/500; currently from the failed Status Event |
| `zcode.model_attempt.provider_error_code`    | string?  | Raw error code in the Provider Response                        |
| `zcode.model_attempt.provider_error_message` | string?  | Raw Provider Response error message, sanitized and truncated   |
| `zcode.model_attempt.retry_after_ms`         | number?  | Retry wait indicated by the Provider                           |

Lifecycle `error_code/error_message` is the Error that terminated the Span (currently the Adapter
usually passes the raw Transport/SDK Error; only when no Error object exists is it built from Status
facts); `provider_error_*` is the structured error fact of the Provider Response. They may coexist and
must not overwrite each other or be templated by error code.

```text
outcome = completed | failed | cancelled | abandoned
failure_stage = configuration | connect | response | stream | parse | validation | unhandled
```

Events: `first_provider_event`, `first_content`, `first_text` (each at most one);
`stream_stalled { idle_ms }` (each noticeable stall; Metric keeps only Count and Max); the parent
`model_call`'s `fallback_selected { reason }` records the logical Fallback decision.

## 13. Compatibility Adapter

Canonical fields are always written first; compatibility fields are projected by an independent Adapter
from the same sanitized fact. When an external standard drifts, change only the Adapter and tests, not
the business Writer API. Compatibility fields are not a second internal Schema; internal queries prefer
`zcode.*`.

| Canonical fact          | Compatibility field                  | Conversion                          |
| ----------------------- | ------------------------------------ | ----------------------------------- |
| Tool execution          | `gen_ai.operation.name=execute_tool` | fixed value                         |
| Tool Call ID            | `gen_ai.tool.call.id`                | exact                               |
| Tool Name               | `gen_ai.tool.name`                   | exact                               |
| Command Exit Code       | `process.exit.code`                  | exact                               |
| Command Signal          | `process.signal.name`                | exact                               |
| Provider Kind           | `gen_ai.provider.name`               | exact                               |
| Requested Model         | `gen_ai.request.model`               | exact                               |
| Response Model          | `gen_ai.response.model`              | exact                               |
| Finish Reason           | `gen_ai.response.finish_reasons`     | string -> single-element array      |
| Input Token             | `gen_ai.usage.input_tokens`          | exact                               |
| Output Token            | `gen_ai.usage.output_tokens`         | exact                               |
| HTTP Status             | `http.response.status_code`          | exact                               |
| Provider Origin Host    | `server.address`                     | hostname extracted from sanitized Origin |
| Provider Origin Port    | `server.port`                        | explicit port or protocol default   |
| Lifecycle Error Type    | `error.type`                         | exact, written on first-claimed Error |
| Lifecycle Error Message | `error.message`                      | exact, sanitized                    |

## 14. Event catalog

| Span                 | Event                   | Attribute  | Dedup/limit                              |
| -------------------- | ----------------------- | ---------- | ---------------------------------------- |
| `tool_execution`     | `permission_requested`  | none       | once                                     |
| `tool_execution`     | `permission_decided`    | `decision` | one decision                             |
| `command_execution`  | `first_output`          | none       | once                                     |
| `command_execution`  | `termination_requested` | `reason`   | each explicit request; Span Event cap    |
| `context_compaction` | `fallback_selected`     | `reason`   | each explicit decision                   |
| `model_call`         | `fallback_selected`     | `reason`   | each explicit decision                   |
| `model_attempt`      | `first_provider_event`  | none       | once                                     |
| `model_attempt`      | `first_content`         | none       | once                                     |
| `model_attempt`      | `first_text`            | none       | once                                     |
| `model_attempt`      | `stream_stalled`        | `idle_ms`  | not per Chunk; Event cap                 |

## 15. Metric catalog

All Duration/TTF Histograms have Unit seconds; the matching `_ms` Trace Attributes are milliseconds.

| Instrument                                         | Type      | Meaning                           | Allowed Labels                                                                        |
| -------------------------------------------------- | --------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| `zcode.agent.turn.duration`                        | Histogram | Turn terminal duration/traffic    | outcome, error_category, actor_kind, input_source, launch_surface                     |
| `zcode.agent.step.duration`                        | Histogram | Step terminal duration/traffic    | outcome, error_category, actor_kind, terminal_reason                                  |
| `zcode.tool.execution.duration`                    | Histogram | Tool terminal duration/traffic    | outcome, error_category, tool_name                                                    |
| `zcode.command.execution.duration`                 | Histogram | Command terminal duration/traffic | outcome, error_category, command_category, command_safe_name                          |
| `zcode.context.compaction.duration`                | Histogram | Compaction duration/traffic       | outcome, error_category, trigger, model_mode                                          |
| `zcode.detached.operation.duration`                | Histogram | Detached duration/traffic         | outcome, error_category, operation, execution_kind                                    |
| `zcode.model.call.duration`                        | Histogram | Logical Call duration/traffic     | outcome, error_category, model_operation, model_role, call_cause                      |
| `zcode.model.attempt.duration`                     | Histogram | Provider Attempt duration/traffic | outcome, error_category, provider_kind, model, transport, model_operation, model_role |
| `zcode.model.call.attempts`                        | Histogram | Attempts per Call                 | Call Labels above + retry_state                                                       |
| `zcode.model.attempt.tokens`                       | Counter   | Provider Token increment          | provider_kind, model, transport, model_operation, model_role, token_type              |
| `zcode.model.attempt.time_to_first_provider_event` | Histogram | TTF Provider Event                | Attempt Labels                                                                        |
| `zcode.model.attempt.time_to_first_content`        | Histogram | TTFC                              | Attempt Labels                                                                        |
| `zcode.model.attempt.time_to_first_text`           | Histogram | TTFT                              | Attempt Labels                                                                        |
| `zcode.model.attempt.stream_stall.count`           | Counter   | Stream stall count                | Attempt Labels                                                                        |
| `zcode.model.attempt.stream_max_idle`              | Histogram | Max stall per Attempt             | Attempt Labels                                                                        |
| `zcode.command.execution.time_to_first_output`     | Histogram | Command first output              | Command Labels                                                                        |
| `zcode.telemetry.creation_drop.count`              | Counter   | Writer rejected by capacity protection before creation | span_name, drop_reason                                           |
| `zcode.telemetry.abandoned.count`                  | Counter   | Abnormally closed Span            | span_name, abandon_reason                                                             |

```text
token_type  = input | output | reasoning | cache_read | cache_write
retry_state = not_needed | recovered | not_recovered
drop_reason = process_capacity | unknown
```

Forbidden as Metric Labels: user, installation, Session, Turn, Query, Tool Call, Logical Call, Request
ID; Provider ID, Endpoint Origin/Route, Provider Request ID; Error/Provider Error Message. Model ID is the
controlled exception: it keeps the raw value, protected by a 250-Series cardinality cap per View.

### 15.1 Histogram Bucket

Current explicit Views use these second-level boundaries:

| Instrument pattern                                                                                      | Boundaries                                                                              |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `zcode.agent.turn.duration`                                                                             | `0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600`                                               |
| `zcode.model.*.duration`                                                                                | `0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120`                                              |
| `zcode.agent.step.duration` / `zcode.context.compaction.duration` / `zcode.detached.operation.duration` | `0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600` |
| `zcode.tool.execution.duration`                                                                         | `0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120, 300`                                |
| `zcode.command.execution.duration`                                                                      | `0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120, 300, 600`                                         |
| `zcode.*.time_to_first_*`                                                                               | `0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120`                                              |
| `zcode.model.call.attempts`                                                                             | `1, 2, 3, 4, 5, 8, 13`                                                                  |

All explicit Views have a Series cardinality cap of 250. Histograms matching no View use the current OTel
SDK default Aggregation; to add an SLO for them, define Buckets explicitly first and update this table.

## 16. ID dictionary

| ID                    | Scope                | Generated by        | Use                                  |
| --------------------- | -------------------- | ------------------- | ------------------------------------ |
| `traceId`             | Trace                | OTel SDK            | Whole execution chain                |
| `spanId`              | Span                 | OTel SDK            | Single node                          |
| `service.instance.id` | Process              | Telemetry Bootstrap | Single-process diagnosis             |
| `installation_id`     | Product installation | Telemetry State     | Cross-version installation pseudonym |
| `user_subject_id`     | Logged-in subject    | Host/Auth           | Controlled user correlation          |
| `session_id`          | Session              | Core                | Session correlation                  |
| `turn_id`             | Turn                 | Core                | One-turn correlation                 |
| `query_id`            | Request              | Core                | Request correlation                  |
| `tool_call_id`        | Tool Call            | Model/Core          | Tool lifecycle correlation           |
| `logical_call_id`     | Logical model call   | Model Telemetry     | Retry/Fallback aggregation           |
| `request_id`          | Physical Attempt     | Model Adapter       | One Provider request                 |
| `provider_request_id` | Provider request     | Provider            | Reconciliation with Provider support |

IDs record only controlled, short, charset-constrained values; Prompt, URL or path is never encoded as
an ID.
