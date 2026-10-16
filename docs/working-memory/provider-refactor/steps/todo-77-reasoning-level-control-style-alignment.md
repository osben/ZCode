# Todo77: Align the Reasoning-level Control Styling

> Verification ownership update (2026-09-09): remaining untested/failed/manual-promotion items are transferred to [Todo102](todo-102-verification-debt-closeout.md). This closes the separate verification schedule here; historical evidence remains, and transfer does not mean a test passed.

> Later, all outstanding Desktop graphical E2E verification was consolidated under Todo78; this Todo no longer has a separate schedule.

> Decision correction (2026-09-07): the statement below that no external Reasoning container would be added does not represent the latest product requirement. Two titled containers—“Reasoning settings” and “Advanced settings”—had already been approved. Todo88/R13 handles the omission; the control sizing and centering requirements in this Todo remain valid.

> Status: Complete (UI unit tests, typecheck, and lint passed; Desktop graphical E2E still needs rerun on Mac).
>
> Date: 2026-09-04
>
> Relationship: visual closeout for the model-settings-page UI polish in Todo75.

## Problem

Model-capability options use the shared `Button` with `outline + lg`; reasoning levels instead use a custom `div` and native `button`. They currently differ in height, corner radius, background, and text alignment:

```text
Model capability option: h-8 / rounded-lg / shared Outline / centered layout
Reasoning level:         h-7 / rounded-md / bg-surface / native button default layout
```

The issue is not caused by an external container. The reasoning-level control does not reuse the shared button's sizing/alignment rules, so it looks smaller and uses a different color in the same model-edit dialog. In non-editing state, its text also lacks explicit horizontal and vertical centering.

## Goals

- Match the height, corner radius, default border, and background hierarchy of model-capability options.
- Explicitly center non-editing reasoning-level text horizontally and vertically.
- Avoid height jumps when switching between editing, static, and add-button states.
- Preserve drag, click-to-edit, delete, keyboard interaction, order, and Personal Override border semantics for reasoning levels.
- Do not change reasoning levels into checkboxes or change Reasoning values, Mapping, persistence, or runtime behavior.

## Implementation Boundaries

1. Prefer the shared `Button` sizing/color rules; do not copy a second button system into the Reasoning Editor.
2. Continue allowing the hover-delete button inside the reasoning-level shell. If the complete `Button` cannot be used directly, extract/reuse only the necessary `buttonVariants` without changing DOM interaction responsibilities.
3. Static text buttons use `inline-flex items-center justify-center`. Keep edit inputs the same height and let them size to content within the existing min/max widths.
4. Make the add button the same height as the level shell. Keep focus, hover, drag, and disabled states on design-system semantic colors.
5. Do not add an external Reasoning container or change Mapping, MFJS, or Footer layout.

## Verification

- First add/update `ProviderModelReasoningLevelEditor` unit tests for static centering, shared dimensions, edit-state dimensions, and delete-button interaction.
- Update model-settings UI E2E to verify visible structure, actual matching dimensions, and editing/dragging behavior without binding to unnecessary internal class names.
- Verify Chinese/English, light/dark themes, and narrow-window layout.
- Run relevant UI tests, `pnpm typecheck`, and `pnpm lint`; rerun Desktop graphical E2E in a Mac environment.
