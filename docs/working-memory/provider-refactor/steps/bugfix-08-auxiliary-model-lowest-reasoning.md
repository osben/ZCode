# Bugfix 08: Auxiliary Model Calls Uniformly Use the Lowest Reasoning Tier

> Status: Completed
>
> Date: 2026-08-28
>
> Source: The GLM-5.3 Flash does not carry the public Reasoning tier when generating the title

## 1. Problem

The Session title, the Goal title, the Git Commit Message, the Memory Recall Selector, and the Provider connectivity test all belong to the short, low-cost auxiliary model calls. These entries currently do not share the "low-cost Reasoning" semantics; instead, they look up the `disabled`, `off`, `nothink`, or `none` Mapping through `reasoningMode: "disabled"` respectively.

This produces two issues:

- The model that does not allow closing the Reasoning, but publicly provides `low / high / max`, ultimately carries no Reasoning Mapping; the title request is inconsistent with the model's public capabilities;
- The business code expresses "lowest cost," but the implementation expresses "force closed," relying on the provider-specific tier name guessing.

## 2. The Correct Semantics

The `values` of the Reasoning Enum is an ordered list, sorted from the lowest reasoning intensity to the highest:

```text
reasoningLevel.values[0]             The lowest public tier
reasoningLevel.values[1..n]          Step by step increase
reasoningLevel.default               The default tier for normal requests (it may not be the lowest)
```

"The lowest tier" is not equal to "closed":

- When the model publicly provides `off / low / high`, the lowest tier is `off`;
- When the model only publicly provides `low / high / max`, the lowest tier is `low`;
- When the model has no Reasoning Option Spec, do not synthesize or guess any tier.

The normal conversations, Compact, Subagent, Repo Wiki, etc., still use the user's explicit selection or the `default`. This Bugfix only changes the entries explicitly declared as the auxiliary low-cost request.

## 3. Unified Execution Chain

```text
The auxiliary call reads the Model.optionSpecs
                    |
                    v
          reasoningLevel.values[0]
                    |
                    v
      Model.bind / ModelRequest.reasoningLevel
                    |
                    v
          The normal reasoningMapping / Adapter
```

- The title and the Git Commit Message directly bind the `values[0]` to the created Model;
- The Memory Recall directly passes the `reasoningLevel: values[0]` in a single request;
- The Provider connectivity test directly binds the `values[0]` to the formal Model, and continues to initiate the request through the same Registry, ModelFactory, runtime headers, and Adapter chain;
- Delete the `reasoningMode: "disabled"` and its hidden closed Mapping scanning used for selecting the auxiliary tier;
- Do not add the Policy, the Resolver, the Factory Input, or the Request Option; the Adapter only consumes the normal `reasoningLevel`;
- The Active Model remains immutable; the single Memory Recall request cannot modify its `options`.

## 4. Impact Scope

| Entry                      | New Behavior                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session Title              | Create the auxiliary Model using the lowest public Reasoning tier                                                                                              |
| Goal Title                 | Share the same implementation with the Session Title                                                                                                           |
| Git Commit Message         | Regardless of the tier of the current session, the auxiliary Model uses the lowest public tier                                                                 |
| Memory Recall Selector     | The single request uses the current Model's lowest public tier; the Active Model remains unchanged; the total output budget is inherited from the Active Model |
| Provider Connectivity Test | Test the formal Model in the current Registry, and use the lowest public tier; do not synthesize the tier when there is no Spec                                |

This does not change the model selection, Session persistence, Provider Registry, Account/Personal Overlay, normal request default, or the desktop/mobile recovery semantics.

## 5. Schema and Configuration Author Constraints

- The Provider Model Config Schema annotates the `reasoningLevel.values` as "sorted from the lowest reasoning intensity to the highest";
- The TypeScript Contract, Provider Config Design, Model Contract, and Built-in author specification synchronously explain the order semantics;
- The existing Reasoning values in the Built-in Config are sorted from the lowest to the highest; the `default` retains the original value, so the normal request behavior remains unchanged;
- The Schema only validates non-empty and that the `default` belongs to the `values`. The order correctness and the avoidance of duplicate values are the responsibility of the configuration publisher, not the client repeatedly establishing complex validation.

## 6. Test

Write the failure tests first, then implement:

- The `values[0]` is directly taken when there is the Reasoning Spec; no tier is synthesized when there is no Spec;
- The Session/Goal Title and the Git Commit Message both bind the `values[0]` on the created Model; the Selection is not changed;
- The single Memory Recall request uses the lowest tier; the Active Model options remain unchanged;
- The Provider connectivity test binds the `values[0]` when there is the Reasoning Spec; it does not bind when there is no Spec;
- The Provider connectivity test continues to use the provider-neutral user message; it does not restore the Start Plan-specific request body, the Provider ID branch, or the test-specific authentication;
- The Memory Recall inherits the total output budget of the Active Model; the old assumption of "closed reasoning is fixed to 256" is not retained;
- The Adapter sends the lowest tier through the normal Reasoning Mapping, without scanning the hidden closed alias;
- The Built-in Config review confirms that the Reasoning values are sorted from low to high; the client does not maintain another set of known tiers or order validation;
- The Core, Bootstrap, Adapters, Provider targeted tests, and the root `typecheck`, `lint` pass.

## 7. Completion Criteria

- All known auxiliary model entries have only one lowest-tier implementation;
- No new Reasoning Policy, Resolver, Factory Input, or Request Option is added;
- There is no `reasoningMode` in the production code; the auxiliary tier selection does not call the `resolveReasoningDisabledMappingKey`;
- The auxiliary request of the GLM-5.3/Flash uses the `low`, not the no Reasoning parameter;
- The normal request continues to use the explicit selection or the `reasoningLevel.default`;
- The documentation, Schema, Built-in order, and the test give the consistent explanation for "the Reasoning values are ordered."

## 8. Implementation and Verification Record

- The implementation only reads the `optionSpecs.reasoningLevel.values[0]` directly in three places: the Session/Goal Title shared chain, the Git Commit Message, and the Memory Recall;
- Delete the `reasoningMode`, the dedicated Model Request Options, the Factory Input, and the internal Mapping entry; no alternative abstraction is added;
- The GLM-5.3/Flash integrity test confirms the public order is `low / high / max`, the normal default is still `max`, and the lowest tier mapping is `low`;
- The Contracts, Adapters, Bootstrap, Core, and Provider Node targeted tests pass;
- The root `typecheck`, the CLI affected package typecheck, and the `lint` pass;
- The full unit test: 1491 test files pass, 1 skip; 12,720 tests pass, 25 skip.
- The format check of this round's 26 modified files and the `git diff --check` pass; the full workspace `fmt:check` is still blocked by the existing Electron example HTML syntax and the `apps/zcode-cli/tests/gb2312.js` read issue; the scope is not expanded to fix this round.
- The Todo 42 further deletes the invalid 256 Token fake parameter of the Git Commit Message, the Core's corresponding special ignore branch, and the Adapter Telemetry's closed tier name scanning; the Title, Git Commit, and Recall without the Reasoning Spec all have direct tests.
- The 2026-08-30 review discovers that the Provider connectivity test still misses the lowest tier binding; this Bugfix incorporates it into the same direct `values[0]` rule. The 3012 risk control rejection that cannot be reproduced after the Experience Plan activity ends is not changed to the Provider special case by guessing.
