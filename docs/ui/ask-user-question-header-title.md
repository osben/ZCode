# AskUserQuestion Dialog on Mobile

## Background

The AskUserQuestion / elicitation panel header previously truncated the question to one line to stay compact, with the full text available through a hover title. This could work on desktop, but mobile Web remote control has no hover, so users see a question that appears incomplete.

Mobile screens also have limited vertical space. A long question and multiple options can take up much of the screen, making it impossible to temporarily view context without submitting or dismissing the blocking question dialog.

## Design

- Show the question area in `<tag> <question>` order: the tag comes first, followed immediately by the question.
- On desktop, do not truncate the question to one line; wrap naturally and show the complete text.
- On mobile, limit a long question to 4 lines by default and provide “Expand question / Collapse question” buttons. Expansion reveals the complete prompt.
- On mobile, provide a “Collapse question dialog / Expand question dialog” button for the whole dialog. When collapsed, retain only a compact summary row, question number, and expand button; hide the options and footer actions so users can view context.
- Collapsing the whole dialog changes only the current client's UI state. It does not respond to, cancel, or modify the AskUserQuestion request. After expanding, the user can continue with the existing choices and draft.
- Use `leading-6` for the question text so wrapped lines have enough spacing; keep answer-option text compact.
- Retain the native `title` on the question body as a supplementary copy/hover affordance on desktop, but do not make it the only way to read the full question.
- A long header may still use a compact Badge at the top to avoid squeezing pagination controls.
- Show option text in natural reading order: title first, followed immediately by its description. Do not use flex layout for the text area, which could separate the title and description in a way that conflicts with reading order.
- This capability does not change the AskUserQuestion protocol, answer content, task flow, or remote `replayable` / desktop `continuous` semantics.

## Acceptance

- The full question is readable on desktop without hover and on mobile by expanding the question.
- Show the tag before the question; do not use `truncate` for the question.
- Use `leading-6` for the question without changing the line spacing of option titles or descriptions.
- Pagination controls are not squeezed by a long question.
- Option titles and descriptions appear in the same text flow, with the description wrapping naturally after the title.
- On mobile, users can collapse the entire question dialog and expand it again from the summary without affecting the task flow or answer draft.
- Server-side rendered output includes the complete question body and its `title` attribute to prevent regressions.
