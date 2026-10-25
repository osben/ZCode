# Todo145: OpenRouter Messages reasoning-parameter fix

Status: implemented and reviewed (recorded after the fact); code commit `2d622900ce`.

## Cause and scope

On Air, GLM-5.3 sent `thinking.type=enabled` to OpenRouter Messages without `budget_tokens`, violating the
server protocol. Full decision and evidence: [OpenRouter request contract](../../../openrouter-reasoning-request-contract.md).

- GLM, DeepSeek, Kimi K2, Qwen and MiMo use adaptive + effort on OpenRouter Messages.
- The off level stays disabled; no artificial fixed budget; other vendors and API formats unchanged.
- Personal overrides and the existing Claude, GPT and Kimi K3 dedicated rules are kept.
- Verification: published-config resolution and real SDK wire tests (221) passed; typecheck, lint, format and architecture checks passed. On Air, adaptive requests for GLM-5.3, GLM-5.3-Flash and DeepSeek 4.1 Flash succeeded.

Fable's failure was a region restriction, not the reasoning parameters; the region restriction is not
bypassed. Not every model was called online, and no remote config was published.
