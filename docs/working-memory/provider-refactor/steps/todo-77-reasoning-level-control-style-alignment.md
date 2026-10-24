# Todo77: Align the Reasoning-level Control Styling

> Verification ownership update (2026-09-09): remaining untested/failed/manual-promotion items are transferred to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence remains, and transfer does not mean a test passed. Desktop graphical E2E was also consolidated under Todo78.

> Decision correction (2026-09-07): the statement below that no external Reasoning container would be added does not represent the latest product requirement. Two titled containers, "Reasoning settings" and "Advanced settings", were already approved. Todo88/R13 handles the omission; the control sizing and centering requirements in this Todo remain valid.

> Status: Complete (UI unit tests, typecheck and lint passed; Desktop graphical E2E still needs rerun on Mac).
>
> Date: 2026-09-04
>
> Relationship: visual closeout for the model-settings-page UI polish in Todo75.

## Problem

Model-capability options use the shared `Button` with `outline + lg`; reasoning levels used a custom `div` and native `button`, so they differed in height, corner radius, background and text alignment:

```text
Model capability option: h-8 / rounded-lg / shared Outline / centered layout
Reasoning level:         h-7 / rounded-md / bg-surface / native button default layout
```

An external container was not the cause: the reasoning-level control did not reuse the shared button's sizing/alignment rules, so it looked smaller and used a different color in the same dialog, and its static text lacked explicit horizontal and vertical centering.

## Goals

- Match the height, corner radius, default border and background hierarchy of model-capability options.
- Center non-editing reasoning-level text horizontally and vertically; no height jump between editing, static and add-button states.
- Preserve drag, click-to-edit, delete, keyboard interaction, order and Personal Override border semantics.
- Do not turn levels into checkboxes or change Reasoning values, Mapping, persistence or runtime behavior.

## Implementation boundaries

1. Prefer the shared `Button` sizing/color rules; do not copy a second button system into the Reasoning Editor.
2. The hover-delete button stays inside the level shell; if the full `Button` cannot be used, extract/reuse only the necessary `buttonVariants` without changing DOM interaction responsibilities.
3. Static text buttons use `inline-flex items-center justify-center`; edit inputs keep the same height and size to content within existing min/max widths.
4. The add button has the same height as the level shell; focus, hover, drag and disabled states use design-system semantic colors.
5. No external Reasoning container; no change to Mapping, MFJS or Footer layout.

## Verification

Unit tests for `ProviderModelReasoningLevelEditor` first (static centering, shared dimensions, edit-state dimensions, delete-button interaction); model-settings UI E2E verifies visible structure, actual matching dimensions and editing/dragging without binding to unnecessary class names; check zh/en, light/dark and narrow windows; run relevant UI tests, `pnpm typecheck`, `pnpm lint`. Desktop graphical E2E still needs a Mac rerun.
