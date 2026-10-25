# Composer picker focus restore

## Contract

After closing a composer toolbar picker (mode/Plan switch, model picker, thought level), keyboard
focus returns to the text input of the composer instance that owns the picker — never to whichever
composer happens to appear first in the document.

- Scoping: the picker resolves its own composer root via `closest('[data-testid="v4-composer"]')`
  from the picker trigger element, then focuses `[data-testid="v4-composer-input"]` inside that
  root. Shared helper: `restoreComposerInputFocusAfterPickerClose`
  (`packages/ui/src/lib/pickerFocus.ts`).
- Fallback: when the trigger is not mounted inside a `v4-composer` root, the pre-existing global
  selector passed by the caller is used.
- `restoreFocusSelector` / `focusSelectorOnClose = null` (settings views, automation dialogs) keeps
  Radix's default behavior: focus returns to the picker trigger.
- Coarse-touch devices skip focus restore entirely so closing a picker does not reopen the on-screen
  keyboard.

## Why

Side conversations (SelectionSideChat panes) and workbench split panes mount several
`ConversationComposer` instances in one document, and all of them share the same input testid. A
global `document.querySelector` lookup always matched the first composer in DOM order (the main
pane), so switching to Plan mode inside a side conversation threw focus into the main composer.

## Acceptance scenarios

- Selecting Plan (or any mode, model, or thought-level entry) in a side conversation keeps focus in
  the side conversation's composer input.
- The same holds for the main composer and every workbench split pane: focus stays in the pane where
  the picker was opened.
- Settings and automation pickers keep Radix's default trigger-focus behavior.
- On coarse-touch devices no focus restore happens after a picker closes.

Regression coverage: `packages/ui/test/pickerFocus.test.ts`.

The shared `ConfigSelect` uses the same scoped restore path when its caller supplies a composer
trigger ref; its settings/automation null-selector behavior is unchanged. Coverage includes a close
handler with a side-composer trigger and a different global input.
