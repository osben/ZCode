# Anthropic Thinking Max Output Budget

With `thinking.type = "enabled"`, the AI SDK adds the request's `maxOutputTokens` and fixed `thinking.budgetTokens` into the provider-visible `max_tokens`. When model metadata's `maxOutputTokens` already equals the provider cap, adding the thinking budget overflows it (observed on `default-mimo/mimo-v2.5-pro`, requestId `d19aedba-9da4-477a-9765-696c9cb5eb00`: `maxOutputTokens` 131072 + budget 1024 → `max_tokens 132096 is out of supported range (0, 131072]`).

Rules:

- Under the Anthropic transport, core's `maxOutputTokens` is the total budget shared by thinking and visible output; the final provider `max_tokens` must not exceed it.
- A fixed thinking budget larger than the total budget is clamped for that request only — shared provider options are untouched.
- Non-Anthropic transports and requests without a fixed thinking budget are unchanged.
- `requestedMaxOutputTokens` keeps existing resolution: explicit request value first; Anthropic transport defaults to adapter `32000`; non-Anthropic defaults to unset.
- No changes to preflight candidate/baseline selection, Compact thinking, and no minimum, retry, fallback, or side-request special cases.

Projection (in adapter request-option construction, since the AI SDK sums the two values):

```text
effectiveThinkingBudget = min(configuredThinkingBudget, requestedMaxOutputTokens - 1)
aiSdkMaxOutputTokens = requestedMaxOutputTokens - effectiveThinkingBudget
```

A fixed budget must stay below the final `max_tokens`. Example: compact total budget 20,000 with fixed thinking 32,000 sends `thinking.budgetTokens=19999` and `maxOutputTokens=1`, so the wire gets `max_tokens=20,000`. The projection clones the request's Anthropic options; later main requests keep the original 32K config.

When the normalized total budget is below 2, fixed thinking and visible output cannot each get one token: the adapter throws `InvalidModelRequest` before the network request — never a zero/negative thinking budget, never silently disabling user-configured thinking. Anthropic's official 1,024-token minimum is intentionally not adopted; budgets ≥ 2 project by the formula, preserving protocol room for Anthropic-compatible BYOK endpoints.

Verification: unit tests cover budget deduction in Anthropic `generateText`/`streamText`, `InvalidModelRequest` for totals 0.5 and 1 (total 2 still projects to 1+1), per-request-only clamping with original options intact, a wire test asserting `max_tokens=20000` with `thinking.budget_tokens=19999` for compact, and OpenAI-compatible transports unaffected.
