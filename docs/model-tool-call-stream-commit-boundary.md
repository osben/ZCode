# Model Tool Call Stream Commit Boundary

Providers stream tool arguments as multiple deltas. An unfinished argument prefix can already be
valid JSON (e.g. `{}` received first, fields still appended after), so "currently parseable with
`JSON.parse`" describes syntax only and is never evidence that a tool call is complete or
executable.

Pinned dependencies: `ai@6.0.193`, `@ai-sdk/anthropic@3.0.81`, `@ai-sdk/openai@3.0.65`,
`@ai-sdk/openai-compatible@2.0.60`. In ZCode's normal agent-tool path, the provider adapter
enqueues `tool-input-end` and the final `tool-call` in the same local transform / flush; they are
adjacent local events in the AI SDK full stream, with no further read of the provider network
stream between them.

Per-provider completion timing stays adapted by AI SDK:

- Anthropic Messages: `content_block_stop`;
- OpenAI Responses: tool output item / arguments done;
- OpenAI-compatible Chat Completions: response stream `flush()`.

## Behavior spec

ZCode never synthesizes an executable call from deltas. In a normal main request, streaming
display, retry buffering and final execution input relate as:

```text
Provider SSE
    │
    ▼
AI SDK
    ├─ tool-input-start / delta / end
    └─ final tool-call(input)
                    │
                    ▼
ZCode retry-safe buffer
    ├─ start / delta / end ───────────────→ display only, wait for final call
    │
    └─ final tool-call
            │
            ├─ strictly normalize final input
            └─ flush start / delta / end / tool_call once
                                          │
                                          ▼
                                    Core scheduling and execution
```

- Never synthesize `tool_input_end` or `tool_call` because accumulated arguments first pass
  `JSON.parse`.
- In normal main requests, `tool-input-start`, `tool-input-delta` and `tool-input-end` are a
  retry-safe prelude before the final call; deltas are display-only and never the source of
  execution arguments.
- A call that already emitted `tool-input-start` keeps its existing end gate: without
  `tool-input-end`, the final call cannot substitute for the end event and is not published or
  buffered.
- Execution arguments come only from the AI SDK final `tool-call.input`. This preserves provider
  initial arguments present only in the final input, absent from deltas.
- On final `tool-call` arrival, the Adapter strictly normalizes once and flushes the previously
  buffered events as the existing retry boundary.
- On network failure before the final call, keep the existing adapter retry: discard the current
  attempt's display prefix; never guess arguments from deltas.
- An atomic `tool-call` without start/delta is handled directly as a final call.
- Duplicate final calls with the same id publish once.
- `tool-input-start.providerExecuted` stays legacy metadata compatibility: the final call wins when
  it explicitly provides it; the start value backfills when the final omits it. No new commit,
  retry or execution semantics.
- Malformed/null strict normalization and `{}` recovery follow
  [Model Tool Call Validation](./model-tool-call-validation.md).

With the current SDK, end/call are adjacent events from one local transform; ZCode consumes the
pair within the same attempt and keeps the existing adapter retry, core recovery and compact
policies.

## Multi-provider timing

```text
Anthropic content_block_stop ──────┐
OpenAI Responses item done ────────┼─→ AI SDK tool-input-end
OpenAI-compatible stream flush ────┘             │
                                                 └─→ final tool-call
                                                          │
                                                          ▼
                                              ZCode strict normalization and publish
```

Anthropic and OpenAI Responses keep per-call completion timing. OpenAI-compatible Chat Completions
has no standard per-call done; the adapter ends still-accumulating tool arguments at response
stream flush. ZCode consumes AI SDK events uniformly and designs no provider capability checks or
`finish_reason` / `[DONE]` inspection of its own.

Compact keeps its existing raw provider boundary for SSE/fallback retry scope, not the main-request
prelude classification; but it likewise synthesizes no call from deltas and executes only the final
`tool-call.input`. Core stream recovery, provider-executed ownership and request cancellation are
unchanged.

## Acceptance criteria

- A first-parseable argument prefix generates no `tool_call`.
- After `start/delta`, a retryable network error before the final call lets the adapter start the
  next attempt.
- With streaming input started but `tool-input-end` missing, no `tool_call` is published.
- With `tool-input-end` immediately followed by the final call, publish exactly once in
  `start/delta/end/tool_call` order.
- Even when the delta is already parseable JSON with only some fields, the published input must
  come wholly from the final `tool-call.input`, preserving provider initial input present only in
  the final call.
- A malformed/null final input does not break the model request; recovery follows the validation
  spec.
- Atomic final calls use the same normalization path.
- Normal requests and Compact no longer synthesize calls on "first JSON parseable"; all other
  Compact behavior is unchanged.
