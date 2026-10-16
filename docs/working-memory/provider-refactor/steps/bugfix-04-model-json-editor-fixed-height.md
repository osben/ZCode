# Bugfix 04: Model JSON Editor Fixed Height

> Status: Completed

## Problem

The reasoning tier Option Spec and Reasoning Mapping in the Model Config popup use multi-line JSON text.
The shared `Textarea` defaults to `field-sizing-content`, so when the Personal value is empty and the
Effective JSON is shown as a placeholder, the input box automatically grows taller with the multi-line
placeholder. The longer the Mapping, the more it stretches the popup content, and also makes the JSON
look like plain text scattered on the page.

## Target Behavior

- The three JSON config items continue to use the native editable `Textarea`; do not introduce a second JSON state or editor dependency;
- The JSON text box uses a uniform fixed height, and does not change with the number of lines in the value or placeholder;
- The JSON exceeding the height scrolls vertically within the text box; the popup itself only handles scrolling between fields;
- When the Personal value is empty, the Effective JSON is still shown only as a placeholder, without being written to the Personal Overlay;
- Maintain the monospace font, JSON highlighting, keyboard editing, theme, and desktop/Web shared behavior.

## Root Cause and Fix

The root cause is not the Config or Overlay, but the `JsonSlotEditor` only sets the minimum height and the draggable resize, without overriding the shared
`Textarea`'s content-adaptive size.

The fix is completed within the visual boundary of the `JsonSlotEditor`: overridden to `field-sizing-fixed`, using a fixed height, disabling the manual
resize, and enabling the internal scrolling. Do not modify the JSON parsing, Draft, Effective Preview, or the save semantics.

## Acceptance

- The long JSON value and the long Effective placeholder do not change the text box height;
- The three JSON text boxes have the same height;
- The text box has a clear input boundary, and the content can scroll internally when it overflows;
- The save and restore-default behavior remain unchanged;
- The UI unit test, the typecheck, and the lint pass.

## Implementation Result

- The `JsonSlotEditor` uniformly uses a fixed height and the internal vertical scrolling; the long value/placeholder no longer stretches the popup;
- The three JSON fields continue to reuse the same editor; the sparse Personal Overlay, Effective placeholder, and restore-default semantics are not changed;
- The targeted test explicitly asserts the `field-sizing-fixed`, the fixed height, and the `resize-none`; the corresponding implementation commit is `39cb217ca3`.
