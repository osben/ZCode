# Todo 84: Model Selection Missing Reasoning and Auxiliary-Request Policy Closeout

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.

> Status: corrected and phase-accepted by Todo 88 R11 (status synced 2026-09-08). Taking the highest level when the user actively picks a model is implemented and no longer a to-do item; the full-platform unrun items stay as recorded in Todo 88, not claimed as all passing.
>
> Date: 2026-09-05
>
> Relation: closes the scattered conventions in Todo 58, 60, 63, 70 and 81 about missing/invalid Reasoning and auxiliary calls.

## Background

On 2026-09-07 the user corrected the rule: when the user actively picks a new model, use that model's current ordered highest level `values.at(-1)`. Historical restore, a missing persisted selection or an invalid level still keeps the model identity and clears the level. These are different product actions and their semantics are not merged for implementation convenience. The active-pick entry constructs a complete Selection explicitly; that is not a new Option Spec default and ModelFactory or the request layer must not fill in values silently. Auxiliary requests still use the lowest level at their own call sites.

## Final rules

### 1. Active model pick vs restore of an existing selection

```text
user actively picks a new model -> highest Reasoning level of the target model -> new Selection containing it
restore / re-validate an existing Selection -> keep the valid values, clear the invalid part (below)

Model Selection -> validate against the current Registry
  Provider/Model invalid -> clear the whole Selection
  Provider/Model valid -> validate reasoning: valid -> keep; missing/invalid -> keep Provider/Model, clear reasoning
```

- Switching models actively takes the target model's `values.at(-1)` and does not carry the source model's level; with no legal candidate level none is forged.
- Reading persisted or historical Selections and re-validating an existing selection after config refresh follow the empty rule, never filling the highest level.
- This ruling does not change the initial model of a brand-new Composer, Recent or Configured Default priority, nor the same-model / same-level continuity rule when switching accounts.
- A Selection with empty Reasoning must not enter normal model execution; the Composer waits for the user to re-pick the level.
- A nonexistent Provider or Model is never guessed; the whole Selection is cleared.
- The ordinary Composer shows an invalid Reasoning as empty with no generic migration-failure notice; executable tasks (Automation, still-runnable Off-Peak) surface "cannot continue running" at their original error location, following Todo 81's scenario scoping.

### 2. Auxiliary requests choose the level independently and explicitly

Auxiliary requests are not repairing or completing a Model Selection; each call constructs temporary request parameters explicitly:

```text
auxiliary call: Title / Memory / Recall / Connectivity Test / Goal Completion Verification / other explicit sidecar requests
  -> reasoning = optionSpecs.reasoningLevel.values[0]
     maxOutputTokens = budget explicitly limited by the caller
```

- Auxiliary calls never write back to Composer, Session or a persisted Selection.
- The lowest-level policy appears only when an auxiliary call builds its parameters and is not pushed down into a Model Selection default.
- Normal Goal execution and Goal continuation are not low-cost auxiliary requests and use the current complete Model Selection; only Goal Completion Verification uses the auxiliary policy.
- The connectivity test keeps using the lowest level explicitly and does not depend on the Composer's reasoning state.

## Scope (closed by Todo 88, acceptance requirements kept)

1. Restore the shared construction entry that takes the highest Reasoning on active model pick, with tests for how it differs from empty-on-restore; the fill never moves into the execution layer.
2. Every ordinary Selection requires a valid Reasoning before execution; ModelFactory and lower layers never fill levels silently.
3. Keep and unify "invalid Provider/Model clears the whole Selection, invalid Reasoning clears only Reasoning".
4. Audit consumers (Composer, Session restore, Model Selection View, Automation, Off-Peak, Subagent, Bot, Repo Wiki) so none re-guesses or fills Reasoning.
5. State the auxiliary-request call sites and test boundaries; in particular, Goal main execution must not take `auxiliaryModelOptions` and only Goal Completion Verification uses the lowest level.
6. Clean names, comments, docs and tests tied to the old "highest-level default fill" rule; no bridging logic.

## Acceptance

- After an active pick the default level is the model's current highest; persisted/historical restore and re-validation of an existing selection still leave a missing/invalid Reasoning empty (no auto up/down-grade).
- Provider/Model invalid -> whole Selection empty; Reasoning alone invalid -> model identity kept.
- The Composer recognizes empty Reasoning and asks for re-selection without an unrepairable generic migration notice.
- Automation and continuable Off-Peak tasks do not run with an empty Selection and give an understandable error in the original task location.
- Normal Goal setup and continuation use the current complete Selection; Goal Completion Verification uses the lowest Reasoning and its own output budget.
- Title, Memory, Connectivity and other auxiliary requests still pass the lowest level explicitly and modify no persisted Selection.
- Targeted tests covering create, persisted restore, Registry change, Composer, Goal, Automation and connectivity test pass, along with full typecheck, lint and existing E2E regressions.

## History and later correction

- The original 2026-09-05 implementation (`a43049c265d`) cancelled the active-pick highest-level fill: `normalizeModelSelection` kept Provider/Model identity and cleared missing/invalid Reasoning, the Registry-order fallback and auto highest level were deleted, model switching could save identity first with an explicit Reasoning pick required before execution, `resolveRegistryThoughtLevel` no longer fell back to the highest level, and `auxiliaryModelOptions` kept the lowest-level policy (Goal main execution and continuation unchanged). That behavior is historical and not the current one.
- [Todo 88 R11](todo-88-provider-audit-regression-repair.md) wired Composer, scheduled tasks, off-peak tasks, Subagent and Wiki active picks to the shared highest-level construction and filled both Bot `/model` entries. Historical restore with a missing level stays empty, not filled in ModelFactory. Recorded evidence: selection config/Facade/Composer 33 pass; Bot services 93/93; Pro `desktop-e2e-20260907-163541-147` 3/3, plus real child-request verification in I20 (synced from the record, not rerun).
- Full desktop/mobile unrun limits follow Todo 88. Migration environment-independence, original-intent protection and the legacy-field audit are carried by Todo 96/97; the highest-level feature is not re-listed as unimplemented.

## Non-goals

No redesign of Provider Config layering or Personal Provider Instance structure (Todo 76); no change to Goal product semantics, queue semantics or completion verification flow, only its model-level ownership; the auxiliary lowest level is not written into Model Config's `default` field.
