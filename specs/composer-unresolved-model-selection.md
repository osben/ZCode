# Composer: stored model selection cannot be resolved

An existing session stores the model the user picked. When that model can no longer run (for
example its provider is not signed in, such as Z.ai), the follow-up composer shows "Choose model"
and Send is disabled. The blocked reason must be visible and Enter must not silently insert a
newline.

## Decisions

1. **The stored selection stays the intent.** A session-bound draft keeps its stored model and is
   never silently replaced by another model. A new-task (root) draft is different: it still
   initializes from the Host's `preferredSelection` as before (`useDraftConfigControl`). Saved
   records and requests already pinned to a model are not changed.
   - **Precedence with ISSUE-035:** a stale explicit pick (the Session model moved away from its
     base) is dropped only when the picked model is resolvable. An unresolvable pick stays as stored
     intent: the marker and the model stay, and Send stays blocked with the model reason. See the
     precedence rule in `docs/ui/composer-text-draft-persistence.md`, section "已有 Session 的显式模型选择".
2. **Only the unavailability verdicts count.** The Host's `ModelSelectionView.selectionIssue`
   (`packages/provider/src/effective-model-selection.ts`) values mean the stored model cannot run now:
   - `provider-not-found` and `model-not-found` give `modelUnavailable`:
     "Selected model is unavailable — choose a model."
   - `account-connection-unavailable` gives `modelAccountUnavailable`: "The selected model's account
     isn't connected — sign in or choose a model." It needs a sign-in, not only another model.
   - `selection-missing` (no model chosen) and the reasoning-level issues keep the generic reason.
3. **Settled startup only, per window.** A verdict is trusted only after this window's provider
   startup has settled. Root (`packages/ui/src/Root.tsx`, around the `providerStartupSettled`
   assignment) is the single writer of `providerStartupSettled` in `zcodeSessionStore`
   (`packages/ui/src/store/zcodeSessionStore.ts`). The flag is
   `!providerStartupSyncPending && providerAvailabilityStartupCheckCompleted`. Before that a "not
   found" verdict can be transient (the cold-start Selection View may lack the account overlay), so
   the generic reason stays.
   - **Scope limit:** the flag reflects this window's local startup only. The startup of a remote
     target Host is not covered; a remote workspace's verdict is trusted only after this window has
     settled.
4. **Ordering.** After the remote-availability check, a model verdict yields to the in-flight
   barriers: `sendInProgress`, `outcomeUnresolved` and `firstSubmissionDelivering` keep their own
   copy, because they describe a message that is still being delivered. Only when none of them is
   active does the model reason show. The generic readiness path is otherwise unchanged.
5. **Visible, not only in the toast.** When the reason is a model reason and the draft has content,
   the inline `composer-send-blocked-reason` status line under the editor shows the copy. The Send
   button stays disabled. A disabled button does not open its hover tooltip, so the inline line is
   the visible surface, not the tooltip.
6. **Enter keeps the draft and names the reason.** In a model-reason state, the send key does not
   insert a newline, for the default binding and for a rebound send key alike. `LexicalChatInput`
   calls the caller's `onSubmitBlocked` (passed only for model reasons) before the scoped-binding
   early return. The composer repeats the same copy as a deduplicated toast, but only when the draft
   has content.
   - **Empty draft:** Enter on an empty model-blocked draft is swallowed silently. It inserts no
     newline and shows no notice, because the inline line is shown only for a non-empty draft.
   - Other blocked states keep their existing Enter behavior. Mobile `enterSubmits` off is unchanged.
   - Shift+Enter (the newline binding) is never taken by the blocked path. An Enter with
     `isComposing` true is left to the IME (not taken). An IME-commit Enter with `isComposing` false
     (Safari fires `compositionend` before it, reported as keyCode 229 or `Process`) is detected by
     the shared `isShortcutEventNoise` predicate and is swallowed silently on every path: blocked,
     unblocked, rebound, or otherwise. It never submits, shows the blocked notice, or inserts a
     newline. Key repeat keeps its existing behavior.
   - **Known follow-up (not fixed):** reverse-delivery Ctrl+Enter with the default binding still
     inserts a newline while a model reason is shown. Only a rebound send key is covered by the
     blocked path (UMS-09).
7. **One owner.** `resolveComposerSubmitBlockReason`
   (`packages/ui/src/v4/composer/composerSubmitBlockReason.ts`) derives the reason. The composer
   passes `selectionIssue` and the settled flag into it at both call sites (the render-state Send
   barrier and `submit()`), so they cannot disagree.

## Owners and event order

- Host: `ModelSelectionView` (`resolveEffectiveModelSelection`) owns the verdict.
- Root: writes the per-window settled flag from provider startup state.
- `useDraftConfigControl` owns the draft intent and derives `draftConfig.modelSelection` (undefined
  when unresolved), so the toolbar keeps showing "Choose model".
- `ConversationComposer` derives the reason and renders it. It does not write the selection.
- `LexicalChatInput` only reports the send key through `onSubmitBlocked`.

## Acceptance

| ID     | Action                                                              | Must observe                                                                                                                 |
| ------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| UMS-01 | Existing session, stored provider not signed in; type "x"           | Inline line under the editor: "Selected model is unavailable — choose a model."; Send stays disabled                         |
| UMS-02 | Same as UMS-01, press Enter                                         | No newline is inserted; the text stays; the same copy appears as a toast; nothing is sent; the stored selection is unchanged |
| UMS-03 | Stored account connection missing; type "x"                         | Inline line shows the sign-in copy, not the model copy                                                                       |
| UMS-04 | Same as UMS-01, but before startup has settled (cold start)         | The generic "session isn't ready" reason shows, not the model copy; no model-specific Enter path                             |
| UMS-05 | UMS-01 while a first submission is delivering                       | The in-flight barrier copy shows, not the model copy                                                                         |
| UMS-06 | Choose a resolvable model from the toolbar; press Enter             | The message sends with the chosen model; the inline reason disappears                                                        |
| UMS-07 | New task with no model chosen; press Enter                          | Generic "The session isn't ready yet" text (unchanged)                                                                       |
| UMS-08 | Stored model unavailable while the remote host is disconnected      | The remote-unavailable reason is shown, not the model reason                                                                 |
| UMS-09 | UMS-01 with a rebound Ctrl+Enter send; press Ctrl+Enter, then Enter | Ctrl+Enter behaves like UMS-02; plain Enter inserts a newline as it does for any unbound key                                 |
| UMS-10 | UMS-01 with an empty draft; press Enter                             | Nothing happens: no newline, no notice (see decision 6)                                                                      |

## Validation

- `packages/ui/test/composerSubmitBlockReason.test.ts`: the provider and model verdicts yield
  `modelUnavailable`; the account verdict yields `modelAccountUnavailable`; the remote reason takes
  precedence; an unsettled startup keeps `sessionNotReady`; in-flight barriers are not hidden;
  `selection-missing` and reasoning-level issues keep `sessionNotReady`; a ready state returns null.
- `packages/ui/test/lexicalKeyboardBlockedSend.test.ts`: a real Lexical editor with the real
  `KeyboardPlugin`, dispatching `KEY_ENTER_COMMAND`. The default binding and a rebound Ctrl+Enter
  both keep the draft and call `onSubmitBlocked`; plain Enter with a rebound send inserts a newline;
  a blocked Enter without a named reason keeps the newline; mobile `enterSubmits` off is unchanged;
  an unblocked Enter still submits.
- `packages/ui/test/v4ConversationComposerPromptHistory.test.ts` (mounted composer with the editor
  mocked): UMS-01 and UMS-02 (inline line, Enter callback), UMS-03 (account copy), UMS-04 (no inline
  line before settled, no Enter path).
- `packages/ui/test/i18nCatalogParity.test.ts`: `composer.sendBlocked.modelUnavailable` and
  `composer.sendBlocked.modelAccountUnavailable` exist in en-US, zh-CN and uk-UA.
- Not covered by a test: UMS-05, UMS-08 in a mounted or E2E run, and the cold-start settle
  transition in Root.
- Open: UMS-01, UMS-02, UMS-09 and UMS-10 still need desktop E2E coverage; the run record is to be
  added then.
