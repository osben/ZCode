# Anthropic Stream Compatibility

Status: L1 Implemented

## Current implementation

L1 lives at the Anthropic provider fetch boundary. `packages/adapters/src/model/registry.ts` wraps the
provider fetch with `createAnthropicStreamCompatFetch()` only when `provider.kind === "anthropic"`;
`openai-compatible`, `openai`, `gateway` and custom providers do not pass through this layer.

Implemented:

- `packages/adapters/src/model/anthropic-stream-compat.ts` handles only responses whose `content-type`
  contains `event-stream`; non-SSE responses are returned unchanged.
- The compat transform recognizes the non-standard bare
  `content_block_start.content_block.type === "tool_result"` in an assistant stream, drops its start,
  delta and stop frames by `index`, and clears cross-message state on `message_start`.
- Legal text, `server_tool_use`, `web_search_tool_result` and similar frames, non-JSON SSE frames and
  `[DONE]` pass through unchanged. Thinking frames also pass through unchanged when no signature
  completion is needed. If the provider carries a non-empty `signature` only in the thinking block of
  `content_block_start`, the layer adds a standard `signature_delta` before the `content_block_stop` of
  the same index. If a native `signature_delta` already appeared in the stream, nothing is added.
- `message_start` clears both the pending thinking signatures and the pending filtered block indexes,
  so unclosed state of a previous message cannot pollute the next one.
- The wrapped SSE response drops the stale `content-length` and `content-encoding` so response metadata
  matches the filtered body.
- Anthropic function tool projection explicitly disables the AI SDK eager input streaming by default, so
  the request body carries no per-tool `eager_input_streaming` field. The field is
  provider-compatibility sensitive: some Anthropic-compatible backends, protocol conversion proxies and
  gateway routes reject it as an unknown tool schema field. ZCode currently prefers stable
  compatibility.

Tests are in `packages/adapters/tests/registry.test.ts`: bare `tool_result` filtering, typed result
preservation, thinking start signature completion, native signature delta de-duplication, no rewrite of
non-event-stream responses and non-JSON SSE frame pass-through.

## Background

When ZCode image input goes through an Anthropic-compatible provider, some backends expose
provider-internal tool results in the assistant SSE. For example, an image-analysis backend may first
return `server_tool_use` and then a bare `tool_result` in the same assistant stream.

`@ai-sdk/anthropic` validates `content_block_start.content_block.type` with a runtime schema at the
provider boundary. The Anthropic response stream allows typed results such as `server_tool_use`,
`web_search_tool_result` and `mcp_tool_result`, but not a bare `tool_result`. A bare `tool_result`
normally belongs to the next user message, answering a client-side `tool_use`, and must not appear as an
assistant stream content block.

## Compatibility strategy

ZCode does not patch `@ai-sdk/anthropic` and does not change the ZCode image input format. The
compatibility logic is confined to the Anthropic provider fetch boundary of the model adapter:

- Handle only responses whose `content-type` is `text/event-stream`.
- Except for the bare `tool_result` filtering and thinking signature completion below, keep the original
  content and order of legal SSE events.
- When `content_block_start.content_block.type === "thinking"` and its `signature` is a non-empty
  string, stash the signature by block `index`.
- If a native `content_block_delta.delta.type === "signature_delta"` later appears for the same index,
  clear the stashed signature immediately and pass the native delta through unchanged; never synthesize a
  duplicate.
- If a stashed signature remains for the same index at `content_block_stop`, synthesize a standard
  `content_block_delta` with delta `{ type: "signature_delta", signature }` before the original stop
  frame, then clear the stash for that index and pass the stop through unchanged. The synthetic frame is
  never placed before thinking deltas and never changes the order of other frames.
- On `content_block_start` with `content_block.type === "tool_result"`, mark that `index` as a
  provider-internal non-standard block and drop the frame.
- Drop the later `content_block_delta` and `content_block_stop` of the same `index`; clear the mark after
  the stop.
- Do not rewrite it into `mcp_tool_result`, `web_search_tool_result` or a text block, to avoid forging
  provider semantics or showing internal tool output twice.
- On `message_start`, clear pending signatures and pending filtered indexes; state belongs only to the
  current assistant message and must not carry across messages.
- Non-event-stream responses, SSE frames that are not valid JSON and legal typed results pass through
  unchanged.

This strategy strips provider-internal tool traces from the Anthropic stream so the following
thinking/text still reaches the AI SDK. If a backend is fixed to emit a standard Anthropic-compatible
stream, the layer must not change behavior.

### Tool input streaming field policy

By default `@ai-sdk/anthropic` injects `eager_input_streaming: true` into every function tool of a
streaming Anthropic request. The ZCode provider adapter must disable that injection by default:

- When a normal client-side function tool is converted to an AI SDK tool, set
  `providerOptions.anthropic.eagerInputStreaming = false`.
- This provider option only affects AI SDK Anthropic request body serialization; it does not enter the
  ZCode `ModelToolContract`, the tool runtime schema, session events or UI projection.
- Provider-native tools do not get this option; they follow their own provider-native contract.
- If fine-grained tool input streaming is re-enabled later, first add a provider capability contract,
  enable it by provider/baseURL/model allowlist or explicit config, and cover proxy field rejection,
  invalid partial JSON, `max_tokens` interruption and stream recovery tests.
- Even though ZCode does not request Anthropic eager input streaming by default, the adapter must still
  consume any `tool-input-start/delta/end` the provider already returns and synthesize a single
  `tool_call` per the assembler rules in `streaming-tool-execution-and-recovery.md`. Whether to send the
  `eager_input_streaming` request field stays decided by the provider capability gate.

## Observability and error boundary

The compat layer does not swallow HTTP errors, provider business errors or stream transport errors. It
only filters specific non-standard content blocks of an already established SSE response, or projects a
signature already present in a thinking start into a standard signature delta the AI SDK can read; it
never generates, validates or modifies signature content. Upstream JSON business errors are still
detected by the existing provider business error fetch.

## Test coverage

Tests must cover:

- A bare `tool_result` block and its same-index stop are filtered.
- Normal text/thinking/server_tool_use events are preserved.
- When the thinking signature appears only in `content_block_start`, one `signature_delta` is
  synthesized before the same-index `content_block_stop`, and the relative order of the original start,
  thinking delta and stop is unchanged.
- When the same index already has a native `signature_delta`, nothing is synthesized, and the native
  signature and event order are preserved.
- With SSE frames split across transport chunks, CRLF frame separators and a last frame missing the
  blank line, the single signature event is still synthesized before stop and existing framing is kept.
- A new `message_start` clears pending signature state of unclosed blocks; a signature of the previous
  message is never added to the next one.
- An empty-string `signature` and `redactedData` of non-streaming JSON thinking still count as existing
  metadata and are not removed by the unsigned-thinking compatibility cleanup.
- Legal typed results, such as `web_search_tool_result`, are not removed by mistake.
- Non-event-stream responses are not rewritten.
- Non-JSON SSE frames pass through unchanged.
- The Anthropic client-side function tool request options explicitly contain
  `providerOptions.anthropic.eagerInputStreaming = false`, so no `eager_input_streaming` request field
  is produced.
