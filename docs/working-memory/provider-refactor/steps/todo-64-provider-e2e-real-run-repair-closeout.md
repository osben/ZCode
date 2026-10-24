# Todo 64: Provider E2E Real-Run Repair and Evidence Closeout

> Status (2026-09-09): this verification Todo is closed; remaining items are owned solely by [Todo102](todo-102-verification-debt-closeout.md). The failures below are historical; closing does not mean they passed.

> Status: done
>
> Date: 2026-09-02
>
> Baseline: `64d48f6eee`
>
> Implementation report: `todo-64-provider-e2e-real-run-repair-closeout-implementation-report.md`
>
> Prerequisites: Todo 52 (first E2E migration round); Todo 59 (removed Renderer Account-first selection); Todo 60 (removed fixed reasoning budget); Todo 63 (Selection invalidation and request budget). This Todo follows real WDIO runs on a MacBook Pro and fixes test drift, residual implementation and genuine product bugs.

## 1. Goal

Make the formal Desktop E2E prove the current Provider architecture again:

```text
real Config / Account / Personal input
                    |
                    v
          Effective Provider Registry
                    |
                    v
     Host preferredSelection / Active Model
                    |
                    v
       Desktop UI and real model-request behavior
```

Each failure must be classified as: a test still building removed legacy Account API Providers or Selection state; a shared Helper asserting a removed request field; a wait that never saw the formal Registry/Selection state; an unrelated product/test problem found by the run; or production code that violates the current Design.

Never restore Family legacy Schema, Renderer Account-first branches, fixed `budget_tokens`, legacy Provider seeds or a second Registry to make tests pass.

## 2. Execution rules and stop boundary

```text
root cause, contract and fix clear -> fix failing test/evidence first, fix fully, remove same-origin residue
root cause unclear -> isolate single Case + runtime evidence
      unique root cause and natural fix within existing Design -> fix after recording evidence
      otherwise -> change nothing, record evidence, ask for a ruling
```

1. Decided problems are fixed completely, not by loosening assertions, restoring old fields or adding product special cases. Personal Config polling may take a bounded 1-3 seconds of propagation.
2. Undiagnosed problems need the earliest failure point proven; never guess from a final UI timeout.
3. If evidence points uniquely to a Fixture, Helper, wait condition or case isolation and the product contract is unchanged, fix directly.
4. A fix that would change Provider, Model Selection, Repo Wiki, Compact, Quota or Account product semantics stops and asks for a ruling.
5. After each fix, review sibling callers and tests; remove dead compatibility branches, duplicate Helpers and residual assertions.
6. Passing Cases are not changed to accommodate failing ones; affected groups and the final set prove no regression.
7. The implementation report is maintained during execution.

## 3. Real-run baseline

MacBook Pro, clean run directory, commit `64d48f6eee`, Desktop WDIO per spec (last run per spec): 43 pass, 12 fail, 1 environment skip. The skip is Remote SSH: not counted as pass, not a product failure; stays `blocked-environment` with a reproducible command.

Chains that already passed and must not be touched to suit failing Cases: Bot terminal, Feishu interaction cards and streaming lifecycle; most Coding Plan/Team Plan Usage, Quota and OAuth recovery scenarios; Context Window cold resume; Model Output Token main budget and two real multi-turn smokes; Turbo recovery and switch; Coding Plan Upgrade WebView (after fixing the run environment); Automation create/manage.

## 4. The 12 initial failures

| Category              | Case               | Failure                                                     | Ruling                                                                                   |
| --------------------- | ------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Template/UI           | MP-UI-01           | not restored to new Provider detail after creation          | Fixed: detail may have no name-edit button; assert the selected navigation identity      |
| Model JSON UI         | MP-UI-06           | expected `"{}"`, got empty string                           | Update the old placeholder assertion                                                     |
| Template + first send | I08                | Personal Rule save wait never satisfied                     | Fixed: Helper read `maxOutputTokens.default`; the formal field is `.max`                 |
| Repo Wiki             | Repo Wiki settings | no `ready-empty`                                            | Remove the non-core no-model E2E assertion; no no-Provider Fixture                       |
| Repo Wiki             | Repo Wiki produces | Generate button still disabled                              | Model selection lost reasoning; reuse unified Selection completion                       |
| Output Token          | OTB08-OTB10        | OTB09 asserted old cap 41,665                               | usage anchor already covers the previous assistant; correct value 41,671                 |
| Reasoning             | I20                | Helper required `thinking.budget_tokens`                    | Remove the shared assertion with no contract basis                                       |
| Restart Selection     | I26                | complete Team Plan Recent not restored                      | Complete seed + Registry readiness; fix production recovery only if still failing        |
| Restart Fallback      | I27                | old Start Plan Recent invalid, expected Account first model | Fall back to Host Configured Default; no Renderer Account-first                          |
| Restart Fallback      | I28                | removed-model Recent invalid, expected Account first model  | Same as I27                                                                              |
| Settings Transition   | I31                | non-first Team Plan model not kept                          | Settings round-trip keeps it; delete the consumer-less transition state                  |
| Quota Reminder        | QR-E2E-09          | first reset opportunity reminder not shown                  | Passes alone and in the full Coding Plan spec; run-isolation noise, no production change |

CPUW-01/03 failed first because of the WebView run environment and passed on rerun; if they fail again, fix the environment or Fixture first, never restore legacy Account API behavior.

## 5. The single model-selection semantics

### 5.1 General priority

```text
current Draft explicit selection (valid)
              |
              v
Workspace Recent Selection (valid)
              |
              v
Host ModelSelectionView.preferredSelection
```

Host `preferredSelection` has one general rule:

```text
valid Configured Default
          +-- exists --> use it
          `-- absent/invalid
                    v
          first visible Provider of the ordered Registry
                    v
          that Provider's first available model
```

Account Providers already sort before ordinary Providers and recommended models before other models, so without a valid Configured Default the generic fallback lands on the Account Provider's recommended model. That is the result of unified ordering, not Renderer Account-first special casing. Account Overlay changes only account access facts, entitlement and model members; the Renderer does not understand Start, Individual or Team and never reads Account Connection to pick `models[0]`.

### 5.2 Reasoning completion for new Selections

`completeNewModelSelection()` is the only entry that completes a new Selection:

```text
providerId + modelId
      -> find target Model in Registry
         +-- reasoningLevel present --> keep as is
         `-- missing --> ordered values.at(-1)
```

`reasoningLevel.values` is ordered low to high, so ordinary new user selections default to the last level. Auxiliary models (Title, Git Commit) that explicitly use the lowest level still take `values[0]`; the two behaviors must not be merged into one global policy. Repo Wiki model selection must reuse this entry and not save only `providerId/modelId` or duplicate `values.at(-1)` in the Renderer.

### 5.3 I26

Recent points to a still-valid non-first model of the current Team Plan; after cold start the complete selection must stay. Steps: seed complete `providerId + modelId + reasoningLevel`; the Account Scenario provides the Team Provider and model members; wait for an Effective Registry revision containing the model before asserting the toolbar; after first send, assert the real request routes to that Provider/Model/Reasoning. Only if the complete input still falls back is it a production recovery bug.

### 5.4 I27 / I28

Old expectations implied the removed Account-first rule. Current semantics:

```text
Recent invalid + Configured Default = DeepSeek valid
      -> Host preferredSelection -> Configured Default
```

I27: Recent is an invalid old Start Plan selection. I28: Recent is a model removed from Provider members. Fixtures add a DeepSeek replay and assert by Provider/Model identity on real requests. Only when Configured Default is absent or invalid does Registry publish order provide the final fallback.

### 5.5 I31

I31 used to re-select the same Team Plan after opening settings and expect the model to hold. Problems: a native Select does not guarantee `onValueChange` when re-selecting the current value; and `modelProviderFamilyConnectionTransitionSeq` had a producer but no consumer. I31 now verifies that a settings round-trip does not break a valid non-first model of the current Team Plan: seed a complete Team Selection, enter settings and confirm the same Team Connection, return without re-selecting the option, verify toolbar and first-send request keep the model and reasoning. Switching to another Team identity is not covered (no guarantee the model belongs to the new Provider); add a separate case if that rule is ever needed. The transition sequence, mark action, unchanged-selection reconciliation helper and their fake tests are deleted.

## 6. Reasoning request assertion

The formal Model Option Map no longer promises a fixed `thinking.budget_tokens`. I20 captured:

```text
Parent                thinking.type=enabled, output_config.effort=max
Child                 thinking.type=enabled, output_config.effort=high
Parent continuation   thinking.type=enabled, output_config.effort=max
```

This proves parent/child reasoning isolation and continuation. `assertUpstreamThoughtLevelCapture()` keeps route, model, text, `thinking.type` and `output_config.effort` assertions and drops the hard `thinking.budget_tokens > 0` requirement. A model-specific budget mapping is asserted only in that model's Fixture. All formal and pending Cases using the Helper are checked.

## 7. E2E shared infrastructure

### 7.1 Selection seed

`seedPersistedModelSelection()` writes only complete Selections `{ providerId, modelId, reasoningLevel }`; `reasoningLevel` is required at all formal call sites. Legacy-migration tests use an explicitly named raw/legacy seed. The Helper never guesses reasoning from model names or reads the UI to back-fill Fixtures.

### 7.2 Account Scenario seed

`seedAccountScenario(...)` expresses Account Provider, Team identity, entitlement and dynamic model members. Tests never assemble removed Account API Providers or invalid legacy fields; Family display and connection selection that are still needed go through the formal Schema.

### 7.3 Registry/Selection waits

Semantic waits observe user-visible Registry/Selection results; no E2E-only Registry, no production internal Snapshot reads, no fixed sleep instead of a final-state assertion:

```text
waitForEffectiveProvider(providerId)
waitForSelectableModel(providerId, modelId)
waitForSelectedModel(providerId, modelId, reasoningLevel)
```

Personal Config save to Worker effect may lag 1-3 seconds; bounded polling is allowed.

### 7.4 Template creation

One user click must produce one create mutation, one Personal Provider Overlay and an automatic entry to the new Provider detail. If the E2E helper clicked then submitted again, remove the duplicate; if production event bubbling/re-entry caused two mutations, write a failing E2E/component test first and fix the event boundary. Creation success waits on the returned Provider ID or the new Personal Overlay, never fuzzy name matching. Then add a model, wait for it to be selectable, and finish I08 first send.

### 7.5 JSON placeholder

Empty Overlay: textarea value empty, `{}` only a placeholder. User-written `{}`: value is `"{}"`. Effective read-only JSON shows the real parsed value. A placeholder is not saved Personal Config.

## 8. Specific fixes

### 8.1 Repo Wiki settings

The Case's job is the generation settings controls: drop the `ready-empty` banner and disabled-Generate assertions, add no no-Provider Fixture, use an ordinary E2E Provider for defaults/selection/input bounds, keep `repoWikiModelState` unit coverage of the empty Ready View, and remove the dedicated no-Provider entry from Repo Wiki E2E docs.

### 8.2 Repo Wiki produces

Real bug: choosing from the model menu saved only identity and overwrote the Host-completed Selection:

```text
complete preferredSelection -> user picks model menu
-> parseModelPickerValue() returns only providerId/modelId
-> reasoningLevel lost -> invalid-explicit -> Generate disabled
```

Fix: the pick event calls `completeNewModelSelection(modelSelectionView, identity)` and writes complete `providerId/modelId/options.reasoningLevel` to the Repo Wiki Draft; do not loosen the `ready` gate; no Repo Wiki-specific fallback or reasoning default; tests prove re-selecting the current model, switching model and switching reasoning keep a complete Selection.

## 9. Evidence plan for undiagnosed items

- MP-UI-01 / I08: record Template card activation count, create mutation count and returned Provider ID, Personal Overlay writes, nav selection, and whether the Helper creates again. One production mutation means fix the test; re-entry means fix the event boundary after a failing test.
- OTB08-OTB10: keep the 21K reserve, preflight cap and reactive compact goals. For the second request collect whether it was sent, replay lane match, compact completion, and whether assistant completion was lost to admission, fixture or UI wait. Change production only if the budget/compact behavior is proven wrong.
- QR-E2E-09: depends on Account Provider, Model Selection and entitlement but asserts the `initial` reset-opportunity reminder. Isolate the Case then compare with the whole spec: request sent, status/opportunity Fixture quantities and expiry, `displayedProviderId`/entitlement/Context trigger, reminder DOM dismissed by pointer events, window-level dismissal store already holding the same opportunity, earlier Case pollution. Pass-alone/fail-in-group is a case-isolation fix. Never change Account Provider ordering to make the reminder appear.

## 10. Implementation phases

- A: implementation report, required-reasoning Selection seed, Account Scenario and readiness Helpers, JSON placeholder assertion, remove the reasoning-helper budget assertion; review for no new legacy fields, model-name hardcode, direct Registry injection or unbounded waits (except the ruled 1-3 s polling).
- B: Selection Cases (Repo Wiki, I26, I27/I28, I31); confirm no Renderer Account-first branch and Configured Default still outranks Registry fallback.
- C: runtime diagnosis of MP-UI-01/I08, OTB08-10, QR-E2E-09.
- D: update Conversation Case Catalog and Coverage Matrix; keep Todo 57 history and reference this baseline without overwriting old evidence; record artifact paths, commands, SHA; keep SSH Case `blocked-environment` with rerun conditions; finish the report.

## 11. Implementation report contract

A separate file (not rewriting the plan as narrative) with: implementation baseline (start/end SHA, run directory and tool versions, initial 43/12/1 evidence); per-Case record (failure and artifact, earliest failure point, root-cause class production / fixture / helper / isolation / environment, product-ruling involvement, fix and deletions, targeted/group/full results, unchanged items and why); final review (Provider/Selection abstraction, legacy-field search, typecheck/lint/unit/E2E results, blocked-environment conditions, remaining risks). Unlocated or failing Cases stay explicit, never summarized away as "unrelated" or "environment flakiness".

## 12. Verification plan

Targeted Helper/Store/Selection unit tests; `pnpm --filter @zcode/desktop typecheck:e2e`; Fixture and case-local config checks; run the 12 original Cases alone with artifacts; rerun affected groups per spec (pass-alone/fail-in-group is a state-leak/Fixture-isolation bug, group runs stay in the gate); rerun the affected list; `pnpm typecheck`; `pnpm lint`; `pnpm test:unit`; `pnpm audit:conversation-session-coverage`; format check and `git diff --check`.

## 13. Completion criteria

- Selection seed no longer creates reasoning-less illegal data by default.
- I26 keeps the valid non-first Team Plan model; I27/I28 fall back through Host preferred to a valid Configured Default with no Renderer Account-first special case.
- I31 does not rely on re-selecting the same Select option; consumer-less transition state is gone.
- The DeepSeek reasoning shared Helper no longer requires `budget_tokens`.
- One Template click creates one Provider and enters its detail atomically; I08 first-sends by instance identity.
- JSON empty-Overlay and placeholder assertions agree.
- Repo Wiki model selection always yields a complete Selection; settings E2E has no unnecessary no-model scenario.
- MP-UI-01/I08, OTB08-10, QR-E2E-09 have clear root causes and tests, not guess-changed assertions.
- All environment-capable Cases in the affected list pass; environment skips are listed separately.
- Family display and connection selection still needed are not deleted; removed Account API Providers are not restored; no second config or Registry authority; no concrete model IDs driving production behavior.
- The implementation report records each failure's outcome, run evidence, open items and final review.
- Final commit is a Conventional Commit with the Agent session trailer; no guessed Session ID.
