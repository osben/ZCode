# Todo 110: Guide Re-resolves the Same Selection Without Triggering a Model-Switch System Rebuild

> Status: Completed (2026-09-10): implementation, real-Runtime request verification and per-item review; the new desktop
> GS/P06 assertions have not been run. Evidence, boundary review and real-environment limits:
> [delivery review](./provider-todos-105-113-delivery-review.md).
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-110-guide-selection-change-prefix-rebuild.md`

## Ruling

Two facts are separated: **execution Model re-resolution** and **ModelSelection change**.

1. When a Guide carries a ModelSelection, even an unchanged one must re-resolve configuration through the current unified
   entry, validate it and create the execution Model; the same Provider, model and level do not mean the config is unchanged.
2. The newly resolved Model serves later requests; an old Model, skipped config resolution or old execution parameters are
   never reused just because the Selection is equal.
3. Only a change of the Selection itself triggers the Guide's model-switch System prefix rebuild. "A Model was returned"
   or "the new Model object differs from the old one" is not the switch condition.
4. Out of scope: the output-style freeze problem, and any refactor of Provider, Selection, account sync or Guide scheduling.

This supersedes the draft "reuse the old Model for an equal selection and skip the model factory"; it must not be implemented.

## Problem and Entries

- `apps/zcode-cli/packages/core/src/runtime/methods/turn-model.ts` `applySubmissionExecutionState()` creates and returns a
  Model on receiving a Selection; the existing selection comparison only controls the Session model-selection event and
  does not stop the Model from being returned.
- `turn-guide-drain.ts` only checked `if (guideModel)` and then replaced the execution Model and called
  `rebuildContextPrefix()`, conflating getting a Model with a switch.
- `turn.ts` new-Turn / compact paths use the same public function, which must not break.
- The Session-saved selection and the Loop's bound execution model may differ (Bot entries can update the Session), so
  whether a Guide changes the execution selection is compared against the current Loop's actual Model, not the mutable Session value.

```text
Guide consumed at the next model-step boundary -> append Guide body
  -> record the pre-switch execution selection (from the current Loop Model)
  -> re-resolve / validate / create Model via the existing unified entry -> later requests use the new Model
  -> compare Guide selection with the pre-switch selection: same -> no switch System prefix rebuild; different -> existing rebuild
  -> normal input ownership, mode and other Guide handling
requests already sent keep their original binding
```

## Rules

1. Selection comparison covers `providerId`, `modelId`, `options.reasoningLevel` per the full Selection contract; a change
   of Provider, model or level alone counts. Not by display name, object reference or whole model config.
2. `model` and `selectionChanged` are expressed separately at a suitable existing boundary (small return value or Guide-local
   computation); no state service, cache or persisted field for one boolean.
3. `selectionChanged` controls only the switch-specific prefix rebuild, not whether the Model is re-resolved. With the same
   selection but updated config, later requests must use the new Model's config.
4. No early return at the top of the public function for "same selection", and no old Model passed as `preparedModel`.
   Normal new-Turn Model creation and existing prepared-model uses are unchanged.
5. Session selection commit, persistence and events keep their semantics; the Session-change event and the "rebuild the
   prefix" decision are different judgments and not replaced by one boolean. When Session / execution / Guide selections
   agree, no false model-switch event is produced.
6. Guide body, mode update, query / message ownership, tool-restriction merge and duplicate-tool detection reset are still
   processed. A Guide without Selection keeps the original behavior.
7. A real model change keeps using the factory validation and switch boundary, never silently swaps models or swallows
   resolution failures. Execution-scope temporary binding, Off-Peak and existing inheritance protection are unchanged.
8. A short comment at the fix explains "config re-resolution does not mean selection change". The unified Model downstream
   consumption is kept; no second request-parameter source.
9. Specs / feature graph wording "Guide always creates and rebuilds the model context" is updated to state the different
   conditions for re-resolution and prefix rebuild; the overall context freeze contract is untouched.

## Not Done

- The second problem (on a real switch the prefix builder reads the latest output style while the reminder still uses
  the turn's frozen style) stays independent and is not claimed as solved; no deleting/pre-updating of the reminder or
  refreshing of all frozen config to mask it.
- No change to Guide admission, FIFO, commit/save timing, desktop continuous / phone replayable chains, no new pre-send
  sync barrier; no database migration, Bot command, Provider config rule or other auxiliary call policy change.

## Acceptance (all done; tests first, per-batch targeted runs)

- Same full Selection, unchanged config: factory still called, later requests use the re-resolved Model; System not
  rebuilt; Guide body enters the request.
- Same full Selection, changed config (observable, e.g. legal output limit change): later actual requests use the new
  config while the System prefix does not change from switch logic (not just factory-call or object-comparison asserts).
- Same Selection plus run-mode change: mode applied, prefix not rebuilt; input ownership and other Guide state kept.
- Provider, model and level each changed: original real switch behavior, new Model used, prefix rebuilt per existing rules.
- Consecutive Guides A->B, B->B: both resolve, only the first triggers the switch rebuild.
- Session-saved selection differs from the Loop execution selection: rebuild depends on the Loop; Session save / event
  keep original commit semantics (the two change judgments are not mixed).
- No Selection, resolution failure, execution-scope temporary binding, and next-turn same-model paths do not regress.
- Real Runtime with an offline test model capturing before/after requests: changing output style mid-run then submitting a
  same-selection Guide shows the body while the System prefix is unchanged (this does not claim the real-switch style
  freeze problem is fixed).
- Existing Guide interaction E2E checked, minimal discriminating cases added/updated; desktop/phone share the CLI
  consumption boundary (single-end passing is not written as all-end on-device passing).
- Whole-batch targeted tests, `pnpm typecheck`, `pnpm lint`; review of public callers, new-Model downstream use,
  persistence and out-of-scope freeze semantics.

## Result

- Reuses `turn-model`'s full selection comparison and controls only the rebuild in Guide, comparing the old Loop Model
  with the new Model (not the mutable Session or object references). Factory and Session commit logic unchanged; no early
  return or prepared-model bypass.
- `guide-model-refresh.test.ts` (real Runtime request capture): 5 same-selection / consecutive-Guide scenarios failed on
  the old implementation; with the fix 9 scenarios pass (including real Provider/model/level changes and two-way
  Session/Loop differences). Output limit updated 8,000 -> 16,000: later requests use the new value, System keeps the old
  value, Guide text/mode/ownership normal.
- 5 files / 186 targeted regression cases pass (above test, old Guide tests, Runtime model lifecycle/selection, full tool
  loop); Core typecheck passes.
- Review: execution-scope branch unchanged; no-selection, resolution-failure, new-Turn and prepared-model paths keep their
  original route; current request unaffected; tool restriction, duplicate-tool detection and message/query updates remain
  outside the rebuild judgment. No sync/persistence/projection state added; the second output-style freeze problem untouched.
- GS/P06 gains real first-turn / consecutive-Guide request prefix assertions with catalog/matrix synced; these new E2E
  assertions are awaiting whole-batch desktop verification and the old formal mark must not stand in for this run.
