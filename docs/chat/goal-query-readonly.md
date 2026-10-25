# Goal Query Readonly

`/goal` and `/target` show in the chat as user queries but are not ordinary prompts:

- The send entry routes them to session goal control commands.
- set / replace writes the current session target and may trigger goal continuation.
- pause / resume / clear / show are goal state controls and must not be treated as retryable natural-language queries.

## Interaction rules

User messages produced from plain-text `/goal ...` or `/target ...` stay read-only:

- No edit / retry action on the user message. Read-only actions (copy, time display, expanding long text) stay available.
- The leading `/goal` / `/target` is submit-control syntax. The read-only user bubble keeps the Goal icon and command semantic color with a `goal` / `target` label but does not render the leading `/`; the rest of the goal text keeps the ordinary user-text style.
- Copy, inline edit and command intent still use the original `UserInputRow.text`; omitting the `/` in the display layer must not lose the original `/goal` / `/target`.
- Mentioning `/goal` in ordinary body text is unaffected.
- `/goal ...` with attachments is not handled as a goal slash command and keeps ordinary message behavior. This includes context attachments such as web elements or conversation selections: stripping the context block from the visible body must not make the message render as a goal query.

Omitting the `/` only changes the renderer's read-only body. It does not change message text, copied content, the edit target or the desktop continuous / web remote replayable projection semantics. Desktop and mobile Web share the same row component and use existing semantic colors for light and dark themes.

## Implementation constraints

The UI check must reuse the same visible slash command semantics as the send entry, not a string-contains check for `/goal`; this avoids misclassifying ordinary discussion text, i18n copy and messages with file or context attachments. Display parsing only identifies confirmed goal queries and omits the leading `/` in the command label; the authoritative source text stays `UserInputRow.text`, and command intent is never reconstructed from the rendered result.
