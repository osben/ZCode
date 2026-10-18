# UI accidental-action guards

Status: implemented (2026-10-17).

## Problem

An interface review found four places where one stray keystroke or click runs an action the user did not choose, or throws away what they typed:

1. `ConfirmDialogHost` confirms on every Enter, including Enter on a focused Cancel or Close button. A keyboard user who tabs to Cancel and presses Enter runs the destructive action.
2. `PermissionDialog` answers immediately when the user presses `1`/`2`/`3`. The dialog autofocuses its first option when it appears, often while the user is still typing in the composer, so a typed digit can approve a tool call or create an "always allow" rule.
3. Inline edit of a sent user message (`ConversationRowView` editing branch) returns nothing from `onSubmit`, which Lexical reads as "accepted" and clears the editor right away. When the edit then fails or is blocked by a file conflict, the text is gone, and the conflict dialog's "Conversation only" action resubmits an empty draft (a no-op).
4. In the grouped sidebar view, the hover X button is labelled "Close" but archives the task immediately. Project and Pinned rows archive through a two-step inline confirmation.

## Decisions

1. **ConfirmDialog: focused controls own Enter.** The window-level Enter handler only confirms when focus is not on an interactive control (`button`, `input`, `textarea`, `select`, `[role=checkbox]`, contenteditable) inside the dialog. Enter on a focused button activates that button natively: Confirm confirms (it is autofocused, so the default "Enter confirms" path is unchanged), and Cancel or Close cancels. This generalizes the existing checkbox-dialog exception to every dialog.
2. **PermissionDialog: digit keys select, Enter/Confirm answers.** Pressing `1`–`3` on an option moves selection and focus to that option and does not answer. Enter or the Confirm button answers as before. This matches how the feedback-row digit already behaves (focus only, never submit), so every digit has the same meaning. Arrow keys, Tab, Enter and the feedback-row rules from `docs/permission-project-approval.md` are unchanged.
3. **Inline edit keeps the draft until the edit is accepted.** The editing `onSubmit` returns `false`, so Lexical never resets the editor on Enter. The editor closes only when `onEdit` succeeds (existing `setEditing(false)` path). A failed ACK or a blocked rewind leaves the text in the editor and in `draft`, so "Conversation only" resubmits the real text. The submit button and Enter now behave the same way.
4. **Grouped row: Archive with inline confirmation.** The hover action is labelled `taskList.archive` and uses the Archive icon (CloudUpload for remote tasks, matching `TaskListItem`). The first click switches the button to a destructive "Confirm" button. A second click archives through the existing `onCloseTask` path. Escape or a pointer-down outside the row cancels. While confirming, the hover action cluster stays mounted. The confirmation state is local to the row, since only one row can receive a pointer-down at a time and an outside pointer-down cancels the previous one. The context-menu "Archive" item is an explicit menu choice and stays single-step, as in the other lists.

## Owners and event order

- ConfirmDialog: the store (`confirmDialogStore`) stays the single owner of the pending request. Only the key-routing rule changes.
- PermissionDialog: the response is still sent only through `respondWithOption` / `confirmSelection`.
- Inline edit: `ConversationRowView` owns `editing` and `draft`. Lexical's reset decision follows `LexicalSubmitResult` (`false` = keep).
- Grouped row: `GroupedTaskRow` owns the `archiveConfirming` flag. `WorkspaceGroupedTasksSection.handleCloseTask` stays the only archive path.

## Validation

- `packages/ui/test/confirmDialogEnterRouting.test.ts`: Enter on Cancel cancels, Enter on Confirm confirms once, and Enter on non-interactive dialog content confirms.
- `packages/ui/test/permissionDialogFocus.test.ts`: a digit selects and focuses an option without answering; Enter then answers with that option.
- `packages/ui/test/v4ConversationRowViewUserEdit.test.ts`: the edit `onSubmit` returns `false`; after a failed ACK the editor stays open; the conflict "Conversation only" action resubmits the typed draft.
- `packages/ui/test/groupedTaskRowArchiveConfirm.test.ts`: the first click does not archive, the second click archives once, and Escape or an outside pointer-down cancels.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.

These are jsdom interaction tests with real DOM events. No new Electron E2E scenario was added, because these paths need a live permission prompt or a seeded grouped sidebar fixture.
