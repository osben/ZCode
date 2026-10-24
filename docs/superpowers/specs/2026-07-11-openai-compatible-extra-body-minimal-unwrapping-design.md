# OpenAI-compatible reasoning canonical request fields

Status: implemented.

## Background

ZCode's reasoning policy and bundled model catalog used to store OpenAI-compatible extension parameters as `openaiCompatible.extra_body`, which the runner shallow-unwrapped before handing them to `@ai-sdk/openai-compatible`. That gave the same parameter two representations (model config vs final request) and mistook the Python/OpenAI client's `extra_body` call argument for a provider protocol field. The legacy GLM-5.2 mapping also put `reasoning_effort` inside `chat_template_kwargs`, which OpenAI-compatible gateways supporting top-level `reasoning_effort` rejected.

The actual provider and AI SDK contract is canonical direct options:

- `reasoningEffort` -> wire `reasoning_effort`
- `thinking` -> wire `thinking`
- `enable_thinking` -> wire `enable_thinking`

Only ZCode's auto-generated model request parameters were corrected; model identification, thinking level sets, default level, UI, protocol, and provider connection selection are unchanged.

## Request contract

```text
model/catalog reasoning profile
          │ canonical AI SDK options
          ▼
providerOptions.openaiCompatible
          │ copy to resolved provider-name namespace
          ▼
@ai-sdk/openai-compatible
          │ serialize once
          ▼
provider wire body (no ZCode-generated extra_body)
```

ZCode auto-generated OpenAI-compatible parameters:

| Model contract                 | Levels                     | Canonical option                                    | Final wire                                           |
| ------------------------------ | -------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| GLM-5.2                        | `max` / `high` / `nothink` | `reasoningEffort=max/high/none`                     | `reasoning_effort=max/high/none`                     |
| DeepSeek V4 auto-inference     | `high/max`                 | `thinking.type=enabled` + `reasoningEffort=<level>` | `thinking.type=enabled` + `reasoning_effort=<level>` |
| Qwen thinking toggle           | `enabled/off`              | `enable_thinking=true/false`                        | `enable_thinking=true/false`                         |
| Kimi/MiMo etc. thinking toggle | `enabled/off`              | `thinking.type=enabled/disabled`                    | `thinking.type=enabled/disabled`                     |

The GLM-5.2 UI key `nothink` is unchanged and maps to `none` only at the provider option boundary; no new alias or UI level. DeepSeek V4's built-in exact catalog can show `off/high/max`; the row above covers only auto-inference without an exact catalog. `low/medium` normalize to `high` as legacy config values only — they are not canonical presentable levels.

## Compatibility boundaries

- Programmatic/user config that explicitly passes `openaiCompatible.extra_body` keeps being shallow-unwrapped by the runner for backward compatibility.
- ZCode's own reasoning policy, workspace catalog completion, and bundled catalog no longer generate `extra_body`.
- Canonical direct fields are still copied into the dynamic provider-name namespace the SDK actually reads; existing precedence of raw provider-name overrides is unchanged.
- Short sidecars (title/goal-title) keep requiring thinking off and share the same model-aware no-thinking transform. Git commit message generation distinguishes intent: with an explicit thought variant requested, keep the user's selected thinking/providerOptions; without one, project as a no-thinking sidecar and disable inherited thinking. (Bug history: commit messages are user-triggered generation using the currently selected model and thinking strength; the old contract grouped them with automatic title sidecars and wrongly rewrote always-thinking models' `max/high/low` to disabled.)
- The no-thinking transform must preserve original options before deleting inherited effort: set an existing direct thinking toggle to disabled; GLM-5.2 and GPT base models that explicitly support `none` convert effort to canonical `reasoningEffort=none`. MiniMax M3 writes its official off parameter per existing `apiFormat` when reasoning options are missing; effort-only models with no off contract only drop the inherited effort — never fabricate `none`.
- GPT minor versions are recognized only in official dotted form (e.g. `gpt-5.1`); a GPT-5 dated snapshot like `gpt-5-2025-08-07` must not be read as a minor version and must not get an unsupported `none`.
- compact keeps its existing boundary; no path may create a new `extra_body` to disable thinking.

## Explicitly not done

- No removal of the explicit user `extra_body` compatibility unwrap.
- No changes to provider/model identification rules, reasoning levels, default selection, or the models-dev snapshot.
- No base-URL inference, field allowlists, retry-after-400-with-field-deletion, or provider special cases.
- No UI, ZCode Protocol, persistence, queue, remote, or workspace identity changes.
- No projection of bundled catalog context window, max output, or other metadata into the runtime.

## Verification

- Adapter policy/unit tests assert canonical provider options independently, without copying a production helper as the expectation.
- With real `@ai-sdk/openai-compatible` and fake fetch, assert the final wire body for GLM, DeepSeek, Qwen, and thinking toggles; the ZCode auto-generated path contains no `extra_body` or `chat_template_kwargs`.
- Core sidecar table-driven tests cover GLM, DeepSeek, Qwen, Kimi K2/K3, MiMo, MiniMax, Claude, and GPT: off-capable models produce the correct off parameters, non-off-capable models never fabricate `none`, no path re-synthesizes `extra_body`.
- Core runtime tests: Git commit message without an explicit variant uses GLM-5.2 canonical effort to generate `reasoningEffort=none` without modifying the main request options; with an explicit variant the selected thinking/providerOptions are kept, and the commit-message visible output budget composes with the Anthropic fixed thinking budget into a legal wire total.
- E2E I14 checks GLM-5.2 `max/nothink` main request plus title `reasoning_effort=none`; I15 checks DeepSeek V4 `high/max`; I65 checks form-created Qwen and Kimi custom provider `enabled/off`. All three assert from UI selection down to the final request body captured by the replay server.
