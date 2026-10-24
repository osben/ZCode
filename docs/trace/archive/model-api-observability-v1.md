# CLI Agent Model API Observability Design (Historical V1)

> Status: superseded by the [CLI Agent OpenTelemetry final architecture spec](../cli-agent-telemetry.md). This file keeps the early decision background only; it is no longer the basis for fields, interfaces, privacy or reports.
>
> The new implementation removed the Endpoint/Error Fingerprint, `cache_observation` and `had_error/recovered_after_retry` Trace summary designs described here; do not add queries or code from them.
>
> The Agent execution backbone is in [CLI Agent Turn Trace observability design](./turn-trace-observability-v2.md). The `zcode.model.call` / `zcode.model.attempt` spans of this doc are not deprecated; they migrate from the current short Trace to child spans under Turn / Step / Compaction / Tool.
>
> Full history: `git show b8876e8b:docs/trace/archive/model-api-observability-v1.md`.

## 1. Conclusion

Two layers:

1. A generic `TelemetryRuntime` that owns only queue, batching, rate-limited alerts, flush and exporter lifecycle. P0 records everything; sampling is added later in this layer.
2. A strongly typed `ModelApiTelemetry` on top that understands model calls: Logical Call, Physical Attempt, Provider, Model, reasoning level, Token, Cache, Retry, Fallback and errors.

No arbitrary `track(name, properties)` is exposed to business code, and the model domain does not depend on the ARMS SDK directly.

The CLI is the authoritative producer of model-call facts. The App only injects OTLP, runtime environment and identity config when launching the CLI; the CLI can read the same config standalone. App RUM and CLI OTel use the same Alibaba Cloud account/Workspace but share no SDK, Endpoint or `service.name`.

Short term, existing `plan_request`, `/event/report`, SQLite Usage, UI performance and local logs stay; the new path double-writes and reconciles. Long term, CLI Model API Facts become the single request-level fact source and gradually replace the duplicated `plan_request` producer.

## 2. Goals and Non-goals

### 2.1 Goals

- Cover every distinguishable CLI model API call: main Agent, Subagent, Workflow Child, Compaction, title, Goal Verifier, Git Commit and tool-internal model calls.
- Separate one model call from its physical Provider requests, Adapter Retry, stream recovery and Transport Fallback.
- Measure call volume, physical-request amplification, success rate, cancel rate, Retry recovery rate, latency, TTFT, Token and Prompt Cache.
- Record the actual Provider, sanitized Endpoint, Model, and requested and effective reasoning level.
- On failure record the ZCode error code, Provider error code, HTTP status, redacted message, error phase, retryability and Provider Request ID.
- Every record carries correlation IDs: UID, device, Session, Turn, Trace, Logical Call, Request.
- App-launched and Standalone CLI share one Schema and Exporter logic.
- Telemetry failure, congestion or absence never blocks or changes Agent behavior.

### 2.2 Non-goals

- Never upload prompts, message bodies, tool input/output, file content, headers, cookies, API keys or full Provider Options.
- No per-token, per-SSE-delta or per-chunk reporting.
- CLI Provider TTFT does not replace Renderer user-visible TTFT.
- Business conversion/purchase/feedback `/event/report` events do not move to this path.
- Telemetry state is not written into conversation snapshot, relay, desktop main or renderer store.
- Phase 1 creates no ARMS relational "table" and no local `model_attempt_usage` table.
- Phase 1 does not delete or change existing RUM, business telemetry or external local Usage behavior.

## 3. Confirmed Boundaries

| Boundary                | Decision                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Monitoring abstraction  | Generic Telemetry runtime + model-specific strongly typed Schema/Recorder                                                                    |
| Model call classes      | Stable dotted `operation` path; no separate `operation_phase`                                                                                |
| Feature-specific fields | Discriminated union and namespaced fields; no arbitrary attribute Map                                                                        |
| Provider Endpoint       | Sanitized automatically inside the client; no user config, UI or awareness                                                                   |
| Path sanitization       | Remove URL credentials/query/fragment, then lightly regex-replace email, UUID, long number and token/hash-style segments; no over-templating |
| Endpoint cache          | In-process memoization by `providerKind + baseURL`; not persisted                                                                            |
| Thought Level           | Reuse the Model Catalog, UI `thoughtLevel` and final Provider Options mapping; no new vendor-neutral levels                                  |
| App ARMS                | Same account/Workspace; App RUM and CLI OTel use separate Service and Endpoint                                                               |
| Compatibility           | Short term double-write without breaking; mid term reconcile; long term replace the duplicate request-level path                             |
| Performance             | Business thread only updates small state and enqueues into a bounded queue; real network by a background Batch Exporter                      |
| UID/RID/SID             | Schema uses explicit names; the Exporter may map to the backend's `uid/rid/sid`; the domain layer avoids ambiguous abbreviations             |

## 4. Current Facts and Overlapping Chains

### 4.1 Model request main path

All production model requests converge in the AiSdk Model Adapter:

```text
Core / Tool / Sidecar
        |
        v
ModelPort.generateText / streamText
        |
        v
AiSdkModelAdapter
        |
        +--> runGenerateText
        +--> runStreamText
                 |
                 v
          Provider HTTP / SSE
```

The Adapter already emits `ModelNetworkStatusEvent` values `model_request_started`, `model_request_completed`, `model_request_failed`, `model_retry_scheduled`, `model_stream_stalled`, carrying most of Trace/Query/Session/Turn, Request, Provider, Model, Base URL, Transport, Attempt, Duration, Usage, Failure Reason, Message and HTTP Status.

### 4.2 Monitoring/Usage chain

```text
CLI model status
  |\
  | +--> protocol live fact --> Renderer --> RUM plan_request
  |
  +----> UI retry/debug projection

CLI runtime usage
  +----> SQLite model_usage / turn_usage / tool_usage

Renderer conversation lifecycle
  +----> /event/report message_completion / agent_step / context_compaction
  +----> RUM plan_ttft / UI TTFT / UI completion / UI stall

Desktop main
  +----> RUM crash / resource / HTTP / RPC / longTask
```

### 4.3 Overlap review

| Mechanism                          | Relation to the new design                | Short term                                    | Long term                                               |
| ---------------------------------- | ----------------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| `ModelNetworkStatusEvent`          | Best source of physical Attempt facts     | Reuse and add fields                          | Stays as Runtime/UI projection and Recorder input       |
| `ModelStatusSink`                  | Existing status-consumer abstraction      | Fix request/global either-or, support fan-out | Keep, or fold into a unified Composite Sink             |
| SQLite `model_usage`               | Local logical-call Token/latency facts    | Tables and queries unchanged                  | Consume the same Model Call Terminal Fact               |
| RUM `plan_request`                 | Highly duplicates request-level Attempt   | Double-write for reconciliation               | Stop (or compat Exporter only) once OTel is stable      |
| RUM `plan_ttft`                    | Renderer user-visible latency             | Keep                                          | Keep; never merged with Provider TTFT                   |
| `/event/report message_completion` | User Turn/business quality                | Keep                                          | Keep; correlate via Session/Turn ID                     |
| `/event/report agent_step`         | UI/business step, not a Model API Request | Keep                                          | Keep; docs must avoid confusing it with Model Call      |
| Desktop RUM network monitoring     | Main/Renderer HTTP, RPC, WS               | Keep                                          | Keep; cannot replace CLI child-process model semantics  |
| Local logs                         | Single-machine diagnosis                  | Keep                                          | Keep; may be more detailed than ARMS but still redacted |

Principle: merge fact production, do not force-merge every consumer.

## 5. State Ownership

| Fact                                      | Authoritative source                                             | Mirror/consumer                            |
| ----------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| Provider/Model/Base URL/Transport         | Final resolution in the Model Adapter                            | ARMS OTel, UI safe projection, logs        |
| Physical Attempt lifecycle                | `runGenerateText` / `runStreamText`                              | ModelApiTelemetry, UI retry/debug          |
| Token/Cache/Finish Reason                 | Final Usage after Adapter normalization                          | ModelApiTelemetry, SQLite Usage            |
| Operation semantics                       | Core/Tool/Sidecar call sites                                     | ModelApiTelemetry                          |
| Compaction/Verifier final business result | The calling Operation                                            | Operation Record, existing business events |
| Requested reasoning level                 | Session/Model Ref/caller override                                | ModelApiTelemetry                          |
| Effective reasoning level                 | Final merged Provider Options + Model Catalog reverse lookup     | ModelApiTelemetry                          |
| UID                                       | App Host's current OAuth identity snapshot; absent in Standalone | Telemetry Context                          |
| Device MID                                | Existing `telemetry-state.json`                                  | App RUM, CLI OTel, `/event/report`         |
| Session/Turn/Trace/Query                  | CLI Runtime Trace Context                                        | All model records                          |

Renderer, Desktop Main and Relay do not re-derive Provider request facts.

## 6. Record Model

### 6.1 Three layers

```text
Model Operation
  |
  +--> Model API Call #1 (streamText)
  |      |
  |      +--> Physical Attempt #1
  |      +--> Physical Attempt #2
  |
  +--> Model API Call #2 (generateText fallback)
         |
         +--> Physical Attempt #1
```

1. Operation: expressed by `operation_id` and a stable `operation` path, e.g. one full Compaction or Goal Verification. The implemented Model phase sends no extra Operation Span; the Agent Turn Trace phase adds a parent Span for Operations with their own lifecycle such as Compaction.
2. `ModelApiCallRecord`: one `ModelPort.generateText()` or `streamText()` call.
3. `ModelApiAttemptRecord`: one real Provider HTTP/SSE/WebSocket request.

A normal Agent Step usually has Operation and API Call one-to-one. A Compaction SSE -> HTTP fallback is two API Calls under one Operation; an Adapter-internal Retry is several Attempts under one API Call.

### 6.2 Trace boundary evolution

An Agent Session can run very long with unbounded Steps, Tools and Compactions, so one Session-long Trace makes span count, memory, sampling and query boundaries unstable. Phase 1 implements one short Trace/Root Span per `ModelApiCallRecord` with Physical Attempts as child Spans, correlated across Traces by ZCode's own `session_id`, `turn_id`, `operation_id` and `logical_call_id`. The target structure is one Trace per Agent Turn:

```text
One Agent Turn = one Trace
Turn -> Step -> Model Call -> Physical Attempt
             -> Tool Call
Turn -> Compaction -> Model Call -> Physical Attempt
```

Async Sidecars, Background Subagents and Workflow Children keep independent Traces plus OTel Links. Full parent/child relations, lifecycle and migration are in [CLI Agent Turn Trace observability design](./turn-trace-observability-v2.md).

## 7. Operation Classification

### 7.1 Stable paths

These are the Phase 1 v1 values currently emitted. New chains must not extend legacy names such as `sidecar.*`; v2 canonical values, compatibility aliases and migration order are in the Turn Trace v2 doc.

```text
agent.step
context.compaction
sidecar.session_title
sidecar.goal_title
sidecar.goal_verification
sidecar.git_commit_message
tool.web_search
tool.web_fetch
tool.read_session_context.extract
tool.read_session_context.synthesize
other
```

`operation_family` derives from the first path segment; callers never write it by hand.

### 7.2 Path admission

Only finite, stable branches with business meaning enter the path: `extract` / `synthesize` may; `attempt_2`, `failed`, model name, Provider ID and Chunk Index may not. Dynamic values use fields.

### 7.3 Actor role

`actor_kind` is orthogonal to Operation: `main_agent | subagent | workflow_child | system | tool`. `agent.step + actor_kind=subagent` is a Subagent's normal model Step; `query_source=subagent` no longer expresses function and role at once. During migration the original `query_source` stays as a Trace compatibility field, mapped by a strict Registry to `operation + actor_kind`; unknown values map to `operation=other` and never become Metrics Labels directly.

## 8. Schema

### 8.1 Common identity and correlation fields

```text
schema_version
record_id
occurred_at

user_id_hash
identity_state
device_mid

session_id
parent_session_id
turn_id
trace_id
query_id
operation_id
logical_call_id
request_id
provider_request_id
tool_call_id

app_version
cli_version
deployment_environment
runtime_surface
```

- `record_id`: unique per fact, for idempotency and de-duplication. `logical_call_id`: one Model API Call. `request_id`: unique per Physical Attempt; an Adapter Retry generates a new value. `provider_request_id`: the request ID from the Provider response header/body when present.
- The raw OAuth/account UID never enters a Record, OTLP Resource or the public environment of Agent child processes; the App Host injects only the SHA-256. `user_id_hash` is for ARMS user correlation and the Exporter also maps it to the existing query convention `uid`; `identity_state=authenticated|anonymous|unavailable`. Standalone without a ZCode account leaves UID empty (never the string `unknown`).
- The Exporter maps `uid/rid/sid = user_id_hash/request_id/session_id`; the domain Schema keeps full names.
- These IDs are for Trace/SLS detail queries only, never Metrics Labels.

### 8.2 Call origin

```text
operation
operation_family
actor_kind
agent_name
step_index
runtime_surface
```

`agent_name` and `step_index` go to Trace only; `operation`, `actor_kind`, `runtime_surface` can be controlled Metrics dimensions.

### 8.3 Provider and model

```text
provider_id
provider_kind
provider_origin
provider_route
provider_endpoint_fingerprint
endpoint_sanitizer_version
model_id
model_role
```

`provider_id` is the user/system-configured Provider instance (e.g. `company-prod`); `provider_kind` is the actual Adapter/protocol type (e.g. `anthropic`, `openai-compatible`). `provider_id` may be high-cardinality so it defaults to Trace only; `provider_kind` may be a Metrics dimension.

### 8.4 Reasoning

The first Schema had not shipped, so no `thought*` / `reasoningEnabled` compatibility fields are kept. Public domain and Telemetry use `reasoning`; vendor-native names (`thinking`, `reasoning_effort`, `enable_thinking`) exist only in the Provider Adapter and the wire request.

```text
reasoning_capability = supported | unsupported | unknown
reasoning_state = enabled | disabled | unknown
reasoning_control_type = none | toggle | effort | fixed_budget | adaptive | unknown
reasoning_requested_level
reasoning_effective_level
reasoning_effective_budget_tokens
```

- `capability`: whether there is evidence the model supports Reasoning; a missing Catalog entry is never written as `unsupported`.
- `state`: whether the final Provider request actually enabled Reasoning.
- `control_type`: the vendor's control mechanism; `disabled` is a state, not a mechanism.
- `requested_level`: the level requested by Session/caller. `effective_level`: reverse-looked-up from the final merged Provider Options and Model Catalog. `effective_budget_tokens`: the fixed budget actually sent, never raw Provider Options.
- The Adapter first projects a single Provider namespace from the actual `provider_kind` and SDK `provider_options_name`, then resolves `state`, `control_type`, `effective_level` and `effective_budget_tokens`; other providers' namespaces in the same object are unconsumed config and not used for this request's facts.

The three are orthogonal facts: a custom model without a Catalog entry can report `capability=unknown, state=enabled, control_type=fixed_budget` ("cannot prove model capability, but the request explicitly carried a fixed budget"); it is never rewritten to `unsupported` or `disabled`. If the model declaration conflicts with the final request, both real values are kept so monitoring can find the config problem.

Requirements:

- Do not force GLM `enabled`, OpenAI `high` and Anthropic `xhigh` into a fake vendor-neutral scale.
- When a Sidecar explicitly disables Reasoning, Requested and Effective must differ.
- When a custom Provider Options cannot be reverse-looked-up, record `unknown`; never guess or write `disabled`.
- When several conflicting Provider namespaces exist, record only the one the current Adapter consumed; never recursively scan all `providerOptions`.
- `false` means explicit evidence of off; unknown facts are never faked as `false` or `0`.
- OTel accepts no `null` Attribute: omit unknown numbers; low-cardinality states use explicit `unknown`.
- Never upload full Provider Options.

### 8.5 Attempt and Transport

```text
transport
streaming
call_cause
previous_logical_call_id
attempt_number
max_attempts
attempt_cause
previous_request_id
retry_delay_ms
stream_recovery_number
stream_recovered_from_request_id
stream_output_committed
```

```text
call_cause = initial | transport_fallback | model_fallback | provider_fallback | recovery
attempt_cause = initial | retry
```

Transport/Model/Provider Fallback creates a new `ModelApiCallRecord` linked to the previous Call by `previous_logical_call_id`; an Adapter-internal Retry creates a new Physical Attempt under the same Call linked by `previous_request_id`. Core Fallback and Adapter Retry are therefore not counted as the same kind of retry.

Feature-specific fields go in namespaces, not the common Schema:

```text
zcode.compaction.trigger
zcode.compaction.outer_attempt
zcode.compaction.stream_output_committed
zcode.compaction.fallback_eligible
```

### 8.6 Timing

```text
duration_ms
time_to_first_provider_event_ms
time_to_first_content_ms
time_to_first_text_ms
stream_max_idle_ms
stream_stall_count
retry_delay_ms
```

Provider event, content and user-visible text are three different moments; the CLI does not claim `time_to_first_text_ms` equals Renderer UI TTFT.

### 8.7 Token and Cache

```text
input_tokens
output_tokens
reasoning_tokens
cache_read_tokens
cache_write_tokens
provider_total_tokens
computed_total_tokens
cache_observation
```

```text
cache_observation = hit | hit_and_write | write | miss | unknown
```

When the Provider returns no Usage or the request fails before Usage, it must be `unknown`, never mis-recorded as `miss`.

### 8.8 Success, cancel and error

```text
status
finish_reason
error_code
failure_reason
provider_error_code
http_status_code
error_message
provider_error_message
error_phase
exception_type
error_fingerprint
retryable
retry_after_ms
cancelled_by
telemetry_terminal_missing
telemetry_abandon_reason
```

```text
status = completed | error | cancelled | abandoned
error_phase = prepare | connect | response | stream | parse | postprocess
```

- `error_code` uses the ZCode `ModelErrorCode`; `provider_error_code` keeps the Provider business code and never overrides the unified code. `error_message` is a ZCode-normalized safe message; `provider_error_message` must be redacted and truncated to at most 1024 characters.
- Error messages and Stack never become Metrics Labels. Successful calls collect no Stack; error Stack enters detailed Trace only when explicitly enabled and redacted.
- Cancellation is listed separately and excluded from the model failure-rate denominator.
- `abandoned` is only for missing observation terminals caused by shutdown, idle TTL or capacity protection; it is not a Provider error and is counted via `telemetry_abandon_reason`.
- A Call that succeeds after Retry: `status=completed` plus `had_error=true`, `recovered_after_retry=true`.
- Operation post-processing failure never rewrites model call success: `call_status` and `operation_status` are recorded separately.

## 9. Provider Endpoint Sanitization

### 9.1 Product boundary

Fully internal: no user config, no `telemetryRouteTemplate`, no settings-page exposure, no need for users to understand or maintain a monitoring Route.

### 9.2 Lightweight rules

```text
raw Base URL
  |
  +--> use a standard URL parser
  +--> drop username/password
  +--> drop query and fragment
  +--> lowercase hostname, drop default port
  +--> lightly regex-replace path segments
          email            -> {email}
          UUID             -> {uuid}
          long number      -> {id}
          long hex/hash    -> {hash}
          token-style long string -> {token}
  +--> keep the remaining stable Path
  +--> produce origin / route / fingerprint
```

Example:

```text
https://user:pass@gateway.example.com/team-a/v1/messages?api_key=secret

provider_origin = https://gateway.example.com
provider_route  = /team-a/v1/messages
```

`team-a` is kept if it matches no sensitive regex; this low risk is accepted instead of adding tenant dictionaries or Provider-specific templates.

### 9.3 Performance and cache

Sanitization is `O(URL length)`, negligible versus a model network request, but memoized per Provider config: cache key `provider_kind + "\0" + raw_base_url`, value `ProviderEndpointIdentity`, limit 256, held in the Resolved Provider / in-process LRU and never persisted to SQLite or config (cheap to compute, rules may upgrade, Base URL may change, persistence leaves stale results). `endpoint_sanitizer_version` is recorded so rule upgrades recompute naturally. The fingerprint is based on the sanitized `origin + route`; a raw URL that still contains secrets is never hashed without a key.

## 10. Generic Runtime and Model Recorder

### 10.1 Generic layer

```ts
interface TelemetryRuntime {
  record(record: TelemetryRecord): void;
  flush(options: { timeoutMs: number }): Promise<void>;
  shutdown(options: { timeoutMs: number }): Promise<void>;
}
```

Owns: bounded in-memory queue; Batch Export; export timeout and failure isolation; P1 sampling and P0 alert rate limiting; Resource Attributes; local Exporter health snapshot and rate-limited warnings (remote self-telemetry metrics are P1); test Memory Sink and production No-op Sink.

Does not own: judging model errors, parsing Token/Cache, recognizing Compaction, parsing Provider Options, sanitizing model-domain fields.

### 10.2 Model layer

```ts
class ModelApiTelemetryStatusSink implements ModelStatusSink {
  publish(event: ModelNetworkStatusEvent): void;
}
```

The Recorder keeps minimal in-memory state until a Call/Attempt closes, then produces an immutable Terminal Record. The OTel Sink maps Terminal Records to Spans with explicit start/end timestamps. Core/Adapter never hold OTel Span objects, and OTel Context never crosses Async Generators, Tools and Fallback into domain code.

### 10.3 TelemetryRecord

```ts
type TelemetryRecord = ModelApiCallRecord | ModelApiAttemptRecord | TelemetryExporterHealthRecord;
```

Not `Record<string, unknown>`.

## 11. App Injection and Standalone Initialization

```text
App-launched
  Host resolve config/identity
       |
       +--> spawn env / startup config
                    |
                    v
Standalone ------> async identity prepare
                    |
                    v
                  CLI Telemetry Bootstrap
                    |
                    +--> TelemetryRuntime
                    +--> ModelApiTelemetry
                    +--> OTLP Exporter
```

Standalone file-identity initialization is CLI startup I/O, not part of the synchronous Telemetry factory:

```text
headless / TUI / protocol async entry
  |
  +--> prepareModelTelemetryEnv()
         |
         +--> endpoint disabled/missing ----------> original env (zero file I/O)
         |
         +--> host already injected device_mid ---> original env (zero file I/O)
         |
         +--> async read telemetry-state.json
                |
                +--> existing device_mid ---------> inject into startup env
                |
                +--> async lock + atomic rename --> inject new device_mid
                |
                +--> I/O failure -----------------> identity unavailable
  |
  +--> synchronous createZCodeApp()
         |
         +--> synchronous createModelTelemetry() (consumes prepared env only)
```

Concurrent prepares of the same state file in one process share a Promise; across processes `telemetry-state.lock`, stale-owner detection and atomic rename are reused. Identity I/O failure is bypassed (at most `identity_state=unavailable`) and never blocks App creation or the first model request. A host that embeds and calls synchronous `createZCodeApp()` is responsible for injecting identity; the official headless, TUI and protocol entries all run the async prepare.

Config priority: (1) explicitly injected `TelemetryRuntime`/Sink for tests or embedding; (2) App-injected OTLP config; (3) Standalone CLI env/config; (4) No-op.

Phase 1 uses standard OTel env vars with no user settings UI:

```text
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   # preferred, full /v1/traces URL
OTEL_EXPORTER_OTLP_ENDPOINT          # second choice, CLI appends /v1/traces
OTEL_EXPORTER_OTLP_TRACES_HEADERS    # preferred over OTEL_EXPORTER_OTLP_HEADERS
OTEL_SERVICE_NAME                    # default zcode-cli-agent
OTEL_RESOURCE_ATTRIBUTES
ZCODE_MODEL_TELEMETRY_ENABLED        # false/0/off/disabled force-disables
```

Desktop main passes only allowlisted OTLP config to the host and drops externally supplied UID hash, Identity State, Device MID and Runtime Surface so environment variables cannot forge identity. The Host captures the OTLP config when initializing services and deletes it from the public `process.env`; it injects it when starting the Agent, and the CLI bootstrap deletes it again after capture, so auth headers never reach Bash, MCP or Tool child processes. The Desktop UID is read from the OAuth Profile and SHA-256 pseudonymized inside the Host, so the raw value never crosses the Agent boundary (the hash is still a linkable identifier, not anonymous data). Device MID reuses the App's existing `telemetry-state.json`.

The App's built-in `ZCODE_ARMS_RUM_ENDPOINT` is `/rum/web/v2` and cannot derive an OTLP address or reuse RUM auth. Deployment must provide the target ARMS Workspace's OTLP Endpoint/Header separately; when missing, the new chain is an explicit No-op while RUM, SQLite and `/event/report` keep running.

### 11.1 Desktop packaged-installer config delivery

Packaged installers cannot rely on launching from a Terminal or reading the dev repo's `.env`. The build pipeline injects deployment defaults into Desktop Main through dedicated variables:

```text
ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT
ZCODE_PACKAGED_AGENT_OTEL_HEADERS
ZCODE_PACKAGED_AGENT_OTEL_SERVICE_NAME   # optional, default zcode-cli-agent
```

They are used only to build Desktop Main, never exposed as generic `OTEL_*` variables to pnpm, electron-builder or other build subprocesses. At runtime they map to the standard fields the Agent supports:

```text
ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT     -> OTEL_EXPORTER_OTLP_ENDPOINT
ZCODE_PACKAGED_AGENT_OTEL_HEADERS      -> OTEL_EXPORTER_OTLP_HEADERS
ZCODE_PACKAGED_AGENT_OTEL_SERVICE_NAME -> OTEL_SERVICE_NAME
```

```text
GitLab CI variables (Header must be masked)
  |
  +--> Desktop tsup build
         |
         +--> packaged deployment defaults (Main bundle)
                |
                +--> Desktop Main
                       |
                       +--> Host (connection config only)
                              |
                              +--> Agent (connection config + trusted identity)
                                     |
                                     +--> OTLP/HTTP -> ARMS
```

1. Endpoint and Headers must both be present; configuring only one fails the build (no installer that looks enabled but cannot authenticate).
2. Ordinary dev/MR builds with nothing configured stay No-op; `release/current` and Tag builds with everything missing also fail, so a release installer never silently falls back to No-op.
3. Endpoint must be an HTTP(S) URL; releases use HTTPS.
4. Packaged defaults rank below explicit runtime `OTEL_*` to ease operations diagnosis and isolated-environment override.
5. Build variables may only produce Endpoint, Headers and Service Name, never runtime identity (UID, Device MID, Session).
6. CI Headers must be masked variables, never in the repo, build logs or artifact manifests; once the target release branch is a GitLab protected branch the variables also become protected.
7. An ingestion credential in the Desktop client can eventually be extracted by the local user, so it must be a low-privilege rotatable write-only credential with no query or admin rights; the long-term plan is a controlled Collector/Gateway with short-lived credentials.
8. Standalone CLI keeps reading only standard `OTEL_*` and never implicitly inherits Desktop installer defaults.

Constraints:

- A CLI run has exactly one OTel Exporter owner.
- App Main passes only Endpoint/Auth/Resource config, the Host then injects trusted Identity; the injected result is config, not an Electron RUM SDK object.
- The CLI sends to ARMS OTel directly, not via Renderer and not per-record through Host/Main IPC.
- UID identity is a startup snapshot; if account switching without restarting the CLI is needed, a strict protocol Identity Update is added later rather than guessed in P0.
- Remote SSH/WSL/Docker must pass config explicitly and safely; the local process environment does not automatically reach the remote.
- Relay/Main hold no Model Call state.

## 12. App ARMS vs CLI ARMS

```text
Same Alibaba Cloud account / ARMS Workspace
  |
  +--> zcode-desktop-rum
  |      SDK: @arms/rum-electron
  |      Endpoint: /rum/web/v2
  |      scope: crash / JS error / UI / longTask / main-renderer network
  |
  +--> zcode-cli-agent
         SDK: minimal OpenTelemetry trace packages (Metrics is P1)
         Endpoint: OTLP
         scope: Model API / Agent Runtime
```

Shared correlation attributes: `device_mid`, `user_id_hash / uid`, `session_id`, `turn_id`, `app_version`, `cli_version`, `deployment_environment`, `runtime_surface`. CLI data must never be sent to the existing RUM `/rum/web/v2` Endpoint.

## 13. Performance, Memory, CPU and Network Review

1. Hot path: a normal successful model call produces 1 ModelApiCall Terminal Record and 1 ModelApiAttempt Terminal Record, never per-Chunk Records; a Retry adds one Attempt Span; `retry_scheduled` and `stream_stalled` are Attempt Span Events/aggregated fields. The business thread only reads clocks, counts, copies small fields, does Map lookups and enqueues; it never does network, file I/O, large JSON stringify, Prompt/Message/Tool payload traversal, success-path Stack generation or per-chunk allocation.
2. Budgets: `record()` sync P95 `< 0.5ms`, P99 `< 1ms`; steady CPU at 10 calls/s `< 1%` of one core; extra synchronous TTFT delay `< 1ms`; Queue/Recorder steady RSS increment `< 10 MiB`; a successful Call's state keeps no Prompt, Response, Header or raw Provider Metadata. Normal Call target `< 4 KiB` uncompressed, error/Retry Call `< 8 KiB`.
3. Memory caps: completed-record queue 2000 records or 4 MiB (first wins); active call/attempt state 1000 handles; endpoint identity cache 256 entries. On a full queue: drop Telemetry, increment `telemetry_dropped_total`, rate-limited warn, continue the Agent. A normal main-stream Consumer Close adds no abort/terminal; the Recorder prevents unbounded growth by lazy 30-minute cleanup and evicting the oldest dangling Call at 1000. A Compact hidden stream still aborts and closes on Consumer Close.
4. Network: OTLP Batch `max_batch_size = 100 spans`, `flush_interval = 5s`, `export_timeout = 3s`, `shutdown_flush_timeout = 1~2s`; batching and compression required; no per-Record HTTP. Phase 1 exposes in-process `health()`; P1 sends `telemetry_export_bytes_total`, `telemetry_export_batches_total`, `telemetry_export_failures_total`, `telemetry_dropped_total`, `telemetry_queue_size`.
5. Startup and bundle: use the minimal official OTel packages with manual Spans (no Node auto-instrumentation, no hand-built protocol), added as explicit dependencies. When unconfigured, initialization is lazy / No-op with no Batch Worker. The implementation MR must report `dist/zcode.cjs` size change, SEA size change, `zcode --help` and first-Prompt startup change, and RSS baseline disabled vs enabled.
6. ARMS failure: at most one failed request per Flush cycle; queue drops at its limit; local rate-limited log plus self-monitoring counter; Agent model calls completely unaffected. The Exporter never retries infinitely, spools to disk infinitely, blocks process exit or throws to the model caller; Phase 1 does not re-implement SDK-internal retry; failed batches are dropped and shutdown closes under one total timeout.
7. Phase 1 measured (macOS arm64, Node.js 24.14.0, local micro-benchmarks): sync Recorder per full Call P50/P95/P99 `0.0022` / `0.0046` / `0.0095ms`; 2,000-record queue RSS `+6.20MiB`; telemetry module cold import `26.6ms`, disabled create `0.089ms`, enabled create `0.234ms`; first OTel load + two Span Export + shutdown `93.0ms` / RSS `+18.0MiB` in the background; 1 Call + 1 Attempt OTLP protobuf `3,456B` (gzip `1,159B`); `dist/zcode.cjs` `+5.82%`, darwin-arm64 SEA `+0.62%`; `--help` cold start P50 `290.2ms -> 295.0ms`. `LazyOtlpTelemetryRecordExporter` loads OTel only on the first non-empty Batch.

## 14. Code Intrusiveness Review

1. Layers touched: `@zcode/contracts` (Operation Registry, typed observations, records, Sink interface; pure types/Schema, no ARMS dependency), Model Adapter (Attempt lifecycle, final Provider/Endpoint/Thought/Usage, error completion; medium), Core Runtime (about ten semantic entries add `operation`; low to medium), Tool Handlers (WebSearch/WebFetch/ReadSessionContext; low), Bootstrap (Runtime/Recorder/Composite Sink; medium), CLI Entry (Standalone config, Flush/Shutdown), Services Host (spawn config and identity injection; no per-event protocol forwarding), Desktop/UI (status quo during double-write plus migration Feature Flag/reconciliation), SQLite (no migration in P0).
2. Call sites only declare semantics, e.g. `model.generateText({ ...request, modelCall: { operation: Operation.SessionTitleGeneration } })`; after v2 `actorKind` is inherited from the current Scope. The Adapter fills Provider, Endpoint, Thought, Token, Cache and errors. `modelCall` is an internal field the Adapter strips before building the AI SDK request.
3. Phase 1 structural outcome: request/global sinks fan out independently (a throwing sink does not block the other); streaming completion carries final Usage, Finish Reason, first Provider Event/Content/Text, Stall and Output Commit; failed events carry the unified `error_code`, Provider code/message, HTTP Status, Request ID, phase and exception type; `query_source` maps via a strict Registry (unknown -> `other`); Tool-internal model calls are covered by ARMS Call/Attempt (SQLite logical-usage unification stays Phase 3); Title/Git Commit mark Effective Disabled; Adapter Retry uses new Request IDs, Compaction Transport Fallback links by `previous_logical_call_id`, Stream Recovery by `stream_recovered_from_request_id`.
4. Not recommended: hand-written `arms.sendCustom()` at call sites; re-sending full Telemetry Events through Renderer/Main IPC; a SQLite Row as the OTel Schema; Model Adapter depending on Electron, ARMS RUM or Host Service; an arbitrary `metadata: Record<string, unknown>`; awaiting a real Export in the business path.

## 15. Metrics and Statistics

### 15.1 Base counters

```text
model_api_calls_total
model_api_attempts_total
model_api_errors_total
model_api_cancellations_total
model_api_retries_total
model_api_retry_recovered_total
model_api_fallbacks_total
model_api_tokens_total
model_api_cache_read_tokens_total
model_api_cache_write_tokens_total
```

### 15.2 Formulas

```text
Logical Call success rate = completed / (completed + error)
Attempt success rate = completed attempts / (completed attempts + failed attempts)
Physical request amplification = physical attempts / model API calls
Retry recovery rate = completed-after-retry / retried calls
Cache Call hit rate = hit calls / cache-observable calls
Cache Token hit rate = sum(cache_read_tokens) / sum(input_tokens)
```

Cancellation is listed separately and excluded from the default failure-rate denominator.

### 15.3 Metrics Labels

Allowed: `operation`, `operation_family`, `actor_kind`, `provider_kind`, `transport`, `status`, `error_code`, `runtime_surface`, `deployment_environment`.

Disallowed by default: `user_id_hash / uid`, `device_mid`, `session_id`, `turn_id`, `trace_id`, `logical_call_id`, `request_id`, `provider_request_id`, `provider_id`, `agent_name`, `error_message`, `provider_route`. `model_id` enters Metrics only after a known-model allowlist / cardinality budget; otherwise it is for Trace/SLS queries only.

## 16. ARMS Data Organization

No separate tables per `step/compact/title/tool`. One OTel Service: `service.name = zcode-cli-agent`, with `span.name` of `zcode.model.call`, `zcode.model.attempt`, `zcode.model.operation`, classified by fields such as `operation`, `actor_kind`, `transport`. Trace data is stored by ARMS; if a long-term wide table or fixed offline analysis is needed later, a derived Logstore is generated through SLS Scheduled SQL, not a P0 prerequisite.

## 17. Dashboard and Alerts

1. Dashboards: Overview (Call/Attempt volume, Logical/Attempt success rate, P50/P95/P99, TTFT, Token); Provider/Model (Provider Kind, Provider ID, Model, Thought Level); Compaction (SSE success, HTTP Fallback, Outer Retry, Operation Commit); Retry/Error (unified error code, Provider error code, HTTP Status, Retry recovery rate); Cache (Call hit, Token hit, Cache Write); Surface (Desktop, Standalone, Remote, Automation); Telemetry Health (Queue, Drop, Export Failure, Export Bytes).
2. Alerts need a minimum sample size to avoid low-traffic false alarms; success rate, P95, 429, 5xx, Timeout and Context Exceeded alert separately; Exporter failure alerts only the monitoring chain and never fails the Agent; the first phase collects a baseline and sets no business SLO without data.

## 18. Sampling and Cost

P0: Logical Call Terminal, Error, Cancel, Retry, Fallback 100%; Attempt Terminal 100% (to build a real baseline and reconcile with `plan_request`); no per-Chunk reports. After the baseline stabilizes: exact Calls/Errors/Duration/Token use unsampled Metrics or full Terminal Facts; detailed success Traces may be sampled; Error/Cancel/Retry/Fallback Traces stay 100%; exact success rate is never computed from sampled success Traces.

## 19. Migration Route

- Phase 0, Spec and contract (done): freeze Operation Registry, Schema, privacy and performance budget; add Golden Schema/Privacy Tests.
- Phase 1, side-channel integration (code done, pending ARMS gray): add TelemetryRuntime and ModelApiTelemetry; collect on the side from existing Model Status/Usage; keep RUM `plan_request`, SQLite and `/event/report` unchanged; ARMS OTel uses a separate Service.
- Phase 2, double-write reconciliation: compare Started/Terminal/Attempt counts, Provider/Model/Transport, Completed/Error/Cancelled, Duration/TTFT, Token/Cache, Retry/Fallback; gray 1% -> 10% -> 100% while watching Exporter Drop, CPU, RSS, network and billing.
- Phase 3, unified fact production: SQLite `model_usage` driven by the unified Model Call Terminal Fact; RUM `plan_request` becomes a compat Exporter or stops; UI retry/debug keeps consuming the safe projection, not ARMS.
- Phase 4, remove duplicate chains: after stable reconciliation and old-dashboard migration, stop the Renderer re-producing `plan_request`; keep `plan_ttft`, UI Perf, business `/event/report` and local logs; evaluate whether Tool/RPC reuse the generic TelemetryRuntime without sharing the Model Schema.

## 20. Failure and Degradation Matrix

| Scenario                      | Agent behavior             | Telemetry behavior                                               |
| ----------------------------- | -------------------------- | ---------------------------------------------------------------- |
| OTLP not configured           | Runs normally              | No-op; SQLite kept                                               |
| ARMS network timeout          | Runs normally              | At most one failed request per Flush cycle; failed batch dropped |
| Queue full                    | Runs normally              | Drop new/old per implementation policy, Drop Counter increments  |
| Endpoint sanitization fails   | Runs normally              | Keep Provider Kind/ID, Endpoint fields missing                   |
| Thought reverse lookup fails  | Runs normally              | Effective=`unknown`                                              |
| Provider Usage missing        | Runs normally              | Token may be missing, Cache=`unknown`                            |
| UID missing                   | Runs normally              | Identity=`anonymous/unavailable`                                 |
| Span/Record close fails       | Runs normally              | Rate-limited local log, not thrown to the caller                 |
| CLI abnormal exit             | Process exits              | Bounded Flush only, never blocks exit                            |
| Remote cannot get OTLP config | Remote Agent runs normally | No-op/local Usage, no Main proxying back                         |

Phase 1 adds no ARMS "table": `zcode.model.call` and `zcode.model.attempt` are two Span kinds under the same `service.name=zcode-cli-agent`; traffic, success rate, latency percentiles and Token/Cache aggregate from Span attributes. A derived Logstore/Scheduled SQL is created on the SLS side only if a fixed wide table is needed, without changing the CLI Schema.

## 21. Dimensions and Pruning

Domains: Model/Provider Runtime (yes: source of model, Thought, Transport, Retry facts); Monitoring/Telemetry/Usage (yes: ARMS, SQLite, RUM, `/report` boundary); Architecture/Process (yes: App injection, CLI self-init, Remote boundary); Persistence (representative: P0 migrates no table, only verifies existing SQLite does not regress); Conversation/UI (representative: only safe projection and existing events are checked).

Dimensions: Operation `agent.*` / `context.*` / `sidecar.*` / `tool.*`; Actor main / subagent / workflow / system / tool; Transport HTTP / SSE / WebSocket; Outcome completed / error / cancelled; Attempt initial / retry / recovery / fallback; Cache hit / write / miss / unknown; Thought disabled / toggle / effort / budget / adaptive / unknown; Surface Desktop / Standalone / Remote / Automation; Telemetry state enabled / disabled / exporter down / queue full.

Pruning: no full Operation × Provider × Model cartesian (pick representatives by Provider protocol family and Thought control type); no all-value Session/Turn ID combinations (verify presence, correlation and that high cardinality stays out of Metrics); no per-Streaming-Chunk enumeration (cover first content, Stall, natural end, pre-failure and post-commit failure); UI `desktop-continuous` and `web-remote-replayable` do not share real network-report semantics, and CLI's own model-request facts are independent of UI replay; Endpoint Path covers only obvious sensitive patterns and ordinary stable Paths, with no tenant template matrix.

## 22. Verification Summary

Covered: Operation Registry and Query Source mapping; Endpoint sanitization and cache; Requested/Effective Thought across providers and Sidecar Disabled; error code/message redaction; Cache `hit/write/miss/unknown`; Metrics Label allowlist; Queue limit/Drop/Flush Timeout; Adapter Generate/Stream success, error, cancel, retry, stall, consumer close, with a new Request ID per Physical Attempt and no duplicate events across request and global sinks; Operation cases (Main/Subagent/Workflow Child share `agent.step`; Compaction SSE success, pre-content fallback to HTTP, post-commit failure without fallback; Goal Verifier failure vs fail-open result; Title/Git Commit Thought Disabled; tool-internal calls); integration (Fake OTLP Collector batches, one Exporter owner, Disabled sends nothing, ARMS Down/Timeout/429/Queue Full keep the Agent running, `plan_request` double-write reconciliation, SQLite Usage no regression, local/SSH/WSL/Docker boundaries, cross-OS URL/Shutdown/Signal); performance (10 calls/s, retry storm, 30 minutes Exporter Down, 1000 dangling handles, startup/bundle size).

Desktop Agent `prepare:desktop-runtime` must complete in a clean environment without `apps/zcode-cli/packages/telemetry/dist`; the ordinary pnpm build and the `bootstrap:with-remote` direct tsc build share the single `cliWorkspaceBuilds` list in `scripts/build-desktop-agent-cli.mjs` in the order `@zcode/contracts -> @zcode/telemetry -> @zcode/bootstrap`; never depend on leftover dev-machine dist.

Phase 1 local results (2026-07-22, Node.js 24.14.0): `@zcode/telemetry` 21 tests, `@zcode/adapters` 775 tests (2 skipped), `@zcode/contracts` 179 tests, Core Compaction/Streaming 104 tests, Bootstrap Workflow/Model Catalog 10 tests, Shared/Services/Desktop config injection 29 tests pass; root `pnpm typecheck` passes; `pnpm lint` 0 errors (52 pre-existing warnings); CLI CJS and darwin-arm64 SEA build/startup smoke tests pass. Full Core still has 8 baseline failures unrelated to this feature (hard-coded external local paths, existing I/O/module-line-count boundaries, Subagent/WebFetch/Workflow assertions, three persistence/timing assertions).

## 23. Accepted Cases

- MODEL-OBS-001: Standalone, OTLP enabled; Main Agent completes one model call; 1 Call + 1 Attempt with Provider/Model/Thought/Token/ID complete (Fake Collector + Memory Sink).
- MODEL-OBS-002: Adapter Retry once, first 429 then success; Logical completed, Attempts error+success, recovered=true (Span + Error Fields).
- MODEL-OBS-003: Compaction SSE fails before first content and falls back to HTTP; two Calls under one Operation, final Operation committed (Span + Runtime Event).
- MODEL-OBS-004: Stream already has content and the connection fails mid-way; `stream_output_committed=true`, no wrong replay (Span + Provider Fixture).
- MODEL-OBS-005: Goal Verifier model fails and is fail-open; Call error, Operation fail_open (Span + Runtime Result).
- MODEL-OBS-006: Sidecar Title with Session Thought=high; Requested=high, Effective=disabled (Span + Final Provider Options).
- MODEL-OBS-007: Exporter Down, model returns normally; business succeeds, Queue bounded, Exporter Failure grows (Result + Health Metrics).
- MODEL-OBS-008: App-launched, Host injects config and identity; CLI OTel works, RUM still works, no double Exporter (Process Env + Collector + RUM Ring).
- MODEL-OBS-009: Standalone without account; UID empty, Identity anonymous, Device MID present (Span).
- MODEL-OBS-010: Sensitive Base URL with userinfo/query/email/hash; ARMS sees only sanitized origin/route, no secrets (Privacy Test).
- MODEL-OBS-011: WebFetch/ReadSessionContext tool-internal model calls; Operation path correct, no missed Call (Span + Tool Result).
- MODEL-OBS-012: Queue Full under continuous Terminal Records; Agent not blocked, Drop Counter grows, memory bounded (Benchmark + Health Metrics).
- MODEL-OBS-013: App started with OTLP enabled, no active session, Host warmup calls `workspace/readState`; the state-only adapter accepts the telemetry sink injection, creates no model request, and workspace state returns normally (Protocol Test + Desktop Runtime).
- MODEL-OBS-014: clean checkout without telemetry dist, build the Desktop Agent runtime; both build modes produce telemetry before compiling bootstrap and the desktop bundle builds (Script Contract + Clean Build).

## 24. Open Items

| Item                         | Default decision                                                      | Action before implementation                                                                                 |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Backend definition of `rid`  | Map to Physical `request_id`                                          | Confirm with ARMS/warehouse field owners; if it is actually Run/Resource ID, use an explicit Canonical field |
| Raw UID into ARMS            | Decided: never; upload only SHA-256 `user_id_hash/uid`                | A new privacy review is required to change this                                                              |
| OTel Metrics Endpoint        | Phase 1 aggregates all Terminal Spans in ARMS; separate Metrics is P1 | Verify OTLP Metrics/Prometheus access and permissions in the target ARMS Workspace                           |
| `plan_request` compat period | Stop after one full gray/reconciliation cycle                         | Confirm old Dashboard owner and the migration-done criteria                                                  |
| OTel SDK bundle budget       | Measured: CJS `+5.82%`, darwin-arm64 SEA `+0.62%`                     | Keep watching startup/RSS during gray; optimize if needed                                                    |

## 25. Implementation Index

- Telemetry Contract: `apps/zcode-cli/packages/contracts/src/telemetry/index.ts`
- Runtime/Recorder: `apps/zcode-cli/packages/telemetry/src/runtime.ts`, `model-api-recorder.ts`
- OTLP Bootstrap/Exporter: `apps/zcode-cli/packages/telemetry/src/bootstrap.ts`, `lazy-otlp-exporter.ts`, `otlp-exporter.ts`
- Endpoint sanitization: `apps/zcode-cli/packages/telemetry/src/provider-endpoint.ts`
- Model Adapter: `apps/zcode-cli/packages/adapters/src/model/runner.ts`
- Attempt Status: `apps/zcode-cli/packages/adapters/src/model/runner-status.ts`
- Generate: `apps/zcode-cli/packages/adapters/src/model/runner-generate.ts`
- Stream: `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts`
- Failure Classifier: `apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`
- Thought Catalog: `apps/zcode-cli/packages/contracts/src/model/catalog.ts`
- Thought Policies: `apps/zcode-cli/packages/adapters/src/model/reasoning-policy.ts`
- Runtime Thought Mapping: `apps/zcode-cli/packages/adapters/src/model/runtime-thought-level.ts` (Bootstrap keeps a compatibility re-export)
- App/Standalone Bootstrap: `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`
- Local Usage: `apps/zcode-cli/packages/core/src/runtime/methods/usage-observability.ts`
- SQLite Usage: `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts`
- App ARMS: `packages/desktop/src/main/appARMSBootstrap.ts`
- RUM Plan Usage: `packages/ui/src/lib/planUsageArmsTelemetry.ts`
- Host Spawn: `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`
- Host OTLP identity injection: `packages/services/src/zcode-agent/agentTelemetryEnv.ts`
- Business Telemetry: `packages/services/src/telemetry/telemetryCore.ts`

## 26. Related Docs

- [Performance telemetry event catalog](../../monitoring/performance-telemetry-catalog.md)
- [Performance monitoring](../../monitoring/performance-monitoring.md)
- [Plan Usage ARMS custom events](../../monitoring/plan-usage-arms-telemetry.md)
- [ARMS Electron monitoring](../../monitoring/arms-browser-monitoring.md)
- [V4 conversation telemetry compatibility spec](../../monitoring/conversation-telemetry-v4.md)
- [CLI Usage Observability](../../../apps/zcode-cli/docs/design/v2/usage-observability.md)
- [Model implementation design](../../../apps/zcode-cli/docs/design/v2/model/README.md)
- [ARMS OpenTelemetry Node.js onboarding](https://help.aliyun.com/zh/opentelemetry/user-guide/use-managed-service-for-opentelemetry-to-submit-the-trace-data-of-a-node-js-application)
- [ARMS observable data storage](https://help.aliyun.com/zh/opentelemetry/developer-reference/arms-observable-data-storage-overview)
