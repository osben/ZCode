# Provider Token Usage

## Goal

Expose token usage that comes from the model provider response, not local context
estimation. The value is only available after a model request finishes.

## Non-goals

- Do not use local token estimation for user-visible usage.
- Do not call provider token-count endpoints just to update the TUI.
- Do not add a new environment variable.

## Canonical Shape

All model adapters normalize provider usage into `ModelUsage`:

- `inputTokens`: provider-normalized total input tokens. For providers with
  prompt caching this already includes ordinary input, cache creation/write, and
  cache read tokens.
- `outputTokens`: provider-reported output tokens.
- `totalTokens`: provider total when available, otherwise the runtime derives a
  total from normalized usage.
- `cacheReadTokens`: provider-reported cache hit tokens, kept as a breakdown of
  `inputTokens`.
- `cacheWriteTokens`: provider-reported cache creation/write tokens, kept as a
  breakdown of `inputTokens`.
- `reasoningTokens`: provider-reported reasoning tokens.

For turn-level consumers, core exposes a `ModelUsageSummary` on `TurnResult`.
It is aggregated from `model_complete.payload.usage` events emitted during that
turn. A turn that never receives provider usage leaves this field undefined.

## Provider Mapping

- OpenAI Chat and OpenAI-compatible APIs map `prompt_tokens`,
  `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`,
  and `completion_tokens_details.reasoning_tokens`.
- OpenAI Responses maps `input_tokens`, `output_tokens`, `total_tokens`,
  `input_tokens_details.cached_tokens`, and
  `output_tokens_details.reasoning_tokens`.
- Anthropic maps `input_tokens`, `output_tokens`,
  `cache_creation_input_tokens`, and `cache_read_input_tokens`. AI SDK v6
  normalizes `inputTokens` to ordinary input plus cache write plus cache read,
  so runtime context and compact calculations must not add cache tokens again.

## Runtime Events

- `model_complete.payload.usage` is the per-model-request source of truth.
- `turn_complete.payload.usage` may include the aggregated usage for the whole
  turn.
- `turn_complete.payload.tokenCount` must be derived from provider usage, and
  should be `0` when no provider usage exists.

## Context Estimation Anchor

The persisted assistant message already owns the normalized `tokens` value. Context
estimation reuses that value instead of introducing a second `providerUsage` field:

- the live runtime carries the same normalized `tokens` on its internal assistant entry;
- provider projection strips the runtime-only field before sending the request;
- estimation scans the provider-visible projection backwards for the latest committed
  assistant with valid tokens and uses that provider input as its baseline;
- the primary provider contract requires valid `input` and positive `output` for a
  non-empty assistant. Existing compatibility handling for legacy normalized usage is
  retained, but new estimation behavior must not be designed around malformed usage;
- normalized `output: 0` without a usable `total` does not prove that provider usage
  covered the assistant output, because legacy normalization also maps a missing
  `outputTokens` field to zero. In that case estimation keeps the provider input as
  the base and locally estimates from the assistant itself; a positive output or a
  usable total advances the local suffix past the assistant;
- cold hydration keeps a contentless assistant only when its persisted tokens form a
  valid provider input baseline. This preserves the same anchor as the live runtime,
  while all-zero request placeholders and contentless responses without usable usage
  remain outside provider history;
- if no such assistant exists, estimation falls back to the full local message estimate;
- old sessions without token data remain compatible and use the full local estimate.

After Compact replaces the provider-visible old prefix, the original usage of a preserved assistant no
longer represents the current context. Runtime and cold-start projection zero the usage only on copies
of preserved messages; assistants added after Compact keep their own tokens, and the persisted
transcript is not rewritten.

Microcompact rewrites only old tool results and does not clear the usage of the latest assistant.
Estimation keeps using that provider baseline and estimates locally only for messages after the
assistant. This approximation is intentional; no extra usage invalidation or recomputation branch is
added.

This is an in-memory ownership link for estimation, not a new protocol or persistence
schema. `tokens` is response metadata and must never be added to `ModelInputMessage`.

## TUI Contract

The TUI should display real usage only after a model completion or final turn
result. It must not display estimated context tokens as model usage. The final
status footer should include the aggregated turn usage when available. To keep
the ready state readable, final turn usage is rendered on its own footer line
below the main ready/trace line, formatted as `Tokens: <usage>`.

## Tests

- Adapter tests cover provider-to-`ModelUsage` normalization.
- Core runtime tests cover turn aggregation across model requests.
- TUI tests cover displaying usage from `model_complete` and final turn result,
  including the final `Tokens:` footer detail line.
