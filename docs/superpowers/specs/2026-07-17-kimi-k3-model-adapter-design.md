# Kimi K3 Model Adapter Design

## Background

Kimi K3 entered Moonshot's official model list. At launch the official API exposed only `max`, so ZCode modeled it as a single fixed level; the current Kimi Code model docs expose `low` / `high` / `max`, and the old policy would block users from the new levels.

Model naming as of 2026-07-28:

- Keep `kimi-k3`.
- Add `k3`, capability-identical to `kimi-k3`.
- Rename `kimi-k3-256k` to `k3-256k`; the old name is no longer a selectable model.

Local runtime logs confirm K3 requests use the `openai-compatible` transport. Moonshot's official docs state:

- Model ID `kimi-k3`; context window `1,048,576` tokens with text, image, and video input.
- `k3` and `kimi-k3` both use `1,048,576`-token context.
- `k3-256k` has a fixed `262,144`-token window; other capabilities match `kimi-k3`.
- Default output limit `131,072` tokens.
- K3 supports `"low"` / `"high"` / `"max"`; ZCode keeps the existing `"max"` default.
- Unknown effort returns HTTP 400; `none` disables K3 routing and degrades to another model, so it is never exposed as a K3 level.
- K3 must not use K2.x's `thinking` toggle parameter.
- Both the OpenAI-compatible and Anthropic-compatible Kimi Code endpoints support the three K3 levels.
- K3's tool argument validation only accepts `$ref` starting with `#/$defs/`; MCP tools may emit reuse references like `#/properties/...`, which must be promoted to `$defs` at the model-adapter boundary before sending.

References: <https://platform.kimi.com/docs/guide/kimi-k3-quickstart>, <https://platform.kimi.com/docs/models>, <https://www.kimi.com/code/docs/en/kimi-code/models.html>, <https://www.kimi.com/code/docs/en/kimi-code-cli/release-notes/changelog.html>.

## Goals

- Maintain `kimi-k3`, `k3`, and `k3-256k` base capabilities in the China model catalog and the bundled models.dev snapshot.
- Model the three K3 models as `low` / `high` / `max` (default `max`) in the zcode-cli default policy and the App dynamic provider overlay.
- OpenAI-compatible requests map the level to `openaiCompatible.reasoningEffort`, serialized by the AI SDK as top-level `reasoning_effort`.
- Anthropic-compatible requests use `anthropic.effort`, serialized as `output_config.effort`; no K2.x `thinking.type` injection.
- When sending tools to K3, promote parseable non-`$defs` local JSON Pointer references to root `$defs` and rewrite the `$ref` to `#/$defs/...`.
- The composer shows「低 / 高 / 最高」only — never「关闭」「中」or「较高」.

## Non-goals

- No rewriting of the existing thinking protocol for Kimi K2.5/K2.6/K2.7.
- `kimi-k3-256k` stays unexposed; this rename is not an extra legacy-name compatibility slot.
- Kimi alias inputs (`medium` / `xhigh`) are never UI levels.
- `none` is not modeled as K3's off level — off changes actual model routing, not K3 reasoning depth.
- No changes to desktop-continuous or mobile web-replayable session/task message boundaries.

## State and request chain

```text
中国模型目录 / CLI 默认策略
          │  kimi-k3: context=1048576
          │  k3: context=1048576
          │  k3-256k: context=262144
          │  三者: levels=["low", "high", "max"], default="max"
          ▼
App provider metadata
          │  精确命中的旧档位若是新目录档位的真子集，则扩展并写回
          │  非目录自定义档位保持不变
          ▼
workspace provider registry
          ▼
session.settings.thoughtLevel
          │  available=["low", "high", "max"]
          ▼
输入框展示“低 / 高 / 最高” ── 菜单和 Ctrl+T 在三档间循环

OpenAI-compatible: reasoningEffort=level ──► reasoning_effort="low|high|max"
Anthropic-compatible: anthropic.effort=level ──► output_config.effort="low|high|max"

工具 contract: $ref="#/properties/..."
          │  K3 adapter 提升引用目标到根 $defs
          ▼
provider wire: $defs={zcode_ref_0: ...}, $ref="#/$defs/zcode_ref_0"
```

Model capabilities are the single fact source; the UI only derives switchability from option count — no K3 hardcoding by model ID, no extra React state.

## Implementation

1. Update `models_catalog_china_llm_zcode_2026-06-03.json`: keep `kimi-k3`'s 1M context, add the identical `k3`, rename the 256K model to `k3-256k`; all three get multimodal input, the 131072 output budget, and `low` / `high` / `max` with default `max`.
2. Update `apps/zcode-cli/api.json` and regenerate `models-dev-snapshot.ts` so the pure CLI catalog also carries the three K3 models.
3. The reasoning/default policy generates three-level request patches for OpenAI-compatible and Anthropic-compatible K3.
4. The workspace dynamic provider overlay converges K3 capabilities by transport before reading inbound metadata, so legacy single-`max` or generic thinking toggles in old config cannot pollute the result.
5. When the App reads the provider store, exact-catalog models' reasoning levels expand one-way: a legacy level set that is a true subset of the catalog's is replaced by the catalog's and persisted; user-custom configs containing non-catalog levels are untouched. New-task drafts with an existing `config.json` thus also get three levels.
6. The tool transform applies K3 schema compatibility per target model: scan parseable local `$ref`s, reuse one `$defs` entry per reference target, never modify the original tool contract; other models keep their schema unchanged.
7. Keep the capability-driven thinking control; no K3 model-id hardcoding in UI options.

## Tests

- Adapter default policy: `kimi-k3` and `k3` match 1M, `k3-256k` matches 256K; all three hit vision/131072/three-level reasoning with default `max`; `kimi-k3-256k` and K2.x never match.
- models.dev catalog: all three K3 models' metadata project from the snapshot fixture.
- Workspace provider protocol: both transports deliver three levels and matching request patches, with or without legacy metadata.
- App provider store: historical `variants=["max"]` expands and persists as `low/high/max`; custom reasoning with non-catalog levels stays unchanged.
- Wire: `low` / `high` / `max` produce top-level `reasoning_effort` on OpenAI-compatible and `output_config.effort` on Anthropic-compatible, both without K2.x `thinking`.
- Tool wire: K3 `#/properties/...` references promote to root `$defs` rewritten as `#/$defs/...`; other models unmodified; original contract untouched.
- Targeted tests, `pnpm typecheck`, `pnpm lint`.

## Impact briefing

| Field            | Value                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Developer intent | Add `k3`; rename `kimi-k3-256k` to `k3-256k`                                             |
| Capability       | Model capabilities / model selection / provider registry                                 |
| Change layer     | option-source, validation                                                                |
| Primary seeds    | China LLM catalog, models.dev snapshot, model default policy, workspace provider overlay |
| Out of scope     | session state, model-switch commit semantics, remote replay, workspace identity          |

UI surfaces all consume the same provider registry: conversation model selection (V4 composer), automation/Subagent/Repo Wiki selectors, and Model Provider settings. Each keeps its own draft owner, inheritance rules, and commit sink; this change only swaps candidate names and never crosses commit sinks or adds platform branches. Remote workspaces keep the existing registry sync.

Must-preserve invariants:

| Invariant                                         | Surfaces           | Proof                                          |
| ------------------------------------------------- | ------------------ | ---------------------------------------------- |
| `k3` and `kimi-k3` identical except id/name       | catalog / CLI      | catalog and default-policy equality assertions |
| `k3-256k` differs only in 262144 context          | catalog / CLI      | capability assertions                          |
| Legacy `kimi-k3-256k` never registered or matched | catalog / CLI      | absence assertions                             |
| Renaming changes no UI commit sink                | desktop/web/mobile | no UI/session/replay code changes              |

## Case planning

### Boundary decisions

| Boundary        | Decision                         | Includes                                                           | Excludes                                |
| --------------- | -------------------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| Final model set | `kimi-k3`, `k3`, `k3-256k`       | catalog, snapshot, default policy, dynamic overlay, tool transform | `kimi-k3-256k`                          |
| UI behavior     | follows registry candidates only | all entries reusing the model list                                 | UI component, interaction, i18n changes |
| delivery        | existing boundaries              | desktop continuous, web remote shared-host registry                | new realtime/session state              |

### Accepted cases

| Case ID     | Setup                                | Action                                        | Assertions                                              | Evidence layers      |
| ----------- | ------------------------------------ | --------------------------------------------- | ------------------------------------------------------- | -------------------- |
| K3-NAME-001 | load China LLM catalog               | look up K3 models                             | only the three final ids; capability relations correct  | service unit         |
| K3-NAME-002 | models.dev off, default policy only  | query the three final ids and the old 256K id | final ids correct; old id misses                        | adapter unit         |
| K3-NAME-003 | load bundled models.dev snapshot     | query Moonshot models                         | all three final ids present; old id absent              | adapter integration  |
| K3-NAME-004 | dynamic provider missing K3 metadata | upsert `k3` / `k3-256k`                       | three-level reasoning synthesized per transport         | protocol integration |
| K3-NAME-005 | K3 tool contract with local `$ref`   | project `k3` / `k3-256k`                      | `$ref` promoted to `$defs`; original contract unchanged | adapter wire unit    |

No conversation E2E this round: model-selection commit, session state, and realtime/replayable semantics are unchanged, and catalog/default-policy/protocol-overlay/wire-transform coverage is direct via layered unit/integration tests.
