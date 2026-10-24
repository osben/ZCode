# OpenRouter Messages Reasoning Parameter Fix

## Scope and basis

On 2026-09-14, an Air GLM-5.3 connection test sent `thinking.type=enabled` without
`thinking.budget_tokens` and was rejected (400) by OpenRouter's Messages request validation. The
same prompt, key and model with `adaptive + output_config.effort=low` returned 200 and completed.

- [OpenRouter Messages API](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message):
  `enabled` requires an integer `budget_tokens`; `adaptive` requires no budget.
- [OpenRouter Claude 4.6 migration notes](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-4-6):
  adaptive and budget modes are distinct mechanisms — a budgetless `enabled` cannot stand in for
  `adaptive`.

## Decision

- Fix only the same-kind mappings of GLM, DeepSeek, Kimi K2, Qwen and MiMo on OpenRouter Messages;
  their vendor compatibility maps produced budgetless `enabled`, which cannot be sent to OpenRouter
  directly.
- Site-specific rule: the off tier sends `thinking.type=disabled`; all others use `adaptive` with
  effort passed through; the boolean on tier `enabled` maps to `high`. No arbitrary fixed budget.
- Keep the existing tier value ranges, output caps, model members, enable/disable and other
  capabilities; existing dedicated mappings for GPT, Claude, Kimi K3 are untouched. The legacy
  Claude budget strategy is not redesigned here.
- The rule matches only `https://openrouter.ai/api`, optional `/v1` and trailing slash, with API
  `anthropic-messages`. Self-built providers are covered too — no Provider ID / template ID
  dependency.
- No changes to other sites, Chat/Responses, personal maps or fixed manual configs; no data
  migration; no model-name branches in the runtime. Desktop/remote share the same config resolution
  chain — no new state or protocol.
- Fable already uses `adaptive`; its local 403 is a regional restriction and is not bypassed by map
  changes.

## Acceptance

- Parse the full valid config from the release JSON and enumerate all OpenRouter template models
  and legal tiers: no `enabled` without a legal budget; off never becomes on.
- Assert `adaptive + effort` explicitly for the affected models; other sites/APIs and personal
  overrides stay unchanged.
- Keep the real-SDK serialized map wire verification and the low-output-cap (1 token) compatibility
  assertion.
- Never record region-restricted models as real-call passes; never auto-publish remote configs or
  modify user configs.

## Verification record (2026-09-14)

Outcome: 14/14 new config tests pass after the fix (12 failed before); 133 tests across 7 related
config/catalog/history-map/format/release files pass; 88 real-SDK wire tests pass including 8 new
OpenRouter cases covering the five model families and the off tier (network intercepted only — no
mock 200s claimed as server support). Typecheck, format and architecture checks pass; lint 0
errors, 42 pre-existing warnings. Live Air → OpenRouter checks with the release-config request
shape and the original test prompt (`low`, `max_tokens=1000`) returned HTTP 200 with `end_turn` /
`message_stop` twice each for z-ai/glm-5.3-flash (`gen-1789366855-73w0bfyOBz3ELtvUBygJ`) and
deepseek/deepseek-v4.1-flash (`gen-1789366855-gFYWCQboaRXqxM9q5QkH`); the earlier GLM-5.3 adaptive
control also fully succeeded (`gen-1789365468-l1GzIrS9atlIn0WGWZsj`). Other models were not
individually called online; the Fable regional restriction remains. No new packages installed, no
Air personal config or published online config modified.

Full history: `git show 163889a2:docs/openrouter-reasoning-request-contract.md`
