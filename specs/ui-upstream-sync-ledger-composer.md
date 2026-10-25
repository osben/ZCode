# UI upstream sync 3.16.1: composer ledger

Scope: re-applying fork composer changes onto upstream 3.16.1 for
`packages/ui/src/v4/ConversationComposer.tsx` and `packages/ui/src/v4/composer/composerDraftStore.ts`,
plus the composer i18n keys they need. Base `aac47556`, target `0a1fc56d`, fork ours `9c2434f7`.
The tree was intentionally red until the other UI buckets merged.

## Ported

- `composerDraftStore.ts`
  - `V4ComposerRecoveryContexts` type and `V4ComposerDraft` fields `recoveryAttachments`,
    `recoveryContexts`, `worktreeIntent`, `initializeFromNewTask`.
  - `readDraft` keeps a draft with empty text when it carries recovery attachments or contexts
    (upstream drops every blank draft); `persistV4ComposerDraft` keeps a recovery-only record (same
    rule), so a failed worktree submission does not lose its attachments or contexts.
  - `readRecoveryContexts` / `hasRecoveryContexts` validation.
  - `writeDraftFile` dispatches the in-tab change event; `subscribeV4ComposerDrafts` and
    `getV4ComposerDraftVersion` expose it to `useSyncExternalStore`.
  - `V4_WORKTREE_RECOVERY_PENDING_SCOPE`, `getV4WorktreeRecoveryScope`,
    `readV4WorktreeRecoveryDrafts` (fork key layout, workspace-keyed).
  - `moveV4ComposerDraft` (fork signature: workspace key, not project scope).
- `ConversationComposer.tsx`
  - Props: `onPrepareWorktreeSession`, `onSyncWorktreePreparation`, `onWorktreePreparationFailed`,
    `onResumeError`, `voiceDictationEnabled`.
  - Send options: `reuploadAttachmentsForSession`, `executionWorktree`, `preparedSessionId`,
    `preparedAttemptId`, `incognito`.
  - External insert mode `prepend-text` (`zcode://task/new` keeps unsent text).
  - Submission owner: `renderedOwnerRef` epoch, `composerAliveRef`, `reservingWorktreeRef`,
    `queuedSubmissionIdRef`, `draftPersistClaimRef`, `updateComposerContentRef`.
  - Worktree queue: `worktreeQueued` state, pipeline selectors, the three queued-send effects
    (adopt from the module registry, navigated-away release, unmount release) and the draft-branch
    text reset effect.
  - `submit` is the fork skeleton (runSend closure, queue-time claim, frozen recovery records,
    draft branch intent guard, incognito capture/release, worktree consume) merged with upstream
    settlement: `settleSubmittedContent`, `subscribeToCommandResolution` (pendingCommandRegistry),
    `trackUnsettledComposerSubmission` on restore, `remoteAvailable` and `runtimeBlocked` guards,
    `submittedDraftText`, `onCommandCreated`.
  - Post-submit: `applyWorktreeRecoveryDraft`, frozen worktree-intent hydration effect, failure-return
    store restore and submit effects.
  - Share context: `restoredShareContext` and `activeShareContextId` (replaces `pendingShareContext`
    in the send gate and deps).
  - Voice: `voicePreview` ghost state, `voiceScopeRef`, `insertVoiceTranscript`,
    `V4ComposerDictationControl` before the send button, `voicePreview` on `ChatPromptEditor`.
  - Incognito: `V4ComposerIncognitoControl` in the context row, incognito shell border class on the
    editor.
  - `ComposerWorktreeRecovery` panel below the editor.
  - Send spinner shows while `worktreeQueued`; `canSend` requires `!worktreeQueued`.
  - Progress overlay text class `text-[7px]` changed to `text-ui-xs` (fork).
  - `handleEditorChange` clears `suppressDraftPersistRef` (fork).
- `packages/ui/src/i18n/locales/en-US.ts`, `zh-CN.ts`: contiguous block after the object header with
  `composerRecovery.*`, `chat.incognito.*`, `worktreeFailure.*` (13 + 10 keys). `uk-UA.ts` already
  had all of them.

## Deliberate deviations

- `useOptionalWorkspaceServicesResolution` is a fork-only export of
  `hooks/useWorkspaceServices.tsx`, not in upstream. The composer uses
  `useOptionalBaseWorkspaceServices()`. For remote targets, branch-intent git calls run on base
  services, not the remote-routed services the fork picked. Restore the fork hook if remote
  branch-intent parity is required.
- Settlement: the success path runs `settleSubmittedContent` (upstream semantics). The
  command-resolution (ACK lost) path settles content but does not release the incognito intent or
  consume the pipeline entry; only the synchronous success path does those.
- Draft scope: upstream's `draftScopeId` (project-scoped `__draft__:<root>`) is kept. The fork's
  `sessionId ?? V4_DRAFT_SCOPE_ROOT` appears only in the `ComposerWorktreeRecovery` `scopeId` prop.
  Confirm the recovery panel reads the same scope the project-scoped draft writes to.
- `composerPlanTransition.ts` (fork `v4/composer` helper) is not restored; nothing in the upstream
  composer imports it. Its test `packages/ui/test/composerPlanTransition.test.ts` fails on the
  missing module.

## Contracts needed from other files

- `SessionPane.tsx` (or the owning shell) must pass `onPrepareWorktreeSession`,
  `onSyncWorktreePreparation`, `onWorktreePreparationFailed`, `onResumeError` and
  `voiceDictationEnabled` to `ConversationComposer`. Without them the worktree send path is inert and
  voice input is hidden.
- `ConversationWorktreeSetupSteps.tsx` (other bucket) must exist with its `Retry` surface and
  `worktreeSetup.*` keys. Two `composerWorktreePipeline` tests need the card's Retry button.
- `useDraftConfigControl.ts` (other bucket) must read `initializeFromNewTask` from
  `V4ComposerDraft`. Two `useDraftConfigControl` hydration tests fail.
- Catalogs: `commandCenter.worktree.error.*` keys are needed by `composerWorktreePipeline`,
  `worktreeCreationFailureReason`, `commandCenter*` and `worktreeSetupI18n` tests (another bucket).
- `ChatEmptyState` (`@/ChatEmptyState.js`) is needed by `chatEmptyWorktreeTaskToggle.test.ts`
  (another bucket).
- `hooks/useWorkspaceServices.tsx`: optional `useOptionalWorkspaceServicesResolution`
  (see deviations).

## Verification

`tsc -p packages/ui`: 29 errors, all in files outside this bucket; none in `ConversationComposer.tsx`,
`composerDraftStore.ts`, the composer helpers or the locale files. `oxlint` on the two ported files:
0 warnings, 0 errors; `oxfmt` applied. Composer, worktree and draft vitest files (87): 77 pass; the
10 failing files are the contracts above plus the fork-only `composerPlanTransition` module.

Full history: git show 5df10a43f18201fe2dcfb1c8e1ccea240f50a0ef:specs/ui-upstream-sync-ledger-composer.md
