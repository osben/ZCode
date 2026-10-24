# Agent Auto Compact Output Reserve Design

The agent runtime reserves `contextWindow - outputReserve` as the input-side auto-compact budget. Without an explicit `maxOutputTokens`, the old fallback of `32_000` mismatched the Anthropic adapter's default `64_000` output tokens (plus thinking budget on top of `max_tokens`), leaving the input threshold too loose. Conversely, catalog models with `limit.output > 64_000` (some at or above `limit.context`) would shrink `effectiveContextWindow` toward zero and cause premature or repeated compaction. The reserve is therefore a policy value capped at `64_000`, not the provider's advertised maximum.

Rules:

- Without `maxOutputTokens`, the default auto-compact output reserve is `64_000`:

```text
outputReserveTokens = 64_000
effectiveContextWindow = contextWindow - min(64_000, contextWindow)
autoCompactThreshold = floor(effectiveContextWindow * 90%)
```

- With `maxOutputTokens`, it is capped:

```text
rawOutputReserveTokens = maxOutputTokens
outputReserveTokens = min(rawOutputReserveTokens, 64_000)
effectiveContextWindow = contextWindow - min(outputReserveTokens, contextWindow)
```

Examples (`contextWindow = 200_000`): no `limit.output` → old `168_000`/`151_200`, now `136_000`/`122_400` (compacts earlier, matching the real request budget); `limit.output = 131_072` → old `68_928`/`62_035`, now `136_000`/`122_400` (oversized output caps no longer starve the input budget).

- The same cap applies to the outgoing request: `requestMaxOutputTokens = min(configuredMaxOutputTokens, 64_000)`; provider `max_tokens` never exceeds `64_000`. The catalog keeps the raw `maxOutputTokens` (e.g. 131_072) as capability data.
- Anthropic thinking requests keep the thinking-budget deduction, ordered cap-then-deduct: cap configured max output to `64_000` first, then subtract the fixed thinking budget, so the AI SDK's assembled `max_tokens` stays within `64_000`.
- `summaryReserveTokens` remains a test/policy override; its default and cap follow `64_000`.
- Compact logs: `effectiveContextWindow`, `inputBudgetTokens`, `outputReserveTokens` reflect the capped reserve; `maxOutputTokens` still records the model's real configuration.

Non-goals: user config file format unchanged; no forced `limit.output` for custom models; the adapter's Anthropic `64_000` default unchanged; provider usage + incremental input estimation not implemented here.

Verification: `apps/zcode-cli/packages/core/tests/compact-policy.test.ts` (default `64_000` reserve; cap when `maxOutputTokens > 64_000`), `apps/zcode-cli/packages/core/tests/runtime-model-anomaly.test.ts` (runtime→adapter cap), `apps/zcode-cli/packages/adapters/tests/runner-options.test.ts` (AI SDK options cap; Anthropic thinking deduction stays within `64_000`).
