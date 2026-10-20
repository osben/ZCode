# UI upstream sync: ledger (extra bucket, UI-2 and routed compile errors)

Scope: packages/ui typecheck errors that sit outside the 319-file re-apply manifest (`/private/tmp/claude-501/ui1/manifest.json`).
Branch: `claude/ui-port-extra` (from `claude/upstream-sync-ui-1`). Not pushed.

## Fixed in this bucket

- `packages/ui/src/workspace-config-catalog/useConfigWorkspaceServices.ts`: `sourceServerWorkspaceService` is optional on `IServiceAccessor`; the binding now stays unset (config RPC closed) when a Source does not register it, instead of skipping alias admission.
- `packages/ui/src/v4/conversationShareItems.ts`: share navigator items carry `isPinned` (upstream navigator item shape); derived from pinned assistant text rows, matching the navigator helper.
- `packages/ui/src/v4/ConversationShareContent.tsx`: `workflowCardDetail` takes the intl instance (fork helper signature), not a bound `formatMessage`.

## UI-2 (old sidebar, grouped-task store replaced by project-sidebar)

- `packages/ui/src/workspace-grouped-tasks/view.ts`: imports `GroupedDraftTaskPlacement` from `store/zcodeSessionStoreTypes.ts`, which upstream removed. Reached only through `workspace-grouped-tasks/shared.tsx`, which is imported by the old `task-item.tsx`, `group-item.tsx`, `sticky-group-header.tsx` (old list: `virtualized-top-level-list.tsx`, `virtualized-group-task-list.tsx`). The live sidebar is `project-sidebar/` (`TaskGroupedView`, `grouped/*`). Test `packages/ui/test/useGroupedTaskView.test.ts` and `packages/ui/test/workspaceGroupedTasksVirtualization.test.ts` cover this chain. Suggested: drop the chain with the old sidebar; do not restore the type for it.

## Routed to manifest owners (not edited here)

Each error below comes from a manifest file that another bucket is re-applying. The non-manifest consumer is listed for context.

- Composer worktree recovery (17 errors): `v4/composer/composerDraftStore.ts` (manifest) lacks `V4ComposerRecoveryContexts`, `V4_WORKTREE_RECOVERY_PENDING_SCOPE`, `getV4WorktreeRecoveryScope`, `moveV4ComposerDraft`, `readV4WorktreeRecoveryDrafts`, `subscribeV4ComposerDrafts`, `getV4ComposerDraftVersion`, and the `V4ComposerDraft` fields `recoveryAttachments`, `recoveryContexts`, `worktreeIntent`. Consumers: `v4/composer/composerRecoveryContexts.ts`, `composerWorktreeFailureReturn.ts`, `ComposerWorktreeRecovery.tsx`. A new module would duplicate draft-store state, so not done.
- Telemetry (4 errors): `lib/messageTelemetry.ts` (manifest) lacks `discardSubagentToolUsageSession`, `buildSubagentUsageSessionKey` and the `usageSessionKey` field. Consumer: `v4/telemetry/conversationTelemetrySupervisor.ts`.
- Session data (1 error): `v4/conversationProjectionStore.ts` (manifest) constructor takes 3 args; the fork's `sessionDataLayer.ts` passes a 4th (session-gone callback).
- Pane request type (1 error): `lib/workspaceSidePane.ts` (manifest) `OpenScopedPlanDetailSideTabRequest` lacks `rootSessionId`. Consumer: `app-shell/SelectionSideChatPane.tsx`.
- Task deletion (1 error): `lib/taskListMetaSync.ts` (manifest) lacks `removeTaskFromTaskCaches`. Consumer: `task-deletion/taskDeletion.ts`.
- Task list context menu (1 error): `TaskActionMenuContent.tsx` (manifest) lacks the `onDeleteTask` / `deleteDisabledReason` props. Consumer: `TaskListItemContextMenu.tsx`.
- Memory settings (1 error): `settings/MemorySettingsViewer.tsx` (manifest) prop shape. Consumer: `settings/MemorySettingsSection.tsx`.
- Dependencies (1 error, `components/ai-elements/message.tsx`): `packages/ui/package.json` (manifest) lost the fork pins `@streamdown/code ^2.0.0` and `shiki ^4.5.0` (upstream has `^1.1.1` and `^4.0.2`). Installed `@streamdown/code` 1.1.1 has a `code.highlight` type mismatch with the streamdown plugin config.
- Manifest-only errors (not in this bucket): `TaskListItem.tsx`, `SettingsPage.tsx`, `settings/settingsPageConfig.ts` (theme `zai-dark`/`zai-light`), `settings/HooksSection.tsx`, `settings/model-provider-section/ProviderTemplatePicker.tsx`, `App.tsx`, `app-shell/AnimatedSidePanePanel.tsx`, `app-shell/WorkspaceShellLayout.tsx`.
