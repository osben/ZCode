# Todo 95: Equivalent Cleanup of Dedicated Reasoning Maps and a Stronger Fallback

> 2026-09-12 follow-up ruling: [Todo138](./todo-138-reasoning-level-ui-and-api-defaults.md) changes the generic Model levels to disabled/enabled and adds `enabled -> high` to the three API generic maps, superseding this document's earlier restriction "do not add enabled -> high". Dedicated maps, personal overrides and rule layering keep their original semantics. The rest of this document stays as the implementation record at the time.

> Status: A/B/C done and closed, updated 2026-09-09. Unified closing-level names and best-effort legacy Selection mapping are implemented; unreleased Personal config gets no compatibility. The formatting regression was fixed by Todo98. All residual unverified items and manual promotion are followed only in [Todo102](todo-102-verification-debt-closeout.md). History evidence: [execution record](../research/todo94-97-execution-and-review.md).
>
> Overall principle: **beautify the existing models' dedicated Reasoning Maps and strengthen the fallback Reasoning Map. Existing dedicated rules get only equivalent beautification and no behavior change.** Closing-level renaming and legacy selection compatibility are a separate change and are not mixed into "beautification".

## 1. Three workstreams and boundaries

| Workstream                      | May change                                                                                                       | Must keep                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A: dedicated Map beautification | expression structure, duplicated branches, condition placement                                                   | for every legal input the final request fields, values, omit/delete semantics, mode and budget               |
| B: fallback Map enhancement     | per API Schema, provide usable generic reasoning field mappings                                                  | dedicated-rule override capability, Personal override, model-selection validation and output-limit authority |
| C: closing-level cleanup        | non-API-native closing names unified to `disabled` where possible, compatible mapping of affected old selections | the old selection's closing semantics, user-defined levels/Maps, each business save boundary                 |

- No change to dedicated rules' model match range, prefix/suffix rules, site range, priority or other model capability; dedicated Maps must not all be replaced by a generic hybrid Map.
- No model ID change, no Provider special execution path, no extension of the expression language for shorter code.
- No change to a running Active Model, history, Off-Peak Ticket or account connection migration. Wiki output-budget unification belongs to [Todo 94](todo-94-wiki-model-output-limit.md), not here.

## 2. Facts and expression principles

Main config is `config/provider/zcode-builtin.json`. The generic model rule declared only `disabled` with Reasoning Map `{}`; the API Schema fallback rule had output-limit mapping but no reasoning mapping. Dedicated rules contained branches returning the same-named string per level and repeatedly building identical objects.

1. `values` declares legal levels and the unified validation layer rejects illegal ones; a Map only converts legal input into request fields.
2. Same names pass through directly; no `low -> low / high -> high / max -> max` enumeration ternaries.
3. Conditions sink to the field that actually varies; keep an outer branch only if field presence or object structure really differs.
4. The last `else` must not quietly turn unknown input into the highest, closed or another default level.
5. Do not change an omitted field to `null` for brevity: this is JSON Merge Patch where `null` means delete, not omit.
6. Not every ternary is eliminated mechanically; clear semantics and request equivalence beat character count.

For example, if an original legal level maps straight to the API effort it simplifies to `{"reasoning":{"effort":reasoningLevel}}`; but with an original `off/enabled`, `reasoningLevel` cannot pass directly into `thinking.type` which accepts only `disabled/enabled`: the name change must go through workstream C first, and beautification must not hide the difference.

## 3. Fallback enhancement: layering and targets

For an unknown model where the user only adds the reasoning levels it supports, the API Schema fallback Map should work directly, without requiring ordinary users to write expressions first.

```text
generic model default config -> API Schema fallback Map
 -> existing more specific model / site / template rules (existing merge order)
 -> Personal override -> effective values validation -> Option Map -> final request
```

- Built on the existing layering from [Todo 76](todo-76-builtin-provider-config-layering-and-site-rules.md); no new runtime mapping system.
- Generic `values` stays conservative: an enhanced Map does not claim all unknown models support `low/high/max`; the user or a more specific config declares supported levels.
- Dedicated Maps still override the fallback; an explicit Personal Map and the full config with "smart configuration" off are not rewritten automatically.
- No promise that arbitrary invented levels are understood by the API: passthrough is a way to build the request, not capability probing.
- The code below is the planned restricted CEL expression and must pass the existing compiler and final-request tests.

### 3.1 Chat Completions: maximum-compatibility hybrid fallback

By the user's accepted compatibility assumption, carry the commonly seen same-meaning control fields of several protocols:

```text
{
  "thinking": {
    "type": reasoningLevel == "disabled" || reasoningLevel == "none"
      ? "disabled" : "enabled"
  },
  "enable_thinking": reasoningLevel != "disabled" && reasoningLevel != "none",
  "reasoning_effort": reasoningLevel == "disabled" ? "none" : reasoningLevel,
  "reasoning": {
    "effort": reasoningLevel == "disabled" ? "none" : reasoningLevel
  }
}
```

- `thinking.type` covers the Zhipu-style thinking switch; `reasoning_effort` the OpenAI-style parameter; `enable_thinking` the Qwen/SiliconFlow style; `reasoning.effort` the OpenRouter style.
- `disabled` and native `none` both mean off, with no contradiction (one switch off while another is on); other legal specific efforts pass through.
- No budget, `reasoning.exclude`, `reasoning_split`, `chat_template_kwargs` or other differently-meaning or site-private fields.
- No implicit `enabled -> high/max`; switch-only models stay with dedicated rules and the generic fallback does not claim arbitrary levels are supported.

Accepted assumptions and their exact limits: (1) the server ignores unknown extra fields; (2) the server accepts multiple same-meaning control fields without rejecting the combination; (3) for services controlled by `thinking.type`, **under `type=disabled`** an extra effort no longer applies and may be ignored, or the interface allows `none` (this does not assume `none` is accepted when thinking is on); (4) for effort-controlled services `none` means off and an extra thinking switch may be ignored. This is a best-effort fallback by assumption, not a lossless guarantee for every compatible site: a strict server may validate known fields' illegal values even with the off switch, or reject unknown fields. Known differences go to dedicated rules; unknown cases error normally, never auto-removing fields and retrying, changing levels or changing the model.

### 3.2 Anthropic Messages: off or Adaptive

```text
reasoningLevel == "disabled"
  ? {"thinking":{"type":"disabled"}}
  : {
      "thinking":{"type":"adaptive"},
      "output_config":{"effort":reasoningLevel}
    }
```

The fallback does not cover the manual `enabled` + `budget_tokens` mode; a specific effort goes to Adaptive. The discussed `enabled` branch, the 12,800 budget and the incidental max-output override were withdrawn and are **not implemented** (the withdrawal covers the fallback only; existing dedicated models' `enabled` and budget modes are unchanged). The Anthropic API Schema alone does not guarantee the target model supports Adaptive/effort; those that do not use dedicated config, with no automatic mode switch.

### 3.3 Responses: keep its own field structure

```text
{"reasoning":{"effort":reasoningLevel == "disabled" ? "none" : reasoningLevel}}
```

Only the Responses effort structure; native legal values such as `none` are kept; the four Chat Completions field groups are not copied.

### 3.4 Output limit and default-off impact

The Reasoning Map writes no `max_tokens`, `max_output_tokens` or other max-output field; the existing maxOutputTokens Option Map stays independent and the multi-Map write-conflict validation is not bypassed. A generic model with only `disabled` now also emits the explicit off fields above, unlike the old `{}`: a real behavior change to be covered by compatibility tests and recorded as risk. No second dynamic rule "switch Map by whether values grew" is added to hide this; if testing shows the off strategy must change, record the evidence and rule.

## 4. Closing-level names and legacy selection compatibility

The goal is to tidy the project's own invented closing names such as `off/nothink`, not to rewrite every vendor value. API-native passthrough `none` may stay; not every spelling the user mentioned orally (such as `disable`) actually exists, so the config inventory decides.

```text
persisted original Selection / current user draft
 -> target Host effective config and unified selection resolution
    original level still legal? yes -> keep as is
    no -> a clear rename table hit on the affected rule and the target level is supported?
          yes -> transient effective level -> the business's original success-submit / explicit-save boundary (not write-back on read)
          no -> existing invalidation handling, no highest-level guess
```

- The rename table is bound to the affected Built-in rules/sources; never globally replace any `off/none/disable` with `disabled`; no guessing from model-name fragments.
- The original value wins: a user-kept still-legal `off` or native `none` is not migrated; unknown values are not guessed.
- Each rename verifies that "old input + old Map" and "new input + new Map" produce the same request (not the same literal input).
- Reuse [Todo 87](todo-87-selection-view-unified-resolution.md)'s effective-selection resolution and change notification. A read returns a transient result without overwriting persisted intent; a task's long-term setting is still updated at its original explicit save boundary, and this run may freeze the resolved result.
- No new storage version, no bulk history rewrite, no change to user Subagent Markdown, no parsing and rewriting of user Map expressions.
- **Latest compatibility boundary:** unreleased Personal config is not supported, old personal Maps are not auto-rewritten and no migration is added for such intermediate formats. The current formal explicit values/Map still apply by override rules; an old Selection rename happens only when the original value is illegal, clearly hits an affected source and the target is supported, keeping original intent and the existing save boundary.
- Explicit Subagent was connected to the Worker-local shared resolution by Todo99; C reuses that entry to verify pure level mapping and the missing Host RPC no longer blocks. Unspecified models and internal overrides stay frozen, with no protocol extension or inheritance change.
- Off-Peak keeps its original Provider and Ticket; pure level compatibility must not re-authorize cross-account switching.

### C execution record: source-limited closing-level migration

- The rename inventory is 25 `modelRules`: 24 `off`, 1 `nothink`; `none` and `enabled` are unchanged. The inventory keeps the old rule selectors and old closing value, not a second full model config.
- The Node unified Facade builds the old value-domain projection from the same applied snapshot: only Built-in rules identical to inventory entries recover the old closing value; rule matching and override order still reuse `ModelConfigRules.resolve`. So it is not model-name-fragment guessing, and an old value domain overridden by a later rule does not take effect again.
- An alias is tried only when the original level is illegal, then validated by the existing check. Explicit Personal reasoning values/Map or a pinned config do not take part in inference; a still-legal original is kept. (This limit is not unreleased-config compatibility but avoids mistaking user-defined values for built-in old ones.)
- Host and Worker share the Node Facade; config default selection gets the same pure-level normalization. The final Registry/Factory keeps exact validation with no alias.
- Acceptance layers: the real 25-rule inventory and original-request equivalence, public Facade source/override/read-only tests, real Composer/task entry regressions. Running requests, implicit inheritance and Ticket get no re-resolution; Todo102's historical verification debt is out of scope.
- Full rule/API review: dedicated Maps keep request equivalence across the rename; combinations inheriting the generic fallback correct the temporary mismatch left by the A/B vs C stepwise implementation. For example GLM Chat `off` had been passed through by the new fallback as an on-effort and now correctly takes the off branch; the Responses old `off/nothink` passthrough becomes `none`. This is the settled closing-semantic fallback closure; those wrong intermediate requests are not preserved and the fallback requests are not claimed byte-equivalent. On-levels and dedicated budgets keep their original values.

## 5. Impact and single authority

Config/request semantics and limited selection compatibility, not a UI redesign. Boundaries use the existing feature graph's model-capabilities and model-selection nodes (codegraph unavailable: targeted reading of the config and known seed files, no full call-graph audit claimed).

| Priority / entry                     | Shared boundary and what to check                                                                                       | Commit / save boundary                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| must: Built-in / Resolver            | `zcode-builtin.json`, `packages/provider/src/resolver.ts`; rule layering, source, dedicated override                    | Personal config not rewritten on load                                        |
| must: compile and request            | `packages/model-option-map/src/`, Agent `model-option-map-fetch.ts`; compile, Merge Patch, conflicts with output Map    | final Model build validation and request stay authoritative                  |
| must: shared selection resolution    | `packages/provider/src/effective-model-selection.ts`, Registry validation                                               | transient effective vs persisted intent                                      |
| must: add/edit model                 | shared model draft, `useModelSelectionView`; adding only levels inherits the fallback, explicit Map/pinned config stays | Personal written on user save; smart-config switch semantics unchanged       |
| must: Composer / session             | shared View and draft; old level resolution, new-selection legality                                                     | original send-success / explicit-save boundary, no change to a running Model |
| should: scheduled tasks / Bot / Wiki | entries reusing resolution, display/execution consistent                                                                | each explicit save and execution-freeze boundary, no bulk record refresh     |
| conditional: Subagent / Off-Peak     | whether Host resolution is bypassed, original identity and execution locking                                            | per §4, no Markdown/Ticket change                                            |
| invariant: desktop/Web, Local/Remote | target Host config, no local substitute or forced pre-send sync                                                         | `workspaceIdentity` isolation; continuous/replayable unchanged               |

## 6. Order and acceptance

1. First complete the rule inventory: rule location, API Schema, site/model range, effective values, old Map, proposed Map, owning A/B/C line; record rename and Personal-override risks (test counts do not substitute for coverage proof).
2. Update the Model Option Map / Built-in config / Selection specs only where the contract truly changes, then tests first, then implementation; existing specs must not be rewritten as dedicated-behavior changes by "fallback enhancement".
3. Dedicated Maps: cover all legal levels per rule (equivalent rules may be parameterized but site rules must not be missed); compare the final merged request JSON including missing, null, empty object, budget and max-output fields.
4. Fallback: verify Chat off/native none/specific efforts, Messages off/Adaptive, Responses off/effort; an unknown model that only adds values, a known dedicated model override, a Personal Map and smart-config off; illegal values still fail in the unified validation layer.
5. Compatibility: original-legal-first, affected old value mapping, unknown not guessed, Personal override combinations, read-only no-persist, existing run unchanged, covering real consumers not just a pure function.
6. Interaction E2E on the MacBook Pro with isolated fixtures/mocks: adding a model and changing only levels yields the right request, old selection display/submission, personal config not overridden; further entries such as scheduled tasks per the actual change; capture the final request (not expression snapshots); no real account claiming or quota use.
7. `pnpm typecheck`, `pnpm lint`, related unit tests and E2E; record environment vs product failures; unrun is never written as passed.
8. Final diff review: dedicated legal requests equivalent; only the fallback and explicit renames are semantic changes; no budget override, silent retry, extra sync or persistence side effect.

## 7. Execution record

| Item                                             | Status         | Evidence                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| discussion conclusions and three workstreams     | implemented    | this Todo                                                                                                                                                                                                                                                                     |
| all dedicated rules and equivalence baseline     | A done         | `reasoning-map-before-todo95.json` 19 expressions, per-rule index/range; final Merge Patch request compared for every legal level including existing fields/budget                                                                                                            |
| three API fallback mappings                      | B done         | unknown model changing only values, Personal Map override, illegal level rejected; Pro real Model request verified Chat high                                                                                                                                                  |
| closing-level rename and Personal combinations   | C done         | 25 rules renamed; original-legal-first, specific-rule override, unknown rejection and read-only original intent verified by real Built-in Facade tests; unreleased config not supported                                                                                       |
| consumer compatibility (incl. Subagent boundary) | C done         | Host/Worker share the Node Facade; Composer/task real runs, Wiki/Bot/UI 33 regressions, explicit Subagent 9 regressions; frozen execution, inheritance and Ticket get no re-resolution                                                                                        |
| typecheck/lint/unit/Pro E2E                      | A/B/C verified | C: Provider / provider-node / Option Map 352 tests pass; repo typecheck and lint pass; Pro `desktop-e2e-20260909-121842-573`: R95C-01, SR87-01, SR87-06 3/3 pass; pending does not auto-promote                                                                               |
| second review and closeout                       | A/B/C done     | C changes only the revision, 25 `values`, 10 Map close literals and shared resolution; dedicated requests equivalent, the fallback's temporary old-name mismatch corrected to the off semantics; no budget override, pre-send sync, request-layer alias or silent replacement |

C real-run and test-precondition correction: R95C-01 verifies a historical `nothink` draft shows `disabled` after reload, body edits still keep the historical value and the new value is saved only on send; the real model request carries `thinking.type=disabled` with no wrong effort. The first run failed on a test-precondition race (directly editing localStorage let the old page's `beforeunload` re-flush the in-memory draft over the injected historical selection; temporary logs proved the first read on the new page was already `disabled`, so the new resolution did not corrupt persisted state). The case now injects the old record on `pagehide` (after the exit save) before reload; temporary diagnostics were removed and the production Composer save mechanism untouched. Mobile + SSH real devices and other historical debts stay with Todo102, not passed off as full-platform.

## 8. References

Architecture baseline: [Model Option Map](../design/model/model-option-map.md), [Selection State](../design/interaction/selection-state.md), Todo 76 / 87; smart-config interaction per [Todo 92](todo-92-model-smart-config-and-override-feedback.md). Protocol sources (field provenance only, not proof that hybrid fields are accepted by all servers; real compatibility assumptions and limits are in §3; protocol differences found during implementation never quietly change existing dedicated model behavior): Zhipu thinking-mode docs, DeepSeek Thinking Mode, Qwen OpenAI-compatible API, OpenRouter Reasoning, Anthropic Extended Thinking and Effort.
