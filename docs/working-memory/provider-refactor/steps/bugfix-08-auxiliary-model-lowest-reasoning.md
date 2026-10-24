# Bugfix 08: Auxiliary Model Calls Use the Lowest Reasoning Tier

> Status: Completed
>
> Date: 2026-08-28
>
> Source: GLM-5.3 Flash carried no public Reasoning tier when generating a title
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/bugfix-08-auxiliary-model-lowest-reasoning.md`

## 1. Problem

Session title, Goal title, Git Commit Message, Memory Recall Selector and the Provider connectivity test are short,
low-cost auxiliary calls. Each looked up a `disabled` / `off` / `nothink` / `none` Mapping through
`reasoningMode: "disabled"`. A model that cannot close Reasoning but publicly offers `low / high / max` ended up
with no Reasoning Mapping, and business code that meant "lowest cost" implemented "force closed" by guessing
provider-specific tier names.

## 2. Semantics

`reasoningLevel.values` is an ordered list from lowest to highest reasoning intensity; `default` is the tier for
normal requests (not necessarily the lowest). "Lowest" is not "closed":

- public `off / low / high` -> lowest is `off`;
- public `low / high / max` -> lowest is `low`;
- no Reasoning Option Spec -> no tier is synthesized or guessed.

Normal conversations, Compact, Subagent, Repo Wiki, etc. keep using the user's explicit selection or `default`. Only
entries explicitly declared as auxiliary low-cost requests change.

## 3. Rules

1. Auxiliary calls read `Model.optionSpecs.reasoningLevel.values[0]` and bind it through `Model.bind` /
   `ModelRequest.reasoningLevel`; the normal `reasoningMapping` / Adapter chain applies. No new Policy, Resolver,
   Factory Input or Request Option.
2. Entries:

| Entry                      | Behavior                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Session Title / Goal Title | Auxiliary Model created with the lowest public tier (shared implementation)                                                       |
| Git Commit Message         | Auxiliary Model uses the lowest tier regardless of the current session's tier                                                     |
| Memory Recall Selector     | Single request passes `reasoningLevel: values[0]`; Active Model options unchanged (immutable); output budget inherited from the Active Model |
| Provider Connectivity Test | Formal Model from the current Registry bound to `values[0]` through the same Registry, ModelFactory, runtime headers and Adapter chain; nothing bound without a Spec; provider-neutral user message, no Start Plan-specific body, Provider ID branch or test-specific auth |

3. `reasoningMode`, its dedicated Model Request Options, Factory Input, hidden closed-Mapping scanning and
   `resolveReasoningDisabledMappingKey` are removed. The old "closed reasoning fixes 256 tokens" assumption, the
   Git Commit Message fake 256 Token parameter, the Core special ignore branch and Adapter Telemetry closed-tier
   name scanning are also removed (Todo 42).
4. Model selection, Session persistence, Registry, Account/Personal Overlay, normal request defaults and
   desktop/mobile recovery are unchanged.
5. Schema and authoring: the Provider Model Config Schema documents `reasoningLevel.values` as "sorted from the
   lowest reasoning intensity to the highest"; the TypeScript Contract, Provider Config Design, Model Contract and
   Built-in author specification state the same order. Built-in values are sorted low to high with `default`
   unchanged. The Schema validates only non-empty and `default` in `values`; order correctness and duplicate
   avoidance are the config publisher's responsibility, not client validation.

## 4. Verification Targets

`values[0]` taken when a Spec exists, no tier otherwise; Title/Git Commit bind it on the created Model without
touching Selection; single Memory Recall uses it without changing Active Model options; connectivity test binds only
with a Spec; Adapter sends the lowest tier through normal Reasoning Mapping; GLM-5.3/Flash integrity test confirms
public order `low / high / max`, normal default `max`, lowest mapping `low`. Core, Bootstrap, Adapters, Contracts,
Provider Node tests, root `typecheck` and `lint` passed (12,720 unit tests passed at the time).

## 5. Open Items

- Full-workspace `fmt:check` was blocked by pre-existing Electron example HTML and `apps/zcode-cli/tests/gb2312.js`
  issues; not expanded here.
- The 2026-08-30 review found the connectivity test still missed lowest-tier binding; it was folded into the same
  `values[0]` rule. The 3012 risk-control rejection could not be reproduced after the Experience Plan activity ended
  and is deliberately not turned into a Provider special case.
