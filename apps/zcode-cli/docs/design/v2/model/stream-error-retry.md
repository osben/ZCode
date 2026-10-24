# Stream Error Retry

## Background

The app-server mode enables model streaming by default. `streamText().fullStream` of the Vercel AI SDK
may yield a provider 429, 5xx or network failure as an `error` chunk instead of throwing from the async
iterator.

The historical implementation immediately turned the `error` chunk into `ModelStreamEvent.error` for
core, which ended the turn; the custom retry loop of the adapter never got the chance to publish
`model_retry_scheduled`, so the ZCode app-server side could not notify z-code-2 through
`_meta.zcode.apiRetry`.

## Contract

### Generic empty completion

- For an ordinary main request (`preserveProviderStreamBoundaries` not on), if a model attempt ends
  normally but meets all of: `finishReason` is not `stop`/`tool-calls`, text 0, reasoning 0, tool calls 0,
  usage 0, the adapter recognizes it as a generic empty completion and retries automatically **at most
  once**. The retry reuses the unified backoff and status events but does not use the core stream
  recovery budget; if the adapter's `maxAttempts` already forbids a next physical request, no retry
  happens.
- Exceptions cover only context overflow, refusal and content filtering: when `finishReason` or
  `rawFinishReason` hits `context_exceeded`, `context_length_exceeded`, `context_window_exceeded`,
  `model_context_exceeded`, `model_context_window_exceeded`, `prompt_too_long`, or `refusal`,
  `content-filter`, `content_filter`, then even if text/reasoning/tool/usage are all zero the generic
  empty completion retry must not stack. The criterion only trims and normalizes case and does not extend
  its range by fuzzy matching of arbitrary error text. Non-streaming requests read the top-level SDK
  `rawFinishReason`, staying compatible with the existing `providerMetadata.rawFinishReason`; streaming
  finish supports both sources too; this is used for the empty-response decision and does not change the
  existing metadata passthrough or business error recognition. The existing empty-response handling of
  `stop`, `tool-calls`, `tool_calls` is unchanged. Ordinary `length`, `max_tokens`, `max_output_tokens`
  and `other`/`unknown` keep the earlier decision. EOF detection and recovery for a missing finish are
  unchanged.
- When there is an explicit context overflow with no body, no valid reasoning (including opaque metadata)
  and no complete tool call, the Adapter converts it, before a successful finish/completed, into the
  existing `ModelContextExceeded`, publishes one `model_request_failed`, and lets the existing catch of
  Core decide Reactive Compact and retry, without appending Continue. The decision is independent of
  whether usage is zero. Other responses stay as they are, including any context-limit response with valid
  output; the Adapter does not judge Continue and does not migrate or delete the existing
  successful-response compatibility branch of Core. The error keeps the usage the provider already
  reported, accounted by the existing failure event; no `ModelComplete` is forged. compact itself reuses
  the existing error/fallback boundary and changes neither the recovery count nor the cancellation
  semantics.

```text
provider completion -> adapter checks the termination reason
                       | explicit context overflow + no valid output -> failed -> core existing catch / Reactive Compact
                       | other responses -> existing empty-response retry decision and caller handling
```

- For the first attempt of a generic empty completion, no `start`, `finish` or other event belonging only
  to that attempt may be released to core before the retry; if the second is still empty, the existing
  behavior is kept and core generates the visible `empty_model_response` error. Non-streaming
  `generateText` and streaming SSE use the same count cap and boundary.
- A generic empty completion must not override a provider business error: if finish/provider metadata can
  resolve a safety check, authentication, quota, content filter or other business error, classify as the
  business error first and keep its existing retryable/non-retryable policy. User cancellation must not
  trigger the empty completion retry either.
- The compact request with `preserveProviderStreamBoundaries=true` is outside this rule; compact keeps
  being decided by its provider boundary, stream-to-non-stream fallback and commit boundary rules.

### Streaming retry boundary

- If a streaming request receives a retryable `error` chunk, or the iterator throws a retryable network
  error, before the first committed model event, it is handled by the unified retry policy of the adapter.
- Before a retry, `model_request_failed` and `model_retry_scheduled` must be published, so core/the ZCode
  app-server can keep forwarding the retry status.
- The runtime status events keep using `attempt` / `maxAttempts` for the total attempt count; the TUI and
  the private UI metadata of the ZCode app-server must convert them in the projection layer into the
  user-visible retry count, the first retry showing `1/N`.
- During a retry no `ModelStreamEvent.error` should be produced to core, because that event means the
  turn is unrecoverable.
- The adapter may buffer and discard side-effect-free streaming prelude events, currently `start`,
  `text_start`, `text_end`, `reasoning_start`, `reasoning_end`, `tool_input_start`, `tool_input_delta` and
  `tool_input_end`. These events do not immediately write assistant content into the session store nor
  execute tools; if the attempt then fails they are dropped and the next attempt starts over.
- In an ordinary main request, `reasoning_delta` / `text_delta` with zero text length are retry-safe
  prelude too. The Anthropic `signature_delta` is turned by the AI SDK into an empty `reasoning_delta`
  carrying signature metadata; it must be buffered with the prelude and must not trigger the
  already-output boundary. On success the full events and the signature are released in the original
  order; on a retryable failure the prelude of the current attempt is dropped. The decision is
  `text.length === 0`, with no trim, no signature dropping and no special case for specific provider error
  codes.
- A non-empty `reasoning_delta` is user-visible live thinking output and must be released to core and the
  UI at once, so, like non-empty `text_delta`, `tool_call`, `finish` and `error`, it crosses the adapter
  retry boundary. A retryable failure after crossing is handed to core recovery; the adapter must not
  cache visible reasoning until body or tools appear.
- The buffering and release of empty deltas stays solely held by `pendingRetrySafeEvents` of the current
  attempt of the adapter, reusing the existing error classification, request cleanup, backoff and budget;
  cancellation, non-retryable errors, budget exhaustion and the compact
  `preserveProviderStreamBoundaries` boundary keep their original semantics. core adds no zero-byte
  recovery and no second budget.
- The boundary sits inside the CLI and retry status keeps being projected through existing model status
  events. Desktop `desktop-continuous` keeps the direct continuous link, mobile `web-remote-replayable`
  keeps snapshot/gap recovery; no protocol, persistence field or migration is added, and host attachment,
  workspace identity and tool execution timing are unchanged.
- A retryable failure after crossing the adapter retry boundary does not mean the turn must end. The
  adapter still throws the failure up to core, but the core runtime may start a new SSE streaming request
  from the nearest provider-safe recovery anchor per `streaming-tool-execution-and-recovery.md`. This
  runtime recovery must explicitly discard the assistant tail of the failed attempt and must not merge
  partial text into the next request context.
- If a failure hits the declarative fallback of an execution Selection, the model switch must still obey
  the same recovery anchor contract: first close complete tool calls pairwise with real or synthetic
  results, then switch the model; the discarded assistant uses the unified `StreamRecoveryDiscarded`
  persistence marker. It means "waiting for later recovery" and not request success: when the last item is
  still that attempt, cold recovery makes it interrupted, and only when a later normal assistant exists is
  it restored as success. If no fallback target can be resolved, the accepted tools must first be
  committed as real, cancelled or synthetic interrupted results so durable ToolParts and live/cold history
  close; then the original provider error ends the turn, no fallback request is issued, and there is no
  return to the failed execution provider for recovery. If settlement committed tool results, the
  output-token continuation budget must be reset; a pure text/reasoning tail discard does not reset it.
  This boundary uses the same runtime events/persistence facts for desktop continuous and mobile
  replayable.
- SSE streams do not use the ordinary HTTP total request timeout; the adapter uses an inter-event idle
  timeout. Each wait for the next AI SDK stream chunk / SSE event is timed separately and reset when an
  event arrives; the total time may exceed the initial idle timeout. The default initial idle timeout is
  600000ms, overridable with `modelStream.idleTimeoutMs` in `~/.zcode/cli/config.json`. The SSE idle
  timeout increases per retry: the first request uses the configured base timeout, the first retry adds
  30000ms to the base, the second adds 60000ms, and every later one adds another 30s. The internal
  pre-output retry of the adapter increments by `attempt - 1`; a core stream recovery after crossing the
  adapter boundary must pass `streamRecovery.retryNumber` to the adapter as the request-level retry
  number, because to the adapter the recovery request still looks like a new `attempt=1`.
- When the SSE idle timeout fires, `model_stream_stalled` must be published, the current provider request
  aborted and the failure normalized to `stream_idle_timeout`. If the retry boundary has not been crossed
  the unified adapter retry budget is reused; if a non-empty `reasoning_delta`, non-empty `text_delta`,
  `tool_call` or `finish` has already been produced, the adapter must not replay automatically and the
  stream failure is handed to the core runtime recovery to decide whether to start a new SSE streaming
  request.
- v1 adds no `stream_reset` event; the adapter releases no invisible retry-safe prelude upstream before
  reaching the retry boundary or the successful end of the stream. A non-empty `reasoning_delta` is
  already a live-visible boundary; core uses the existing `stream_recovery_tail_discarded` so the
  projection closes the failed row as interrupted, and a new assistant message id then carries the
  recovered stream.
- A non-retryable error or an exhausted retry budget should be wrapped into a stable adapter error,
  keeping the original cause, statusCode, attempt, requestId, traceId and model information.
- The retry budget tier `modelRetryBudget` is bound by the runtime on the model handle and read-only for
  the adapter: `default` uses the `maxAttempts` resolved by the adapter; `unbounded` is for the workflow
  actor, unbounded for transient failures; `single-attempt` narrows the request's `maxAttempts` to 1, so
  a transient failure is not retried and the first failure is thrown up to core. `single-attempt` is used
  only for execution-scope Selections with a `selectionFallback` declaration (such as the Highspeed
  acceleration card), where core, after a failure, falls back to the session model and continues the
  turn; it does not change the backoff curve, failure classification, the extra attempts of auth
  refresh/signature repair or the compact boundary, and the status event reports `maxAttempts` as 1
  truthfully.
- An internal adapter retry is a new physical provider request; every new `model_request_started` must
  carry a new `requestId` and `x-request-id`, correlated by the same `traceId` and the increasing
  `attempt`; `model_retry_scheduled` still belongs to the old request that just failed.
- Every physical stream attempt that ends because of a provider, network or stream read error must,
  before entering the next retry or throwing the final error, abort its own request signal and, in the
  same bounded barrier, wait for the asynchronous close of the iterator and the consumption cleanup of the
  AI SDK `fullStream` tee's retained branch; this cleanup does not depend on
  `preserveProviderStreamBoundaries`. A close exception or timeout logs only a low-frequency warn and
  must not override the original provider error or block the retry indefinitely. A natural EOF does no
  extra abort; an ordinary consumer ending early and a caller stop keep the asynchronous best-effort
  close and must not be slowed by the internal cleanup timeout.
- A provider business error inside an HTTP 200 SSE must be recognized first at the provider fetch
  boundary, for example `event: error` + `error.code/error.message` in the `data` JSON. If the business
  error maps to `HTTP 5xx`, or its structured provider code clearly indicates an upstream network failure
  such as `1234`, `network_error` or `network_error_retryable`, and the request has produced no committed
  model event to core yet, the unified adapter retry budget is reused; otherwise the stream body should
  fail and the Model Runner publishes the final `model_request_failed`.
- After the fetch boundary checks the JSON business error through `Response.clone()`, if it decides to
  throw `ProviderBusinessError` it must consume the original response body in a bounded way; consuming
  only the clone and leaving an unreachable original tee branch occupying a connection slot is forbidden,
  as is the underlying stream pending forever and blocking the throw of the parsed business error.
  Complete consumption is preferred over just calling `cancel()`, because the completion of `cancel()`
  does not mean the Undici connection is reusable.

## Recovery semantics after SSE events were received

After an SSE stream is interrupted there is no connection-level resume and no `Last-Event-ID` stitching of
model output. A model generation stream is not an ordinary subscription stream: when the connection
drops, the provider side may have kept generating, executed provider-native tools or dropped internal
state, and the client cannot prove the "next event" attaches seamlessly after the tokens already
received locally. So ZCode's recovery object is the model semantic state and not the SSE connection
itself.

Recovery flow:

1. After detecting an idle timeout, EOF-before-finish, `response.failed` or an iterator error, the adapter
   must first abort the current provider request.
2. The core runtime freezes the stream ledger received in this attempt, distinguishing stable anchors from
   the incomplete tail.
3. The runtime drops the incomplete tail and starts a new model request only from the nearest
   provider-safe anchor.
4. The `model_request_started` of the new request must carry `streamRecovery` metadata, containing at
   least `recoveredFromRequestId`, `retryNumber` and `maxRetries`, so logs can directly chain "old request
   failed -> new request recovered". core must also pass the same `retryNumber` to the adapter as the
   request-level SSE idle timeout retry number, so the idle timeout of the first recovery request
   increases by 30000ms on the configured base timeout instead of keeping the first-request window.

Event commit boundary:

| Event | Recovery handling |
| --- | --- |
| `start` / `text_start` / `reasoning_start` | Recorded only as attempt prelude, not a recovery anchor. |
| Empty `text_delta` / empty `reasoning_delta` (including pure signatures) | Buffered in ordinary requests before the first valid output; dropped with the prelude on a failure retry, released in the original order with metadata kept on success. |
| Non-empty `text_delta` | May be shown and recorded live, but before `finish` it is an incomplete assistant tail; it must be dropped on recovery and not sent back into the model context as a completed assistant message. |
| Non-empty `reasoning_delta` | May be shown and recorded live, but is not a model context anchor; dropped with the failed tail on recovery. |
| `tool_input_delta` with no `tool_call` formed yet | The tool is not executed; dropped on recovery. |
| `tool_call` accepted but the tool not executed | The tool is not treated as completed; on recovery the next model request decides again, or a synthetic not-executed result is recorded. |
| Tool executed and result committed | That tool result is a provider-safe anchor; the recovery request must keep the assistant tool_call and the tool result, avoiding re-execution. |
| Tool execution state unknown or with side effects | Must not be re-executed; a synthetic interrupted tool result must be written or recovery blocked. |
| `finish` / provider `response.completed` | This stream succeeded completely; the recovery state is cleared. |
| `error` / provider `response.failed` / EOF-before-finish / idle timeout | Enters the adapter retry or core recovery, depending on whether the adapter retry boundary was crossed. |

Observability requirements of core recovery:

- `stream_recovery_started` must record the failure reason, `failedRequestId`, `retryNumber` and
  `maxRetries`.
- `stream_recovery_tail_discarded` must record the discarded assistant message, the body/thinking byte
  counts and the tool call IDs.
- `stream_recovery_retry_started` must record the chosen `anchorId` and `failedRequestId`.
- The `model_request_started` that follows must carry `streamRecovery.recoveredFromRequestId`, so users
  need not guess from timestamps whether a request was really re-issued.
- The ZCode app/server/UI projection layer must convert
  `model_request_started.streamRecovery.retryNumber/maxRetries` into the existing `apiRetry` run state, so
  the retry hint at the bottom of the running turn shows the core recovery `1/10`, `2/10` and is not
  cleared by the adapter `attempt=1`.
- `model_request_started attempt>1` of an ordinary adapter retry only means "next request starts", not
  recovery success, and must not clear `apiRetry` at once; otherwise the hint at the bottom of the running
  turn flickers between "retrying" and empty during network jitter.
- The recovery success boundary of `apiRetry` is the retry attempt first producing valid model progress
  (`text_delta` / `reasoning_delta` / tool input / tool call) or the request completing successfully; a
  final failure, cancellation and the turn terminal state must also clear this run state.
- The request-level SSE idle timeout retry number of core recovery must equal `streamRecovery.retryNumber`;
  the default base timeout is 600000ms, so the 1st recovery uses 630000ms, the 2nd 660000ms, and each
  later one adds 30000ms.

## SSE idle timeout config

`~/.zcode/cli/config.json` supports configuring the initial idle timeout of model streaming:

```json
{
  "modelStream": {
    "idleTimeoutMs": 600000
  }
}
```

- The unit of `modelStream.idleTimeoutMs` is milliseconds: the longest silence while waiting for the next
  SSE/AI SDK stream event.
- The value controls only the base timeout of the first request; adapter retry and core stream recovery
  still add 30000ms per retry.
- It is not an ordinary HTTP total request timeout. As long as stream events keep arriving, the total time
  of one model request may exceed it.
- It is read when the model adapter is constructed; after modifying `config.json` a new agent/runtime must
  be created to guarantee it takes effect, with no promise of hot update on an already constructed
  adapter.
- Do not put it in `provider.options.timeout` / `chunkTimeout`. Provider config describes vendor
  connection parameters, while `modelStream.idleTimeoutMs` describes ZCode's own recovery boundary for SSE
  event silence.

## Environment variable overrides

The default retry policy of the model adapter can be overridden with `ZCODE_` environment variables; the
entry exists only in the bootstrap/adapter layer and core does not read `process.env`.

| Environment variable | Default | Semantics |
| --- | --- | --- |
| `ZCODE_MODEL_RETRY_MAX_RETRIES` | `10` | Maximum retries of a retryable failure, not counting the first request; `maxAttempts` in runtime events equals this value plus one. |
| `ZCODE_MODEL_RETRY_BASE_DELAY_MS` | `2000` | Initial delay in milliseconds of the exponential backoff; may be `0`. |
| `ZCODE_MODEL_RETRY_BACKOFF_FACTOR` | `2` | Exponential backoff multiplier of each retry delay; must be greater than `0`. |
| `ZCODE_MODEL_RETRY_MAX_DELAY_MS` | `60000` | Upper bound in milliseconds of the ordinary exponential backoff delay; may be `0`; a provider `retry-after` hint still takes precedence when `x-should-retry` is not explicitly `false` and it does not exceed 5 minutes or is shorter than the current exponential backoff. |

Precedence: the `retry` option explicitly passed to the adapter > `ZCODE_MODEL_RETRY_*` environment
variables > built-in defaults. An illegal environment variable value does not fail startup; the adapter
ignores it and falls back to the next default layer, so a wrong debug variable cannot make the CLI fully
unusable. Logs and status events must not output the full set of environment variables and may expose
only the normalized retry budget.

## Test coverage

- After a pure-signature or empty-body delta, with only an unfinished `tool_input_start` /
  `tool_input_delta`, an SSE 503 error chunk, connection reset or idle timeout must take the adapter retry
  and not leak the signature, empty deltas and tool input of the failed attempt to core. When the AI SDK
  normalizes a premature EOF into an empty completion, keep verifying the existing single empty completion
  retry; this change does not extend EOF detection or its budget.
- The signature of a successful attempt must be fully kept and released in the original order before the
  complete tool call; non-empty body/thinking, a complete `tool_call` and the compact provider boundary
  still stop adapter replay. Cancellation, non-retryable errors and budget exhaustion add no requests.
- When the stream `error` chunk is 429, retry before the first committed output and publish
  `model_retry_scheduled`.
- An ordinary streaming SSE ending with `finishReason=other` and zero text/reasoning/tool/usage must
  publish `model_retry_scheduled` exactly once and not leak the events of the first attempt to core; when
  the second succeeds only the valid output of the second is finally seen, and when the second is still
  empty `empty_model_response` is still generated.
- When non-streaming `generateText` returns the same zero-output empty completion it retries only once;
  the second returns a valid result, or the second is still empty and the existing empty-response error
  goes to core.
- Streaming and non-streaming zero-output `rawFinishReason=model_context_window_exceeded` produces no
  adapter retry and converts into one overflow failure keeping the reported usage; this holds whether the
  normalized finish is `length` or `other`. Synonym markers of context overflow are handled the same way;
  a response with valid output is returned unchanged whether or not finish is continuable. Refusal,
  content filtering, ordinary output limits and unknown markers keep their original behavior.
- Desktop I73 builds the replay precondition through the Personal Provider UI from a no-account state
  without seeding an unrelated fake OAuth credential, so a login-expired popup does not cover the tested
  interaction. The Provider is initialized only once, each scenario creates a task and selects the model
  through the UI, and no thinking level unrelated to retry semantics is required. It also verifies an
  empty SSE with an explicit context limit: first prepare compactable history, then strictly run three
  requests overflow failure → compact → recovery with no appended Continue; the final normal reply returns
  to idle, and the usage of the failed request, compact and recovery request is recorded independently and
  summed without duplicates or omissions.
- An empty completion of compact `preserveProviderStreamBoundaries=true` must not get an extra retry from
  the ordinary main request rule.
- When the second stream after a retry succeeds, only success events are finally produced to core.
- The `model_retry_scheduled` event should keep `reason=rate_limited`, `statusCode=429`, `nextAttempt`
  and `delayMs` for the ZCode app-server to convert into `_meta.zcode.apiRetry`.
- `model_request_started attempt>1` of an ordinary adapter retry must not clear `apiRetry`; only the next
  model progress or successful completion clears it, avoiding retry state flicker.
- A non-zero business code carried by a provider SSE `event: error` must normalize into
  `ProviderBusinessError`, and the user finally sees the provider message instead of empty output or
  `finishReason: other`.
- A provider business error that maps to `HTTP 5xx` or clearly indicates a provider network failure takes
  the unified retry budget before the first committed output; the final failure is published after the
  cap.
- After an iterator receives only `reasoning_delta` and then hits `ECONNRESET` or an idle timeout, the
  adapter should keep the live-visible reasoning and throw the failure up; core must discard the
  unfinished reasoning tail of that attempt and start a new SSE request from the previous provider-safe
  anchor. The recovery request must not carry the failed reasoning and must not append new output to the
  old assistant message id.
- A retryable failure with no provider event at all, or with only retry-safe prelude not yet released, is
  still retried by the adapter inside the same logical request without consuming the core recovery
  budget.
- When an iterator hits `ECONNRESET` after receiving only `tool_input_delta` and before `tool_call`, the
  buffered tool input events of that attempt are dropped and retried.
- A failed attempt of an ordinary stream, even without `preserveProviderStreamBoundaries`, must abort the
  request signal before the next retry starts and wait for the asynchronous close of the iterator to
  complete or reach the internal cleanup timeout; tests must separately prove that the next attempt does
  not start before the async close completes, and that a close that never completes does not block
  forever. The existing behavior of an ordinary consumer ending early must not change with it.
- Resource isolation of consecutive HTTP business errors must use a real AI SDK provider and a local HTTP
  server covering the full default retry budget; the test must prove from the server that all 11 physical
  requests actually arrived and that the last original provider error is received after the budget is
  exhausted. A mock iterator callback, `Response.bodyUsed` or `model_request_started` can only prove the
  caller entered the cleanup/retry code and cannot replace evidence that the connection slot and reader
  were released.
- When the SSE event gap exceeds `modelStream.idleTimeoutMs`, `model_stream_stalled` should be published,
  the provider request aborted, and the failure/retry event entered with `stream_idle_timeout`.
- The SSE retry idle timeout increases with the retry count; tests must cover the adapter publishing the
  increased `model_stream_stalled.timeoutMs` according to the request-level retry number.
- When the total SSE time exceeds `modelStream.idleTimeoutMs` but each event gap is below the idle timeout,
  it should complete normally and not trigger the ordinary HTTP total timeout.
- The `modelStream.idleTimeoutMs` config should enter the runtime config from `~/.zcode/cli/config.json`
  and be passed to `AiSdkModelAdapter`.
- A retryable network error after the iterator has produced `text_delta` or `tool_call` must not retry
  automatically.
- A core recovery `model_request_started`, even with adapter `attempt=1`, as long as it carries
  `streamRecovery.retryNumber/maxRetries`, makes the ZCode UI, the service runtime snapshot and the
  protocol `_meta.zcode.apiRetry` all show the matching retry count.
- `ZCODE_MODEL_RETRY_MAX_RETRIES` overrides the default retry budget, and `maxAttempts` is still reported
  as "first request + retry count".
- With `modelRetryBudget = single-attempt`, a transient failure like 429 must not publish
  `model_retry_scheduled`, the first failure is thrown as an adapter error, and the status event
  `maxAttempts` is 1; this holds for both streaming and non-streaming.
- `ZCODE_MODEL_RETRY_BASE_DELAY_MS`, `ZCODE_MODEL_RETRY_BACKOFF_FACTOR` and
  `ZCODE_MODEL_RETRY_MAX_DELAY_MS` override the exponential backoff defaults.
- An explicit adapter `retry` option has priority over environment variables; an illegal environment
  variable value falls back to the default.
