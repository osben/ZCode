# Chat Error Banner ARMS Structured Attribution

Full history: `git show b8876e8b:docs/trace/chat-error-banner-attribution.md`

## 1. Goal

`chat_error_banner` is the ARMS reporting entry for UI-visible errors. It records the error exposure
fact only; it must not change model request retry, error codes, error copy, session state or provider
business actions.

`failure_reason` is taken from `ErrorAttribution.reason`. Because the model adapter keeps `unknown` for
old callers and provider business codes, these facts could not be aggregated in ARMS: upstream proxy
`ERROR_RATE_LIMITED` text; BigModel `1309` (Coding Plan expired); HTTP 402 + `Insufficient Balance`; the
same 402 root cause split into different display reasons by the adapter wrapper and upstream
`invalid_request_error`.

## 2. Attribution rules

All derivation happens only at the ARMS payload boundary. It never changes UI error codes, retry or
runtime state. When the root cause cannot be proven the value stays empty and the event lands in
"new schema, attribution pending". `unknown` means no reliable evidence; a new provider error never
justifies changing the product error flow.

1. `failure_reason` and `error_source` are decided in one attribution step by the same evidence. Never
   back-derive "provider" from an arbitrary non-empty reason after losing the provider code, HTTP status
   or controlled copy source.
2. A non-`unknown` structured reason keeps its value (protects existing ARMS aggregation). The only
   exception is rule 6.
3. Ambiguous reasons that can mean either local validation or provider rejection (for example
   `invalid_request`) with no structured source or upstream evidence keep the reason only;
   `error_source` stays empty.
4. Only low-cardinality standard reasons are reported; never full provider message, URL, header,
   credentials or user input. Raw code keeps going through the existing `provider_error_code` field.
5. Old protocol error detail, session projection and task meta may carry an optional `attribution`;
   when absent the legacy path applies. Live and cold hydration must not drift in attribution.
6. Builtin terminal quota codes `1304` / `1308` / `1310` / `1313` etc. may stay `rate_limited` for the
   adapter's runtime failure/retry classification, but the `chat_error_banner` telemetry reason is
   normalized to `quota_exhausted`. Accepted only for a trusted builtin provider identity or a strictly
   matching `[code][message][request-id]` ZCode history envelope; a custom provider's same-numbered code
   is not an official business code.
7. `error_message` stays the visible banner copy (already a user-visible exposure fact).
8. Model-boundary facts (deterministic local validation before the request) may be written with the
   existing `ErrorAttribution` fields; provider business code/message normalization happens only in
   `chat_error_banner` telemetry. Neither changes the adapter's `ModelFailureReason` vocabulary, retry
   decision, error code/message or the ChatErrorBanner main copy.

### 2.1 Priority

```text
existing non-unknown structured reason
  -> trusted builtin terminal quota code normalization
  -> stable local error code / error wrapper derivation
  -> trusted provider business code / generic semantic code under provider source
  -> HTTP status + message/code combination
  -> strict legacy envelope / controlled visible-copy patterns
  -> unknown
```

Each level returns `{ errorSource, failureReason }` from the same evidence.

### 2.2 Derived facts

Legacy wrappers without `ErrorAttribution`:

- `model_config_missing` -> `error_source=runtime`, `failure_reason=model_config_missing`.
- `StreamRecoveryDiscarded` -> `runtime` / `stream_recovery_discarded`.
- `ERR_SQLITE_ERROR` -> `runtime` / `storage_error`.
- Adapter errors with explicit provider/network semantics: derive source/reason from stable error code
  or controlled copy.
- Provider rejection facts still provable from old wrappers: `1301`, `1213`, `3012` and `BAD_REQUEST`
  under a provider source all map to `invalid_request`; HTTP `405` maps to provider `invalid_request`.
  When SSE reached `response_body`, or a non-streaming request reached the `response`/`parse` phase,
  `source` is provider even without HTTP status/provider code; request-preparation stage keeps runtime.
- Bare `Model request failed.` with no response/stream boundary or other upstream evidence stays
  `unknown` (never faked into a provider/network root cause).
- Pre-request model capability/option validation is written by the model boundary as
  `error_source=runtime`, `failure_reason=invalid_request` (the UI must not guess from copy).
- Old transcripts without attribution: telemetry consumes only allowlisted provider codes, stable error
  wrappers and controlled copy; bare `Model request failed.` / `openai_error` are never guessed.
- An old event already `source=provider` with empty or `unknown` reason plus strong network evidence
  (EPIPE, ECONNABORTED, ECONNRESET, ECONNREFUSED, ENOTFOUND, ETIMEDOUT, `UND_ERR_*` timeout) atomically
  yields `network/network_error` or `network/timeout`; the strong evidence is never overridden by the
  coarser source. Stable transport codes use a controlled allowlist covering the Node/Undici network and
  timeout codes the adapter recognizes; an old event keeping only `providerErrorCode` is still recovered
  by code.
- BigModel `1234` is a provider business envelope with network semantics: legacy
  `[1234][message][request-id]` recovers to `network/network_error` (never the contradictory
  `provider/network_error`).
- HTTP `413` alone does not decide a reason: token/context evidence -> `context_exceeded`; request
  body/tool/media structural evidence -> `invalid_request`; otherwise `unknown`.
- Explicit provider codes (`UPSTREAM_NOT_FOUND`, `quota_limit`, `invalid_input`, `validation_error`,
  `internal_server_error`) return their atomic attribution; `getaddrinfo` DNS failures, early-ended or
  truncated streams and server-disconnected copy -> `network/network_error`; explicit in-flight/
  concurrency cap, provider server fault, balance/arrears/budget, invalid tool/input/model and embedded
  HTTP 400/500 map to existing standard reasons; a legacy three-part envelope whose outer error code
  equals the envelope code may consume the allowlisted code, but an envelope code that conflicts with a
  non-wrapper outer code is rejected.
- `ZCode Protocol session stopped` is a ZCode-generated historical cancel signal: cold hydration restores
  it as cancelled, never a visible error. `off-peak-ticket-expired` is attributed only as
  `runtime/offpeak_ticket_expired` (the UI does not know whether requeue succeeded; the Banner is not
  hidden by copy).

Still `unknown` (no stable root-cause evidence; awaiting structured fields from the adapter/owner): bare
`Model request failed.`, `get_channel_failed`, `Provider returned a business error.`,
`gateway_survival_resume_blocked`, bare `openai_error`, `Request could not be completed`, `terminated`,
`aborted`.

### 2.3 Generic `Model request failed.` phase buckets

No new fallback reason is added to "eliminate unknown". The runner writes the low-cardinality failure
phase already used for ModelNetworkStatus / OTel into the terminal error attribution and normalizes the
raw exception into a controlled `exceptionKind`:

- `errorPhase` reuses `prepare | configuration | connect | response | stream | parse | validation | unhandled`.
- `exceptionKind` is only `api_call | provider_business | transport | validation | protocol | type_error | generic`;
  arbitrary exception names are never passed through.
- A normal stream failing before iterator creation is `prepare`, after creation `stream`; generate still
  distinguishes `prepare/response`; retry sleep is `connect`.
- `failure_reason=unknown` may remain, but new events must bucket by phase/exceptionKind and drill down
  through the existing `trace_id` into model-attempt OTel, without uploading raw message, stack or
  requestId.

### 2.4 Standard reasons

Existing values plus safely identifiable additions: `rate_limited`, `quota_exhausted`,
`balance_insufficient`, `plan_expired`, `plan_access_denied`, `model_not_found`, `context_exceeded`,
`server_error`, `network_error`, `timeout`, `stream_idle_timeout`, `tls_error`, `auth_failed`,
`invalid_request`, `provider_not_configured`, `provider_overloaded`, `offpeak_ticket_expired`.

## 3. Invariant

```text
user request -> adapter / retry / session state   (unchanged path)
          └-> TurnError -> ChatErrorBanner
                            └-> buildChatErrorBannerTelemetryPayload
                               └-> single evidence parse -> failure_reason + error_source
```

ARMS reporting failure is handled by the existing side path and must not block the UI or model request.

## 4. Verification

- Proxy rate-limit copy, 1309, 402 Insufficient Balance, 429, 5xx, unknown errors.
- Model capability/option local pre-checks; strict legacy 1210/1211/1214/1301/1305/1308/1310 envelopes;
  legacy 1234 network envelope; EPIPE/ECONNABORTED/ECONNRESET/ECONNREFUSED/ENOTFOUND;
  ETIMEDOUT/`UND_ERR_*` timeout; 413 context/request-body split; off-peak marker.
- Second-round unknown evidence (DNS, stream termination, in-flight/concurrency, provider server,
  balance/budget/arrears, invalid tool/input, UPSTREAM_NOT_FOUND, embedded 400/500) with negative cases
  for the unknown inputs above.
- Phases: normal stream prepare/stream, generate prepare/response, retry connect; controlled
  exceptionKind; live/cold hydration equivalence; `failure_phase` / `failure_exception_kind` ARMS
  expansion.
- Existing non-`unknown` reasons unchanged; trusted builtin quota codes change only telemetry reason,
  not adapter retry / UI action; with source missing, explicit network/runtime reasons still get the
  right source and ambiguous reasons stay empty; historical `ZCode Protocol session stopped` restores as
  cancelled while similar provider copy remains an error; `error_message`, `error_code` and sanitized
  provider/model fields unchanged.
- UI focused tests, `pnpm typecheck`, `pnpm lint`.
