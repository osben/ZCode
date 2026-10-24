# Secondary confirmation dialog primary button

## Background

Secondary confirmation dialogs protect user actions about to run. Different business units used to render the
confirm button as primary, warning or destructive, so a semantically identical "confirm and continue" button
changed color between dialogs.

## Specification

- The confirm button in a secondary confirmation dialog always uses the primary button style.
- The cancel button keeps the secondary button style, keeping the action hierarchy clear.
- Risk semantics such as delete, stop, leave or refresh broken links are expressed through title,
  description and button text, not through confirm-button color.
- `ConfirmDialogRequest` provides no button color or variant configuration; callers must not override the
  confirm button style through dialog requests.
- Confirmation dialogs that use `AlertDialogAction` independently also keep the confirm button primary, unless
  a future design spec explicitly introduces a new confirm-button semantic level.

## Impact scope

- The global `ConfirmDialogHost` confirm button.
- Independent `AlertDialogAction` used by business-specific confirmation dialogs.
