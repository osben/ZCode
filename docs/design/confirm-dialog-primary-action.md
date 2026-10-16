# Secondary Confirmation Dialog Primary Button Specification

## Background

Secondary confirmation dialogs protect user actions about to be executed. Previously, different business units rendered confirmation buttons as primary, warning, or destructive, causing "confirm and continue" buttons to jump between colors across dialogs even when semantically identical.

## Specification

- Confirmation buttons in secondary confirmation dialogs uniformly use the primary button style.
- Cancellation buttons continue to use the secondary button style, keeping the operation hierarchy clear.
- Risk semantics such as delete, stop, leave, or refresh broken links are expressed through titles, descriptions, and button text, not distinguished by confirmation button color.
- `ConfirmDialogRequest` does not provide button color or variant configuration; callers must not override the confirmation button style through dialog requests.
- Confirmation dialogs independently using `AlertDialogAction` should also keep the confirmation button as primary, unless a future design specification explicitly introduces a new confirmation button semantic level.

## Current Impact Scope

- The global `ConfirmDialogHost` confirmation button.
- Independent `AlertDialogAction` used by business-specific confirmation dialogs.
