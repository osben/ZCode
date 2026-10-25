# Todo 108: Restore the Goal Verifier Thinking Level and Output Limit

> Status: Completed (2026-09-10): implementation, Verifier real-request tests and per-item review. Evidence, boundary
> review and real-environment limits: [delivery review](./provider-todos-105-113-delivery-review.md).
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-108-goal-verifier-model-options-restoration.md`

## Ruling

The Goal Verifier uses the Session's model and thinking configuration as of verification start, with the output limit
that model resolves to under the current configuration system. Being an internal call is no reason to force a lower
thinking level or add a separate 5,000-token cap. The original product semantics are restored while keeping the current
Provider / ModelSelection / ModelFactory abstraction; old interfaces and config sources are not restored.

## Root Cause (confirmed)

- Remote `main` (`e7921fb5d4`): the Verifier read `defaultModelRef` and `modelProviderOptions` at verification start with
  no independent thinking override; `resolveNormalRequestMaxOutputTokens` used the model's resolved `maxOutputTokens`
  (fallback 32,000 only when missing/invalid; not a cap; no Verifier-specific 5,000 limit).
- The current Verifier still read the Session ModelSelection and created the Model, but commit `5aaddd0bdf` changed the
  request parameters to `auxiliaryModelOptions(model)`: forced `reasoningLevel.values[0]` and `min(5000, maxOutputTokens.max)`.
  The Verifier had been grouped into the low-cost auxiliary call policy; unifying the call implementation changed business behavior.
- Code: `apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts`,
  `apps/zcode-cli/packages/core/src/model/auxiliary-model-options.ts`.

## Rules

1. The Verifier does not use the auxiliary downgrade / 5,000 cap policy. The request inherits the created Model's thinking
   configuration (no switch to lowest, highest or off level).
2. The output limit follows the unified model configuration and request rules; the Verifier adds no budget, fallback or
   cap. main's 32,000 is history only; the old Runtime fallback is not reintroduced.
3. The model is fixed at verification start; the request, retries and usage attribution share the same execution Model.
   Changing the Session selection mid-verification does not affect the running verification, and Verifier parameters are
   never written back to the Session.

```text
verification start -> read Session ModelSelection -> create execution Model via the existing unified entry
  -> request / retry / usage attribution share it;  later Session reselection affects only new executions
```

4. `auxiliaryModelOptions` is not changed or deleted globally; other auxiliary calls (such as title generation) keep their policy.
5. Verifier Prompt, result parsing, failure handling, cancellation, Start Plan retry, message projection and Provider
   authentication are unchanged; no new account architecture.

## Implementation (2026-09-10 ruling)

A local deletion of the wrong policy, with no Verifier-specific config layer, parameter parser or helper:

1. Keep the existing `getSessionModelSelection()` and `createRuntimeModel(...)` binding entries.
2. Remove the Verifier's import and use of `auxiliaryModelOptions`; pass in `generateText`:

   ```ts
   options: {
     maxOutputTokens: input.model.optionSpecs.maxOutputTokens.max,
   },
   ```

3. No `reasoningLevel` override is passed; existing Model request preparation merges bound parameters and validates.
4. `options` cannot be dropped entirely: normal Turns in `turn-model-step.ts` explicitly use the model's declared output
   limit and ModelFactory does not fill the request output budget; the Verifier follows the same boundary.
5. No global change of `auxiliaryModelOptions`, no old `defaultModelRef` / `modelProviderOptions` path, no 32,000 fallback or new budget constant.
6. A short comment at the change explains that the Verifier cannot use the low-cost auxiliary downgrade/cap policy.

## Acceptance (all done)

- Regression tests first, asserting parameters actually used after Model request merge, not only the creation-time Selection.
- A non-lowest Session level (high / max) is used in the actual request; the off level is preserved, not forced on.
- With no explicit level, the unified Model's resolution semantics apply (no Verifier default policy).
- Output limits above and below 5,000 follow the model configuration; 64,000 is covered to prevent a 32,000 cap.
- Reselecting the Session mid-verification, retries and usage records keep using the starting execution Model; the Session
  is not polluted by auxiliary parameters.
- Other auxiliary call parameters, Verifier message projection, cancellation and existing retry paths do not regress.
- Targeted tests, typecheck and lint ran per batch; no per-small-change full regression or Pro run; untested parts are
  stated, and local parameter capture is not real-provider verification.

## Result

- `adapters/tests/goal-verifier-model-options.test.ts` (real Runtime + SQLite + ExecutableModel request preparation,
  capturing merged parameters): high/max/no-explicit-level failed before the fix; 5/5 pass after, including 4,000,
  64,000, 128,000 and Session reselection during a Start busy retry. Existing Core Verifier/verification tests: 22 pass
  (usage binding, cancel, retry, media projection, goal loop, queue boundary); two stale 5,000-policy assertions corrected.
- Review: Factory/Selection entry unchanged; one Model bound per verification and shared by request, retry and usage; no
  Session write-back; other auxiliary calls and the helper unchanged; Prompt, parsing and failure policy unchanged.
- Root `pnpm typecheck` and `pnpm lint` pass (41 existing warnings, 0 errors); Adapters typecheck passes. Offline local
  evidence, not provider online verification.
