# Bot Binding Command Guidance

## Background

After users generate a binding code in Bot settings, the UI shows only `/bind <code>` and a copy icon. The current prompt does not clearly say that the command must be sent to the bot, so users may think copying it completes the binding.

## Goals

- Show clear instructions before the binding command: copy the command below and send it in a direct message to the bot.
- Label the copy button “Copy binding command” to avoid ambiguity when only an icon is visible.
- After copying, the toast should give the next step: open a direct message with the bot, paste, and send the command.
- Keep binding-code expiration, refresh, and countdown behavior unchanged.

## UI Rules

- Use the existing `DetailPanel` hierarchy; do not add another overlay or nested card.
- Keep `font-mono` and `bg-surface` on the command itself to preserve its technical, copyable appearance.
- Use `text-ui-base leading-5 text-foreground-subtle` for the guidance copy, accommodating Chinese and English wrapping and mobile widths.
- Treat the instructions as helper text only; do not introduce new business state.

## Copy

- Title: Binding command
- Guidance: Copy the binding command below and send it in a direct message to the bot.
- Copy button: Copy binding command
- Copy success: Binding command copied. Open a direct message with the bot, paste, and send it.
