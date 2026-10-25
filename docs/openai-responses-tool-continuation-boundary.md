# OpenAI Responses Tool Continuation Boundary

## Goal

OpenAI Responses sessions must continue tool-call turns without leaking Responses-only stored item
replay into non-stateful or partially compatible `/responses` providers.

## Problem

ZCode keeps provider-visible history in a protocol-neutral message list. After a Responses model
emits reasoning and tool calls, the next model request replays the assistant message plus tool
results. Some OpenAI Responses-compatible providers accept `function_call` and
`function_call_output` replay, but fail when a stored reasoning `item_reference` is included
without `previous_response_id` or a conversation boundary.

Observed failure mode: the first Responses request succeeds and returns tool calls; tools complete;
the follow-up request with tool results gets HTTP 502.

## Required boundary

- Limited to OpenAI Responses transport: `providerKind === "openai"` and
  `apiFormat === "openai-responses"`.
- Applies only during stateless history replay: no `openai.previousResponseId`, no
  `openai.conversation`, and `openai.store` not explicitly `false`.
- Only stored OpenAI reasoning references are suppressed from assistant history replay.
- Tool calls and tool results stay in the normal protocol-neutral history.
- Anthropic reasoning, OpenAI Chat-style tool results, OpenAI-compatible Chat Completions, and
  DeepSeek/MiMo `reasoning_content` replay remain unchanged.

## Verification

- Adapter transform coverage proves Responses stateless replay drops only stored OpenAI reasoning
  references.
- Neighbor coverage proves the same reasoning is preserved when a stateful Responses boundary
  exists.
- Existing Anthropic and OpenAI-compatible reasoning replay tests keep passing.
- Required checks: `pnpm typecheck`, `pnpm lint`.
