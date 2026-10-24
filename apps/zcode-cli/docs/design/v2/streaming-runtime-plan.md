# Streaming Runtime Production Plan

## Status

Plan for upgrading ZCode from the batch-style agent loop to a production streaming runtime.

Implemented so far (Phase 0/1 initial slice):

- Core can opt into `streamText()`; normalized model stream events are emitted as `model_streaming`, and
  the TUI renders text deltas into the active assistant response.
- Stream-path tool calls are collected after a model step completes and then routed through the existing
  `ToolExecutor`.

Not implemented: streaming tool execution before model step completion (Phase 5).

Baseline the plan builds on:

- `packages/adapters/src/model/runner.ts` has an AI SDK `streamText()` wrapper that maps a small subset of
  stream chunks into `ModelStreamEvent`.
- `packages/core/src/runtime.ts` drives the main loop through `modelAdapter.generateText()` and extracts
  complete tool calls after the model response finishes.
- `SessionEventType.ModelStreaming` exists; the plan reuses the current event sink and permission broker
  instead of adding a second UI channel.

## Goals

- Stream assistant text and reasoning deltas through `SessionEvent`.
- Keep tool execution inside ZCode `ToolExecutor`: schema validation, permission broker, trace, artifact
  storage, timeout, cancellation and result budgeting must not be bypassed by AI SDK tool execution.
- Streamed model output, tool calls, approvals, tool results, cancellation, retries and turn completion
  are recoverable from session state.
- Preserve the non-interactive `submitPrompt()` API shape.
- Keep provider-specific behavior in model adapter/transform code, not in core.

## Non-goals

- No direct provider wire protocols; AI SDK remains the adapter boundary.
- Streaming tool execution is not required for the first production streaming release; running tools as
  soon as their complete input appears is a later optimization.
- No second event model for TUI or ZCode app-server; `SessionEvent` remains the fact model.

## Design Patterns

Stream loop and persistence:

- `streamText()` is the only hot path for normal LLM calls.
- Stream chunks become persisted message parts: text, reasoning, tool, step start, step finish, retry,
  patch.
- Provider quirks stay in `ProviderTransform`: message cleanup, tool call id normalization, provider
  options, unsupported media handling.
- On resume, pending/running tool calls become interrupted tool results so the next provider request
  never contains dangling tool calls.
- The loop is driven by persisted message/part state, not only by transient in-memory stream objects.

Stream events and tool orchestration:

- Stream handling splits into item started, delta, item completed and response completed events.
- Completed model output items are persisted immediately, then tool futures are queued.
- In-flight tool futures drain before deciding whether the model needs a follow-up sampling request.
- A central tool orchestrator handles approval, sandbox selection, retry and escalated execution.
- Cancellation propagates through a turn-level token with child tokens for model/tool work.

Streaming tool execution:

- The query loop is an async generator yielding model/tool/progress messages during execution.
- It is feature-gated and introduced after the basic stream loop is correct.
- Concurrency-safe tools may run in parallel; unsafe tools run exclusively.
- Tool results are buffered so model-visible ordering stays valid.
- If streaming fallback or interruption creates orphaned tool calls, emit synthetic tool results or
  tombstones so transcript/history stay valid.

## Architecture Decisions

1. Core owns the streaming state machine. The adapter normalizes AI SDK stream chunks; core decides when
   to emit events, persist parts, schedule tools, wait for permission, execute tools and loop.
2. AI SDK tools are projection only. `toAiSdkTools()` keeps exposing schemas without provider-side
   `execute`. A model tool call becomes a ZCode `ExecutableToolCall` only after core validates and
   schedules it.
3. `SessionEvent` is the durable streaming API. Every user-visible delta or lifecycle transition first
   becomes a `SessionEvent`; TUI/ZCode app-server/debug clients project from those events.
4. Production v1 executes tools after a streaming model step completes. This matches the generate-text
   loop semantics while giving token streaming and stream-path tool calls. Starting tools before model
   finish is an explicit later phase.
5. No transparent retry after committed stream output. Adapter retry is safe only while it holds
   discardable prelude events such as reasoning/tool-input deltas. Once text deltas, formal tool calls or
   finish events are emitted or persisted, failures become stream errors and the runtime must close or
   recover the turn explicitly.

## Phase 0: Spec and Contract Cleanup

Add or refine contracts before runtime edits.

- Expand `ModelStreamEvent` to cover `start`, `text_start`, `text_delta`, `text_end`, `reasoning_start`,
  `reasoning_delta`, `reasoning_end`, `tool_input_start`, `tool_input_delta`, `tool_input_end`,
  `tool_call`, `finish`, `error`.
- Extend `ModelStreamingPayload` to identify stream part kind, model request id, assistant message id,
  part id, tool call id and delta text.
- Define a `StreamingModelStep` accumulator contract: assistant text, reasoning text, completed tool
  calls, usage, finish reason, provider metadata.
- Document when partial output is persisted and how interrupted output is marked.

Acceptance:

- Contracts compile without core depending on AI SDK types.
- Existing generate-text runtime tests keep passing.

## Phase 1: Token Streaming Without Tool Execution Changes

Implement a streaming model step behind a runtime option, preserving existing tool execution timing.

Tasks:

- Add `AgentRuntimeConfig.modelStreaming?: "off" | "on"` or equivalent.
- Add a runtime helper such as `runModelStepStreaming()`.
- Consume `modelAdapter.streamText()` and emit ordered events: `model_request`, `model_streaming` for
  text/reasoning deltas, `model_complete`.
- Persist assistant text parts with stable ids. For v1, text may be appended in memory during streaming
  and persisted at `text_end` or `finish`; live deltas still go through `SessionEvent`.
- TUI projection appends `model_streaming` deltas into the pending assistant message instead of waiting
  for `model_complete`.

Acceptance:

- A no-tool response appears token by token in TUI.
- `submitPrompt()` still resolves to the same final `TurnResult.response`.
- `--prompt` stays usable and does not require consuming live events.

## Phase 2: Stream-Path Tool Loop

Route tool calls produced by `streamText()` through the existing tool runtime.

Tasks:

- The adapter preserves AI SDK tool input start/delta/end events when available.
- Accumulate completed `tool_call` events during a streaming step.
- After the model step finishes, reuse the current scheduling and execution path: add the assistant
  message with tool calls to `MessageHistory`, persist pending tool parts, emit `tool_call_scheduled`,
  execute through `ToolExecutor`, append model-visible tool results to history, continue with another
  streaming model step.
- Permission approval stays inside `ToolExecutor` and the existing broker.
- Tool result ids match provider tool call ids exactly.

Acceptance:

- A streamed model can call `Read`, receive the result and continue streaming the final answer.
- A streamed model can call `Write` or `Bash`, pause for TUI approval, execute after approval and
  continue the loop.
- Denied permission produces a model-visible tool error/result consistent with the generate-text path.

## Phase 3: Cancellation, Errors, and Resume Correctness

Make the stream path safe under failure.

Tasks:

- Abort the model stream on user cancellation and emit a structured turn error.
- Abort pending permission requests when the turn is cancelled.
- Abort running tools through the existing `AbortSignal`.
- Mark partial assistant text/reasoning as interrupted or errored in persisted session parts.
- On resume, transform pending/running tool calls into interrupted tool results before sending history
  to the model.
- Add synthetic tool result behavior for stream failure after a tool call was emitted but before a real
  result exists.
- Stream fallback must not leak orphaned tool results from a previous attempt.

Acceptance:

- Cancelling during model streaming leaves no dangling assistant/tool state.
- Cancelling during permission wait resolves or rejects the broker request.
- Cancelling during tool execution produces no unmatched tool call in the next model request.
- Resuming a cancelled/interrupted session produces valid model messages.

## Phase 4: Production Observability and Backpressure

Tasks:

- Trace spans for model stream, stream part handling, tool scheduling, permission wait and tool
  execution.
- Bounded buffering for live deltas so slow sinks cannot grow memory without limit.
- Model stream idle timeout that emits `model_stream_stalled`.
- Redact debug records for request headers, API keys and high-risk content.
- Record usage and first-token timing when available.

Acceptance:

- Stream events carry the same `traceId` and turn/session identifiers.
- Slow or failing live sinks cannot corrupt persisted facts.
- Debug logs do not include raw authorization secrets.

## Phase 5: Optional Streaming Tool Execution

Start executing completed tool calls before the model stream fully finishes; feature-gated at first,
behind a dedicated streaming tool executor.

Tasks:

- A `StreamingToolScheduler` that accepts tool calls incrementally.
- Start concurrency-safe tools immediately once their complete input is known.
- Keep non-concurrent or destructive tools exclusive.
- Buffer tool results so model-visible ordering stays provider-valid.
- If a Bash/system tool fails, cancel dependent or sibling tools according to tool policy.
- Keep permission prompts stable when multiple tool calls appear quickly.

Acceptance:

- Consecutive read-only tool calls can run in parallel.
- Unsafe tools do not overlap with other side-effecting tools.
- The model-visible transcript stays deterministic and valid.

## Test Plan

Adapter tests:

- maps AI SDK `text-delta`, reasoning deltas, tool input deltas, final tool calls, finish and error
  chunks into provider-neutral events;
- retries stream setup failures only before any event is emitted;
- does not retry after a visible stream event.

Core tests:

- no-tool streaming event order;
- streamed tool call followed by tool execution and a follow-up model step;
- permission request/resolution order in the stream path;
- permission denial creates a valid tool result/history;
- abort during model stream, during permission wait, and during tool execution;
- resume converts pending/running streamed tool calls into interrupted results;
- live sink failure does not prevent event store append.

TUI tests:

- renders `model_streaming` deltas into the active assistant message;
- renders the approval prompt while a streamed turn is active;
- a confirmed double Ctrl+C cancels the model stream, permission wait and active tool work while exiting
  the fullscreen TUI.

Persistence tests:

- assistant text/reasoning/tool parts created by the stream path hydrate into valid `MessageHistory`;
- incomplete streamed parts are marked interrupted and never sent as dangling provider tool calls.

## Suggested Implementation Order

1. Update contracts and tests for the richer stream event vocabulary.
2. Implement adapter stream chunk normalization.
3. Add runtime `runModelStepStreaming()` for no-tool responses.
4. Wire TUI `ModelStreaming` rendering.
5. Reuse the generate-text scheduling/execution code for streamed tool calls after model finish.
6. Harden cancellation/resume/error paths.
7. Turn streaming on by default for TUI, keeping `--prompt` compatible.
8. Consider feature-gated streaming tool execution.

## Release Gate

Streaming runtime is production-ready only when:

- TUI shows token deltas.
- Streamed tool calls run only through `ToolExecutor`.
- Write/Edit/Bash still require approval according to permission mode.
- Cancellation leaves no dangling model/tool state.
- Resume after interruption produces valid provider messages.
- `npm run lint`, `npm test` and typecheck pass.
- Debug output redacts secrets.
