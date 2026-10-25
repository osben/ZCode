# Todo 31: Model Config Popup Input Control Consolidation

> Status: Completed
>
> Date: 2026-08-27
>
> Source: Provider settings page real experience feedback
>
> Related tasks: [`Todo 27`](./todo-27-provider-settings-dogfood-closeout.md),
> [`Todo 29`](./todo-29-model-config-resolution-and-idle-trigger-closure.md)

## 1. Problem

Model config popup JSON fields first used an outer field card plus an inner `Textarea` (double borders); after
removing the outer cards the shared `Textarea`'s weak background and stroke were nearly invisible in the dark popup.
Technical inputs also inherited the browser's natural-language spell check (red dashed lines under Model ID in
macOS/Electron). Model ID, context window and max output Token inputs treated any Enter as save, including the Enter
that confirms a Chinese IME candidate:

```text
IME composing -> Enter -> candidate text committed + onCommit() -> popup unexpectedly saves
```

## 2. JSON single-layer text box

Each JSON field keeps one layer: field title plus a `Textarea` (the sole background and stroke).

- No cards, extra background or second-layer stroke.
- Background, stroke and Focus state match normal text boxes; the Checkbox Personal Override emphasis style is not
  used.
- No Personal value: Effective JSON is the placeholder; with a Personal value: normal input text.
- Fixed height; content scrolls inside the text box; not drag-resizable.
- Monospace font and JSON line wrapping stay; no new read-only Effective Preview.
- Invalid JSON reuses the normal input error state and field-level error text.

## 3. Technical input behavior

Model ID, Provider technical fields, URL, API key and JSON do not participate in natural-language assisted input:
spell check off, auto-correct and auto-capitalization off, browser auto-complete off. Password visibility, numeric
keyboard, placeholder and save semantics are unchanged.

## 4. IME-safe Enter

All "Enter means save/end editing" Provider settings inputs reuse the existing IME composition judgment:

```text
Enter
├─ composition active -> only confirmed by the input method; no preventDefault, no save, no blur
└─ ordinary keydown   -> original save or blur behavior
```

- Read both the component-maintained `compositionstart/compositionend` state and native `isComposing`.
- Model popup Model ID, context window, max output Token, and Provider name, Base URL, API key Enter-to-save entries
  all use the same helper.
- Enter in a JSON Textarea always inserts a newline and never saves.
- Explicit save button, normal Enter, blur and 1200ms idle save are unchanged.

## 5. Acceptance

1. JSON fields are still two fixed-height `Textarea`s, no outer cards, normal input styles.
2. Effective JSON as placeholder, Personal JSON as value.
3. Model ID and JSON technical inputs disable spell check and auto-correct.
4. `compositionstart -> Enter` does not call save and does not block candidate confirmation.
5. `compositionend -> normal Enter` saves once.
6. All Provider page Enter-to-save technical inputs obey the same IME boundary.
7. JSON Enter does not trigger save.
8. Chinese/English, light/dark and keyboard operation stay usable.

Not modified: Model Config Rule content, Overlay order, Registry, account plan, model runtime capabilities.

Verification: regression tests first proved the old implementation wrongly saved; Provider/Model UI directed tests
57 passed; full unit tests 12,477 passed / 25 skipped; `pnpm typecheck` passed; `pnpm lint` 0 errors (34
pre-existing warnings); changed files passed `oxfmt --check` and `git diff --check`. Workspace-wide `pnpm fmt:check`
is still blocked by pre-existing invalid HTML in Electron docs and `apps/zcode-cli/tests/gb2312.js`.
