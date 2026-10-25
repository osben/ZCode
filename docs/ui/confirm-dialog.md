# Confirm Dialog

## Goal

- Provide `packages/ui` with a globally reusable confirm dialog.
- It first covers two high-risk operations: deleting a task and removing a project.

## Implementation

- `packages/ui/src/store/confirmDialogStore.ts` manages a singleton confirmation request with Zustand; callers wait for the result through a Promise.
- `packages/ui/src/ConfirmDialog.tsx` renders the dialog, with layout and button area aligned to the `z-work` confirm dialog style.
- `packages/ui/src/Root.tsx` mounts `ConfirmDialogHost` at the root, so desktop, web, local and remote all use the same UI logic.

## Integration points

- `packages/ui/src/TaskList.tsx` shows the confirmation before deleting a task.
- `packages/ui/src/WorkspaceSidebar.tsx` shows the confirmation before removing a project.

## Interaction constraints

- `Esc` cancels, `Enter` confirms.
- Closing a project only removes the sidebar entry and does not affect files on disk.
