# Bugfix 04: Model JSON Editor Fixed Height

> Status: Completed
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/bugfix-04-model-json-editor-fixed-height.md`

## Problem and Cause

The reasoning tier Option Spec and Reasoning Mapping in the Model Config popup are multi-line JSON text. The shared
`Textarea` defaults to `field-sizing-content`, so an empty Personal value with the Effective JSON shown as a
placeholder grew the box with the placeholder's line count and stretched the popup. The cause is in
`JsonSlotEditor` (it set only a minimum height and a draggable resize), not in Config or Overlay.

## Rules

1. The three JSON config items keep the native editable `Textarea`; no second JSON state or editor dependency.
2. `JsonSlotEditor` overrides to `field-sizing-fixed` with one uniform fixed height and `resize-none`; overflow
   scrolls vertically inside the text box and the popup only scrolls between fields.
3. With an empty Personal value the Effective JSON stays a placeholder and is never written to the Personal Overlay.
4. Monospace font, JSON highlighting, keyboard editing, theme and Desktop/Web behavior are unchanged; JSON parsing,
   Draft, Effective Preview, save and restore-default semantics are unchanged.

## Acceptance

Long values and long Effective placeholders do not change the height; all three boxes have the same height; the box
has a clear boundary and scrolls internally on overflow. The targeted test asserts `field-sizing-fixed`, the fixed
height and `resize-none` (implementation commit `39cb217ca3`).
