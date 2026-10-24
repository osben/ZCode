# UI accidental-action guards

Status: implemented (2026-10-17).

## Problem

An interface review found four places where one stray keystroke or click runs an action the user did not choose, or throws away what they typed:

1. `ConfirmDialogHost` confirms on every Enter, including Enter on a focused Cancel or Close button. A keyboard user who tabs to Cancel and presses Enter runs the destructive action.
2. `PermissionDialog` answers immediately when the user presses `1`/`2`/`3`. The dialog autofocuses its first option when it appears, often while the user is still typing in the composer, so a typed digit can approve a tool call or create an "always allow" rule.
3. Inline edit of a sent user message (`ConversationRowView` editing branch) returns nothing from `onSubmit`, which Lexical reads as "accepted" and clears the editor right away. When the edit then fails or is blocked by a file conflict, the text is gone, and the conflict dialog's "Conversation only" action resubmits an empty draft (a no-op).
4. In the grouped sidebar view, the hover X button is labelled "Close" but archives the task immediately. Project and Pinned rows archive through a two-step inline confirmation.

## Decisions

1. **ConfirmDialog: focused controls own Enter.** The window-level Enter handler only confirms when focus is not on an interactive control (`button`, `input`, `textarea`, `select`, `[role=checkbox]`, contenteditable) inside the dialog. Enter on a focused button activates that button natively: Confirm confirms (it is autofocused, so the default "Enter confirms" path is unchanged), Cancel settles the request as `"cancel"`, and Close dismisses it (`"dismiss"`, the same as Escape or an overlay click), so `requestChoice` callers keep the distinction. This generalizes the existing checkbox-dialog exception to every dialog.
2. **PermissionDialog: digit keys select, Enter/Confirm answers.** Pressing the digit shown in an option's label (`1`–`N` for `N` permission options, including the Deny row) moves selection and focus to that option and does not answer (ISSUE-057: Deny was labelled `4.` but `4` was unbound, so `4` + Enter approved the preselected Allow). Enter or the Confirm button answers as before. This matches how the feedback-row digit already behaves (focus only, never submit), so every digit has the same meaning. Arrow keys, Tab, Enter and the feedback-row rules from `docs/permission-project-approval.md` are unchanged.
3. **Inline edit keeps the draft until the edit is accepted.** The editing `onSubmit` returns `false`, so Lexical never resets the editor on Enter. The editor closes only when `onEdit` succeeds (existing `setEditing(false)` path). A failed ACK or a blocked rewind leaves the text in the editor and in `draft`, so "Conversation only" resubmits the real text. The submit button and Enter now behave the same way.
4. **Grouped row: Archive with inline confirmation.** The hover action is labelled `taskList.archive` and uses the Archive icon (CloudUpload for remote tasks, matching `TaskListItem`). The first click switches the button to a destructive "Confirm" button. A second click archives through the existing `onCloseTask` path. Escape or a pointer-down outside the row cancels. While confirming, the hover action cluster stays mounted. When the Archive button was activated from the keyboard (it held focus), focus moves to the Confirm button so a second Enter confirms. A mouse click does not move focus. If a pending interaction hides the actions while confirming, the confirmation is cleared, so the row never comes back with an armed Confirm button. The confirmation state is local to the row, since only one row can receive a pointer-down at a time and an outside pointer-down cancels the previous one. The context-menu "Archive" item is an explicit menu choice and stays single-step, as in the other lists.

## Owners and event order

- ConfirmDialog: the store (`confirmDialogStore`) stays the single owner of the pending request. Only the key-routing rule changes.
- PermissionDialog: the response is still sent only through `respondWithOption` / `confirmSelection`.
- Inline edit: `ConversationRowView` owns `editing` and `draft`. Lexical's reset decision follows `LexicalSubmitResult` (`false` = keep).
- Grouped row: `GroupedTaskRow` owns the `archiveConfirming` flag. `WorkspaceGroupedTasksSection.handleCloseTask` stays the only archive path.

## Validation

- `packages/ui/test/confirmDialogEnterRouting.test.ts`: Enter on Cancel cancels, Enter on Confirm confirms once, and Enter on non-interactive dialog content confirms.
- `packages/ui/test/permissionDialogFocus.test.ts`: a digit selects and focuses an option without answering; Enter then answers with that option. Every numbered permission row, including Deny (`4` in the full-access layout), is reachable by its digit, and `4` + Enter denies without approving.
- `packages/ui/test/v4ConversationRowViewUserEdit.test.ts`: the edit `onSubmit` returns `false`; after a failed ACK the editor stays open; the conflict "Conversation only" action resubmits the typed draft.
- `packages/ui/test/groupedTaskRowArchiveConfirm.test.ts`: the first click does not archive, the second click archives once, and Escape or an outside pointer-down cancels. Keyboard activation moves focus to Confirm, and a pending interaction clears the armed state.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.

These are jsdom interaction tests with real DOM events. No new Electron E2E scenario was added, because these paths need a live permission prompt or a seeded grouped sidebar fixture.

## Project deletion confirmation (ISSUE-028, 2026-10-22)

### Problem

"Delete project" ran `deleteProject` at once on both entries: the project row menu (`virtual-project-delete`) and the project editor button (`virtual-project-editor-delete`). One click removed the project from the sidebar with no way back from the UI.

### Decisions

1. **Both entries confirm before the soft delete.** The row menu and the editor button open the shared confirm dialog (`useConfirmDialog`, the same store as the other project confirmations). Confirm runs `deleteProject` once with the project's original `hostId`; Cancel, Escape, or an overlay click runs nothing.
2. **Copy says what is kept.** Title "Delete project {name}?", description "Its tasks stay in Tasks.", destructive confirm button "Delete", cancel "Cancel". Tasks are not deleted, so the dialog does not warn about task loss.
3. **One request builder.** `projectDeleteConfirmRequest` (`packages/ui/src/project-sidebar/view.ts`) builds the request for both entries, so the copy and the destructive variant cannot drift apart.

### Owners and event order

- `ProjectSidebarNode` (row menu): `onDelete` awaits the confirm, then calls `service.deleteProject` and `refresh`. The confirm happens inside `runProjectAction`, as the existing add-folder confirm does, so a failure still reaches the toast.
- `ProjectEditor` (editor): `remove()` awaits the confirm before `setBusy(true)`. Cancel returns with the form, the draft, and the busy state unchanged. Confirm then runs the existing soft-delete flow (refresh, then close; failures keep the editor open).
- `confirmDialogStore` stays the single owner of the pending request; a second request while one is open is rejected by the store and does not delete.

### Acceptance scenarios

| ID     | Entry  | Action                               | Must observe                                                                         |
| ------ | ------ | ------------------------------------ | ------------------------------------------------------------------------------------ |
| PDEL-1 | Menu   | Choose "Delete project", then Delete | One `deleteProject(id, hostId)` call, then one `refresh`                             |
| PDEL-2 | Menu   | Choose "Delete project", then Cancel | No `deleteProject` and no `refresh`; the project stays in the sidebar                |
| PDEL-3 | Editor | Click "Delete project", then Delete  | One `deleteProject(id, hostId)` call; the editor closes after the refresh            |
| PDEL-4 | Editor | Click "Delete project", then Cancel  | No `deleteProject`; the editor stays open with the draft and the Save button enabled |

### Validation

- `packages/ui/test/projectSidebarNode.test.ts`: PDEL-1 and PDEL-2 (the confirm request is destructive with the project's copy, and the call happens after the confirm).
- `packages/ui/test/projectEditorRoots.test.ts`: PDEL-3 (existing delete tests now confirm first), PDEL-4 (cancel leaves the form and the project untouched).
- Desktop E2E specs under `manual-review/pending` that delete a project from either entry now click `confirm-dialog-confirm` after the delete click. They are pending and were not run.
