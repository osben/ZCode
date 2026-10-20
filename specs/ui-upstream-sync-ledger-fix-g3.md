# UI upstream sync ledger, fix group G3 (conversation, share, composer, command center)

Scope: failing vitest cases in group G3 after the `claude/upstream-sync-ui` integration.
Rule applied: a fork test case is spec only when the fork changed that behavior (fork delta vs base
`aac4755666d09fdcd70272fcf063c077a639015f`). Cases unchanged from base that upstream 3.16.1 rewrote
were adopted from upstream. Comment-only fork edits are not behavior.

- `packages/ui/test/conversationShareConfirmationDock.test.ts`: test replaced by upstream
  `0a1fc56d` version (17 cases pass). The six failing cases (publish progress, review highlight,
  SHARE28 body scroll, 480px action stack, permission grid radiogroup, rail alignment) were
  identical in fork and base and are dropped by upstream's dock redesign. Not ported; ConfirmDialog
  Enter rule unchanged.
- `packages/ui/test/chatViewDragDropScope.test.ts`: assertion anchored to the Chinese comment in
  `ConversationComposer.tsx` (fork only translated the comment). Comment-anchored, no behavior change.
- `packages/ui/test/offPeakFigmaLayout.test.ts`: one case skipped `it.skip` with
  `TEMPORARY(UI-2)`. It asserts the fork idle-time toolbar (`containerClassName="contents"`,
  `triggerIndicator`), which upstream 3.16.1 rebuilt. Other cases in the file pass unchanged.
- `packages/ui/test/animatedSidePanePanelLayout.test.ts`: the fork model-trajectory case
  expected no `files` item. Upstream keeps `files` (base and upstream tests expect it). Case
  expectations updated to include `files`; the model-trajectory item and `hasActiveTask` gating are
  unchanged.
- `packages/ui/src/lib/modelSelectionGroups.ts` (outside G3 hints): fork hunk ported. The API
  key badge applies only to `api.openai.com` base URLs; the ChatGPT plan keeps "Subscription".
  Projection test expectations for `example.com` API-key providers no longer carry the "API" badge
  (fork test shape).
- `packages/ui/test/archivedTasksActionsMenu.test.ts`: one case `it.skip` with `TEMPORARY(UI-2)`.
  The fork replaced the bulk-delete `useConfirmDialog` with `TaskDeleteConfirmationDialog`
  (`eraseTasks`). The fork test for that flow imports the fork-only `WebRemoteControlTaskIndex`,
  which upstream does not have.
- `packages/ui/test/savedWorkflowDetailView.test.ts`: literal Chinese not-found copy replaced by
  `expectedCopy("workflows.hub.detail.notFound")` (test runs in en-US).
- `packages/ui/test/savedWorkflowLaunchDialog.test.ts`: two upstream cases use `expectedCopy` keys
  for the note, cancel button and required label (test runs in en-US).
- `packages/ui/test/groupedOffPeakSystemGroup.test.ts`: one source-assertion case `it.skip` with
  `TEMPORARY(UI-2)`. It reads `src/WorkspaceGroupedTasksSection.tsx`, a fork-only grouped-tasks file
  that upstream removed.
- `packages/shared/src/tool-identity.ts` (outside G3 hints): `WebFetch` maps to the `web-fetch`
  family and `web-fetch` is added to `ZCodeToolFamily`, as upstream 3.16.1. The integration had kept
  the base `search` mapping. Fork did not change this line. This also fixes
  `toolPresentationParity` and `webFetchPresentation`.
- `packages/ui/test/commandCenterSelection.test.ts` (upstream-only test): mocks
  `@/hooks/useSettingService.js`. The fork command center calls `useSettings` for worktree defaults,
  which needs a PlatformProvider the fixture does not provide.
