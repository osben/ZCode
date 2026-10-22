# Composer: stored model selection cannot be resolved

Status: implemented (2026-10-22, ISSUE-026; amended the same day after live verification).

## Problem

An existing session stores the model the user picked. When that model can no longer run
(for example its provider is not signed in, such as Z.ai), the follow-up composer shows
"Choose model" and Send is disabled. Live verification then showed that Enter inserted a newline,
no notice appeared, and hovering Send showed nothing, so the reason was computed but never shown.

## Decisions

1. **The stored selection stays the intent.** A session-bound draft keeps its stored model and is
   never silently replaced by another model. A new-task (root) draft is different: it still
   initializes from the Host's `preferredSelection` as before (`useDraftConfigControl`). Saved
   records and requests already pinned to a model are not changed.
2. **Only the unavailability verdicts count.** The Host's `ModelSelectionView.selectionIssue`
   (`packages/provider/src/effective-model-selection.ts`) values mean the stored model cannot run now:
   - `provider-not-found` and `model-not-found` give `modelUnavailable`:
     "Selected model is unavailable — choose a model."
   - `account-connection-unavailable` gives `modelAccountUnavailable`: "The selected model's account
     isn't connected — sign in or choose a model." It needs a sign-in, not only another model.
   - `selection-missing` (no model chosen) and the reasoning-level issues keep the generic reason.
3. **Settled startup only.** The verdict is trusted only after provider startup has settled. Root
   (`packages/ui/src/Root.tsx`) is the single writer of `useProviderStartupStore.settled`
   (`packages/ui/src/store/providerStartupStore.ts`), which is `!providerStartupSyncPending &&
providerAvailabilityStartupCheckCompleted`. Before that a "not found" verdict can be transient
   (the cold-start Selection View may lack the account overlay), so the generic reason stays.
4. **Ordering.** After the remote-availability check, a model verdict yields to the in-flight
   barriers: `sendInProgress`, `outcomeUnresolved` and `firstSubmissionDelivering` keep their own
   copy, because they describe a message that is still being delivered. Only when none of them is
   active does the model reason show. The generic readiness path is otherwise unchanged.
5. **Visible, not only in the toast.** When the reason is a model reason and the draft has content,
   the inline `composer-send-blocked-reason` status line under the editor shows the copy. The Send
   button stays disabled. A disabled button does not open its hover tooltip, so the inline line is
   the visible surface, not the tooltip.
6. **Enter keeps the draft and names the reason.** In a model-reason state, Enter does not insert a
   newline. `LexicalChatInput` calls the caller's `onSubmitBlocked` (passed only for model reasons),
   which repeats the same copy as a deduplicated toast. Other blocked states keep their existing
   Enter behavior.
7. **One owner.** `resolveComposerSubmitBlockReason`
   (`packages/ui/src/v4/composer/composerSubmitBlockReason.ts`) derives the reason. The composer
   passes `selectionIssue` and the settled flag into it at both call sites (the render-state Send
   barrier and `submit()`), so they cannot disagree.

## Owners and event order

- Host: `ModelSelectionView` (`resolveEffectiveModelSelection`) owns the verdict.
- Root: writes the settled flag from provider startup state.
- `useDraftConfigControl` owns the draft intent and derives `draftConfig.modelSelection`
  (undefined when unresolved), so the toolbar keeps showing "Choose model".
- `ConversationComposer` derives the reason and renders it. It does not write the selection.
- `LexicalChatInput` only reports the Enter through `onSubmitBlocked`.

## Acceptance

| ID     | Action                                                         | Must observe                                                                                                                 |
| ------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| UMS-01 | Existing session, stored provider not signed in; type "x"      | Inline line under the editor: "Selected model is unavailable — choose a model."; Send stays disabled                         |
| UMS-02 | Same as UMS-01, press Enter                                    | No newline is inserted; the text stays; the same copy appears as a toast; nothing is sent; the stored selection is unchanged |
| UMS-03 | Stored account connection missing; type "x"                    | Inline line shows the sign-in copy, not the model copy                                                                       |
| UMS-04 | Same as UMS-01, but before startup has settled (cold start)    | The generic "session isn't ready" reason shows, not the model copy; no model-specific Enter path                             |
| UMS-05 | UMS-01 while a first submission is delivering                  | The in-flight barrier copy shows, not the model copy                                                                         |
| UMS-06 | Choose a resolvable model from the toolbar; press Enter        | The message sends with the chosen model; the inline reason disappears                                                        |
| UMS-07 | New task with no model chosen; press Enter                     | Generic "The session isn't ready yet" text (unchanged)                                                                       |
| UMS-08 | Stored model unavailable while the remote host is disconnected | The remote-unavailable reason is shown, not the model reason                                                                 |

## Validation

- `packages/ui/test/composerSubmitBlockReason.test.ts`: the provider and model verdicts yield
  `modelUnavailable`; the account verdict yields `modelAccountUnavailable`; the remote reason takes
  precedence; an unsettled startup keeps `sessionNotReady`; in-flight barriers are not hidden;
  `selection-missing` and reasoning-level issues keep `sessionNotReady`; a ready state returns null.
- `packages/ui/test/v4ConversationComposerPromptHistory.test.ts` (mounted composer with the editor
  mocked): UMS-01 and UMS-02 (inline line, Enter callback keeps the text, no send), UMS-03 (account
  copy), UMS-04 (no inline line before settled, no Enter path).
- `packages/ui/test/i18nCatalogParity.test.ts`: `composer.sendBlocked.modelUnavailable` and
  `composer.sendBlocked.modelAccountUnavailable` exist in en-US, zh-CN and uk-UA.
- Not covered by a test: the real Lexical Enter key path (the mocked editor exercises the composer
  side only), UMS-05, UMS-06 and UMS-08 in a mounted or E2E run, and the cold-start settle transition
  in Root. Live verification of UMS-01 and UMS-02 is the remaining gate.
