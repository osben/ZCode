# Model request provider compatibility follow-ups

> Status: gaps audited (2026-07-14), not included in the minimal output-token fix of
> 2026-07-13. Written before the later provider refactor; re-verify each action against the
> current adapter layout before picking it up. This ledger does not change Compact,
> `extra_body` unwrapping precedence, empty-completion status or UI.

## Current protocol responsibility

| Request protocol          | State                        | Field serialization responsibility                                       |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| OpenAI Compatible Chat    | integrated                   | AI SDK maps `maxOutputTokens` to `max_tokens`                             |
| OpenAI Responses          | integrated                   | AI SDK maps `maxOutputTokens` to `max_output_tokens`                      |
| Anthropic Messages        | integrated                   | AI SDK maps `max_tokens` and adds the fixed thinking budget to the final  |
| Gemini                    | no SDK/provider kind wired   | not supported by the existing AI SDK path                                 |
| Bedrock                   | no SDK/provider kind wired   | not supported by the existing AI SDK path                                 |

ZCode owns model capability budgets, provider-conditional omission and provider-specific
renames in the final JSON body; the AI SDK only serializes standard fields for integrated
protocols and owns none of ZCode's provider/model policy.

## Action 1: unify the providerOptions deep-merge boundary

Four merge behaviors coexist:

1. Workspace provider options and model options merge as a top-level shallow merge; a
   same-named model namespace wholesale-overrides the provider namespace.
2. Model target options and thought-level options merge recursively (deep).
3. Multiple registry targets of one provider conflict when their `providerOptions` are not
   exactly equal.
4. The adapter runner shallow-merges resolved provider options with request provider
   options; only the OpenAI Compatible SDK namespace then gets a local recursive merge.

Affected fields: `anthropic.thinking`/`anthropic.effort` and cache/beta options;
`openai.reasoningEffort`, `reasoningSummary`, `store`, cache keys;
`openaiCompatible.extra_body`, `thinking`, `chat_template_kwargs`; gateway
routing/caching namespaces; future Gemini/Bedrock namespaces.

Typical loss today: base `{ anthropic: { custom: true, thinking: {...} } }` merged with
override `{ anthropic: { effort: "high" } }` drops `custom` and `thinking`.

Target: define one precedence, apply one shared recursive merge across
provider → model → runtime request; arrays and scalars are still wholly overridden by the
later value. `extra_body` participates as a plain object without changing its existing
unwrapping and same-name precedence.

## Action 2: fill in the provider/model default request parameter matrix

Main turns currently set only the output budget and reasoning providerOptions;
`temperature`, `topP`, `topK`, penalties, stop and seed exist in the generic request
contract but fall to SDK/provider defaults when unset. Evaluate per item, not all at once:

- Responses/OpenAI-compatible `store`, reasoning summary, encrypted reasoning continuation;
- session/prompt cache keys;
- OpenRouter/Gateway usage and caching options;
- Gemini, Anthropic-compatible, Alibaba reasoning/thinking defaults;
- Qwen, Gemini, MiniMax, Kimi temperature/topP/topK defaults;
- provider-required headers and tool streaming switches.

Every default must be conditioned on provider/model capability and proven by a final
request-body test; unknown providers get nothing injected, so one provider's extension
parameter is never sent to every compatible endpoint.

## Action 3: extend the message/tool compatibility matrix

Already covered: media capability projection, empty-media replacement, Anthropic cache
control, DeepSeek reasoning replay, Anthropic thinking metadata, Responses stateless
reasoning item cleanup, Anthropic tool eager input off, structured tool result projection.

Not yet covered:

- illegal Unicode surrogate cleanup;
- Anthropic/Bedrock empty-message and empty content-part filtering;
- Claude/Mistral tool call id charset/length requirements;
- Mistral tool → user message sequence repair;
- OpenAI, Moonshot, Gemini tool JSON Schema downgrade;
- providerOptions namespace remapping on message/content parts;
- provider-specific no-op tools and tool-call repair.

Add items one per real provider failure; no automatic guessing or failure-retry for unknown
providers. Each item needs a pure transform test plus one final provider-visible request
body test.

## Action 4: add first-class provider protocols

Gemini, Bedrock, Azure, Vertex cannot be declared fully supported through the OpenAI
Compatible path alone. Wiring one requires together: provider factory, auth and endpoint
selection; providerOptions namespace projection; reasoning/default options; message/tool
schema compatibility; final request-body and streaming response tests. Prioritize by real
user demand — a catalog entry alone never implies runtime support.
