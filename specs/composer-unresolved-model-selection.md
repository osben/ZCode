# Composer: stored model selection cannot be resolved

Status: implemented (2026-10-22, ISSUE-026).

## Problem

An existing session stores the model the user picked. When that model can no longer run
(for example its provider is not signed in, such as Z.ai), the follow-up composer shows
"Choose model" and Send is disabled. Pressing Enter then showed the generic toast "The session
isn't ready yet", which does not say that the user has to pick a different model.

## Decisions

1. **The stored selection stays the intent.** The composer does not rewrite it, and it never
   falls back to another model on its own. Saved records and requests already pinned to a model
   are not changed.
2. **Only the three unavailability verdicts count.** The Host's `ModelSelectionView.selectionIssue`
   (`packages/provider/src/effective-model-selection.ts`) values `provider-not-found`,
   `account-connection-unavailable` and `model-not-found` mean the stored model cannot run now.
   `selection-missing` (no model chosen) and the reasoning-level issues keep the generic reason.
3. **A dedicated block reason.** When the verdict is one of those three, the submit block reason
   is `modelUnavailable`, with the text "Selected model is unavailable — choose a model." It is
   checked after the remote-availability check (an unavailable remote host still explains
   itself first) and before the generic readiness check.
4. **One owner.** `resolveComposerSubmitBlockReason`
   (`packages/ui/src/v4/composer/composerSubmitBlockReason.ts`) derives the reason. The composer
   passes `modelSelectionView.selectionIssue` into it at both call sites (the render-state Send
   barrier and `submit()`), so they cannot disagree.

## Owners and event order

- Host: `ModelSelectionView` (`resolveEffectiveModelSelection`) owns the verdict.
- `useDraftConfigControl` owns the draft intent and derives the `draftConfig.modelSelection`
  (undefined when unresolved), so the toolbar keeps showing "Choose model".
- `ConversationComposer` only forwards the verdict into the predicate. It does not write the
  selection.

## Acceptance

| ID     | Action                                                             | Must observe                                                                                                                             |
| ------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| UMS-01 | Open a session whose stored provider is not signed in, press Enter | Toast and Send tooltip say "Selected model is unavailable — choose a model."; the message is not sent; the stored selection is unchanged |
| UMS-02 | Same session, choose a model from the toolbar, press Enter         | Message sends with the chosen model; the block reason disappears                                                                         |
| UMS-03 | New task with no model chosen, press Enter                         | Generic "The session isn't ready yet" text (unchanged)                                                                                   |
| UMS-04 | Stored model unavailable while the remote host is disconnected     | The remote-unavailable reason is shown, not the model reason                                                                             |

## Validation

- `packages/ui/test/composerSubmitBlockReason.test.ts`: each of the three unavailability
  verdicts yields `modelUnavailable` even when readiness is false; the remote reason takes
  precedence; `selection-missing` and reasoning-level issues keep `sessionNotReady`; a ready
  state returns null.
- `packages/ui/test/i18nCatalogParity.test.ts`: the new `composer.sendBlocked.modelUnavailable`
  key exists in en-US, zh-CN and uk-UA.
- UMS-01 to UMS-04 are not covered by a mounted UI or E2E test yet; the unit test covers the
  predicate only.
