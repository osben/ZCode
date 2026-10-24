# Compact Stream-first → Non-stream Fallback Design

Status: 2026-07-15, baseline ZCode `feat/streamable-compact`. Scope: the compact summary sidecar request's transport order only. Non-goals: cache-sharing fork, separate summarizer, compact product state or prompt semantics changes.

## Background

`compactActiveConversation()` used to call `modelAdapter.generateText(...)` directly, so the compact summary always went over HTTP non-stream even when main requests used SSE. The target behavior: the compact summary request tries streaming first; when streaming still fails after internal retry and no complete assistant content block has been committed, it may fall back to non-streaming. `thinking_delta` / `content_block_delta` are in-flight content; `content_block_stop` is the commit boundary. Only this transport order and its safety boundary change.

## Goal

One logical compact attempt always runs:

```text
streamText(compactRequest)
  ├─ success → 返回隐藏聚合结果
  └─ terminal failure before committed block
       → generateText(the same compactRequest)
```

Guarantees:

1. Compact streaming deltas never enter session events, UI, or the realtime stream.
2. Fallback never changes compact prompt, tools, thinking, selection, preserve, or persistence.
3. Adapter-internal SSE/HTTP retry policy and auto compact's outer three logical attempts are unchanged.
4. Abort, context-exceeded, and media-too-large keep going to their existing dedicated handling; transport fallback never swallows them.

## Relation to cache-sharing fork

Cache-sharing fork is a compact-internal auxiliary branch reusing the main session's cache prefix and isolating summary generation from main session state. It is neither a precondition of stream transport nor a user-visible session fork. This design does not introduce it, nor a separate summarizer system prompt on its failure; the existing P32 direct-summarizer/cache-sharing gap stays postponed.

## Pre-change implementation boundaries

- Core compact (`apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`) creates one `ModelRequest(querySource=compact)`, assembles projected messages, compact tools, provider options, status sink, trace, and the header refresh hook, calls `modelAdapter.generateText(...)`, and handles abort, media too large, context exceeded, usage facts, summary validation, and persistence. Auto trigger runs at most 3 logical compact attempts; manual runs 1.
- `runner-stream.ts` and `runner-generate.ts` each own SSE/HTTP retry; core never duplicates those loops. Once the stream adapter has emitted a retry boundary event upstream it will not replay SSE; the compact helper can safely switch to HTTP while no complete content block exists because all deltas stay hidden.
- A normal main request's streaming collector emits `ModelStreaming`. Compact must not reuse that visible collector — summary drafts would pollute the session transcript, desktop continuous, and web-remote replayable state.

## Design

### New helper

`apps/zcode-cli/packages/core/src/runtime/methods/compact-summary-model-request.ts`:

```ts
runCompactSummaryModelRequest({
  logger,
  modelAdapter,
  request,
}): Promise<RuntimeModelTextResult>
```

Responsibilities:

1. Iterate `modelAdapter.streamText(request)` first.
2. Aggregate, in memory per content block, the committed text, tool calls, finish reason, usage, and top-level provider metadata that compact actually consumes; for reasoning, record only whether a delta appeared and whether the block completed — no body or block metadata.
3. Never call `createModelStreamingEventQueue()` or publish any `ModelStreaming`.
4. On normal stream completion, return a `RuntimeModelTextResult` shaped like `generateText()`'s.
5. On an eligible stream failure, log one low-frequency warn, then call `modelAdapter.generateText(request)`.
6. On fallback failure, throw the fallback error; the original stream error stays in network status and degradation logs.

### Request identity

`compact-active.ts` builds one request object. The stream leg and HTTP leg share the semantic fields `abortSignal`, `model`, `maxOutputTokens` / `maxOutputTokensSource`, `messages`, `metadata`, `providerOptions`, `statusSink`, `traceContext`, `tools`, `refreshRuntimeHeadersBeforeAttempt`. The header refresh hook may still produce fresh headers per physical attempt; tests compare only provider-visible semantic input, not dynamic headers or adapter request ids.

### Hidden stream aggregation

The compact summary still carries the existing runtime/MCP tool schemas (provider-visible request and cache shape unchanged), but `formatCompactSummaryOrThrow()` rejects any tool call before the executor — compact never executes tools, so it needs none of the main request's "publish tool calls as soon as argument JSON is complete" optimization. The compact request makes one one-way opt-in: runtime-only `preserveProviderStreamBoundaries: true`. The field preserves three groups of provider stream provenance uniformly: the first real provider event ends SSE retry eligibility; same-index/type legality of provider response start, provider content block start/delta/stop, plus whether the final stop reason is truthy, decide whether the stream formed an acceptable result; a real content block stop forms a commit that cannot be HTTP-replayed. An AI SDK-synthesized `start` before the provider stream is read does not count as a provider event and keeps existing adapter retry. The opt-in must be on, and the adapter must observe raw provider chunks, to cover response start, block start/delta/stop, and stop reason that the AI SDK may swallow or synthesize. Every provider `message_delta` overwrites the current stop reason (a later `null` clears it); raw `ping` forms no boundary; any other raw event ends SSE retry, but with no real block stop yet, core may still discard the hidden partial and take the non-stream fallback. Raw chunks never project to core/UI; the adapter sends only bodyless semantic boundary events to the compact collector. Core records each `content_block_start`'s block type by raw block index and validates only delta compatibility (no body parsing): `text_delta→text`, `input_json_delta→tool_use/server_tool_use`, `signature_delta→thinking`, `thinking_delta→thinking/redacted_thinking`; `citations_delta` and unknown future deltas pass when the block already exists. `content_block_stop` commits only when the same index is established, the delta type never mismatched, and the response started. Normal main requests without the field keep existing eager tool-call, retry-safe prelude, and best-effort end behavior — no second boolean or generic transport policy here. Illegal raw start/delta/stop throws immediately; the fallback gate only checks whether a commit already happened, with no "keep draining then judge" middle state.

Event handling:

| `ModelStreamEvent` | Hidden aggregation action | SSE retry eligibility | HTTP fallback commit |
| --- | --- | --- | --- |
| AI SDK synthetic `start` | not saved | kept | no |
| raw provider event (excluding `ping`) | observed only; raw body never projected to core/UI | ends | no |
| provider `response_start` boundary | records provider response established | ends | no |
| provider `content_block_start(index,type)` boundary | records raw block index/type | ends | no |
| provider `content_block_delta(index,type)` boundary | validates block exists, delta type compatible | ends | no |
| provider `content_block_stop(index)` boundary | solidifies real block commit when same-index legal | ends | yes |
| provider `message_delta.stop_reason` boundary | overwrites current truthy stop-reason state | ends | no |
| `text_start` / `reasoning_start` / `tool_input_start` | observes provider event only | ends | no |
| `text_delta` | appends to pending text block | ends | no |
| `reasoning_delta` | records partial delta seen | ends | no |
| `tool_input_delta` | not projected to UI; awaits real input end | ends | no |
| `tool_input_end` / provider-complete `tool_call` | aggregates the denied tool call | ends | inferred only without raw block provenance |
| `text_end` / `reasoning_end` | closes block; text joins the summary only here | ends | inferred only without raw block provenance |
| `tool_call` | normalized, deduped by id, saved | ends | inferred only without raw block provenance |
| `finish` | saves usage/finish/provider metadata | ends | no; also needs the stream completeness gate |
| `error` | normalized into the fallback gate | only pre-first-event stale/watchdog kept; SSE protocol/business errors end | depends on commit state |

`text_delta` / `reasoning_delta` / parseable-but-unstopped tool JSON, even if arrived, stay invisible; they end the physical SSE's retry eligibility, but as long as the whole stream has completed no provider content block, core may discard the hidden partial and run the non-stream fallback — the first-provider-event boundary and the `content_block_stop` commit boundary respectively. The criterion is not whether a single part contains text, nor whether the final summary is empty. For providers with raw message-block provenance, AI SDK-synthesized `text_end` / `reasoning_end` / `tool_input_end` cannot replace a real `content_block_stop`; only providers without that provenance keep the existing normalized-end inference. Pending text that never saw `text_end` cannot join the summary even if a clean `finish` follows; when an unclosed tail block appears after a completed text block, only the completed block survives.

"Empty" is judged per whole provider response, not per part: a completed empty text/reasoning block still reaches block commit, so it neither retries SSE nor replays over HTTP; a stream that cleanly EOFs with no legal response/block/stop reason takes one non-stream fallback instead of another SSE retry. An empty `text_delta`, empty JSON fragment, or bodyless single part never triggers a retry alone. If the stream breaks after a complete tool JSON delta but before the real input end, the adapter must not synthesize a committed `tool_call`; if a normal `finish` arrives, any actual tool call is still rejected by compact deny validation and never reaches the tool executor.

A real provider `content_block_stop` is the tool-block commit for message-block providers. AI SDK may synthesize `tool_input_end/tool_call` from `message_start.content` locally; such events lack a provider block stop and must not preemptively forbid fallback. For providers without raw message-block provenance, a complete direct `tool_call` remains a usable commit inference; even if its name/input validation fails, the adapter must first deliver the commit marker to core and stop SSE retry, then propagate the error, so committed blocks are never HTTP-replayed. Any successfully aggregated tool call is still denied by compact's unified deny — no execution. A lone `finish` only saves results; it must not synthesize `tool_input_end/tool_call` for unclosed tool blocks or impersonate `content_block_stop`.

The assembler's unified flush is decided solely by the compact opt-in: normal main keeps best-effort unclosed-tool-block finalization; compact must never synthesize a commit for a missing real input end, whether it sees provider `finish` or iterator EOF. There are no two behaviorally identical flush entries or `source/includeUnended` parameters.

Under the compact opt-in, the adapter hand-drives `fullStream.next()`; only `next.done=true` is a natural EOF. Retry, terminal error, direct tool-call validation failure, or early consumer exit must abort the physical attempt's linked signal in `finally` before best-effort calling the underlying iterator `return()`. `return()` alone cannot cancel the provider stream retained by AI SDK `tee()`; early consumer exit must also publish one non-retryable cancelled terminal so no dangling SSE `model_request_started` remains before fallback. This cleanup changes no retry/fallback decision and never reverse-aborts the caller signal. Normal main streams do not enable this active-cancel/terminal-completion logic and keep their existing best-effort iterator close on caller/idle abort.

The adapter tags terminal errors with an internal `streamFailurePhase` only on hard evidence, and stores the hard transport status separately as `httpResponseStatus`: iterator not yet constructed, or a real non-2xx response not yet in the SSE body, is `request_setup`; an observed provider boundary, underlying response status 2xx, a received fullStream `error` chunk, or response `content-type: text/event-stream` is `response_body`. The real transport status outranks response headers; `ProviderBusinessError.responseStatus` outranks a possibly business-overridden `statusCode`; the finish payload's `response.status` is extracted as transport status; `RetryError` must be unwrapped before comparing inner evidence. A socket reset before the first event with no status/response evidence stays unknown — never assumed to be setup. A logical `EPIPE` inside a hard HTTP 200 body cannot impersonate stale transport. These fields live only in adapter error context — never in contracts/protocol/UI.

### Fallback gate

On stream error (including iterator tail errors after `finish`), no usable finish, or a clean finish failing the stream completeness check, judge in order:

1. `isTurnCancellationError(error, request.abortSignal)`: rethrow.
2. `isModelContextExceededError(error)`: rethrow — existing compact reselection/truncation handles it.
3. `isModelMediaTooLargeError(error)`: rethrow — existing strip-media retry handles it.
4. A real provider content block stop at the same index as the raw start was received, or (without raw message-block provenance) a normalized text/reasoning/tool block completed: rethrow — no HTTP replay.
5. `streamFailurePhase=request_setup`: existing adapter/API retry may run first; after exhaustion only a real `httpResponseStatus=404` continues into non-stream fallback — other HTTP 4xx/5xx, synchronous runtime/setup, and provider/model/config/request validation errors rethrow.
6. SSE protocol/business errors with `streamFailurePhase=response_body` get no inner SSE retry; with no committed block, non-stream fallback is allowed. Pre-first-event `ECONNRESET` / `EPIPE` / `ConnectionClosed` and the stream idle watchdog keep existing SSE retry; caller cancellation wins — no retry is published.
7. With no committed block before this point: raw message-block provenance missing response start, delta/stop without a same-index start, delta type mismatching the block, or a clean finish with neither committed block nor final truthy provider stop reason — treat as stream-no-events.
8. Other eligible terminal stream failures: discard the hidden partial state and call `generateText(request)`.

After stream `finish` and clean iterator EOF, success requires at least one of "committed block" or "final real truthy stop reason", plus an observed response start for message-block providers. Empty summary with a normal stop reason, committed empty blocks, or committed tool calls still flow to `createCompactContextExceededFinishError()` and `formatCompactSummaryOrThrow()`; AI SDK's default synthesized `finishReason:other` without a raw stop reason proves nothing.

### Timing and counting

```text
CompactStarted(operationId, logicalAttempt)
  └─ ModelRequest（一次逻辑事件）
      ├─ SSE physical attempts（adapter-owned）
      └─ HTTP physical attempts（fallback 后，adapter-owned）
  └─ ModelComplete 或现有 compact failure/retry
```

- `ModelRequest`: created once per logical compact request.
- `ModelNetworkStatusEvent`: kept per physical request, transport `sse` / `http` respectively.
- `ModelComplete`: created once for the final success.
- Auto compact: still at most 3 logical attempts; physical provider request counts never replace this assertion.

### Logging

Fallback is a recoverable degradation; at most one `warn` per logical attempt:

```text
event=compact.summary.stream_to_non_stream_fallback
module=core.runtime
```

It logs only trace, model, an error digest, and whether partial deltas were observed — never prompt, summary, or per-delta content. No new high-frequency info logs.

## Explicitly not done

- No changes to `shouldStreamModelText()` or normal main-request transport.
- No changes to adapter retry counts, backoff, SSE idle timeout, or the main request's generic retry policy; the compact opt-in only preserves the real content-block end so adapter retry and core fallback see the same commit provenance.
- No cache-sharing fork, separate summarizer, or fixed compact model.
- No changes to compact prompt, tool surface/deny policy, thinking, cache control, or media projection.
- No changes to manual/auto/reactive lifecycle, selection, preserved tail, boundary, or post-compact reminders.
- No new protocol schema, UI state, desktop/web remote messages, or snapshot fields.
- No test-compat branch in production code like "if the model adapter lacks `streamText`, go straight to HTTP".
- Tests never use fakes to synthesize sourceless `text_end` to block fallback; legacy fakes only map success results to streams, and failures must pass through as real pre-commit errors.

## Test contract

### Core helper (`compact-summary-model-request.test.ts`)

- Stream success without calling generate.
- First-event failure, no-finish EOF, empty SSE, and `response_start → response_stop` without block/stop reason fall back.
- A final truthy provider stop reason accepts a no-block clean finish; a later `null` clears that eligibility; missing response start, same-index block start, or delta type mismatch falls back when nothing is committed; a bad block after an existing commit keeps the commit and forbids replay.
- AI SDK tool ends synthesized from the response-start payload never impersonate a provider block stop.
- Fallback after text/reasoning delta but before block end; no fallback after any content block/tool call commit (including empty no-delta blocks).
- Abort/context/media never fall back.
- Synchronous setup errors and HTTP 400/401/403/429/500, even after existing API retry exhaustion, never fall back; HTTP 404 stays the fallback special case; real HTTP status vs SSE body logical status are separate.
- A logical 500/1234 error inside an HTTP 200 SSE body gets no second SSE retry and falls back pre-commit.
- Stream-finish empty results/tool calls return to existing validation.
- Fallback success/failure and request object reuse.
- Tool-call dedup, reasoning delta/commit observation, usage/provider metadata aggregation.

### Adapter runner (`runner.test.ts`)

- Normal main-request eager tool-call order unchanged.
- Compact's complete tool JSON publishes only at input end, but commit is decided by the raw provider block stop.
- Compact stops SSE retry after the first real provider start/delta; core decides HTTP fallback directly.
- Compact hands HTTP 200 SSE protocol/business errors straight to core fallback; setup keeps existing API retry; the inner stream keeps SSE retry only for pre-first-event stale transport/watchdog; caller cancellation wins; normal main requests unchanged.
- Real HTTP status outranks the `event-stream` header; a fullStream error chunk's logical status never impersonates request setup; finish `response.status` and RetryError inner status are preserved; a real 404 conflicting with logical 500 still falls back per the real 404, logical-only 404 does not.
- AI SDK's locally synthesized `start` never impersonates a provider event; pre-event adapter retry unchanged.
- Without raw provenance, compact's empty text/reasoning block end still represents a complete block: SSE retry ends immediately and HTTP fallback is forbidden; the Anthropic Messages raw path commits only on the matching `content_block_stop`.
- The same empty block without the compact opt-in keeps the normal main request's existing retry behavior.
- Iterator throw or EOF before the real input end never synthesizes a tool-call commit.
- Direct tool-call name/input validation failure still solidifies the provable commit first — no adapter retry or HTTP replay.
- Compact non-natural EOF aborts the physical attempt, closes the underlying iterator, and completes the cancelled terminal; natural EOF does not double-cancel; the caller signal is unaffected; normal main consumer close keeps its lifecycle.
- Raw response start, content block start/delta/stop with index/type, and each stop-reason overwrite project as compact-only semantic boundaries; raw body never leaks.
- Invalid raw protocol fails immediately at the observation point: falls back with no existing commit, rethrows with one.

### Runtime compact (`runtime-compact.test.ts`)

- manual/auto/reactive all use the stream-first helper; one logical `ModelRequest`, one final `ModelComplete`; compact emits no `ModelStreaming`; existing prompt/tools/thinking/media/context/timeline/retry/persistence assertions keep passing.

### Scripted provider integration (`openai-responses-compact`)

Fixed sequence: main setup SSE success with the marker's request asserted `stream:true`; compact stream leg `stream:true` returning a non-retryable 404; compact HTTP leg returning JSON success missing message `id` / output_text `annotations`; post-compact main SSE success asserted `stream:true` with the summary marker observed in the provider request. Both main requests must be located by setup / post-compact markers — never the loose "some provider request has `stream:true`", since the compact first leg is itself streaming. This fixture supplements F08's provider/transport evidence and adds no conversation product state; F09/C01 only update the "logical attempt vs physical transport leg" terminology, product end states unchanged.

### Desktop formal wiring evidence

`conversation-session-compact-stream-fallback.test.ts` adds one representative path only:

```text
desktop /compact
  -> runtime compact summary
     -> stream:true / synthetic non-retryable failure
        -> non-stream / JSON success
           -> manual compact success marker
```

The first leg must explicitly match `stream:true` and the second must exclude it; the spec also asserts exactly two compact provider requests and verifies from the capture artifact that the last leg is a 2xx non-stream. Normal stream success stays covered by `conversation-session-v4-compact.test.ts`. abort/context/media/commit-boundary branches stay in core unit tests — no desktop/provider Cartesian expansion.

## Acceptance criteria

- The first physical compact request is SSE; stream success issues no HTTP request.
- Eligible stream failure produces an HTTP fallback.
- Partial deltas never enter session/UI; the fallback summary completes once.
- abort/context/media/commit/tool-validation semantics unchanged; auto compact still at most 3 logical attempts.
- The Responses scripted integration proves the `stream:true → non-stream JSON` order; the desktop formal E2E proves `/compact → stream failure → non-stream success → success marker` wiring.
- The desktop compact success fixture reuses the replay server's `response.text` SSE generator instead of hand-written protocol frames; the fallback's non-stream JSON keeps a raw body because it carries the transport contract.
- Core/adapter tests, agent/root typecheck, targeted package lint and build pass.
- The conversation coverage audit must run; if blocked by an existing repository gap, record the baseline error and confirm this diff adds none.
