# Slash Command Leading Dunhao Alias

## Background

With a Chinese IME, a user who wants to type `/` as the first character of the chat input to summon the
slash command panel may type the Chinese enumeration comma `、`. Adding `、` to slash command matching would
widen the command parsing boundary and could disturb normal Chinese punctuation input.

## Goal

- Handle only a hand-typed leading `、` in the chat input: when `、` would become the first character of the
  whole input, replace it with ASCII `/` immediately.
- After replacement, keep reusing the existing `/` slash command panel, filtering, mention insertion and
  send parsing logic.
- Never replace `、` globally in the body, nor handle pasted or programmatically prefilled content.

## Boundary

- Only a real input of the browser `beforeinput` with `inputType === "insertText"` and `data === "、"` is
  handled.
- No replacement when the caret is not at the start of the whole editor text, e.g. `你好、` stays as is.
- Pasting `、goal`, restoring a draft, or external prefill is not replaced.
- Slash command matching and execution still recognize only the standard `/`; this feature only corrects
  once before the input enters the editor.

## Compatibility

The logic sits in the Lexical input layer of `packages/ui`; desktop, local Web and mobile remote reuse the
same input component. No change to `@zcode/protocol`; agent, session, continuous/replayable message flows
and the remote task command queue are unaffected.

## Acceptance

- Hand-typing `、` in an empty input turns the content into `/` and summons the slash command panel.
- Hand-typing `、` with the caret at the start of existing content corrects the first character to `/`.
- Hand-typing `、` when the caret is not at the start is not replaced.
- Pasting or programmatically writing `、goal` is not replaced.
- Existing `/` slash command behavior is unchanged.
