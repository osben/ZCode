# GLM-5.2 Reasoning Depth (three thinking levels)

> **Superseded by Provider Refactor (2026-08-24).** The modelId prefix matcher, `default-policy`,
> `providerOptionsByLevel` and the Runtime reverse matching described here are deleted. GLM-5.2
> behavior is now declared explicitly by Built-in Model Config Rules and handed to the Adapter through
> Effective Model Config. Do not restore the name-inference implementation. Current contract:
> [Model Contract](../../../../../../docs/working-memory/provider-refactor/design/model/contract.md).

## Status

Historical implementation record. The original design was written on 2026-06-02 and rechecked on
2026-07-15; it is no longer the active implementation contract.

GLM-5.2 needs three selectable reasoning depths instead of the binary enabled/disabled thinking toggle
that every other GLM model receives. The levels map to canonical AI SDK `reasoningEffort` options on the
OpenAI-compatible transport and to native Anthropic `thinking` controls on the Anthropic-compatible
transport.

| Level     | OpenAI-compatible request body | Anthropic request body                                                    |
| --------- | ------------------------------ | ------------------------------------------------------------------------- |
| `max`     | `reasoning_effort: "max"`      | `thinking: { type: "enabled", budgetTokens: 32000 }` (+ `effort: "max"`)  |
| `high`    | `reasoning_effort: "high"`     | `thinking: { type: "enabled", budgetTokens: 16000 }` (+ `effort: "high"`) |
| `nothink` | `reasoning_effort: "none"`     | `thinking: { type: "disabled" }`                                          |

The default level is `max` when no app/session preference supplies a compatible level. The match was by
model-id **prefix** `glm-5.2` (case insensitive, on the last `/`-separated id segment), so `glm-5.2`,
`glm-5.2-pro`, `GLM-5.2` and `zai/glm-5.2` were covered, while `glm-4.6` and `glm-5.1` kept the
thinking toggle.

## App Selection Preservation

- The app must not force `thought_level=max` after a user switches away from and back to a
  GLM-5.2-compatible model. User-selected levels such as `high` stay valid and are preserved by the app
  preference seed and the V4 `switchModelConfig` / `createSession.config` paths when the returned
  capability list still contains that level.
- The `max` default applies only through normal capability defaulting when no compatible app/session
  preference exists. Switching to a GLM-5.2-compatible model must not issue an extra thought-level
  command solely because the model default is `max`. Across models, the V4 handler lets the target model
  select a compatible actual thought level; it treats thought as an explicit write only when the model
  identity is unchanged.
- GLM-5.2 also carries a **1,000,000-token context window**, a separate default policy
  (`glm-5.2-context-window-1m`) in `default-policy.ts` that reused the same `isGlm52ModelId` prefix match
  and the shared `ONE_MILLION_CONTEXT_WINDOW` constant, like the DeepSeek-V4 / mimo 1M policies. It
  replaced the context window (`replaceContextWindow: true`) so a stale `models.dev` value did not win.

## Temporary Dated Aliases

`glm-<MMDD>` and `glm-<MMDD>[1m]` temporary ids (for example `glm-0531` and `glm-0606[1m]`) behave like
`glm-5.2`: three reasoning depths and a 1M context window. `isDatedGlmTempModelId` uses an exact
dated-id pattern, so names such as `glm-0606x` do not match. `default-policy.ts` and `config/schema.ts`
applied the same rule, including provider-qualified ids.

## Why Two Factories

Reasoning provider options are transport-specific. `providerOptionsByLevel` entries are namespaced by AI
SDK provider kind (`openaiCompatible` vs `anthropic`); the active provider reads only its own slice.
Reusing an `openaiCompatible` option set on an Anthropic-compatible model produces a request with no
thinking field while the UI still shows thinking enabled; this bug is documented in
`config/schema.ts:createConfiguredModelDefaultReasoning`. DeepSeek-V4 solved it with a pair of factories
(`createDeepSeekV4Reasoning` + `createDeepSeekV4AnthropicReasoning`) wired into the two resolution
paths, and GLM-5.2 followed that precedent.

## Resolution Paths

Reasoning capability was resolved through two seams, and GLM-5.2 wired into both:

1. **`adapters/src/model/default-policy.ts`**: `resolveModelCapabilityDefaults` matches by model id only
   (no transport kind) and supplied the **OpenAI-compatible** option set. The policy entry
   `glm-5.2-reasoning-depth` was inserted **after** the generic `glm-thinking-toggle` entry so that, as
   `resolveModelCapabilityDefaults` does an ordered `Object.assign`, the GLM-5.2 `reasoning` replaced the
   toggle for matching ids.
2. **`adapters/src/config/schema.ts`**: `createConfiguredModelDefaultReasoning` is transport-kind aware.
   In the `kind === "anthropic"` branch, an `isGlm52ConfiguredModelId(modelId)` check ran **before** the
   generic thinking-toggle check and returned the **Anthropic** option set.

The selected level's `providerOptionsByLevel[level]` flows unchanged through
`bootstrap/src/runtime-model-metadata.ts` → `adapters/src/model/runner-options.ts:mergeProviderOptions`
→ AI SDK `providerOptions`. For OpenAI-compatible providers the runner copies the canonical
`openaiCompatible.reasoningEffort` field into the SDK's resolved provider-name namespace. The SDK then
serializes it once as top-level `reasoning_effort`; ZCode does not generate `extra_body` or
`chat_template_kwargs` for these levels.

## Level Display

`bootstrap/src/zcode-protocol/session-mapper.ts` maps each capability level string straight to
`{ value: level, label: level }`. The labels are literally `max` / `high` / `nothink`, consistent with
existing levels (`enabled`/`disabled`, `low`/`high`). No new i18n surface in the agent.

## Round-Trip

`resolveRuntimeThoughtLevel` reverse-maps the active `providerOptions` to a level via deep equality
(`recordsEqual`). The three option objects are mutually distinct on each transport, so the selected level
round-trips.

## Testing

- `adapters/tests/model-default-policy.test.ts`: GLM-5.2 yields levels `[max, high, nothink]`, default
  `max` and the exact OpenAI-compatible `providerOptionsByLevel`; prefix variants (`glm-5.2-pro`,
  `GLM-5.2`, `zai/glm-5.2`) match; `glm-4.6` / `glm-5.1` stay on the enabled/disabled toggle.
- `adapters/tests/config.test.ts`: with `kind === "anthropic"`, GLM-5.2 resolves to the Anthropic option
  set; `nothink` produces `thinking: { type: "disabled" }` and no `chat_template_kwargs`.
- `packages/ui/test/composerRecent.test.ts`: Recent records' legacy format compatibility, independent
  model/mode validation, accepted writes, submit order and workspace isolation.
- `packages/ui/test/v4ModelConfigPreferenceConfirmation.test.ts`: V4 snapshot confirmation preserves a
  selected GLM-5.2 `high` configuration.

## External Verification Boundary

Whether the GLM Anthropic-compatible endpoint distinguishes `max` vs `high` through `effort` passthrough
or through `budgetTokens` is a backend contract detail. The Anthropic factory mirrors the DeepSeek-V4
Anthropic mapping (`effort` + `thinking` budget) as precedent. A backend compatibility claim still
requires capturing the outgoing request body for both transports through the runner's
`experimental_include.requestBody` model-IO debug path; unit tests prove the local mapping, not
acceptance by every deployed endpoint.
