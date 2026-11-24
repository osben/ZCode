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

## Update confirmation in a narrow window (2026-11-19)

- The update restart confirmation declares `presentation: "update-confirmation"`. It affects only this request and
  does not change other confirm dialogs.
- The standalone update window is 512px wide. The viewport `sm` breakpoint must not turn the desktop action area
  into full-width stacked buttons.
- The update confirmation title uses `text-ui-base font-medium`, the description uses
  `text-ui-sm text-foreground-subtle`, and the body wraps naturally.
- Buttons sit in a row, right-aligned, at content width, and wrap when space runs out. They use the shared Button
  `lg` size (32px) and hide the Enter/Esc hint text.
- The surface uses `bg-popover` with no extra transparency. Buttons keep the existing primary and secondary theme
  tokens.
- Enter to confirm, Escape to cancel, the active-task check and the update-after-confirm path are unchanged.
- Acceptance covers 512px, 390px and a wide window, Zai Light/Dark, Chinese and English, and checks that the
  default confirm dialog is not affected.

Browser acceptance entry: `node --test packages/ui/test/browser/manual-review/pending/update-confirmation.test.mjs`.
It uses the real `ConfirmDialogHost`, theme and i18n. 12 groups pass. They check the button row, the 32px height,
the 16px side margin, the text hierarchy, that the default confirm dialog is unchanged, and Enter/Escape settling.
Screenshots are in `packages/desktop/.e2e-artifacts/update-confirmation-browser/`. The real update install is not
called, so this is not acceptance of the native window or the install chain.

## Interaction constraints

- `Esc` cancels, `Enter` confirms.
- Closing a project only removes the sidebar entry and does not affect files on disk.
